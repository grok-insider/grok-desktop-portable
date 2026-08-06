/**
 * Multi-bone humanoid idle / speaking clips for three-vrm.
 *
 * Prefer optional VRMA assets when present; otherwise build a rich procedural
 * AnimationClip (weight shift, breathe, head look, arm micro-motion).
 */

import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

export type IdleClipKind = "idle" | "speaking";

type BoneName =
  | "hips"
  | "spine"
  | "chest"
  | "upperChest"
  | "neck"
  | "head"
  | "leftShoulder"
  | "rightShoulder"
  | "leftUpperArm"
  | "rightUpperArm"
  | "leftLowerArm"
  | "rightLowerArm"
  | "leftHand"
  | "rightHand"
  | "leftUpperLeg"
  | "rightUpperLeg"
  | "leftLowerLeg"
  | "rightLowerLeg";

type EulerKey = {
  t: number;
  /** degrees */
  x?: number;
  y?: number;
  z?: number;
};

function quatFromEulerDeg(x = 0, y = 0, z = 0): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(x),
      THREE.MathUtils.degToRad(y),
      THREE.MathUtils.degToRad(z),
      "XYZ",
    ),
  );
}

function pushQuatTrack(
  tracks: THREE.KeyframeTrack[],
  vrm: VRM,
  bone: BoneName,
  keys: EulerKey[],
): void {
  const node = vrm.humanoid?.getNormalizedBoneNode(bone);
  if (!node || keys.length === 0) return;

  const times: number[] = [];
  const values: number[] = [];
  const q = new THREE.Quaternion();
  for (const k of keys) {
    times.push(k.t);
    q.copy(quatFromEulerDeg(k.x ?? 0, k.y ?? 0, k.z ?? 0));
    // Preserve rest pose offset: multiply rest * delta
    const rest = node.quaternion.clone();
    const out = rest.clone().multiply(q);
    values.push(out.x, out.y, out.z, out.w);
  }

  tracks.push(
    new THREE.QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      times,
      values,
    ),
  );
}

function pushPosTrack(
  tracks: THREE.KeyframeTrack[],
  vrm: VRM,
  bone: BoneName,
  keys: { t: number; x?: number; y?: number; z?: number }[],
): void {
  const node = vrm.humanoid?.getNormalizedBoneNode(bone);
  if (!node || keys.length === 0) return;
  const times: number[] = [];
  const values: number[] = [];
  const rest = node.position.clone();
  for (const k of keys) {
    times.push(k.t);
    values.push(
      rest.x + (k.x ?? 0),
      rest.y + (k.y ?? 0),
      rest.z + (k.z ?? 0),
    );
  }
  tracks.push(
    new THREE.VectorKeyframeTrack(`${node.name}.position`, times, values),
  );
}

/**
 * Build a looping standing idle (~4s) with weight shift + breathe + look.
 * Uses humanoid normalized bones so it retargets across VRoid models.
 */
