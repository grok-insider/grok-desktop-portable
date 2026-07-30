# ADR light 0006: Local origin, pairing, control lease, and a single agent session

- Status: proposed (amended 2026-07-30 for hosted UI — see
  [ADR light 0016](0016-hosted-ui-local-bridge.md))
- Date: 2026-07-28

## Context

Originally ADR light 0002 put the application on a loopback origin served by
the host. Production UI is now the hosted document at `https://desktop.grok.me`
(ADR 0016), while the **API** remains on loopback. That does not by itself
answer: which browser may control the host, which tab may act, and how many
agent sessions may run.

Loopback is a machine boundary, not a user account boundary. Any local process,
including one belonging to another user on a shared Linux machine, can open a
connection to the listener. A page from any other origin can also attempt
requests, and cookies are not scoped by port, so the origin hostname is the only
cookie isolation boundary available over plain loopback HTTP.

## Decision

**Two origins (after ADR 0016).** Distinguish:

| Role | Value |
|------|--------|
| **Document (production)** | `https://desktop.grok.me` (allowlisted) |
| **API (always)** | Loopback, e.g. `http://127.0.0.1:<port>` or fallback `http://<install-id>.grok-light.localhost:<port>` |

The install id remains random and stable per installation. The port is allocated
outside the platform ephemeral range (Linux default ephemeral `32768-60999`) so
a routine outbound socket cannot take it. The bridge binds **loopback only**.

**`Host` (API request).** Must match the API host the client is calling
(loopback forms only). It is not the document hostname.

**`Origin` (browser).**

- **Hosted document (production):** mutations and WebSocket upgrades require
  `Origin` exactly equal to an allowlisted web origin (default
  `https://desktop.grok.me`). Safe probe methods used for discovery may omit
  credentials but must not accept a *mismatched* Origin when present. CORS
  preflight is answered only for allowlisted origins with exact
  `Access-Control-Allow-Origin` (never `*`) and credentials allowed.
- **Loopback document (fallback SPA):** safe methods may omit `Origin`;
  mutations and WS require the exact loopback document origin. No CORS is
  required for same-origin fallback.

`Origin: null`, unknown origins, and non-loopback peers are rejected.

Port unavailability and identity rotation remain separate: a busy port retries
with backoff and keeps pairings; only explicit `grok-bridge repair` rotates
identity.

**Pairing.** `grok-bridge open` reaches the host over an owner-only Unix socket,
the host mints a single-use 256-bit nonce with a short TTL, and the launcher
hands the user a URL whose fragment carries the nonce — for production,
`https://desktop.grok.me/#pair=<nonce>` (or equivalent). The SPA redeems the
nonce against the **loopback** pair endpoint. The bridge sets a host-only
`HttpOnly` session cookie on the **loopback** response (first-party to the API
host). The SPA clears the fragment immediately and uses `credentials: 'include'`
on subsequent API calls. The host stores only a hash of the browser token and
supports individual and total revocation. No pairing **nonce** appears in a
query string, a public bookmark, a log, or a WebSocket URL. Hosted SPA may
persist the **session token + CSRF** and last loopback **port** on the document
origin for silent resume across tabs/restarts (see [ADR light 0016](0016-hosted-ui-local-bridge.md));
that is resume QoL, not a second pairing channel, and is cleared on demotion.

Because the nonce is only obtainable through an owner-only socket, another local
user can reach the listener but cannot pair.

**Control lease.** The first paired tab takes a control lease bound to its
WebSocket and a monotonic epoch. Prompts, cancels, workspace mutations, and
permission decisions carry the expected epoch. A second tab is blocked and may
show status only. Heartbeats renew the lease, a short grace covers reload, and
expiry denies pending permissions, attempts a bounded cancel, and leaves any
ambiguous effect in `interrupted_needs_review`. v1 does not allow forcible
takeover of a live controlling tab.

**Sessions.** One agent session is active at a time. Concurrency requires a
later ADR. **Superseded by [ADR light 0011](0011-concurrent-agent-sessions.md):
sessions run concurrently on one agent process, bounded, and each is addressed
by id. The single-controller decision above is unchanged.**

## Consequences

- A transient port race never destroys the user's bookmark or pairings.
- Another local user can observe that the port is open but cannot control it.
- Two tabs cannot race a permission decision, which removes a class of ambiguous
  approvals.
- Users cannot run parallel agent sessions in v1, which is a real limitation and
  is stated rather than worked around. Lifted by ADR light 0011 once the
  qualified CLI was measured holding concurrent turns on one connection.

## Rejected alternatives

- A fixed hostname with a random port would leave the cookie scope shared with
  any other local service using that name.
- Requiring `Origin` on every request would reject the application's own
  document load, as the Chrome 150 measurement shows.
- Treating the pairing **nonce** as a permanent bookmark grant remains rejected.
  A **session** token on the document origin for resume is accepted under ADR
  0016 with explicit clear rules (XSS on that origin already implies control).
- Allowing multiple controlling tabs would require conflict resolution for
  approvals, where ambiguity is least acceptable.
- Rotating the origin on any bind failure would convert a transient race into
  permanent user-visible breakage.
