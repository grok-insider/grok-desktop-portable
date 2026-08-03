/**
 * Parent-scoped side chat dock: tabs + independent transcript/composer pane.
 * (light ADR 0019)
 */

import { useRef } from "react";
import { X } from "lucide-react";
import { Button, IconButton, cn } from "../../components/ui";
import { MarkdownMessage } from "../../components/MarkdownMessage";
import type { SessionProjection, SideChatClip } from "../../services/outcomes";
import { clipChipLabel, sideChatTitle } from "../../services/sideChat";
import type { SessionPhase, ThoughtEntry, ToolEntry, TranscriptEntry } from "../SessionView";
import { ThoughtRow } from "../ThoughtRow";
import { ToolRow } from "../ToolRow";
import { SessionComposer } from "../composer/SessionComposer";
import type { ModelProjection } from "../../services/models";
import type { CommandProjection } from "../../services/protocol";
import type { ContextEntry, ToolProjection } from "../../services/outcomes";

export function SideChatDock({
  sides,
  activeSideId,
  onSelectSide,
  onCloseSide,
  onNewSide,
  transcript,
  tools,
  thoughts,
  phase,
  draft,
  onDraftChange,
  queued,
  onSubmit,
  onCancel,
  onSendNow,
  onRemoveQueued,
  clips,
  onRemoveClip,
  connected,
  models,
  modelId,
  effortId,
  onModelChange,
  onEffortChange,
  configTools,
  commands,
  contextEntries,
  contextLoading,
  onContextQuery,
}: {
  sides: SessionProjection[];
  activeSideId: string | null;
  onSelectSide: (sessionId: string) => void;
  onCloseSide: (sessionId: string) => void;
  onNewSide: () => void;
  transcript: TranscriptEntry[];
  tools: ToolEntry[];
  thoughts: ThoughtEntry[];
  phase: SessionPhase;
  draft: string;
  onDraftChange: (text: string) => void;
  queued: { entryId: string; text: string }[];
  onSubmit: () => void;
  onCancel: () => void;
  onSendNow: () => void;
  onRemoveQueued: (entryId: string) => void;
  clips: SideChatClip[];
  onRemoveClip: (clipId: string) => void;
  connected: boolean;
  models: ModelProjection[];
  modelId: string | null;
  effortId: string | null;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effortId: string) => void;
  configTools: ToolProjection[];
  commands: CommandProjection[];
  contextEntries: ContextEntry[];
  contextLoading: boolean;
  onContextQuery?: (query: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (sides.length === 0 && activeSideId === null) {
    return null;
  }

  type TimelineItem =
    | { kind: "message"; entry: TranscriptEntry }
    | { kind: "tool"; tool: ToolEntry }
    | { kind: "thought"; thought: ThoughtEntry };
  const timeline: TimelineItem[] = [
    ...transcript.map((entry) => ({ kind: "message" as const, entry })),
    ...tools.map((tool) => ({ kind: "tool" as const, tool })),
    ...thoughts.map((thought) => ({ kind: "thought" as const, thought })),
  ].toSorted((left, right) => {
    const seq = (item: TimelineItem) =>
      item.kind === "message"
        ? item.entry.seq
        : item.kind === "tool"
          ? item.tool.seq
          : item.thought.seq;
    return seq(left) - seq(right);
  });

  return (
    <aside
      className="flex min-h-0 w-full min-w-[280px] max-w-[440px] flex-col border-l border-border bg-card/40"
      aria-label="Side chats"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {sides.map((side) => {
            const active = side.sessionId === activeSideId;
            return (
              <button
                key={side.sessionId}
                type="button"
                className={cn(
                  "flex max-w-[140px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
                onClick={() => onSelectSide(side.sessionId)}
                aria-current={active ? "true" : undefined}
              >
                <span className="truncate">{sideChatTitle(side)}</span>
                {side.awaitingDecision ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                    aria-label="Needs you"
                  />
                ) : side.running ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label="Working" />
                ) : null}
                <IconButton
                  size="sm"
                  className="size-5"
                  aria-label={`Close ${sideChatTitle(side)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseSide(side.sessionId);
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </IconButton>
              </button>
            );
          })}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onNewSide}>
          +
        </Button>
      </div>

      {clips.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2" aria-label="Context clips">
          {clips.map((clip) => (
            <span
              key={clip.clipId}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-caption text-foreground"
            >
              <span className="truncate">{clipChipLabel(clip)}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove clip ${clipChipLabel(clip)}`}
                onClick={() => onRemoveClip(clip.clipId)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          {timeline.length === 0 ? (
            <p className="text-body text-muted-foreground">
              Ask about the selected context without interrupting the main chat.
            </p>
          ) : null}
          {timeline.map((item) => {
            if (item.kind === "message") {
              const entry = item.entry;
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "text-body",
                    entry.role === "user" ? "text-foreground" : "text-foreground",
                  )}
                >
                  {entry.role === "user" ? (
                    <p className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2">{entry.text}</p>
                  ) : (
                    <MarkdownMessage streaming={phase === "streaming"}>
                      {entry.text}
                    </MarkdownMessage>
                  )}
                </div>
              );
            }
            if (item.kind === "tool") {
              return <ToolRow key={item.tool.id} tool={item.tool} />;
            }
            return (
              <ThoughtRow
                key={item.thought.id}
                thought={item.thought}
                streaming={phase === "streaming"}
              />
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-2">
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
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={onSubmit}
          onSendNow={onSendNow}
          onCancel={onCancel}
          commands={commands}
          contextEntries={contextEntries}
          contextLoading={contextLoading}
          onContextQuery={onContextQuery}
        />
      </div>
    </aside>
  );
}
