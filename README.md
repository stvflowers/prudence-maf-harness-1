# Prudence

Prudence is a GUI-first agent harness built on Microsoft Agent Framework.
It supports Microsoft Foundry and OpenAI-compatible local model profiles while keeping
session state, tasks, approvals, events, and memory local by default.

The browser workspace includes:

- independently scrolling streaming chat, safe inline progress cues, click-to-answer option
  pickers for short numbered questions, provider-generated session titles after the first
  completed exchange, and an activity trail;
- native MAF plan/execute mode and persistent tasks;
- context-aware agent controls that hide Plan/Execute actions during Counsel & Craft sessions
  while retaining task progress;
- labeled multi-step progress dots that light as persistent tasks complete;
- independently collapsible context blocks and a modern system font stack;
- a dedicated per-session Settings view for persistent session naming, workspace binding,
  instruction layers, skills, hooks, MCP servers, and bounded subagents, keeping the chat
  sidebar focused on live state;
- visible model-provider selection and status with management actions grouped in a compact dropdown;
- a workspace menu, searchable command palette, keyboard shortcuts, and focus-safe
  keyboard navigation while retaining button-driven core workflows;
- explicit plan approval with execute-only autonomous todo looping capped at eight iterations;
- approval-gated tool continuation;
- typed approval previews with operation/risk labels, affected paths, bounded unified
  diffs for exact text replacements, and secondary raw-argument disclosure;
- session-scoped file memory for unbound sessions and workspace-shared file memory under
  `<workspace>\.prudence\memory` for bound sessions;
- persisted tool-call, tool-result, runtime-status, and context-usage events;
- automatic WebSocket reconnection with refresh-safe event recovery;
- classified provider failures with retry restricted to safe transient cases;
- explicit machine, local-network, or external model-traffic indicators;
- editable provider profiles with probe history and non-secret JSON import/export;
- **Counsel & Craft** dual mode, pairing a remote Microsoft Foundry reasoning agent with
  a serialized, context-budgeted local microtask broker for small files, code fragments,
  and bounded simple tasks;
- schema-versioned portable session archives for events, memory, instructions, and
  complete artifact version history without secrets or resumable runtime state;
- explicit per-session workspace binding and read-only project-context discovery;
- a native folder picker that fills the workspace path while preserving explicit binding;
- layered `AGENTS.md`, Copilot, shared, and local workspace instruction loading;
- inspectable managed, user, project, local, and session instruction precedence;
- bounded read-only workspace search/file reads and Git status/diff/log tools;
- explicit workspace-shared opt-in for approval-gated file creation, text replacement, tests,
  branches, and commits;
- searchable workspace-shared artifacts backed by the real files Prudence mutates, with
  bounded metadata history, previews, and downloads;
- progressively loaded reusable skills with visible user/project source and precedence;
- declarative lifecycle hooks with visible audit/block policy and project precedence;
- trusted local stdio MCP servers with allowlisted, approval-gated progressive tools;
- bounded read-only explore and review subagents with visible permissions and budgets;
- color-independent status labels, semantic live regions, reduced-motion support, and
  compiled-browser accessibility checks;
- run cancellation and restart-safe session recovery.

## Development

Backend:

```powershell
Set-Location .\backend
uv sync
uv run prudence
```

Frontend:

```powershell
Set-Location .\frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite development server proxies `/api` and
`/api/.../stream` to the backend on port 8000.

## Local application

Build the frontend once, then start the packaged local web application:

```powershell
Set-Location .\frontend
npm run build

Set-Location ..\backend
uv run prudence
```

The backend serves the compiled GUI and opens `http://127.0.0.1:8000`. New installations
store session data under `%USERPROFILE%\.prudence`; set `PRUDENCE_DATA_DIRECTORY` to use
a different local directory. Existing `%USERPROFILE%\.maf-harness` installations continue
using that directory when `.prudence` does not exist. The legacy
`MAF_HARNESS_DATA_DIRECTORY` variable and `maf-harness-api` command remain compatibility
aliases.

## Provider profiles

- **Microsoft Foundry:** enter the project endpoint and deployment name. Authentication uses
  `DefaultAzureCredential`; for local development, sign in through Azure CLI first.
- **Local model:** enter an OpenAI-compatible base URL and model name. If the endpoint needs an
  API key, enter the *environment variable name* that contains it. Secret values are never stored.
  Profiles without one use the conventional `local` placeholder expected by OpenAI-compatible
  local servers. Foundry Local uses its service URL with `/v1`, for example
  `http://127.0.0.1:<port>/v1`, and the exact model ID returned by `/v1/models`.

