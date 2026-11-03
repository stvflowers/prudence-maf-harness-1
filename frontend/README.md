# Prudence Frontend

React, TypeScript, and Vite provide the conversation workspace, provider configuration,
session settings, approvals, and context inspection. API and WebSocket traffic under
`/api` is proxied to the local backend at `http://127.0.0.1:8000` during development.

## Development

From this directory:

```powershell
npm ci
npm run dev
```

Start the backend separately using the [repository setup instructions](../README.md#quick-start).

```powershell
npm run build
npm run lint
```

The build runs TypeScript checking before producing `dist`. The backend can serve that
directory directly.

## Porcelain / Vermilion

The interface is intentionally light-only. [src/index.css](src/index.css) declares the shared
`--p-*` tokens and global font/focus styles; [src/App.css](src/App.css) consumes those tokens
across every component.

| Role | Token | Color |
| --- | --- | --- |
| Porcelain canvas | `--p-bg` | `#F6F2EB` |
| Warm taupe sidebar | `--p-sidebar` | `#EEE8DF` |
| Chalk surface | `--p-surface` | `#FFFDFA` |
| Ink text | `--p-text` | `#252320` |
| Muted text | `--p-muted` | `#625D56` |
| Fine dividers | `--p-border` | `#DDD5CB` |
| Vermilion accent | `--p-accent` | `#E34B36` |
| Accessible filled action | `--p-action` | `#CE3D29` |
| Hover action | `--p-accent-hover` | `#CA3B28` |
| Accent text / focus | `--p-accent-text`, `--p-focus` | `#B93423` |

Use semantic success, warning, danger, information, and delegation tokens for status, rather
than interpreting every vermilion element as an error. Code previews use warm light surfaces
with dark monospace text. Keep new component colors token-based.

The visual treatment uses compact editorial headings, warm rules, restrained shadows,
and mostly 8-10px control corners. The existing brand asset is shown in grayscale in the
sidebar; the source image is unchanged.

Single-provider sessions expose the existing Plan / Execute actions in the top bar.
Counsel & Craft does not gain a manual mode switch. Approval placement, write-access
permissions, auto-approve behavior, API contracts, and session persistence are unchanged.
The **Powered by Microsoft Agent Framework** attribution sits at the bottom center of the
main workspace on every view, rather than inside the welcome content.

Provider management uses an icon-led model selector and a small **Add provider** control
in its heading. **Manage providers** opens a centered, 680px native modal dialog with a bounded
height, internal scrolling, profile selection, grouped actions, and connectivity history.
The sidebar reserves scrollbar space and does not expand when management opens.
Native modal focus containment keeps the workspace inert. Close, backdrop click, and Escape
return focus to the trigger; Escape cannot stop an active run. Workspace shortcuts are
suspended while management is open.

Inspecting profiles does not switch the sidebar's selected model. Editing or deleting a
different profile also preserves that selection. Add, Edit, Import, Export, and Delete close
the dialog before invoking the existing workflows; Delete still requires confirmation.
Connection tests stay in the dialog, target the inspected profile, and show results or failures
alongside refreshed history. History loads only for the inspected profile, with explicit errors
rather than treating failed loads as empty history.
Both the active-provider and Craft selectors use the same in-app picker instead of native
operating-system dropdowns. Provider options show compact names, exact model IDs, distinct
provider symbols (diamond for Foundry, cube for local), data boundaries, and a selected checkmark.
Symbols have accessible names and hover labels; leading "Microsoft Foundry", "Foundry Local",
"Foundry", and "Local" display prefixes are omitted. A type-only profile name displays its
model ID instead. Stored names, configuration forms, IDs, and API payloads remain unchanged;
full names remain in tooltips and option accessibility labels. Keyboard navigation, typed prefixes,
focus restoration, dismissal, and bounded scrolling are shared. Options expand in sidebar flow
without covering adjacent controls; unavailable management actions remain disabled.
The existing first-provider default selection is preserved. **Choose a model** is a placeholder
only when no providers are configured, not a clearing action that silently selects another model.

The selector is the sidebar's only provider identity block; there is no duplicate summary
underneath. Selectors and picker options omit the model-ID subtitle when it exactly matches
the compact display name. Distinct model IDs remain visible below readable profile names.

### Collapsible Workspace Panels

Workspace commands independently collapse or expand the left sessions/providers sidebar
and right context inspector. Open the command palette with **Ctrl+K** (or **Cmd+K**);
the actions show **Collapse** or **Expand** according to the panel state, with shortcut hints:

- **Alt+V** toggles the left sidebar.
- **Ctrl+Alt+V** toggles the right pane.

There are no dedicated pane buttons in the workspace header. Commands remain reachable
while panels are hidden; the right-pane action is disabled on views without an inspector.
Shortcuts work from text fields without modifying drafts, ignore held-key repeats and
AltGraph input, and are suspended while provider management is open.
On desktop, collapsing a panel gives its width to the conversation. Stacked layouts hide
the corresponding section without horizontal overflow.

Collapse preferences remain in application state across session/settings navigation, not
across page reloads. Hidden panels stay mounted, preserving selections and inspection
disclosures. Drafts, streaming runs, approval gates, and model configuration are unaffected;
pending approvals remain visible in the central workspace. Closing the palette restores
focus to the previous visible control, or the Commands trigger if that control was hidden.

### Counsel & Craft Pairing

Foundry providers expose a compact, connected Counsel / Craft rail instead of nested form
cards. Roles, model identities, pairing state, and Craft's actual data boundary stay separate.
Readable provider names lead each role; exact model IDs remain in tooltips and option details.
Long names truncate visually but retain their full text.

Craft uses an in-app listbox with model names, provider names, boundary labels, and a selected
checkmark. Its options expand in normal sidebar flow rather than covering adjacent controls.
Only configured local providers appear, alongside **Counsel only**; a missing-local-provider
state explains how to enable Craft. Arrow keys, Home/End, and typed model/provider prefixes
navigate without committing; Enter/Space selects. Escape returns focus without stopping a
run, Tab continues to the next control, and outside clicks dismiss the picker.

The rail explicitly describes **new-session setup**, not a live switch of the current session.
Selecting a pair does not execute a model request or change approvals. New sessions keep the
existing `provider_id` / `craft_provider_id` contract, and paired sessions still have no manual
Plan / Execute toggle. Changing Counsel to a non-Foundry provider clears the Craft selection.

### Activity and Prompt Reruns

Activity displays the latest twelve recorded events, newest first, with an explicit count.
Each timeline entry includes an outcome, readable summary, timestamp, and applicable facts
such as token counts, task progress, tool paths, or delegation duration. Failures include
category-aware next-step guidance. Unknown events remain visible and explicitly identify
that a readable summary is unavailable.

**Technical details** reveals recorded diagnostic text; **Raw event payload** preserves the
original JSON for inspection. Presentation never reclassifies a failure by guessing from its
stack trace or infers retry permission. The runtime failure summary uses the same presenter.

User messages expose two deliberate actions:

- **Run again** submits that original prompt as a new turn in the same session, keeping any
  unrelated composer draft. This is not a rollback, a fresh session, or an automatic retry.
- **Edit & rerun** loads the original text into the composer without sending it. Replacing a
  different, non-empty draft requires confirmation; cancel leaves the draft unchanged.

Both are disabled while running, updating session context, or waiting for approval.
Sending checks that the WebSocket is open and locks the running state immediately to avoid
duplicate submissions. Existing tool permissions and approval gates remain in force.
The separate **Retry last run** control still requires the recorded `retryable: true` flag;
manual reruns do not alter that flag or silently bypass policy restrictions.

### Output Summary

The inspector describes output instead of opening a filename list or JSON preview.
Programming languages appear above file types in the summary.
**Indexed files** counts each artifact record once. File types and programming languages
use the `file_name` entry matching `current_version`, regardless of version-array order.
TypeScript/TSX and JavaScript/JSX share their respective language counts. JSON, Markdown,
HTML/CSS, environment files, and project manifests are not counted as programming languages;
unknown source extensions remain unassigned. Classification does not inspect file content.

Recorded size sums only known, nonnegative latest-version byte sizes, displayed in binary
units (B, KiB, MiB). Incomplete totals are labeled **Known size** with an explicit coverage
count; entirely unavailable sizes say **Not reported**. Missing current-file metadata is
counted as **Unknown**, never guessed from the title or an older version. **Available
versions** counts supplied version entries, not the current-version counter: workspace
indexing may retain only the latest entry even after several updates.

For bound sessions the output index is workspace-shared; unbound sessions have session-scoped
output. Neither represents a scan of every physical file or verifies unindexed edits.
**Inspect files** starts collapsed and preserves search by title/current filename, previews,
version selection, and downloads. Search and preview selection do not change summary totals.
No extra content requests are made to construct the summary.

### Layout Boundaries

Notifications occupy a dedicated row inside the main workspace, between the composer and
framework attribution. They never float over the inspector or send controls. Long messages
wrap and scroll inside a bounded notice; dismissal remains available.

The composer gives model metadata its own line, lets permission controls wrap, and reserves
a separate column for Send. Inputs use border-box sizing and can shrink within their cards.
Provider field pairs stack below 560px; session settings use one card column below 1100px.

Above 1100px the workspace retains three panes. At 761-1100px the sidebar and conversation
share the first row and the inspector sits below; at 760px and below the full layout stacks.
Desktop workspaces have a 600px minimum height, so shorter windows can scroll rather than
clip controls. Approval trays use a smaller height cap in short windows.

## Browser Checks

```powershell
npm run test:ui
```

Tests use Playwright with **Microsoft Edge** (`msedge` channel), which must be installed.
Playwright starts and stops an isolated Vite server on `127.0.0.1:5176`; keep that port free.
There is no backend or model prerequisite.

[tests/interface.spec.ts](tests/interface.spec.ts) intercepts all API and model WebSocket
traffic with synthetic fixtures. Unexpected API requests are surfaced as fixture failures.
Checks cover:

- Plan / Execute state and the existing mode API payload.
- Bottom-centered framework attribution, including the welcome view.
- Command palette opening, Escape dismissal, and composer keyboard focus.
- Approval gating and the existing approval decision payload.
- Session settings and provider editing.
- Provider action hierarchy, Escape dismissal, action closure, and empty-state add/import.
- Exact sidebar geometry before/after management opens and closes, centered and bounded modal
  sizing, keyboard focus containment, lazy connection history, correct probe targets, visible
  failures, and editing/deleting other profiles without switching models.
- In-app primary provider selection, empty state, Foundry / Local labels, unchanged session
  creation payloads, safe keyboard dismissal, and long-name containment.
- Counsel / Craft keyboard and pointer selection, new-session payloads, solo mode, missing
  local providers, boundary labels, long-model containment, and Escape without run cancellation.
- Parsed activity, original diagnostics, tool/subagent failures, zero token counts, unknown
  events, and the explicit latest-twelve limit.
- Exact rerun payloads, immediate running-state locking, draft protection, explicit edited
  submission, and pending-approval gates.
- Exact output counts, latest-version selection, filename-based types/languages, missing and
  invalid size metadata, zero-byte files, and optional search/preview/version-download links.
- Containment and nonintersection for long filenames and previews at desktop and narrow widths.
- Actual element containment and nonintersection for notices, composer controls, the header,
  and settings fields across wide, narrow, and short windows, including a 420px-high window
  with a long error and pending approval. Page-width checks alone do not prove this.
- Light appearance under a system dark preference and no page-level horizontal overflow
  at 1024px and 390px viewport widths.
- WCAG AA contrast (at least 4.5:1) for sampled normal text, primary actions, approval
  headings, and code preview text. This is not a full accessibility audit.

## Screenshots

```powershell
npm run screenshots
```

This runs only the documentation capture cases and overwrites:

- [Workspace](../docs/assets/prudence-app.png), 1440 x 1000.
- [Focused workspace](../docs/assets/prudence-focused-workspace.png), both side panels collapsed.
- [Pane commands](../docs/assets/prudence-panel-commands.png), palette actions and shortcut hints.
- [Permission gate](../docs/assets/prudence-approval.png), 1440 x 1200.
- [Session settings](../docs/assets/prudence-settings.png), 1440 x 1000.
- [Provider management](../docs/assets/prudence-provider-menu.png), cropped to the centered dialog.
- [Provider picker](../docs/assets/prudence-provider-picker.png), cropped to the expanded selector.
- [Empty provider management](../docs/assets/prudence-provider-empty.png), cropped to the centered dialog.
- [Parsed activity](../docs/assets/prudence-activity.png), cropped to the activity section.
- [Inline run error](../docs/assets/prudence-notice.png), 1440 x 1000.
- [Output summary](../docs/assets/prudence-output-summary.png), cropped to the output section.
- [Counsel / Craft pairing](../docs/assets/prudence-counsel-craft.png), cropped to the pairing rail.
- [Craft model picker](../docs/assets/prudence-craft-picker.png), cropped to the expanded pairing rail.

These are actual rendered UI screenshots, not generated design images. Their provider,
conversation, task plan, local path, and diff are synthetic; captures make no model calls
and access no real workspace. They demonstrate presentation and UI behavior, not live
provider connectivity or backend execution. Normal `test:ui` runs do not overwrite them.

Test results and failure traces are ignored by Git. Do not commit traces from real sessions
or replace the documented fixtures with private prompts, credentials, or workspace content.
