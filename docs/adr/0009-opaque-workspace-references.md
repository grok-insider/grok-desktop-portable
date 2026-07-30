# ADR light 0009: Workspace references are opaque, and the host resolves every directory

- Status: proposed
- Date: 2026-07-29

## Context

Light is host-authority execution by design (ADR light 0001). The agent runs as
the desktop user, with that user's full Grok Build configuration (ADR light
0004), so whatever directory the agent is pointed at is a directory it can read
and write with the user's own rights. The choice of directory is therefore the
single most consequential input in the product.

The browser is the least trustworthy place to make that choice. It is reachable
by any page the user has open, and a command body is attacker-influenceable in
a way a host-side lookup is not. `AGENTS.md` already states the rule — never
accept a filesystem path from the browser; workspaces are opaque ids — and the
plan and threat model repeat it, but no ADR records it. Two places in the code
cite "light ADR 0006" for it, which is the origin, pairing, and control lease
decision and says nothing about paths. A rule this load-bearing should not rest
on a mis-citation.

The gap became concrete with session loading. The ACP `session/load` method
takes both a `sessionId` and a `cwd`; verified against grok 0.2.112, it is
implemented (an unknown id answers `-32603`, not `-32601`, so the method
exists). Light's `LoadSession` operation carries only a session id, so there is
no directory to send. The operation currently returns `Acknowledged` without
loading anything, which reports success for work that did not happen.

Three ways out were available: infer the directory, take it from the browser,
or make the operation name the workspace it belongs to.

## Decision

**A workspace reference in the protocol is an opaque id and never a path.** The
host holds the mapping from id to canonical directory. The id carries no
structure a caller can exploit and no information about the machine: it is not
a path, not an encoding of one, and not a hash of one. This applies to every
direction of the protocol, including projections and review records.

**Every agent call that needs a directory resolves it host-side, at the moment
of use.** The host looks the id up in the enrolment index, revalidates that the
directory still exists and is still the one that was enrolled, and passes the
canonical path to the agent. A reference that no longer resolves is refused;
it is never coerced into a nearby path or a default.

**`LoadSession` carries the workspace id alongside the session id.** The
operation becomes:

```json
{ "kind": "loadSession", "workspaceId": "<opaque>", "sessionId": "<agent id>" }
```

The host resolves `workspaceId` to a directory and calls `session/load` with
that `cwd`. A session id whose workspace is not enrolled is refused, which
means resuming a session requires the user to still hold the directory it ran
in. That is the intended behaviour: revocation must actually withdraw access
(the enrolment is the grant), and a resumed session that reached a directory
the user had given up would be a way around it.

**The change lands inside `light.local.v1` rather than bumping the version.**
`AGENTS.md` requires versioning, compatibility tests, and an ADR for breaking
protocol changes, and the reason is to avoid breaking consumers. Light has no
consumers: it is unreleased, packaging is Phase 8, and the SPA is served by the
host binary that answers it, so the two cannot be separately installed. `v1` is
still being drafted, and the WebSocket subprotocol is `light.local.v1`; shipping
a first release that speaks `protocolVersion: 2` inside a `v1` family would be a
permanent inconsistency bought for no compatibility benefit. Once Light is
released, this operation's shape is frozen and any further change bumps.

The compatibility tests are still required and still exist. They pin that a
load carrying no workspace does not deserialise into a usable command, so the
shape cannot drift back, and that a version the host does not speak is refused
on version alone.

**Version is checked before the body is understood.** An operation whose shape
changed will not deserialise under the older version, so a version checked
afterwards never runs: the host would answer a stale client with a malformed
request error and leave the user nothing to act on. The host therefore reads
`protocolVersion` from the raw body first and answers `409` with
`unsupported_protocol_version`, which the SPA renders as a reload.

**The picker follows from this rule rather than restating it.** The host owns
the dialog, chooses its title, filter, and modality, and the browser may ask
for it but learns only the resulting opaque id. Portal URIs are parsed and
constrained by the host because they arrive from another process.

## Consequences

- The browser cannot name a directory, so a crafted command body cannot point
  the agent anywhere. The reachable set is exactly the enrolment set.
- Resuming a session is bounded by the enrolments that exist now, not by the
  ones that existed when the session was created. Sessions in a revoked
  workspace are not resumable, and the interface must say why rather than
  showing an empty list.
- The mapping is host state, so it must be durable and is subject to the same
  fail-closed reads as the rest: an index that cannot be read stops the host
  rather than silently exposing no workspaces or the wrong ones.
- Light cannot offer "open recent directory" from the browser without an
  enrolment behind it, which is a deliberate loss of convenience.
- The two code comments citing ADR light 0006 for this rule are corrected to
  cite this one.

## Rejected alternatives

**Infer the directory for `LoadSession`.** Using the sole enrolment, or the
most recent one, would be guessing. It would silently succeed with the wrong
directory whenever the guess was wrong, and the failure mode is an agent
working in a directory the user did not intend — the exact outcome the opaque
id exists to prevent.

**Accept a `cwd` from the browser for `LoadSession` only.** A single exception
is the whole hole: the rule is only worth having if it has no case where a path
crosses the boundary. It would also be the easiest thing to reach from a
malicious page, since it takes a path directly.

**Ask the agent which directory the session used.** This inverts the trust
direction. The agent's answer is untrusted input, and using it to choose where
the agent may then work would let a compromised or confused agent select its
own workspace.

**Leave `LoadSession` acknowledging without loading.** Reporting success for
work that did not happen is worse than refusing, because the user believes a
session was resumed and acts on a transcript that was never restored.
