/**
 * Side-chat membership helpers (light ADR 0019).
 *
 * Pure filters so WorkShell tabs stay primary-only and the dock lists children
 * of the open parent. Never invents paths.
 */

import type { SessionProjection, SideChatClip } from "./outcomes";

/** Whether a projected open session is a user side chat. */
export function isSideChatSession(session: SessionProjection): boolean {
  return session.role === "side_chat";
}

/** WorkShell / home-rail peers: open sessions that are not side chats. */
export function primaryOpenSessions(
  sessions: readonly SessionProjection[],
): SessionProjection[] {
  return sessions.filter((session) => !isSideChatSession(session));
}

/** Side chats belonging to a parent primary (oldest first). */
export function sideChatsForParent(
  sessions: readonly SessionProjection[],
  parentSessionId: string,
): SessionProjection[] {
  return sessions.filter(
    (session) =>
      isSideChatSession(session) && session.parentSessionId === parentSessionId,
  );
}

/** Display title for a side tab. */
export function sideChatTitle(session: SessionProjection): string {
  if (session.title && session.title.trim().length > 0) {
    return session.title.trim();
  }
  const firstClip = session.clips?.[0];
  if (firstClip?.label && firstClip.label.trim().length > 0) {
    return firstClip.label.trim();
  }
  if (firstClip?.text) {
    const line = firstClip.text.split("\n")[0]?.trim() ?? "";
    return line.length > 48 ? `${line.slice(0, 48)}…` : line || "Side chat";
  }
  return "Side chat";
}

/** Chip label for a clip in the side composer. */
export function clipChipLabel(clip: SideChatClip): string {
  if (clip.label && clip.label.trim().length > 0) {
    return clip.label.trim();
  }
  const line = clip.text.split("\n")[0]?.trim() ?? "";
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "Clip";
}

/**
 * Resolve which session id owns a shell tab click.
 *
 * Side chat ids must not become primary URL sessions without their parent;
 * returns parent if the id is a side child, otherwise the id itself when primary.
 */
export function resolvePrimarySessionId(
  sessions: readonly SessionProjection[],
  sessionId: string,
): string {
  const hit = sessions.find((session) => session.sessionId === sessionId);
  if (hit !== undefined && isSideChatSession(hit) && hit.parentSessionId) {
    return hit.parentSessionId;
  }
  return sessionId;
}

/**
 * Pick which open session should be the shell primary after a host refresh.
 *
 * Never promotes a side_chat to the main surface. Prefer keeping `current` when
 * it is still live (resolving side → parent); otherwise the newest primary.
 */
export function pickPrimarySessionId(
  sessions: readonly SessionProjection[],
  current: string | null,
): string | null {
  const primaries = primaryOpenSessions(sessions);
  if (current !== null) {
    const hit = sessions.find((session) => session.sessionId === current);
    if (hit !== undefined) {
      if (isSideChatSession(hit) && hit.parentSessionId) {
        // Parent must still be open; otherwise fall through.
        if (primaries.some((p) => p.sessionId === hit.parentSessionId)) {
          return hit.parentSessionId;
        }
      } else if (primaries.some((p) => p.sessionId === current)) {
        return current;
      }
    }
  }
  return primaries.at(-1)?.sessionId ?? null;
}

/**
 * Whether the still-open effect should clear dock focus.
 *
 * Only clear when the side was previously confirmed open under the parent and
 * has since disappeared — never when it was just created and has not yet
 * appeared in `openSessions` (create → setActive → refresh race).
 */
export function shouldClearSideFocus(
  activeSideSessionId: string | null,
  parentSessionId: string | null,
  openSessions: readonly SessionProjection[],
  previouslyKnownSideIds: ReadonlySet<string>,
): boolean {
  if (activeSideSessionId === null || parentSessionId === null) {
    return false;
  }
  const stillOpen = openSessions.some(
    (session) =>
      session.sessionId === activeSideSessionId &&
      isSideChatSession(session) &&
      session.parentSessionId === parentSessionId,
  );
  if (stillOpen) {
    return false;
  }
  // Not in open list: only clear if we had already seen this id under the parent.
  return previouslyKnownSideIds.has(activeSideSessionId);
}

/**
 * Permission prompt visible for the open primary surface.
 *
 * Prefers the active side chat when it has a pending request, then the
 * primary, then any side under that parent (so a child request is never
 * silent while the parent is on screen).
 */
export function visiblePermissionSessionId(
  promptSessionIds: readonly string[],
  primarySessionId: string | null,
  activeSideSessionId: string | null,
  sideSessionIdsUnderParent: readonly string[],
): string | null {
  const pending = new Set(promptSessionIds);
  if (
    activeSideSessionId !== null &&
    pending.has(activeSideSessionId)
  ) {
    return activeSideSessionId;
  }
  if (primarySessionId !== null && pending.has(primarySessionId)) {
    return primarySessionId;
  }
  for (const sideId of sideSessionIdsUnderParent) {
    if (pending.has(sideId)) {
      return sideId;
    }
  }
  return null;
}
