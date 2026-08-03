import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any

from agent_framework import Agent, FunctionTool, tool
from agent_framework.foundry import FoundryChatClient
from agent_framework.openai import OpenAIChatCompletionClient

from maf_harness.workspace_tools import WorkspaceReadTools

ActivityCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
SubagentClient = FoundryChatClient | OpenAIChatCompletionClient
MAX_DELEGATED_TASK_CHARS = 4_000


@dataclass(frozen=True)
class SubagentDefinition:
    name: str
    description: str
    instructions: str
    permissions: tuple[str, ...]
    timeout_seconds: int = 60
    max_tool_calls: int = 8
    max_tool_output_chars: int = 100_000
    max_result_chars: int = 20_000
    max_output_tokens: int = 2_048


@dataclass
class InvocationBudget:
    max_tool_calls: int
    max_tool_output_chars: int
    tool_calls: int = 0
    tool_output_chars: int = 0

    def record(self, result: str) -> str:
        if self.tool_calls >= self.max_tool_calls:
            raise RuntimeError(
                f"Subagent tool-call budget exhausted ({self.max_tool_calls} calls)"
            )
        self.tool_calls += 1
        remaining = self.max_tool_output_chars - self.tool_output_chars
        if remaining <= 0:
            raise RuntimeError(
                "Subagent tool-output budget exhausted "
                f"({self.max_tool_output_chars} characters)"
            )
        bounded = result[:remaining]
        self.tool_output_chars += len(bounded)
        if len(result) > remaining:
            bounded += "\n[Subagent tool output truncated at its character budget.]"
        return bounded


class SubagentRegistry:
    def __init__(self, workspace_root: Path) -> None:
        self._workspace = WorkspaceReadTools(workspace_root)

    def definitions(self) -> list[SubagentDefinition]:
        review_permissions = [
            "search_workspace",
            "read_workspace_file",
        ]
        if self._workspace.git_available:
            review_permissions.extend(["git_status", "git_diff", "git_log"])
        return [
            SubagentDefinition(
                name="explore_workspace",
                description=(
                    "Delegate broad read-only repository exploration and return a concise "
                    "evidence-based summary."
                ),
                instructions=(
                    "You are a read-only repository explorer. Locate relevant files and symbols, "
                    "trace only the requested behavior, cite workspace-relative paths, and return "
                    "a concise factual summary. Never claim to have changed files."
                ),
                permissions=("search_workspace", "read_workspace_file"),
            ),
            SubagentDefinition(
                name="review_workspace",
                description=(
                    "Delegate a read-only code review focused on concrete correctness, security, "
                    "and reliability defects."
                ),
                instructions=(
                    "You are a read-only code reviewer. Inspect the requested code or Git diff. "
                    "Report only high-confidence correctness, security, or reliability findings "
                    "with workspace-relative paths and actionable reasoning. If no such findings "
                    "exist, say so. Never modify files."
                ),
                permissions=tuple(review_permissions),
            ),
        ]

    def create_agent_tools(
        self,
        client: SubagentClient,
        on_activity: ActivityCallback,
    ) -> list[FunctionTool]:
        return [
            self._create_delegation_tool(client, definition, on_activity)
            for definition in self.definitions()
        ]

    def _create_delegation_tool(
        self,
        client: SubagentClient,
        definition: SubagentDefinition,
        on_activity: ActivityCallback,
    ) -> FunctionTool:
        registry = self

        @tool(name=definition.name, description=definition.description)
        async def delegate(task: str) -> str:
            normalized_task = task.strip()
            if not normalized_task:
                raise ValueError("Delegated task must not be empty")
            if len(normalized_task) > MAX_DELEGATED_TASK_CHARS:
                raise ValueError(
                    f"Delegated task must not exceed {MAX_DELEGATED_TASK_CHARS} characters"
                )
            budget = InvocationBudget(
                definition.max_tool_calls,
                definition.max_tool_output_chars,
            )
            started = monotonic()
            await on_activity(
                "subagent_started",
                registry._activity_payload(definition)
                | {"task": normalized_task, "status": "running"},
            )
            agent = Agent(
                client=client,
                name=definition.name,
                description=definition.description,
                instructions=definition.instructions,
                tools=registry._create_workspace_tools(definition, budget),
                default_options={
                    "allow_multiple_tool_calls": False,
                    "max_tokens": definition.max_output_tokens,
                },
            )
            try:
                async with asyncio.timeout(definition.timeout_seconds):
                    async with agent:
                        response = await agent.run(normalized_task)
                result = response.text
                if len(result) > definition.max_result_chars:
                    result = (
                        result[: definition.max_result_chars]
                        + "\n[Subagent result truncated at its character budget.]"
                    )
                await on_activity(
                    "subagent_completed",
                    registry._activity_payload(definition)
                    | {
                        "status": "completed",
                        "duration_ms": round((monotonic() - started) * 1_000),
                        "tool_calls": budget.tool_calls,
                        "tool_output_chars": budget.tool_output_chars,
                        "result_chars": len(result),
                    },
                )
                return result
            except Exception as exc:
                await on_activity(
                    "subagent_failed",
                    registry._activity_payload(definition)
                    | {
                        "status": "failed",
                        "duration_ms": round((monotonic() - started) * 1_000),
                        "tool_calls": budget.tool_calls,
                        "tool_output_chars": budget.tool_output_chars,
                        "error": str(exc),
                    },
                )
                raise

        return delegate

    def _create_workspace_tools(
        self,
        definition: SubagentDefinition,
        budget: InvocationBudget,
    ) -> list[FunctionTool]:
        workspace = self._workspace
        permissions = set(definition.permissions)
        tools: list[FunctionTool] = []

        if "search_workspace" in permissions:

            @tool(name="search_workspace")
            def search_workspace(query: str, path_glob: str = "**/*") -> str:
                """Search bounded UTF-8 workspace files without modifying them."""
                return budget.record(workspace.search(query, path_glob))

            tools.append(search_workspace)

        if "read_workspace_file" in permissions:

            @tool(name="read_workspace_file")
            def read_workspace_file(
                relative_path: str,
                start_line: int = 1,
                end_line: int | None = None,
            ) -> str:
                """Read a bounded line range from one UTF-8 workspace file."""
                return budget.record(
                    workspace.read_file(relative_path, start_line, end_line)
                )

            tools.append(read_workspace_file)

        if "git_status" in permissions:

            @tool(name="git_status")
            def git_status() -> str:
                """Inspect the workspace Git branch and working-tree status."""
                return budget.record(workspace.git_status())

            tools.append(git_status)

        if "git_diff" in permissions:

            @tool(name="git_diff")
            def git_diff(relative_path: str | None = None, staged: bool = False) -> str:
                """Inspect a bounded workspace Git diff without changing it."""
                return budget.record(workspace.git_diff(relative_path, staged))

            tools.append(git_diff)

        if "git_log" in permissions:

            @tool(name="git_log")
            def git_log(limit: int = 10) -> str:
                """Inspect bounded recent workspace Git history."""
                return budget.record(workspace.git_log(limit))

            tools.append(git_log)

        return tools

    @staticmethod
    def _activity_payload(definition: SubagentDefinition) -> dict[str, Any]:
        return {
            "name": definition.name,
            "permissions": list(definition.permissions),
            "timeout_seconds": definition.timeout_seconds,
            "max_tool_calls": definition.max_tool_calls,
            "max_tool_output_chars": definition.max_tool_output_chars,
            "max_result_chars": definition.max_result_chars,
            "max_output_tokens": definition.max_output_tokens,
        }
