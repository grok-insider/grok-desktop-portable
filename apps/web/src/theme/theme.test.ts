import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  cycleThemePreference,
  isThemePreference,
  preferenceLabel,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  writeThemePreference,
} from "./theme";

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("resolveTheme", () => {
  it("honours forced light and dark", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system when preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("cycleThemePreference", () => {
  it("cycles system → light → dark → system", () => {
    expect(cycleThemePreference("system")).toBe("light");
    expect(cycleThemePreference("light")).toBe("dark");
    expect(cycleThemePreference("dark")).toBe("system");
  });
});

describe("storage", () => {
  it("reads and writes a valid preference", () => {
    writeThemePreference("dark");
    expect(readThemePreference()).toBe("dark");
  });

  it("falls back to system for missing or invalid values", () => {
    expect(readThemePreference()).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(readThemePreference()).toBe("system");
  });

  it("narrows preference strings", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("neon")).toBe(false);
  });
});

describe("applyResolvedTheme", () => {
  it("toggles the dark class and color-scheme", () => {
    applyResolvedTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyResolvedTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("systemPrefersDark", () => {
  it("reads matches from the media query", () => {
    expect(systemPrefersDark({ matches: true })).toBe(true);
    expect(systemPrefersDark({ matches: false })).toBe(false);
  });
});

describe("preferenceLabel", () => {
  it("labels each preference for a11y", () => {
    expect(preferenceLabel("system")).toBe("System");
    expect(preferenceLabel("light")).toBe("Light");
    expect(preferenceLabel("dark")).toBe("Dark");
  });
});
