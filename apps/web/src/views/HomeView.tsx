/**
 * Home: the projects rail beside the sessions of the selected project.
 *
 * This used to be two screens — a Projects page that navigated to a Sessions
 * page — which meant choosing where to work and choosing what to resume could
 * never be seen at once, and every project switch cost a round trip through a
 * back link. They are one screen because they are one decision.
 *
 * The rail is the set of projects opened in Light, not an inventory of the
 * user's GROK_HOME. Listing every folder the Grok Build CLI had touched put a
 * long tail of one-off directories above the two the user actually works in,
 * and disclosed their names to the browser for no gain (light ADR 0014).
 * Enrolment is the host picker or `grok-light workspace add`; the browser
 * never names a directory and only sends opaque ids (light ADR 0009).
 */

import { useMemo, useState, type ReactNode } from "react";
import { FolderOpen, FolderPlus, History, Plus, RefreshCw } from "lucide-react";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  IconButton,
  Row,
  SearchField,
  SectionLabel,
  StatusChip,
  cn,
} from "../components/ui";
import type { ProjectProjection, SessionSummary } from "../services/outcomes";

/** A workspace as the host projects it: no path, ever. */
export interface WorkspaceSummary {
  id: string;
  displayName: string;
  available: boolean;
  sessionCount?: number;
  lastActiveAt?: string;
}

/** Sessions bucketed by when they were last touched. */
export interface SessionGroup {
  label: string;
  sessions: SessionSummary[];
}

/**
 * Bucket sessions into Today / Yesterday / Older.
 *
 * A flat list of forty timestamps is not scannable; the boundary a user
 * actually reasons about is "was this today". Anything the host could not date
 * falls to Older rather than being hidden or promoted.
 *
 * `now` is a parameter so the boundary is testable without freezing the clock.
 */
export function groupSessionsByDay(
  sessions: SessionSummary[],
  now: Date = new Date(),
): SessionGroup[] {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const today: SessionSummary[] = [];
  const yesterday: SessionSummary[] = [];
  const older: SessionSummary[] = [];

  for (const session of sessions) {
    const stamp = Date.parse(session.updatedAt);
    if (Number.isNaN(stamp) || stamp < startOfYesterday) {
      older.push(session);
    } else if (stamp >= startOfToday) {
      today.push(session);
    } else {
      yesterday.push(session);
    }
  }

  return [
    { label: "Today", sessions: today },
    { label: "Yesterday", sessions: yesterday },
    { label: "Older", sessions: older },
  ].filter((group) => group.sessions.length > 0);
}

