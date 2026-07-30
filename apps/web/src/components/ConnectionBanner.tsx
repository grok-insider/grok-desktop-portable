/**
 * Visible recovery strip when the event channel drops while paired.
 *
 * Status chips alone are easy to miss; this is the explicit recovery path
 * for lease/WS loss without dumping the user to setup if the cookie still
 * holds.
 */

import { WifiOff } from "lucide-react";
import { Button } from "./ui";

export function ConnectionBanner({
  reconnecting,
  onRetry,
}: {
  reconnecting: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 border-b border-warning/40 bg-warning-soft px-6 py-2.5"
    >
      <p className="flex min-w-0 items-center gap-2 text-body text-warning">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-card/70 text-warning">
          <WifiOff size={14} aria-hidden="true" />
        </span>
        <span>
          {reconnecting
            ? "Reconnecting to the local host…"
            : "Disconnected from the local host. The agent will not receive prompts until the channel is back."}
        </span>
      </p>
      <Button variant="secondary" onClick={onRetry} disabled={reconnecting}>
        Retry
      </Button>
    </div>
  );
}
