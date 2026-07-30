/**
 * The Work session: transcript, composer, and interrupted review.
 *
 * Reading measure follows DESIGN.md §6 (65–75ch, centred). Streaming shows a
 * caret and a status chip, never bouncing dots (§7). Agent text is markdown;
 * user text stays plain.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, MessagesSquare, PanelRight } from "lucide-react";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { Button, Card, EmptyState, IconButton, cn } from "../components/ui";
import {
  reviewCauseMessage,
  type SessionChangesProjection,
  type SessionInspectorProjection,
  type SessionProjection,
} from "../services/outcomes";
import type { ModelProjection } from "../services/models";
import type { ContextEntry, ToolProjection } from "../services/outcomes";
import type { ChangeMode, CommandProjection } from "../services/protocol";
import {
  captureScrollMemory,
  isStuckToBottom,
  restoreScrollTop,
  type SessionScrollMemory,
} from "../services/transcriptScroll";
import { SessionComposer } from "./composer/SessionComposer";
import { SessionSidebar } from "./SessionSidebar";
import { SessionReviewPanel } from "./SessionReviewPanel";
import { PlanRow } from "./PlanRow";
import { SessionRepairBanner } from "./SessionRepairBanner";
import { ToolRow } from "./ToolRow";
import {
  checkpointPreview,
  TranscriptCheckpoints,
} from "./TranscriptCheckpoints";
import { WorkShell } from "../shell/WorkShell";
import type { PlanEntryProjection } from "../services/protocol";
import type { SessionDiagnosis } from "../services/outcomes";

/**
 * Where something sits in the conversation.
 *
 * Messages and tool calls arrive on one ordered event stream but were folded
 * into two independent arrays, so the transcript could only ever show every
 * message and then every tool call — a user could not tell which turn ran a
 * command. Carrying the host's event sequence on both lets the view put them
 * back in the order they happened.
 */
export interface Sequenced {
  seq: number;
}

/** One rendered turn in the transcript. */
export interface TranscriptEntry extends Sequenced {
  id: string;
  role: "user" | "agent";
  text: string;
}

/** A tool call the agent reported. */
export interface ToolEntry extends Sequenced {
  id: string;
  /** What the agent called it, refined once the call resolves. */
  name: string;
  /** read | edit | execute | search | think | fetch | other. */
  action: string;
  /** Whether the agent declares the call cannot change anything. */
  readOnly: boolean;
  /** The MCP server it came from, when it is not the agent's own toolset. */
  provider?: string | null;
  /** One line saying what it acted on. Agent text: rendered, never parsed. */
  detail?: string | null;
  finished: boolean;
  failed: boolean;
  truncated: boolean;
}

/**
 * An ambiguous effect awaiting human review.
 *
 * `operation` and `cause` come from the host's journal. They are what makes
 * the record actionable — without them the user is told something happened but
 * not what to go and check — so they are shown whenever the host supplies them.
 */
export interface ReviewRecord {
  recordId: string;
  operation?: string;
  /** Conversation it belonged to, so the user can be taken there. */
  sessionId?: string | null;
  cause?: string;
}

export type SessionPhase = "idle" | "streaming" | "interrupted";

