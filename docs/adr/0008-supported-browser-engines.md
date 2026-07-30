# ADR light 0008: Supported browser engines and WebKit exclusion

- Status: proposed (amended 2026-07-30 for hosted UI — see
  [ADR light 0016](0016-hosted-ui-local-bridge.md))
- Date: 2026-07-28

## Context

Production Work UI is hosted at `https://desktop.grok.me` and calls
`grok-bridge` on loopback (ADR 0016). That path depends on the browser allowing
a **public origin to connect to loopback** (Chromium Local Network Access /
equivalent). Fallback loopback SPA still depends on `*.localhost` resolving to
loopback without consulting DNS and treating that origin as potentially
trustworthy.

Chromium implements this. Firefox has supported `http://localhost` and
`http://*.localhost` as trustworthy origins since Firefox 84. WebKit does not:
it has never implemented the name resolution rule, does not treat loopback as
potentially trustworthy, and the tracking issue has been open since 2017 with no
commitment to change.

Measured on a glibc Linux host with Chrome 150:

| Check | Result |
|-------|--------|
| `getent ahosts <id>.grok-light.localhost` | `127.0.0.1` and `::1` |
| `location.origin` in the page | the canonical `.grok-light.localhost` origin |
| `window.isSecureContext` | `true` |
| `crypto.subtle` | available |
| Server-observed peer address | `127.0.0.1` |
| `HttpOnly; SameSite=Strict` cookie | set and echoed back |

Name resolution therefore happens twice over: the browser short-circuits it, and
glibc's resolver also maps `*.localhost` to loopback locally per RFC 6761. A
direct DNS query for the name returns `NXDOMAIN`, which is why a tool that
bypasses the system resolver appears to fail while the system path succeeds.

This is a settled question, not an open compatibility risk to be discovered in a
platform phase.

## Decision

Supported engines are Chromium and Firefox 84 or later. WebKit is unsupported
and not qualified. This includes Safari on macOS and iOS, GNOME Web, and any
WebKitGTK embedder.

**Hosted UI (ADR 0016):** Chromium shows a Local Network Access (or successor)
permission when `https://desktop.grok.me` first reaches `http://127.0.0.1`. The
user must allow it for Work mode. Denial is a first-class UI state (landing +
help), not a silent hang. Firefox support requires the same local-access story
as qualified on the matrix; engines that cannot reach loopback from a public
page cannot use hosted mode (fallback loopback SPA may still work where
`*.localhost` qualifies).

Setup detects the engine. A non-conforming engine is blocked with a diagnostic
and guidance rather than an opaque failure. Each platform installer verifies the
presence of at least one conforming browser.

Per platform: Windows is covered by Edge, which is Chromium. Linux requires
Chromium or Firefox rather than the WebKit-based default of some desktops. macOS
explicitly requires Chrome or Firefox, because its default browser cannot run
Light; the macOS gate includes that requirement in the installer and the
documentation.

Because the origin is a `.localhost` name, a conforming browser resolves it
internally and a conforming system resolver resolves it locally, so the install
identifier does not reach a DNS server. On a client that implements neither
rule, the name would be sent to the configured resolver. That residual exposure
is disclosed in the threat model rather than mitigated, because resolution
happens before any request reaches the host.

The engine matrix is not an open release decision. Minimum versions within these
engines, and the Linux distribution matrix, remain open.

## Consequences

- Light is not usable in Safari, and macOS users must install another browser.
  This is stated up front rather than discovered during the macOS gate.
- Qualification work is bounded to two engine families.
- `isSecureContext` holds, so the SPA may rely on secure-context APIs.
- If WebKit later implements the resolution rule and trustworthy-origin
  treatment, this ADR is revisited rather than worked around.

## Rejected alternatives

- Using `127.0.0.1` directly would work on more engines but would place Light in
  a cookie scope shared with every other loopback service, since cookies ignore
  port.
- Serving over local TLS to satisfy WebKit requires a distributed private key or
  a locally installed CA, rejected in ADR light 0002.
- Shipping an embedded WebView would make Light a desktop application and remove
  the reason to use the user's own browser.
- Leaving the engine matrix to a later phase would defer a known, unchanging
  answer to the most expensive moment to discover it.
