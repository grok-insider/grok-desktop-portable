/**
 * When Aether Studio dogfood panel is allowed on this page.
 * Production: ?aetherStudio=1 (or true/yes), or localStorage pin.
 * Dev: always allowed unless ?aetherStudio=0.
 */

import {
  AETHER_STUDIO_QUERY,
  AETHER_STUDIO_PIN_KEY,
  isAetherStudioAllowed as packageGate,
} from "@aether/studio";

export { AETHER_STUDIO_QUERY, AETHER_STUDIO_PIN_KEY };

export function isAetherStudioAllowed(): boolean {
  return packageGate(
    typeof window !== "undefined" ? window.location.search : "",
    Boolean(import.meta.env.DEV),
  );
}
