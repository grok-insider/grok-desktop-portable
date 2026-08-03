# ADR light 0019: User side chats as parent-scoped sessions

## Status

Accepted

## Context

Cursor-style **Side Chats** let a user select a fragment of a primary
conversation, anchor it as context, and open a parallel agent thread in a
dock without polluting the parent transcript or the home rail.

Portable already has:

- concurrent ACP sessions on one agent process ([ADR 0011](0011-concurrent-agent-sessions.md));
- parent-scoped **members** for agent-spawned subagents ([ADR 0017](0017-session-membership-and-runtime-hierarchy.md));
- host-derived catalog from GROK_HOME ([ADR 0010](0010-session-catalog-from-grok-home.md)).

Subagents are agent-owned (`session_kind` ~ `subagent*`, `parent_session_id` on
disk). User side chats are **user-owned**, selection-driven, and must not appear
as home-rail peers. The qualified CLI has no stable `side_chat` kind today.

## Decision

1. **A side chat is a real ACP session** created with `session/new` in the
   parent’s enrolled workspace. Tools, permissions, queue, cancel, model, repair,
   and events reuse the existing per-`sessionId` surface. There is no second
   transcript pipeline and no multiplex onto the parent session.

2. **Host session-graph overlay.** Durable edges live in the bridge state
   directory (`session_graph.json`), not as a second transcript store:
   `childSessionId → { parentSessionId, role: side_chat, title, clips[], createdAtMs }`.
   Transcripts remain in GROK_HOME. If the CLI later writes
   `session_kind: side_chat` + parent, the overlay becomes a cache; the wire
   contract does not change.

3. **Visibility.** `ListSessions` / home rail omit ids present as side-chat
   children in the overlay (in addition to ADR 0017 `is_hidden`). WorkShell
   tabs list **primary** open sessions only. Side chats appear only under the
   open parent (dock / snapshot).

4. **Context clips.** Optional bounded text anchors (selection from the parent
   transcript). The browser sends clip text (and optional source message seq);
   the **host** injects a stable wrapper when dispatching `prompt` / `sendNow`
   on a side session. The SPA never invents filesystem paths.

5. **Lifecycle.** `createSideChat` requires an open parent. Closing a side
   removes its live entry (edge retained until purged or parent cascade).
   Closing a **parent** cascades close of live side children so they do not
   orphan `MAX_LIVE_SESSIONS` budget. Bounds: sides count toward
   `MAX_LIVE_SESSIONS` and `MAX_SIDE_CHATS_PER_PARENT`.

6. **Deep links.** A child id must not present as a top-level chat: open/load
   the parent and focus the side (same rule as ADR 0017 members).

## Consequences

- Product can ship independent parallel turns (parent + side) on one agent.
- Catalog filtering couples to host overlay as well as GROK_HOME summaries.
- SPA must filter shell tabs by role and mount a parent-scoped dock (UI PRs).
- Permission dialogs must label which session raised the request (already
  session-scoped; titles improve clarity).

## Alternatives considered

- **SPA-only side panel on the parent sessionId.** No parallel turns; context
  and permissions bleed; fails product goal.
- **CLI `spawn_subagent`.** Agent-owned lifecycle; wrong ownership and no
  user selection model.
- **Promote CLI `fork` as side chat.** Forks are primary in ADR 0010 visibility.
- **Second transcript store in the bridge.** Conflicts with ADR 0010; overlays
  edges only.
