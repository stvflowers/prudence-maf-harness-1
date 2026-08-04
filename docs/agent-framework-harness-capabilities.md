# Agent Framework harness capabilities in Prudence

Prudence is built with Microsoft Agent Framework's `create_harness_agent` factory, but it
does not enable every factory capability exactly as supplied. Some capabilities use the
framework defaults, some are replaced with Prudence-specific implementations, and some are
intentionally disabled.

## Status summary

| Capability | Status in Prudence | Implementation |
| --- | --- | --- |
| Function invocation | In use | Native Agent Framework tool loop |
| Per-service-call history persistence | Partial | Native in-memory per-call persistence; SQLite checkpoint after the run |
| Compaction | In use | Native token-budget compaction, optionally wrapped by Prudence hooks |
| Todo provider | In use | Native `TodoProvider` |
| Agent mode provider | In use | Native `AgentModeProvider` |
| File memory provider | In use with a mode exception | Native `FileMemoryProvider`; disabled in Counsel & Craft mode |
| File access provider | Custom equivalent | Prudence workspace tools replace the native provider |
| Tool approval | In use with custom policy | Native approval middleware plus Prudence approval UI and auto-approve setting |
| OpenTelemetry | Wired, not exported by this project | Native MAF instrumentation; no Prudence exporter configuration |
| Web search | Disabled | Explicitly disabled |
| Skills provider | Custom equivalent | Prudence skill registry and progressive `load_skill` tool |
| Background agents | Custom, foreground-only equivalent | Bounded read-only delegated agents; not MAF background/parallel agents |
| Shell environment | Not in use | No general shell executor or shell environment provider |
| Looping | In use | Native todo-driven loop capped at eight iterations |

## Shared harness configuration

