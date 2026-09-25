# Changelog

All notable, user-facing changes to Grok Desktop Portable are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-07-31

- docs: Portable UI, auto dry-run diagnosis, and CLI surface gaps
- feat(web): Portable Work chrome, composer, thinking, and auto diagnosis
- ci(release): publish CHANGELOG notes to GitHub Releases via shared action

## [0.1.1] - 2026-07-31

- style: rustfmt events_socket test
- fix(test): connect events_socket via 127.0.0.1 for Windows CI
- fix(ci): build fake_agent with EXE_SUFFIX for Windows tests
- fix(bridge): make unit tests and Windows identity portable
- docs: ship-min multiplatform install and prereq messaging
- fix(bridge): make Windows owner-only DACL verification work
- fix(bridge): make Windows control plane compile and test cleanly
- ci(release): ship native Windows grok-bridge-windows-x64.exe
- feat(bridge): kill Windows ACP process tree via job object
- feat(bridge): Windows owner-only state directory ACLs
- feat(bridge): Windows named-pipe control plane with Unix UDS path
- fix(ci): release checksums without a git checkout

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