export function SessionView({
  transcript,
  tools,
  reviews,
  phase,
  plan = [],
  sessionLoading = false,
  diagnosis = null,
  repairBusy = false,
  onDiagnoseSession,
  onRepairSession,
  onDismissDiagnosis,
  connected,
  workspaceName,
  sessions,
  activeSessionId,
  sessionTitles,
  draft,
  onDraftChange,
  queued,
  onSendNow,
  onRemoveQueued,
  onSelectSession,
  onCloseSession,
  onLeaveSession,
  connectionBanner,
  hostMessage,
  onPrompt,
  onCancel,
  onAcknowledge,
  models = [],
  modelId = null,
  effortId = null,
  onModelChange,
  onEffortChange,
  configTools = [],
  commands = [],
  contextEntries = [],
  contextLoading = false,
  onContextQuery,
  reviewPanelOpen = false,
  onReviewPanelOpenChange,
  inspector = null,
  changes = null,
  inspectorLoading = false,
  changesLoading = false,
  changeMode = "git",
  onChangeMode,
}: {
  transcript: TranscriptEntry[];
  tools: ToolEntry[];
  reviews: ReviewRecord[];
  phase: SessionPhase;
  /** Latest agent plan steps; empty when the agent has not published one. */
  plan?: PlanEntryProjection[];
  /** True while create/load is in flight so the empty state does not flash. */
  sessionLoading?: boolean;
  /** Optional history-pairing diagnosis for this conversation. */
  diagnosis?: SessionDiagnosis | null;
  repairBusy?: boolean;
  onDiagnoseSession?: () => void;
  onRepairSession?: () => void;
  onDismissDiagnosis?: () => void;
  connected: boolean;
  /** Host-projected display name only — never a filesystem path. */
  workspaceName?: string;
  /** Every open conversation, host-ordered (light ADR 0011). */
  sessions: SessionProjection[];
  activeSessionId: string | null;
  /** What each conversation is about, keyed by session id. */
  sessionTitles: Record<string, string>;
  /**
   * The composer's text for the conversation on screen.
   *
   * Owned by the caller and keyed by conversation, because a draft belongs to
   * the conversation it was written in. Held locally it survived a switch and
   * could be sent to a conversation the user was not looking at when they
   * wrote it.
   */
  draft: string;
  onDraftChange: (text: string) => void;
  /** Messages waiting for the turn in flight, in the order they were sent. */
  queued: { entryId: string; text: string }[];
  /** Stop the current turn and run this message next. */
  onSendNow: (text: string) => void;
  onRemoveQueued: (entryId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** Leave the transcript without closing anything. */
  onLeaveSession: () => void;
  connectionBanner?: ReactNode;
  /** Host-level error or refusal shown above the transcript. */
  hostMessage?: string;
  onPrompt: (text: string) => void;
  onCancel: () => void;
  onAcknowledge: (recordId: string) => void;
  models?: ModelProjection[];
  modelId?: string | null;
  effortId?: string | null;
  onModelChange?: (modelId: string) => void;
  onEffortChange?: (effortId: string) => void;
  /** Global/project configuration entries; the composer shows MCP names only. */
  configTools?: ToolProjection[];
  /** Slash commands the agent published for this conversation. */
  commands?: CommandProjection[];
  /** Workspace-relative paths for the `@` menu (light ADR 0013). */
  contextEntries?: ContextEntry[];
  contextLoading?: boolean;
  onContextQuery?: (query: string) => void;
  /** Whether the read-only Changes / Context panel is visible. */
  reviewPanelOpen?: boolean;
  onReviewPanelOpenChange?: (open: boolean) => void;
  inspector?: SessionInspectorProjection | null;
  changes?: SessionChangesProjection | null;
  inspectorLoading?: boolean;
  changesLoading?: boolean;
  changeMode?: ChangeMode;
  onChangeMode?: (mode: ChangeMode) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Per-session positions for this tab only — mirrors drafts, never host state.
  const scrollMemoryRef = useRef<Map<string, SessionScrollMemory>>(new Map());
  const previousSessionIdRef = useRef<string | null>(null);
  /** Session id we last applied a restore for (avoids re-jumping on stream). */
  const restoredForRef = useRef<string | null>(null);
  /**
   * Synchronous stick flag. React state alone races with the pin effect: when
   * switching chats the previous session's `stuckToBottom === true` still
   * applies for one paint and pins the *new* transcript to the end, then
   * overwrites that chat's memory. The ref is updated in layout before paint.
   */
  const stuckToBottomRef = useRef(true);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null);
  const lastAgentText = transcript.at(-1)?.role === "agent" ? transcript.at(-1)?.text : "";

  function setStuck(next: boolean) {
    stuckToBottomRef.current = next;
    setStuckToBottom(next);
  }

  /**
   * Messages and tool calls, back in the order they happened.
   *
   * They arrive on one ordered stream and are folded into two arrays, so the
   * view has to put them back together. Sorting on the host's event sequence
   * is stable and needs no extra protocol: a tool keeps the position of the
   * event that started it, so it lands under the turn that ran it.
   */
  const timeline = useMemo(() => {
    const entries = [
      ...transcript.map((entry) => ({ kind: "message" as const, entry })),
      ...tools.map((tool) => ({ kind: "tool" as const, tool })),
    ];
    return entries.toSorted((left, right) => {
      const a = left.kind === "message" ? left.entry.seq : left.tool.seq;
      const b = right.kind === "message" ? right.entry.seq : right.tool.seq;
      return a - b;
    });
  }, [transcript, tools]);

  const userCheckpoints = useMemo(
    () =>
      transcript
        .filter((entry) => entry.role === "user")
        .map((entry) => ({
          id: entry.id,
          preview: checkpointPreview(entry.text),
        })),
    [transcript],
  );

  /**
   * One bounded announcement for the most recent tool outcome.
   *
   * The list used to be a live region, so every row re-announced whenever any
   * one of them changed. Assistive tech needs the last change, not the log.
   */
  const lastToolOutcome = (() => {
    const finished = tools.filter((tool) => tool.finished).at(-1);
    if (finished === undefined) {
      return "";
    }
    if (finished.failed) {
      return `${finished.name} failed.`;
    }
    return finished.truncated
      ? `${finished.name} finished; output was truncated.`
      : `${finished.name} finished.`;
  })();

  function readScrollMetrics() {
    const element = scrollRef.current;
    if (element === null) {
      return null;
    }
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  }

  function escapeTurnId(id: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(id);
    }
    return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function rememberCurrentScroll() {
    if (activeSessionId === null) {
      return;
    }
    const metrics = readScrollMetrics();
    if (metrics === null) {
      return;
    }
    scrollMemoryRef.current.set(activeSessionId, captureScrollMemory(metrics));
  }

  function pinToEnd() {
    endRef.current?.scrollIntoView({ block: "end" });
    setStuck(true);
    // Persist after layout so the next visit to this chat returns to the end.
    requestAnimationFrame(() => rememberCurrentScroll());
  }

  function recomputeStuck() {
    const metrics = readScrollMetrics();
    if (metrics === null) {
      return;
    }
    const next = isStuckToBottom(metrics);
    if (stuckToBottomRef.current !== next) {
      setStuck(next);
    }
    rememberCurrentScroll();
  }

  function updateActiveCheckpoint() {
    const scroller = scrollRef.current;
    if (scroller === null || userCheckpoints.length === 0) {
      setActiveCheckpointId(null);
      return;
    }
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    let nearest: string | null = userCheckpoints[0]?.id ?? null;
    let best = Number.POSITIVE_INFINITY;
    for (const turn of userCheckpoints) {
      const node = scroller.querySelector<HTMLElement>(
        `[data-turn-id="${escapeTurnId(turn.id)}"]`,
      );
      if (node === null) {
        continue;
      }
      const top = node.offsetTop;
      const distance = Math.abs(top - mid);
      if (distance < best) {
        best = distance;
        nearest = turn.id;
      }
    }
    setActiveCheckpointId((current) => (current === nearest ? current : nearest));
  }

  // Drop memory for conversations that left the open set (same hygiene as drafts).
  useEffect(() => {
    const live = new Set(sessions.map((session) => session.sessionId));
    for (const key of scrollMemoryRef.current.keys()) {
      if (!live.has(key)) {
        scrollMemoryRef.current.delete(key);
      }
    }
  }, [sessions]);

  // Invalidate restore when the open conversation changes.
  useLayoutEffect(() => {
    if (previousSessionIdRef.current !== activeSessionId) {
      restoredForRef.current = null;
      previousSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId]);

  // Apply restore once per visit, after history is ready to measure.
  // Memory is written on scroll/pin while the chat is open — not on leave —
  // because the DOM already shows the *next* transcript by the time the id prop
  // changes.
  useLayoutEffect(() => {
    if (sessionLoading || activeSessionId === null) {
      return;
    }
    if (restoredForRef.current === activeSessionId) {
      return;
    }
    const scroller = scrollRef.current;
    if (scroller === null) {
      return;
    }
    const memory = scrollMemoryRef.current.get(activeSessionId);
    // Unstuck restores need real content height; wait for history to land.
    if (
      memory !== undefined &&
      !memory.stuckToBottom &&
      timeline.length === 0
    ) {
      return;
    }
    const metrics = {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    };
    const next = restoreScrollTop(memory, metrics);
    scroller.scrollTop = next.scrollTop;
    // Sync ref *before* paint so the pin effect cannot apply the previous
    // chat's stickiness to this transcript.
    setStuck(next.stuckToBottom);
    restoredForRef.current = activeSessionId;
    requestAnimationFrame(() => updateActiveCheckpoint());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per session visit, not on stream ticks
  }, [activeSessionId, sessionLoading, timeline.length]);

  // Follow the end only while *this* conversation is stuck. Use the ref, not
  // React state: state from the previous chat is still true for one effect
  // pass after a switch and would pin every newly selected chat to the end.
  useEffect(() => {
    if (activeSessionId === null) {
      return;
    }
    if (restoredForRef.current !== activeSessionId) {
      return;
    }
    if (!stuckToBottomRef.current) {
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
    requestAnimationFrame(() => rememberCurrentScroll());
  }, [transcript.length, lastAgentText, tools.length, phase, activeSessionId]);

  /**
   * Send, or queue behind the turn in flight.
   *
   * The host decides which: it holds the queue, because it is the one that
   * knows when a turn ends. Pressing Enter mid-turn used to do nothing at all
   * and say nothing about why.
   */
  function submit() {
    const text = draft.trim();
    if (text.length === 0 || text === "!") {
      return;
    }
    setStuck(true);
    onPrompt(text);
    // Cleared here rather than by the caller: this is the component that knows
    // the text left the composer.
    onDraftChange("");
  }

  /** Stop what is running so this message goes next. */
  function sendNow() {
    const text = draft.trim();
    if (text.length === 0 || text === "!") {
      return;
    }
    setStuck(true);
    onSendNow(text);
    onDraftChange("");
  }

  function jumpToTurn(id: string) {
    const scroller = scrollRef.current;
    const node = scroller?.querySelector<HTMLElement>(
      `[data-turn-id="${escapeTurnId(id)}"]`,
    );
    node?.scrollIntoView({ block: "start" });
    setStuck(false);
    setActiveCheckpointId(id);
    requestAnimationFrame(() => rememberCurrentScroll());
  }

  const lastAgentIndex = (() => {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      if (transcript[index]?.role === "agent") {
        return index;
      }
    }
    return -1;
  })();

  return (
    <WorkShell
      workspaceName={workspaceName}
      phase={phase}
      connected={connected}
      trailing={
        <IconButton
          size="sm"
          onClick={() => onReviewPanelOpenChange?.(!reviewPanelOpen)}
          aria-label={reviewPanelOpen ? "Close review panel" : "Open review panel"}
          aria-pressed={reviewPanelOpen}
        >
          <PanelRight size={14} aria-hidden="true" />
        </IconButton>
      }
    >
      {connectionBanner}
      <div className="relative flex min-h-0 flex-1">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          titles={sessionTitles}
          onSelect={onSelectSession}
          onClose={onCloseSession}
          onNew={onLeaveSession}
        />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <TranscriptCheckpoints
              turns={userCheckpoints}
              activeId={activeCheckpointId}
              onJump={jumpToTurn}
            />
            <div
              ref={scrollRef}
              // Extra right padding keeps the native scrollbar clear of the
              // compact checkpoint stack.
              className="h-full overflow-y-auto px-6 py-6 pr-8"
              onScroll={() => {
                recomputeStuck();
                updateActiveCheckpoint();
              }}
            >
            {/* Turns breathe; a tool call sits close to the turn that ran it,
                which is what the smaller gap on the tool row buys back. */}
            <div className="mx-auto flex w-[min(760px,100%)] flex-col gap-4">
              {/* The transcript is the page, so its heading is announced but not
                  drawn: a visible title would only repeat the topbar. */}
              <h1 className="sr-only">
                {workspaceName === undefined
                  ? "Work session"
                  : `Work session in ${workspaceName}`}
              </h1>
              {hostMessage === undefined ? null : (
                <p
                  role="alert"
                  className="rounded-md bg-destructive-soft px-3 py-2 text-body text-destructive"
                >
                  {hostMessage}
                </p>
              )}
              {reviews.length > 0 ? (
                <Card className="border-warning/40 bg-warning-soft">
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      size={16}
                      className="mt-0.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    <div className="flex flex-col gap-2">
                      <h2 className="text-body font-semibold text-warning">
                        {reviews.length === 1
                          ? "An action was interrupted"
                          : `${reviews.length} actions were interrupted`}
                      </h2>
                      <p className="text-body text-warning">
                        Grok Light does not know whether these finished, so it will not
                        retry them. Check the result in your workspace, then mark them
                        reviewed.
                      </p>
                      <ul className="flex flex-col gap-2">
                        {reviews.map((review) => (
                          <li
                            key={review.recordId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-card px-3 py-2"
                          >
                            <span className="text-body text-muted-foreground">
                              {review.operation === undefined ? (
                                "An action the host could not confirm"
                              ) : (
                                <>
                                  <span className="font-medium text-foreground">
                                    {review.operation}
                                  </span>
                                  {review.cause === undefined
                                    ? null
                                    : ` — ${reviewCauseMessage(review.cause)}`}
                                </>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              {review.sessionId == null ||
                              review.sessionId === activeSessionId ||
                              !sessions.some(
                                (open) => open.sessionId === review.sessionId,
                              ) ? null : (
                                <Button
                                  variant="ghost"
                                  onClick={() =>
                                    onSelectSession(review.sessionId as string)
                                  }
                                  aria-label={`Open the conversation this interrupted ${review.operation ?? "action"} belongs to`}
                                >
                                  Open it
                                </Button>
                              )}
                              <Button
                                variant="secondary"
                                onClick={() => onAcknowledge(review.recordId)}
                                aria-label={`Mark ${review.operation ?? "the interrupted action"} as reviewed`}
                              >
                                Mark reviewed
                              </Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </Card>
              ) : null}

              {sessionLoading && timeline.length === 0 && plan.length === 0 ? (
                <EmptyState
                  icon={<MessagesSquare size={24} />}
                  title="Opening conversation…"
                  description="Loading session state from the host. This is not an empty conversation."
                />
              ) : timeline.length === 0 && plan.length === 0 ? (
                <EmptyState
                  icon={<MessagesSquare size={24} />}
                  title="No messages yet"
                  description="Send a prompt and the agent will work in the enrolled directory, with your own authority."
                />
              ) : (
                <>
                {timeline.map((item) => {
                  if (item.kind === "tool") {
                    return <ToolRow key={`tool-${item.tool.id}`} tool={item.tool} />;
                  }
                  const entry = item.entry;
                  const isUser = entry.role === "user";
                  const streamingHere =
                    !isUser &&
                    phase === "streaming" &&
                    transcript.indexOf(entry) === lastAgentIndex;
                  return (
                    <article
                      key={entry.id}
                      data-turn-id={entry.id}
                      className={cn("flex flex-col", isUser && "items-end")}
                      aria-label={isUser ? "Your message" : "Agent message"}
                    >
                      {isUser ? (
                        /* The fill is the boundary: a border as well made every
                           turn read as a filed document. */
                        <div className="max-w-[min(82%,64ch)] rounded-lg bg-secondary px-3.5 py-2.5">
                          <p className="whitespace-pre-wrap text-body-lg text-foreground">
                            {entry.text}
                          </p>
                        </div>
                      ) : (
                        /* No card. The agent's answer is the page, not an
                           object on it — the reading measure already bounds it. */
                        <MarkdownMessage streaming={streamingHere}>
                          {entry.text}
                        </MarkdownMessage>
                      )}
                    </article>
                  );
                })}
                <PlanRow entries={plan} />
                </>
              )}

              {onDiagnoseSession != null && onRepairSession != null && onDismissDiagnosis != null ? (
                <div className="mt-3 flex flex-col gap-2">
                  {diagnosis == null ? (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        onClick={onDiagnoseSession}
                        disabled={repairBusy || sessionLoading}
                        aria-label="Check conversation history pairing"
                      >
                        Check history
                      </Button>
                    </div>
                  ) : (
                    <SessionRepairBanner
                      diagnosis={diagnosis}
                      busy={repairBusy}
                      onDiagnose={onDiagnoseSession}
                      onRepair={onRepairSession}
                      onDismiss={onDismissDiagnosis}
                    />
                  )}
                </div>
              ) : null}

              <div ref={endRef} />
            </div>
            </div>
            {stuckToBottom || timeline.length === 0 ? null : (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  className="pointer-events-auto shadow-overlay"
                  onClick={() => pinToEnd()}
                  aria-label="Jump to latest message"
                >
                  <ArrowDown size={14} aria-hidden="true" />
                  Latest
                </Button>
              </div>
            )}
          </div>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {lastToolOutcome}
          </div>

          <SessionComposer
            connected={connected}
            phase={phase}
            draft={draft}
            onDraftChange={onDraftChange}
            queued={queued}
            onRemoveQueued={onRemoveQueued}
            configTools={configTools}
            models={models}
            modelId={modelId}
            effortId={effortId}
            onModelChange={onModelChange ?? (() => {})}
            onEffortChange={onEffortChange ?? (() => {})}
            onSubmit={submit}
            onSendNow={sendNow}
            onCancel={onCancel}
            commands={commands}
            contextEntries={contextEntries}
            contextLoading={contextLoading}
            onContextQuery={onContextQuery}
          />
        </div>
        {reviewPanelOpen ? (
          <>
            <button
              type="button"
              className="absolute inset-0 z-10 bg-scrim min-[1181px]:hidden"
              onClick={() => onReviewPanelOpenChange?.(false)}
              aria-label="Close review panel overlay"
            />
            <SessionReviewPanel
              inspector={inspector}
              changes={changes}
              inspectorLoading={inspectorLoading}
              changesLoading={changesLoading}
              mode={changeMode}
              onModeChange={onChangeMode ?? (() => {})}
              onClose={() => onReviewPanelOpenChange?.(false)}
              configTools={configTools}
            />
          </>
        ) : null}
      </div>
    </WorkShell>
  );
}