/** `2026-07-29T11:17:39.746Z` → `11:17`, and nothing at all if undated. */
function timeOfDay(updatedAt: string): string {
  const stamp = Date.parse(updatedAt);
  if (Number.isNaN(stamp)) {
    return "";
  }
  return new Date(stamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * `2026-07-12T22:59:00Z` → `Jul 12`, or `Jul 12, 2025` across a year boundary.
 *
 * Only the Older bucket needs this. "Older" spanned everything from two days
 * ago to two years ago, and a bare clock time on those rows told the user the
 * one thing they already knew was useless. Today and Yesterday keep the clock
 * alone: the heading already carries the date.
 */
export function dayStamp(updatedAt: string, now: Date = new Date()): string {
  const stamp = Date.parse(updatedAt);
  if (Number.isNaN(stamp)) {
    return "";
  }
  const when = new Date(stamp);
  return when.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function HomeView({
  workspaces,
  projects,
  sessions,
  selectedWorkspaceId,
  selectedWorkspaceName,
  busy,
  error,
  banner,
  onOpenPicker,
  onRefreshProjects,
  onRefreshSessions,
  onSelectProject,
  onNewSession,
  onResumeSession,
}: {
  workspaces: WorkspaceSummary[];
  /** Session-store projects when the host provides them; otherwise derived. */
  projects?: ProjectProjection[];
  sessions: SessionSummary[];
  selectedWorkspaceId: string | null;
  selectedWorkspaceName?: string;
  busy: boolean;
  error?: string;
  /** Review records and other full-width notices, above the grid. */
  banner?: ReactNode;
  onOpenPicker: () => void;
  onRefreshProjects: () => void;
  onRefreshSessions: () => void;
  /** Select an already-enrolled workspace. */
  onSelectProject: (workspaceId: string) => void;
  onNewSession: () => void;
  onResumeSession: (sessionId: string) => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");

  const rows = useMemo(() => {
    const fromHost =
      projects !== undefined && projects.length > 0
        ? projects
        : workspaces.map(
            (workspace): ProjectProjection => ({
              projectId: workspace.id,
              displayName: workspace.displayName,
              sessionCount: workspace.sessionCount ?? 0,
              lastActiveAt: workspace.lastActiveAt ?? "",
              available: workspace.available,
              workspaceId: workspace.id,
            }),
          );
    const needle = projectQuery.trim().toLowerCase();
    if (needle.length === 0) {
      return fromHost;
    }
    return fromHost.filter((project) =>
      project.displayName.toLowerCase().includes(needle),
    );
  }, [projects, workspaces, projectQuery]);

  const groups = useMemo(() => {
    const needle = sessionQuery.trim().toLowerCase();
    const matching =
      needle.length === 0
        ? sessions
        : sessions.filter((session) =>
            session.title.toLowerCase().includes(needle),
          );
    return groupSessionsByDay(matching);
  }, [sessions, sessionQuery]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/*
        Left-aligned, not centred. Centring a 1024px column on a wide display
        pushed the projects rail into the middle of the screen — the rail is
        navigation, and navigation belongs against the edge the eye starts at.
        The cap only stops the sessions list from running to a 4K edge.
      */}
      <div className="w-full max-w-[1440px] px-6 py-8">
        {banner}
        {error === undefined ? null : (
          <p
            role="alert"
            className="mb-4 rounded-md bg-destructive-soft px-3 py-2 text-body text-destructive"
          >
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/*
            The rail keeps its own scroll and stays put. Thirty projects in
            page flow pushed the sessions column — the thing the user came for
            — a screen and a half below the fold.
          */}
          <aside
            className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-0 lg:h-[calc(100dvh-8rem)] lg:self-start"
            aria-label="Projects"
          >
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 pl-1.5">
              <SectionLabel>Projects</SectionLabel>
              <span className="flex items-center gap-0.5">
                <IconButton
                  size="sm"
                  aria-label="Refresh projects"
                  onClick={onRefreshProjects}
                  disabled={busy}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label="Add a project"
                  onClick={onOpenPicker}
                  disabled={busy}
                >
                  <FolderPlus size={14} aria-hidden="true" />
                </IconButton>
              </span>
            </div>

            <SearchField
              label="Search projects"
              value={projectQuery}
              onValueChange={setProjectQuery}
              className="shrink-0"
            />

            {rows.length === 0 ? (
              <div className="flex flex-col gap-3 px-1.5 py-4">
                <p className="text-body-sm text-muted-foreground">
                  {projectQuery.trim().length > 0
                    ? "No project matches that."
                    : "Nothing enrolled yet. The host chooses the directory and hands back an identifier — Light cannot read a path you type."}
                </p>
                {projectQuery.trim().length > 0 ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onOpenPicker}
                    disabled={busy}
                    className="self-start"
                  >
                    <FolderPlus size={14} aria-hidden="true" />
                    Choose a directory
                  </Button>
                )}
                <p className="font-mono text-label text-subtle-foreground">
                  or: grok-light workspace add &lt;path&gt;
                </p>
              </div>
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {rows.map((project) => {
                  const letter = project.displayName.charAt(0).toUpperCase() || "P";
                  const selected = project.workspaceId === selectedWorkspaceId;
                  return (
                    <li key={project.projectId}>
                      <Row
                        selected={selected}
                        disabled={busy || !project.available}
                        aria-label={`Open project ${project.displayName}`}
                        title={
                          project.available
                            ? undefined
                            : "This directory is no longer available."
                        }
                        onClick={() => onSelectProject(project.workspaceId)}
                        className="h-9 gap-2 px-1.5"
                      >
                        <span
                          className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-accent text-label font-semibold text-accent-foreground"
                          aria-hidden="true"
                        >
                          {letter}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-body",
                            selected
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {project.displayName}
                        </span>
                        {/* Ready is the resting state and draws nothing; only a
                            directory that has gone away is worth a chip. */}
                        {project.available ? null : (
                          <StatusChip tone="warning">Unavailable</StatusChip>
                        )}
                      </Row>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="shrink-0">
              <Disclosure>
                Grok Light runs the agent with your own authority and your own
                Grok configuration. It is a control surface, not a sandbox.
              </Disclosure>
            </div>
          </aside>

          <section className="flex min-w-0 flex-col gap-4">
            {selectedWorkspaceId === null ? (
              <Card>
                <EmptyState
                  icon={<FolderOpen size={24} />}
                  title="Pick a project"
                  description="Choose a folder on the left to see the sessions Grok already has for it, or start a new one."
                />
              </Card>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h1 className="min-w-0 truncate text-title-sm font-semibold text-foreground">
                    {selectedWorkspaceName ?? "Workspace"}
                  </h1>
                  <span className="flex shrink-0 items-center gap-1">
                    <IconButton
                      size="sm"
                      aria-label="Refresh sessions"
                      onClick={onRefreshSessions}
                      disabled={busy}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                    </IconButton>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={onNewSession}
                      disabled={busy}
                    >
                      <Plus size={14} aria-hidden="true" />
                      New session
                    </Button>
                  </span>
                </div>

                <SearchField
                  label="Search sessions"
                  value={sessionQuery}
                  onValueChange={setSessionQuery}
                />

                {groups.length === 0 ? (
                  <EmptyState
                    icon={<History size={24} />}
                    title={
                      sessionQuery.trim().length > 0
                        ? "No matching sessions"
                        : "No sessions yet"
                    }
                    description={
                      sessionQuery.trim().length > 0
                        ? "Try another search, or start a new session."
                        : "Nothing is stored for this project under your Grok home. Start a new session to begin."
                    }
                    action={
                      sessionQuery.trim().length > 0 ? undefined : (
                        <Button
                          variant="primary"
                          onClick={onNewSession}
                          disabled={busy}
                        >
                          <Plus size={14} aria-hidden="true" />
                          New session
                        </Button>
                      )
                    }
                  />
                ) : (
                  groups.map((group) => (
                    <div key={group.label} className="flex flex-col gap-1">
                      <div className="sticky top-0 z-10 bg-card pb-1 pl-1.5 pt-1">
                        <SectionLabel>{group.label}</SectionLabel>
                      </div>
                      <ul className="flex flex-col gap-0.5" aria-label={group.label}>
                        {group.sessions.map((session) => {
                          const title =
                            session.title.length > 0
                              ? session.title
                              : "Untitled session";
                          const at = timeOfDay(session.updatedAt);
                          const on =
                            group.label === "Older"
                              ? dayStamp(session.updatedAt)
                              : "";
                          return (
                            <li key={session.id}>
                              {/* The row is the action. A per-row Resume button
                                  turned a list of sixteen sessions into a
                                  column of sixteen filled buttons. */}
                              <Row
                                disabled={busy}
                                aria-label={`Resume ${title}`}
                                onClick={() => onResumeSession(session.id)}
                                className="h-10 gap-3 px-1.5"
                              >
                                <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                                  {title}
                                </span>
                                {session.messageCount === 0 ? (
                                  <span className="w-16 shrink-0 whitespace-nowrap text-right text-label text-subtle-foreground">
                                    Empty
                                  </span>
                                ) : (
                                  <span className="w-16 shrink-0 whitespace-nowrap text-right font-mono text-label text-subtle-foreground">
                                    {session.messageCount} msgs
                                  </span>
                                )}
                                {on.length === 0 ? null : (
                                  /* Older only: "was this last week or last
                                     year" is unanswerable from a clock alone.
                                     Undated rows draw neither column, as
                                     before. */
                                  <span className="w-24 shrink-0 whitespace-nowrap text-right font-mono text-label text-subtle-foreground">
                                    {on}
                                  </span>
                                )}
                                {at.length === 0 ? null : (
                                  /* Wide enough for a 12-hour clock: `02:47 PM`
                                     wrapped to two lines in a narrower column
                                     and doubled the row height. */
                                  <span className="w-20 shrink-0 whitespace-nowrap text-right font-mono text-label text-subtle-foreground">
                                    {at}
                                  </span>
                                )}
                              </Row>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
