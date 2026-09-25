# ADR light 0017: Session membership and runtime hierarchy

## Status

Accepted (catalog visibility landed; live/rehydrate parent surfaces follow)

## Context

Grok Build persists every agent turn as a session under
`$GROK_HOME/sessions/<encoded-cwd>/<id>/`. Workflow and `spawn_subagent` runs
create **child sessions** with `session_kind` values such as `subagent`,
`subagent_fork`, and `subagent_resume`, often linked by `parent_session_id` and
`parent/subagents/<child-id>/meta.json`.

The CLI resume picker excludes those rows via `Summary::is_hidden` (explicit
`hidden`, else `session_kind` starting with `subagent`). Portable’s early
catalog listed every directory with a `summary.json`, so one `/deep-research`
appeared as nine peer chats. Live workflow progress used `_x.ai/session/update`
kinds the bridge dropped entirely.

Product intent: the browser should treat nested agents as **members of a
parent conversation**, not as independent home-rail chats, while still using
the same GROK_HOME store (ADR 0010).

## Decision

1. **Session graph on the host.** For each enrolled cwd, the bridge builds a
   host-only graph from `summary.json` (+ `subagents/` edges). Nodes carry
   kind, explicit hidden, parent id, and a visibility class:
   - **Primary** — `ListSessions` / home rail
   - **Member** — hidden by CLI rules and parented; shown only under that parent
   - **Hidden** — hidden without a known parent; omitted from SPA v1 surfaces
2. **Visibility contract.** Match Grok Build `Summary::is_hidden` exactly.
   Forks and worktrees remain primary. Contract tests pin kinds.
3. **Primary list projection.** Wire rows may include `kind` and `memberCount`
   (additive). No child transcripts or paths in list responses.
4. **Parent is the routing key** for live hierarchy events. Child spawn does
   not open a browser tab. Future `WorkflowUpdated` / `SubagentUpdated` events
   attach to the parent `sessionId`.
5. **Parent-scoped rehydrate (follow-on).** Opening a primary session may attach
   bounded `members` and `workflows` to `sessionSnapshot` (opaque ids, truncated
   titles/objectives, no filesystem paths). Member transcript inspector is
   optional and read-only.
6. **No second store.** Membership is derived from GROK_HOME; Portable does not
   invent a parallel session index.

## Consequences

- Home rail stays scannable after multi-agent workflows.
- Listing is coupled to CLI summary fields; version skew with Grok Build must
  be watched.
- Full CLI workflow UX (phase rail, pause/resume) still needs projection of
  allowlisted `_x.ai/*` updates and SPA panels; this ADR defines the membership
  model those surfaces hang on.
- Deep links to a member session id must not present the child as a top-level
  chat (open parent or show an explicit nested-agent state).

## Alternatives considered

- **Hard-code `session_kind == "subagent"` filter only.** Breaks on
  `subagent_*` variants and explicit `hidden`; does not model membership.
- **`x.ai/session/list` over stdio for the whole catalog.** Matches TUI but is
  non-ACP and needs version gates; still deferred (ADR 0010). Disk graph with
  the same visibility fields is enough for membership.
- **Delete child session directories.** Destroys CLI resume/debug data; out of scope.
