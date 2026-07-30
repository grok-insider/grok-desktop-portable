# AGENTS.md — Grok Desktop Portable

Read this before changing the repository.

**Docs:** [docs/overview.md](docs/overview.md), [docs/protocol.md](docs/protocol.md),
[docs/threat-model.md](docs/threat-model.md), [docs/adr/](docs/adr/).

## Product invariants

- Composition root is `crates/grok-bridge` only. There is no Desktop daemon.
- The bridge executes the **user's** Grok Build CLI against the **user's**
  `GROK_HOME`, auth, plugins, hooks, MCP, and endpoints.
- Production ACP transport is `grok agent --no-leader stdio`. Never expose
  `grok agent serve` to a browser.
- Never pass `--always-approve` or `--plugin-dir` to the agent.
- Never serve the Work SPA from a CDN or add a Portable cloud backend. The host
  serves the SPA over loopback (ADR light 0002 / docs).
- Never accept a filesystem path from the browser; workspaces are opaque ids.
- Permission UI: only `allow-once`, `reject-once`, `allow-edits-session` in v1.
- `interrupted_needs_review` for ambiguous non-idempotent effects; never auto-replay.
- Credentials never enter the renderer, protocol, or logs.
- Supported browsers: Chromium and Firefox 84+. WebKit unsupported.

## Layout

| Path | Role |
|------|------|
| `crates/grok-bridge` | Host + `grok-bridge` binary |
| `apps/web` | Work SPA (embedded at build) |
| `site/` | Landing for desktop.grok.me |
| `install/` | `install.sh` / `install.ps1` sources |
| `docs/` | ADRs, protocol, threat model, UI |

## Commands

```sh
pnpm install
pnpm test:web
pnpm typecheck:web
pnpm build:web
cargo fmt --all --check
cargo clippy -p grok-bridge --all-targets -- -D warnings
cargo test -p grok-bridge
```

Release builds must embed the SPA (`pnpm build:web` before `cargo build --release`).
CI fails if the embedded bundle is empty on release jobs.

## Releases

Only the **bridge binary** is published on GitHub Releases (per OS/arch) plus
`checksums.txt`. No npm app publish required for v0. No code signing.
