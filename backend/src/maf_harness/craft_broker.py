import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Literal

from agent_framework.exceptions import AgentFrameworkException

CraftResponseKind = Literal["complete_file", "code_fragment", "simple", "code"]
ActivityCallback = Callable[[str, dict[str, Any]], Awaitable[None]]

CRAFT_COMPLETION_MARKER = "<<<CRAFT_COMPLETE>>>"
_CHARS_PER_INPUT_TOKEN = 3
_CHARS_PER_OUTPUT_TOKEN = 4
_MAX_TARGET_PATH_CHARS = 300
_MAX_UNIT_NAME_CHARS = 80
_MAX_LANGUAGE_CHARS = 30


class CraftRequestValidationError(ValueError):
    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


class CraftIncompleteOutputError(RuntimeError):
    pass


class CraftOutputBudgetError(RuntimeError):
    pass


class CraftProviderQueueAbortedError(RuntimeError):
    pass


class _CraftEmptyOutputError(RuntimeError):
    pass


@dataclass(frozen=True)
class CraftBudget:
    context_window_tokens: int
    configured_output_tokens: int
    system_reserve_tokens: int
    input_character_budget: int
    output_tokens: int
    output_character_budget: int
    output_line_budget: int
    retry_output_tokens: int
    retry_output_character_budget: int
    retry_output_line_budget: int

    @classmethod
    def derive(cls, max_context_window_tokens: int, max_output_tokens: int) -> CraftBudget:
        system_reserve = max(192, min(384, max_context_window_tokens // 5))
        output_tokens = min(max_output_tokens, max(256, max_context_window_tokens // 2))
        available_input_tokens = max_context_window_tokens - system_reserve - output_tokens
        input_tokens = min(output_tokens, max(128, available_input_tokens))
        retry_output_tokens = max(128, output_tokens * 3 // 4)
        return cls(
            context_window_tokens=max_context_window_tokens,
            configured_output_tokens=max_output_tokens,
            system_reserve_tokens=system_reserve,
            input_character_budget=input_tokens * _CHARS_PER_INPUT_TOKEN,
            output_tokens=output_tokens,
            output_character_budget=output_tokens * _CHARS_PER_OUTPUT_TOKEN,
            output_line_budget=max(32, output_tokens // 2),
            retry_output_tokens=retry_output_tokens,
            retry_output_character_budget=retry_output_tokens * _CHARS_PER_OUTPUT_TOKEN,
            retry_output_line_budget=max(24, retry_output_tokens // 2),
        )


@dataclass(frozen=True)
class CraftRequest:
    task: str
    response_kind: CraftResponseKind
    language: str = ""
    target_path: str = ""
    unit_name: str = ""


@dataclass(frozen=True)
class CraftInferenceResult:
    content: str
    finish_reason: str | None = None


InferenceCallback = Callable[
    [str, str, int],
    Awaitable[str | CraftInferenceResult],
]


@dataclass(frozen=True)
class ValidatedCraftRequest:
    task: str
    response_kind: Literal["complete_file", "code_fragment", "simple"]
    language: str
    target_path: str
    unit_name: str
    user_prompt: str
    task_character_budget: int

    @property
    def is_code(self) -> bool:
        return self.response_kind != "simple"


@dataclass
class _EndpointLane:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    waiting: int = 0
    failure_generation: int = 0


class CraftBroker:
    def __init__(self) -> None:
        self._lanes: dict[str, _EndpointLane] = {}

    async def execute(
        self,
        request: CraftRequest,
        budget: CraftBudget,
        endpoint_key: str,
        from_model: str,
        to_model: str,
        data_boundary: str,
        infer: InferenceCallback,
        on_activity: ActivityCallback,
    ) -> str:
        try:
            validated = self._validate_request(request, budget)
        except CraftRequestValidationError as exc:
            await on_activity(
                "model_handoff_rejected",
                self._budget_payload(budget)
                | {
                    "from_role": "Counsel",
                    "to_role": "Craft",
                    "reason": exc.reason,
                    "error": str(exc),
                    "task_characters": len(request.task),
                },
            )
            raise

        payload = self._request_payload(
            validated, budget, from_model, to_model, data_boundary
        )
        lane = self._lanes.setdefault(endpoint_key, _EndpointLane())
        queue_generation = lane.failure_generation
        queue_position = lane.waiting + (1 if lane.lock.locked() else 0) + 1
        lane.waiting += 1
        acquired = False
        try:
            await on_activity(
                "model_handoff_queued",
                payload | {"status": "queued", "queue_position": queue_position},
            )
            async with lane.lock:
                acquired = True
                lane.waiting -= 1
                if queue_generation != lane.failure_generation:
                    error = CraftProviderQueueAbortedError(
                        "Craft request was queued behind a provider failure. "
                        "Retry after the local provider is available."
                    )
                    await on_activity(
                        "model_handoff_failed",
                        payload
                        | {
                            "status": "failed",
                            "reason": "provider_queue_aborted",
                            "error_type": type(error).__name__,
                        },
                    )
                    raise error
                await on_activity(
                    "model_handoff_started",
                    payload | {"status": "running", "attempt": 1},
                )
                try:
                    return await self._execute_attempts(
                        validated, budget, payload, infer, on_activity
                    )
                except (AgentFrameworkException, OSError, TimeoutError, ValueError):
                    lane.failure_generation += 1
                    raise
        finally:
            if not acquired:
                lane.waiting -= 1

    async def _execute_attempts(
        self,
        request: ValidatedCraftRequest,
        budget: CraftBudget,
        payload: dict[str, Any],
        infer: InferenceCallback,
        on_activity: ActivityCallback,
    ) -> str:
        max_attempts = 2 if request.is_code else 1
        for attempt in range(1, max_attempts + 1):
            is_retry = attempt == 2
            output_tokens = (
                budget.retry_output_tokens if is_retry else budget.output_tokens
            )
            output_characters = (
                budget.retry_output_character_budget
                if is_retry
                else budget.output_character_budget
            )
            output_lines = (
                budget.retry_output_line_budget
                if is_retry
                else budget.output_line_budget
            )
            if is_retry:
                await on_activity(
                    "model_handoff_retry",
                    payload
                    | {
                        "status": "retrying",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "reason": "incomplete_output",
                        "output_token_budget": output_tokens,
                        "output_character_budget": output_characters,
                        "output_line_budget": output_lines,
                    },
                )
            await on_activity(
                "model_handoff_attempt",
                payload
                | {
                    "status": "running",
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "output_token_budget": output_tokens,
                    "output_character_budget": output_characters,
                    "output_line_budget": output_lines,
                },
            )
            system_prompt = self._system_prompt(request, retry=is_retry)
            try:
                inference_result = await infer(
                    system_prompt, request.user_prompt, output_tokens
                )
            except (AgentFrameworkException, OSError, TimeoutError, ValueError) as exc:
                await on_activity(
                    "model_handoff_failed",
                    payload
                    | {
                        "status": "failed",
                        "attempt": attempt,
                        "reason": "provider_error",
                        "error_type": type(exc).__name__,
                    },
                )
                raise

            if isinstance(inference_result, str):
                raw_result = inference_result
                finish_reason = None
            else:
                raw_result = inference_result.content
                finish_reason = inference_result.finish_reason
            try:
                result = self._validate_output(
                    raw_result,
                    request.is_code,
                    output_tokens,
                    output_characters,
                    output_lines,
                    finish_reason,
                )
            except CraftIncompleteOutputError:
                if not is_retry:
                    continue
                await on_activity(
                    "model_handoff_failed",
                    payload
                    | {
                        "status": "failed",
                        "attempt": attempt,
                        "reason": "incomplete_output",
                        "output_characters": len(raw_result),
                    },
                )
                raise
            except CraftOutputBudgetError:
                await on_activity(
                    "model_handoff_failed",
                    payload
                    | {
                        "status": "failed",
                        "attempt": attempt,
                        "reason": "output_over_budget",
                        "output_characters": len(raw_result),
                    },
                )
                raise
            except _CraftEmptyOutputError:
                await on_activity(
                    "model_handoff_failed",
                    payload
                    | {
                        "status": "failed",
                        "attempt": attempt,
                        "reason": "empty_output",
                        "output_characters": 0,
                    },
                )
                raise

            await on_activity(
                "model_handoff_completed",
                payload
                | {
                    "status": "completed",
                    "attempts": attempt,
                    "output_characters": len(result),
                    "finish_reason": finish_reason,
                },
            )
            return result
        raise AssertionError("Craft attempt loop exited unexpectedly")

    @staticmethod
    def _validate_request(
        request: CraftRequest, budget: CraftBudget
    ) -> ValidatedCraftRequest:
        task = request.task.strip()
        if not task:
            raise CraftRequestValidationError(
                "Craft delegation requires a non-empty microtask", "empty_task"
            )
        if request.response_kind not in {
            "complete_file",
            "code_fragment",
            "simple",
            "code",
        }:
            raise CraftRequestValidationError(
                "Craft response_kind must be complete_file, code_fragment, or simple",
                "invalid_response_kind",
            )
        response_kind = (
            "complete_file" if request.response_kind == "code" else request.response_kind
        )
        target_path = request.target_path.strip().replace("\\", "/")
        language = request.language.strip().lower()
        unit_name = request.unit_name.strip()
        if len(language) > _MAX_LANGUAGE_CHARS or not all(
            character.isalnum() or character in "_+#.-" for character in language
        ):
            raise CraftRequestValidationError(
                "Craft code language contains unsupported characters", "invalid_language"
            )
        if len(target_path) > _MAX_TARGET_PATH_CHARS:
            raise CraftRequestValidationError(
                f"Craft target_path must not exceed {_MAX_TARGET_PATH_CHARS} characters",
                "target_path_over_budget",
            )
        target_candidate = PurePosixPath(target_path)
        if target_path and (
            target_candidate.is_absolute()
            or ".." in target_candidate.parts
            or any(part.endswith(":") for part in target_candidate.parts)
        ):
            raise CraftRequestValidationError(
                "Craft code handoffs require one relative target file path",
                "invalid_target_path",
            )
        target_path = target_candidate.as_posix() if target_path else ""
        if len(unit_name) > _MAX_UNIT_NAME_CHARS:
            raise CraftRequestValidationError(
                f"Craft unit_name must not exceed {_MAX_UNIT_NAME_CHARS} characters; "
                "name one concise symbol or section",
                "unit_name_over_budget",
            )
        language_line = f"Language: {language}\n" if language else ""

        if response_kind == "complete_file":
            if not target_path:
                raise CraftRequestValidationError(
                    "A complete_file microtask requires target_path", "missing_target_path"
                )
            if unit_name:
                raise CraftRequestValidationError(
                    "complete_file does not accept unit_name; use code_fragment for one symbol",
                    "unexpected_unit_name",
                )
            prefix = (
                "Mode: complete_file\n"
                f"Target path: {target_path}\n"
                f"{language_line}"
                "Return only the complete contents of this small file.\n\n"
            )
        elif response_kind == "code_fragment":
            if not target_path:
                raise CraftRequestValidationError(
                    "A code_fragment microtask requires target_path", "missing_target_path"
                )
            if not unit_name:
                raise CraftRequestValidationError(
                    "A code_fragment microtask requires a concise unit_name naming one "
                    "symbol or section",
                    "missing_unit_name",
                )
            prefix = (
                "Mode: code_fragment\n"
                f"Existing target path: {target_path}\n"
                f"Unit: {unit_name}\n"
                f"{language_line}"
                "Return only the exact replacement text for this one symbol or section.\n\n"
            )
        else:
            if target_path or unit_name or language:
                raise CraftRequestValidationError(
                    "A simple microtask does not accept target_path, unit_name, or language",
                    "unexpected_metadata",
                )
            prefix = "Mode: simple\nReturn one concise answer.\n\n"

        task_character_budget = budget.input_character_budget - len(prefix)
        if task_character_budget < 1 or len(task) > task_character_budget:
            raise CraftRequestValidationError(
                "Craft microtask input exceeds its context-derived budget "
                f"({len(task)} task characters; maximum {max(0, task_character_budget)} "
                "with this metadata). Decompose the work or provide less context.",
                "input_over_budget",
            )
        return ValidatedCraftRequest(
            task=task,
            response_kind=response_kind,
            language=language,
            target_path=target_path,
            unit_name=unit_name,
            user_prompt=prefix + task,
            task_character_budget=task_character_budget,
        )

    @staticmethod
    def _validate_output(
        raw_result: str,
        is_code: bool,
        output_tokens: int,
        output_character_budget: int,
        output_line_budget: int,
        finish_reason: str | None = None,
    ) -> str:
        raw_stripped = raw_result.rstrip()
        has_marker = raw_stripped.endswith(CRAFT_COMPLETION_MARKER)
        stripped = (
            raw_stripped[: -len(CRAFT_COMPLETION_MARKER)].rstrip()
            if is_code and has_marker
            else raw_stripped
        )
        if is_code:
            normalized = CraftBroker._strip_single_outer_code_fence(stripped)
            first_line = stripped.splitlines()[0].strip() if stripped else ""
            if normalized == stripped and first_line.startswith("```"):
                lines = stripped.splitlines()
                opener = lines[0].strip()
                has_nested_fence = any(
                    line.strip().startswith("```") for line in lines[1:]
                )
                if (
                    has_marker
                    and not has_nested_fence
                    and CraftBroker._valid_code_fence_opener(opener)
                ):
                    normalized = "\n".join(lines[1:]).rstrip()
                else:
                    raise CraftIncompleteOutputError(
                        "Craft returned a malformed outer code fence. "
                        "Delegate a smaller unit or retry the response."
                    )
            stripped = normalized
            if stripped.endswith(CRAFT_COMPLETION_MARKER):
                has_marker = True
                stripped = stripped[: -len(CRAFT_COMPLETION_MARKER)].rstrip()
        result = stripped
        if is_code and not has_marker and finish_reason != "stop":
            raise CraftIncompleteOutputError(
                "Craft did not complete the delegated code within its output limit. "
                "Delegate a smaller unit or increase the Craft provider output-token limit."
            )
        estimated_tokens = (len(result) + _CHARS_PER_OUTPUT_TOKEN - 1) // _CHARS_PER_OUTPUT_TOKEN
        line_count = len(result.splitlines()) if result else 0
        if (
            len(result) > output_character_budget
            or line_count > output_line_budget
            or estimated_tokens > output_tokens
        ):
            raise CraftOutputBudgetError(
                "Craft output exceeded its deterministic budget "
                f"({len(result)}/{output_character_budget} characters, "
                f"{line_count}/{output_line_budget} lines, "
                f"estimated {estimated_tokens}/{output_tokens} tokens). "
                "Delegate a smaller file or symbol."
            )
        if not result:
            raise _CraftEmptyOutputError("Craft returned an empty response")
        return result

    @staticmethod
    def _strip_single_outer_code_fence(value: str) -> str:
        lines = value.splitlines()
        if len(lines) < 3 or lines[-1].strip() != "```":
            return value
        opener = lines[0].strip()
        if not CraftBroker._valid_code_fence_opener(opener):
            return value
        return "\n".join(lines[1:-1]).rstrip()

    @staticmethod
    def _valid_code_fence_opener(opener: str) -> bool:
        if (
            not opener.startswith("```")
            or opener.count("`") != 3
            or len(opener) > 33
        ):
            return False
        language = opener[3:]
        return not language or all(
            character.isalnum() or character in "_+#.-" for character in language
        )

    @staticmethod
    def _system_prompt(
        request: ValidatedCraftRequest,
        *,
        retry: bool,
    ) -> str:
        prompt = (
            "You are Craft, Prudence's local implementation model. Complete only the "
            "delegated microtask. For complete_file or code_fragment, your entire response "
            "must contain the raw requested content, one newline, then a separate "
            f"{CRAFT_COMPLETION_MARKER} final line. Never emit triple backticks, a language "
            "label, explanation, or text after the marker. For simple, return one concise answer. "
            "Do not claim access to tools, files, or unstated facts."
        )
        if retry:
            prompt += (
                " RETRY: Start over from the original task. Do not quote, continue, repair, "
                "or concatenate the prior response. Use the shortest complete implementation."
            )
        return prompt

    @staticmethod
    def _budget_payload(budget: CraftBudget) -> dict[str, int]:
        return {
            "context_window_tokens": budget.context_window_tokens,
            "configured_output_tokens": budget.configured_output_tokens,
            "system_reserve_tokens": budget.system_reserve_tokens,
            "input_character_budget": budget.input_character_budget,
            "output_token_budget": budget.output_tokens,
            "output_character_budget": budget.output_character_budget,
            "output_line_budget": budget.output_line_budget,
            "retry_output_token_budget": budget.retry_output_tokens,
        }

    @classmethod
    def _request_payload(
        cls,
        request: ValidatedCraftRequest,
        budget: CraftBudget,
        from_model: str,
        to_model: str,
        data_boundary: str,
    ) -> dict[str, Any]:
        return cls._budget_payload(budget) | {
            "from_role": "Counsel",
            "from_model": from_model,
            "to_role": "Craft",
            "to_model": to_model,
            "data_boundary": data_boundary,
            "response_kind": request.response_kind,
            "target_path": request.target_path or None,
            "unit_name": request.unit_name or None,
            "task_characters": len(request.task),
            "task_character_budget": request.task_character_budget,
        }