Application state defaults to `%USERPROFILE%\.prudence\prudence.db`. Existing
`.maf-harness\harness.db` databases are reused automatically. Unbound session memory and
artifacts remain under the application-data directory. Binding moves durable scope to the
workspace: shared memory is stored in `<workspace>\.prudence\memory`, settings and bounded
artifact index metadata are stored under `<workspace>\.prudence`, and artifact content is the
real contained workspace file. Existing global session memory is copied and verified on bind;
conflicts fail without overwriting either copy.

Provider profiles can be added, edited, tested, exported, imported, and deleted from the
sidebar. Recognized local model families automatically use their published context-window and
maximum-output limits. Unknown local models are initialized from token-limit metadata reported
by their OpenAI-compatible `/models` endpoint; initialization fails explicitly when the endpoint
cannot identify the model or its limits. Foundry deployments retain explicit editable resource
settings, defaulting to 32,768/4,096. Every connectivity test persists its timestamp, result,
streaming support, and tool-calling capability; failures are retained as well as successes. The
basic connectivity
probe confirms streamed inference but does not force a tool invocation, so verify the model's
published `toolCalling` metadata before relying on approval or tool workflows.

Provider export files are schema-versioned JSON and contain configuration plus environment
variable names only, never secret values, database IDs, timestamps, probe history, or session
data. A provider cannot be deleted while a session references it.

### Counsel & Craft dual mode

Select a Microsoft Foundry provider, then choose a local provider under **Counsel & Craft**
before creating a session. Foundry acts as Counsel: it owns planning, reasoning, tools, verification, approvals, and final
judgment. Counsel first plans contract- and dependency-ordered microtasks, then delegates them
sequentially through `consult_craft`. The broker also serializes concurrent calls per runner and
local endpoint, so only one local response stream can run at a time. Queue, attempt, retry, and
budget state are persisted without hidden reasoning. If an active local-provider request fails,
requests already waiting behind it are aborted without additional inference calls; a later
delegation can retry after the provider is restored.

Craft accepts a complete small file (`complete_file`, with a target path), one named symbol or
section for an existing file (`code_fragment`, with a target path and unit name), or a bounded
simple response. Input, output-token, character, and line ceilings are conservatively derived
from the Craft profile's context window and output limit rather than a fixed task allowance.
Oversized requests fail before inference. Code handoffs require an explicit completion marker;
when the provider adapter exposes a transport finish reason, a clean `stop` is accepted as stronger
completion evidence while `length` still fails closed. Adapters without finish metadata retain the
marker requirement. Completed code that a local model wraps in a noncompliant outer Markdown fence
is normalized when the explicit completion marker proves the response finished; unmarked malformed
fences remain blocked.
marker requirement. Incomplete code receives one fresh, lower-ceiling retry, then fails closed.
Marked or transport-complete output that exceeds its deterministic bounds is also rejected.

Craft receives only the explicit delegation and has no Prudence workspace tools or memory. Code
handoffs return raw source without Markdown fences. A single model-added outer code fence is
deterministically removed before validation; nested or malformed fences are not normalized.
Complete files pass directly to
`create_workspace_file`, and fragments pass directly to `replace_workspace_text`. Counsel may add
fences only when presenting the unchanged raw source in final chat. Code-bearing writes and final
chat code blocks must match verified Craft output (or code supplied by the user); Counsel cannot
repair or substitute code. Dual-mode replies are staged until that check passes. Boundary failures
are visible in the activity trail. Existing single-provider sessions continue unchanged.

While a run is active, the transcript shows bounded status cues derived from persisted task,
handoff, tool, and approval events. These cues describe observable work without exposing hidden
reasoning. In dual mode, agent file-memory tools are disabled so Counsel cannot use session memory
to bypass Craft provenance. When workspace writes are enabled, verified Craft code can be sent to
the approval-gated `create_workspace_file` tool for new files or `replace_workspace_text` for
existing files.

The composer exposes compact workspace write-access and auto-approve switches directly below the
message input so mutation capability is visible before a coding run. Auto-approve remains off by
default, requires write access, and applies only to the bounded workspace mutation tools. Workspace
binding and the detailed capability/tool list remain in Session Settings.
Pending approvals appear in a bounded slide-up tray above the composer, preserving the operation,
risk, affected paths, preview, exact arguments, and approve/deny controls without occupying the
session context sidebar.

## Instruction layers

Instructions are merged in ascending precedence; later sources override earlier sources:

