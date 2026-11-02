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
- [Permission gate](../docs/assets/prudence-approval.png), 1440 x 1200.
- [Session settings](../docs/assets/prudence-settings.png), 1440 x 1000.

These are actual rendered UI screenshots, not generated design images. Their provider,
conversation, task plan, local path, and diff are synthetic; captures make no model calls
and access no real workspace. They demonstrate presentation and UI behavior, not live
provider connectivity or backend execution. Normal `test:ui` runs do not overwrite them.

Test results and failure traces are ignored by Git. Do not commit traces from real sessions
or replace the documented fixtures with private prompts, credentials, or workspace content.
