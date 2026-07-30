# ADR light 0011: Concurrent agent sessions on one agent process

- Status: proposed
- Date: 2026-07-29
- Supersedes: the single-session decision in
  [ADR light 0006](0006-local-origin-pairing-and-control-lease.md) §Sessions

## Context

ADR light 0006 decided that one agent session is active at a time and said
concurrency "requires a later ADR". The plan repeats that (§1, normative
decision 8). This is that ADR.

The limit was never a product goal. Work that takes minutes is the normal case
for this product, and a user who must wait for one task before starting another
is being asked to serialise work the machine could overlap. Waiting also makes
the interruption invariant worse: a long turn the user cannot leave is a turn
they are tempted to abandon by closing the tab.

The limit is currently structural, not just a guard. `SessionState` holds one
`Option<String>`; the command envelope carries no `sessionId`, so `Prompt`,
`CancelTurn`, and `CloseSession` address whatever session happens to be open;
events carry no session id either, so a second stream of deltas would be
indistinguishable from the first. Review records have the same gap: the journal
stores no `sessionId`, although `protocol.md` §4 and the plan §7.5 both say a
record carries one.

Whether one agent process can hold concurrent turns was unknown, and the answer
decides the shape. Measured against grok 0.2.112 on one
`grok agent --no-leader stdio` connection: two sessions created, two prompts
sent back to back without waiting. The short turn produced 26 updates and
finished at 1.5s while the long turn was still streaming, ending at 2.5s with
157 updates. Turns interleave; the connection is not a queue.

## Decision

**One agent process hosts every session.** ACP already addresses each method by
`sessionId`, and the qualified CLI honours that concurrently, so a process per
session would buy nothing and cost a stdio pump, a child, and its memory each
time. The host keeps one supervised agent and routes by session id.

**Every session-scoped operation names its session.** `Prompt`, `CancelTurn`,
`CloseSession`, and `DecidePermission` carry a `sessionId`. Ambient addressing
is removed rather than kept as a default, because a default is exactly how a
prompt reaches the wrong workspace once more than one is open.

**Every session-scoped event names its session.** `messageDelta`,
`thoughtDelta`, tool events, `sessionStatus`, and `permissionRequest` carry the
id they belong to. A browser holding several transcripts must be able to route
without guessing, and an event that cannot be attributed is dropped rather than
shown against the wrong conversation.

**Review records name their session.** `interrupted_needs_review` becomes
useless with concurrency if it cannot say which conversation was interrupted.
This closes a gap the documents already assumed was closed.

**Concurrency is bounded.** A maximum number of live sessions is enforced by
the host and stated in `bounds`. The browser may not open more; the refusal is
explicit. Unbounded sessions would let one page exhaust the agent, and every
other boundary in this product is bounded.

**The control lease does not change.** One controlling tab still holds the
lease and may drive every session. Concurrent *sessions* and concurrent
*controllers* are different problems: the second remains out of scope, and
a second tab still watches without acting.

**Permissions stay per session.** A pending request belongs to the session that
raised it and is answered against that session. A decision is never applied to
a request the user was not shown.

## Consequences

- The protocol changes incompatibly. It is versioned with a compatibility test
  per `AGENTS.md`, and the SPA is served by the host, so no deployed client can
  straddle the change.
- The SPA holds one projection per session rather than one flat transcript, and
  its view state stops being "the host's single open session".
- Closing a session no longer means "leave Work"; leaving Work no longer means
  closing a session. They become separate acts, which is what makes a list of
  conversations meaningful.
- A crash now leaves several sessions unresolved rather than one, so the
  restart reconciliation raises one review record per interrupted session.
- The agent process becomes a shared resource. If it dies, every session dies
  with it. That is already true today, but the blast radius grows, so its exit
  must be reported against every live session rather than only the active one.

## Rejected alternatives

**One agent process per session.** Robust in isolation, and the obvious answer
if the measurement had shown a queue. It did not: turns interleave on one
connection. Paying N children, N stdio pumps, and N times the memory to
reimplement what ACP already does would be cost without a benefit.

**`grok agent leader` shared process.** The CLI offers exactly this for
multi-client use, and the TUI's own dashboard reads it. ADR light 0003 rejects
the leader for production because it changes the trust and lifecycle model, and
nothing here needs it: one process already holds concurrent sessions. Adopting
it would be a transport decision, not a concurrency one, and belongs in a
revision of 0003 if ever.

**Keep one session and add a queue.** Serialising in the host would preserve
the current shape and still let the user line work up. It hides the machine's
real capability behind an interface limit, and the measurement shows there is
no technical reason to.
