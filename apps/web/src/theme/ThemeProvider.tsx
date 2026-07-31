/**
 * Theme context for Grok Desktop Portable. Preference is local; resolved theme drives
 * the `.dark` class on <html>.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyResolvedTheme,
  cycleThemePreference,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  cyclePreference: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useSystemDark(): boolean {
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setSystemDark(media.matches);
    };
    onChange();
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  return systemDark;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readThemePreference(),
  );
  const systemDark = useSystemDark();
  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    applyResolvedTheme(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeThemePreference(next);
  }, []);

  const cyclePreference = useCallback(() => {
    setPreferenceState((current) => {
      const next = cycleThemePreference(current);
      writeThemePreference(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cyclePreference }),
    [preference, resolved, setPreference, cyclePreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return value;
}
