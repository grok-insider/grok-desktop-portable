import { describe, expect, it } from "vitest";
import { parsePath, pathFor } from "./routes";

describe("parsePath", () => {
  it("maps root to home", () => {
    expect(parsePath("/")).toEqual({ kind: "home" });
    expect(parsePath("")).toEqual({ kind: "home" });
  });

  it("maps /s/:id to a session route", () => {
    expect(parsePath("/s/abc-123")).toEqual({
      kind: "session",
      sessionId: "abc-123",
    });
  });

  it("rejects path-like session ids", () => {
    // Opaque ids only — a smuggled path is treated as unknown → home.
    expect(parsePath("/s/../etc")).toEqual({ kind: "home" });
    expect(parsePath("/s/a/b")).toEqual({ kind: "home" });
  });
});

describe("pathFor", () => {
  it("round-trips session routes", () => {
    const route = { kind: "session" as const, sessionId: "s-1" };
    expect(parsePath(pathFor(route))).toEqual(route);
  });
});
