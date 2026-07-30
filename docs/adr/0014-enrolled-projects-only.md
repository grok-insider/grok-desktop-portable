# ADR light 0014: The project rail lists only projects opened in Light

## Status

Accepted. Supersedes the discovery half of
[light ADR 0012](0012-project-catalog-from-session-groups.md).

## Context

ADR 0012 made the rail an OpenCode-style catalog: every directory with Grok
conversations under `$GROK_HOME/sessions/` appeared, whether or not the user
had ever used it in Light. In practice a developer's Grok home accumulates one
directory per experiment, subagent scratch dir, and `cd`-and-try, so the rail
became a thirty-row inventory in which the two projects the user actually works
in were indistinguishable from the twenty-eight they do not. Search does not fix
a list whose default state is wrong; it asks the user to retype what they
already chose once.

There is a disclosure cost too. Light's `displayName` is a basename, not a path
(ADR 0009), but the *set* of basenames is itself information about the user's
machine, and the browser was receiving all of it to render two useful rows.
Handing the browser only the projects it needs is strictly less to protect.

This does not change what Light *can* open. Every directory reachable before is
still reachable — through the host picker or `grok-light workspace add` — and
the CLI's own session store is still what supplies session history for the
projects that are listed.

## Decision

1. **The enrolment set is the list.** `SessionState::project_projects` iterates
   `workspaces.json` and projects one row per enrolled workspace. A directory
   the user only ever opened in the Grok Build CLI or TUI is not projected, and
   its display name does not reach the browser.
2. **The session store is an attribute lookup, not a source.** `sessionCount`
   and `lastActiveAt` still come from `$GROK_HOME/sessions/*` (ADR 0010
   encoding), joined to enrolled rows by canonical path. An enrolled directory
   with no session history is still projected, with a zero count, so
   Add → Open works before the first conversation exists.
3. **`workspaceId` is always present** on `ProjectProjection`. The browser's
   only row action is `listSessions` / `createSession` against that id.
4. **The display label is the enrolment's**, not the scanner's, because it is
   what the user saw when they chose the directory. Scanner-side basename
   disambiguation no longer applies to the rail.
5. **An enrolled directory that has gone away stays listed**, marked
   unavailable and non-selectable. Dropping the row would silently discard a
   choice the user made and leave nothing to revoke.
6. **`openProject { projectId }` is retained in the protocol** but is no longer
   reachable from the browser, which can never hold an unenrolled project id.
   Removing it is a separate protocol decision.

Unchanged from ADR 0012: opaque `projectId` (`proj-` + hex of the host path),
no paths on the wire, `MAX_PROJECTS` / `MAX_WORKSPACES` bounds, and sort by
last activity descending then display name.

## Consequences

- Opening a folder for the first time now always costs one explicit enrolment
  (picker or CLI). That is the point: enrolment is what "opened in Light" means,
  and the rail is a record of decisions rather than of filesystem residue.
- The rail's size is bounded by user intent rather than by `$GROK_HOME`, so
  `MAX_PROJECTS` truncation stops being reachable in normal use.
- `projects` and `workspaces` in the workspaces outcome now describe the same
  set. They are kept distinct because `projects` carries session-store activity
  the enrolment index does not hold; collapsing them is a later cleanup.
- Users who relied on ADR 0012's zero-step access to CLI-only folders lose it.
  The `grok-light workspace add <path>` hint stays on the empty state for that
  reason.

## Alternatives considered

- **Filter in the renderer.** Simplest, but the host would still ship every
  basename in `$GROK_HOME` to the browser to have it discarded. Rejected.
- **A "recent in CLI" secondary section.** Keeps discovery while fixing the
  ordering complaint, but reintroduces the full disclosure and doubles the
  rail's concepts for a one-time action. Rejected; revisit if enrolment
  friction is reported.
- **Auto-enrol on first render.** Mutates durable state without user intent and
  hits the workspace cap — already rejected by ADR 0012 and still rejected.
