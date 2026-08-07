/**
 * Builds baseline (legacy) vs after (product + ladder) reports via shipped APIs.
 * When `AETHER_BENCH_OUT` is set, writes JSON files (node fs at runtime only).
 */
// @ts-nocheck — optional node write path; vitest provides process/fs at runtime
import { describe, expect, it } from "vitest";
import {
  aggregateSamples,
  listBenchScenarios,
  resolveConfiguredFpsCap,
  simulateCappedSamples,
  PRESET_LEGACY,
  PRESET_PRODUCT_BALANCED,
  PRESET_BENCH_60,
  PRESET_BENCH_120,
  PRESET_BENCH_144,
  PRESET_BENCH_UNCAPPED,
  getLightingProfile,
} from "@aether/studio";

function runSuite(
  presetId: string,
  lightingId: string,
  getCap: (speaking: boolean) => number | null,
) {
  const scenarios = listBenchScenarios();
  const reports = scenarios.map((sc) => {
    const speaking = sc.activity === "streaming";
    const cap = getCap(speaking);
    const samples = simulateCappedSamples(cap, sc.seconds);
    return aggregateSamples(samples, {
      scenarioId: sc.id,
      label: sc.label,
      presetId,
      lightingProfileId: lightingId,
      configuredFpsCap: cap,
      durationMs: sc.seconds * 1000,
      drawCalls: 36,
      triangles: 111_000,
      bufferW: presetId === "legacy" ? 720 : 1080,
      bufferH: presetId === "legacy" ? 720 : 1080,
      clip: sc.animationId,
      webgl: "simulated-cap (no GPU in unit env)",
      animationId: sc.animationId,
    });
  });
  return {
    startedAt: new Date().toISOString(),
    hostHint: "simulated-cap via shipped resolveConfiguredFpsCap + simulateCappedSamples",
    mode: "configured-delivery",
    note: "Wall FPS equals configured cap (honest for ladder unlock). Live GPU may be lower; see dogfood if available.",
    lighting: getLightingProfile(lightingId),
    reports,
  };
}

describe("bench export + ladder comparison", () => {
  it("builds baseline (legacy) and after (product + ladder) reports", () => {
    const baseline = runSuite("legacy", "legacy", (speaking) =>
      resolveConfiguredFpsCap(PRESET_LEGACY, speaking),
    );
    const afterProduct = runSuite(
      "product-balanced",
      "vroid-hub-ani",
      (speaking) => resolveConfiguredFpsCap(PRESET_PRODUCT_BALANCED, speaking),
    );
    const ladder = {
      "bench-60": runSuite("bench-60", "vroid-hub-ani", () =>
        resolveConfiguredFpsCap(PRESET_BENCH_60, false),
      ),
      "bench-120": runSuite("bench-120", "vroid-hub-ani", () =>
        resolveConfiguredFpsCap(PRESET_BENCH_120, false),
      ),
      "bench-144": runSuite("bench-144", "vroid-hub-ani", () =>
        resolveConfiguredFpsCap(PRESET_BENCH_144, false),
      ),
      "bench-uncapped-360": runSuite("bench-uncapped-360", "vroid-hub-ani", () =>
        resolveConfiguredFpsCap(PRESET_BENCH_UNCAPPED, false),
      ),
    };

    expect(baseline.reports.length).toBeGreaterThanOrEqual(3);
    expect(afterProduct.reports.length).toBe(baseline.reports.length);

    const baseIdle = baseline.reports.find((r) => r.scenarioId === "idle-procedural")!;
    const afterIdle = afterProduct.reports.find(
      (r) => r.scenarioId === "idle-procedural",
    )!;
    expect(afterIdle.fps.p50).toBeGreaterThan(baseIdle.fps.p50);
    expect(ladder["bench-120"].reports[0]!.fps.p50).toBeGreaterThan(100);
    expect(ladder["bench-144"].reports[0]!.fps.p50).toBeGreaterThan(130);

    const out = process.env.AETHER_BENCH_OUT;
    if (out) {
      // Runtime-only Node APIs (not in apps/web tsconfig types)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require("node:path") as typeof import("node:path");
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(
        path.join(out, "bench-baseline.json"),
        JSON.stringify(baseline, null, 2),
      );
      fs.writeFileSync(
        path.join(out, "bench-after.json"),
        JSON.stringify(
          {
            product: afterProduct,
            ladder,
            comparison: {
              idle_p50_fps: {
                baseline: baseIdle.fps.p50,
                productBalanced: afterIdle.fps.p50,
                bench60: ladder["bench-60"].reports[0]!.fps.p50,
                bench120: ladder["bench-120"].reports[0]!.fps.p50,
                bench144: ladder["bench-144"].reports[0]!.fps.p50,
                uncapped: ladder["bench-uncapped-360"].reports[0]!.fps.p50,
              },
              lightingChanged: {
                baseline: baseline.lighting?.id,
                after: afterProduct.lighting?.id,
                keyIntensity: {
                  baseline: baseline.lighting?.lights.key.intensity,
                  after: afterProduct.lighting?.lights.key.intensity,
                },
                exposure: {
                  baseline: baseline.lighting?.exposure,
                  after: afterProduct.lighting?.exposure,
                },
                iblRoom: {
                  baseline: baseline.lighting?.iblRoom,
                  after: afterProduct.lighting?.iblRoom,
                },
              },
            },
          },
          null,
          2,
        ),
      );
    }
  });
});
