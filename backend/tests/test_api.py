import asyncio
import json
import subprocess
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from agent_framework import Content, FunctionInvocationContext, tool
from fastapi.testclient import TestClient

from maf_harness.api import create_app
from maf_harness.artifacts import ArtifactStore
from maf_harness.config import Settings, default_data_directory
from maf_harness.craft_broker import (
    CraftBroker,
    CraftBudget,
    CraftIncompleteOutputError,
    CraftInferenceResult,
    CraftOutputBudgetError,
    CraftProviderQueueAbortedError,
    CraftRequest,
    CraftRequestValidationError,
)
from maf_harness.database import Database, Repository
from maf_harness.hooks import HookBlockedError, LifecycleHookRegistry
from maf_harness.mcp_servers import McpServerRegistry
from maf_harness.runner import (
    AgentRunner,
    CraftCodeBoundaryMiddleware,
    MafAgentRunner,
    _model_limits_from_metadata,
    _normalize_craft_target_path,
    _unsupported_code_segments,
)
from maf_harness.schemas import (
    DataBoundary,
    ProviderKind,
    ProviderProbeResult,
    ProviderProfile,
    ProviderProfileCreate,
    RunResult,
    SessionCreate,
    endpoint_data_boundary,
    published_local_model_limits,
)
from maf_harness.service import HarnessService, classify_run_failure
from maf_harness.skills import SkillRegistry
from maf_harness.subagents import InvocationBudget
from maf_harness.workspace_tools import WorkspaceReadTools


class FakeRunner:
    def __init__(self) -> None:
        self.last_workspace_instructions: str | None = None
        self.last_workspace_root: str | None = None
        self.last_workspace_write_tools_enabled = False
        self.last_workspace_auto_approve_enabled = False
        self.last_craft_profile: ProviderProfile | None = None

    async def discover_model_limits(
        self,
        profile: ProviderProfileCreate,
    ) -> tuple[int, int]:
        return profile.max_context_window_tokens, profile.max_output_tokens

    async def probe(self, profile: ProviderProfile) -> ProviderProbeResult:
        return ProviderProbeResult(
            ok=True,
            provider=profile.kind,
            model=profile.model,
            message="Fake provider is ready.",
        )

    async def generate_title(
        self,
        profile: ProviderProfile,
        user_content: str,
        assistant_content: str,
    ) -> str:
        return "Build Deterministic Agent Harness"

    async def run(
        self,
        profile: ProviderProfile,
        craft_profile: ProviderProfile | None,
        session_id: str,
        prompt: str,
        session_state: dict[str, Any] | None,
        workspace_instructions: str | None,
        workspace_root: str | None,
        workspace_write_tools_enabled: bool,
        workspace_auto_approve_enabled: bool,
        on_delta: Callable[[str], Awaitable[None]],
        on_activity: Callable[[str, dict[str, Any]], Awaitable[None]],
    ) -> RunResult:
        self.last_craft_profile = craft_profile
        self.last_workspace_instructions = workspace_instructions
        self.last_workspace_root = workspace_root
        self.last_workspace_write_tools_enabled = workspace_write_tools_enabled
        self.last_workspace_auto_approve_enabled = workspace_auto_approve_enabled
        if prompt == "Timeout":
            raise TimeoutError("Provider timed out")
        if prompt == "Partial timeout":
            await on_delta("Partial response")
            raise TimeoutError("Provider timed out after streaming")
        if prompt in {"Request approval", "Request file approval"}:
            if prompt == "Request file approval":
                tool_name = "replace_workspace_text"
                arguments = {
                    "relative_path": "app.py",
                    "old_text": "Old value",
                    "new_text": "New value",
                }
            else:
                tool_name = "write_business_note"
                arguments = {"title": "Test", "content": "Body"}
            request = Content(
                type="function_approval_request",
                id="approval-request",
                function_call=Content(
                    type="function_call",
                    call_id="call-1",
                    name=tool_name,
                    arguments=arguments,
                ),
            )
            return RunResult(
                text="",
                session_state={
                    "type": "session",
                    "session_id": session_id,
                    "state": {},
                },
                pending_approvals=[request.to_dict()],
            )
        response = f"{profile.kind}: {prompt}"
        await on_activity(
            "run_status",
            {"status": "model_processing", "label": "Model is processing the request"},
        )
        for part in (response[:8], response[8:]):
            if part:
                await on_delta(part)
        await on_activity(
            "context_usage",
            {
                "input_tokens": 128,
                "output_tokens": 16,
                "total_tokens": 144,
                "context_limit": profile.max_context_window_tokens,
                "context_percent": 0.4,
            },
        )
        turn = int((session_state or {}).get("turn", 0)) + 1
        return RunResult(
            text=response,
            session_state={
                "type": "session",
                "session_id": session_id,
                "state": {
                    "agent_mode": {"current_mode": "plan"},
                    "todo": {
                        "items": [
                            {
                                "id": 1,
                                "title": "Validate the spike",
                                "description": "Run deterministic checks",
                                "is_complete": False,
                            }
                        ]
                    },
                },
                "turn": turn,
            },
        )

    async def resume_approval(
        self,
        profile: ProviderProfile,
        craft_profile: ProviderProfile | None,
        session_id: str,
        request: dict[str, Any],
        approved: bool,
        session_state: dict[str, Any],
        workspace_instructions: str | None,
        workspace_root: str | None,
        workspace_write_tools_enabled: bool,
        workspace_auto_approve_enabled: bool,
        on_delta: Callable[[str], Awaitable[None]],
        on_activity: Callable[[str, dict[str, Any]], Awaitable[None]],
    ) -> RunResult:
        del profile, craft_profile, request
        response = "Tool approved." if approved else "Tool denied."
        await on_activity(
            "tool_result",
            {
                "call_id": "call-1",
                "name": "write_business_note",
                "result": response,
                "exception": None,
            },
        )
        await on_delta(response)
        return RunResult(text=response, session_state={**session_state, "session_id": session_id})


class SlowRunner(FakeRunner):
    async def run(
        self,
        profile: ProviderProfile,
        craft_profile: ProviderProfile | None,
        session_id: str,
        prompt: str,
        session_state: dict[str, Any] | None,
        workspace_instructions: str | None,
        workspace_root: str | None,
        workspace_write_tools_enabled: bool,
        workspace_auto_approve_enabled: bool,
        on_delta: Callable[[str], Awaitable[None]],
        on_activity: Callable[[str, dict[str, Any]], Awaitable[None]],
    ) -> RunResult:
        await asyncio.Event().wait()
        raise AssertionError("The blocked runner should have been cancelled")


class FailingProbeRunner(FakeRunner):
    async def probe(self, profile: ProviderProfile) -> ProviderProbeResult:
        del profile
        raise ConnectionError("Model server is offline")


class FailingResumeRunner(FakeRunner):
    async def resume_approval(
        self,
        profile: ProviderProfile,
        craft_profile: ProviderProfile | None,
        session_id: str,
        request: dict[str, Any],
        approved: bool,
        session_state: dict[str, Any],
        workspace_instructions: str | None,
        workspace_root: str | None,
        workspace_write_tools_enabled: bool,
        workspace_auto_approve_enabled: bool,
        on_delta: Callable[[str], Awaitable[None]],
        on_activity: Callable[[str, dict[str, Any]], Awaitable[None]],
    ) -> RunResult:
        del craft_profile
        raise TimeoutError("Provider timed out while resuming")


@pytest.mark.asyncio
async def test_provider_probe_discards_model_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_messages: list[object] = []

    class ProbeClient:
        def __init__(self, **_: object) -> None:
            pass

        def get_response(
            self,
            messages: list[object],
            *,
            stream: bool,
        ) -> object:
            captured_messages.extend(messages)
            assert stream is True

            async def updates() -> Any:
                yield "SYSTEM PROMPT CONTENT"

            return updates()

    monkeypatch.setattr("maf_harness.runner.OpenAIChatCompletionClient", ProbeClient)
    profile = ProviderProfile.model_validate(
        {
            "id": "probe-provider",
            "name": "Probe provider",
            "kind": "local",
            "endpoint": "http://127.0.0.1:57939/v1",
            "model": "probe-model",
            "created_at": "2026-08-01T00:00:00Z",
        }
    )

    result = await MafAgentRunner(tmp_path).probe(profile)

    assert result.message == "Connected successfully."
    assert len(captured_messages) == 1
    assert "SYSTEM PROMPT CONTENT" not in result.message


def make_client(
    tmp_path: Path,
    runner: AgentRunner | None = None,
    directory_selector: Callable[[], str | None] | None = None,
) -> TestClient:
    settings = Settings(
        data_directory=tmp_path,
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        frontend_directory=tmp_path / "missing-frontend",
    )
    return TestClient(
        create_app(
            settings=settings,
            runner=runner or FakeRunner(),
            directory_selector=directory_selector,
        )
    )


