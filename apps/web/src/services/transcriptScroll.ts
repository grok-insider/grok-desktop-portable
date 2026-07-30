/**
 * Pure helpers for hybrid transcript scroll (pin-to-bottom + per-session memory).
 *
 * The view owns the DOM; this module only answers “are we stuck?” and how to
 * store restore points so session switches do not yank the reader around.
 */

/** Distance from the bottom (px) that still counts as “following the end”. */
export const STUCK_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Saved scroll position for one conversation in this tab. */
export interface SessionScrollMemory {
  scrollTop: number;
  stuckToBottom: boolean;
}

/** True when the viewport is at (or within the threshold of) the end. */
export function isStuckToBottom(
  metrics: ScrollMetrics,
  thresholdPx: number = STUCK_THRESHOLD_PX,
): boolean {
  const room = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return room <= thresholdPx;
}

/** Snapshot the live scroller for later restore. */
export function captureScrollMemory(
  metrics: ScrollMetrics,
  thresholdPx: number = STUCK_THRESHOLD_PX,
): SessionScrollMemory {
  return {
    scrollTop: metrics.scrollTop,
    stuckToBottom: isStuckToBottom(metrics, thresholdPx),
  };
}

/**
 * Choose the scrollTop to apply when re-entering a conversation.
 *
 * First visit (no memory) → stick to the end. Saved stuck → end. Otherwise
 * restore the exact offset the user left.
 */
export function restoreScrollTop(
  memory: SessionScrollMemory | undefined,
  metrics: Pick<ScrollMetrics, "scrollHeight" | "clientHeight">,
): { scrollTop: number; stuckToBottom: boolean } {
  if (memory === undefined || memory.stuckToBottom) {
    return {
      scrollTop: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
      stuckToBottom: true,
    };
  }
  const maxTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return {
    scrollTop: Math.min(Math.max(0, memory.scrollTop), maxTop),
    stuckToBottom: false,
  };
}
