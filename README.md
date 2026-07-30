# Grok Desktop Portable

Drive the [Grok Build](https://grok.com) CLI you already installed from
**`https://desktop.grok.me`**, through a small local **`grok-bridge`**.

```text
https://desktop.grok.me  →  grok-bridge (127.0.0.1)  →  grok CLI
```

| Piece | Role |
|-------|------|
| `https://desktop.grok.me` | Production Work UI + landing |
| `grok-bridge` | Only shipped native binary; loopback API + ACP to your CLI |
| `server.mjs` | Optional **stub** demo without a real CLI ([docs/hosted-demo.md](docs/hosted-demo.md)) |

This is **not** Grok Desktop (the Electron app). No Desktop daemon, vault, or
managed `GROK_HOME`. Architecture: [docs/adr/0016-hosted-ui-local-bridge.md](docs/adr/0016-hosted-ui-local-bridge.md).

## Requirements

- Grok Build CLI installed and authenticated (`grok`), version **≥ 0.2.115**
- Chromium or Firefox 84+ (Safari / WebKit unsupported)
- Linux (primary); macOS bridge binary available; Windows bridge not in beta yet
- For hosted UI: allow **local network** access when the browser asks

## Install bridge

```sh
curl -fsSL https://desktop.grok.me/install.sh | sh
```

Or download from
[GitHub Releases](https://github.com/grok-insider/grok-desktop-portable/releases)
and verify `checksums.txt`. Unsigned FOSS builds.

Assets: `grok-bridge-linux-x64`, `grok-bridge-darwin-arm64`.

## Contributing

Default branch is **`master`**. Open feature/fix PRs against **`dev`**. When a
batch is ready, open one integration PR from `dev` into `master`. Releases are
cut by the Release workflow (patch auto; minor/major via Manual Version Bump).
See [AGENTS.md](AGENTS.md).

## First run

```sh
grok-bridge doctor
grok-bridge serve          # leave running
grok-bridge open           # prints https://desktop.grok.me/#pair=… (once implemented)
```

Then open **https://desktop.grok.me**, allow local network if prompted, complete
pairing, and work. Without a running bridge the site shows **landing only**.

Enrol a workspace if needed:

```sh
grok-bridge workspace add /path/to/project
```

## Develop

```sh
pnpm install
pnpm test
pnpm build:web:dist        # SPA for bridge embed / site pipeline
cargo test -p grok-bridge
cargo run -p grok-bridge -- serve
```

| Variable | Purpose |
|----------|---------|
| `GROK_BRIDGE_STATE_DIR` | Host state directory |
| `GROK_BRIDGE_AGENT` | Path to `grok` (default: `grok` on `PATH`) |

## Non-claims

Portable is a control surface, not a sandbox. Your CLI config (plugins, hooks,
MCP) remains authoritative. See [docs/threat-model.md](docs/threat-model.md).

## License

Dual-licensed: AGPL-3.0-or-later or commercial terms from Grok Insider. See
`LICENSE` and `LICENSES/`.
