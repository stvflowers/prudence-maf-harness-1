import asyncio
import os
import shutil
import tempfile
from collections import defaultdict
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any, cast

from agent_framework import AgentSession, Content
from agent_framework._harness._mode import get_agent_mode, set_agent_mode
from pydantic import TypeAdapter

from maf_harness.artifacts import ArtifactStore
from maf_harness.database import Repository
from maf_harness.hooks import HookBlockedError, LifecycleHookRegistry
from maf_harness.mcp_servers import McpServerRegistry
from maf_harness.runner import AgentRunner
from maf_harness.schemas import (
    ApprovalPreview,
    ApprovalRecord,
    ArtifactPreview,
    ArtifactSummary,
    EventRecord,
    HookSummary,
    McpServerSummary,
    MemoryCreate,
    MemoryEntry,
    ProviderProbeResult,
    ProviderProfile,
    ProviderProfileCreate,
    ProviderProfileUpdate,
    SessionArchive,
    SessionArchiveArtifact,
    SessionArchiveEvent,
    SessionArchiveImport,
    SessionInstructionUpdate,
    SessionStateView,
    SessionSummary,
    SkillSummary,
    SubagentSummary,
    TaskItem,
    WorkspaceBindRequest,
    WorkspaceCapabilityUpdate,
    WorkspaceContext,
    WorkspaceContextFile,
    WorkspaceInstructionSource,
)
from maf_harness.skills import SkillRegistry
from maf_harness.subagents import SubagentRegistry
from maf_harness.workspace_state import WorkspaceSettings, WorkspaceSettingsStore
from maf_harness.workspace_tools import WorkspaceReadTools

EmitCallback = Callable[[dict[str, Any]], Awaitable[None]]
TASK_LIST_ADAPTER = TypeAdapter(list[TaskItem])
TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}
TIMEOUT_ERROR_NAMES = {"apitimeouterror", "connecttimeout", "readtimeout", "timeouterror"}
CONNECTION_ERROR_NAMES = {
    "apiconnectionerror",
    "connecterror",
    "connectionerror",
    "servicerequesterror",
}
DATA_INSTRUCTION_FILES = (
    ("managed", "Organization defaults", "managed-instructions.md", 10),
    ("user", "User defaults", "instructions.md", 20),
)
PROJECT_INSTRUCTION_FILES = (
    ("project_context", "Project agent guidance", "AGENTS.md", 30),
    (
        "project_context",
        "Project Copilot guidance",
        ".github/copilot-instructions.md",
        35,
    ),
    ("project_shared", "Prudence project guidance", ".prudence/instructions.md", 40),
    (
        "local_override",
        "Local project override",
        ".prudence/instructions.local.md",
        50,
    ),
)
LEGACY_PROJECT_INSTRUCTION_FILES = {
    ".prudence/instructions.md": (
        "Legacy project shared instructions",
        ".maf-harness/instructions.md",
    ),
    ".prudence/instructions.local.md": (
        "Legacy local project override",
        ".maf-harness/instructions.local.md",
    ),
}
CONTEXT_FILES = {
    "README.md": "project_overview",
    "README": "project_overview",
    "CONTRIBUTING.md": "contributor_guide",
    "pyproject.toml": "python_project",
    "package.json": "javascript_project",
    "azure.yaml": "azure_project",
}
IGNORED_WORKSPACE_DIRECTORIES = {
    ".git",
    ".maf-harness",
    ".prudence",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
}
MAX_INSTRUCTION_BYTES = 65_536
MAX_DISCOVERED_FILES = 10_000


class PendingApprovalError(RuntimeError):
    pass


def normalize_session_title(raw_title: str) -> str:
    title = raw_title.strip().splitlines()[0].strip()
    if title.lower().startswith("title:"):
        title = title[6:].strip()
    title = title.strip(" \t\"'`#*_.,:;!?-")
    words = title.split()
    if not words:
        raise ValueError("The provider returned an empty session title")
    title = " ".join(words[:6])
    if len(title) > 72:
        title = title[:72].rsplit(" ", 1)[0].rstrip()
    if not title:
        raise ValueError("The provider returned an invalid session title")
    return title


def classify_run_failure(exc: Exception, has_partial_response: bool) -> dict[str, Any]:
    raw_status_code: object = getattr(exc, "status_code", None)
    status_code = raw_status_code if isinstance(raw_status_code, int) else None
    error_name = type(exc).__name__.casefold()

    if isinstance(exc, HookBlockedError):
        category = "policy_blocked"
        transient = False
        message = str(exc)
    elif isinstance(exc, TimeoutError) or error_name in TIMEOUT_ERROR_NAMES:
        category = "timeout"
        transient = True
        message = "The model provider timed out. Check connectivity and retry."
    elif isinstance(exc, ConnectionError) or error_name in CONNECTION_ERROR_NAMES:
        category = "connection"
        transient = True
        message = "The model provider could not be reached. Check that it is running and retry."
    elif status_code == 429:
        category = "rate_limit"
        transient = True
        message = "The model provider is rate-limiting requests. Wait briefly and retry."
    elif status_code in TRANSIENT_STATUS_CODES:
        category = "provider_unavailable"
        transient = True
        message = "The model provider is temporarily unavailable. Retry when it recovers."
    elif status_code in {401, 403}:
        category = "authentication"
        transient = False
        message = "The model provider rejected authentication. Verify its credentials and access."
    elif status_code in {400, 404, 409, 422}:
        category = "invalid_request"
        transient = False
        message = "The model provider rejected the request. Review the profile and request details."
    else:
        category = "internal"
        transient = False
        message = "The agent run failed. Review the diagnostic detail before trying again."

    return {
        "message": message,
        "detail": str(exc),
        "category": category,
        "status_code": status_code,
        "transient": transient,
        "retryable": transient and not has_partial_response,
    }


