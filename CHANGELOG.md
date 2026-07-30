# Changelog

All notable, user-facing changes to Grok Desktop Portable are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-30

First stable public line of the local **grok-bridge** (Work UI for the user's
Grok Build CLI). Preceded by GitHub prereleases `v0.1.0-beta.1` / `v0.1.0-beta.2`.

### Added

- Loopback bridge host (`grok-bridge`) with pairing, control lease, and ACP stdio
  transport to the user-installed Grok Build CLI
- Work SPA embed in release binaries; production UI at `https://desktop.grok.me`
- GitHub Release assets: `grok-bridge-linux-x64`, `grok-bridge-darwin-arm64`,
  plus `checksums.txt`
- Install scripts (`install.sh` / `install.ps1`) that resolve the newest release
  including prereleases via the GitHub API
- Opaque workspace ids, session catalog from `GROK_HOME`, permission UI
  (`allow-once` / `reject-once` / `allow-edits-session`)

### Notes

- Windows bridge is not a release target yet (Unix domain sockets for control)
- Builds are unsigned FOSS; verify SHA-256 against `checksums.txt`
- Requires Grok Build CLI ≥ 0.2.115; Chromium or Firefox 84+ (Safari unsupported)
