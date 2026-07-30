# ADR light 0001: Work-only sibling product with a separate composition root

- Status: proposed
- Date: 2026-07-28

## Context

Grok Desktop delivers Chat, Research, Work, library, automations, and managed
integrations through an Electron shell over a Rust daemon that owns durable
state, secrets, policy, approvals, and tool execution. That daemon deliberately
runs a pinned official Grok Build component inside a private managed home with
closed policy (ADR 0032, ADR 0033).

A separate demand exists: drive the Grok Build CLI the user already installed
and authenticated, from a browser UI, on the user's own configuration. Serving
that from the Desktop daemon would require the daemon to run an unpinned
executable against a user-owned `GROK_HOME`, which contradicts the component
ownership and credential boundaries it exists to enforce.

## Decision

Grok Light is a sibling product, not a Desktop surface and not a renderer of the
Desktop daemon. Its scope is Work only. Chat, Research, Isolated Guest, Desktop
Host Tools, the Desktop vault, automations, voice, desktop computer-use, and
Electron are out of product.

Light has its own composition root, `crates/grok-light-host`, its own local
protocol, and its own lifecycle. It does not link the Desktop daemon, does not
reuse Host Tools enrollment, and never reads or shares the Desktop managed
`GROK_HOME`.

Desktop invariants continue to apply to Desktop unchanged. Light is a documented
exception with its own invariants, recorded in `AGENTS.md` and in the ADRs of
this directory. Neither product weakens the other by proximity.

Shared code moves in one direction only: presentation primitives may be
extracted from Desktop once Light's backend is proven, and only when they carry
no daemon, Electron, or policy coupling. Behaviour, policy, and trust decisions
are never shared implicitly.

## Consequences

- Two composition roots exist in one repository, each responsible for its own
  authority model. Reviewers must not assume a Desktop invariant holds in Light.
- Light re-implements transport, journaling, and recovery mechanics that Desktop
  already solved. Designs are reused as normative input; code is not.
- A change to Desktop policy does not silently change Light behaviour, and the
  reverse is also true.
- Scope creep toward Chat, Research, or Guest inside `apps/light` requires a
  product ADR that supersedes this one.

## Rejected alternatives

- Adding a web transport to the Desktop daemon would force it to accept an
  unpinned executable and a user-owned credential home, dissolving the boundary
  ADR 0033 establishes.
- Shipping Light as another Desktop renderer would inherit Desktop capability
  state and approvals that Light cannot honour.
- A shared "Work backend" behind both products would couple two different trust
  models at the point where they differ most.
