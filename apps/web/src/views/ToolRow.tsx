/**
 * What the agent actually did, rather than which function it called.
 *
 * A row used to read `run_terminal_command · Done`, which named the mechanism
 * and hid the act. A user scanning a transcript wants to know that a command
 * ran, which one, whether it could change anything, and whether it worked.
 *
 * Rows sit **in** the transcript, at the point in the conversation where they
 * happened. They used to be collected into a card pinned below every message,
 * which meant a reader could see that a command ran but never which turn ran
 * it.
 *
 * A row that worked says so by staying quiet: a chip on every successful read
 * is a column of green that trains the eye to skip the one that failed.
 * Running, failed, and truncated keep their chip, because those are the states
 * worth interrupting for.
 *
 * Finished quiet reads collapse by default so the timeline stays scannable;
 * running, failed, truncated, and may-change rows stay open. Everything here
 * is agent-supplied and therefore untrusted: rendered as text, never markup.
 */

import {
  ArrowRightLeft,
  ChevronRight,
  CircleHelp,
  FileSearch,
  Globe,
  Lightbulb,
  Pencil,
  Search,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import { StatusChip, cn } from "../components/ui";
import type { ToolEntry } from "./SessionView";

/**
 * The closed set of actions the host projects, each with how to show it.
 *
 * Closed on purpose: the value comes from the agent, and only a fixed set can
 * choose an icon without letting agent text pick its own presentation.
 */
const ACTIONS: Record<
  string,
  { icon: ComponentType<{ size?: number; className?: string }>; label: string }
> = {
  read: { icon: FileSearch, label: "Read" },
  edit: { icon: Pencil, label: "Edit" },
  execute: { icon: Terminal, label: "Run" },
  search: { icon: Search, label: "Search" },
  think: { icon: Lightbulb, label: "Think" },
  fetch: { icon: Globe, label: "Fetch" },
  delete: { icon: Trash2, label: "Delete" },
  move: { icon: ArrowRightLeft, label: "Move" },
  switch_mode: { icon: ArrowRightLeft, label: "Mode" },
  other: { icon: CircleHelp, label: "Tool" },
};

function presentation(action: string) {
  return ACTIONS[action] ?? ACTIONS.other!;
}

/** Open by default when the user may need to act or watch. */
export function defaultToolExpanded(tool: ToolEntry): boolean {
  if (!tool.finished) {
    return true;
  }
  if (tool.failed || tool.truncated) {
    return true;
  }
  // May-change stays visible so a write is not buried after it finishes.
  if (!tool.readOnly) {
    return true;
  }
  return false;
}

function statusTone(tool: ToolEntry): "destructive" | "warning" | "info" {
  if (!tool.finished) {
    return "info";
  }
  if (tool.failed) {
    return "destructive";
  }
  return "warning";
}

function statusLabel(tool: ToolEntry, actionLabel: string): string | null {
  if (!tool.finished) {
    return `${actionLabel}\u2026`;
  }
  if (tool.failed) {
    return "Failed";
  }
  if (tool.truncated) {
    return "Truncated";
  }
  // Done is the resting state; a chip on every successful read is noise.
  return null;
}

/** One tool call, inline in the transcript. */
export function ToolRow({ tool }: { tool: ToolEntry }) {
  const { icon: Icon, label } = presentation(tool.action);
  const shouldExpand = defaultToolExpanded(tool);
  const [expanded, setExpanded] = useState(shouldExpand);

  // When a running row finishes, re-apply the default so quiet reads fold away.
  // Keyed on the answer rather than every field it is derived from, so a
  // progress event that does not change the answer cannot undo a user's own
  // collapse.
  useEffect(() => {
    setExpanded(shouldExpand);
  }, [tool.id, shouldExpand]);

  const chip = statusLabel(tool, label);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`tool-detail-${tool.id}`}
        onClick={() => setExpanded((open) => !open)}
        className={cn(
          "group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left",
          "transition-[background-color] duration-150 ease-fluid hover:bg-accent/60",
        )}
      >
        <Icon
          size={14}
          className={cn(
            "shrink-0",
            tool.readOnly ? "text-subtle-foreground" : "text-warning",
          )}
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-body">
          <span className="shrink-0 font-medium text-foreground">{label}</span>
          <span className="shrink-0 text-subtle-foreground" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 shrink truncate text-muted-foreground">
            {tool.name}
          </span>
          {tool.detail == null || expanded ? null : (
            <>
              <span className="shrink-0 text-subtle-foreground" aria-hidden="true">
                ·
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-subtle-foreground">
                {tool.detail}
              </span>
            </>
          )}
        </span>

        <span className="flex shrink-0 items-center gap-1.5">
          {tool.provider == null ? null : (
            <span
              className="rounded-sm bg-muted px-1.5 text-label text-muted-foreground"
              title={`Provided by the ${tool.provider} MCP server`}
            >
              {tool.provider}
            </span>
          )}
          {tool.readOnly ? null : (
            <span className="text-label text-warning">may change things</span>
          )}
          {chip === null ? null : <StatusChip tone={statusTone(tool)}>{chip}</StatusChip>}
          <ChevronRight
            size={14}
            className={cn(
              "text-subtle-foreground transition-transform duration-150 ease-fluid",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </span>
        <span className="sr-only">
          {expanded ? "Collapse" : "Expand"} {tool.name}
        </span>
      </button>

      {expanded ? (
        <div
          id={`tool-detail-${tool.id}`}
          className="ml-[13px] flex flex-col gap-1 border-l border-border py-1 pl-4"
        >
          {tool.detail == null ? (
            <span className="text-body-sm text-subtle-foreground">No detail</span>
          ) : (
            <span className="break-all font-mono text-body-sm text-muted-foreground">
              {tool.detail}
            </span>
          )}
          {tool.truncated ? (
            <span className="text-label text-subtle-foreground">
              Output was truncated by the host.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
