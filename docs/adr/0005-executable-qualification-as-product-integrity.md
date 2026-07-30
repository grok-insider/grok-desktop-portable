# ADR light 0005: Executable qualification is product integrity, not a security control

- Status: proposed
- Date: 2026-07-28

## Context

Grok Desktop pins the exact official Grok Build artifact by URL, version, size,
and SHA-256, binds the manifest digest into the daemon at compile time, and
reverifies the executable before every spawn (ADR 0033). That pin is a real
security control there, because Desktop also closes the component's policy and
runs it in a private managed home.

Light does not have that context. ADR light 0004 accepts the user's complete
configuration, including arbitrary plugins, hooks, MCP servers, and custom
endpoints, all executing with the same authority as the CLI itself.

Carrying Desktop's framing into Light would therefore assert a boundary that
does not exist. Verifying the binary while accepting arbitrary plugin code is
defending the smaller opening, and presenting it as a security control invites
reviewers and users to assume containment Light does not provide.

Leaving the requirement vague has a second cost: the Linux gate would carry an
unresolved question about what happens when a platform publishes no verifiable
signature, blocking a phase on an unanswerable question.

## Decision

Light qualifies the Grok Build executable for **product integrity and support**,
not as a security boundary. The purpose is to bound the supported ACP contract,
avoid unknowingly driving a fork, and produce an honest diagnostic when the CLI
changes underneath the product.

The host resolves and persists the qualified executable, and revalidates
canonical path, file identity, and version on every spawn. The web surface never
chooses path, argv, environment, or version.

Where a platform publishes verifiable signatures or checksums for the artifact,
the host uses and records them. Where it does not, qualification rests on
version plus file identity, and says so. The absence of a publishable signature
does not block Phase 1 or the Linux gate, because provenance was never the
security boundary. A version outside the matrix, or an ACP contract that does
not match its fixtures, does block; there is no silent fallback.

Light does not claim that a qualified executable makes a session safe.

## Consequences

- Phase 1 has a defined outcome on every platform instead of an open question.
- Threat model and product copy stay coherent: Light does not advertise a
  boundary it does not enforce.
- A substituted `grok` binary is detected as a support and contract problem, and
  is reported as such rather than as a breach.
- If Light ever closes the configuration surface, this ADR must be revisited,
  because the reasoning depends on ADR light 0004.

## Rejected alternatives

- Reusing Desktop's compile-time pin would assert containment that ADR light
  0004 contradicts, and would also break the premise of running the user's own
  installation.
- Dropping executable checks entirely would remove the contract bound that makes
  ACP drift diagnosable.
- Blocking the Linux gate on an unavailable signature would stall the program on
  a control that does not change the accepted risk.
