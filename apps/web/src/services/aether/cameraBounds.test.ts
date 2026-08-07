/**
 * Hub-like pan framing: pan is allowed, but pan-failure poses (target in head,
 * camera behind/inside body) must clamp to a safe view.
 */
import { describe, expect, it } from "vitest";
import {
  applyStudioCameraFraming,
  clampCameraFrontHemisphere,
  clampCameraOutsideBox,
  clampOrbitTarget,
  framingLimitsFromModel,
  fullBodyFramingPose,
  minDistanceToClearBox,
  pointInBox,
} from "@aether/studio";

const bodyBox = {
  min: { x: -0.35, y: 0, z: -0.25 },
  max: { x: 0.35, y: 1.65, z: 0.3 },
};

const center = { x: 0, y: 0.85, z: 0 };
const height = 1.65;

describe("cameraBounds pan framing (shipped)", () => {
  it("minDistance from chest target clears the top of the head", () => {
    const chest = { x: 0, y: 0.95, z: 0 };
    const minD = minDistanceToClearBox(chest, bodyBox);
    const toTop = Math.hypot(0.35, 1.65 - 0.95, 0.3);
    expect(minD).toBeGreaterThanOrEqual(toTop);
    const cam = { x: 0, y: chest.y + minD, z: 0 };
    expect(pointInBox(cam, bodyBox)).toBe(false);
  });

  it("clampOrbitTarget allows pan within band but not into skull/feet", () => {
    const limits = framingLimitsFromModel(center, height, bodyBox);
    // Valid pan truck
    const ok = { x: 0.1, y: (limits.yMin + limits.yMax) / 2, z: 0.05 };
    clampOrbitTarget(ok, limits);
    expect(ok.x).toBeCloseTo(0.1, 5);

    // Yanked into head (pan failure pose)
    const head = { x: 0, y: 1.55, z: 0 };
    clampOrbitTarget(head, limits);
    expect(head.y).toBeLessThanOrEqual(limits.yMax);
    expect(head.y).toBeGreaterThanOrEqual(limits.yMin);

    // Yanked under feet
    const feet = { x: 0, y: 0.05, z: 0 };
    clampOrbitTarget(feet, limits);
    expect(feet.y).toBeGreaterThanOrEqual(limits.yMin);
  });

  it("applyStudioCameraFraming fixes target-in-head + camera-inside torso", () => {
    const limits = framingLimitsFromModel(center, height, bodyBox);
    const cam = { x: 0.05, y: 1.1, z: 0.05 };
    const target = { x: 0, y: 1.55, z: 0 }; // pan into skull
    expect(pointInBox(cam, bodyBox)).toBe(true);

    const r = applyStudioCameraFraming(cam, target, bodyBox, limits);
    expect(r.targetClamped).toBe(true);
    expect(target.y).toBeLessThanOrEqual(limits.yMax);
    expect(r.camInsideBox).toBe(false);
    expect(pointInBox(cam, bodyBox)).toBe(false);
    const dist = Math.hypot(cam.x - target.x, cam.y - target.y, cam.z - target.z);
    expect(dist + 1e-6).toBeGreaterThanOrEqual(r.minDistance);
  });

  it("applyStudioCameraFraming corrects rear camera (open-head black face)", () => {
    const limits = framingLimitsFromModel(center, height, bodyBox);
    // Rear for Ani face+Z is −Z; front is +Z
    const cam = { x: 0.1, y: 1.2, z: -1.8 };
    const target = { x: 0, y: 0.95, z: 0 };
    const r = applyStudioCameraFraming(cam, target, bodyBox, limits, {
      frontSign: 1,
    });
    expect(cam.z - target.z).toBeGreaterThan(0);
    expect(r.camInsideBox).toBe(false);
  });

  it("clamps a camera placed inside the torso to outside", () => {
    const target = { x: 0, y: 0.95, z: 0 };
    const cam = { x: 0.05, y: 1.1, z: 0.05 };
    expect(pointInBox(cam, bodyBox)).toBe(true);
    const applied = clampCameraOutsideBox(cam, target, bodyBox);
    expect(applied).toBeGreaterThan(0.8);
    expect(pointInBox(cam, bodyBox)).toBe(false);
  });

  it("rejects pure rear hemisphere without full framing", () => {
    const target = { x: 0, y: 0.95, z: 0 };
    const cam = { x: 0.1, y: 1.2, z: -1.5 };
    clampCameraFrontHemisphere(cam, target, 1, Math.PI * 0.48);
    expect(cam.z - target.z).toBeGreaterThan(0);
  });

  it("fullBodyFramingPose fits model height into FOV (page-open framing)", () => {
    const height = 1.68;
    const width = 1.62; // hair AABB can be wide
    const fov = 28;
    const aspect = 416 / 640; // product presence plate
    const pose = fullBodyFramingPose(height, width, fov, aspect, {
      frontSign: 1,
    });
    // Target mid-body, camera on +Z front
    expect(pose.target.y).toBeGreaterThan(0.5);
    expect(pose.target.y).toBeLessThan(height * 0.7);
    expect(pose.cam.z).toBeGreaterThan(2.0);
    expect(pose.distance).toBeGreaterThan(2.0);
    // Must not zoom out to a tiny figure because of wide hair AABB
    expect(pose.distance).toBeLessThan(4.5);
    // Vertical FOV must cover height*pad at that distance
    const vFov = (fov * Math.PI) / 180;
    const halfH = pose.distance * Math.tan(vFov / 2);
    expect(halfH * 2).toBeGreaterThanOrEqual(height * 1.1);
  });
});