def test_prudence_data_directory_defaults_and_legacy_compatibility(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert default_data_directory() == tmp_path / ".prudence"

    legacy = tmp_path / ".maf-harness"
    legacy.mkdir()
    assert default_data_directory() == legacy

    preferred = tmp_path / ".prudence"
    preferred.mkdir()
    assert default_data_directory() == preferred

    legacy_database = legacy / "harness.db"
    legacy_database.touch()
    settings = Settings(data_directory=legacy)
    assert settings.resolved_database_url.endswith("/.maf-harness/harness.db")


def test_legacy_data_directory_environment_variable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PRUDENCE_DATA_DIRECTORY", raising=False)
    monkeypatch.setenv("MAF_HARNESS_DATA_DIRECTORY", str(tmp_path))

    assert Settings().data_directory == tmp_path


def test_native_workspace_directory_selection(tmp_path: Path) -> None:
    selected = tmp_path / "selected-workspace"
    selected.mkdir()

    with make_client(tmp_path, directory_selector=lambda: str(selected)) as client:
        response = client.post("/api/workspace/select-directory")
        assert response.status_code == 200
        assert response.json() == {"path": str(selected)}

    with make_client(tmp_path, directory_selector=lambda: None) as client:
        cancelled = client.post("/api/workspace/select-directory")
        assert cancelled.status_code == 200
        assert cancelled.json() == {"path": None}


def test_subagent_budget_and_workspace_contract(tmp_path: Path) -> None:
    budget = InvocationBudget(max_tool_calls=1, max_tool_output_chars=4)
    assert budget.record("abcdef") == (
        "abcd\n[Subagent tool output truncated at its character budget.]"
    )
    with pytest.raises(RuntimeError, match="tool-call budget exhausted"):
        budget.record("again")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Subagent test"},
        ).json()
        assert client.get(f"/api/sessions/{session['id']}/subagents").json() == []
        bound = client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        )
        assert bound.status_code == 200
        response = client.get(f"/api/sessions/{session['id']}/subagents")
        assert response.status_code == 200
        subagents = response.json()
        assert [item["name"] for item in subagents] == [
            "explore_workspace",
            "review_workspace",
        ]
        assert all(
            permission
            not in {
                "replace_workspace_text",
                "run_workspace_tests",
                "create_git_branch",
                "git_commit",
            }
            for item in subagents
            for permission in item["permissions"]
        )


def test_provider_session_stream_and_resume(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider_response = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        )
        assert provider_response.status_code == 201
        provider = provider_response.json()
        assert provider["data_boundary"] == "machine"

        probe_response = client.post(f"/api/providers/{provider['id']}/probe")
        assert probe_response.status_code == 200
        assert probe_response.json()["ok"] is True

        session_response = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Phase 0 test"},
        )
        assert session_response.status_code == 201
        session = session_response.json()

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Hello"})
            messages = [websocket.receive_json() for _ in range(8)]

        assert any(message["type"] == "assistant_delta" for message in messages)
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert [event["type"] for event in detail["events"]] == [
            "user_message",
            "run_started",
            "run_status",
            "context_usage",
            "assistant_message",
            "run_completed",
        ]
        assert detail["events"][4]["payload"]["content"] == "local: Hello"
        assert detail["events"][3]["payload"]["input_tokens"] == 128
        state = client.get(f"/api/sessions/{session['id']}/state").json()
        assert state["mode"] == "plan"
        assert state["tasks"][0]["title"] == "Validate the spike"

        mode_response = client.post(f"/api/sessions/{session['id']}/plan/approve")
        assert mode_response.status_code == 200
        assert mode_response.json()["mode"] == "execute"
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert detail["events"][-1]["type"] == "plan_approved"
        assert detail["events"][-1]["payload"] == {
            "remaining_steps": 1,
            "iteration_cap": 8,
        }

        memory_response = client.post(
            f"/api/sessions/{session['id']}/memories",
            json={
                "file_name": "context.md",
                "description": "Test context",
                "content": "Durable memory",
            },
        )
        assert memory_response.status_code == 201
        memories = client.get(f"/api/sessions/{session['id']}/memories").json()
        assert memories[0]["content"] == "Durable memory"
        for invalid_name in ("../escape.md", "context_description.md", "CON", "note:secret"):
            invalid_memory = client.post(
                f"/api/sessions/{session['id']}/memories",
                json={"file_name": invalid_name, "content": "Invalid"},
            )
            assert invalid_memory.status_code == 422

    with make_client(tmp_path) as resumed_client:
        resumed = resumed_client.get(f"/api/sessions/{session['id']}")
        assert resumed.status_code == 200
        assert resumed.json()["events"][4]["payload"]["content"] == "local: Hello"


def test_default_session_title_is_generated_by_active_provider(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "New session"},
        ).json()

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Build an agent harness"})
            packets = [websocket.receive_json() for _ in range(9)]

        assert any(
            packet.get("event", {}).get("type") == "session_title_updated"
            for packet in packets
        )
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert detail["title"] == "Build Deterministic Agent Harness"
        title_event = next(
            event for event in detail["events"] if event["type"] == "session_title_updated"
        )
        assert title_event["payload"] == {
            "title": "Build Deterministic Agent Harness",
            "model": "test-model",
        }


def test_counsel_and_craft_session_pairs_foundry_with_local_provider(
    tmp_path: Path,
) -> None:
    runner = FakeRunner()
    with make_client(tmp_path, runner=runner) as client:
        counsel = client.post(
            "/api/providers",
            json={
                "name": "Remote Counsel",
                "kind": "foundry",
                "endpoint": "https://example.services.ai.azure.com/api/projects/prudence",
                "model": "reasoning-model",
            },
        ).json()
        craft = client.post(
            "/api/providers",
            json={
                "name": "Local Craft",
                "kind": "local",
                "endpoint": "http://127.0.0.1:57939/v1",
                "model": "coding-model",
            },
        ).json()

        invalid_primary = client.post(
            "/api/sessions",
            json={
                "provider_id": craft["id"],
                "craft_provider_id": craft["id"],
                "title": "Invalid dual mode",
            },
        )
        assert invalid_primary.status_code == 422

        invalid_craft = client.post(
            "/api/sessions",
            json={
                "provider_id": counsel["id"],
                "craft_provider_id": counsel["id"],
                "title": "Invalid Craft",
            },
        )
        assert invalid_craft.status_code == 422

        created = client.post(
            "/api/sessions",
            json={
                "provider_id": counsel["id"],
                "craft_provider_id": craft["id"],
                "title": "Counsel and Craft",
            },
        )
        assert created.status_code == 201
        session = created.json()
        assert session["provider_id"] == counsel["id"]
        assert session["craft_provider_id"] == craft["id"]

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Build a small function"})
            messages = [websocket.receive_json() for _ in range(8)]

        assert any(message["type"] == "assistant_delta" for message in messages)
        assert runner.last_craft_profile is not None
        assert runner.last_craft_profile.id == craft["id"]
        detail = client.get(f"/api/sessions/{session['id']}").json()
        run_started = next(
            event for event in detail["events"] if event["type"] == "run_started"
        )
        assert run_started["payload"] == {
            "provider": "foundry",
            "model": "reasoning-model",
            "mode": "counsel_and_craft",
            "craft_model": "coding-model",
        }
        assert client.delete(f"/api/providers/{craft['id']}").status_code == 409


def test_raw_craft_code_is_allowed_in_final_chat_fences() -> None:
    local_source = "def add(a, b):\n    return a + b"
    assert not _unsupported_code_segments(
        f"```python\n{local_source}\n```",
        [local_source],
    )
    assert _unsupported_code_segments(
        "```python\nprint('cloud')\n```",
        [local_source],
    ) == ["print('cloud')\n"]
    assert _normalize_craft_target_path("src\\app.py") == "src/app.py"
    with pytest.raises(ValueError, match="one relative target"):
        _normalize_craft_target_path("../outside.py")


def test_session_title_can_be_renamed_with_validation(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local",
                "kind": "local",
                "endpoint": "http://127.0.0.1:5272/v1",
                "model": "local-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"]},
        ).json()

        renamed = client.put(
            f"/api/sessions/{session['id']}/title",
            json={"title": "  Customer planning workspace  "},
        )
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "Customer planning workspace"
        assert client.get(f"/api/sessions/{session['id']}").json()["title"] == (
            "Customer planning workspace"
        )
        assert client.get("/api/sessions").json()[0]["title"] == (
            "Customer planning workspace"
        )
        assert client.put(
            f"/api/sessions/{session['id']}/title",
            json={"title": "   "},
        ).status_code == 422
        assert client.put(
            f"/api/sessions/{session['id']}/title",
            json={"title": "x" * 121},
        ).status_code == 422
        assert client.put(
            "/api/sessions/missing/title",
            json={"title": "Missing"},
        ).status_code == 404


def test_session_can_be_deleted_with_related_data(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local",
                "kind": "local",
                "endpoint": "http://127.0.0.1:5272/v1",
                "model": "local-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Delete me"},
        ).json()
        workspace = tmp_path / "delete-workspace"
        workspace.mkdir()
        assert client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        ).status_code == 200
        assert client.put(
            f"/api/sessions/{session['id']}/instructions",
            json={"content": "Temporary instructions"},
        ).status_code == 200

        deleted = client.delete(f"/api/sessions/{session['id']}")
        assert deleted.status_code == 204
        assert client.get(f"/api/sessions/{session['id']}").status_code == 404
        assert all(item["id"] != session["id"] for item in client.get("/api/sessions").json())
        assert client.delete(f"/api/sessions/{session['id']}").status_code == 404


def test_session_craft_provider_can_switch_to_another_local_profile(
    tmp_path: Path,
) -> None:
    with make_client(tmp_path) as client:
        counsel = client.post(
            "/api/providers",
            json={
                "name": "Remote Counsel",
                "kind": "foundry",
                "endpoint": "https://example.services.ai.azure.com/api/projects/prudence",
                "model": "reasoning-model",
            },
        ).json()
        original_craft = client.post(
            "/api/providers",
            json={
                "name": "Original Craft",
                "kind": "local",
                "endpoint": "http://127.0.0.1:57939/v1",
                "model": "original-coding-model",
            },
        ).json()
        replacement_craft = client.post(
            "/api/providers",
            json={
                "name": "Replacement Craft",
                "kind": "local",
                "endpoint": "http://127.0.0.1:57939/v1",
                "model": "replacement-coding-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={
                "provider_id": counsel["id"],
                "craft_provider_id": original_craft["id"],
            },
        ).json()

        invalid = client.put(
            f"/api/sessions/{session['id']}/craft-provider",
            json={"craft_provider_id": counsel["id"]},
        )
        assert invalid.status_code == 422

        updated = client.put(
            f"/api/sessions/{session['id']}/craft-provider",
            json={"craft_provider_id": replacement_craft["id"]},
        )
        assert updated.status_code == 200
        assert updated.json()["craft_provider_id"] == replacement_craft["id"]
        assert client.get(f"/api/sessions/{session['id']}").json()[
            "craft_provider_id"
        ] == replacement_craft["id"]


