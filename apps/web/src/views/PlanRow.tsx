/**
 * The agent's current plan as a compact checklist in the transcript column.
 *
 * Plans update in place (the agent republishes the full list), so this is a
 * living block rather than a historical tool row. Content is agent-supplied
 * and rendered as text only. Status is a closed set from the host.
 */

import { Check, Circle, Loader2, ListTodo } from "lucide-react";
import type { PlanEntryProjection } from "../services/protocol";
import { cn } from "../components/ui";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") {
    return <Check size={12} className="text-success" aria-hidden="true" />;
  }
  if (status === "in_progress") {
    return (
      <Loader2
        size={12}
        className="animate-spin text-info"
        aria-hidden="true"
      />
    );
  }
  return <Circle size={12} className="text-subtle-foreground" aria-hidden="true" />;
}

/** Latest plan for the open conversation. Renders nothing when empty. */
export function PlanRow({ entries }: { entries: PlanEntryProjection[] }) {
  if (entries.length === 0) {
    return null;
  }

  const done = entries.filter((entry) => entry.status === "completed").length;

  return (
    <section
      className="rounded-lg border border-border bg-card/60 px-3 py-2.5"
      aria-label={`Agent plan, ${done} of ${entries.length} done`}
    >
      <header className="mb-2 flex items-center gap-1.5 text-caption text-muted-foreground">
        <ListTodo size={14} className="shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground">Plan</span>
        <span aria-hidden="true">·</span>
        <span>
          {done}/{entries.length}
        </span>
      </header>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {entries.map((entry, index) => {
          const label = STATUS_LABEL[entry.status] ?? STATUS_LABEL.pending;
          return (
            <li
              key={`${index}-${entry.content.slice(0, 24)}`}
              className={cn(
                "flex min-h-6 items-start gap-2 text-body",
                entry.status === "completed" && "text-muted-foreground",
              )}
            >
              <span className="mt-0.5 shrink-0" title={label}>
                <StatusIcon status={entry.status} />
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {entry.content}
              </span>
              <span className="sr-only">{label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
