# ADR light 0006: Local origin, pairing, control lease, and a single agent session

- Status: proposed
- Date: 2026-07-28

## Context

ADR light 0002 puts the application on a loopback origin served by the host.
That removes cross-origin exposure but does not by itself answer three
questions: which browser may control the host, which tab may act, and how many
agent sessions may run.

Loopback is a machine boundary, not a user account boundary. Any local process,
including one belonging to another user on a shared Linux machine, can open a
connection to the listener. A page from any other origin can also attempt
requests, and cookies are not scoped by port, so the origin hostname is the only
cookie isolation boundary available over plain loopback HTTP.

## Decision

**Origin.** The canonical origin is
`http://<random-install-id>.grok-light.localhost:<stable-port>`. The install id
is random, stable per installation, and derived from nothing about the machine.
The random hostname exists because cookies ignore port, so a fixed name would
share a cookie scope with any other local service on that name. The port is
allocated outside the platform ephemeral range, which on Linux defaults to
`32768-60999`, so a routine outbound socket cannot take it.

`Host` must always match the canonical value exactly. `Origin` handling depends
on the request, because browsers do not attach `Origin` to same-origin safe
requests. Verified against Chrome 150: a document navigation and a same-origin
`GET` carry no `Origin`, while `POST` and `DELETE` carry it exactly. Therefore
safe methods accept an absent `Origin` but reject a mismatched one, and
mutations and the WebSocket upgrade require it exactly. Aliases, proxy headers,
`Origin: null`, non-loopback peers, and any CORS are rejected.

Port unavailability and origin conflict are different failures. A busy port
retries with backoff and keeps hostname, port, and pairings. Only an explicit
`grok-light repair` rotates identity and invalidates the bookmark.

**Pairing.** `grok-light open` reaches the host over an owner-only Unix socket,
the host mints a single-use 256-bit nonce with a short TTL, and the launcher
opens the origin with the nonce in the URL fragment. The fragment never reaches
the server. The SPA exchanges it for a host-only, `HttpOnly`, `SameSite=Strict`
cookie and clears the fragment immediately. The host stores only a hash of the
browser token and supports individual and total revocation. No token appears in
a query string, `localStorage`, a bookmark, a log, or a WebSocket URL.

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
- A permanent token in `localStorage` would be readable by any script that
  achieves execution in the origin.
- Allowing multiple controlling tabs would require conflict resolution for
  approvals, where ambiguity is least acceptable.
- Rotating the origin on any bind failure would convert a transient race into
  permanent user-visible breakage.
