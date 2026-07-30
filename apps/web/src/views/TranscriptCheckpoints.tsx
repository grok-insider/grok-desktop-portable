/**
 * Compact checkpoint rail for user turns in the transcript.
 *
 * Marks sit in a short, vertically-centered stack *inside* the content gutter
 * (not on the native scrollbar) so few turns are not stretched across the
 * whole viewport and the scrollbar stays free.
 */

import { cn } from "../components/ui";

export interface CheckpointTurn {
  id: string;
  /** First line of the user message, for the accessible name. */
  preview: string;
}

export function TranscriptCheckpoints({
  turns,
  activeId,
  onJump,
}: {
  turns: CheckpointTurn[];
  /** User turn nearest the viewport, when known. */
  activeId?: string | null;
  onJump: (id: string) => void;
}) {
  if (turns.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label="Conversation checkpoints"
      className={cn(
        // Inset from the scrollbar (pr on the scroller) and compact — not a
        // full-height justify-between rail that leaves huge empty gaps.
        "pointer-events-none absolute top-1/2 right-2 z-10 hidden -translate-y-1/2",
        "max-h-[min(14rem,45%)] w-3 flex-col items-center gap-1 overflow-y-auto py-1",
        "min-[681px]:flex",
      )}
    >
      {turns.map((turn, index) => {
        const active = turn.id === activeId;
        const label =
          turn.preview.length > 0
            ? `Jump to your message: ${turn.preview}`
            : `Jump to your message ${index + 1}`;
        return (
          <button
            key={turn.id}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? "true" : undefined}
            className={cn(
              "pointer-events-auto h-1 w-2.5 shrink-0 rounded-full border-0 p-0",
              "transition-[background-color,width] duration-150 ease-fluid",
              "hover:w-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active ? "w-3 bg-foreground" : "bg-muted-foreground/40 hover:bg-muted-foreground",
            )}
            onClick={() => onJump(turn.id)}
          />
        );
      })}
    </nav>
  );
}

/** Short single-line preview for an accessible checkpoint label. */
export function checkpointPreview(text: string, max = 48): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) {
    return line;
  }
  return `${line.slice(0, max - 1)}…`;
}
