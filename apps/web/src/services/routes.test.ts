import { afterEach, describe, expect, it } from "vitest";
import { parsePath, pathBase, pathFor } from "./routes";

afterEach(() => {
  document.head.querySelectorAll('meta[name="grok-path-base"]').forEach((n) => n.remove());
});

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

  it("strips hosted demo base from paths", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "grok-path-base");
    meta.setAttribute("content", "/demo");
    document.head.appendChild(meta);
    expect(pathBase()).toBe("/demo");
    expect(parsePath("/demo")).toEqual({ kind: "home" });
    expect(parsePath("/demo/")).toEqual({ kind: "home" });
    expect(parsePath("/demo/setup")).toEqual({ kind: "setup" });
    expect(parsePath("/demo/s/abc-123")).toEqual({
      kind: "session",
      sessionId: "abc-123",
    });
  });
});

describe("pathFor", () => {
  it("round-trips session routes at product root", () => {
    const route = { kind: "session" as const, sessionId: "s-1" };
    expect(parsePath(pathFor(route))).toEqual(route);
    expect(pathFor(route)).toBe("/s/s-1");
  });

  it("prefixes demo base when meta is set", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "grok-path-base");
    meta.setAttribute("content", "/demo");
    document.head.appendChild(meta);
    expect(pathFor({ kind: "home" })).toBe("/demo/");
    expect(pathFor({ kind: "setup" })).toBe("/demo/setup");
    const route = { kind: "session" as const, sessionId: "s-1" };
    expect(pathFor(route)).toBe("/demo/s/s-1");
    expect(parsePath(pathFor(route))).toEqual(route);
  });
});
