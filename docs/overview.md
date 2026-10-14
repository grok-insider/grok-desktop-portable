# Grok Desktop Portable — product overview

> **Public name:** Grok Desktop Portable. Historical docs and wire identifiers
> still say “Grok Light” / `light.local.v1` / `grok-light` in places; those are
> protocol-stable names in v0, not the product name.

Grok Desktop Portable lets a browser tab at **`https://desktop.grok.me`** drive
the **Grok Build CLI** the user already installed and authenticated, through the
local agent host that ships with Spanreed (**`spanreed agent`**). Scope is Work
only. This repository holds the SPA and the installers; the host is the crate
`fabrials-agent-host` in `grok-insider/fabrials-libs`.

```text
https://desktop.grok.me       Installable PWA / local computer profiles
        │ WSS + pinned Noise over a private network
        ▼
  spanreed agent             User's computer; closed application protocol
        │ ACP stdio / shared terminal leader
        ▼
  grok                       User's CLI + GROK_HOME + configuration
```

The current architecture is [ADR 0020](adr/0020-direct-private-pwa.md). Pairing,
private use and the installed shell do not require a Fabrials account. Public
conversation hosting is a separate explicit opt-in with its own authorization
and deletion policy. `#pair=` retains the explicit legacy loopback launch;
loopback embedding remains the fallback.

The native binary is Spanreed. This repository supplies the SPA, installers and
release notes. The cloud never runs the user's CLI or holds its provider secrets.
The [release plan](public-release-plan.md) identifies mandatory qualification;
the [direct implementation](direct-pwa-implementation.md) records local evidence
and remaining gaps. ADR 0019 and its managed-relay evaluation are historical.

## Naming

| Thing | Name | Note |
|-------|------|------|
| Product | Grok Desktop Portable | Marketing / repo name |
| Local host | `spanreed agent` | Spanreed CLI; `grok-bridge` remains an alias name |
| Production UI | `https://desktop.grok.me` | Installable direct PWA (ADR 0020) |
| App package | `@grok-desktop-portable/web` | Built for site deploy; also embeddable for fallback |
| App path | `apps/web` | SPA source |
| Host crate | `fabrials-agent-host` (`grok-insider/fabrials-libs`) | Loopback API + ACP composition root |
| User CLI (host) | `spanreed agent` | `serve`, `open`, `status`, `doctor`, `stop`, `repair`, `workspace` |
| Local protocol | `light.local.v1` | Browser ↔ host (not ACP) |
| ACP client identifier | `grok-light` | Via `GROK_CLIENT_NAME` → `ClientType::Generic` |
| Docs root | `docs/` | ADRs under `docs/adr/` |

The `@grok-desktop/` npm scope reflects the workspace, not the product.
User-facing copy says **Grok Desktop Portable** and never implies it is the
Electron Grok Desktop application. Wire names (`light.local.v1`, `grok-light`)
stay protocol-stable in v0.

## Positioning

| Dimension | Grok Desktop | Grok Desktop Portable |
|-----------|--------------|------------------------|
| Surfaces | Chat, Research, Work, library, automations, integrations | Work only |
| Presentation | Electron renderer | User's browser against a local origin |
| Executor | Rust daemon, pinned ACP component, managed policy | The user's Grok Build CLI |
| Grok configuration | Private, closed Desktop profile | The user's complete configuration |
| Secrets | Desktop daemon vault | Owned by the CLI |
| Threat model | Untrusted renderer, managed execution | Untrusted browser, user-authority CLI |

## Claims

Portable may state:

- The Portable UI is served from `desktop.grok.me` (or the host's embedded
  fallback); the host and CLI run locally on the user's machine.
- Portable speaks only the ACP contract of the qualified Grok Build CLI.
- The browser never receives authentication credentials (OAuth tokens, refresh
  tokens, API keys, `auth.json`) or raw ACP.
- Portable does not modify Grok configuration from the web surface.
- Portable cannot create a persistent permission grant.

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
- that private execution works without reaching the user's host and configured providers;
- that automatic backups or a managed relay are available, or that offline copies are current.

The honest one-line description is in the
[threat model](threat-model.md#1-what-light-is): Light gives a local browser tab
the ability to drive the Grok Build CLI the user installed and authenticated,
with the same authority that CLI already has.

## Requirements

- Grok Build CLI (**≥ 0.2.115**), installed and authenticated by the user.
  Portable does **not** install `grok`; that is a separate product/installer.
- A qualified current Chromium or Firefox browser. Apple clients require explicit
  experimental opt-in until the physical-device gates pass (ADR 0020).
- Spanreed for Linux x86_64, macOS (arm64, x86_64) or native Windows x64,
  installed via `install.sh` / `install.ps1` from the site.
- Start the host with `spanreed agent serve` (or the Spanreed tray).

The installed shell, opted-in drafts and separately opted-in read-only transcript copies can open offline. Transcript copies contain messages and tool summaries, with explicit missing-image indicators. Grok Build still
needs its configured services to authenticate and produce responses.

## Implementation status

| Area | State |
|------|-------|
| ACP handshake against the qualified CLI | Verified; **minimum qualified** `grok` **0.2.115** (product integrity, ADR light 0005) |
| Permission projection (ADR light 0007) | Implemented and unit-tested |
| Local origin, port policy, `Host`/`Origin` checks | Implemented and unit-tested |
| Pairing, sessions, CSRF | Implemented and unit-tested |
| Control lease and epochs | Implemented and unit-tested |
| Journal, idempotency, event cursor, review records | Implemented and unit-tested |
| HTTP and WebSocket server | Implemented in `fabrials-agent-host` |
| SPA (`apps/web`) | Implemented Work shell: Home, Session, Setup, tools, composer, review |
| ACP session-update projection | Pure module `projection` → `light.local.v1` events (tools, plan, commands) |
| Session history repair (`x.ai/session/repair`) | Implemented: auto dry-run diagnose + opt-in `RepairSession` apply (ADR 0015) |
| Packaging | Spanreed releases + `install.sh` / `install.ps1` (unsigned FOSS) |

`spanreed agent doctor` reports the installed CLI against the qualified minimum.
