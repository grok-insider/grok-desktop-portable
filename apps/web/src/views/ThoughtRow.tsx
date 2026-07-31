/**
 * Agent reasoning (`thoughtDelta`) as a collapsible transcript block.
 *
 * Mirrors the CLI pager’s Thinking block: live while the turn streams, quiet
 * and collapsed once the answer lands. Content is agent-supplied and rendered
 * as plain text only (never markdown / HTML).
 */

import { Brain, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../components/ui";
import type { ThoughtEntry } from "./SessionView";

export function ThoughtRow({
  thought,
  streaming,
}: {
  thought: ThoughtEntry;
  /** True while this is the open thought block of a running turn. */
  streaming: boolean;
}) {
  // Auto-expand while streaming; once finished, collapse so the answer is
  // the primary read — the user can open it again.
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (streaming) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [streaming]);

  const label = streaming ? "Thinking…" : "Thought";

  return (
    <section
      className="rounded-lg border border-border/70 bg-muted/40"
      aria-label={label}
    >
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          "text-body-sm text-muted-foreground transition-colors duration-150 ease-fluid",
          "hover:bg-accent/40 hover:text-foreground",
        )}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRight
          size={14}
          className={cn(
            "shrink-0 transition-transform duration-150 ease-fluid",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        {streaming ? (
          <Loader2
            size={14}
            className="shrink-0 animate-spin text-info"
            aria-hidden="true"
          />
        ) : (
          <Brain size={14} className="shrink-0 text-subtle-foreground" aria-hidden="true" />
        )}
        <span className="font-medium text-foreground">{label}</span>
        {!streaming && thought.text.trim().length > 0 ? (
          <span className="min-w-0 flex-1 truncate text-label text-subtle-foreground">
            {thought.text.trim().split(/\s+/).slice(0, 12).join(" ")}
            {thought.text.trim().split(/\s+/).length > 12 ? "…" : ""}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">
          <p className="whitespace-pre-wrap font-mono text-body-sm leading-relaxed text-muted-foreground">
            {thought.text}
            {streaming ? (
              <span
                className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse bg-info/70"
                aria-hidden="true"
              />
            ) : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}