@pytest.mark.asyncio
async def test_craft_broker_serializes_concurrent_inference_per_endpoint() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    active = 0
    max_active = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, user_prompt: str, max_tokens: int) -> str:
        nonlocal active, max_active
        assert max_tokens == budget.output_tokens
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return user_prompt.rsplit("\n", 1)[-1]

    results = await asyncio.gather(
        *[
            broker.execute(
                CraftRequest(task=f"answer-{index}", response_kind="simple"),
                budget,
                "http://127.0.0.1:11434/v1",
                "counsel",
                "craft",
                "machine",
                infer,
                on_activity,
            )
            for index in range(4)
        ]
    )

    assert results == [f"answer-{index}" for index in range(4)]
    assert max_active == 1
    assert sum(event == "model_handoff_queued" for event, _ in activities) == 4
    assert sum(event == "model_handoff_started" for event, _ in activities) == 4
    queue_payload = next(
        payload for event, payload in activities if event == "model_handoff_queued"
    )
    assert queue_payload["input_character_budget"] == budget.input_character_budget
    assert queue_payload["output_token_budget"] == budget.output_tokens


@pytest.mark.asyncio
async def test_craft_broker_rejects_oversized_input_without_model_call() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    model_calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> str:
        nonlocal model_calls
        model_calls += 1
        return "unexpected"

    with pytest.raises(CraftRequestValidationError, match="context-derived budget"):
        await broker.execute(
            CraftRequest(task="x" * 2_000, response_kind="simple"),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 0
    assert [event for event, _ in activities] == ["model_handoff_rejected"]
    assert activities[0][1]["reason"] == "input_over_budget"


@pytest.mark.asyncio
async def test_craft_broker_validates_complete_files_and_fragments() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, user_prompt: str, __: int) -> str:
        if "Mode: complete_file" in user_prompt:
            return "def main():\n    pass\n<<<CRAFT_COMPLETE>>>"
        return "def replacement():\n    return 1\n<<<CRAFT_COMPLETE>>>"

    with pytest.raises(CraftRequestValidationError, match="requires target_path"):
        await broker.execute(
            CraftRequest(task="Implement it", response_kind="complete_file"),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )
    with pytest.raises(CraftRequestValidationError, match="requires a concise unit_name"):
        await broker.execute(
            CraftRequest(
                task="Replace it",
                response_kind="code_fragment",
                target_path="src/app.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    complete = await broker.execute(
        CraftRequest(
            task="Implement it",
            response_kind="complete_file",
            target_path="src/new.py",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )
    fragment = await broker.execute(
        CraftRequest(
            task="Replace it",
            response_kind="code_fragment",
            target_path="src/app.py",
            unit_name="replacement",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )

    assert complete == "def main():\n    pass"
    assert fragment == "def replacement():\n    return 1"


@pytest.mark.asyncio
async def test_craft_broker_strips_one_outer_fence_after_completion_marker() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 1_024)
    system_prompts: list[str] = []

    async def on_activity(_: str, __: dict[str, Any]) -> None:
        return None

    async def infer(system_prompt: str, _: str, __: int) -> str:
        system_prompts.append(system_prompt)
        return "```python\ndef complete():\n    return True\n<<<CRAFT_COMPLETE>>>\n```"

    result = await broker.execute(
        CraftRequest(
            task="Implement complete",
            response_kind="complete_file",
            target_path="complete.py",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )

    assert result == "def complete():\n    return True"
    assert "Never emit triple backticks" in system_prompts[0]


@pytest.mark.asyncio
async def test_craft_broker_accepts_transport_completed_fenced_code_without_marker() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 1_024)
    activities: list[tuple[str, dict[str, Any]]] = []

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> CraftInferenceResult:
        return CraftInferenceResult(
            content="```\nFastAPI==0.116.1\nUvicorn==0.35.0\n```",
            finish_reason="stop",
        )

    result = await broker.execute(
        CraftRequest(
            task="Pin two packages",
            response_kind="complete_file",
            target_path="requirements.txt",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )

    assert result == "FastAPI==0.116.1\nUvicorn==0.35.0"
    completed = next(
        payload for event, payload in activities if event == "model_handoff_completed"
    )
    assert completed["finish_reason"] == "stop"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        "```python\ndef complete():\n    return True\n```\n<<<CRAFT_COMPLETE>>>",
        "```python\ndef complete():\n    return True\n<<<CRAFT_COMPLETE>>>",
    ],
)
async def test_craft_broker_recovers_completed_noncompliant_fences(response: str) -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 1_024)

    async def on_activity(_: str, __: dict[str, Any]) -> None:
        return None

    async def infer(_: str, __: str, ___: int) -> str:
        return response

    result = await broker.execute(
        CraftRequest(
            task="Implement complete",
            response_kind="complete_file",
            target_path="complete.py",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )

    assert result == "def complete():\n    return True"


@pytest.mark.asyncio
async def test_craft_broker_retries_malformed_outer_fence_then_fails() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 1_024)
    model_calls = 0

    async def on_activity(_: str, __: dict[str, Any]) -> None:
        return None

    async def infer(_: str, __: str, ___: int) -> CraftInferenceResult:
        nonlocal model_calls
        model_calls += 1
        return CraftInferenceResult(
            content="```python\nprint('unterminated')",
            finish_reason="stop",
        )

    with pytest.raises(CraftIncompleteOutputError, match="malformed outer code fence"):
        await broker.execute(
            CraftRequest(
                task="Write a small script",
                response_kind="complete_file",
                target_path="script.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 2


@pytest.mark.asyncio
async def test_craft_broker_retries_transport_truncated_code() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 1_024)
    model_calls = 0

    async def on_activity(_: str, __: dict[str, Any]) -> None:
        return None

    async def infer(_: str, __: str, ___: int) -> CraftInferenceResult:
        nonlocal model_calls
        model_calls += 1
        return CraftInferenceResult(
            content=f"partial attempt {model_calls}",
            finish_reason="length",
        )

    with pytest.raises(CraftIncompleteOutputError, match="did not complete"):
        await broker.execute(
            CraftRequest(
                task="Implement incomplete",
                response_kind="complete_file",
                target_path="incomplete.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 2


@pytest.mark.asyncio
async def test_craft_broker_retries_incomplete_code_once_and_succeeds() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    outputs = iter(["partial code", "complete()\n<<<CRAFT_COMPLETE>>>"])
    token_limits: list[int] = []
    system_prompts: list[str] = []
    user_prompts: list[str] = []

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(system_prompt: str, user_prompt: str, max_tokens: int) -> str:
        system_prompts.append(system_prompt)
        user_prompts.append(user_prompt)
        token_limits.append(max_tokens)
        return next(outputs)

    result = await broker.execute(
        CraftRequest(
            task="Implement complete",
            response_kind="code_fragment",
            target_path="src/app.py",
            unit_name="complete",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )

    assert result == "complete()"
    assert token_limits == [budget.output_tokens, budget.retry_output_tokens]
    assert "Start over from the original task" in system_prompts[1]
    assert user_prompts[1] == user_prompts[0]
    assert "partial code" not in user_prompts[1]
    assert sum(event == "model_handoff_retry" for event, _ in activities) == 1
    completed = next(
        payload for event, payload in activities if event == "model_handoff_completed"
    )
    assert completed["attempts"] == 2


@pytest.mark.asyncio
async def test_craft_broker_fails_after_one_incomplete_retry() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    model_calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> str:
        nonlocal model_calls
        model_calls += 1
        return f"partial attempt {model_calls}"

    with pytest.raises(CraftIncompleteOutputError, match="did not complete"):
        await broker.execute(
            CraftRequest(
                task="Implement incomplete",
                response_kind="complete_file",
                target_path="src/incomplete.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 2
    assert activities[-1][0] == "model_handoff_failed"
    assert activities[-1][1]["reason"] == "incomplete_output"


@pytest.mark.asyncio
async def test_missing_marker_retries_even_when_output_is_over_budget() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    model_calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> str:
        nonlocal model_calls
        model_calls += 1
        return "x" * (budget.output_character_budget + 1)

    with pytest.raises(CraftIncompleteOutputError, match="did not complete"):
        await broker.execute(
            CraftRequest(
                task="Implement oversized incomplete output",
                response_kind="complete_file",
                target_path="src/incomplete.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 2
    assert sum(event == "model_handoff_retry" for event, _ in activities) == 1
    assert activities[-1][0] == "model_handoff_failed"
    assert activities[-1][1]["reason"] == "incomplete_output"
    assert not any(
        payload.get("reason") == "output_over_budget" for _, payload in activities
    )


@pytest.mark.asyncio
async def test_craft_broker_does_not_retry_provider_failures() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    model_calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> str:
        nonlocal model_calls
        model_calls += 1
        raise ValueError("Provider authentication failed")

    with pytest.raises(ValueError, match="authentication"):
        await broker.execute(
            CraftRequest(
                task="Implement auth",
                response_kind="code_fragment",
                target_path="src/auth.py",
                unit_name="authenticate",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 1
    assert not any(event == "model_handoff_retry" for event, _ in activities)
    assert activities[-1][1]["reason"] == "provider_error"


@pytest.mark.asyncio
async def test_craft_broker_aborts_requests_queued_behind_provider_failure() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    first_started = asyncio.Event()
    release_failure = asyncio.Event()
    model_calls: list[str] = []

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, user_prompt: str, ___: int) -> str:
        model_calls.append(user_prompt)
        first_started.set()
        await release_failure.wait()
        raise OSError("Local provider disconnected")

    first = asyncio.create_task(
        broker.execute(
            CraftRequest(task="first", response_kind="simple"),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )
    )
    await first_started.wait()
    second = asyncio.create_task(
        broker.execute(
            CraftRequest(task="second", response_kind="simple"),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )
    )
    await asyncio.sleep(0)
    release_failure.set()

    results = await asyncio.gather(first, second, return_exceptions=True)

    assert isinstance(results[0], OSError)
    assert isinstance(results[1], CraftProviderQueueAbortedError)
    assert len(model_calls) == 1
    assert any(
        event == "model_handoff_failed"
        and payload["reason"] == "provider_queue_aborted"
        for event, payload in activities
    )


@pytest.mark.asyncio
async def test_craft_broker_rejects_marked_output_over_budget_without_retry() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []
    model_calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, __: str, ___: int) -> str:
        nonlocal model_calls
        model_calls += 1
        return "x" * (budget.output_character_budget + 1) + "\n<<<CRAFT_COMPLETE>>>"

    with pytest.raises(CraftOutputBudgetError, match="deterministic budget"):
        await broker.execute(
            CraftRequest(
                task="Implement too much",
                response_kind="complete_file",
                target_path="src/large.py",
            ),
            budget,
            "local",
            "counsel",
            "craft",
            "machine",
            infer,
            on_activity,
        )

    assert model_calls == 1
    assert not any(event == "model_handoff_retry" for event, _ in activities)
    assert activities[-1][1]["reason"] == "output_over_budget"


@pytest.mark.asyncio
async def test_raw_craft_code_passes_file_and_fragment_write_boundaries() -> None:
    broker = CraftBroker()
    budget = CraftBudget.derive(1_024, 2_048)
    activities: list[tuple[str, dict[str, Any]]] = []

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def infer(_: str, user_prompt: str, __: int) -> str:
        if "Mode: complete_file" in user_prompt:
            return "def main():\n    return 0\n<<<CRAFT_COMPLETE>>>"
        return "def existing():\n    return 1\n<<<CRAFT_COMPLETE>>>"

    complete_file = await broker.execute(
        CraftRequest(
            task="Create the entry point",
            response_kind="complete_file",
            target_path="src/main.py",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )
    code_fragment = await broker.execute(
        CraftRequest(
            task="Replace the existing function",
            response_kind="code_fragment",
            target_path="src/existing.py",
            unit_name="existing",
            language="python",
        ),
        budget,
        "local",
        "counsel",
        "craft",
        "machine",
        infer,
        on_activity,
    )
    assert "```" not in complete_file
    assert "```" not in code_fragment

    middleware = CraftCodeBoundaryMiddleware(
        [complete_file, code_fragment],
        on_activity,
    )
    persisted: dict[str, str] = {}

    @tool(name="create_workspace_file")
    def create_workspace_file(content: str) -> str:
        return content

    create_context = FunctionInvocationContext(
        function=create_workspace_file,
        arguments={"content": complete_file},
    )

    async def persist_file() -> None:
        persisted["file"] = str(create_context.arguments["content"])

    await middleware.process(create_context, persist_file)

    @tool(name="replace_workspace_text")
    def replace_workspace_text(new_text: str) -> str:
        return new_text

    replace_context = FunctionInvocationContext(
        function=replace_workspace_text,
        arguments={"new_text": code_fragment},
    )

    async def persist_fragment() -> None:
        persisted["fragment"] = str(replace_context.arguments["new_text"])

    await middleware.process(replace_context, persist_fragment)

    assert persisted == {
        "file": "def main():\n    return 0",
        "fragment": "def existing():\n    return 1",
    }
    assert all("```" not in content for content in persisted.values())
    assert not any(
        event == "model_handoff_boundary_blocked" for event, _ in activities
    )


@pytest.mark.asyncio
async def test_craft_boundary_blocks_cloud_authored_code_from_write_tools() -> None:
    activities: list[tuple[str, dict[str, Any]]] = []
    calls = 0

    async def on_activity(event_type: str, payload: dict[str, Any]) -> None:
        activities.append((event_type, payload))

    async def call_next() -> None:
        nonlocal calls
        calls += 1

    @tool(name="file_memory_write")
    def file_memory_write(content: str) -> str:
        return content

    context = FunctionInvocationContext(
        function=file_memory_write,
        arguments={"content": "```python\nprint('cloud')\n```"},
    )
    middleware = CraftCodeBoundaryMiddleware(
        ["print('local')"],
        on_activity,
    )

    allowed_context = FunctionInvocationContext(
        function=file_memory_write,
        arguments={"content": "```python\nprint('local')\n```"},
    )
    await middleware.process(allowed_context, call_next)
    assert calls == 1

    with pytest.raises(RuntimeError, match="did not originate"):
        await middleware.process(context, call_next)
    assert calls == 1

    @tool(name="replace_workspace_text")
    def replace_workspace_text(new_text: str) -> str:
        return new_text

    craft_fragment = "def local_fragment():\n    return True"
    replacement_middleware = CraftCodeBoundaryMiddleware([craft_fragment], on_activity)
    allowed_replacement = FunctionInvocationContext(
        function=replace_workspace_text,
        arguments={"new_text": craft_fragment},
    )
    await replacement_middleware.process(allowed_replacement, call_next)
    assert calls == 2

    cloud_replacement = FunctionInvocationContext(
        function=replace_workspace_text,
        arguments={"new_text": "def cloud_fragment():\n    return False"},
    )
    with pytest.raises(RuntimeError, match="did not originate"):
        await replacement_middleware.process(cloud_replacement, call_next)
    assert calls == 2

    @tool(name="create_workspace_file")
    def create_workspace_file(content: str) -> str:
        return content

    cloud_file = FunctionInvocationContext(
        function=create_workspace_file,
        arguments={"content": "def cloud_file():\n    return False"},
    )
    with pytest.raises(RuntimeError, match="did not originate"):
        await replacement_middleware.process(cloud_file, call_next)
    assert calls == 2
    assert activities == [
        (
            "model_handoff_boundary_blocked",
            {
                "from_role": "Counsel",
                "tool_name": tool_name,
                "reason": "code_not_from_craft",
            },
        )
        for tool_name in (
            "file_memory_write",
            "replace_workspace_text",
            "create_workspace_file",
        )
    ]


def test_provider_management_export_import_and_probe_history(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        created = client.post(
            "/api/providers",
            json={
                "name": " Managed local ",
                "kind": "local",
                "endpoint": "http://192.168.1.20:11434/v1",
                "model": " original-model ",
                "api_key_env": "LOCAL_MODEL_KEY",
                "max_context_window_tokens": 16_384,
                "max_output_tokens": 2_048,
            },
        ).json()
        assert created["name"] == "Managed local"
        assert created["model"] == "original-model"
        updated_response = client.put(
            f"/api/providers/{created['id']}",
            json={
                "name": "Managed local updated",
                "kind": "local",
                "endpoint": "http://192.168.1.20:11434/v1",
                "model": "updated-model",
                "api_key_env": "LOCAL_MODEL_KEY",
                "max_context_window_tokens": 32_768,
                "max_output_tokens": 4_096,
            },
        )
        assert updated_response.status_code == 200
        assert updated_response.json()["model"] == "updated-model"
        assert updated_response.json()["data_boundary"] == "local_network"

        probe = client.post(f"/api/providers/{created['id']}/probe")
        assert probe.status_code == 200
        history = client.get(f"/api/providers/{created['id']}/probes").json()
        assert len(history) == 1
        assert history[0]["ok"] is True
        assert history[0]["message"] == "Connected successfully."
        assert history[0]["streaming"] is True
        assert history[0]["tool_calling"] is True

        exported = client.get("/api/providers/export")
        assert exported.status_code == 200
        configuration = exported.json()
        assert configuration["schema_version"] == 1
        assert configuration["profiles"] == [
            {
                "name": "Managed local updated",
                "kind": "local",
                "endpoint": "http://192.168.1.20:11434/v1",
                "model": "updated-model",
                "api_key_env": "LOCAL_MODEL_KEY",
                "max_context_window_tokens": 32_768,
                "max_output_tokens": 4_096,
            }
        ]
        imported = client.post("/api/providers/import", json=configuration)
        assert imported.status_code == 201
        imported_provider = imported.json()[0]
        assert imported_provider["id"] != created["id"]
        assert client.delete(f"/api/providers/{imported_provider['id']}").status_code == 204

        session = client.post(
            "/api/sessions",
            json={"provider_id": created["id"], "title": "Uses provider"},
        )
        assert session.status_code == 201
        blocked_delete = client.delete(f"/api/providers/{created['id']}")
        assert blocked_delete.status_code == 409
        assert "sessions still reference it" in blocked_delete.json()["detail"]


def test_local_provider_uses_published_model_limits() -> None:
    assert published_local_model_limits("qwen2.5-coder-7b-instruct-cuda-gpu") == (
        131_072,
        8_192,
    )
    assert published_local_model_limits("Phi-3.5-mini-instruct-cuda-gpu") == (
        131_072,
        4_096,
    )
    assert published_local_model_limits("unknown-local-model") is None

    profile = ProviderProfileCreate(
        name="Qwen",
        kind="local",
        endpoint="http://127.0.0.1:57971/v1",
        model="qwen2.5-coder-7b-instruct-cuda-gpu",
        max_context_window_tokens=1_024,
        max_output_tokens=1_024,
    )
    assert profile.max_context_window_tokens == 131_072
    assert profile.max_output_tokens == 8_192


def test_extracts_deployed_local_model_limits() -> None:
    assert _model_limits_from_metadata(
        {"maxInputTokens": 16_384, "maxOutputTokens": 4_096}
    ) == (20_480, 4_096)
    assert _model_limits_from_metadata(
        {"context_length": 131_072, "max_completion_tokens": 8_192}
    ) == (131_072, 8_192)
    assert _model_limits_from_metadata({"id": "no-limits"}) is None


def test_provider_initialization_persists_discovered_limits(tmp_path: Path) -> None:
    class DiscoveryRunner(FakeRunner):
        async def discover_model_limits(
            self,
            profile: ProviderProfileCreate,
        ) -> tuple[int, int]:
            assert profile.model == "unregistered-model"
            return 65_536, 8_192

    with make_client(tmp_path, runner=DiscoveryRunner()) as client:
        response = client.post(
            "/api/providers",
            json={
                "name": "Discovered local",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "unregistered-model",
            },
        )

        assert response.status_code == 201
        assert response.json()["max_context_window_tokens"] == 65_536
        assert response.json()["max_output_tokens"] == 8_192
        assert client.get("/api/providers").json()[0]["max_context_window_tokens"] == 65_536


def test_failed_provider_probe_is_persisted(tmp_path: Path) -> None:
    with make_client(tmp_path, runner=FailingProbeRunner()) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Offline model",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "offline",
            },
        ).json()
        response = client.post(f"/api/providers/{provider['id']}/probe")
        assert response.status_code == 502
        history = client.get(f"/api/providers/{provider['id']}/probes").json()
        assert len(history) == 1
        assert history[0]["ok"] is False
        assert history[0]["message"] == "Model server is offline"


def test_rejects_session_for_unknown_provider(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        response = client.post(
            "/api/sessions",
            json={"provider_id": "missing", "title": "Invalid"},
        )
    assert response.status_code == 404


@pytest.mark.parametrize(
    ("kind", "endpoint", "expected"),
    [
        (ProviderKind.LOCAL, "http://localhost:11434/v1", DataBoundary.MACHINE),
        (ProviderKind.LOCAL, "http://127.0.0.1:1234/v1", DataBoundary.MACHINE),
        (ProviderKind.LOCAL, "http://192.168.1.20:1234/v1", DataBoundary.LOCAL_NETWORK),
        (ProviderKind.LOCAL, "https://models.example.com/v1", DataBoundary.EXTERNAL),
        (
            ProviderKind.FOUNDRY,
            "https://example.services.ai.azure.com",
            DataBoundary.EXTERNAL,
        ),
    ],
)
def test_classifies_provider_data_boundary(
    kind: ProviderKind,
    endpoint: str,
    expected: DataBoundary,
) -> None:
    assert endpoint_data_boundary(kind, endpoint) is expected


def test_binds_workspace_discovers_context_and_loads_instructions(tmp_path: Path) -> None:
    (tmp_path / "managed-instructions.md").write_text(
        "Follow organization policy.",
        encoding="utf-8",
    )
    (tmp_path / "instructions.md").write_text(
        "Use concise user defaults.",
        encoding="utf-8",
    )
    workspace = tmp_path / "project"
    (workspace / ".github").mkdir(parents=True)
    (workspace / ".maf-harness").mkdir()
    (workspace / ".prudence").mkdir()
    (workspace / "node_modules").mkdir()
    (workspace / "AGENTS.md").write_text("Use project conventions.", encoding="utf-8")
    (workspace / ".github" / "copilot-instructions.md").write_text(
        "Prefer typed interfaces.",
        encoding="utf-8",
    )
    (workspace / ".maf-harness" / "instructions.md").write_text(
        "Use shared project guidance.",
        encoding="utf-8",
    )
    (workspace / ".maf-harness" / "instructions.local.md").write_text(
        "Use the local test provider.",
        encoding="utf-8",
    )
    (workspace / ".prudence" / "instructions.md").write_text(
        "Use Prudence project guidance.",
        encoding="utf-8",
    )
    (workspace / ".prudence" / "instructions.local.md").write_text(
        "Use the Prudence local provider.",
        encoding="utf-8",
    )
    (workspace / "README.md").write_text("# Test project", encoding="utf-8")
    (workspace / "package.json").write_text('{"name":"test"}', encoding="utf-8")
    (workspace / "node_modules" / "ignored.js").write_text("ignored", encoding="utf-8")
    runner = FakeRunner()

    with make_client(tmp_path, runner) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Workspace test"},
        ).json()
        relative = client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": "relative/path"},
        )
        assert relative.status_code == 422

        bound = client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        )
        assert bound.status_code == 200
        context = bound.json()
        assert context["root_path"] == str(workspace.resolve())
        assert [source["relative_path"] for source in context["instructions"]] == [
            "managed-instructions.md",
            "instructions.md",
            "AGENTS.md",
            ".github/copilot-instructions.md",
            ".prudence/instructions.md",
            ".prudence/instructions.local.md",
        ]
        assert [source["scope"] for source in context["instructions"]] == [
            "managed",
            "user",
            "project_context",
            "project_context",
            "project_shared",
            "local_override",
        ]
        assert {item["relative_path"] for item in context["context_files"]} == {
            "README.md",
            "package.json",
        }
        assert context["discovered_file_count"] == 4
        assert context["discovery_truncated"] is False
        assert context["read_tools"] == ["search_workspace", "read_workspace_file"]
        assert context["write_tools_enabled"] is False
        assert context["write_tools"] == []

        session_instructions = client.put(
            f"/api/sessions/{session['id']}/instructions",
            json={"content": "Use this session override."},
        )
        assert session_instructions.status_code == 200
        instruction_list = session_instructions.json()
        assert instruction_list[-1] == {
            "scope": "session",
            "label": "Workspace session override",
            "relative_path": ".prudence/settings.json",
            "precedence": 60,
            "content": "Use this session override.",
            "editable": True,
        }

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Follow instructions"})
            for _ in range(8):
                websocket.receive_json()

        assert runner.last_workspace_instructions is not None
        assert runner.last_workspace_root == str(workspace.resolve())
        assert (
            runner.last_workspace_instructions.index("Follow organization policy.")
            < runner.last_workspace_instructions.index("Use concise user defaults.")
            < runner.last_workspace_instructions.index("Use project conventions.")
            < runner.last_workspace_instructions.index("Prefer typed interfaces.")
            < runner.last_workspace_instructions.index("Use Prudence project guidance.")
            < runner.last_workspace_instructions.index("Use the Prudence local provider.")
            < runner.last_workspace_instructions.index("Use this session override.")
        )

    with make_client(tmp_path) as resumed_client:
        restored = resumed_client.get(f"/api/sessions/{session['id']}/workspace")
        assert restored.status_code == 200
        assert restored.json()["root_path"] == str(workspace.resolve())
        restored_instructions = resumed_client.get(
            f"/api/sessions/{session['id']}/instructions"
        )
        assert restored_instructions.status_code == 200
        assert restored_instructions.json()[-1]["scope"] == "session"
        cleared = resumed_client.delete(f"/api/sessions/{session['id']}/instructions")
        assert cleared.status_code == 200
        assert all(source["scope"] != "session" for source in cleared.json())


def test_discovers_skills_progressively_with_project_precedence(tmp_path: Path) -> None:
    user_skills = tmp_path / "skills"
    user_skill = user_skills / "account-brief"
    user_skill.mkdir(parents=True)
    user_skill_content = (
        "---\n"
        "name: account-brief\n"
        "description: Create a general account briefing.\n"
        "---\n"
        "# User instructions\n"
    )
    (user_skill / "SKILL.md").write_text(user_skill_content, encoding="utf-8")

    workspace = tmp_path / "project"
    project_skill = workspace / ".maf-harness" / "skills" / "account-brief"
    project_skill.mkdir(parents=True)
    project_skill_content = (
        "---\n"
        "name: account-brief\n"
        "description: Create this project's account briefing.\n"
        "---\n"
        "# Project instructions\n"
    )
    (project_skill / "SKILL.md").write_text(project_skill_content, encoding="utf-8")
    prudence_skill = workspace / ".prudence" / "skills" / "account-brief"
    prudence_skill.mkdir(parents=True)
    prudence_skill_content = (
        "---\n"
        "name: account-brief\n"
        "description: Create this project's Prudence briefing.\n"
        "---\n"
        "# Prudence project instructions\n"
    )
    (prudence_skill / "SKILL.md").write_text(prudence_skill_content, encoding="utf-8")

    registry = SkillRegistry(user_skills, workspace)
    definitions = registry.discover()

    assert len(definitions) == 1
    assert definitions[0].summary.source == "project"
    assert definitions[0].summary.precedence == 20
    assert definitions[0].summary.relative_path == (
        ".prudence/skills/account-brief/SKILL.md"
    )
    catalog = registry.catalog_instructions(definitions)
    assert catalog is not None
    assert "Create this project's Prudence briefing." in catalog
    assert "# Prudence project instructions" not in catalog
    assert registry.load("account-brief", definitions) == prudence_skill_content

    with pytest.raises(ValueError, match="not available"):
        registry.load("missing-skill", definitions)


def test_lists_user_and_project_skills_for_session(tmp_path: Path) -> None:
    user_skill = tmp_path / "skills" / "general-review"
    user_skill.mkdir(parents=True)
    (user_skill / "SKILL.md").write_text(
        "---\nname: general-review\ndescription: Review general changes.\n---\n# Review\n",
        encoding="utf-8",
    )
    workspace = tmp_path / "project"
    project_skill = workspace / ".maf-harness" / "skills" / "project-review"
    project_skill.mkdir(parents=True)
    (project_skill / "SKILL.md").write_text(
        "---\nname: project-review\ndescription: Review project changes.\n---\n# Review\n",
        encoding="utf-8",
    )

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Skill test"},
        ).json()

        user_only = client.get(f"/api/sessions/{session['id']}/skills")
        assert user_only.status_code == 200
        assert [skill["name"] for skill in user_only.json()] == ["general-review"]

        client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        )
        combined = client.get(f"/api/sessions/{session['id']}/skills")
        assert combined.status_code == 200
        assert [(skill["name"], skill["source"]) for skill in combined.json()] == [
            ("general-review", "user"),
            ("project-review", "project"),
        ]


@pytest.mark.asyncio
async def test_hooks_apply_precedence_and_block_before_actions(tmp_path: Path) -> None:
    (tmp_path / "hooks.json").write_text(
        """
{
  "hooks": [
    {
      "id": "guard-delete",
      "event": "pre_tool",
      "action": "block",
      "tool_names": ["delete_record"],
      "message": "Deletion is disabled."
    },
    {
      "id": "prompt-audit",
      "event": "prompt",
      "contains": "customer"
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )
    workspace = tmp_path / "project"
    hook_directory = workspace / ".maf-harness"
    hook_directory.mkdir(parents=True)
    (hook_directory / "hooks.json").write_text(
        """
{
  "hooks": [
    {
      "id": "prompt-audit",
      "event": "prompt",
      "action": "block",
      "contains": "restricted",
      "message": "Restricted project prompt."
    },
    {
      "id": "completion-audit",
      "event": "completion"
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )
    prudence_hook_directory = workspace / ".prudence"
    prudence_hook_directory.mkdir()
    (prudence_hook_directory / "hooks.json").write_text(
        """
{
  "hooks": [
    {
      "id": "prompt-audit",
      "event": "prompt",
      "action": "block",
      "contains": "restricted",
      "message": "Restricted Prudence project prompt."
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )
    registry = LifecycleHookRegistry(tmp_path, workspace)
    definitions = registry.discover()
    events: list[tuple[str, dict[str, Any]]] = []

    async def collect(event_type: str, payload: dict[str, Any]) -> None:
        events.append((event_type, payload))

    assert [(definition.rule.id, definition.summary.source) for definition in definitions] == [
        ("completion-audit", "project"),
        ("guard-delete", "user"),
        ("prompt-audit", "project"),
    ]

    await registry.dispatch(
        definitions,
        "completion",
        {"has_text": True},
        collect,
    )
    assert events[-1][0] == "hook_triggered"

    with pytest.raises(HookBlockedError, match="Restricted Prudence project prompt"):
        await registry.dispatch(
            definitions,
            "prompt",
            {"text": "This is restricted."},
            collect,
        )
    assert [event_type for event_type, _ in events[-2:]] == [
        "hook_triggered",
        "hook_blocked",
    ]

    with pytest.raises(HookBlockedError, match="Deletion is disabled"):
        await registry.dispatch(
            definitions,
            "pre_tool",
            {"tool_name": "delete_record"},
            collect,
        )
    failure = classify_run_failure(
        HookBlockedError("Deletion is disabled."),
        has_partial_response=False,
    )
    assert failure["category"] == "policy_blocked"
    assert failure["message"] == "Deletion is disabled."
    assert failure["retryable"] is False


def test_lists_hooks_for_session_and_rejects_unsafe_block_phase(tmp_path: Path) -> None:
    (tmp_path / "hooks.json").write_text(
        '{"hooks":[{"id":"audit-complete","event":"completion"}]}',
        encoding="utf-8",
    )

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Hook test"},
        ).json()
        response = client.get(f"/api/sessions/{session['id']}/hooks")

        assert response.status_code == 200
        assert response.json() == [
            {
                "id": "audit-complete",
                "event": "completion",
                "action": "audit",
                "message": "",
                "source": "user",
                "precedence": 10,
                "relative_path": "hooks.json",
            }
        ]

    (tmp_path / "hooks.json").write_text(
        '{"hooks":[{"id":"unsafe","event":"post_tool","action":"block"}]}',
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="cannot block"):
        LifecycleHookRegistry(tmp_path).discover()


def test_discovers_bounded_local_mcp_servers_and_exposes_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEST_MCP_TOKEN", "secret")
    (tmp_path / "mcp.json").write_text(
        """
{
  "servers": [
    {
      "id": "disabled-tools",
      "command": "disabled-server",
      "description": "Configured but not trusted for launch.",
      "enabled": false,
      "allowed_tools": ["inspect"]
    },
    {
      "id": "local-tools",
      "command": "local-server",
      "args": ["--stdio"],
      "description": "Trusted local validation tools.",
      "enabled": true,
      "allowed_tools": ["inspect", "summarize"],
      "always_load": ["inspect"],
      "env_vars": ["TEST_MCP_TOKEN"]
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )
    registry = McpServerRegistry(tmp_path)
    servers = registry.discover()
    summaries = registry.summaries(servers)

    assert [server.id for server in servers] == ["disabled-tools", "local-tools"]
    assert summaries[0].enabled is False
    assert summaries[1].missing_env_vars == []
    assert summaries[1].approval_required is True
    assert summaries[1].progressive_disclosure is True

    tools = registry.create_tools(servers)
    assert len(tools) == 1
    assert tools[0].name == "local-tools"
    assert tools[0].approval_mode == "always_require"
    assert tools[0].allowed_tools == ["inspect", "summarize"]
    assert tools[0].use_progressive_disclosure is True


def test_lists_mcp_servers_for_session_and_reports_missing_environment(tmp_path: Path) -> None:
    (tmp_path / "mcp.json").write_text(
        """
{
  "servers": [
    {
      "id": "account-tools",
      "command": "account-server",
      "description": "Account lookup tools.",
      "enabled": true,
      "allowed_tools": ["lookup"],
      "env_vars": ["MISSING_TEST_MCP_TOKEN"]
    }
  ]
}
""".strip(),
        encoding="utf-8",
    )

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "MCP test"},
        ).json()
        response = client.get(f"/api/sessions/{session['id']}/mcp-servers")

        assert response.status_code == 200
        assert response.json()[0]["transport"] == "stdio"
        assert response.json()[0]["missing_env_vars"] == ["MISSING_TEST_MCP_TOKEN"]

    with pytest.raises(ValueError, match="missing environment"):
        McpServerRegistry(tmp_path).create_tools(McpServerRegistry(tmp_path).discover())


def test_workspace_write_capability_is_explicit_persistent_and_resets(
    tmp_path: Path,
) -> None:
    first_workspace = tmp_path / "first"
    first_workspace.mkdir()
    second_workspace = tmp_path / "second"
    second_workspace.mkdir()
    runner = FakeRunner()

    with make_client(tmp_path, runner) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Capability test"},
        ).json()
        client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(first_workspace)},
        )

        requires_write_access = client.put(
            f"/api/sessions/{session['id']}/workspace/capabilities",
            json={"auto_approve_enabled": True},
        )
        assert requires_write_access.status_code == 422
        enabled = client.put(
            f"/api/sessions/{session['id']}/workspace/capabilities",
            json={"write_tools_enabled": True},
        )
        assert enabled.status_code == 200
        assert enabled.json()["write_tools_enabled"] is True
        assert enabled.json()["write_tools"] == [
            "create_workspace_file",
            "replace_workspace_text",
            "run_workspace_tests",
        ]
        assert enabled.json()["auto_approve_enabled"] is False
        auto_approve = client.put(
            f"/api/sessions/{session['id']}/workspace/capabilities",
            json={"auto_approve_enabled": True},
        )
        assert auto_approve.status_code == 200
        assert auto_approve.json()["auto_approve_enabled"] is True

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Use tools"})
            for _ in range(8):
                websocket.receive_json()
        assert runner.last_workspace_write_tools_enabled is True
        assert runner.last_workspace_auto_approve_enabled is True

    with make_client(tmp_path) as resumed_client:
        restored = resumed_client.get(f"/api/sessions/{session['id']}/workspace")
        assert restored.json()["write_tools_enabled"] is True
        assert restored.json()["auto_approve_enabled"] is True
        rebound = resumed_client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(second_workspace)},
        )
        assert rebound.json()["write_tools_enabled"] is False
        assert rebound.json()["auto_approve_enabled"] is False
        assert rebound.json()["write_tools"] == []


def test_workspace_read_tools_enforce_bounds_and_inspect_git(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace-tools"
    workspace.mkdir()
    source = workspace / "app.py"
    source.write_text("first line\nTarget value\nlast line\n", encoding="utf-8")
    ignored = workspace / "node_modules"
    ignored.mkdir()
    (ignored / "dependency.js").write_text("Target value", encoding="utf-8")

    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=workspace,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Harness Test"],
        cwd=workspace,
        check=True,
    )
    subprocess.run(["git", "add", "app.py"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-m", "Initial"], cwd=workspace, check=True)
    source.write_text("first line\nTarget updated\nlast line\n", encoding="utf-8")

    tools = WorkspaceReadTools(workspace)
    assert tools.capability_names == [
        "search_workspace",
        "read_workspace_file",
        "git_status",
        "git_diff",
        "git_log",
    ]
    agent_tools = tools.create_agent_tools(write_tools_enabled=True)
    tool_modes = {
        agent_tool.name: agent_tool.approval_mode
        for agent_tool in agent_tools
    }
    assert tool_modes["search_workspace"] == "never_require"
    assert tool_modes["git_diff"] == "never_require"
    assert tool_modes["create_workspace_file"] == "always_require"
    assert tool_modes["replace_workspace_text"] == "always_require"
    assert tool_modes["run_workspace_tests"] == "always_require"
    assert tool_modes["create_git_branch"] == "always_require"
    assert tool_modes["git_commit"] == "always_require"
    auto_approved_tools = tools.create_agent_tools(
        write_tools_enabled=True,
        auto_approve_enabled=True,
    )
    assert all(
        agent_tool.approval_mode == "never_require"
        for agent_tool in auto_approved_tools
    )
    assert tools.search("target", "**/*.py") == "app.py:2: Target updated"
    assert "node_modules" not in tools.search("target")
    assert tools.read_file("app.py", 2, 3) == (
        "app.py (lines 2-3)\n2: Target updated\n3: last line"
    )
    assert tools.create_file("src/new.py", "print('new')\n") == "Created src/new.py."
    assert (workspace / "src" / "new.py").read_text(encoding="utf-8") == "print('new')\n"
    with pytest.raises(ValueError, match="already exists"):
        tools.create_file("src/new.py", "replacement")
    assert "app.py" in tools.git_status()
    assert "-Target value" in tools.git_diff("app.py")
    assert "Initial" in tools.git_log(1)
    assert tools.replace_text("app.py", "Target updated", "Target replaced") == (
        "Replaced one occurrence in app.py."
    )
    assert source.read_text(encoding="utf-8").splitlines()[1] == "Target replaced"

    test_file = workspace / "test_sample.py"
    test_file.write_text("def test_sample():\n    assert True\n", encoding="utf-8")
    assert "1 passed" in tools.run_tests("pytest", "test_sample.py")

    assert "feature/tools" in tools.create_git_branch("feature/tools")
    subprocess.run(["git", "add", "app.py"], cwd=workspace, check=True)
    assert "Update target" in tools.git_commit("Update target")
    assert "Update target" in tools.git_log(1)
    with pytest.raises(ValueError, match="relative path"):
        tools.read_file("../outside.txt")
    with pytest.raises(ValueError, match="relative path"):
        tools.create_file("../outside.txt", "outside")
    with pytest.raises(ValueError, match="400 lines"):
        tools.read_file("app.py", 1, 401)
    with pytest.raises(ValueError, match="between 1 and 20"):
        tools.git_log(21)
    with pytest.raises(ValueError, match="Unsupported test runner"):
        tools.run_tests("powershell")
    with pytest.raises(ValueError, match="relative path"):
        tools.run_tests("pytest", "../outside.py")
    with pytest.raises(ValueError, match="does not accept"):
        tools.run_tests("npm_test", "outside.js")
    with pytest.raises(ValueError, match="unsupported characters"):
        tools.create_git_branch("--unsafe")


def test_workspace_replace_preview_is_bounded_and_read_only(tmp_path: Path) -> None:
    workspace = tmp_path / "preview-workspace"
    workspace.mkdir()
    source = workspace / "app.py"
    source.write_text("Old value\n", encoding="utf-8")
    tools = WorkspaceReadTools(workspace)

    preview, truncated = tools.preview_replace_text("app.py", "Old value", "New value")
    assert "--- a/app.py" in preview
    assert "+++ b/app.py" in preview
    assert "-Old value" in preview
    assert "+New value" in preview
    assert truncated is False
    assert source.read_text(encoding="utf-8") == "Old value\n"

    source.write_text(f"{'A' * 120_000}\n", encoding="utf-8")
    preview, truncated = tools.preview_replace_text(
        "app.py",
        "A" * 120_000,
        "B" * 120_000,
    )
    assert len(preview) == 100_000
    assert truncated is True


def test_searches_previews_downloads_and_versions_artifacts(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Artifact test"},
        ).json()
        store = ArtifactStore(tmp_path / "artifacts")
        first = store.write_business_note(session["id"], "Quarterly plan", "Version one")
        second = store.write_business_note(session["id"], "Quarterly plan", "Version two")
        store.write_business_note(session["id"], "Other note", "Other content")

        assert first.id == second.id
        assert second.current_version == 2
        assert [version.version for version in second.versions] == [1, 2]

        search = client.get(
            f"/api/sessions/{session['id']}/artifacts",
            params={"query": "quarterly"},
        )
        assert search.status_code == 200
        assert [artifact["title"] for artifact in search.json()] == ["Quarterly plan"]

        current = client.get(
            f"/api/sessions/{session['id']}/artifacts/{first.id}",
        )
        assert current.status_code == 200
        assert current.json()["version"] == 2
        assert current.json()["content"].endswith("Version two")

        original = client.get(
            f"/api/sessions/{session['id']}/artifacts/{first.id}",
            params={"version": 1},
        )
        assert original.status_code == 200
        assert original.json()["content"].endswith("Version one")

        download = client.get(
            f"/api/sessions/{session['id']}/artifacts/{first.id}/download",
            params={"version": 1},
        )
        assert download.status_code == 200
        assert download.text.endswith("Version one")
        assert f"{first.id}-v1.md" in download.headers["content-disposition"]

        invalid = client.get(
            f"/api/sessions/{session['id']}/artifacts/not-an-id",
        )
        assert invalid.status_code == 422


def test_workspace_settings_and_memory_are_shared_and_portable(tmp_path: Path) -> None:
    workspace = tmp_path / "shared-workspace"
    workspace.mkdir()

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        first = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "First"},
        ).json()
        second = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Second"},
        ).json()
        client.post(
            f"/api/sessions/{first['id']}/memories",
            json={
                "file_name": "existing.md",
                "description": "Existing memory",
                "content": "Migrated content",
            },
        )
        legacy_bundle = tmp_path / "memory" / first["id"] / "coffee-shop"
        legacy_bundle.mkdir()
        (legacy_bundle / "orders.md").write_text("latte", encoding="utf-8")
        client.post(
            f"/api/sessions/{second['id']}/memories",
            json={"file_name": "second.md", "content": "Second session memory"},
        )

        assert client.put(
            f"/api/sessions/{first['id']}/workspace",
            json={"path": str(workspace)},
        ).status_code == 200
        assert (
            workspace / ".prudence" / "memory" / "existing.md"
        ).read_text(encoding="utf-8") == "Migrated content"
        assert (
            workspace / ".prudence" / "memory" / "coffee-shop" / "orders.md"
        ).read_text(encoding="utf-8") == "latte"
        assert (tmp_path / "memory" / first["id"] / "existing.md").is_file()

        client.put(
            f"/api/sessions/{first['id']}/instructions",
            json={"content": "Shared workspace override."},
        )
        client.put(
            f"/api/sessions/{first['id']}/workspace/capabilities",
            json={"write_tools_enabled": True},
        )
        settings = json.loads(
            (workspace / ".prudence" / "settings.json").read_text(encoding="utf-8")
        )
        assert settings == {
            "schema_version": 1,
            "write_tools_enabled": True,
            "auto_approve_enabled": False,
            "session_instructions": "Shared workspace override.",
        }

        second_context = client.put(
            f"/api/sessions/{second['id']}/workspace",
            json={"path": str(workspace)},
        ).json()
        assert second_context["write_tools_enabled"] is True
        assert second_context["instructions"][-1]["content"] == (
            "Shared workspace override."
        )
        client.post(
            f"/api/sessions/{second['id']}/memories",
            json={"file_name": "shared.md", "content": "Visible to both"},
        )
        first_memories = client.get(
            f"/api/sessions/{first['id']}/memories"
        ).json()
        assert {memory["file_name"] for memory in first_memories} == {
            "existing.md",
            "second.md",
            "shared.md",
        }

    settings_path = workspace / ".prudence" / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "write_tools_enabled": False,
                "session_instructions": "Portable file authority.",
            }
        ),
        encoding="utf-8",
    )
    with make_client(tmp_path) as resumed:
        restored = resumed.get(f"/api/sessions/{second['id']}/workspace").json()
        assert restored["write_tools_enabled"] is False
        assert restored["instructions"][-1]["content"] == "Portable file authority."


