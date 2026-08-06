import { afterEach, describe, expect, it } from "vitest";
import {
  AETHER_STUDIO_PIN_KEY,
  isAetherStudioAllowed as packageGate,
  writeStudioPin,
} from "@aether/studio";
import { isAetherStudioAllowed } from "./studioGate";

describe("studio gate", () => {
  afterEach(() => {
    try {
      localStorage.removeItem(AETHER_STUDIO_PIN_KEY);
    } catch {
      /* ignore */
    }
  });

  it("package: allows DEV without query", () => {
    expect(packageGate("", true)).toBe(true);
  });

  it("package: denies prod without query or pin", () => {
    expect(packageGate("", false)).toBe(false);
  });

  it("package: allows ?aetherStudio=1 in prod", () => {
    expect(packageGate("?aetherStudio=1", false)).toBe(true);
  });

  it("package: denies ?aetherStudio=0 even in DEV", () => {
    expect(packageGate("?aetherStudio=0", true)).toBe(false);
  });

  it("package: allows prod when pin is set", () => {
    writeStudioPin(true);
    expect(packageGate("", false)).toBe(true);
    writeStudioPin(false);
    expect(packageGate("", false)).toBe(false);
  });

  it("portable wrapper returns boolean", () => {
    expect(typeof isAetherStudioAllowed()).toBe("boolean");
  });
});
