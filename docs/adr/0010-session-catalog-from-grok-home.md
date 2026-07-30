# ADR light 0010: Session catalog from the user's Grok home

## Status

Accepted

## Context

Grok Build persists every conversation under the user's `GROK_HOME` (default
`~/.grok/sessions/<encoded-cwd>/<session-id>/`). The TUI `/resume` picker reads
that store. Light spawns `grok agent --no-leader stdio` against the same home,
so sessions created in Light already appear on disk next to TUI sessions.

ACP `session/list` is not implemented on the qualified CLI (`-32601`). The TUI
uses a proprietary `x.ai/session/list` extension. Light's `ListSessions` cannot
honestly claim to call ACP list.

Product direction for v1 history: show **all** sessions for an enrolled
workspace cwd (CLI and Light), not only sessions Light created.

## Decision

1. **List** sessions by reading, on the host only, `summary.json` files under
   `$GROK_HOME/sessions/<url-encoded-absolute-cwd>/`. Encoding matches Grok
   Build (`/` → `%2F`, unreserved characters unescaped).
2. **Scope** listing to an enrolled workspace id. The host resolves the
   canonical path; the browser never sends a path (ADR 0009).
3. **Project** only metadata: session id, title, timestamps, message count.
   Never transcript bodies, never absolute paths, in list responses.
4. **Resume** uses ACP `session/load` with the enrolled cwd, then **rehydrates**
   the browser transcript by reading `updates.jsonl` on the host
   (`user_message_chunk` / `agent_message_chunk` only; thoughts dropped) and
   emitting `sessionSnapshot` with messages.
5. **Bounds:** list size and rehydrate character total are defined in
   `grok_bridge::bounds`. Corrupt summaries are skipped, not fatal.

## Consequences

- Light history matches the TUI for the same directory without inventing a
  second transcript store.
- Light is coupled to the on-disk layout of Grok sessions. If Grok renames
  `summary.json` or encoding, listing degrades (empty/partial) until updated;
  load via ACP remains the source of session identity.
- `ListSessions` requires `workspaceId` on the wire.
- Rehydrate is best-effort: a missing `updates.jsonl` yields an empty
  transcript after a successful load.

## Alternatives considered

- **Host-only index of Light-created sessions.** Simpler, but fails the product
  goal of seeing CLI chats in Light.
- **`x.ai/session/list` over stdio.** Matches the TUI API but is non-ACP and
  needs fixtures and version gates; deferred.
- **Browser reads `~/.grok`.** Forbidden: path and store stay host-side.
