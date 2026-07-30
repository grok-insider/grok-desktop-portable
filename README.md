# Grok Desktop Portable

Local **Work** UI for the [Grok Build](https://grok.com) CLI you already installed
and authenticated. A small native **bridge** serves the interface on loopback;
you open it in Chromium or Firefox. There is no cloud backend and no CDN-hosted
app.

| Piece | Role |
|-------|------|
| `grok-bridge` | Only shipped binary (GitHub Releases) |
| Work SPA | Embedded in the bridge; never published as a website |
| `https://desktop.grok.me` | Landing + `install.sh` only |

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
pnpm build:web
cargo test -p grok-bridge
cargo run -p grok-bridge -- serve
```

Environment overrides:

| Variable | Purpose |
|----------|---------|
| `GROK_BRIDGE_STATE_DIR` | Host state directory |
| `GROK_BRIDGE_AGENT` | Path to the `grok` binary (default: `grok` on `PATH`) |

## Non-claims

Portable is a control surface for **your** CLI and configuration. It is not a
sandbox, does not guarantee Grok-only tools/MCP/hooks, and does not contain
malicious model output. Read `docs/threat-model.md`.

## License

Dual-licensed: AGPL-3.0-or-later or a commercial license from Grok Insider.
See `LICENSE` and `LICENSES/`.
