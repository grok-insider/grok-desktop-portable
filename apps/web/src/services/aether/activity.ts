/**
 * Map Portable session phase → Aether speaking / mouth level.
 *
 * Pure functions for unit tests. No DOM. Synthetic LFO stands in for real
 * TTS amplitude until a voice pipeline exists (ADR 0020).
 */

export type AvatarPhase = "idle" | "streaming" | "interrupted";

export type AvatarActivity = {
  speaking: boolean;
  /** Mouth amplitude 0..1 */
  level: number;
};

/**
 * Dev/QA override from `?aetherPhase=streaming|idle|interrupted`.
 * Production sessions still pass real phase; query wins only when present.
 */
export function phaseFromSearch(
  search: string | undefined | null,
  fallback: AvatarPhase,
): AvatarPhase {
  if (!search) return fallback;
  const q = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = q.get("aetherPhase");
  if (raw === "streaming" || raw === "idle" || raw === "interrupted") {
    return raw;
  }
  return fallback;
}

/**
 * Continuous mapping. `elapsedSec` advances while streaming so the mouth
 * breathes; ignored for idle/interrupted.
 */
export function activityForPhase(
  phase: AvatarPhase,
  elapsedSec = 0,
): AvatarActivity {
  switch (phase) {
    case "streaming": {
      // Gentle LFO ~0.25–0.75 so soft raster lip-sync is visible.
      const wave = 0.5 + 0.25 * Math.sin(elapsedSec * 6.2);
      return { speaking: true, level: clamp01(wave) };
    }
    case "interrupted":
      return { speaking: false, level: 0.05 };
    case "idle":
    default:
      return { speaking: false, level: 0 };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
