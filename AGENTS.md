# AGENTS.md — Grok Desktop Portable

Read this before changing the repository.

**Docs:** [docs/overview.md](docs/overview.md), [docs/protocol.md](docs/protocol.md),
[docs/threat-model.md](docs/threat-model.md), [docs/adr/](docs/adr/).

## Host moved to Spanreed

This repository is web-only: the Work SPA served at `https://desktop.grok.me`
(Vercel runs `pnpm build` into `public/`, see `vercel.json`) and the installers.
The local host ships as `spanreed agent` (Spanreed CLI); its code is the crate
`fabrials-agent-host` in `grok-insider/fabrials-libs`. Change host code there,
not here. `site/install.sh` and `site/install.ps1` install Spanreed and keep a
`grok-bridge` name that runs `spanreed agent`; `scripts/install-resolve.test.sh`
checks them offline. The SPA must stay compatible with the host wire contract
(`light.local.v1`, storage keys, `mode: "bridge"` in `/healthz`); only
human-facing text names Spanreed.

## Product invariants

- The host (`spanreed agent`) is the only composition root. There is no
  Desktop daemon.
- The host executes the **user's** Grok Build CLI against the **user's**
  `GROK_HOME`, auth, plugins, hooks, MCP, and endpoints.
- Production ACP transport is `grok agent --no-leader stdio`. Never expose
  `grok agent serve` to a browser.
- Never pass `--always-approve` or `--plugin-dir` to the agent.
- **Production UI** is hosted at `https://desktop.grok.me` and talks to the
  host on **loopback** (ADR light 0016). There is no Portable cloud backend
  that runs the CLI. CORS only for the exact allowlisted web origin(s).
- Loopback-served SPA remains a **fallback** (dev/offline), not the primary path.
- Never accept a filesystem path from the browser; workspaces are opaque ids.
- Permission UI: only `allow-once`, `reject-once`, `allow-edits-session` in v1.
- `interrupted_needs_review` for ambiguous non-idempotent effects; never auto-replay.
- Credentials never enter the SPA, protocol, or logs.
- Supported browsers: Chromium and Firefox 84+. WebKit unsupported. Hosted mode
  needs local-network permission where the browser requires it.

## Branch model (Model A)

```
feat/* / fix/*  ──PR──►  dev  ──integration PR──►  master
                                              │
                                        release bot PR
                                   (version + CHANGELOG + AI notes)
                                              ▼
                                  tag vX.Y.Z (package.json)
                                              ▼
                              GitHub Release (CHANGELOG notes)
```

- **Default branch: `master`** — released line only.
- **Human work targets `dev`**, not `master`. Open short-lived `feat/*` / `fix/*`
  branches from `dev`.
- When ready to ship a batch, open one **`dev` → `master`** PR.
- Only `dev` and release-bot heads (`release-plz-*`, `release-plz-manual-*`,
  and release-please patterns) may PR into `master` (`guard-master.yml`).
- Use **Conventional Commits** (`feat:`, `fix:`, `ci:`, `docs:`, `chore:`, …).
  Auto release only opens a PR when there are `feat`/`fix` commits since the
  last tag (patch line). Minor/major: workflow **Manual Version Bump** (admin).

## Layout

| Path | Role |
|------|------|
| `apps/web` | Work SPA (site deploy + optional Spanreed loopback embed) |
| `site/` | Public install scripts (install Spanreed), release notes footer |
| `install/` | Operator installers with env overrides (`VERSION`, `SPANREED_*`) |
| `scripts/` | `public/` assembly and installer tests |
| `docs/` | ADRs (0016 = hosted UI), protocol, threat model, UI |
| `server.mjs` / `api/` | Stub demo only — not production (docs/hosted-demo.md) |

## Commands

```sh
pnpm install
pnpm test:web
pnpm typecheck:web
pnpm build:web
pnpm test:public
pnpm test:install
```

`pnpm build:web:dist` builds only `apps/web/dist`. Spanreed embeds it as the
loopback fallback UI when built with `FABRIALS_AGENT_HOST_WEB_DIST` pointing at
that directory; keep the script for that path.

## Releases

The version is the root `package.json` `version`. A release is a git tag
`vX.Y.Z` plus a GitHub Release whose body is the `CHANGELOG.md` section and
`site/release-footer.md`. No binary assets, no npm publish, no crates.io.
desktop.grok.me deploys from Vercel independently of tags.

**Pipeline** (`.github/workflows/release.yml`): merge a PR into `master` →
`release-pr` opens/updates the patch Release PR `release-plz-v<next>` (bumps
`package.json`, writes the CHANGELOG section with
`grok-insider/release-changelog-action@v1`) when `feat`/`fix` commits landed
since the last tag → merge the Release PR (head `release-plz-*`) → `release`
tags `v<package.json version>` at the merge commit if untagged and publishes the
GitHub Release through the same action (`skip-generate`,
`publish-github-release`). `manual-version-bump.yml` opens
`release-plz-manual-v<next>-<run>` PRs for minor/major bumps.

**Do not hand-edit `CHANGELOG.md` outside a Release PR.**

### Secrets (GitHub repo secrets; never commit values)

| Secret | Purpose |
|--------|---------|
| `RELEASE_PLZ_TOKEN` | PAT so release-bot PRs trigger required CI |
| `OPENROUTER_API_KEY` | AI changelog via release-changelog-action |

Also enable “Allow GitHub Actions to create and approve pull requests” for the
repo.
