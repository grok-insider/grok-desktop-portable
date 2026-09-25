# Anonymous presence (hosted landing)

The Work SPA at `https://desktop.grok.me` may show a small **online · total**
badge on the welcome landing. Counts come from **`grok-insider-api`**, not from
the local host (`spanreed agent`) and not from the marketing site.

Local layout:

```text
~/dev/opensource/grok-insider/
  grok-insider-api/          ← this service
  grok-desktop-portable/     ← this SPA
```

Workspace-level summary: [`../docs/presence.md`](../../docs/presence.md)
(from container root: `docs/presence.md`).

## Privacy

| Sent | Not sent |
|------|----------|
| Opaque UUID `client_id` (random, `localStorage` on the document origin) | Auth, pairing tokens, CSRF |
| | Ports, workspace paths, install-id |
| | Prompt text, session ids, tool output |

The public service stores only client ids and last-seen (Redis). IP / User-Agent
are not written by the app. Failures are silent: the badge hides; landing still
works.

## Endpoint

Default: `https://api.grokinsider.net/desktop/v1/portable/count`  
(Override at build: `VITE_PRESENCE_URL`. Empty string disables presence.)

```http
GET  → { "active": N, "total": M, "window_sec": 300 }
POST { "client_id": "<uuid-v4>" } → same
```

Implementation: sibling project **`grok-insider-api`** (Bun HTTP + Redis).

Local:

```sh
cd ../grok-insider-api && docker compose up -d && bun run dev
# VITE_PRESENCE_URL=http://127.0.0.1:3001/desktop/v1/portable/count
```

## SPA behaviour

- Heartbeat every ~60s while the **hosted** SPA is open (landing or Work).
- Badge UI only on `LandingView` (top-right).
- Loopback-embedded SPA does not call presence unless `VITE_PRESENCE_URL` is set
  (and the bridge CSP still restricts `connect-src` to `'self'`).

## CSP

Hosted `connect-src` allows `https://api.grokinsider.net` and
`https://grokinsider.net` in addition to loopback bridge hosts.
