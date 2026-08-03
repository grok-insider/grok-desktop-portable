/**
 * Parent-scoped runtime strip: workflows, nested agents, background tasks.
 *
 * Mirrors CLI TasksPane groups at a high level (not a full TUI clone).
 * Children / tasks never become home-rail peers (ADR 0017 / 0018).
 */

import type {
  SnapshotBackgroundTask,
  SnapshotMember,
  SnapshotWorkflow,
} from "../services/protocol";
import { cn } from "../components/ui";

function phaseMark(state: string): string {
  switch (state) {
    case "done":
      return "✓";
    case "active":
      return "●";
    default:
      return "○";
  }
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) {
    return "";
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function taskStatusLabel(status: string): string {
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
      return status;
  }
}

export function WorkflowStrip({
  workflows,
  members,
  backgroundTasks = [],
  selectedTaskId = null,
  onSelectTask,
}: {
  workflows: SnapshotWorkflow[];
  members: SnapshotMember[];
  backgroundTasks?: SnapshotBackgroundTask[];
  /** Task currently open in the side rail, if any. */
  selectedTaskId?: string | null;
  /** Toggle task detail for this id. */
  onSelectTask?: (taskId: string) => void;
}) {
  if (
    workflows.length === 0 &&
    members.length === 0 &&
    backgroundTasks.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Session hierarchy">
      {backgroundTasks.length > 0 ? (
        <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
          <div className="mb-1 text-label font-semibold uppercase tracking-wide text-muted-foreground">
            Tasks ({backgroundTasks.length})
          </div>
          <ul className="flex flex-col gap-0.5">
            {backgroundTasks.map((task) => {
              const title = task.title || task.command || task.taskId;
              const elapsed = formatElapsed(task.elapsedMs);
              const badge =
                (task.lineCount ?? 0) > 0
                  ? `(${task.lineCount}${task.truncated ? "+" : ""})`
                  : "";
              const meta = [
                task.kind === "monitor" ? "monitor" : null,
                taskStatusLabel(task.status),
                elapsed,
                badge,
              ]
                .filter(Boolean)
                .join(" · ");
              const selected = selectedTaskId === task.taskId;
              const rowClass = cn(
                "flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-0.5 text-left text-body",
                "transition-colors duration-150 ease-fluid",
                selected
                  ? "bg-accent text-foreground"
                  : "hover:bg-accent/50",
              );
              const metaClass = cn(
                "shrink-0 font-mono text-label",
                task.status === "failed"
                  ? "text-destructive"
                  : task.status === "running" || task.status === "killing"
                    ? "text-muted-foreground"
                    : "text-subtle-foreground",
              );
              return (
                <li key={task.taskId}>
                  {onSelectTask ? (
                    <button
                      type="button"
                      className={rowClass}
                      aria-pressed={selected}
                      aria-label={`Show log for ${title}`}
                      onClick={() => onSelectTask(task.taskId)}
                    >
                      <span className="min-w-0 truncate font-medium">{title}</span>
                      <span className={metaClass}>{meta}</span>
                    </button>
                  ) : (
                    <div className={rowClass}>
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {title}
                      </span>
                      <span className={metaClass}>{meta}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {workflows.map((workflow) => {
        const trail = (workflow.phases ?? [])
          .map((phase) => `${phase.title} ${phaseMark(phase.state)}`)
          .join(" · ");
        const agents =
          workflow.agentsUsed !== undefined
            ? workflow.agentBudget !== undefined
              ? `${workflow.agentsUsed}/${workflow.agentBudget} agents`
              : `${workflow.agentsUsed} agents`
            : "";
        const elapsed = formatElapsed(workflow.elapsedMs);
        const meta = [workflow.status, agents, elapsed].filter(Boolean).join(" · ");
        return (
          <div
            key={workflow.runId}
            className="rounded-lg border border-border/60 bg-secondary/40 px-3 py-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-label font-semibold uppercase tracking-wide text-muted-foreground">
                Workflow
              </span>
              <span className="text-body font-medium text-foreground">
                {workflow.name || workflow.runId}
              </span>
              {meta.length > 0 ? (
                <span className="font-mono text-label text-subtle-foreground">{meta}</span>
              ) : null}
            </div>
            {workflow.objective ? (
              <p className="mt-0.5 line-clamp-2 text-body text-muted-foreground">
                {workflow.objective}
              </p>
            ) : null}
            {trail.length > 0 ? (
              <p className="mt-1 font-mono text-label text-subtle-foreground">[{trail}]</p>
            ) : null}
          </div>
        );
      })}

      {members.length > 0 ? (
        <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
          <div className="mb-1 text-label font-semibold uppercase tracking-wide text-muted-foreground">
            Nested agents ({members.length})
          </div>
          <ul className="flex flex-col gap-0.5">
            {members.map((member) => {
              const label = member.label || member.title || member.id;
              const status = member.status || "unknown";
              return (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-2 text-body"
                >
                  <span className="min-w-0 truncate text-foreground">{label}</span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-label",
                      status === "completed" || status === "done"
                        ? "text-subtle-foreground"
                        : status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {status}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
