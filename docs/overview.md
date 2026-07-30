# Grok Desktop Portable — product overview

> **Public name:** Grok Desktop Portable. Historical docs and wire identifiers
> still say “Grok Light” / `light.local.v1` / `grok-light` in places; those are
> protocol-stable names in v0, not the product name.

Grok Desktop Portable is a **local web interface for the Grok Build CLI the user
already installed and authenticated**. A local **bridge** (`grok-bridge`) serves
the interface over loopback; the user opens a stable URL in their own browser
and works from it. Scope is Work only. The only shipped binary is the bridge
(GitHub Releases + `https://desktop.grok.me/install.sh`).

Portable is a sibling of Grok Desktop (Electron), not a Desktop surface. Read
[ADR light 0001](adr/0001-work-only-sibling-product.md) before assuming a
Desktop invariant applies here.

| Document | Purpose |
|----------|---------|
| [light-website-plan.md](light-website-plan.md) | Full program plan and phases |
| [protocol.md](protocol.md) | `light.local.v1` draft |
| [threat-model.md](threat-model.md) | Trust boundaries, accepted risks, non-claims |
| [ui.md](ui.md) | Work UI shell vs Desktop DESIGN.md |
| [adr/](adr/) | Light architecture decisions |

## Naming

| Thing | Name | Note |
|-------|------|------|
| Product | Grok Desktop Portable | Marketing / repo name |
| Bridge binary | `grok-bridge` | Only artifact on GitHub Releases |
| App package | `@grok-desktop-portable/web` | Workspace scope only |
| App path | `apps/web` | SPA, embedded and versioned with the bridge |
| Host crate | `crates/grok-bridge` | Binary and composition root |
| User CLI | `grok-bridge` | `serve`, `open`, `status`, `doctor`, `stop`, `repair` |
| Local protocol | `light.local.v1` | Browser to host. Not ACP (name kept in v0) |
| ACP client identifier | `grok-light` | Passed via `GROK_CLIENT_NAME`; resolves to `ClientType::Generic` |
| Landing | `https://desktop.grok.me` | Install + docs only; never the Work SPA |
| Docs root | `docs/` | ADRs under `docs/adr/` |

The `@grok-desktop/` npm scope reflects the workspace, not the product. Anything
user-facing says Grok Light and never implies it is the desktop application.

## Positioning

| Dimension | Grok Desktop | Grok Light |
|-----------|--------------|------------|
| Surfaces | Chat, Research, Work, library, automations, integrations | Work only |
| Presentation | Electron renderer | User's browser against a local origin |
| Executor | Rust daemon, pinned ACP component, managed policy | The user's Grok Build CLI |
| Grok configuration | Private, closed Desktop profile | The user's complete configuration |
| Secrets | Desktop daemon vault | Owned by the CLI |
| Threat model | Untrusted renderer, managed execution | Untrusted browser, user-authority CLI |

## Claims

Light may state:

- The Light UI and host run locally; the application is served from the
  installed binary, not from a website.
- Light speaks only the ACP contract of the qualified Grok Build CLI.
- The browser never receives authentication credentials (OAuth tokens, refresh
  tokens, API keys, `auth.json`) or raw ACP.
- Light does not modify Grok configuration from the web surface.
- Light cannot create a persistent permission grant.

## Non-claims

Light may **not** state, and must not imply:

- that the effective CLI configuration is Grok-only;
- that every tool, hook, plugin, or MCP call requests permission through Light —
  the CLI's own `pre_tool_use` hooks and persisted grants can resolve an action
  before Light ever sees it;
- that the workspace is a sandbox;
- that Allow or Deny contains malicious code or prompt injection;
- that a qualified executable makes a session safe;
- that the browser sees no sensitive data — tool output and diffs may carry
  secrets the agent read;
- that the origin hostname can never reach a resolver on an unsupported client;
- that visiting an ordinary HTTP URL can start a stopped native process;
- that any sync, backup, or remote execution exists.

The honest one-line description is in the
[threat model](threat-model.md#1-what-light-is): Light gives a local browser tab
the ability to drive the Grok Build CLI the user installed and authenticated,
with the same authority that CLI already has.

## Requirements

- Grok Build CLI, installed and authenticated by the user, at a qualified version.
- A conforming browser: Chromium, or Firefox 84 or later. WebKit, including
  Safari, is unsupported — see
  [ADR light 0008](adr/0008-supported-browser-engines.md).
- Linux is the first qualification platform. Windows and macOS follow their own
  gates.

Light is not an offline product: Grok Build needs its configured services to
authenticate and produce responses.

## Implementation status

| Area | State |
|------|-------|
| ACP handshake against the qualified CLI | Verified; **minimum qualified** `grok` **0.2.115** (product integrity, ADR light 0005) |
| Permission projection (ADR light 0007) | Implemented and unit-tested |
| Local origin, port policy, `Host`/`Origin` checks | Implemented and unit-tested |
| Pairing, sessions, CSRF | Implemented and unit-tested |
| Control lease and epochs | Implemented and unit-tested |
| Journal, idempotency, event cursor, review records | Implemented and unit-tested |
| HTTP and WebSocket server | Implemented in `crates/grok-light-host` |
| SPA (`apps/light`) | Implemented Work shell: Home, Session, Setup, tools, composer, review |
| ACP session-update projection | Pure module `projection` → `light.local.v1` events (tools, plan, commands) |
| Session history repair (`x.ai/session/repair`) | Implemented: `DiagnoseSession` / `RepairSession`, ADR 0015, SPA opt-in banner |
| Packaging | GitHub Releases multi-OS + `install.sh` / `install.ps1` (unsigned FOSS) |
| User service / autostart | Not started (manual `serve` for beta) |

`grok-bridge doctor` reports the installed CLI against the qualified minimum.
