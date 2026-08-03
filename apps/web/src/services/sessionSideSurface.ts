/**
 * Exactly one secondary surface in the Work session chrome.
 *
 * Review and runtime detail share the right rail; mutual exclusion is
 * structural (this enum), not two booleans. Future workflow/member detail
 * can add kinds without a second layout model.
 */

export type SessionSideSurface =
  | { kind: "none" }
  | { kind: "review" }
  | { kind: "taskDetail"; taskId: string };

export const SIDE_SURFACE_NONE: SessionSideSurface = { kind: "none" };
export const SIDE_SURFACE_REVIEW: SessionSideSurface = { kind: "review" };

export function isReviewOpen(surface: SessionSideSurface): boolean {
  return surface.kind === "review";
}

export function isTaskDetailOpen(
  surface: SessionSideSurface,
): surface is { kind: "taskDetail"; taskId: string } {
  return surface.kind === "taskDetail";
}

export function toggleReview(current: SessionSideSurface): SessionSideSurface {
  return current.kind === "review" ? SIDE_SURFACE_NONE : SIDE_SURFACE_REVIEW;
}

export function toggleTaskDetail(
  current: SessionSideSurface,
  taskId: string,
): SessionSideSurface {
  if (current.kind === "taskDetail" && current.taskId === taskId) {
    return SIDE_SURFACE_NONE;
  }
  return { kind: "taskDetail", taskId };
}
