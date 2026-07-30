# Grok Desktop Portable

Local **Work** UI for the [Grok Build](https://grok.com) CLI you already installed
and authenticated. A small native **bridge** serves the interface on loopback;
you open it in Chromium or Firefox. There is no cloud backend and no CDN-hosted
**product** app.

| Piece | Role |
|-------|------|
| `grok-bridge` | Only shipped binary (GitHub Releases) |
| Work SPA | Embedded in the bridge; never the production website |
| `https://desktop.grok.me` | Landing + `install.sh` only |
| `server.mjs` (optional) | **Hosted demo** host for previews / Vercel — not the product path |

This product is **not** Grok Desktop (the Electron app). It does not use the
Desktop daemon, vault, or managed `GROK_HOME`.

## Requirements

- Grok Build CLI installed and authenticated (`grok`), version **≥ 0.2.115**
- Chromium or Firefox 84+ (Safari / WebKit are unsupported)
- Linux, Windows, or macOS

## Install (beta)

```sh
curl -fsSL https://desktop.grok.me/install.sh | sh
```

Or download a binary from
[GitHub Releases](https://github.com/grok-insider/grok-desktop-portable/releases)
and verify the SHA-256 in `checksums.txt`.

Builds are **unsigned** FOSS artifacts. Prefer verifying the checksum and the
tag source over platform “smart screen” prompts.

## First run

```sh
grok-bridge doctor   # CLI + state dir
grok-bridge serve    # leave running
# other terminal:
grok-bridge open     # prints a one-time pairing URL
```

On Windows/macOS without a native folder picker yet, enrol a workspace from the
CLI:

```sh
grok-bridge workspace add /path/to/project
```

## Develop

```sh
pnpm install
pnpm build:web          # → public/ (and prepares static HTML)
cargo test -p grok-bridge
cargo run -p grok-bridge -- serve
```

Environment overrides:

| Variable | Purpose |
|----------|---------|
| `GROK_BRIDGE_STATE_DIR` | Host state directory |
| `GROK_BRIDGE_AGENT` | Path to the `grok` binary (default: `grok` on `PATH`) |

## Hosted demo (preview / Vercel)

The product remains loopback-only. For App Builder previews and static hosting
checks, this repo also ships a **demo host** that is explicitly not the
production bridge:

| Path | Role |
|------|------|
| [`server.mjs`](server.mjs) | Node entrypoint (`package.json` `main`/`start`): serves `public/` + mock `light.local.v1` |
| [`api/`](api/) | Vercel serverless routes for `/pair`, `/session`, `/command`, `/healthz` (import handler from `server.mjs`) |
| [`vercel.json`](vercel.json) | `outputDirectory: public`, API rewrites |
| [`scripts/prepare-public.mjs`](scripts/prepare-public.mjs) | Post-build HTML patch (CSP / demo banner) |
| [`docs/hosted-demo.md`](docs/hosted-demo.md) | Full demo contract and non-claims |

```sh
pnpm install
pnpm build              # builds Work SPA into public/ (gitignored)
npm start               # node server.mjs on 0.0.0.0:8080
```

Vercel: `pnpm build` must emit `public/`; do not commit that directory. Without
`server.mjs` on the branch, the Node entrypoint and serverless API routes fail.

The demo auto-pairs the browser, exposes a sample project, and streams stub
replies. It does **not** run your Grok Build CLI or honour production origin /
pairing threat-model guarantees.

## Non-claims

Portable is a control surface for **your** CLI and configuration. It is not a
sandbox, does not guarantee Grok-only tools/MCP/hooks, and does not contain
malicious model output. Read `docs/threat-model.md`.

## License

Dual-licensed: AGPL-3.0-or-later or a commercial license from Grok Insider.
See `LICENSE` and `LICENSES/`.
