# ADR light 0016: Hosted Work UI on `desktop.grok.me` with a local bridge

- Status: accepted
- Date: 2026-07-30
- Supersedes (production UI delivery): [ADR light 0002](0002-locally-served-application.md)
- Amends: [ADR light 0006](0006-local-origin-pairing-and-control-lease.md),
  [ADR light 0008](0008-supported-browser-engines.md)

## Context

Grok Desktop Portable exists so a user can drive the Grok Build CLI they already
installed and authenticated, with their own configuration and authority. The
binary `grok-bridge` owns pairing, the closed `light.local.v1` surface, the
supervised ACP child, and never puts OAuth tokens or API keys in the browser.

ADR light 0002 chose to **serve the Work SPA from the bridge over loopback** so
the document and the API share one origin: no CORS, no Local Network Access
prompt, and no public origin that could push code to every paired machine.

Product direction has since fixed a different delivery for the **UI**:

```text
https://desktop.grok.me     →  Work SPA / landing (public origin)
        │  fetch + WebSocket to loopback
        ▼
  grok-bridge (127.0.0.1)   →  light.local.v1
        │  ACP stdio
        ▼
  grok (user CLI)
```

Users open **one public URL**. Without a running bridge (or without pairing)
they see **landing only** (install, start bridge, browser help). With bridge and
pairing they use Work against their local CLI. The cloud never runs the CLI.

That reintroduces a public document origin talking to loopback. The trade-offs
ADR 0002 rejected become **accepted product risks**, mitigated by pairing, an
exact Origin allowlist, credentials only on the loopback API host, and
deploy discipline for `desktop.grok.me`.

## Decision

1. **Production Work UI** is hosted at `https://desktop.grok.me` (and only
   origins explicitly listed in the bridge allowlist). It is not a second
   backend: it is static application code plus client logic.

2. **`grok-bridge`** remains the sole composition root for control of the CLI.
   It binds **loopback only**, runs ACP stdio to the user's `grok`, and enforces
   the closed operation surface, journal, permissions, and bounds.

3. **Cross-origin API access** is allowed only for allowlisted document
   origins. The bridge:

   - answers CORS preflight for those origins with exact
     `Access-Control-Allow-Origin` (never `*`) and credentials allowed;
   - requires `Origin` on mutations and WebSocket upgrades to match the
     allowlist (or the loopback document origin in fallback mode);
   - validates `Host` against the **API** host the SPA calls (typically
     `127.0.0.1:<port>` or `localhost:<port>`), independent of the document
     origin.

4. **Session model.** Pairing still starts from an owner-only control channel
   (`grok-bridge open` mints a single-use nonce). The hosted SPA redeems the
   nonce against the loopback API. The bridge sets the session cookie on the
   **loopback response** (first-party to `http://127.0.0.1:<port>`). The SPA
   uses `credentials: 'include'` on API calls. CSRF continues to apply on
   mutations. Tokens are not stored in `localStorage` as a long-lived power
   grant.

5. **Landing vs Work.** The hosted SPA probes the bridge (`/healthz` or
   equivalent). States include at least: bridge missing, local-network
   permission blocked, needs pairing, ready. Work UI is not shown until ready.

6. **Fallback.** The bridge may still embed and serve a loopback SPA for
   development, offline, or recovery. That mode keeps same-origin behaviour
   from ADR 0002 and does not replace production hosted UI.

7. **Non-claims unchanged in substance:** Portable is not a sandbox; user
   configuration (plugins, hooks, MCP) remains authoritative; the browser may
   see tool output that contains secrets the agent read.

## Consequences

- Chromium users must grant **Local Network Access** (or equivalent) for
  `desktop.grok.me` to reach loopback. That is a UX cost, not a security
  boundary.
- A compromised deploy of `desktop.grok.me`, XSS, or DNS hijack of that name
  can drive every **currently paired** bridge until revocation. Mitigations:
  pairing expiry/revocation, no silent always-approve, strict Origin allowlist,
  release discipline.
- CORS and CSP (`connect-src` including loopback) become part of the product
  contract and must be tested.
- UI updates can ship by deploying the site without a bridge release; protocol
  and security changes still require a bridge release.
- ADR 0002 remains historically true as the **fallback** path and as the
  rationale we knowingly trade for hosted UX.

## Rejected alternatives

- **DNS `desktop.grok.me` → 127.0.0.1 only:** works for a local-looking URL but
  cannot serve a public landing when the bridge is stopped without always-on
  local process or a second hostname.
- **Cloud executes the CLI:** out of product; credentials and config stay user-
  owned on the machine.
- **Open CORS or `Origin: *`:** rejected; only exact allowlisted origins.
- **Serving production Work UI from an unauthenticated loopback without
  pairing:** rejected; pairing remains required for control.

## Implementation notes (non-normative)

- Default allowlist entry: `https://desktop.grok.me`.
- Dev may add `http://127.0.0.1:5173` / Vite origins via explicit config, never
  by default in release builds.
- Well-known bridge port remains outside the ephemeral range; the SPA learns
  it via build-time config and/or a documented default.
- Protocol document: `docs/protocol.md`. Threat model: `docs/threat-model.md`.
