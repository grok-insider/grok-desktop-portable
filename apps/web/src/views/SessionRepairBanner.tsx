/**
 * Opt-in recovery for tool-pairing history that may be bricked.
 *
 * Dry-run may be automatic when a conversation settles; **apply** never is.
 * Never offers retry of interrupted side effects. Copy must not claim
 * filesystem undo — only agent history pairing repair (ADR 0015).
 */

import { AlertTriangle, Wrench } from "lucide-react";
import { Button, Card } from "../components/ui";
import type { RepairReport, SessionDiagnosis } from "../services/outcomes";

function reportSummary(report: RepairReport): string {
  const parts: string[] = [];
  if (report.duplicatesRemoved > 0) {
    parts.push(
      `${report.duplicatesRemoved} duplicate tool result${report.duplicatesRemoved === 1 ? "" : "s"}`,
    );
  }
  if (report.syntheticResultsInserted > 0) {
    parts.push(
      `${report.syntheticResultsInserted} synthetic result${report.syntheticResultsInserted === 1 ? "" : "s"}`,
    );
  }
  if (report.strippedToolResultIds.length > 0) {
    parts.push(
      `${report.strippedToolResultIds.length} orphan result id${report.strippedToolResultIds.length === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) {
    return report.repaired
      ? "Pairing fixes were reported."
      : "No pairing issues found.";
  }
  return parts.join(", ");
}

export function SessionRepairBanner({
  diagnosis,
  busy,
  onDiagnose,
  onRepair,
  onDismiss,
}: {
  diagnosis: SessionDiagnosis | null;
  busy: boolean;
  onDiagnose: () => void;
  onRepair: () => void;
  onDismiss: () => void;
}) {
  if (diagnosis === null) {
    return null;
  }

  if (diagnosis.status === "healthy") {
    return (
      <Card className="border-border px-3 py-2.5">
        <p className="text-body text-muted-foreground">
          Conversation history pairing looks healthy.
        </p>
        <div className="mt-2">
          <Button variant="ghost" onClick={onDismiss} disabled={busy}>
            Dismiss
          </Button>
        </div>
      </Card>
    );
  }

  if (diagnosis.status === "unsupported") {
    return (
      <Card className="border-border px-3 py-2.5">
        <div className="flex gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-foreground">
              History repair is not available
            </p>
            <p className="mt-1 text-body-sm text-muted-foreground">
              This Grok Build CLI does not expose out-of-band history repair.
              Update the CLI, or recover the session from the terminal. This is
              not the same as reviewing an interrupted action.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" onClick={onDismiss} disabled={busy}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // corrupt
  const report = diagnosis.report ?? null;
  return (
    <Card className="border-warning/40 px-3 py-2.5">
      <div className="flex gap-2">
        <Wrench size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-foreground">
            This conversation may not continue reliably
          </p>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Tool-pairing history looks corrupted
            {report ? ` (${reportSummary(report)})` : ""}. Repair rewrites agent
            history only — it does not undo file changes and is not a retry of
            an interrupted action.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onDiagnose} disabled={busy}>
              Check again
            </Button>
            <Button variant="primary" onClick={onRepair} disabled={busy}>
              {busy ? "Repairing…" : "Repair history"}
            </Button>
            <Button variant="ghost" onClick={onDismiss} disabled={busy}>
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