export function buildProceduralIdleClip(vrm: VRM): THREE.AnimationClip {
  const duration = 4.0;
  const tracks: THREE.KeyframeTrack[] = [];

  // Weight shift left → center → right → center
  pushPosTrack(tracks, vrm, "hips", [
    { t: 0.0, y: 0.0, x: 0.0 },
    { t: 1.0, y: 0.006, x: 0.012 },
    { t: 2.0, y: 0.0, x: 0.0 },
    { t: 3.0, y: 0.006, x: -0.012 },
    { t: 4.0, y: 0.0, x: 0.0 },
  ]);
  pushQuatTrack(tracks, vrm, "hips", [
    { t: 0.0, y: -4, z: 1 },
    { t: 1.0, y: 0, z: -1.5 },
    { t: 2.0, y: 4, z: 1 },
    { t: 3.0, y: 0, z: -1.5 },
    { t: 4.0, y: -4, z: 1 },
  ]);

  // Torso breathe
  pushQuatTrack(tracks, vrm, "spine", [
    { t: 0.0, x: 2, y: -1 },
    { t: 2.0, x: -2, y: 2 },
    { t: 4.0, x: 2, y: -1 },
  ]);
  pushQuatTrack(tracks, vrm, "chest", [
    { t: 0.0, x: 1.5 },
    { t: 1.3, x: -1.2 },
    { t: 2.6, x: 1.0 },
    { t: 4.0, x: 1.5 },
  ]);
  pushQuatTrack(tracks, vrm, "upperChest", [
    { t: 0.0, x: 1 },
    { t: 2.0, x: -1.5 },
    { t: 4.0, x: 1 },
  ]);

  // Head / neck look-around (subtle)
  pushQuatTrack(tracks, vrm, "neck", [
    { t: 0.0, y: -3, x: 0 },
    { t: 1.2, y: 2, x: 2 },
    { t: 2.4, y: 5, x: 0 },
    { t: 3.2, y: -1, x: -1 },
    { t: 4.0, y: -3, x: 0 },
  ]);
  pushQuatTrack(tracks, vrm, "head", [
    { t: 0.0, y: -6, x: 1 },
    { t: 1.0, y: 0, x: 3 },
    { t: 2.0, y: 7, x: 0 },
    { t: 3.0, y: 2, x: -2 },
    { t: 4.0, y: -6, x: 1 },
  ]);

  // Shoulders / arms: relaxed hang + micro sway (not T-pose)
  // Base Z ~ ±66° drops arms from T-pose; keys are deltas on top of rest.
  pushQuatTrack(tracks, vrm, "leftShoulder", [
    { t: 0.0, z: 2, y: 0 },
    { t: 2.0, z: -2, y: 1 },
    { t: 4.0, z: 2, y: 0 },
  ]);
  pushQuatTrack(tracks, vrm, "rightShoulder", [
    { t: 0.0, z: -2, y: 0 },
    { t: 2.0, z: 2, y: -1 },
    { t: 4.0, z: -2, y: 0 },
  ]);
  pushQuatTrack(tracks, vrm, "leftUpperArm", [
    { t: 0.0, z: 62, x: 8, y: 4 },
    { t: 1.3, z: 58, x: 10, y: 2 },
    { t: 2.6, z: 64, x: 6, y: 5 },
    { t: 4.0, z: 62, x: 8, y: 4 },
  ]);
  pushQuatTrack(tracks, vrm, "rightUpperArm", [
    { t: 0.0, z: -62, x: 8, y: -4 },
    { t: 1.3, z: -58, x: 10, y: -2 },
    { t: 2.6, z: -64, x: 6, y: -5 },
    { t: 4.0, z: -62, x: 8, y: -4 },
  ]);
  pushQuatTrack(tracks, vrm, "leftLowerArm", [
    { t: 0.0, y: 8, x: 5 },
    { t: 2.0, y: 14, x: 2 },
    { t: 4.0, y: 8, x: 5 },
  ]);
  pushQuatTrack(tracks, vrm, "rightLowerArm", [
    { t: 0.0, y: -8, x: 5 },
    { t: 2.0, y: -14, x: 2 },
    { t: 4.0, y: -8, x: 5 },
  ]);
  pushQuatTrack(tracks, vrm, "leftHand", [
    { t: 0.0, x: 5 },
    { t: 2.0, x: 10 },
    { t: 4.0, x: 5 },
  ]);
  pushQuatTrack(tracks, vrm, "rightHand", [
    { t: 0.0, x: 5 },
    { t: 2.0, x: 10 },
    { t: 4.0, x: 5 },
  ]);

  // Soft knee bend with weight shift
  pushQuatTrack(tracks, vrm, "leftUpperLeg", [
    { t: 0.0, x: 1, z: 0 },
    { t: 1.0, x: 3, z: 1 },
    { t: 2.0, x: 1, z: 0 },
    { t: 3.0, x: 0.5, z: -0.5 },
    { t: 4.0, x: 1, z: 0 },
  ]);
  pushQuatTrack(tracks, vrm, "rightUpperLeg", [
    { t: 0.0, x: 1, z: 0 },
    { t: 1.0, x: 0.5, z: 0.5 },
    { t: 2.0, x: 1, z: 0 },
    { t: 3.0, x: 3, z: -1 },
    { t: 4.0, x: 1, z: 0 },
  ]);
  pushQuatTrack(tracks, vrm, "leftLowerLeg", [
    { t: 0.0, x: -2 },
    { t: 1.0, x: -5 },
    { t: 2.0, x: -2 },
    { t: 3.0, x: -1 },
    { t: 4.0, x: -2 },
  ]);
  pushQuatTrack(tracks, vrm, "rightLowerLeg", [
    { t: 0.0, x: -2 },
    { t: 1.0, x: -1 },
    { t: 2.0, x: -2 },
    { t: 3.0, x: -5 },
    { t: 4.0, x: -2 },
  ]);

  return new THREE.AnimationClip("aether-idle", duration, tracks);
}

/**
 * Speaking overlay: stronger torso + head nod on top of idle (shorter loop).
 */
export function buildProceduralSpeakingClip(vrm: VRM): THREE.AnimationClip {
  const duration = 1.6;
  const tracks: THREE.KeyframeTrack[] = [];

  pushQuatTrack(tracks, vrm, "spine", [
    { t: 0.0, x: 1, y: -1 },
    { t: 0.4, x: 3, y: 1 },
    { t: 0.9, x: 0, y: -0.5 },
    { t: 1.6, x: 1, y: -1 },
  ]);
  pushQuatTrack(tracks, vrm, "chest", [
    { t: 0.0, x: 2 },
    { t: 0.5, x: 5 },
    { t: 1.1, x: 1 },
    { t: 1.6, x: 2 },
  ]);
  pushQuatTrack(tracks, vrm, "head", [
    { t: 0.0, x: 2, y: -2 },
    { t: 0.35, x: 5, y: 1 },
    { t: 0.8, x: 1, y: 3 },
    { t: 1.2, x: 4, y: -1 },
    { t: 1.6, x: 2, y: -2 },
  ]);
  pushQuatTrack(tracks, vrm, "leftUpperArm", [
    { t: 0.0, z: 60, x: 10 },
    { t: 0.8, z: 56, x: 14 },
    { t: 1.6, z: 60, x: 10 },
  ]);
  pushQuatTrack(tracks, vrm, "rightUpperArm", [
    { t: 0.0, z: -60, x: 10 },
    { t: 0.8, z: -56, x: 14 },
    { t: 1.6, z: -60, x: 10 },
  ]);

  return new THREE.AnimationClip("aether-speaking", duration, tracks);
}