class HarnessService:
    def __init__(
        self,
        repository: Repository,
        runner: AgentRunner,
        data_directory: Path,
    ) -> None:
        self.repository = repository
        self.runner = runner
        self._data_directory = data_directory
        self._memory_root = data_directory / "memory"
        self._artifact_store = ArtifactStore(data_directory / "artifacts")
        self._user_skill_root = data_directory / "skills"
        self._mcp_registry = McpServerRegistry(data_directory)
        self._session_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._active_runs: dict[str, asyncio.Task[Any]] = {}
        self._subscribers: defaultdict[str, set[EmitCallback]] = defaultdict(set)

    def subscribe(self, session_id: str, emit: EmitCallback) -> None:
        self._subscribers[session_id].add(emit)

    def unsubscribe(self, session_id: str, emit: EmitCallback) -> None:
        subscribers = self._subscribers.get(session_id)
        if subscribers is None:
            return
        subscribers.discard(emit)
        if not subscribers:
            self._subscribers.pop(session_id, None)

    async def create_provider(self, profile: ProviderProfileCreate) -> ProviderProfile:
        initialized = await self._initialize_provider_limits(profile)
        return self.repository.create_provider(initialized)

    async def update_provider(
        self,
        provider_id: str,
        profile: ProviderProfileUpdate,
    ) -> ProviderProfile:
        if self.repository.get_provider(provider_id) is None:
            raise LookupError(f"Provider {provider_id} was not found")
        initialized = await self._initialize_provider_limits(profile)
        return self.repository.update_provider(
            provider_id,
            ProviderProfileUpdate.model_validate(initialized),
        )

    async def import_providers(
        self,
        profiles: list[ProviderProfileCreate],
    ) -> list[ProviderProfile]:
        initialized = [
            await self._initialize_provider_limits(profile) for profile in profiles
        ]
        return self.repository.import_providers(initialized)

    async def _initialize_provider_limits(
        self,
        profile: ProviderProfileCreate,
    ) -> ProviderProfileCreate:
        context_tokens, output_tokens = await self.runner.discover_model_limits(profile)
        return profile.model_copy(
            update={
                "max_context_window_tokens": context_tokens,
                "max_output_tokens": output_tokens,
            }
        )

    async def probe_provider(self, provider_id: str) -> ProviderProbeResult:
        profile = self.repository.get_provider(provider_id)
        if profile is None:
            raise LookupError(f"Provider {provider_id} was not found")
        try:
            result = await self.runner.probe(profile)
        except Exception as exc:
            self.repository.record_provider_probe(
                provider_id,
                ok=False,
                message=str(exc),
                tool_calling=False,
                streaming=False,
            )
            raise
        self.repository.record_provider_probe(
            provider_id,
            ok=result.ok,
            message=result.message,
            tool_calling=result.tool_calling,
            streaming=result.streaming,
        )
        return result

    async def run_prompt(
        self,
        session_id: str,
        content: str,
    ) -> None:
        async with self._session_locks[session_id]:
            current_task = asyncio.current_task()
            if current_task is None:
                raise RuntimeError("Agent run is not executing in an asyncio task")
            self._active_runs[session_id] = current_task
            session = self.repository.get_session(session_id)
            if session is None:
                raise LookupError(f"Session {session_id} was not found")
            if any(
                approval.status == "pending"
                for approval in self.repository.list_approvals(session_id)
            ):
                raise PendingApprovalError(
                    "Resolve the pending approval before sending another message."
                )
            profile = self.repository.get_provider(session.provider_id)
            if profile is None:
                raise LookupError(f"Provider {session.provider_id} was not found")
            craft_profile = (
                self.repository.get_provider(session.craft_provider_id)
                if session.craft_provider_id
                else None
            )
            if session.craft_provider_id and craft_profile is None:
                raise LookupError(
                    f"Craft provider {session.craft_provider_id} was not found"
                )

            await self._record_and_emit(session_id, "user_message", {"content": content})
            await self._record_and_emit(
                session_id,
                "run_started",
                {
                    "provider": profile.kind,
                    "model": profile.model,
                    "mode": "counsel_and_craft" if craft_profile else "single_provider",
                    "craft_model": craft_profile.model if craft_profile else None,
                },
            )
            response_parts: list[str] = []

            async def on_delta(delta: str) -> None:
                response_parts.append(delta)
                await self._broadcast(
                    session_id,
                    {"type": "assistant_delta", "payload": {"content": delta}},
                )

            async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
                await self._record_and_emit(session_id, event_type, payload)

            try:
                result = await self.runner.run(
                    profile,
                    craft_profile,
                    session_id,
                    content,
                    self.repository.get_session_state(session_id),
                    self.get_workspace_instructions(session_id),
                    self.repository.get_workspace(session_id),
                    self._workspace_write_tools_enabled(session_id),
                    self._workspace_auto_approve_enabled(session_id),
                    on_delta,
                    on_activity,
                )
                self.repository.save_session_state(session_id, result.session_state)
                if result.pending_approvals:
                    await self._record_approvals(
                        session_id,
                        result.pending_approvals,
                    )
                    await self._record_and_emit(session_id, "run_waiting_approval", {})
                    return
                await self._record_and_emit(
                    session_id,
                    "assistant_message",
                    {"content": result.text},
                )
                await self._generate_default_session_title(
                    session_id,
                    profile,
                    content,
                    result.text,
                )
                await self._record_and_emit(session_id, "run_completed", {})
            except asyncio.CancelledError:
                await self._record_and_emit(session_id, "run_cancelled", {})
            except Exception as exc:
                if response_parts:
                    await self._record_and_emit(
                        session_id,
                        "assistant_message",
                        {"content": "".join(response_parts), "partial": True},
                    )
                await self._record_and_emit(
                    session_id,
                    "run_failed",
                    classify_run_failure(exc, bool(response_parts)),
                )
                raise
            finally:
                if self._active_runs.get(session_id) is current_task:
                    self._active_runs.pop(session_id, None)

    async def _generate_default_session_title(
        self,
        session_id: str,
        profile: ProviderProfile,
        user_content: str,
        assistant_content: str,
    ) -> None:
        session = self.repository.get_session(session_id)
        if session is None:
            raise LookupError(f"Session {session_id} was not found")
        if session.title != "New session":
            return
        try:
            raw_title = await self.runner.generate_title(
                profile,
                user_content,
                assistant_content,
            )
            title = normalize_session_title(raw_title)
            self.repository.update_session_title(session_id, title)
            await self._record_and_emit(
                session_id,
                "session_title_updated",
                {"title": title, "model": profile.model},
            )
        except Exception as exc:
            await self._record_and_emit(
                session_id,
                "session_title_failed",
                {"message": str(exc), "model": profile.model},
            )

    def _latest_user_content(self, session_id: str) -> str:
        session = self.repository.get_session(session_id)
        if session is None:
            raise LookupError(f"Session {session_id} was not found")
        for event in reversed(session.events):
            if event.type == "user_message":
                return str(event.payload.get("content", ""))
        return ""

    async def decide_approval(
        self,
        approval_id: str,
        approved: bool,
    ) -> ApprovalRecord:
        approval = self.repository.get_approval(approval_id)
        if approval is None:
            raise LookupError(f"Approval {approval_id} was not found")
        async with self._session_locks[approval.session_id]:
            if approval.status != "pending":
                raise ValueError("Approval has already been decided")
            session = self.repository.get_session(approval.session_id)
            if session is None:
                raise LookupError(f"Session {approval.session_id} was not found")
            profile = self.repository.get_provider(session.provider_id)
            if profile is None:
                raise LookupError(f"Provider {session.provider_id} was not found")
            craft_profile = (
                self.repository.get_provider(session.craft_provider_id)
                if session.craft_provider_id
                else None
            )
            if session.craft_provider_id and craft_profile is None:
                raise LookupError(
                    f"Craft provider {session.craft_provider_id} was not found"
                )
            session_state = self.repository.get_session_state(approval.session_id)
            if session_state is None:
                raise ValueError("Session has no framework state to resume")

            decided = self.repository.decide_approval(approval.id, approved)
            await self._record_and_emit(
                approval.session_id,
                "approval_decided",
                {"approval_id": approval.id, "approved": approved},
            )
            response_parts: list[str] = []

            async def on_delta(delta: str) -> None:
                response_parts.append(delta)
                await self._broadcast(
                    approval.session_id,
                    {"type": "assistant_delta", "payload": {"content": delta}},
                )

            async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
                await self._record_and_emit(approval.session_id, event_type, payload)

            current_task = asyncio.current_task()
            if current_task is None:
                raise RuntimeError("Approval continuation is not executing in an asyncio task")
            self._active_runs[approval.session_id] = current_task
            try:
                result = await self.runner.resume_approval(
                    profile,
                    craft_profile,
                    approval.session_id,
                    approval.request,
                    approved,
                    session_state,
                    self.get_workspace_instructions(approval.session_id),
                    self.repository.get_workspace(approval.session_id),
                    self._workspace_write_tools_enabled(approval.session_id),
                    self._workspace_auto_approve_enabled(approval.session_id),
                    on_delta,
                    on_activity,
                )
                self.repository.save_session_state(approval.session_id, result.session_state)
                if result.pending_approvals:
                    await self._record_approvals(
                        approval.session_id,
                        result.pending_approvals,
                    )
                    await self._record_and_emit(
                        approval.session_id,
                        "run_waiting_approval",
                        {},
                    )
                    return decided
                if result.text:
                    await self._record_and_emit(
                        approval.session_id,
                        "assistant_message",
                        {"content": result.text},
                    )
                    await self._generate_default_session_title(
                        approval.session_id,
                        profile,
                        self._latest_user_content(approval.session_id),
                        result.text,
                    )
                await self._record_and_emit(approval.session_id, "run_completed", {})
                return decided
            except asyncio.CancelledError:
                await self._record_and_emit(approval.session_id, "run_cancelled", {})
                raise
            except Exception as exc:
                if response_parts:
                    await self._record_and_emit(
                        approval.session_id,
                        "assistant_message",
                        {"content": "".join(response_parts), "partial": True},
                    )
                await self._record_and_emit(
                    approval.session_id,
                    "run_failed",
                    classify_run_failure(exc, bool(response_parts)),
                )
                raise
            finally:
                if self._active_runs.get(approval.session_id) is current_task:
                    self._active_runs.pop(approval.session_id, None)

    async def delete_session(self, session_id: str) -> None:
        active_run = self._active_runs.get(session_id)
        if active_run is not None and not active_run.done():
            raise ValueError("Cannot delete a session while a run is active")
        lock = self._session_locks[session_id]
        async with lock:
            self.repository.delete_session(session_id)
            for root in (self._memory_root, self._data_directory / "artifacts"):
                target = root / session_id
                if target.is_symlink() or target.is_file():
                    target.unlink()
                elif target.is_dir():
                    shutil.rmtree(target)
        self._active_runs.pop(session_id, None)
        self._session_locks.pop(session_id, None)
        self._subscribers.pop(session_id, None)

    def cancel_run(self, session_id: str) -> bool:
        task = self._active_runs.get(session_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    def list_artifacts(
        self,
        session_id: str,
        query: str | None = None,
    ) -> list[ArtifactSummary]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        return self._artifact_store_for(session_id).list_artifacts(session_id, query)

    def preview_artifact(
        self,
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> ArtifactPreview:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        return self._artifact_store_for(session_id).preview(
            session_id, artifact_id, version
        )

    def artifact_download(
        self,
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> tuple[ArtifactSummary, Path]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        artifact, _, path = self._artifact_store_for(session_id).download_path(
            session_id,
            artifact_id,
            version,
        )
        return artifact, path

    async def bind_workspace(
        self,
        session_id: str,
        request: WorkspaceBindRequest,
    ) -> WorkspaceContext:
        context = await asyncio.to_thread(self._bind_workspace, session_id, request)
        await self._record_and_emit(
            session_id,
            "workspace_bound",
            {
                "root_path": context.root_path,
                "instruction_count": len(context.instructions),
                "context_file_count": len(context.context_files),
            },
        )
        return context

    async def update_workspace_capabilities(
        self,
        session_id: str,
        update: WorkspaceCapabilityUpdate,
    ) -> WorkspaceContext:
        root = self._workspace_root(session_id)
        settings_store = WorkspaceSettingsStore(root)
        changes = update.model_dump(exclude_none=True)
        if not changes:
            raise ValueError("At least one workspace capability must be provided")
        if changes.get("write_tools_enabled") is False:
            changes["auto_approve_enabled"] = False
        settings = settings_store.load().model_copy(update=changes)
        if settings.auto_approve_enabled and not settings.write_tools_enabled:
            raise ValueError("Auto-approve requires workspace write access")
        settings_store.save(settings)
        write_tools_enabled = self.repository.set_workspace_write_tools(
            session_id, settings.write_tools_enabled
        )
        auto_approve_enabled = self.repository.set_workspace_auto_approve(
            session_id, settings.auto_approve_enabled
        )
        await self._record_and_emit(
            session_id,
            "workspace_capabilities_changed",
            {
                "write_tools_enabled": write_tools_enabled,
                "auto_approve_enabled": auto_approve_enabled,
            },
        )
        return self.get_workspace_context(session_id)

    def _bind_workspace(
        self,
        session_id: str,
        request: WorkspaceBindRequest,
    ) -> WorkspaceContext:
        candidate = Path(request.path).expanduser()
        if not candidate.is_absolute():
            raise ValueError("Workspace path must be absolute")
        root = candidate.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("Workspace path must identify an existing directory")
        previous_root = self.repository.get_workspace(session_id)
        settings_store = WorkspaceSettingsStore(root)
        if settings_store.exists():
            settings = settings_store.load()
            settings_need_save = False
        else:
            settings = WorkspaceSettings(
                write_tools_enabled=(
                    self.repository.workspace_write_tools_enabled(session_id)
                    if previous_root == str(root)
                    else False
                ),
                auto_approve_enabled=(
                    self.repository.workspace_auto_approve_enabled(session_id)
                    if previous_root == str(root)
                    else False
                ),
                session_instructions=self.repository.get_session_instructions(
                    session_id
                ),
            )
            settings_need_save = True
        self._migrate_session_memory(session_id, root)
        if settings_need_save:
            settings_store.save(settings)
        self.repository.set_workspace(session_id, str(root))
        self.repository.set_workspace_write_tools(
            session_id, settings.write_tools_enabled
        )
        self.repository.set_workspace_auto_approve(
            session_id, settings.auto_approve_enabled
        )
        if settings.session_instructions is None:
            self.repository.clear_session_instructions(session_id)
        else:
            self.repository.set_session_instructions(
                session_id, settings.session_instructions
            )
        return self.get_workspace_context(session_id)

    def get_workspace_context(self, session_id: str) -> WorkspaceContext:
        root_path = self.repository.get_workspace(session_id)
        if root_path is None:
            raise LookupError(f"Session {session_id} has no workspace")
        root = Path(root_path).resolve(strict=True)
        instructions = self.list_instruction_sources(session_id)

        context_files = [
            WorkspaceContextFile(
                relative_path=relative_path,
                kind=kind,
                size_bytes=source.stat().st_size,
            )
            for relative_path, kind in CONTEXT_FILES.items()
            if (source := root / relative_path).is_file()
            and source.resolve(strict=True).is_relative_to(root)
        ]
        discovered_file_count = 0
        discovery_truncated = False
        for _, directory_names, file_names in os.walk(root, followlinks=False):
            directory_names[:] = [
                name
                for name in directory_names
                if name not in IGNORED_WORKSPACE_DIRECTORIES
            ]
            discovered_file_count += len(file_names)
            if discovered_file_count >= MAX_DISCOVERED_FILES:
                discovered_file_count = MAX_DISCOVERED_FILES
                discovery_truncated = True
                break

        tools = WorkspaceReadTools(root)
        write_tools_enabled = self._workspace_write_tools_enabled(session_id)
        auto_approve_enabled = self._workspace_auto_approve_enabled(session_id)
        return WorkspaceContext(
            root_path=str(root),
            instructions=instructions,
            context_files=context_files,
            discovered_file_count=discovered_file_count,
            discovery_truncated=discovery_truncated,
            read_tools=tools.capability_names,
            write_tools_enabled=write_tools_enabled,
            auto_approve_enabled=auto_approve_enabled,
            write_tools=tools.write_capability_names if write_tools_enabled else [],
        )

    def get_workspace_instructions(self, session_id: str) -> str | None:
        instructions = self.list_instruction_sources(session_id)
        if not instructions:
            return None
        sections = [
            (
                f"Source: {source.label} [{source.scope}] "
                f"({source.relative_path}, precedence {source.precedence})\n"
                f"{source.content}"
            )
            for source in instructions
        ]
        return (
            "Apply these instructions in ascending precedence order; later sources "
            "override earlier sources when they conflict.\n\n"
            + "\n\n---\n\n".join(sections)
        )

    def list_instruction_sources(
        self,
        session_id: str,
    ) -> list[WorkspaceInstructionSource]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        sources: list[WorkspaceInstructionSource] = []
        data_root = self._data_directory.resolve(strict=True)
        for scope, label, relative_path, precedence in DATA_INSTRUCTION_FILES:
            source = data_root / relative_path
            loaded = self._load_instruction_source(
                source,
                data_root,
                scope,
                label,
                relative_path,
                precedence,
            )
            if loaded is not None:
                sources.append(loaded)

        workspace_root = self.repository.get_workspace(session_id)
        if workspace_root is not None:
            root = Path(workspace_root).resolve(strict=True)
            for (
                scope,
                label,
                relative_path,
                precedence,
            ) in PROJECT_INSTRUCTION_FILES:
                selected_label = label
                selected_relative_path = relative_path
                if not (root / relative_path).exists():
                    legacy = LEGACY_PROJECT_INSTRUCTION_FILES.get(relative_path)
                    if legacy is not None:
                        selected_label, selected_relative_path = legacy
                loaded = self._load_instruction_source(
                    root / selected_relative_path,
                    root,
                    scope,
                    selected_label,
                    selected_relative_path,
                    precedence,
                )
                if loaded is not None:
                    sources.append(loaded)

        session_content = self._session_instruction_content(session_id)
        if session_content is not None:
            sources.append(
                WorkspaceInstructionSource(
                    scope="session",
                    label=(
                        "Workspace session override"
                        if workspace_root is not None
                        else "Session override"
                    ),
                    relative_path=(
                        ".prudence/settings.json"
                        if workspace_root is not None
                        else "session"
                    ),
                    precedence=60,
                    content=session_content,
                    editable=True,
                )
            )
        return sources

    def _load_instruction_source(
        self,
        source: Path,
        root: Path,
        scope: str,
        label: str,
        relative_path: str,
        precedence: int,
    ) -> WorkspaceInstructionSource | None:
        if not source.is_file():
            return None
        resolved_source = source.resolve(strict=True)
        if not resolved_source.is_relative_to(root):
            raise ValueError(f"Instruction file escapes its scope: {relative_path}")
        size = resolved_source.stat().st_size
        if size > MAX_INSTRUCTION_BYTES:
            raise ValueError(
                f"Instruction file exceeds {MAX_INSTRUCTION_BYTES} bytes: {relative_path}"
            )
        return WorkspaceInstructionSource(
            scope=scope,
            label=label,
            relative_path=relative_path,
            precedence=precedence,
            content=resolved_source.read_text(encoding="utf-8"),
        )

    async def update_session_instructions(
        self,
        session_id: str,
        update: SessionInstructionUpdate,
    ) -> list[WorkspaceInstructionSource]:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is not None:
            store = WorkspaceSettingsStore(Path(workspace_path))
            store.save(
                store.load().model_copy(
                    update={"session_instructions": update.content}
                )
            )
        self.repository.set_session_instructions(session_id, update.content)
        await self._record_and_emit(
            session_id,
            "session_instructions_changed",
            {"configured": True, "characters": len(update.content)},
        )
        return self.list_instruction_sources(session_id)

    async def clear_session_instructions(
        self,
        session_id: str,
    ) -> list[WorkspaceInstructionSource]:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is not None:
            store = WorkspaceSettingsStore(Path(workspace_path))
            settings = store.load()
            cleared = settings.session_instructions is not None
            store.save(settings.model_copy(update={"session_instructions": None}))
            self.repository.clear_session_instructions(session_id)
        else:
            cleared = self.repository.clear_session_instructions(session_id)
        await self._record_and_emit(
            session_id,
            "session_instructions_changed",
            {"configured": False, "cleared": cleared},
        )
        return self.list_instruction_sources(session_id)

    def list_subagents(self, session_id: str) -> list[SubagentSummary]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        workspace_root = self.repository.get_workspace(session_id)
        if workspace_root is None:
            return []
        definitions = SubagentRegistry(Path(workspace_root)).definitions()
        return [
            SubagentSummary(
                name=definition.name,
                description=definition.description,
                permissions=list(definition.permissions),
                timeout_seconds=definition.timeout_seconds,
                max_tool_calls=definition.max_tool_calls,
                max_tool_output_chars=definition.max_tool_output_chars,
                max_result_chars=definition.max_result_chars,
                max_output_tokens=definition.max_output_tokens,
            )
            for definition in definitions
        ]

    def list_skills(self, session_id: str) -> list[SkillSummary]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        workspace_path = self.repository.get_workspace(session_id)
        workspace_root = Path(workspace_path) if workspace_path is not None else None
        registry = SkillRegistry(self._user_skill_root, workspace_root)
        return [definition.summary for definition in registry.discover()]

    def list_mcp_servers(self, session_id: str) -> list[McpServerSummary]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        servers = self._mcp_registry.discover()
        return self._mcp_registry.summaries(servers)

    def list_hooks(self, session_id: str) -> list[HookSummary]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        workspace_path = self.repository.get_workspace(session_id)
        workspace_root = Path(workspace_path) if workspace_path is not None else None
        registry = LifecycleHookRegistry(self._user_skill_root.parent, workspace_root)
        return [definition.summary for definition in registry.discover()]

    def get_state(self, session_id: str) -> SessionStateView:
        state = self.repository.get_session_state(session_id)
        if state is None:
            return SessionStateView(
                mode="plan",
                tasks=[],
                is_running=session_id in self._active_runs,
            )
        session = AgentSession.from_dict(state)
        todo_state = session.state.get("todo")
        todo_mapping: Mapping[object, object] = (
            cast(Mapping[object, object], todo_state)
            if isinstance(todo_state, Mapping)
            else {}
        )
        raw_items = todo_mapping.get("items")
        tasks = TASK_LIST_ADAPTER.validate_python(raw_items) if isinstance(raw_items, list) else []
        return SessionStateView(
            mode=get_agent_mode(session),
            tasks=tasks,
            is_running=session_id in self._active_runs,
        )

    def set_mode(self, session_id: str, mode: str) -> SessionStateView:
        state = self.repository.get_session_state(session_id)
        session = AgentSession.from_dict(state) if state else AgentSession(session_id=session_id)
        set_agent_mode(session, mode)
        self.repository.save_session_state(session_id, session.to_dict())
        return self.get_state(session_id)

    async def approve_plan(self, session_id: str) -> SessionStateView:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        state = self.get_state(session_id)
        remaining = [task for task in state.tasks if not task.is_complete]
        if not remaining:
            raise ValueError("The session has no incomplete plan steps to approve")
        updated = self.set_mode(session_id, "execute")
        await self._record_and_emit(
            session_id,
            "plan_approved",
            {"remaining_steps": len(remaining), "iteration_cap": 8},
        )
        return updated

    def _workspace_root(self, session_id: str) -> Path:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            raise LookupError(f"Session {session_id} has no workspace")
        return Path(workspace_path).resolve(strict=True)

    def _workspace_write_tools_enabled(self, session_id: str) -> bool:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            return False
        settings = WorkspaceSettingsStore(Path(workspace_path)).load()
        if (
            self.repository.workspace_write_tools_enabled(session_id)
            != settings.write_tools_enabled
        ):
            self.repository.set_workspace_write_tools(
                session_id, settings.write_tools_enabled
            )
        return settings.write_tools_enabled

    def _workspace_auto_approve_enabled(self, session_id: str) -> bool:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            return False
        settings = WorkspaceSettingsStore(Path(workspace_path)).load()
        if (
            self.repository.workspace_auto_approve_enabled(session_id)
            != settings.auto_approve_enabled
        ):
            self.repository.set_workspace_auto_approve(
                session_id, settings.auto_approve_enabled
            )
        return settings.auto_approve_enabled

    def _session_instruction_content(self, session_id: str) -> str | None:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            return self.repository.get_session_instructions(session_id)
        content = WorkspaceSettingsStore(Path(workspace_path)).load().session_instructions
        database_content = self.repository.get_session_instructions(session_id)
        if content is None and database_content is not None:
            self.repository.clear_session_instructions(session_id)
        elif content is not None and database_content != content:
            self.repository.set_session_instructions(session_id, content)
        return content

    def _memory_directory(self, session_id: str) -> Path:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            return self._memory_root / session_id
        return Path(workspace_path) / ".prudence" / "memory"

    def _artifact_store_for(self, session_id: str) -> ArtifactStore:
        workspace_path = self.repository.get_workspace(session_id)
        if workspace_path is None:
            return self._artifact_store
        return ArtifactStore.for_workspace(Path(workspace_path))

    def _migrate_session_memory(self, session_id: str, workspace_root: Path) -> None:
        source_root = self._memory_root / session_id
        if not source_root.exists():
            return
        if source_root.is_symlink() or not source_root.is_dir():
            raise ValueError("Global session memory must be a real directory")
        destination_root = workspace_root / ".prudence" / "memory"
        if destination_root.exists() and (
            destination_root.is_symlink() or not destination_root.is_dir()
        ):
            raise ValueError("Workspace memory path must be a real directory")

        copies: list[tuple[Path, Path]] = []
        conflicts: list[str] = []
        for source in sorted(source_root.rglob("*")):
            if source.is_symlink():
                raise ValueError(
                    "Global session memory contains a symbolic link: "
                    f"{source.relative_to(source_root).as_posix()}"
                )
            if not source.is_file():
                continue
            relative = source.relative_to(source_root)
            if relative.as_posix().casefold() == "memories.md":
                continue
            destination = destination_root / relative
            if destination.exists() or destination.is_symlink():
                if (
                    destination.is_symlink()
                    or not destination.is_file()
                    or source.read_bytes() != destination.read_bytes()
                ):
                    conflicts.append(relative.as_posix())
                continue
            copies.append((source, destination))
        if conflicts:
            joined = ", ".join(conflicts)
            raise ValueError(
                f"Workspace memory migration conflicts with existing files: {joined}"
            )

        for source, destination in copies:
            destination.parent.mkdir(parents=True, exist_ok=True)
            resolved_parent = destination.parent.resolve(strict=True)
            if not resolved_parent.is_relative_to(workspace_root):
                raise ValueError("Workspace memory migration escapes the workspace")
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=resolved_parent,
                    prefix=".memory-",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = Path(temporary.name)
                shutil.copy2(source, temporary_path)
                os.replace(temporary_path, destination)
            finally:
                if temporary_path is not None and temporary_path.exists():
                    temporary_path.unlink()
            if source.read_bytes() != destination.read_bytes():
                raise OSError(
                    "Workspace memory migration verification failed for "
                    f"{source.relative_to(source_root).as_posix()}"
                )
        self._write_memory_index(destination_root)

    def list_memories(self, session_id: str) -> list[MemoryEntry]:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        directory = self._memory_directory(session_id)
        if not directory.exists():
            return []
        memories: list[MemoryEntry] = []
        for path in sorted(directory.iterdir()):
            if (
                not path.is_file()
                or path.is_symlink()
                or path.name == "memories.md"
                or path.name.endswith("_description.md")
            ):
                continue
            description_path = path.with_name(f"{path.stem}_description.md")
            memories.append(
                MemoryEntry(
                    file_name=path.name,
                    description=(
                        description_path.read_text(encoding="utf-8")
                        if description_path.is_file()
                        and not description_path.is_symlink()
                        else None
                    ),
                    content=path.read_text(encoding="utf-8"),
                )
            )
        return memories

    def create_memory(self, session_id: str, memory: MemoryCreate) -> MemoryEntry:
        if self.repository.get_session(session_id) is None:
            raise LookupError(f"Session {session_id} was not found")
        directory = self._memory_directory(session_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / memory.file_name
        self._atomic_memory_write(target, memory.content)
        if memory.description:
            self._atomic_memory_write(
                target.with_name(f"{target.stem}_description.md"),
                memory.description,
            )
        self._write_memory_index(directory)
        return MemoryEntry(
            file_name=memory.file_name,
            description=memory.description,
            content=memory.content,
        )

    def _write_memory_index(self, directory: Path) -> None:
        if not directory.exists():
            return
        entries: list[str] = []
        for path in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
            if (
                not path.is_file()
                or path.is_symlink()
                or path.name.casefold() == "memories.md"
                or path.name.casefold().endswith("_description.md")
            ):
                continue
            description_path = path.with_name(f"{path.stem}_description.md")
            description = (
                description_path.read_text(encoding="utf-8").strip()
                if description_path.is_file()
                and not description_path.is_symlink()
                else ""
            )
            entries.append(
                f"- **{path.name}**: {description}"
                if description
                else f"- **{path.name}**"
            )
            if len(entries) >= 50:
                break
        self._atomic_memory_write(
            directory / "memories.md",
            "# Memory Index\n\n" + "\n".join(entries) + ("\n" if entries else ""),
        )

    def _atomic_memory_write(self, target: Path, content: str) -> None:
        if target.exists() and target.is_symlink():
            raise ValueError("Memory files must not be symbolic links")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.parent.is_symlink():
            raise ValueError("Memory directory must not be a symbolic link")
        directory = target.parent.resolve(strict=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="",
                dir=directory,
                prefix=".memory-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(content)
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, target)
        finally:
            if temporary_path is not None and temporary_path.exists():
                temporary_path.unlink()

    def export_session(self, session_id: str) -> SessionArchive:
        session = self.repository.get_session(session_id)
        if session is None:
            raise LookupError(f"Session {session_id} was not found")
        provider = self.repository.get_provider(session.provider_id)
        if provider is None:
            raise LookupError(f"Provider {session.provider_id} was not found")
        artifacts: list[SessionArchiveArtifact] = []
        artifact_store = self._artifact_store_for(session_id)
        for artifact in artifact_store.list_artifacts(session_id):
            versions: list[str] = []
            export_versions = (
                artifact.versions
                if self.repository.get_workspace(session_id) is None
                else artifact.versions[-1:]
            )
            for version in export_versions:
                _, _, path = artifact_store.download_path(
                    session_id,
                    artifact.id,
                    version.version,
                )
                versions.append(path.read_text(encoding="utf-8"))
            artifacts.append(
                SessionArchiveArtifact(
                    title=artifact.title,
                    media_type="text/markdown",
                    versions=versions,
                )
            )
        return SessionArchive(
            title=session.title,
            source_provider=ProviderProfileCreate.model_validate(
                provider,
                from_attributes=True,
            ),
            events=[
                SessionArchiveEvent(
                    type=event.type,
                    payload=event.payload,
                    created_at=event.created_at,
                )
                for event in session.events
            ],
            memories=self.list_memories(session_id),
            artifacts=artifacts,
            session_instructions=self._session_instruction_content(session_id),
        )

    def import_session(self, request: SessionArchiveImport) -> SessionSummary:
        archive = request.archive
        imported = self.repository.import_session(
            request.provider_id,
            archive.title,
            archive.events,
        )
        for memory in archive.memories:
            self.create_memory(
                imported.id,
                MemoryCreate.model_validate(memory, from_attributes=True),
            )
        for artifact in archive.artifacts:
            heading = f"# {artifact.title}\n\n"
            for content in artifact.versions:
                body = content.removeprefix(heading)
                self._artifact_store.write_business_note(imported.id, artifact.title, body)
        if archive.session_instructions:
            self.repository.set_session_instructions(
                imported.id,
                archive.session_instructions,
            )
        return imported

    async def _record_approvals(
        self,
        session_id: str,
        requests: list[dict[str, Any]],
    ) -> None:
        for raw_request in requests:
            request = Content.from_dict(raw_request)
            function_call = request.function_call
            if function_call is None:
                continue
            tool_name = function_call.name or "unknown_tool"
            arguments = dict(function_call.parse_arguments() or {})
            preview = self._build_approval_preview(
                session_id,
                tool_name,
                arguments,
            )
            approval = self.repository.create_approval(
                session_id,
                tool_name,
                arguments,
                raw_request,
                preview,
            )
            await self._record_and_emit(
                session_id,
                "approval_requested",
                {
                    "approval_id": approval.id,
                    "tool_name": approval.tool_name,
                    "arguments": approval.arguments,
                    "preview": approval.preview.model_dump(mode="json"),
                },
            )

    def _build_approval_preview(
        self,
        session_id: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> ApprovalPreview:
        if tool_name == "write_business_note":
            workspace_root = self.repository.get_workspace(session_id)
            if workspace_root is not None:
                title = arguments.get("title")
                if not isinstance(title, str):
                    return ApprovalPreview(
                        operation="Save business note",
                        category="artifact_write",
                        risk_level="write",
                        preview_kind="unavailable",
                        preview_content="The request does not contain a valid note title.",
                    )
                try:
                    relative_path = ArtifactStore.for_workspace(
                        Path(workspace_root)
                    ).business_note_relative_path(session_id, title)
                except (OSError, UnicodeDecodeError, ValueError) as exc:
                    return ApprovalPreview(
                        operation="Save business note",
                        category="artifact_write",
                        risk_level="write",
                        preview_kind="unavailable",
                        preview_content=f"Target path preview unavailable: {exc}",
                    )
                return ApprovalPreview(
                    operation="Save business note",
                    category="artifact_write",
                    risk_level="write",
                    affected_paths=[relative_path],
                    preview_kind="summary",
                    preview_content=(
                        f"Create or update the workspace business note at {relative_path}."
                    ),
                )

        if tool_name == "replace_workspace_text":
            relative_path = arguments.get("relative_path")
            old_text = arguments.get("old_text")
            new_text = arguments.get("new_text")
            affected_paths = [relative_path] if isinstance(relative_path, str) else []
            if (
                not isinstance(relative_path, str)
                or not isinstance(old_text, str)
                or not isinstance(new_text, str)
            ):
                return ApprovalPreview(
                    operation="Replace workspace text",
                    category="file_write",
                    risk_level="write",
                    affected_paths=affected_paths,
                    preview_kind="unavailable",
                    preview_content=(
                        "The request does not contain valid text replacement arguments."
                    ),
                )
            workspace_root = self.repository.get_workspace(session_id)
            if workspace_root is None:
                return ApprovalPreview(
                    operation="Replace workspace text",
                    category="file_write",
                    risk_level="write",
                    affected_paths=affected_paths,
                    preview_kind="unavailable",
                    preview_content="The session has no bound workspace.",
                )
            try:
                diff, truncated = WorkspaceReadTools(
                    Path(workspace_root)
                ).preview_replace_text(
                    relative_path,
                    old_text,
                    new_text,
                )
            except (FileNotFoundError, OSError, UnicodeDecodeError, ValueError) as exc:
                return ApprovalPreview(
                    operation="Replace workspace text",
                    category="file_write",
                    risk_level="write",
                    affected_paths=affected_paths,
                    preview_kind="unavailable",
                    preview_content=f"Diff preview unavailable: {exc}",
                )
            return ApprovalPreview(
                operation="Replace workspace text",
                category="file_write",
                risk_level="write",
                affected_paths=affected_paths,
                preview_kind="unified_diff",
                preview_content=diff,
                preview_truncated=truncated,
            )

        mappings: dict[str, tuple[str, str, str]] = {
            "write_business_note": ("Save business note", "artifact_write", "write"),
            "run_workspace_tests": ("Run workspace tests", "command_execution", "execute"),
            "create_git_branch": ("Create Git branch", "version_control", "write"),
            "git_commit": ("Create Git commit", "version_control", "write"),
        }
        operation, category, risk_level = mappings.get(
            tool_name,
            (tool_name.replace("_", " "), "external_tool", "external"),
        )
        affected_paths: list[str] = []
        if tool_name == "run_workspace_tests":
            target = arguments.get("target")
            if isinstance(target, str) and target:
                affected_paths.append(target.partition("::")[0])
        return ApprovalPreview(
            operation=operation,
            category=category,
            risk_level=risk_level,
            affected_paths=affected_paths,
            preview_kind="summary",
            preview_content=(
                "Review the typed operation, affected paths, and exact arguments before approval."
            ),
        )

    async def _record_and_emit(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> EventRecord:
        event = self.repository.append_event(session_id, event_type, payload)
        await self._broadcast(
            session_id,
            {"type": "event", "event": event.model_dump(mode="json")},
        )
        return event

    async def _broadcast(self, session_id: str, message: dict[str, Any]) -> None:
        for emit in tuple(self._subscribers.get(session_id, ())):
            await emit(message)