1. `%USERPROFILE%\.prudence\managed-instructions.md` — managed defaults, priority 10.
2. `%USERPROFILE%\.prudence\instructions.md` — user defaults, priority 20.
3. `<workspace>\AGENTS.md` — project agent guidance, priority 30.
4. `<workspace>\.github\copilot-instructions.md` — project Copilot guidance, priority 35.
5. `<workspace>\.prudence\instructions.md` — project-shared guidance, priority 40.
6. `<workspace>\.prudence\instructions.local.md` — local override, priority 50.
7. The workspace-shared override in `<workspace>\.prudence\settings.json` for bound
   sessions, or the SQLite-backed per-session override for unbound sessions — priority 60.

Every active layer is separately inspectable in the GUI with its scope, source, and priority.
Only the final override is edited in the harness; managed, user, and project files remain
file-managed. The bounded, atomically written workspace settings file also stores the shared
workspace write capability. Legacy `.maf-harness` project files remain readable as fallbacks;
the corresponding `.prudence` layer is authoritative when both exist. Files are UTF-8, bounded
to 64 KiB, and rejected if their resolved path escapes their declared root.

## Reusable skills

Skills use a `SKILL.md` file with YAML front matter containing `name` and `description`.
User skills live under `%USERPROFILE%\.prudence\skills\<name>\SKILL.md`. Project skills
live under `<workspace>\.prudence\skills\<name>\SKILL.md` and override same-named user
or legacy `.maf-harness` skills.

The agent initially receives only the bounded skill catalog. It loads full instructions
through the read-only `load_skill` tool when a skill description matches the request.
Skill files are UTF-8, limited to 64 KiB, contained within their configured roots, and
listed in the GUI with source, precedence, and relative path.

## Lifecycle hooks

User hooks live in `%USERPROFILE%\.prudence\hooks.json`; project hooks live in
`<workspace>\.prudence\hooks.json`. Project rules override same-named user or legacy
`.maf-harness` rules.
Hook files contain a bounded `hooks` array:

```json
{
  "hooks": [
    {
      "id": "guard-delete",
      "event": "pre_tool",
      "action": "block",
      "tool_names": ["delete_record"],
      "message": "Deletion is disabled."
    }
  ]
}
```

Supported events are `session`, `prompt`, `pre_tool`, `post_tool`, `compaction`, and
`completion`. Every matching rule persists a `hook_triggered` event. Blocking rules also
persist `hook_blocked` and are allowed only before session work, prompts, tools, or
compaction; post-tool and completion hooks are audit-only because their side effects have
already occurred. Rules are declarative rather than executable scripts.

## Local MCP servers

The first MCP increment supports local stdio servers only. Configure trusted machine-level
servers in `%USERPROFILE%\.prudence\mcp.json`; workspace files cannot launch MCP
processes.

```json
{
  "servers": [
    {
      "id": "account-tools",
      "command": "account-server",
      "args": ["--stdio"],
      "description": "Trusted local account tools.",
      "enabled": true,
      "allowed_tools": ["lookup", "summarize"],
      "always_load": ["lookup"],
      "env_vars": ["ACCOUNT_API_TOKEN"]
    }
  ]
}
```

Servers must be explicitly enabled. Every exposed MCP tool requires user approval,
tool names are allowlisted, non-essential tools use MAF progressive disclosure, request
timeouts are bounded, and server-initiated model sampling remains denied. Processes use
fixed command/argument arrays without a shell. They receive only essential operating-system
variables plus the explicitly named environment variables; values are never stored or shown
in the GUI.

## Constrained subagents

Binding a workspace enables two MAF-native delegated agents. `explore_workspace` can only
search and read bounded UTF-8 workspace files. `review_workspace` receives the same read
permissions plus bounded Git status, diff, and log inspection when Git metadata is available.
Neither agent receives workspace write tools, test execution, artifacts, memory, skills, hooks,
or MCP tools.

Every invocation uses a fresh isolated session with a 60-second timeout, eight-tool-call limit,
100,000-character tool-output limit, 20,000-character result limit, and 2,048 model-output-token
limit. Start, completion, failure, duration, and consumed budget data are persisted in the
session activity trail.

## Validation

```powershell
Set-Location .\backend
uv run pytest
uv run ruff check .
uv run pyright

Set-Location ..\frontend
npm run lint
npm run build
```

Run the deterministic capability benchmark matrix:

```powershell
Set-Location .\backend
uv run python .\benchmarks\run.py
```

The seven gates cover feature delivery, exact bug-fix edits, targeted test execution,
repository analysis, hook blocking, permission boundaries, and autonomous iteration
budgets. This deterministic suite does not claim model-quality certification; live
Foundry and local-model certification requires selected endpoints and authentication.