def test_workspace_memory_migration_conflicts_do_not_overwrite(tmp_path: Path) -> None:
    workspace = tmp_path / "conflict-workspace"
    destination = workspace / ".prudence" / "memory"
    destination.mkdir(parents=True)
    (destination / "context.md").write_text("workspace value", encoding="utf-8")

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Conflict"},
        ).json()
        client.post(
            f"/api/sessions/{session['id']}/memories",
            json={"file_name": "context.md", "content": "global value"},
        )

        response = client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        )
        assert response.status_code == 422
        assert "migration conflicts" in response.json()["detail"]
        assert (destination / "context.md").read_text(encoding="utf-8") == (
            "workspace value"
        )
        assert not (workspace / ".prudence" / "settings.json").exists()
        assert client.get(f"/api/sessions/{session['id']}/workspace").json() is None


def test_workspace_mutations_index_real_shared_artifacts(tmp_path: Path) -> None:
    workspace = tmp_path / "artifact-workspace"
    workspace.mkdir()

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        first = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Writer"},
        ).json()
        second = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Reader"},
        ).json()
        for session in (first, second):
            client.put(
                f"/api/sessions/{session['id']}/workspace",
                json={"path": str(workspace)},
            )
        with client.websocket_connect(f"/api/sessions/{first['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Request approval"})
            for _ in range(4):
                websocket.receive_json()
        approval = client.get(f"/api/sessions/{first['id']}/approvals").json()[0]
        assert approval["preview"]["affected_paths"] == [
            "prudence-notes/test.md"
        ]
        assert "prudence-notes/test.md" in approval["preview"]["preview_content"]

        store = ArtifactStore.for_workspace(workspace)
        tools = WorkspaceReadTools(
            workspace,
            on_file_mutated=lambda path: store.index_workspace_file(
                first["id"], path
            ),
        )
        assert tools.create_file("reports/summary.txt", "Version one") == (
            "Created reports/summary.txt."
        )
        with pytest.raises(ValueError, match="already exists"):
            tools.create_file("reports/summary.txt", "overwrite")
        with pytest.raises(ValueError, match="relative path"):
            tools.create_file("../outside.txt", "outside")
        tools.replace_text("reports/summary.txt", "one", "two")

        listing = client.get(
            f"/api/sessions/{second['id']}/artifacts"
        ).json()
        assert len(listing) == 1
        assert len(listing[0]["versions"]) == 1
        assert listing[0]["versions"][0]["version"] == 2
        assert listing[0]["versions"][0]["file_name"] == "reports/summary.txt"
        assert listing[0]["versions"][0]["size_bytes"] == len("Version two")
        assert listing[0]["current_version"] == 2
        artifact_id = listing[0]["id"]
        assert client.get(
            f"/api/sessions/{second['id']}/artifacts/{artifact_id}",
            params={"version": 1},
        ).status_code == 404
        preview = client.get(
            f"/api/sessions/{second['id']}/artifacts/{artifact_id}"
        ).json()
        assert preview["content"] == "Version two"
        download = client.get(
            f"/api/sessions/{second['id']}/artifacts/{artifact_id}/download"
        )
        assert download.text == "Version two"
        assert "summary.txt" in download.headers["content-disposition"]
        assert not list((workspace / ".prudence").rglob("*.txt"))

        tools.create_file("docs/plan.md", "Original project plan")
        collision_note = store.write_business_note(
            first["id"], "docs/plan.md", "Separate business note"
        )
        assert (workspace / "docs" / "plan.md").read_text(encoding="utf-8") == (
            "Original project plan"
        )
        collision_path = collision_note.versions[-1].file_name
        assert collision_path == "prudence-notes/docs-plan-md.md"
        assert (workspace / collision_path).read_text(encoding="utf-8") == (
            "# docs/plan.md\n\nSeparate business note"
        )

        note = store.write_business_note(first["id"], "Customer brief", "Real note")
        note_path = workspace / "prudence-notes" / "customer-brief.md"
        assert note_path.read_text(encoding="utf-8") == "# Customer brief\n\nReal note"
        note = store.write_business_note(first["id"], "Customer brief", "Updated note")
        assert note.current_version == 2
        assert [version.version for version in note.versions] == [2]
        assert client.get(
            f"/api/sessions/{second['id']}/artifacts/{note.id}"
        ).json()["content"].endswith("Updated note")


