/**
 * Parent-scoped workflow + nested-agent strip (CLI-inspired, not a full TUI).
 *
 * Renders phase trail and member roster from sessionSnapshot hierarchy fields.
 * Children never become home-rail peers (ADR 0017).
 */

import type { SnapshotMember, SnapshotWorkflow } from "../services/protocol";
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

export function WorkflowStrip({
  workflows,
  members,
}: {
  workflows: SnapshotWorkflow[];
  members: SnapshotMember[];
}) {
  if (workflows.length === 0 && members.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" aria-label="Session hierarchy">
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
