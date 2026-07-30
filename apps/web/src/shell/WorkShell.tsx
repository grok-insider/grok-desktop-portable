/**
 * Chrome shared by every Work surface once the browser is paired.
 *
 * Keeps the topbar predictable (DESIGN.md §6): product label, optional
 * workspace chip (display name only), and status chips that always carry a
 * text label (DESIGN.md §2 — status is never colour alone).
 *
 * Chips are shown only when the state is *not* the resting one. A permanent
 * green "Connected" and a permanent "Idle" trained the eye to skip that corner,
 * which is exactly where a disconnect or an interruption has to be noticed.
 * Nothing is lost for assistive tech: the polite live region below still says
 * both states on every change.
 *
 * The content sits on a raised surface inset from the canvas, so the app reads
 * as one sheet of paper on a workspace rather than a page that runs to the
 * window edge.
 */

import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { StatusChip } from "../components/ui";
import { ThemeToggle } from "../theme/ThemeToggle";
import type { SessionPhase } from "../views/SessionView";

export function WorkShell({
  title = "Work",
  workspaceName,
  phase,
  connected,
  trailing,
  children,
}: {
  title?: string;
  /** Host-projected label only — never a filesystem path. */
  workspaceName?: string;
  phase?: SessionPhase;
  connected: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh min-h-dvh flex-col bg-background p-2 max-[680px]:h-auto max-[680px]:p-0">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-raised max-[680px]:rounded-none max-[680px]:border-x-0">
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            {/*
              Chrome, not the document heading. Each surface owns its own `h1`,
              so making this one too would leave every page with two and no
              reliable heading order for a screen reader.
            */}
            <p className="shrink-0 text-body font-semibold text-foreground">{title}</p>
            {workspaceName === undefined || workspaceName.length === 0 ? null : (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-body-sm text-muted-foreground"
                title={workspaceName}
              >
                <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{workspaceName}</span>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {trailing}
            {/* Idle is the resting state and draws nothing. */}
            {phase === "streaming" ? (
              <StatusChip tone="info">Running</StatusChip>
            ) : phase === "interrupted" ? (
              <StatusChip tone="warning">Needs review</StatusChip>
            ) : null}
            {connected ? null : <StatusChip tone="destructive">Disconnected</StatusChip>}
            <ThemeToggle />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
      {/* Polite status for assistive tech when connection or phase changes. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {connected ? "Connected to host." : "Disconnected from host."}
        {phase === "streaming"
          ? " Agent is running."
          : phase === "interrupted"
            ? " Action needs review."
            : phase === "idle"
              ? " Ready."
              : ""}
      </div>
    </div>
  );
}