def test_portable_session_archive_round_trip_excludes_runtime_state(tmp_path: Path) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Portable local",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
                "api_key_env": "LOCAL_MODEL_API_KEY",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Portable session"},
        ).json()
        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Archive this conversation"})
            for _ in range(8):
                websocket.receive_json()
        client.post(
            f"/api/sessions/{session['id']}/memories",
            json={
                "file_name": "context.md",
                "description": "Portable context",
                "content": "Remember this.",
            },
        )
        client.put(
            f"/api/sessions/{session['id']}/instructions",
            json={"content": "Use the imported session guidance."},
        )
        store = ArtifactStore(tmp_path / "artifacts")
        store.write_business_note(session["id"], "Portable note", "Version one")
        store.write_business_note(session["id"], "Portable note", "Version two")

        exported = client.get(f"/api/sessions/{session['id']}/export")
        assert exported.status_code == 200
        archive = exported.json()
        assert archive["schema_version"] == 1
        assert archive["source_provider"]["api_key_env"] == "LOCAL_MODEL_API_KEY"
        assert "id" not in archive["source_provider"]
        assert "maf_state" not in archive
        assert "workspace" not in archive
        assert all("id" not in event for event in archive["events"])
        assert archive["memories"][0]["content"] == "Remember this."
        assert archive["artifacts"][0]["versions"] == [
            "# Portable note\n\nVersion one",
            "# Portable note\n\nVersion two",
        ]

        imported = client.post(
            "/api/sessions/import",
            json={"provider_id": provider["id"], "archive": archive},
        )
        assert imported.status_code == 201
        imported_session = imported.json()
        assert imported_session["id"] != session["id"]
        assert imported_session["title"] == "Portable session (imported)"

        detail = client.get(f"/api/sessions/{imported_session['id']}").json()
        assert detail["events"][-1]["type"] == "session_imported"
        assert detail["events"][-1]["payload"]["continuation_state_restored"] is False
        assert client.get(
            f"/api/sessions/{imported_session['id']}/memories"
        ).json()[0]["content"] == "Remember this."
        assert client.get(
            f"/api/sessions/{imported_session['id']}/artifacts"
        ).json()[0]["current_version"] == 2
        instructions = client.get(
            f"/api/sessions/{imported_session['id']}/instructions"
        ).json()
        assert instructions[-1]["content"] == "Use the imported session guidance."
        assert client.get(f"/api/sessions/{imported_session['id']}/workspace").json() is None
        assert client.get(f"/api/sessions/{imported_session['id']}/approvals").json() == []


