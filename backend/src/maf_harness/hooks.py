import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from agent_framework import FunctionInvocationContext, FunctionMiddleware, Message
from pydantic import BaseModel, ConfigDict, Field

from maf_harness.schemas import HookSummary

HookEvent = Literal["session", "prompt", "pre_tool", "post_tool", "compaction", "completion"]
HookAction = Literal["audit", "block"]
ActivityCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
HOOK_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_HOOK_FILE_BYTES = 65_536
MAX_HOOKS = 50
BLOCKABLE_EVENTS = {"session", "prompt", "pre_tool", "compaction"}


class HookRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=HOOK_ID_PATTERN.pattern)
    event: HookEvent
    action: HookAction = "audit"
    message: str = Field(default="", max_length=500)
    contains: str | None = Field(default=None, min_length=1, max_length=500)
    tool_names: list[str] = Field(default_factory=list, max_length=50)


class HookDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hooks: list[HookRule]


@dataclass(frozen=True)
class HookDefinition:
    rule: HookRule
    summary: HookSummary


class HookBlockedError(RuntimeError):
    pass


class LifecycleHookRegistry:
    def __init__(self, data_directory: Path, workspace_root: Path | None = None) -> None:
        self._sources = [(data_directory / "hooks.json", "user", 10, "hooks.json")]
        if workspace_root is not None:
            prudence_path = workspace_root / ".prudence" / "hooks.json"
            legacy_path = workspace_root / ".maf-harness" / "hooks.json"
            self._sources.extend(
                [
                    (
                        legacy_path,
                        "project",
                        19,
                        ".maf-harness/hooks.json",
                    ),
                    (
                        prudence_path,
                        "project",
                        20,
                        ".prudence/hooks.json",
                    ),
                ]
            )

    def discover(self) -> list[HookDefinition]:
        effective: dict[str, HookDefinition] = {}
        for path, source, precedence, relative_path in self._sources:
            for definition in self._read_source(path, source, precedence, relative_path):
                existing = effective.get(definition.rule.id)
                if existing is None or definition.summary.precedence >= existing.summary.precedence:
                    effective[definition.rule.id] = definition
        return sorted(effective.values(), key=lambda definition: definition.rule.id)

    async def dispatch(
        self,
        definitions: list[HookDefinition],
        event: HookEvent,
        payload: Mapping[str, object],
        on_activity: ActivityCallback,
    ) -> None:
        for definition in definitions:
            rule = definition.rule
            if rule.event != event or not self._matches(rule, payload):
                continue
            activity = {
                "hook_id": rule.id,
                "event": event,
                "action": rule.action,
                "source": definition.summary.source,
                "precedence": definition.summary.precedence,
                "message": rule.message,
            }
            await on_activity("hook_triggered", activity)
            if rule.action == "block":
                await on_activity("hook_blocked", activity)
                raise HookBlockedError(rule.message or f"Hook {rule.id} blocked {event}")

    def create_function_middleware(
        self,
        definitions: list[HookDefinition],
        on_activity: ActivityCallback,
    ) -> FunctionMiddleware:
        return LifecycleFunctionMiddleware(self, definitions, on_activity)

    def _read_source(
        self,
        path: Path,
        source: str,
        precedence: int,
        relative_path: str,
    ) -> list[HookDefinition]:
        if not path.exists():
            return []
        resolved_path = path.resolve(strict=True)
        expected_root = path.parent.resolve(strict=True)
        if not resolved_path.is_relative_to(expected_root):
            raise ValueError(f"Hook file escapes its configured root: {relative_path}")
        if not resolved_path.is_file():
            raise ValueError(f"Hook source is not a file: {relative_path}")
        size = resolved_path.stat().st_size
        if size > MAX_HOOK_FILE_BYTES:
            raise ValueError(f"Hook file exceeds {MAX_HOOK_FILE_BYTES} bytes: {relative_path}")
        document = HookDocument.model_validate_json(
            resolved_path.read_text(encoding="utf-8")
        )
        rules = document.hooks
        if len(rules) > MAX_HOOKS:
            raise ValueError(f"Hook file exceeds {MAX_HOOKS} rules: {relative_path}")

        definitions: list[HookDefinition] = []
        for rule in rules:
            if rule.action == "block" and rule.event not in BLOCKABLE_EVENTS:
                raise ValueError(f"Hook {rule.id} cannot block the {rule.event} event")
            definitions.append(
                HookDefinition(
                    rule=rule,
                    summary=HookSummary(
                        id=rule.id,
                        event=rule.event,
                        action=rule.action,
                        message=rule.message,
                        source=source,
                        precedence=precedence,
                        relative_path=relative_path,
                    ),
                )
            )
        return definitions

    @staticmethod
    def _matches(rule: HookRule, payload: Mapping[str, object]) -> bool:
        if rule.contains:
            text = payload.get("text")
            if not isinstance(text, str) or rule.contains.casefold() not in text.casefold():
                return False
        if rule.tool_names:
            tool_name = payload.get("tool_name")
            if not isinstance(tool_name, str) or tool_name not in rule.tool_names:
                return False
        return True


class LifecycleFunctionMiddleware(FunctionMiddleware):
    def __init__(
        self,
        registry: LifecycleHookRegistry,
        definitions: list[HookDefinition],
        on_activity: ActivityCallback,
    ) -> None:
        self._registry = registry
        self._definitions = definitions
        self._on_activity = on_activity

    async def process(
        self,
        context: FunctionInvocationContext,
        call_next: Callable[[], Awaitable[None]],
    ) -> None:
        payload = {"tool_name": context.function.name}
        await self._registry.dispatch(
            self._definitions,
            "pre_tool",
            payload,
            self._on_activity,
        )
        try:
            await call_next()
        except Exception:
            await self._registry.dispatch(
                self._definitions,
                "post_tool",
                {**payload, "succeeded": False},
                self._on_activity,
            )
            raise
        await self._registry.dispatch(
            self._definitions,
            "post_tool",
            {**payload, "succeeded": True},
            self._on_activity,
        )


class HookedCompactionStrategy:
    def __init__(
        self,
        strategy: Callable[[list[Message]], Awaitable[bool]],
        phase: Literal["before", "after"],
        registry: LifecycleHookRegistry,
        definitions: list[HookDefinition],
        on_activity: ActivityCallback,
    ) -> None:
        self._strategy = strategy
        self._phase = phase
        self._registry = registry
        self._definitions = definitions
        self._on_activity = on_activity

    async def __call__(self, messages: list[Message]) -> bool:
        await self._registry.dispatch(
            self._definitions,
            "compaction",
            {"phase": self._phase, "message_count": len(messages)},
            self._on_activity,
        )
        return await self._strategy(messages)
