---

**Install**

```sh
curl -fsSL https://desktop.grok.me/install.sh | sh
```

Windows: `irm https://desktop.grok.me/install.ps1 | iex`

Verify SHA-256 against `checksums.txt`. Builds are unsigned FOSS.

Requirements: Grok Build CLI ≥ 0.2.115 (install and auth separately — Portable does not install `grok`), Chromium or Firefox 84+ (Edge OK on Windows).
Safari/WebKit is unsupported. No autostart: run `grok-bridge serve` yourself. Assets: `grok-bridge-linux-x64`, `grok-bridge-darwin-arm64`,
`grok-bridge-windows-x64.exe`. Native Windows (named pipes); not WSL-primary.
