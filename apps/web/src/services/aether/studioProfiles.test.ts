/**
 * Exercises shipped @aether/studio profile + bench APIs (no WebGL required).
 */
import { describe, expect, it } from "vitest";
import {
  LIGHTING_LEGACY,
  LIGHTING_VROID_HUB_ANI,
  PRESET_BENCH_120,
  PRESET_BENCH_144,
  PRESET_BENCH_UNCAPPED,
  PRESET_LEGACY,
  PRESET_PRODUCT_BALANCED,
  aggregateSamples,
  computeBufferSize,
  getLightingProfile,
  getQualityPreset,
  listBenchScenarios,
  resolveConfiguredFpsCap,
  simulateCappedSamples,
  summarizeNumbers,
} from "@aether/studio";

describe("studio quality presets (shipped)", () => {
  it("does not hard-clamp FPS targets to 60", () => {
    const p120 = getQualityPreset("bench-120");
    const p144 = getQualityPreset("bench-144");
    const pUnc = getQualityPreset("bench-uncapped-360");
    expect(p120).not.toBeNull();
    expect(p144).not.toBeNull();
    expect(pUnc).not.toBeNull();

    expect(resolveConfiguredFpsCap(p120!, false)).toBe(120);
    expect(resolveConfiguredFpsCap(p144!, false)).toBe(144);
    expect(resolveConfiguredFpsCap(pUnc!, false)).toBeNull();

    // Explicit override above 60 must stick (shipped resolver)
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, false, 144)).toBe(144);
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, false, 360)).toBe(360);
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, false, null)).toBeNull();
  });

  it("legacy baseline is 24 idle / 30 speak; product-balanced targets 60", () => {
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, false)).toBe(24);
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, true)).toBe(30);
    expect(resolveConfiguredFpsCap(PRESET_PRODUCT_BALANCED, false)).toBe(60);
    expect(resolveConfiguredFpsCap(PRESET_PRODUCT_BALANCED, true)).toBe(60);
    expect(PRESET_PRODUCT_BALANCED.lightingProfileId).toBe("vroid-hub-ani");
    expect(PRESET_BENCH_120.fpsCap).toBe(120);
    expect(PRESET_BENCH_144.fpsCap).toBe(144);
    expect(PRESET_BENCH_UNCAPPED.fpsMode).toBe("uncapped");
  });

  it("buffer policy respects long-edge and DPR caps", () => {
    const legacy = computeBufferSize(480, 720, 2, 1.25, 720);
    expect(Math.max(legacy.w, legacy.h)).toBeLessThanOrEqual(720);

    const balanced = computeBufferSize(480, 720, 2, 1.75, 1440);
    expect(Math.max(balanced.w, balanced.h)).toBeGreaterThan(
      Math.max(legacy.w, legacy.h),
    );
    expect(Math.max(balanced.w, balanced.h)).toBeLessThanOrEqual(1440);
  });
});

describe("studio Hub lighting profile (shipped)", () => {
  it("vroid-hub-ani differs from legacy lights and exposure", () => {
    const hub = getLightingProfile("vroid-hub-ani");
    const legacy = getLightingProfile("legacy");
    expect(hub).not.toBeNull();
    expect(legacy).not.toBeNull();
    expect(hub!.id).toBe(LIGHTING_VROID_HUB_ANI.id);
    expect(legacy!.id).toBe(LIGHTING_LEGACY.id);

    expect(hub!.exposure).not.toBe(legacy!.exposure);
    expect(hub!.lights.key.intensity).not.toBe(legacy!.lights.key.intensity);
    expect(hub!.lights.fill.intensity).not.toBe(legacy!.lights.fill.intensity);
    expect(hub!.lights.amb.intensity).not.toBe(legacy!.lights.amb.intensity);
    expect(hub!.iblRoom).toBe(true);
    expect(legacy!.iblRoom).toBe(false);
    expect(hub!.lights.key.color.toLowerCase()).not.toBe(
      legacy!.lights.key.color.toLowerCase(),
    );
  });
});

describe("studio scenario bench (shipped)", () => {
  it("lists ≥3 distinct animation scenarios", () => {
    const scenarios = listBenchScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
    const animIds = new Set(
      scenarios.map((s: { animationId: string }) => s.animationId),
    );
    expect(animIds.size).toBeGreaterThanOrEqual(3);
    expect(scenarios.some((s: { id: string }) => s.id === "spin")).toBe(true);
    expect(
      scenarios.some((s: { id: string }) => s.id === "idle-greeting"),
    ).toBe(true);
  });

  it("aggregateSamples returns numeric fps aggregates from real samples", () => {
    const samples = simulateCappedSamples(60, 2);
    expect(samples.length).toBeGreaterThan(10);
    const report = aggregateSamples(samples, {
      scenarioId: "spin",
      label: "Spin",
      presetId: "bench-60",
      lightingProfileId: "vroid-hub-ani",
      configuredFpsCap: 60,
      durationMs: 2000,
      drawCalls: 36,
      triangles: 111000,
      bufferW: 720,
      bufferH: 720,
      clip: "spin",
      webgl: "test",
      animationId: "vrma-05",
    });
    expect(report.scenarioId).toBe("spin");
    expect(report.sampleCount).toBe(samples.length);
    expect(report.fps.p50).toBeGreaterThan(50);
    expect(report.fps.p50).toBeLessThan(70);
    expect(report.fps.mean).toBeGreaterThan(0);
    expect(report.frameMs.p95).toBeGreaterThan(0);
    expect(report.metTarget).toBe(true);
    expect(report.presetId).toBe("bench-60");
  });

  it("uncapped simulation exceeds 60 fps mean", () => {
    const samples = simulateCappedSamples(null, 1);
    const fps = samples.map((s: { wallMs: number }) => 1000 / s.wallMs);
    const stats = summarizeNumbers(fps);
    expect(stats.mean).toBeGreaterThan(60);
  });

  it("legacy vs product-balanced simulated p50 shows ladder improvement", () => {
    const legacy = aggregateSamples(simulateCappedSamples(24, 2), {
      scenarioId: "idle-procedural",
      label: "idle",
      presetId: "legacy",
      lightingProfileId: "legacy",
      configuredFpsCap: 24,
      durationMs: 2000,
      drawCalls: 1,
      triangles: 1,
      bufferW: 720,
      bufferH: 720,
      clip: "idle",
      webgl: "sim",
      animationId: "procedural",
    });
    const after = aggregateSamples(simulateCappedSamples(60, 2), {
      scenarioId: "idle-procedural",
      label: "idle",
      presetId: "product-balanced",
      lightingProfileId: "vroid-hub-ani",
      configuredFpsCap: 60,
      durationMs: 2000,
      drawCalls: 1,
      triangles: 1,
      bufferW: 1440,
      bufferH: 1440,
      clip: "idle",
      webgl: "sim",
      animationId: "procedural",
    });
    expect(after.fps.p50).toBeGreaterThan(legacy.fps.p50 * 2);
  });
});
