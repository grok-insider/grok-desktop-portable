# Grok Desktop Portable

Drive the [Grok Build](https://grok.com) CLI you already installed from
**`https://desktop.grok.me`**, through the local agent host that ships with
[Spanreed](https://github.com/grok-insider/spanreed) (`spanreed agent`).

```text
https://desktop.grok.me  →  spanreed agent (127.0.0.1)  →  grok CLI
```

| Piece | Role |
|-------|------|
| `https://desktop.grok.me` | Production Work UI + landing (this repo, deployed by Vercel) |
| `site/install.sh`, `site/install.ps1` | Public installers served at `desktop.grok.me`; they install Spanreed |
| `spanreed agent` | Loopback API + ACP to your CLI. Code: crate `fabrials-agent-host` in `grok-insider/fabrials-libs` |
| `server.mjs` | Optional **stub** demo without a real CLI ([docs/hosted-demo.md](docs/hosted-demo.md)) |

This is **not** Grok Desktop (the Electron app). No Desktop daemon, vault, or
managed `GROK_HOME`. Architecture: [docs/adr/0016-hosted-ui-local-bridge.md](docs/adr/0016-hosted-ui-local-bridge.md).

## Requirements

- Grok Build CLI installed and authenticated (`grok`), version **≥ 0.2.115**
- Chromium or Firefox 84+ (Safari / WebKit unsupported; Edge is fine on Windows)
- Linux x86_64, macOS (arm64 and x86_64) or native Windows x64
- For hosted UI: allow **local network** access when the browser asks

## Install Spanreed

```sh
curl -fsSL https://desktop.grok.me/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://desktop.grok.me/install.ps1 | iex
```

The installers download the newest
[Spanreed release](https://github.com/grok-insider/spanreed/releases) and verify
its SHA-256 checksum. They also add a `grok-bridge` name that runs
`spanreed agent`, so older commands keep working. For forks, pinned tags or
custom directories, use `install/install.sh` / `install/install.ps1` from a
clone (they read `VERSION`, `SPANREED_REPO`, `SPANREED_INSTALL_DIR`,
`INSTALL_DRY_RUN`).

## First run

`grok` must already be on your `PATH` and authenticated (separate from this
installer). A bookmark cannot start a stopped host.

```sh
spanreed agent doctor
spanreed agent serve       # leave running
spanreed agent open        # prints https://desktop.grok.me/#pair=…
```

Open the pair URL in **Chrome or Firefox 84+** (Edge OK on Windows; Safari
unsupported), allow local network if prompted, complete pairing, and work.
Without a running host the site shows **landing only**.

Enrol a workspace if needed (Linux may also use the in-UI folder picker):

```sh
spanreed agent workspace add /path/to/project
```

## Contributing

Default branch is **`master`**. Open feature/fix PRs against **`dev`**. When a
batch is ready, open one integration PR from `dev` into `master`. Releases are
cut by the Release workflow from the `package.json` version (patch auto;
minor/major via Manual Version Bump). See [AGENTS.md](AGENTS.md).

## Develop

```sh
pnpm install
pnpm test                  # web tests, public/ assembly, installer tests
pnpm build                 # SPA + installers into public/ (what Vercel serves)
pnpm build:web:dist        # SPA only, into apps/web/dist
```

`apps/web/dist` can be embedded in a Spanreed build as the loopback fallback
UI: build Spanreed with `FABRIALS_AGENT_HOST_WEB_DIST` pointing at it.

## Non-claims

Portable is a control surface, not a sandbox. Your CLI config (plugins, hooks,
MCP) remains authoritative. See [docs/threat-model.md](docs/threat-model.md).

## License

Dual-licensed: AGPL-3.0-or-later or commercial terms from Grok Insider. See
`LICENSE` and `LICENSES/`.
