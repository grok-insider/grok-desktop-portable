# ADR light 0012: Project catalog from Grok session groups

## Status

Superseded in part by
[light ADR 0014](0014-enrolled-projects-only.md).

Decision 1 (discover every session group) and decision 3's browser-initiated
`openProject` are withdrawn: the rail lists only projects enrolled in Light,
and the session store supplies activity for those rows rather than the rows
themselves. Decision 2 (opaque `projectId`, display label, no paths on the
wire), decision 4 (integrations off the picker) and decision 5 (bounds and
sort) still hold.

## Context

Light ADR 0010 lists sessions for **one enrolled workspace** by reading
`$GROK_HOME/sessions/<url-encoded-cwd>/`. The workspace picker only showed
directories the user had already enrolled in Light, so folders used only in the
CLI / TUI were invisible. Product direction is an OpenCode-style project list:
every directory that already has Grok conversations should appear, without the
browser ever typing a path (ADR 0009).

MCP integrations were also shown above the picker as honesty about user config
(ADR 0004). That strip competed with project selection; tooling belongs after a
project is chosen, not as hero chrome.

## Decision

1. **Discover** project groups on the host by listing
   `$GROK_HOME/sessions/*` directory names, decoding them with the inverse of
   ADR 0010 encoding, and projecting only rows whose path still is a directory
   and that contain at least one session (or are already enrolled).
2. **Project** `{ projectId, displayName, sessionCount, lastActiveAt,
   available, workspaceId? }`. `projectId` is an opaque hash of the host path
   (`proj-` + hex). `displayName` is the path basename (parent segment only to
   disambiguate collisions). **Never** a full filesystem path on the wire.
3. **Open** via `openProject { projectId }`: host resolves the id to a
   host-known path, enrols it in the durable workspace index if needed, and
   returns the usual workspaces projection. The browser then uses the enrolled
   `workspaceId` for `listSessions` / `createSession` as today.
4. **Integrations** remain host-projected for later scoped UI, but are **not**
   required on the project picker surface.
5. **Bounds:** `MAX_PROJECTS` (list), `MAX_WORKSPACES` (enrolment). Sort by
   last activity descending.

## Consequences

- Light can open any folder the user already worked in with Grok without a
  second manual enrol step for common cases.
- Coupling to session group encoding grows (same as ADR 0010).
- Users with many groups get a capped list plus search; rare dirs can still be
  added via the host picker / `grok-light workspace add`.

## Alternatives considered

- **Auto-enrol everything on Bootstrap.** Mutates durable state aggressively
  and hits the workspace cap without user intent. Rejected.
- **Browser lists decoded paths.** Forbidden by ADR 0009.
- **ACP `session/list` only.** Still not implemented on the qualified CLI
  (`-32601`); host disk catalog remains the source.