Start with
[`_create_configured_agent`](../backend/src/maf_harness/runner.py#L177). This is the central
configuration point for most of the capabilities below.

```python
return create_harness_agent(
    client=client,
    name="Prudence",
    agent_instructions=agent_instructions,
    max_context_window_tokens=profile.max_context_window_tokens,
    max_output_tokens=profile.max_output_tokens,
    tools=tools,
    before_compaction_strategy=before_compaction,
    after_compaction_strategy=after_compaction,
    loop_should_continue=todos_remaining(looping_modes=["execute"]),
    loop_next_message=todos_remaining_message,
    loop_max_iterations=8,
    disable_web_search=True,
    disable_file_memory=True,
    file_access_store=InMemoryAgentFileStore(),
    file_access_disable_write_tools=True,
    context_providers=context_providers,
    middleware=middleware,
)
```

## 1. Function invocation

**Status: In use through Agent Framework.**

`create_harness_agent` supplies the automatic model/tool invocation loop. Prudence builds a
tool list before creating the agent. The list can include business notes, Counsel & Craft,
MCP, skills, workspace operations, and delegated agents.

Look at [`MafAgentRunner._run_with_client`](../backend/src/maf_harness/runner.py#L560):

```python
tools: list[object] = [write_business_note]
...
tools.extend(mcp_registry.create_tools(mcp_servers))
...
tools.extend(
    WorkspaceReadTools(
        workspace_path,
        on_file_mutated=index_workspace_mutation,
    ).create_agent_tools(
        workspace_write_tools_enabled,
        workspace_auto_approve_enabled,
    )
)
```

Tool calls and results are also surfaced as persistent activity events in
[`MafAgentRunner._execute_agent`](../backend/src/maf_harness/runner.py#L890).

## 2. Per-service-call history persistence

**Status: Partial.**

The MAF harness is created with its default history provider. Internally, the harness requires
per-service-call history persistence, so each model call in a tool loop sees the updated
in-memory `AgentSession`.

Prudence then serializes the resulting session to SQLite after a run returns:

[`HarnessService.run_prompt`](../backend/src/maf_harness/service.py#L331):

```python
result = await self.runner.run(
    profile,
    craft_profile,
    session_id,
    content,
    self.repository.get_session_state(session_id),
    ...
)
self.repository.save_session_state(session_id, result.session_state)
```

[`Repository.save_session_state`](../backend/src/maf_harness/database.py#L482):

```python
def save_session_state(self, session_id: str, state: dict[str, Any]) -> None:
    with self._database.session_factory() as db:
        row = db.get(HarnessSessionRow, session_id)
        if row is None:
            raise LookupError(f"Session {session_id} was not found")
        row.maf_state = state
        row.updated_at = utc_now()
        db.commit()
```

This provides durable recovery between completed runs and approval continuations. It does
**not** currently checkpoint the MAF session to SQLite after every inner model call, so a
process crash during a multi-call run can lose progress since the previous run boundary.

## 3. Compaction

**Status: In use through Agent Framework.**

Every configured provider supplies a context-window and output-token limit. Passing both to
`create_harness_agent` activates the framework's default token-budget compaction.

When lifecycle hooks are configured, Prudence wraps the same MAF compaction strategy so hooks
can observe or block the before/after phases:

[`MafAgentRunner._run_with_client`](../backend/src/maf_harness/runner.py#L754):

```python
base_compaction = ContextWindowCompactionStrategy(
    max_context_window_tokens=profile.max_context_window_tokens,
    max_output_tokens=profile.max_output_tokens,
)
before_compaction = HookedCompactionStrategy(
    base_compaction,
    "before",
    hook_registry,
    hooks,
    on_activity,
)
after_compaction = HookedCompactionStrategy(
    base_compaction,
    "after",
    hook_registry,
    hooks,
    on_activity,
)
```

Without hooks, the explicit strategies remain `None`, and the token limits passed to
`create_harness_agent` activate its default strategy.

## 4. Todo provider

**Status: In use through Agent Framework.**

Prudence leaves the harness `TodoProvider` enabled. Todo state lives inside the serialized
`AgentSession` under the `todo` key and is rendered as persistent GUI tasks.

Look at [`HarnessService.get_state`](../backend/src/maf_harness/service.py#L942):

```python
session = AgentSession.from_dict(state)
todo_state = session.state.get("todo")
...
raw_items = todo_mapping.get("items")
tasks = TASK_LIST_ADAPTER.validate_python(raw_items) if isinstance(raw_items, list) else []
```

The todo provider also drives autonomous execute-mode looping; see
[Looping](#14-looping).

## 5. Agent mode provider

**Status: In use through Agent Framework.**

Prudence leaves the native `AgentModeProvider` enabled and reads or changes mode through the
MAF session helpers.

Look at [`HarnessService.set_mode`](../backend/src/maf_harness/service.py#L965):

```python
state = self.repository.get_session_state(session_id)
session = AgentSession.from_dict(state) if state else AgentSession(session_id=session_id)
set_agent_mode(session, mode)
self.repository.save_session_state(session_id, session.to_dict())
```

Plan approval changes the mode to `execute` and records the eight-iteration safety cap in
[`HarnessService.approve_plan`](../backend/src/maf_harness/service.py#L972).

## 6. File memory provider

**Status: In use through Agent Framework, except in Counsel & Craft mode.**

Prudence disables the factory-created default memory provider and supplies one explicitly so
it can select global or workspace-scoped storage.

Look at [`_create_configured_agent`](../backend/src/maf_harness/runner.py#L177):

```python
context_providers = (
    []
    if disable_file_memory
    else [FileMemoryProvider(memory_store, scope=memory_scope)]
)
...
disable_file_memory=True,
context_providers=context_providers,
```

The backing store is selected in
[`MafAgentRunner._run_with_client`](../backend/src/maf_harness/runner.py#L569):

```python
memory_store = (
    FileSystemAgentFileStore(workspace_path / ".prudence")
    if workspace_path is not None
    else self._memory_store
)
memory_scope = "memory" if workspace_path is not None else None
```

Bound sessions therefore use `<workspace>/.prudence/memory`. Counsel & Craft passes
`disable_file_memory=True` to this helper to prevent memory tools from becoming a fallback
code-generation path.

## 7. File access provider

**Status: Custom equivalent; the native MAF file access provider is not used for the real
workspace.**

The harness receives an in-memory, read-only file store. Prudence instead registers its own
root-contained workspace tools, which enforce UTF-8, traversal, symlink, size, output, test
runner, and Git restrictions.

Look at
[`WorkspaceReadTools.create_agent_tools`](../backend/src/maf_harness/workspace_tools.py#L80):

```python
@tool(name="search_workspace")
def search_workspace(query: str, path_glob: str = "**/*") -> str:
    return workspace.search(query, path_glob)

@tool(name="read_workspace_file")
def read_workspace_file(
    relative_path: str,
    start_line: int = 1,
    end_line: int | None = None,
) -> str:
    return workspace.read_file(relative_path, start_line, end_line)

if write_tools_enabled:
    @tool(name="create_workspace_file", approval_mode=write_approval_mode)
    def create_workspace_file(relative_path: str, content: str) -> str:
        return workspace.create_file(relative_path, content)
```

## 8. Tool approval

**Status: In use through MAF with Prudence-specific policy and UI.**

The harness's `ToolApprovalMiddleware` remains enabled by default. Prudence marks sensitive
tools as approval-required and persists pending requests, typed previews, and decisions.

The per-session Auto-approve setting changes workspace mutation tools from
`always_require` to `never_require`:

[`WorkspaceReadTools.create_agent_tools`](../backend/src/maf_harness/workspace_tools.py#L80):

```python
write_approval_mode: Literal["always_require", "never_require"] = (
    "never_require" if auto_approve_enabled else "always_require"
)

@tool(name="replace_workspace_text", approval_mode=write_approval_mode)
def replace_workspace_text(
    relative_path: str,
    old_text: str,
    new_text: str,
) -> str:
    return workspace.replace_text(relative_path, old_text, new_text)
```

The current GUI exposes approve/deny and a persistent workspace Auto-approve switch. It does
not expose MAF's per-tool "don't ask again" response as a separate user choice.

## 9. OpenTelemetry

**Status: Wired by the MAF harness, but not exported by Prudence.**

Prudence does not disable MAF telemetry or override `otel_provider_name`, so the created agent
uses the framework's default `microsoft.agent_framework.harness` provider name. There is no
Prudence code configuring an OpenTelemetry SDK provider, processor, or exporter.

The relevant project call is
[`_create_configured_agent`](../backend/src/maf_harness/runner.py#L194):

```python
return create_harness_agent(
    client=client,
    name="Prudence",
    ...
)
```

Consequently, instrumentation hooks exist, but this repository does not send traces to a
collector or observability backend. Prudence's currently visible observability is its own
persisted activity-event stream.

## 10. Web search

**Status: Disabled.**

Prudence explicitly prevents `create_harness_agent` from adding the provider's hosted web
search tool:

[`_create_configured_agent`](../backend/src/maf_harness/runner.py#L194):

```python
disable_web_search=True,
```

No replacement general-purpose web search tool is registered by default. A trusted configured
MCP server could independently expose a search capability, but that is not the harness default.

## 11. Skills provider

**Status: Custom equivalent.**

Prudence does not pass MAF's `skills_provider` or `skills_paths`. Its `SkillRegistry` discovers
user skills and workspace skills from `.prudence/skills`, applies project precedence, injects a
small catalog into instructions, and exposes a progressive `load_skill` tool.

Look at [`SkillRegistry`](../backend/src/maf_harness/skills.py#L20):

```python
def catalog_instructions(self, definitions: list[SkillDefinition]) -> str | None:
    ...
    return (
        "Reusable skills are available below. Load a skill only when its description "
        "matches the current request. Call load_skill(name) before following that skill. "
        "Project skills override user skills with the same name.\n"
        f"{entries}"
    )

@tool(name="load_skill")
def load_skill(name: str) -> str:
    return registry.load(name, definitions)
```

The registry is connected to the agent in
[`MafAgentRunner._run_with_client`](../backend/src/maf_harness/runner.py#L710).

## 12. Background agents

**Status: Custom bounded delegation, but not MAF background or parallel execution.**

Prudence does not pass `background_agents` to `create_harness_agent`. It registers
`explore_workspace` and `review_workspace` as ordinary tools. Each invocation creates a fresh,
read-only `Agent`, waits for it to finish, and returns its bounded result.

Look at
[`SubagentRegistry._create_delegation_tool`](../backend/src/maf_harness/subagents.py#L109):

```python
@tool(name=definition.name, description=definition.description)
async def delegate(task: str) -> str:
    budget = InvocationBudget(
        definition.max_tool_calls,
        definition.max_tool_output_chars,
    )
    agent = Agent(
        client=client,
        name=definition.name,
        instructions=definition.instructions,
        tools=registry._create_workspace_tools(definition, budget),
        default_options={
            "allow_multiple_tool_calls": False,
            "max_tokens": definition.max_output_tokens,
        },
    )
    async with asyncio.timeout(definition.timeout_seconds):
        async with agent:
            response = await agent.run(normalized_task)
```

These delegated agents are isolated and bounded, but they are foreground calls rather than
parallel, resumable MAF background tasks.

## 13. Shell environment

**Status: Not in use.**

Prudence does not pass `shell_executor` or `shell_environment_provider_options` to
`create_harness_agent`, so the model has no general command shell and receives no automatic
OS/shell/environment probe.

There is one intentionally narrow subprocess surface:
[`WorkspaceReadTools.create_agent_tools`](../backend/src/maf_harness/workspace_tools.py#L135)
exposes an approval-gated test tool that executes
allowlisted test runners through a fixed argument list and workspace working directory. This is
not equivalent to the harness shell environment capability.

```python
@tool(name="run_workspace_tests", approval_mode=write_approval_mode)
def run_workspace_tests(runner: str, target: str | None = None) -> str:
    """Run an allowlisted project test runner after explicit user approval."""
    return workspace.run_tests(runner, target)
```

## 14. Looping

**Status: In use through Agent Framework.**

Prudence opts into native harness looping only when todo items remain and the session is in
`execute` mode. Each iteration receives the standard todo continuation message, and a hard cap
prevents an unbounded autonomous run.

Look at [`_create_configured_agent`](../backend/src/maf_harness/runner.py#L194):

```python
loop_should_continue=todos_remaining(looping_modes=["execute"]),
loop_next_message=todos_remaining_message,
loop_max_iterations=8,
```

Pending approvals stop the loop at the user boundary. After the user decides, Prudence rebuilds
the agent from the serialized session and resumes with the MAF approval response.

## Practical conclusion

Prudence's core orchestration uses the native MAF harness for function invocation, history
management within a run, compaction, todo state, mode state, approval middleware, telemetry
instrumentation, and looping. It deliberately substitutes stricter GUI-oriented implementations
for workspace files, skills, and delegated agents. Web search and a general shell are disabled.
The main durability gap relative to the capability description is that SQLite receives the MAF
session at run and approval boundaries, not after every inner model call.
