import { describe, expect, it } from "vitest";
import type { SessionProjection } from "./outcomes";
import {
  clipChipLabel,
  isSideChatSession,
  pickPrimarySessionId,
  primaryOpenSessions,
  resolvePrimarySessionId,
  shouldClearSideFocus,
  sideChatTitle,
  sideChatsForParent,
  visiblePermissionSessionId,
} from "./sideChat";

function session(
  partial: Partial<SessionProjection> & { sessionId: string },
): SessionProjection {
  return {
    workspaceId: "w-1",
    workspaceName: "Demo",
    running: false,
    openedAtMs: 1,
    ...partial,
  };
}

describe("sideChat helpers", () => {
  const primary = session({ sessionId: "p-1" });
  const sideA = session({
    sessionId: "s-a",
    role: "side_chat",
    parentSessionId: "p-1",
    title: "Data on personas",
    clips: [{ clipId: "c1", text: "cohorts and job roles", label: "cohorts" }],
  });
  const sideB = session({
    sessionId: "s-b",
    role: "side_chat",
    parentSessionId: "p-1",
  });
  const otherPrimary = session({ sessionId: "p-2" });
  const orphanSide = session({
    sessionId: "s-x",
    role: "side_chat",
    parentSessionId: "p-2",
  });

  it("detects side chat role", () => {
    expect(isSideChatSession(primary)).toBe(false);
    expect(isSideChatSession(sideA)).toBe(true);
  });

  it("filters primary open sessions for shell tabs", () => {
    const open = [primary, sideA, otherPrimary, sideB, orphanSide];
    expect(primaryOpenSessions(open).map((s) => s.sessionId)).toEqual([
      "p-1",
      "p-2",
    ]);
  });

  it("lists side chats under one parent only", () => {
    const open = [primary, sideA, otherPrimary, sideB, orphanSide];
    expect(sideChatsForParent(open, "p-1").map((s) => s.sessionId)).toEqual([
      "s-a",
      "s-b",
    ]);
    expect(sideChatsForParent(open, "p-2").map((s) => s.sessionId)).toEqual([
      "s-x",
    ]);
  });

  it("titles from title, then clip label, then text", () => {
    expect(sideChatTitle(sideA)).toBe("Data on personas");
    expect(
      sideChatTitle(
        session({
          sessionId: "x",
          role: "side_chat",
          parentSessionId: "p",
          clips: [{ clipId: "1", text: "hello world", label: "hello" }],
        }),
      ),
    ).toBe("hello");
    expect(
      sideChatTitle(
        session({
          sessionId: "y",
          role: "side_chat",
          parentSessionId: "p",
          clips: [{ clipId: "1", text: "only text" }],
        }),
      ),
    ).toBe("only text");
    expect(
      sideChatTitle(
        session({ sessionId: "z", role: "side_chat", parentSessionId: "p" }),
      ),
    ).toBe("Side chat");
  });

  it("clip chips prefer label", () => {
    expect(clipChipLabel({ clipId: "1", text: "long", label: "short" })).toBe(
      "short",
    );
  });

  it("resolves side ids to parent for shell routing", () => {
    const open = [primary, sideA, otherPrimary];
    expect(resolvePrimarySessionId(open, "s-a")).toBe("p-1");
    expect(resolvePrimarySessionId(open, "p-1")).toBe("p-1");
    expect(resolvePrimarySessionId(open, "unknown")).toBe("unknown");
  });

  it("never picks a side chat as the shell primary after refresh", () => {
    const open = [primary, sideA, otherPrimary, sideB];
    // Newest open often is a side; must still pick a primary.
    expect(pickPrimarySessionId(open, null)).toBe("p-2");
    expect(pickPrimarySessionId(open, "s-a")).toBe("p-1");
    expect(pickPrimarySessionId(open, "p-1")).toBe("p-1");
    expect(pickPrimarySessionId([sideA, sideB], null)).toBeNull();
  });

  it("surfaces side permission session ids while parent is on screen", () => {
    expect(
      visiblePermissionSessionId(
        ["s-a"],
        "p-1",
        null,
        ["s-a", "s-b"],
      ),
    ).toBe("s-a");
    expect(
      visiblePermissionSessionId(
        ["s-a", "p-1"],
        "p-1",
        "s-a",
        ["s-a"],
      ),
    ).toBe("s-a");
    expect(
      visiblePermissionSessionId(["p-1"], "p-1", "s-a", ["s-a"]),
    ).toBe("p-1");
    expect(
      visiblePermissionSessionId(["other"], "p-1", null, ["s-a"]),
    ).toBeNull();
  });

  it("does not clear dock focus for a side not yet in openSessions", () => {
    // createSideChat just set active id; refresh has not merged yet.
    expect(
      shouldClearSideFocus("s-new", "p-1", [primary], new Set()),
    ).toBe(false);
    // Known then closed → clear.
    expect(
      shouldClearSideFocus(
        "s-a",
        "p-1",
        [primary],
        new Set(["s-a"]),
      ),
    ).toBe(true);
    // Still open → keep.
    expect(
      shouldClearSideFocus(
        "s-a",
        "p-1",
        [primary, sideA],
        new Set(["s-a"]),
      ),
    ).toBe(false);
  });
});
