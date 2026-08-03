import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from maf_harness.config import Settings
from maf_harness.database import Database, Repository
from maf_harness.directory_picker import select_directory
from maf_harness.runner import AgentRunner, MafAgentRunner
from maf_harness.schemas import (
    ApprovalDecision,
    ApprovalRecord,
    ArtifactPreview,
    ArtifactSummary,
    HookSummary,
    McpServerSummary,
    MemoryCreate,
    MemoryEntry,
    ModeUpdate,
    ProviderConfigurationExport,
    ProviderConfigurationImport,
    ProviderKind,
    ProviderProbeRecord,
    ProviderProbeResult,
    ProviderProfile,
    ProviderProfileCreate,
    ProviderProfileUpdate,
    SessionArchive,
    SessionArchiveImport,
    SessionCraftProviderUpdate,
    SessionCreate,
    SessionDetail,
    SessionInstructionUpdate,
    SessionStateView,
    SessionSummary,
    SessionTitleUpdate,
    SkillSummary,
    StreamPrompt,
    SubagentSummary,
    WorkspaceBindRequest,
    WorkspaceCapabilityUpdate,
    WorkspaceContext,
    WorkspaceDirectorySelection,
    WorkspaceInstructionSource,
)
from maf_harness.service import HarnessService, PendingApprovalError


def create_app(
    settings: Settings | None = None,
    runner: AgentRunner | None = None,
    directory_selector: Callable[[], str | None] | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings()
    resolved_settings.data_directory.mkdir(parents=True, exist_ok=True)
    database = Database(resolved_settings.resolved_database_url)
    repository = Repository(database)
    service = HarnessService(
        repository,
        runner or MafAgentRunner(resolved_settings.data_directory),
        resolved_settings.data_directory,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        database.initialize()
        yield

    app = FastAPI(title="Prudence", version="0.1.0", lifespan=lifespan)
    app.state.repository = repository
    app.state.service = service
    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(
        _build_router(repository, service, directory_selector or select_directory)
    )
    if resolved_settings.frontend_directory.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=resolved_settings.frontend_directory, html=True),
            name="frontend",
        )
    return app


