# Hosted demo host

> **Not the product.** Production Grok Desktop Portable is the local
> `grok-bridge` binary serving the Work SPA on a loopback origin (ADR light
> 0002). This document describes an optional **demo** surface used for
> previews, static hosting checks, and Vercel deploys of this repository.

## Why it exists

CI / App Builder / Vercel environments cannot ship or run the Rust bridge as
the user-facing binary, and they cannot bind the product’s
`*.grok-light.localhost` origin with owner-only pairing. The demo host lets
reviewers exercise the Work UI shell without a local CLI.

## What it is

| Component | Role |
|-----------|------|
| `server.mjs` | Long-lived Node process: static files + HTTP API + WebSocket `/events` |
| `index.mjs` | Alternate entry that re-exports / listens like `server.mjs` |
| `api/*.mjs` | Vercel serverless wrappers for the same HTTP API |
| `lib/vercel-api.mjs` | Path rewrite helper for serverless routes |
| `public/` | Build output of `apps/web` (gitignored; produced by `pnpm build`) |
| `vercel.json` | `outputDirectory: public` + rewrites to `/api/*` |
| `scripts/prepare-public.mjs` | Softens CSP meta, injects demo banner |

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
npm start           # node server.mjs  (PORT/HOST overridable)
curl -s localhost:8080/healthz
```

## Non-claims (demo)

In addition to the product [threat model](threat-model.md):

- The demo is not a security boundary and is not origin-isolated like the bridge.
- Cookies / CSRF exist only to exercise the SPA client; they are not a pairing
  ceremony with a user-owned host.
- Do not point production users at the demo host as a substitute for
  `grok-bridge serve` + `grok-bridge open`.

## Relationship to product invariants

`AGENTS.md` requires that the **product** never serve the Work SPA from a CDN
and never accept filesystem paths from the browser. The demo host is a separate
entrypoint, documented as non-product, and must not be published as the
canonical install path on `desktop.grok.me`.
