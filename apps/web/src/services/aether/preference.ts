/**
 * User preference for in-SPA Aether avatar visibility.
 * localStorage only — not a secret, not sent to the bridge.
 */

export const AETHER_VISIBLE_KEY = "grok-portable-aether.visible";

/** Default on (ADR 0020). */
export function readAetherVisible(): boolean {
  try {
    const raw = localStorage.getItem(AETHER_VISIBLE_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function writeAetherVisible(visible: boolean): void {
  try {
    localStorage.setItem(AETHER_VISIBLE_KEY, visible ? "1" : "0");
  } catch {
    // Private mode / quota — preference is best-effort.
  }
}
