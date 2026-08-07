/**
 * Hub-style near/far + view-ray recovery when camera enters body volume.
 */
import { describe, expect, it } from "vitest";
import {
  isInsideBodyVolume,
  isLostFramingPose,
  isOffScreenNdc,
  nearFarFromModelBox,
  pushOutsideSphere,
  recoverCameraOutsideSphere,
} from "@aether/studio";

const bodyBox = {
  min: { x: -0.4, y: 0, z: -0.3 },
  max: { x: 0.4, y: 1.7, z: 0.3 },
};

const center = { x: 0, y: 0.9, z: 0 };
const radius = 0.75;

describe("nearFarFromModelBox (shipped)", () => {
  it("keeps near small when camera is far (no face slice on raise)", () => {
    const cam = { x: 0.2, y: 2.8, z: 1.2 };
    const forward = { x: 0, y: -0.85, z: -0.5 };
    const len = Math.hypot(forward.x, forward.y, forward.z);
    forward.x /= len;
    forward.y /= len;
    forward.z /= len;
    const { near, far } = nearFarFromModelBox(cam, forward, bodyBox, 1.2);
    expect(near).toBeLessThanOrEqual(0.1);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near + 0.5);
  });

  it("keeps near tiny when close to the face", () => {
    const cam = { x: 0, y: 1.4, z: 0.5 };
    const forward = { x: 0, y: 0, z: -1 };
    const { near } = nearFarFromModelBox(cam, forward, bodyBox, 0.15);
    expect(near).toBeLessThanOrEqual(0.08);
  });
});

describe("recoverCameraOutsideSphere (shipped)", () => {
  it("recovers inside-head to a front framed pose (complete character)", () => {
    const target = { x: 0, y: 1.0, z: 0 };
    // Camera inside head (black-face hole pose from user screenshots)
    const cam = { x: 0.05, y: 1.2, z: 0.12 };
    expect(
      isInsideBodyVolume(cam, center, 0.3, 0.25, 0, 1.8),
    ).toBe(true);

    const changed = recoverCameraOutsideSphere(cam, target, center, 0.4, {
      margin: 0.1,
      yMin: 0.55,
      yMax: 1.1,
      minDist: 0.75,
      halfX: 0.3,
      halfZ: 0.25,
      bodyYMin: 0,
      bodyYMax: 1.8,
    });
    expect(changed).toBe(true);
    // Front hemisphere: Ani face +Z → camera on +Z with real standoff
    expect(cam.z).toBeGreaterThan(target.z + 0.4);
    expect(cam.y - target.y).toBeLessThan(0.6);
    const horiz = Math.hypot(cam.x - target.x, cam.z - target.z);
    expect(horiz).toBeGreaterThan(0.5);
    expect(
      isInsideBodyVolume(cam, center, 0.3, 0.25, 0, 1.8),
    ).toBe(false);
  });

  it("does not reframe a legitimate front face close-up", () => {
    const target = { x: 0, y: 1.2, z: 0 };
    // Outside capsule, close to face from front (Hub minDistance 0.15 zone)
    const cam = { x: 0, y: 1.3, z: 0.55 };
    expect(
      isInsideBodyVolume(cam, center, 0.3, 0.22, 0, 1.8),
    ).toBe(false);
    const before = { ...cam };
    const changed = recoverCameraOutsideSphere(cam, target, center, 0.4, {
      halfX: 0.3,
      halfZ: 0.22,
      bodyYMin: 0,
      bodyYMax: 1.8,
      minDist: 0.75,
    });
    // No inside volume → no move (except maybe target y clamp)
    expect(cam.x).toBe(before.x);
    expect(cam.z).toBe(before.z);
    expect(changed).toBe(false);
  });

  it("clamps target Y out of the skull band when recovering", () => {
    const target = { x: 0, y: 1.55, z: 0 }; // pan into skull
    const cam = { x: 0.05, y: 1.5, z: 0.1 };
    recoverCameraOutsideSphere(cam, target, center, radius, {
      margin: 0.1,
      yMin: 0.55,
      yMax: 1.1,
      minDist: 0.65,
    });
    expect(target.y).toBeLessThanOrEqual(1.1);
    expect(target.y).toBeGreaterThanOrEqual(0.55);
  });

  it("front-places when cam coincides with target inside sphere", () => {
    const target = { x: 0, y: 0.95, z: 0 };
    const cam = { x: 0, y: 0.95, z: 0 };
    recoverCameraOutsideSphere(cam, target, center, radius, {
      margin: 0.1,
      minDist: 0.65,
    });
    const d = Math.hypot(cam.x - center.x, cam.y - center.y, cam.z - center.z);
    expect(d).toBeGreaterThanOrEqual(radius);
    // Default frontSign +1 → camera on +Z
    expect(cam.z).toBeGreaterThan(center.z);
  });
});

describe("pushOutsideSphere (legacy helper still shipped)", () => {
  it("pushes radially out of sphere", () => {
    const cam = { x: 0.05, y: 1.2, z: 0.08 };
    expect(pushOutsideSphere(cam, center, radius, 0.08)).toBe(true);
    const d = Math.hypot(cam.x - center.x, cam.y - center.y, cam.z - center.z);
    expect(d).toBeGreaterThanOrEqual(radius + 0.08 - 1e-6);
  });
});

describe("isOffScreenNdc / isLostFramingPose (shipped)", () => {
  it("flags model center outside soft NDC plate", () => {
    expect(isOffScreenNdc(0, 0)).toBe(false);
    expect(isOffScreenNdc(0.9, 0.4)).toBe(false);
    expect(isOffScreenNdc(1.2, 0)).toBe(true);
    expect(isOffScreenNdc(0, -1.3)).toBe(true);
    expect(isOffScreenNdc(Number.NaN, 0)).toBe(true);
  });

  it("flags top-down and deep-rear lost poses", () => {
    // Steep top-down into skull
    expect(
      isLostFramingPose(
        { x: 0, y: 2.4, z: 0.1 },
        { x: 0, y: 1.0, z: 0 },
        center,
        { frontSign: 1 },
      ),
    ).toBe(true);
    // Deep rear (−Z when front is +Z) close above center → open head cavity
    expect(
      isLostFramingPose(
        { x: 0, y: 1.5, z: -0.6 },
        { x: 0, y: 1.0, z: 0 },
        center,
        { frontSign: 1 },
      ),
    ).toBe(true);
    // Legitimate front face view (camera on +Z)
    expect(
      isLostFramingPose(
        { x: 0, y: 1.15, z: 1.8 },
        { x: 0, y: 1.0, z: 0 },
        center,
        { frontSign: 1 },
      ),
    ).toBe(false);
  });

  it("inside-head recovery lands face-front with real standoff (not corset)", () => {
    const target = { x: 0, y: 1.4, z: 0 };
    const cam = { x: 0.02, y: 1.35, z: 0.05 };
    recoverCameraOutsideSphere(cam, target, center, 0.35, {
      margin: 0.1,
      yMin: 0.55,
      yMax: 1.15,
      minDist: 0.75,
      halfX: 0.3,
      halfZ: 0.25,
      bodyYMin: 0,
      bodyYMax: 1.8,
      frontSign: 1,
    });
    // Face band target, camera well in front (+Z), not belt-height crop
    expect(target.y).toBeGreaterThan(0.7);
    expect(cam.z - target.z).toBeGreaterThan(1.2);
    expect(cam.y).toBeGreaterThan(0.7);
    expect(isInsideBodyVolume(cam, center, 0.3, 0.25, 0, 1.8)).toBe(false);
  });
});
