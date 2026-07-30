/**
 * Host-owned follow-up queue shown above the composer.
 *
 * Entries wait for the turn in flight. Removing one is a local/host op the
 * parent already owns; this is presentation only.
 */

import { X } from "lucide-react";
import { Button } from "../../components/ui";

export function PromptQueue({
  queued,
  onRemove,
}: {
  queued: { entryId: string; text: string }[];
  onRemove: (entryId: string) => void;
}) {
  if (queued.length === 0) {
    return null;
  }

  return (
    <ul
      className="mb-2 flex flex-col gap-1"
      aria-label="Waiting to be sent"
    >
      {queued.map((entry) => (
        <li
          key={entry.entryId}
          className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-1.5"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full bg-info-soft px-1.5 py-0.5 font-mono text-label font-semibold text-info">
              Waiting
            </span>
            <span className="truncate text-body-sm text-muted-foreground">
              {entry.text}
            </span>
          </span>
          <Button
            variant="ghost"
            onClick={() => onRemove(entry.entryId)}
            aria-label={`Remove the waiting message: ${entry.text}`}
            className="size-7 shrink-0 px-0"
          >
            <X size={12} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
