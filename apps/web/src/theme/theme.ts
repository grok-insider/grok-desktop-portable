/**
 * Presentation theme for Grok Light.
 *
 * Preference is browser-local only (localStorage). It is not host state, not
 * protocol, and never carries credentials — only the string
 * "system" | "light" | "dark".
 *
 * The boot script in index.html mirrors read + resolve so the first paint
 * matches. Keep THEME_STORAGE_KEY and the resolve rules in sync with that
 * script.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "grok-light.theme";

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (PREFERENCES as readonly string[]).includes(value);
}

/** Read preference; invalid or missing values fall back to system. */
export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(raw)) {
      return raw;
    }
  } catch {
    /* private mode */
  }
  return "system";
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* private mode — in-memory still works for the session */
  }
}

export function systemPrefersDark(
  media: Pick<MediaQueryList, "matches"> = typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : { matches: false },
): boolean {
  return media.matches;
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "light") {
    return "light";
  }
  if (preference === "dark") {
    return "dark";
  }
  return systemDark ? "dark" : "light";
}

/** Cycle used by the header control: system → light → dark → system. */
export function cycleThemePreference(current: ThemePreference): ThemePreference {
  if (current === "system") {
    return "light";
  }
  if (current === "light") {
    return "dark";
  }
  return "system";
}

export function applyResolvedTheme(
  resolved: ResolvedTheme,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function preferenceLabel(preference: ThemePreference): string {
  switch (preference) {
    case "system":
      return "System";
    case "light":
      return "Light";
    case "dark":
      return "Dark";
  }
}
