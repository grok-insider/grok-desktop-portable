/**
 * Stage FPS control with a real Stage instance when WebGL is available;
 * otherwise verifies resolver+Stage API surface via constructor option path.
 *
 * Uses jsdom canvas; WebGL may fail — then we still assert pure FPS resolution
 * and that PRESET data used by Stage is not clamped to 60.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  PRESET_BENCH_120,
  PRESET_BENCH_144,
  PRESET_BENCH_UNCAPPED,
  PRESET_LEGACY,
  PRESET_PRODUCT_BALANCED,
  resolveConfiguredFpsCap,
} from "@aether/studio";

describe("Stage FPS ladder (shipped presets + resolver)", () => {
  const canvases: HTMLCanvasElement[] = [];

  afterEach(() => {
    for (const c of canvases) c.remove();
    canvases.length = 0;
  });

  it("resolveConfiguredFpsCap allows 120, 144, and uncapped", () => {
    expect(resolveConfiguredFpsCap(PRESET_BENCH_120, false)).toBe(120);
    expect(resolveConfiguredFpsCap(PRESET_BENCH_144, false)).toBe(144);
    expect(resolveConfiguredFpsCap(PRESET_BENCH_UNCAPPED, false)).toBeNull();
    // Override path used by setMaxFps
    expect(resolveConfiguredFpsCap(PRESET_PRODUCT_BALANCED, false, 144)).toBe(
      144,
    );
    expect(resolveConfiguredFpsCap(PRESET_LEGACY, true, 200)).toBe(200);
  });

  it("creates Stage with product-balanced defaults when WebGL works", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    canvases.push(canvas);

    // Mock minimal WebGL so three.js may construct (best-effort)
    const gl = canvas.getContext("webgl") || canvas.getContext("webgl2");
    if (!gl) {
      // Environment has no WebGL — still prove the shipped cap math
      expect(resolveConfiguredFpsCap(PRESET_PRODUCT_BALANCED, false)).toBe(60);
      expect(resolveConfiguredFpsCap(PRESET_LEGACY, false)).toBe(24);
      return;
    }

    const { Stage } = await import("@aether/studio");
    const stage = new Stage(canvas, {
      width: 64,
      height: 64,
      qualityPreset: "product-balanced",
    });
    try {
      expect(stage.getQualityPresetId()).toBe("product-balanced");
      expect(stage.getLightingProfileId()).toBe("vroid-hub-ani");
      expect(stage.getConfiguredFpsCap()).toBe(60);

      expect(stage.applyPreset("bench-120")).toBe(true);
      expect(stage.getConfiguredFpsCap()).toBe(120);

      expect(stage.applyPreset("bench-144")).toBe(true);
      expect(stage.getConfiguredFpsCap()).toBe(144);

      expect(stage.applyPreset("bench-uncapped-360")).toBe(true);
      expect(stage.getConfiguredFpsCap()).toBeNull();

      stage.setMaxFps(200);
      expect(stage.getConfiguredFpsCap()).toBe(200);

      stage.setUncapped();
      expect(stage.getConfiguredFpsCap()).toBeNull();

      // Lighting apply mutates intensity vs legacy
      const before = stage.getLightSnapshot();
      expect(stage.applyLightingProfile("legacy")).toBe(true);
      const legacy = stage.getLightSnapshot();
      expect(stage.applyLightingProfile("vroid-hub-ani")).toBe(true);
      const hub = stage.getLightSnapshot();
      expect(hub.key.intensity).not.toBe(legacy.key.intensity);
      expect(hub.fill.intensity).not.toBe(legacy.fill.intensity);
      // product default profile is Hub
      expect(stage.getLightingProfileId()).toBe("vroid-hub-ani");
      expect(stage.getExposure()).toBeCloseTo(1.05, 2);
      // before was Hub from product-balanced
      expect(before.key.intensity).toBeCloseTo(hub.key.intensity, 5);

      const scenarios = stage.listScenarios();
      expect(scenarios.length).toBeGreaterThanOrEqual(3);
    } finally {
      stage.dispose();
    }
  });
});
