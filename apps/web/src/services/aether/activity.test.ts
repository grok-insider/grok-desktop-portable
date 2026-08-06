import { describe, expect, it } from "vitest";
import { activityForPhase, phaseFromSearch } from "./activity";

describe("phaseFromSearch", () => {
  it("keeps fallback without query", () => {
    expect(phaseFromSearch("", "idle")).toBe("idle");
    expect(phaseFromSearch("?foo=1", "streaming")).toBe("streaming");
  });

  it("overrides from aetherPhase", () => {
    expect(phaseFromSearch("?aetherPhase=streaming", "idle")).toBe("streaming");
    expect(phaseFromSearch("aetherPhase=interrupted", "idle")).toBe(
      "interrupted",
    );
  });
});

describe("activityForPhase", () => {
  it("idles with mouth closed", () => {
    expect(activityForPhase("idle")).toEqual({ speaking: false, level: 0 });
  });

  it("marks streaming as speaking with mid-range level", () => {
    const a = activityForPhase("streaming", 0);
    expect(a.speaking).toBe(true);
    expect(a.level).toBeGreaterThanOrEqual(0.2);
    expect(a.level).toBeLessThanOrEqual(0.8);
  });

  it("varies streaming level over time", () => {
    const a0 = activityForPhase("streaming", 0);
    const a1 = activityForPhase("streaming", 0.5);
    expect(a0.level).not.toBe(a1.level);
  });

  it("uses low level when interrupted", () => {
    const a = activityForPhase("interrupted");
    expect(a.speaking).toBe(false);
    expect(a.level).toBeGreaterThan(0);
    expect(a.level).toBeLessThan(0.2);
  });
});
