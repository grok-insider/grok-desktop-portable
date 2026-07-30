/**
 * Cycles theme preference: system → light → dark → system.
 *
 * Icon reflects the preference the user chose (Monitor / Sun / Moon), not
 * only the resolved scheme, so "system" is distinguishable from forced light.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "../components/ui";
import { preferenceLabel } from "./theme";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { preference, cyclePreference } = useTheme();
  const Icon =
    preference === "dark" ? Moon : preference === "light" ? Sun : Monitor;

  return (
    <Button
      variant="ghost"
      onClick={cyclePreference}
      aria-label={`Theme: ${preferenceLabel(preference)}. Click to change.`}
      title={`Theme: ${preferenceLabel(preference)}`}
      className="size-9 shrink-0 px-0"
    >
      <Icon size={16} aria-hidden="true" />
    </Button>
  );
}
