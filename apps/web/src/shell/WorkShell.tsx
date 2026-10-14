/**
 * Chrome shared by every Work surface once the browser is paired.
 *
 * Top bar (browser-tab style, inspired by OpenCode):
 *   [Home] | [open chat tabs…] [+]     … status chips, theme
 *
 * Home returns to the project + session catalogue. Open conversations are
 * tabs (order never reshuffles with activity — same rule as the old sidebar).
 * Status chips still only draw when not resting (DESIGN.md §2 / docs/ui.md).
 *
 * The content sits on a raised surface inset from the canvas, so the app reads
 * as one sheet of paper on a workspace rather than a page that runs to the
 * window edge.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FolderOpen, Home, Plus, X } from "lucide-react";
import { IconButton, StatusChip, cn } from "../components/ui";
import { ThemeToggle } from "../theme/ThemeToggle";
import type { SessionPhase } from "../views/SessionView";

/** One open conversation shown as a top-bar tab. */
export interface WorkShellTab {
  sessionId: string;
  /** Opening-message subject (or “New conversation”). */
  title: string;
  /** Host-projected display name only — never a filesystem path. */
  workspaceName?: string;
  running?: boolean;
  awaitingDecision?: boolean;
}

export function WorkShell({
  surface = "home",
  onGoHome,
  tabs = [],
  activeTabId = null,
  onSelectTab,
  onCloseTab,
  onNewTab,
  phase,
  connected,
  canControl = true,
  showThemeControl = true,
  trailing,
  children,
}: {
  /** Which surface is active: home catalogue vs an open conversation. */
  surface?: "home" | "session";
  onGoHome?: () => void;
  /** Open conversations, host-ordered (light ADR 0011). */
  tabs?: WorkShellTab[];
  activeTabId?: string | null;
  onSelectTab?: (sessionId: string) => void;
  onCloseTab?: (sessionId: string) => void;
  /** Go home (or open the catalogue) to start another conversation. */
  onNewTab?: () => void;
  phase?: SessionPhase;
  connected: boolean;
  canControl?: boolean;
  showThemeControl?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const homeActive = surface === "home";
  const showTabs = tabs.length > 0 || onNewTab !== undefined;
  const tablist = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = tablist.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
    if (!list || !active) return;
    const parent = list.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.left < parent.left) list.scrollLeft -= parent.left - item.left;
    else if (item.right > parent.right) list.scrollLeft += item.right - parent.right;
  }, [activeTabId, surface, tabs.length]);

  return (
    <div className="work-shell flex h-dvh min-h-dvh flex-col bg-background max-[680px]:h-auto">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="work-header flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          {/*
            Chrome, not the document heading. Each surface owns its own `h1`,
            so making this one too would leave every page with two and no
            reliable heading order for a screen reader.
          */}
          <button
            type="button"
            onClick={onGoHome}
            aria-label="Home"
            aria-current={homeActive ? "page" : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-body font-medium transition-colors",
              homeActive
                ? "bg-accent text-foreground shadow-[inset_0_-2px_0_var(--brand-ink)]"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Home size={14} className="shrink-0" aria-hidden="true" />
            <span className="max-[680px]:sr-only">Home</span>
          </button>

          {showTabs ? (
            <>
              <span
                className="mx-1 h-5 w-px shrink-0 bg-border"
                aria-hidden="true"
              />
              <div
                ref={tablist}
                role="tablist"
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
                aria-label="Open conversations"
              >
                {tabs.map((tab) => {
                  const active =
                    surface === "session" && tab.sessionId === activeTabId;
                  return (
                    <div
                      key={tab.sessionId}
                      className={cn(
                        "group flex h-8 max-w-[14rem] shrink-0 items-center gap-0.5 rounded-md pl-2 pr-0.5",
                        active
                          ? "bg-accent text-foreground shadow-[inset_0_-2px_0_var(--brand-ink)]"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        role="tab"
                        id={`work-tab-${tab.sessionId}`}
                        onClick={() => onSelectTab?.(tab.sessionId)}
                        aria-selected={active}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        title={
                          tab.workspaceName
                            ? `${tab.title} · ${tab.workspaceName}`
                            : tab.title
                        }
                      >
                        <FolderOpen
                          size={12}
                          className="shrink-0 opacity-70"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-body">
                          {tab.title}
                        </span>
                        {tab.awaitingDecision === true ? (
                          <StatusChip tone="warning">Needs you</StatusChip>
                        ) : tab.running ? (
                          <StatusChip tone="info">Working</StatusChip>
                        ) : null}
                      </button>
                      <IconButton
                        size="sm"
                        onClick={() => onCloseTab?.(tab.sessionId)}
                        disabled={!connected || !canControl}
                        aria-label={`Close ${tab.title}`}
                        className={cn(
                          "size-6 shrink-0",
                          active
                            ? "opacity-70 hover:opacity-100"
                            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                        )}
                      >
                        <X size={12} aria-hidden="true" />
                      </IconButton>
                    </div>
                  );
                })}
                {onNewTab !== undefined ? (
                  <IconButton
                    size="sm"
                    onClick={onNewTab}
                    aria-label="Start a new conversation"
                    className="ml-0.5 size-7 shrink-0 text-muted-foreground"
                  >
                    <Plus size={14} aria-hidden="true" />
                  </IconButton>
                ) : null}
              </div>
            </>
          ) : (
            <div className="min-w-0 flex-1" />
          )}

          <div className="work-header-actions flex shrink-0 items-center gap-1.5 pl-1">
            {trailing}
            {showThemeControl && <ThemeToggle />}
          </div>
          {(phase === "streaming" || phase === "interrupted" || !connected) && <div className="work-header-status flex shrink-0 items-center gap-1.5">
            {phase === "streaming" ? (
              <StatusChip tone="info">Running</StatusChip>
            ) : phase === "interrupted" ? (
              <StatusChip tone="warning">Needs review</StatusChip>
            ) : null}
            {connected ? null : <StatusChip tone="destructive">Disconnected</StatusChip>}
          </div>}
        </header>
        <div className={cn("flex min-h-0 flex-1 flex-col", surface === "session" && "overflow-y-auto")}>{children}</div>
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