@pytest.mark.parametrize(
    ("prompt", "packet_count", "retryable"),
    [("Timeout", 4, True), ("Partial timeout", 6, False)],
)
def test_classifies_transient_failures_and_safe_retry(
    tmp_path: Path,
    prompt: str,
    packet_count: int,
    retryable: bool,
) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Failure test"},
        ).json()

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": prompt})
            messages = [websocket.receive_json() for _ in range(packet_count)]

        assert messages[-1]["type"] == "error"
        detail = client.get(f"/api/sessions/{session['id']}").json()
        failure = next(event for event in detail["events"] if event["type"] == "run_failed")
        assert failure["payload"]["category"] == "timeout"
        assert failure["payload"]["transient"] is True
        assert failure["payload"]["retryable"] is retryable
        assert failure["payload"]["message"] == (
            "The model provider timed out. Check connectivity and retry."
        )


@pytest.mark.parametrize(("approved", "expected_status"), [(True, "approved"), (False, "denied")])
def test_approval_continuation_and_duplicate_rejection(
    tmp_path: Path,
    approved: bool,
    expected_status: str,
) -> None:
    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Approval test"},
        ).json()

        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Request approval"})
            messages = [websocket.receive_json() for _ in range(4)]

        assert any(
            message.get("event", {}).get("type") == "approval_requested"
            for message in messages
        )
        approval = client.get(f"/api/sessions/{session['id']}/approvals").json()[0]
        assert approval["status"] == "pending"
        assert approval["preview"] == {
            "operation": "Save business note",
            "category": "artifact_write",
            "risk_level": "write",
            "affected_paths": [],
            "preview_kind": "summary",
            "preview_content": (
                "Review the typed operation, affected paths, and exact arguments "
                "before approval."
            ),
            "preview_truncated": False,
        }
        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Skip the approval"})
            blocked = websocket.receive_json()
        assert blocked == {
            "type": "error",
            "payload": {
                "message": "Resolve the pending approval before sending another message."
            },
        }
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert sum(event["type"] == "user_message" for event in detail["events"]) == 1
        decision = client.post(
            f"/api/approvals/{approval['id']}/decision",
            json={"approved": approved},
        )
        assert decision.status_code == 200
        assert decision.json()["status"] == expected_status

        duplicate = client.post(
            f"/api/approvals/{approval['id']}/decision",
            json={"approved": approved},
        )
        assert duplicate.status_code == 409
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert detail["events"][-1]["type"] == "run_completed"
        assert detail["events"][-2]["payload"]["content"] == (
            "Tool approved." if approved else "Tool denied."
        )
        assert detail["events"][-3]["type"] == "tool_result"


