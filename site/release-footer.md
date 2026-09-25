---

**Install**

```sh
curl -fsSL https://desktop.grok.me/install.sh | sh
```

Windows: `irm https://desktop.grok.me/install.ps1 | iex`

The installers download [Spanreed](https://github.com/grok-insider/spanreed/releases) and verify its SHA-256 checksum. The Work UI is served at https://desktop.grok.me; this release has no binary assets.

Requirements: Grok Build CLI ≥ 0.2.115 (install and auth separately — Portable does not install `grok`), Chromium or Firefox 84+ (Edge OK on Windows).
Safari/WebKit is unsupported. Start the host with `spanreed agent serve`, then pair with `spanreed agent open`.
