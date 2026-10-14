import { memo } from "react";
import { TranscriptImages } from "../components/TranscriptImages";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { cn } from "../components/ui";
import type { ThoughtEntry, ToolEntry, TranscriptEntry } from "./SessionView";
import { ThoughtRow } from "./ThoughtRow";
import { ToolRow } from "./ToolRow";

export type TimelineItem = {kind: "message"; entry: TranscriptEntry} | {kind: "tool"; tool: ToolEntry} | {kind: "thought"; thought: ThoughtEntry};

const StableToolRow = memo(ToolRow);
const StableThoughtRow = memo(ThoughtRow);
export function MessageRow({entry, streaming}: {entry: TranscriptEntry; streaming: boolean}) {
  const isUser = entry.role === "user";
  return <article data-turn-id={entry.id} className={cn("flex flex-col", isUser && "items-end")} aria-label={isUser ? "Your message" : "Agent message"}>
    {isUser ? <div className="max-w-[min(85%,36rem)] rounded-[var(--fui-radius-lg)] bg-muted px-3.5 py-2.5"><p className="whitespace-pre-wrap text-foreground" dir="auto">{entry.text}</p>{(entry.images?.length || entry.unavailableImages || entry.liveImages?.length) ? <TranscriptImages images={entry.images} unavailable={entry.unavailableImages} live={entry.liveImages} /> : null}</div> : <><MarkdownMessage streaming={streaming}>{entry.text}</MarkdownMessage>{(entry.images?.length || entry.unavailableImages || entry.liveImages?.length) ? <TranscriptImages images={entry.images} unavailable={entry.unavailableImages} live={entry.liveImages} /> : null}</>}
  </article>;
}

const StableMessageRow = memo(MessageRow);

export const TranscriptRows = memo(function TranscriptRows({timeline, agentId, thoughtId}: {timeline: TimelineItem[]; agentId?: string; thoughtId?: string}) {
  return <>{timeline.map((item) => {
    if (item.kind === "tool") return <StableToolRow key={`tool-${item.tool.id}`} tool={item.tool} />;
    if (item.kind === "thought") return <StableThoughtRow key={`thought-${item.thought.id}`} thought={item.thought} streaming={thoughtId === item.thought.id} />;
    return <StableMessageRow key={item.entry.id} entry={item.entry} streaming={item.entry.role === "agent" && agentId === item.entry.id} />;
  })}</>;
});