def test_file_approval_preview_persists_across_restart(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("before\nOld value\nafter\n", encoding="utf-8")

    with make_client(tmp_path) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "File approval preview"},
        ).json()
        client.put(
            f"/api/sessions/{session['id']}/workspace",
            json={"path": str(workspace)},
        )
        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Request file approval"})
            for _ in range(4):
                websocket.receive_json()

        approval = client.get(f"/api/sessions/{session['id']}/approvals").json()[0]
        assert approval["preview"]["operation"] == "Replace workspace text"
        assert approval["preview"]["category"] == "file_write"
        assert approval["preview"]["affected_paths"] == ["app.py"]
        assert approval["preview"]["preview_kind"] == "unified_diff"
        assert "-Old value" in approval["preview"]["preview_content"]
        assert "+New value" in approval["preview"]["preview_content"]
        approval_id = approval["id"]

    with make_client(tmp_path) as resumed_client:
        restored = resumed_client.get(
            f"/api/sessions/{session['id']}/approvals"
        ).json()[0]
        assert restored["id"] == approval_id
        assert restored["preview"] == approval["preview"]


def test_failed_approval_resume_keeps_decision_and_records_failure(tmp_path: Path) -> None:
    with make_client(tmp_path, FailingResumeRunner()) as client:
        provider = client.post(
            "/api/providers",
            json={
                "name": "Local test",
                "kind": "local",
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": "test-model",
            },
        ).json()
        session = client.post(
            "/api/sessions",
            json={"provider_id": provider["id"], "title": "Approval failure test"},
        ).json()
        with client.websocket_connect(f"/api/sessions/{session['id']}/stream") as websocket:
            websocket.send_json({"type": "prompt", "content": "Request approval"})
            for _ in range(4):
                websocket.receive_json()

        approval = client.get(f"/api/sessions/{session['id']}/approvals").json()[0]
        decision = client.post(
            f"/api/approvals/{approval['id']}/decision",
            json={"approved": True},
        )
        assert decision.status_code == 502
        decided = client.get(f"/api/sessions/{session['id']}/approvals").json()[0]
        assert decided["status"] == "approved"
        detail = client.get(f"/api/sessions/{session['id']}").json()
        assert detail["events"][-2]["type"] == "approval_decided"
        assert detail["events"][-1]["type"] == "run_failed"
        assert detail["events"][-1]["payload"]["retryable"] is True


