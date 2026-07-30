# Hosted demo host (stub / preview)

> **Not the product.** Production Grok Desktop Portable (ADR light 0016) is:
>
> - Work UI at **`https://desktop.grok.me`** (real SPA), and
> - **`grok-bridge`** on loopback talking to the user's Grok Build CLI.
>
> This document describes an optional **stub demo** (`server.mjs`) used for
> previews and CI without a real CLI. It must not be confused with production
> hosted UI + real bridge.

## Why it exists

CI / App Builder / Vercel environments cannot ship or run the Rust bridge as
the user-facing binary, and they cannot bind the product’s
`*.grok-light.localhost` origin with owner-only pairing. The demo host lets
reviewers exercise the Work UI shell without a local CLI.

## What it is

| Component | Role |
|-----------|------|
| `server.mjs` | **Required** demo entry: static files + HTTP API + WebSocket `/events` |
| `index.mjs` | Alternate entry that re-exports / listens like `server.mjs` |
| `api/*.mjs` | Vercel serverless wrappers (import the handler from `server.mjs`) |
| `lib/vercel-api.mjs` | Path rewrite helper for serverless routes |
| `public/` | Build output of `apps/web` (gitignored; produced by `pnpm build`) |
| `vercel.json` | `outputDirectory: public` + rewrites to `/api/*` |
| `scripts/prepare-public.mjs` | Softens CSP meta, injects demo banner |
| `startup.sh` | Idempotent preview revive (`node server.mjs` when down) |

Root `package.json` sets `"main": "server.mjs"` and `"start": "node server.mjs"`.
Without `server.mjs` on the branch, Vercel has no Node entrypoint and the
serverless `api/*` routes cannot load the shared handler.

## Protocol coverage

Implements enough of `light.local.v1` for a playable walkthrough:

- `POST /pair`, `GET /session` (auto-pair on first visit)
- `POST /command` for bootstrap, workspaces, sessions, models, prompt, etc.
- `GET /events` WebSocket (long-lived `server.mjs` only; not on serverless)

Prompt replies are **stubbed text**. There is no ACP session and no
`GROK_BRIDGE_AGENT`.

## Commands

```sh
pnpm install
pnpm build          # apps/web → public/ + prepare-public
npm start           # node server.mjs  (PORT/HOST overridable; default 0.0.0.0:8080)
curl -s localhost:8080/healthz
```

## Vercel

| Setting | Value |
|---------|-------|
| Install | `corepack enable && pnpm install` (see `vercel.json`) |
| Build | `pnpm build` → writes `public/` |
| Output Directory | `public` |
| Production SPA routes | `/`, `/s/:sessionId`, `/setup` → `index.html` |
| Demo static | `/demo` only |
| Bridge API | **Not** on Vercel — only `grok-bridge` on loopback (ADR 0016) |
| Serverless `api/*` | Local/demo only. Production **must not** rewrite `/pair` `/session` `/command` `/healthz` to stubs (that made the hosted SPA treat the public origin as a bridge). |

Do not commit `public/` (gitignored). The platform build must produce it.

## Non-claims (demo)

In addition to the product [threat model](threat-model.md):

- The demo is not a security boundary and is not origin-isolated like the bridge.
- Cookies / CSRF exist only to exercise the SPA client; they are not a pairing
  ceremony with a user-owned host.
- Do not point production users at the demo host as a substitute for
  `grok-bridge serve` + `grok-bridge open`.

## Relationship to product invariants

ADR light 0016 **does** ship the production Work SPA from `desktop.grok.me`,
but that SPA talks only to a **real** `grok-bridge` on loopback — not to
`server.mjs` stubs. The demo host here remains a separate, non-product
entrypoint for previews without a CLI. It must never be the path that drives a
user's agent. The product still never accepts filesystem paths from the
browser.