def _build_router(
    repository: Repository,
    service: HarnessService,
    directory_selector: Callable[[], str | None],
) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/providers", response_model=list[ProviderProfile])
    async def list_providers() -> list[ProviderProfile]:
        return repository.list_providers()

    @router.post("/providers", response_model=ProviderProfile, status_code=201)
    async def create_provider(profile: ProviderProfileCreate) -> ProviderProfile:
        try:
            return await service.create_provider(profile)
        except (ConnectionError, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/providers/export", response_model=ProviderConfigurationExport)
    async def export_providers() -> ProviderConfigurationExport:
        return ProviderConfigurationExport(
            profiles=[
                ProviderProfileCreate.model_validate(provider, from_attributes=True)
                for provider in repository.list_providers()
            ]
        )

    @router.post(
        "/providers/import",
        response_model=list[ProviderProfile],
        status_code=201,
    )
    async def import_providers(
        configuration: ProviderConfigurationImport,
    ) -> list[ProviderProfile]:
        try:
            return await service.import_providers(configuration.profiles)
        except (ConnectionError, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.put("/providers/{provider_id}", response_model=ProviderProfile)
    async def update_provider(
        provider_id: str,
        profile: ProviderProfileUpdate,
    ) -> ProviderProfile:
        try:
            return await service.update_provider(provider_id, profile)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (ConnectionError, OSError, TimeoutError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.delete("/providers/{provider_id}", status_code=204)
    async def delete_provider(provider_id: str) -> None:
        try:
            repository.delete_provider(provider_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/providers/{provider_id}/probe", response_model=ProviderProbeResult)
    async def probe_provider(provider_id: str) -> ProviderProbeResult:
        try:
            return await service.probe_provider(provider_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get(
        "/providers/{provider_id}/probes",
        response_model=list[ProviderProbeRecord],
    )
    async def list_provider_probes(
        provider_id: str,
        limit: int = 10,
    ) -> list[ProviderProbeRecord]:
        try:
            return repository.list_provider_probes(provider_id, limit)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/sessions", response_model=list[SessionSummary])
    async def list_sessions() -> list[SessionSummary]:
        return repository.list_sessions()

    @router.post("/sessions", response_model=SessionSummary, status_code=201)
    async def create_session(session: SessionCreate) -> SessionSummary:
        counsel = repository.get_provider(session.provider_id)
        if counsel is None:
            raise HTTPException(status_code=404, detail="Provider was not found")
        if session.craft_provider_id is not None:
            craft = repository.get_provider(session.craft_provider_id)
            if craft is None:
                raise HTTPException(status_code=404, detail="Craft provider was not found")
            if counsel.kind is not ProviderKind.FOUNDRY:
                raise HTTPException(
                    status_code=422,
                    detail="Counsel & Craft requires Microsoft Foundry as Counsel",
                )
            if craft.kind is not ProviderKind.LOCAL:
                raise HTTPException(
                    status_code=422,
                    detail="Counsel & Craft requires a local provider as Craft",
                )
        return repository.create_session(session)

    @router.post("/sessions/import", response_model=SessionSummary, status_code=201)
    async def import_session(request: SessionArchiveImport) -> SessionSummary:
        try:
            return service.import_session(request)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}", response_model=SessionDetail)
    async def get_session(session_id: str) -> SessionDetail:
        session = repository.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        return session

    @router.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: str) -> None:
        try:
            await service.delete_session(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.put("/sessions/{session_id}/title", response_model=SessionSummary)
    async def update_session_title(
        session_id: str,
        update: SessionTitleUpdate,
    ) -> SessionSummary:
        try:
            return repository.update_session_title(session_id, update.title)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.put(
        "/sessions/{session_id}/craft-provider",
        response_model=SessionSummary,
    )
    async def update_session_craft_provider(
        session_id: str,
        update: SessionCraftProviderUpdate,
    ) -> SessionSummary:
        session = repository.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        counsel = repository.get_provider(session.provider_id)
        craft = repository.get_provider(update.craft_provider_id)
        if counsel is None or counsel.kind is not ProviderKind.FOUNDRY:
            raise HTTPException(
                status_code=422,
                detail="Counsel & Craft requires Microsoft Foundry as Counsel",
            )
        if craft is None:
            raise HTTPException(status_code=404, detail="Craft provider was not found")
        if craft.kind is not ProviderKind.LOCAL:
            raise HTTPException(
                status_code=422,
                detail="Counsel & Craft requires a local provider as Craft",
            )
        return repository.update_session_craft_provider(session_id, craft.id)

    @router.get("/sessions/{session_id}/export", response_model=SessionArchive)
    async def export_session(session_id: str) -> SessionArchive:
        try:
            return service.export_session(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/state", response_model=SessionStateView)
    async def get_session_state(session_id: str) -> SessionStateView:
        if repository.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        return service.get_state(session_id)

    @router.get(
        "/sessions/{session_id}/instructions",
        response_model=list[WorkspaceInstructionSource],
    )
    async def list_session_instructions(
        session_id: str,
    ) -> list[WorkspaceInstructionSource]:
        try:
            return service.list_instruction_sources(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.put(
        "/sessions/{session_id}/instructions",
        response_model=list[WorkspaceInstructionSource],
    )
    async def update_session_instructions(
        session_id: str,
        update: SessionInstructionUpdate,
    ) -> list[WorkspaceInstructionSource]:
        try:
            return await service.update_session_instructions(session_id, update)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.delete(
        "/sessions/{session_id}/instructions",
        response_model=list[WorkspaceInstructionSource],
    )
    async def clear_session_instructions(
        session_id: str,
    ) -> list[WorkspaceInstructionSource]:
        try:
            return await service.clear_session_instructions(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/skills", response_model=list[SkillSummary])
    async def list_session_skills(session_id: str) -> list[SkillSummary]:
        try:
            return service.list_skills(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/hooks", response_model=list[HookSummary])
    async def list_session_hooks(session_id: str) -> list[HookSummary]:
        try:
            return service.list_hooks(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/mcp-servers", response_model=list[McpServerSummary])
    async def list_session_mcp_servers(session_id: str) -> list[McpServerSummary]:
        try:
            return service.list_mcp_servers(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, UnicodeDecodeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/subagents", response_model=list[SubagentSummary])
    async def list_session_subagents(session_id: str) -> list[SubagentSummary]:
        try:
            return service.list_subagents(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.put("/sessions/{session_id}/mode", response_model=SessionStateView)
    async def set_session_mode(session_id: str, update: ModeUpdate) -> SessionStateView:
        if repository.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        return service.set_mode(session_id, update.mode)

    @router.post("/sessions/{session_id}/plan/approve", response_model=SessionStateView)
    async def approve_session_plan(session_id: str) -> SessionStateView:
        try:
            return await service.approve_plan(session_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/workspace/select-directory", response_model=WorkspaceDirectorySelection)
    async def select_workspace_directory() -> WorkspaceDirectorySelection:
        try:
            selected = await asyncio.to_thread(directory_selector)
        except (OSError, RuntimeError, ValueError) as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Could not open the directory picker: {exc}",
            ) from exc
        return WorkspaceDirectorySelection(path=selected)

    @router.get("/sessions/{session_id}/workspace", response_model=WorkspaceContext | None)
    async def get_session_workspace(session_id: str) -> WorkspaceContext | None:
        if repository.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        if repository.get_workspace(session_id) is None:
            return None
        try:
            return service.get_workspace_context(session_id)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.put("/sessions/{session_id}/workspace", response_model=WorkspaceContext)
    async def bind_session_workspace(
        session_id: str,
        request: WorkspaceBindRequest,
    ) -> WorkspaceContext:
        try:
            return await service.bind_workspace(session_id, request)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.put(
        "/sessions/{session_id}/workspace/capabilities",
        response_model=WorkspaceContext,
    )
    async def update_session_workspace_capabilities(
        session_id: str,
        update: WorkspaceCapabilityUpdate,
    ) -> WorkspaceContext:
        try:
            return await service.update_workspace_capabilities(session_id, update)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/artifacts", response_model=list[ArtifactSummary])
    async def list_session_artifacts(
        session_id: str,
        query: str | None = None,
    ) -> list[ArtifactSummary]:
        try:
            return service.list_artifacts(session_id, query)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.get(
        "/sessions/{session_id}/artifacts/{artifact_id}",
        response_model=ArtifactPreview,
    )
    async def preview_session_artifact(
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> ArtifactPreview:
        try:
            return service.preview_artifact(session_id, artifact_id, version)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/artifacts/{artifact_id}/download")
    async def download_session_artifact(
        session_id: str,
        artifact_id: str,
        version: int | None = None,
    ) -> FileResponse:
        try:
            artifact, path = service.artifact_download(session_id, artifact_id, version)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        selected_version = version or artifact.current_version
        filename = (
            path.name
            if repository.get_workspace(session_id) is not None
            else f"{artifact.id}-v{selected_version}.md"
        )
        return FileResponse(
            path,
            media_type=artifact.media_type,
            filename=filename,
        )

    @router.post("/sessions/{session_id}/cancel")
    async def cancel_session_run(session_id: str) -> dict[str, bool]:
        return {"cancelled": service.cancel_run(session_id)}

    @router.get("/sessions/{session_id}/approvals", response_model=list[ApprovalRecord])
    async def list_approvals(session_id: str) -> list[ApprovalRecord]:
        if repository.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        return repository.list_approvals(session_id)

    @router.post("/approvals/{approval_id}/decision", response_model=ApprovalRecord)
    async def decide_approval(
        approval_id: str,
        decision: ApprovalDecision,
    ) -> ApprovalRecord:
        try:
            return await service.decide_approval(approval_id, decision.approved)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get("/sessions/{session_id}/memories", response_model=list[MemoryEntry])
    async def list_memories(session_id: str) -> list[MemoryEntry]:
        if repository.get_session(session_id) is None:
            raise HTTPException(status_code=404, detail="Session was not found")
        return service.list_memories(session_id)

    @router.post("/sessions/{session_id}/memories", response_model=MemoryEntry, status_code=201)
    async def create_memory(session_id: str, memory: MemoryCreate) -> MemoryEntry:
        try:
            return service.create_memory(session_id, memory)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @router.websocket("/sessions/{session_id}/stream")
    async def session_stream(websocket: WebSocket, session_id: str) -> None:
        if repository.get_session(session_id) is None:
            await websocket.close(code=4404, reason="Session was not found")
            return
        await websocket.accept()
        connection_open = True

        async def emit(message: dict[str, object]) -> None:
            nonlocal connection_open
            if not connection_open:
                return
            try:
                await websocket.send_json(message)
            except (OSError, RuntimeError, WebSocketDisconnect):
                connection_open = False

        service.subscribe(session_id, emit)
        try:
            while True:
                try:
                    request = StreamPrompt.model_validate(await websocket.receive_json())
                except (ValidationError, ValueError) as exc:
                    await emit(
                        {
                            "type": "error",
                            "payload": {"message": f"Invalid stream message: {exc}"},
                        }
                    )
                    continue
                if request.type != "prompt":
                    await emit(
                        {"type": "error", "payload": {"message": "Unsupported message type"}}
                    )
                    continue
                try:
                    await service.run_prompt(session_id, request.content)
                except PendingApprovalError as exc:
                    await emit(
                        {
                            "type": "error",
                            "payload": {"message": str(exc)},
                        }
                    )
                except Exception:
                    await emit(
                        {
                            "type": "error",
                            "payload": {
                                "message": "The run failed. See the activity panel for details."
                            },
                        }
                    )
        except WebSocketDisconnect:
            return
        finally:
            service.unsubscribe(session_id, emit)

    return router


app = create_app()
