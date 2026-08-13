<div align="center">
  <img src="docs/assets/prudence-hero-mint.png" alt="Prudence" width="180">

  <h1>Prudence</h1>

  <p><strong>A local-first agent harness built for deliberate, observable execution.</strong></p>

  <p>
    Plan work, govern tool use, and delegate bounded tasks across Microsoft Foundry and
    OpenAI-compatible local models.
  </p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/stvflowers/maf-harness-1?style=flat-square" alt="MIT License"></a>
    <img src="https://img.shields.io/badge/Python-3.14-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.14">
    <img src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white" alt="React 19">
    <img src="https://img.shields.io/badge/status-active_development-F59E0B?style=flat-square" alt="Status: active development">
  </p>

  <p>
    <a href="#quick-start">Quick start</a> &bull;
    <a href="#why-prudence">Features</a> &bull;
    <a href="#architecture">Architecture</a> &bull;
    <a href="docs/agent-framework-harness-capabilities.md">Framework capabilities</a> &bull;
    <a href="#contributing">Contributing</a>
  </p>
</div>

---

<p align="center">
  <img src="docs/assets/prudence-app.png" alt="Prudence local agent workspace" width="100%">
</p>

Prudence provides a controlled browser workspace for planning, tool use, approvals, and agent
delegation. Session data, tasks, events, and memory stay on the local machine by default;
workspace-scoped data remains with the bound project.

> [!NOTE]
> Prudence is under active development. Interfaces and persisted data formats may change before
> the first stable release.

## Why Prudence

| Local by default | Approval first | Extensible by design |
| :--- | :--- | :--- |
| Session state and memory remain on your machine or in the bound workspace. | Plans, tool calls, risk-aware diffs, and writes stay visible and governed. | Add instruction layers, skills, lifecycle hooks, MCP servers, and bounded subagents. |

### Core Capabilities

- **Flexible model access:** Configure Microsoft Foundry deployments and OpenAI-compatible local
  models, test connectivity, and import or export non-secret provider profiles.
- **Governed execution:** Review plans, approve individual tool calls, inspect risk-aware diffs,
  cancel runs, and recover sessions after a restart.
- **Workspace context:** Bind a project to enable bounded file search, file reads, Git inspection,
  artifacts, business notes, and optional approval-gated writes.
- **Agent extensibility:** Load layered instructions, reusable skills, declarative lifecycle hooks,
  trusted local stdio MCP servers, and constrained read-only subagents.
- **Counsel & Craft:** Pair a Microsoft Foundry reasoning agent with a serialized local model broker
  for bounded code and content microtasks.
- **Local persistence:** Store session state in SQLite, with workspace memory and metadata under
  `<workspace>\.prudence` when a session is bound.
- **Accessible browser UI:** Use streaming chat, persistent task progress, searchable commands,
  keyboard navigation, semantic live regions, and reduced-motion support.

## Architecture

| Component | Technology | Responsibility |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite | Chat, session settings, approvals, tasks, and activity |
| Backend | Python 3.14, FastAPI, Microsoft Agent Framework | Agent orchestration, tools, providers, and persistence |
| Storage | SQLite and workspace files | Local session state, memory, artifacts, and configuration |

## Requirements

