/**
 * The open conversations, as a work inbox rather than a chat history.
 *
 * Two rules carry the whole feel, both borrowed from T3 Code's Sidebar V2
 * (MIT) and kept deliberately:
 *
 * 1. **Order never changes with activity.** Rows are ordered by when the
 *    session opened, so one keeps its place from the moment it appears until
 *    it is closed. Status is shown *in* the row, never by moving it. A list
 *    that reshuffles on every token is a feed, not an inbox.
 * 2. **State is colour and a label, never colour alone** (DESIGN.md §2).
 *
 * What is not borrowed: branch, pull request, and diff columns in each row.
 * Light keeps review data in the selected session's read-only right panel, so
 * activity cannot turn this navigation list into a second inspector.
 */

import { MessageSquare, Plus, X } from "lucide-react";
import type { SessionProjection } from "../services/outcomes";
import { IconButton, SectionLabel, StatusChip, cn, rowClass } from "../components/ui";

export function SessionSidebar({
  sessions,
  activeSessionId,
  titles,
  onSelect,
  onClose,
  onNew,
}: {
  sessions: SessionProjection[];
  activeSessionId: string | null;
  /**
   * What each conversation is about, keyed by session id.
   *
   * Several conversations commonly run in the same workspace, so labelling
   * rows by workspace alone makes them indistinguishable. A conversation that
   * has not been given a subject yet says so rather than borrowing one.
   */
  titles: Record<string, string>;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}) {
  return (
    <aside
      className="flex w-[248px] shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-2 py-2 text-sidebar-foreground"
      aria-label="Open conversations"
    >
      <div className="flex h-9 items-center justify-between gap-2 pl-1.5">
        <SectionLabel>Conversations</SectionLabel>
        <IconButton
          size="sm"
          onClick={onNew}
          aria-label="Start a new conversation"
          className="text-sidebar-foreground"
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {sessions.length === 0 ? (
        <p className="px-1.5 text-body-sm text-muted-foreground">
          Nothing open. Start one to begin.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {sessions.map((session) => {
            const active = session.sessionId === activeSessionId;
            const title = titles[session.sessionId] ?? "New conversation";
            return (
              <li key={session.sessionId}>
                {/*
                  One line, not two. The second line existed to carry an "Idle"
                  label on every row, which doubled the height of the list to
                  say that nothing was happening.
                */}
                <div className={rowClass({ selected: active, className: "h-9 gap-1.5 px-1.5" })}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.sessionId)}
                    aria-current={active ? "true" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <MessageSquare
                      size={12}
                      className={cn(
                        "shrink-0",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-body",
                        active
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {title}
                    </span>
                    <span className="max-w-[6rem] shrink-0 truncate text-label text-subtle-foreground">
                      {session.workspaceName}
                    </span>
                    {/*
                      Precedence matters: a conversation blocked on the user
                      outranks one that is merely busy, because it is the only
                      state they can do something about. Idle draws nothing.
                    */}
                    {session.awaitingDecision === true ? (
                      <StatusChip tone="warning">Needs you</StatusChip>
                    ) : session.running ? (
                      <StatusChip tone="info">Working</StatusChip>
                    ) : null}
                  </button>
                  <IconButton
                    size="sm"
                    onClick={() => onClose(session.sessionId)}
                    aria-label={`Close ${title}`}
                    className="hover-reveal size-6 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
