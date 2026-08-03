/**
 * Right-rail detail for one background task (CLI Tasks log parity).
 *
 * Log body is pull-only (`getBackgroundTaskOutput`); paths never appear.
 */

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { IconButton, cn } from "../components/ui";
import type { SnapshotBackgroundTask } from "../services/protocol";

export type TaskOutputLoad = {
  text: string;
  truncated: boolean;
  availability: "ok" | "notReady" | "unavailable";
  contentVersion?: number;
  status?: string;
  title?: string;
  command?: string;
  exitCode?: number | null;
  signal?: string;
  loading: boolean;
  error?: string;
};

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "running":
      return "running";
    case "killing":
      return "killing…";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return status ?? "";
  }
}

export function TaskDetailPanel({
  task,
  output,
  onClose,
}: {
  task: SnapshotBackgroundTask | null;
  output: TaskOutputLoad | null;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  const title =
    output?.title ||
    task?.title ||
    task?.command ||
    task?.taskId ||
    "Task";
  const status = output?.status ?? task?.status;
  const text = output?.text ?? "";
  const availability = output?.availability;
  const loading = output?.loading ?? false;

  useEffect(() => {
    if (!stuckToBottom || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text, stuckToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < 48;
    stickRef.current = next;
    setStuckToBottom(next);
  }

  let bodyMessage: string | null = null;
  if (output?.error) {
    bodyMessage = output.error;
  } else if (availability === "unavailable") {
    bodyMessage = "Output is no longer available for this task.";
  } else if (availability === "notReady" && text.length === 0) {
    bodyMessage = "Waiting for output…";
  } else if (loading && text.length === 0) {
    bodyMessage = "Loading output…";
  } else if (!loading && text.length === 0 && availability === "ok") {
    bodyMessage = "(no output yet)";
  }

  const meta = [
    task?.kind === "monitor" ? "monitor" : null,
    statusLabel(status),
    output?.exitCode !== undefined && output?.exitCode !== null
      ? `exit ${output.exitCode}`
      : task?.exitCode !== undefined
        ? `exit ${task.exitCode}`
        : null,
    (output?.signal || task?.signal) ? `signal ${output?.signal || task?.signal}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside
      className={cn(
        "z-20 flex w-[400px] shrink-0 flex-col border-l border-sidebar-border bg-card",
        "max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0",
        "max-[1180px]:w-[min(400px,100%)] max-[1180px]:shadow-dialog",
        "max-[680px]:fixed",
      )}
      aria-label={`Task output: ${title}`}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-foreground" title={title}>
            {title}
          </div>
          {meta ? (
            <div
              className="truncate font-mono text-label text-muted-foreground"
              aria-live="polite"
            >
              {meta}
            </div>
          ) : null}
        </div>
        <IconButton size="sm" onClick={onClose} aria-label="Close task panel">
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {output?.truncated ? (
        <div className="shrink-0 border-b border-border px-3 py-1 text-label text-subtle-foreground">
          Showing latest output (truncated)
        </div>
      ) : null}

      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          "min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words",
          "bg-background px-3 py-2 font-mono text-body-sm text-foreground",
        )}
      >
        {bodyMessage !== null && text.length === 0 ? (
          <span className="text-muted-foreground">{bodyMessage}</span>
        ) : (
          text
        )}
      </pre>
    </aside>
  );
}