- Python 3.14 or later
- [`uv`](https://docs.astral.sh/uv/)
- Node.js with npm
- At least one Microsoft Foundry deployment or OpenAI-compatible local model endpoint
- Azure CLI authentication when using Microsoft Foundry locally

## Quick Start

Start the backend from the repository root:

```powershell
Set-Location .\backend
uv sync
uv run prudence
```

In a second terminal, start the frontend:

```powershell
Set-Location .\frontend
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies API and WebSocket traffic
under `/api` to the backend at `http://127.0.0.1:8000`.

## Build and Run Locally

Build the frontend once, then run the backend as a local web application:

```powershell
Set-Location .\frontend
npm ci
npm run build

Set-Location ..\backend
uv sync
uv run prudence
```

The backend serves the compiled frontend and opens
[http://127.0.0.1:8000](http://127.0.0.1:8000).

## Provider Profiles

### Microsoft Foundry

Enter the project endpoint and deployment name. Authentication uses `DefaultAzureCredential`; for
local development, sign in with Azure CLI before starting Prudence.

Foundry profiles default to a 32,768-token context window and a 4,096-token output limit. These
values remain editable for each deployment.

### Local Models

Enter an OpenAI-compatible base URL and model name. When the endpoint requires an API key, provide
the name of the environment variable that contains it. Prudence never stores the secret value.

Foundry Local uses its service URL with `/v1`, such as `http://127.0.0.1:<port>/v1`, and the exact
model ID returned by `/v1/models`. Recognized model families use their published token limits;
unknown models must report token-limit metadata through the endpoint.

Every connectivity test records its timestamp, result, streaming support, and tool-calling
capability. The basic probe confirms streamed inference but does not force a tool invocation.

Provider exports are schema-versioned JSON files containing configuration and environment variable
names only. They exclude secrets, database IDs, timestamps, probe history, and session data. A
provider cannot be deleted while a session references it.

## Counsel & Craft

Counsel & Craft pairs a Microsoft Foundry provider with a local provider. Foundry acts as Counsel
and owns planning, reasoning, tools, verification, approvals, and final judgment. The local model
acts as Craft and receives serialized, context-bounded microtasks through `consult_craft`.

Craft accepts one of three request types:

- a complete small file with a target path;
- a named symbol or section from an existing file; or
- a bounded simple response.

Input, output-token, character, and line limits are derived from the Craft profile. Oversized or
incomplete responses fail closed, with one lower-ceiling retry available for incomplete code. Craft
has no Prudence workspace tools or memory and receives only the explicit delegation.

Verified complete files flow to `create_workspace_file`; verified fragments flow to
`replace_workspace_text`. Both remain subject to workspace write access and approval policy.
Code-bearing writes and final code blocks must match verified Craft output or user-provided code.

## Local Data and Workspaces

New installations store application state at `%USERPROFILE%\.prudence\prudence.db`. Set
`PRUDENCE_DATA_DIRECTORY` to choose another local directory.

Existing `%USERPROFILE%\.maf-harness` installations remain in use when `.prudence` does not exist.
The `MAF_HARNESS_DATA_DIRECTORY` environment variable and `maf-harness-api` command remain
compatibility aliases.

Unbound sessions keep memory and artifacts in the application data directory. Binding a workspace
moves durable project scope into that workspace:

| Path | Contents |
| --- | --- |
| `<workspace>\.prudence\memory` | Workspace-shared file memory |
| `<workspace>\.prudence\notes` | Business notes |
| `<workspace>\.prudence\artifacts` | Bounded artifact index metadata |
| `<workspace>\.prudence\settings.json` | Shared workspace settings |

Artifact content is stored in the real workspace files Prudence mutates. When a session is bound,
existing global session memory is copied and verified; conflicts fail without overwriting either
copy.

## Instruction Layers

Instructions merge in ascending precedence. Later sources override earlier sources.

| Priority | Source |
| --- | --- |
| 10 | `%USERPROFILE%\.prudence\managed-instructions.md` |
| 20 | `%USERPROFILE%\.prudence\instructions.md` |
| 30 | `<workspace>\AGENTS.md` |
| 35 | `<workspace>\.github\copilot-instructions.md` |
| 40 | `<workspace>\.prudence\instructions.md` |
| 50 | `<workspace>\.prudence\instructions.local.md` |
| 60 | Workspace or per-session override |

Each active layer is separately inspectable in the UI. Prudence edits only the final override;
managed, user, and project files remain file-managed. Instruction files are UTF-8, limited to
64 KiB, and rejected when their resolved path escapes the declared root.

## Skills, Hooks, and MCP

### Reusable Skills

Skills use a `SKILL.md` file with YAML front matter containing `name` and `description`.

- User skills: `%USERPROFILE%\.prudence\skills\<name>\SKILL.md`
- Project skills: `<workspace>\.prudence\skills\<name>\SKILL.md`

The agent initially receives a bounded skill catalog and loads full instructions through the
read-only `load_skill` tool. Project skills override same-named user or legacy skills.

### Lifecycle Hooks

User hooks live in `%USERPROFILE%\.prudence\hooks.json`; project hooks live in
`<workspace>\.prudence\hooks.json`. Project rules override same-named user or legacy rules.

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

Supported events are `session`, `prompt`, `pre_tool`, `post_tool`, `compaction`, and `completion`.
Every match is recorded. Blocking rules are allowed before session work, prompts, tools, or
compaction; post-tool and completion hooks are audit-only.

### Local MCP Servers

Prudence supports trusted machine-level stdio MCP servers configured in
`%USERPROFILE%\.prudence\mcp.json`. Workspace files cannot launch MCP processes.

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

Servers must be explicitly enabled. Tool names are allowlisted, every exposed MCP tool requires
approval, request timeouts are bounded, and server-initiated model sampling is denied. Processes
run from fixed command and argument arrays without a shell. Environment variable values are never
stored or displayed.

## Constrained Subagents

Binding a workspace enables two delegated agents:

- `explore_workspace` can search and read bounded UTF-8 workspace files.
- `review_workspace` adds bounded Git status, diff, and log inspection when Git metadata exists.

Neither agent receives write tools, test execution, artifacts, memory, skills, hooks, or MCP tools.
Each invocation uses a fresh isolated session with a 60-second timeout, an eight-tool-call limit,
bounded tool and result output, and a 2,048-token model output limit. Invocation status and consumed
budgets are persisted in the session activity trail.

## Validation

Run the backend and frontend checks:

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

The seven benchmark gates cover feature delivery, exact bug-fix edits, targeted test execution,
repository analysis, hook blocking, permission boundaries, and autonomous iteration budgets. This
suite does not certify live model quality; that requires selected endpoints and authentication.

## Documentation

- [Agent Framework harness capabilities](docs/agent-framework-harness-capabilities.md)

## Contributing

Bug reports and pull requests are welcome. Before opening a pull request:

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Run the [validation suite](#validation).
4. Describe the user-visible impact and any persistence or compatibility considerations.

Use [GitHub Issues](https://github.com/stvflowers/maf-harness-1/issues) for reproducible bugs and
focused feature proposals. Open a
[pull request](https://github.com/stvflowers/maf-harness-1/pulls) when the change is ready for
review.

## License

Prudence is available under the [MIT License](LICENSE).