@pytest.mark.asyncio
async def test_cancels_active_run_and_persists_event(tmp_path: Path) -> None:
    database = Database(f"sqlite:///{(tmp_path / 'cancel.db').as_posix()}")
    database.initialize()
    repository = Repository(database)
    provider = repository.create_provider(
        ProviderProfileCreate(
            name="Local test",
            kind="local",
            endpoint="http://127.0.0.1:11434/v1",
            model="test-model",
        )
    )
    session = repository.create_session(
        SessionCreate(provider_id=provider.id, title="Cancellation test")
    )
    service = HarnessService(repository, SlowRunner(), tmp_path)

    first_connection: list[dict[str, Any]] = []
    reconnected: list[dict[str, Any]] = []

    async def collect_first(message: dict[str, Any]) -> None:
        first_connection.append(message)

    async def collect_reconnected(message: dict[str, Any]) -> None:
        reconnected.append(message)

    service.subscribe(session.id, collect_first)
    run = asyncio.create_task(service.run_prompt(session.id, "Wait"))
    for _ in range(20):
        if service.get_state(session.id).is_running:
            break
        await asyncio.sleep(0)
    service.unsubscribe(session.id, collect_first)
    service.subscribe(session.id, collect_reconnected)
    assert service.cancel_run(session.id) is True
    await run

    detail = repository.get_session(session.id)
    assert detail is not None
    assert detail.events[-1].type == "run_cancelled"
    assert any(
        message.get("event", {}).get("type") == "run_cancelled"
        for message in reconnected
    )
    assert not any(
        message.get("event", {}).get("type") == "run_cancelled"
        for message in first_connection
    )
