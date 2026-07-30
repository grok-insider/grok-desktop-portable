# ADR light 0002: Locally served application with no CDN and no Light backend

- Status: **superseded for production UI** by
  [ADR light 0016](0016-hosted-ui-local-bridge.md) (2026-07-30)
- Date: 2026-07-28
- Note: The loopback-served SPA remains a **supported fallback** (dev, offline,
  recovery). Production Work UI is hosted at `https://desktop.grok.me` and talks
  to `grok-bridge` on loopback. This ADR records the original threat reasoning
  that 0016 accepts as residual risk.

## Context

A browser UI that drives a local agent can be delivered two ways: hosted on a
public origin that connects back to a local process, or served by the local
process itself.

The hosted shape fails on current browsers and on threat model. Chrome shipped
Local Network Access restrictions in 142, split `loopback-network` as its own
permission in 145, and extended the restrictions to WebSocket and WebTransport
in 147; Firefox ships equivalent restrictions and Brave ships its own localhost
permission. A public page opening a socket to loopback therefore prompts the
user to allow connections to devices on their local network, in the middle of
the happy path. A hosted origin also needs either a publicly trusted certificate
for a loopback address, which no CA issues, or a distributed private key.

The threat model is worse than the ergonomics. With a hosted origin, one XSS, a
CDN compromise, a DNS hijack, or a single malicious deploy becomes arbitrary
code execution with the user's authority on every paired machine, with no
user-visible signal and no user control over when code changes.

Light also requires a local host binary regardless, so the hosted shape pays the
full cost of a local install without buying the convenience of a pure web app.

## Decision

`grok-light-host` serves the SPA, its assets, its documentation, and the local
API from the installed binary over loopback. There is no CDN deployment of the
application, no Light backend, no Light telemetry endpoint, no sync service, and
no cloud storage.

Because the document and the socket share one loopback origin, the request is
not a cross-address-space request and Local Network Access does not apply. No
certificate is required, no CORS is configured, no origin allowlist exists, and
`connect-src 'self'` holds unchanged.

Light originates no outbound traffic.

A public site may exist for download and documentation. It never serves the
application and never participates in pairing or control.

## Consequences

- The SPA ships and versions with the host binary, so UI updates require a host
  update rather than a deploy.
- Preview deployments of the real application are not possible; UI previews use
  an explicitly labelled local fake.
- The user must install and run a local binary. This is stated as a requirement
  rather than hidden behind a web URL.
- Compromising the delivered application requires compromising the installed
  artifact, which the user controls and can pin, rather than a remote origin.

## Rejected alternatives

- A hosted SPA with an origin allowlist still leaves the pinned origin able to
  push arbitrary code to every paired machine, and breaks on Local Network
  Access.
- `wss://` to loopback requires a distributed private key or a locally installed
  CA, both of which trade a solved problem for a worse one.
- A browser extension replaces one distribution problem with a store review
  dependency and a broader permission surface.
