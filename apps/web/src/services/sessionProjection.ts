/**
 * Fold host events into on-screen session projections.
 *
 * Since light ADR 0011 several conversations run at once, so events are routed
 * by the session they name. This is the only place event semantics are
 * interpreted for the Work view; keeping it free of React lets tests cover
 * recovery and streaming without mounting the shell.
 */

import type { EventEnvelope, PlanEntryProjection } from "./protocol";
import type {
  ReviewRecord,
  SessionPhase,
  ThoughtEntry,
  ToolEntry,
  TranscriptEntry,
} from "../views/SessionView";

/** Everything the Work surface shows, folded from the host event stream. */
export interface Projection {
  transcript: TranscriptEntry[];
  tools: ToolEntry[];
  /** Streaming reasoning blocks (`thoughtDelta`); never mixed into agent text. */
  thoughts: ThoughtEntry[];
  reviews: ReviewRecord[];
  phase: SessionPhase;
  /** Latest agent plan for this conversation, or empty when none published. */
  plan: PlanEntryProjection[];
}

/** Empty projection used before any event and after a hard reset. */
export const EMPTY_PROJECTION: Projection = {
  transcript: [],
  tools: [],
  thoughts: [],
  reviews: [],
  phase: "idle",
  plan: [],
};

/**
 * Fold one event into the projection.
 *
 * Thoughts stay in their own channel (`thoughtDelta`) so they never glue onto
 * the agent bubble. Tools and interruptions accumulate until the user or a
 * later command clears them.
 */
function projectOne(current: Projection, envelope: EventEnvelope): Projection {
  const event = envelope.event;
  switch (event.kind) {
    case "thoughtDelta": {
      // Continue the open thought block only while it is still the latest
      // timeline item. A message or tool after it starts a new thought block
      // later in the turn (CLI: thinking → tools → more thinking → answer).
      const last = current.thoughts.at(-1);
      const latestOther = Math.max(
        current.transcript.at(-1)?.seq ?? -1,
        current.tools.at(-1)?.seq ?? -1,
      );
      if (
        last !== undefined &&
        current.phase === "streaming" &&
        last.seq >= latestOther
      ) {
        return {
          ...current,
          phase: "streaming",
          thoughts: [
            ...current.thoughts.slice(0, -1),
            { ...last, text: last.text + event.text },
          ],
        };
      }
      return {
        ...current,
        phase: "streaming",
        thoughts: [
          ...current.thoughts,
          {
            id: `th-${envelope.eventSequence}`,
            text: event.text,
            seq: envelope.eventSequence,
          },
        ],
      };
    }
    case "messageDelta": {
      const last = current.transcript.at(-1);
      // Only a turn still in flight continues the previous bubble. Once the
      // host has said the turn ended — idle, interrupted, or an error — the
      // next delta opens a new one, otherwise two separate answers would be
      // glued into a single message the user cannot tell apart.
      if (last?.role === "agent" && current.phase === "streaming") {
        return {
          ...current,
          phase: "streaming",
          transcript: [
            ...current.transcript.slice(0, -1),
            { ...last, text: last.text + event.text },
          ],
        };
      }
      return {
        ...current,
        phase: "streaming",
        transcript: [
          ...current.transcript,
          {
            id: `a-${envelope.eventSequence}`,
            role: "agent",
            text: event.text,
            seq: envelope.eventSequence,
          },
        ],
      };
    }
    case "promptSent":
      // A message the user queued has left. It becomes their turn now, since
      // the browser could not add it when they wrote it.
      return {
        ...current,
        phase: "streaming",
        transcript: [
          ...current.transcript,
          {
            id: `q-${envelope.eventSequence}`,
            role: "user",
            text: event.text,
            seq: envelope.eventSequence,
          },
        ],
      };
    case "toolStart": {
      // A re-used id updates the row rather than stacking a duplicate.
      const started = {
        id: event.toolCallId,
        name: event.name,
        action: event.action,
        readOnly: event.readOnly,
        provider: event.provider ?? null,
        detail: event.detail ?? null,
        finished: false,
        failed: false,
        truncated: false,
      };
      const existing = current.tools.find((tool) => tool.id === event.toolCallId);
      if (existing !== undefined) {
        // Keep the position it already holds. Restarting a row would slide it
        // to the end of the transcript, away from the turn that ran it.
        return {
          ...current,
          tools: current.tools.map((tool) =>
            tool.id === event.toolCallId
              ? { ...tool, ...started, seq: tool.seq }
              : tool,
          ),
        };
      }
      return {
        ...current,
        tools: [...current.tools, { ...started, seq: envelope.eventSequence }],
      };
    }
    case "toolProgress": {
      if (!current.tools.some((tool) => tool.id === event.toolCallId)) {
        return current;
      }
      // The agent refines the label and the target as the call resolves; a
      // missing value keeps what was already known rather than blanking it.
      return {
        ...current,
        tools: current.tools.map((tool) =>
          tool.id === event.toolCallId
            ? {
                ...tool,
                name: event.title ?? tool.name,
                detail: event.detail ?? tool.detail,
                finished: false,
              }
            : tool,
        ),
      };
    }
    case "toolEnd":
      return {
        ...current,
        tools: current.tools.map((tool) =>
          tool.id === event.toolCallId
            ? {
                ...tool,
                finished: true,
                failed: event.failed,
                truncated: event.truncated,
              }
            : tool,
        ),
      };

    case "planUpdated":
      // Replace the whole plan: the agent republishes the full list, so a
      // merge would leave stale steps after the agent dropped them.
      return {
        ...current,
        plan: Array.isArray(event.entries) ? event.entries : [],
      };
    case "turnInterrupted":
      return {
        ...current,
        phase: "interrupted",
        reviews: [...current.reviews, { recordId: event.recordId }],
      };
    case "sessionStatus":
      return { ...current, phase: event.state === "running" ? "streaming" : "idle" };
    case "sessionSnapshot": {
      // Full replace after resume. Messages and tools are host-rehydrated from
      // on-disk history — never paths, thoughts, or tool bodies.
      const messages = event.messages ?? [];
      const restored = messages.filter(
        (message) =>
          (message.role === "user" || message.role === "agent") &&
          message.text.length > 0,
      );
      const restoredTools = (event.tools ?? []).filter(
        (tool) => typeof tool.toolCallId === "string" && tool.toolCallId.length > 0,
      );
      // Prefer host-assigned seq when present so tools interleave with turns.
      // Fall back to negative indices so rehydrate still sorts before live events.
      const fallbackBase = -(restored.length + restoredTools.length);
      return {
        transcript: restored.map((message, index) => ({
          id: `restored-${index}`,
          role: message.role as "user" | "agent",
          text: message.text,
          seq:
            typeof message.seq === "number"
              ? message.seq + fallbackBase
              : index + fallbackBase,
        })),
        tools: restoredTools.map((tool, index) => ({
          id: tool.toolCallId,
          name: tool.name,
          action: tool.action,
          readOnly: tool.readOnly,
          provider: tool.provider ?? null,
          detail: tool.detail ?? null,
          finished: tool.finished,
          failed: tool.failed,
          truncated: false,
          seq:
            typeof tool.seq === "number"
              ? tool.seq + fallbackBase
              : restored.length + index + fallbackBase,
        })),
        // Thoughts are live-only: history rehydrate drops them (ADR 0010).
        thoughts: [],
        reviews: current.reviews,
        phase: "idle",
        // Plan is live ACP state, not rehydrated from the transcript snapshot.
        plan: [],
      };
    }
    // Handled before the fold, in App.handleEvent, because they change host or
    // browser state rather than the transcript.
    // The agent's command set is conversation state, not transcript content,
    // and a snapshot replaces the transcript wholesale — so it is held beside
    // the projection rather than inside it.
    case "commandsUpdated":
    case "sessionReviewUpdated":
    case "queueChanged":
    case "workspacesChanged":
    case "hostStatus":
    case "permissionRequest":
    case "error":
      return current;
  }
}

/**
 * The position for something the browser adds before the host has numbered it.
 *
 * A prompt is drawn the moment it is sent, so it has no event sequence yet. It
 * belongs after everything currently on screen, and the host's own
 * `promptSent` supersedes it when it arrives.
 */
export function nextLocalSeq(projection: Projection): number {
  let highest = 0;
  for (const entry of projection.transcript) {
    highest = Math.max(highest, entry.seq);
  }
  for (const tool of projection.tools) {
    highest = Math.max(highest, tool.seq);
  }
  for (const thought of projection.thoughts) {
    highest = Math.max(highest, thought.seq);
  }
  return highest + 1;
}

/** Every open conversation, keyed by session id. */
export type Projections = Record<string, Projection>;

/** Nothing open yet. */
export const EMPTY_PROJECTIONS: Projections = {};

/**
 * The session an event belongs to, when it names one.
 *
 * Events that describe the host rather than a conversation carry no session,
 * and are handled before the fold.
 */
function eventSession(envelope: EventEnvelope): string | null {
  const event = envelope.event;
  return "sessionId" in event ? event.sessionId : null;
}

/**
 * Route one event to the conversation it belongs to.
 *
 * An event for a session this browser does not track is dropped rather than
 * opened as a new conversation: the session list comes from the host, and
 * inventing a row from a stray delta would show work the user never started.
 */
export function project(current: Projections, envelope: EventEnvelope): Projections {
  const sessionId = eventSession(envelope);
  if (sessionId === null) {
    return current;
  }
  const existing = current[sessionId];
  if (existing === undefined) {
    // A snapshot is the host declaring a conversation and its whole content,
    // and it arrives when a session is resumed — before the list has been
    // re-read. Dropping it would leave the user looking at an empty transcript
    // for a conversation that plainly has history. Anything else naming a
    // session this browser does not track is a stray and is dropped, so a
    // delta cannot invent a conversation the user never started.
    if (envelope.event.kind !== "sessionSnapshot") {
      return current;
    }
    return { ...current, [sessionId]: projectOne(EMPTY_PROJECTION, envelope) };
  }
  const next = projectOne(existing, envelope);
  return next === existing ? current : { ...current, [sessionId]: next };
}

/** Begin tracking a conversation, keeping anything already folded for it. */
export function openProjection(current: Projections, sessionId: string): Projections {
  return sessionId in current
    ? current
    : { ...current, [sessionId]: EMPTY_PROJECTION };
}

/** Stop tracking a conversation the host has closed. */
export function closeProjection(current: Projections, sessionId: string): Projections {
  if (!(sessionId in current)) {
    return current;
  }
  const next = { ...current };
  delete next[sessionId];
  return next;
}

/** The projection for one conversation, empty when it has said nothing yet. */
export function projectionFor(current: Projections, sessionId: string | null): Projection {
  if (sessionId === null) {
    return EMPTY_PROJECTION;
  }
  return current[sessionId] ?? EMPTY_PROJECTION;
}

/**
 * A short label for each conversation, taken from its first user turn.
 *
 * The host has no title for a session it just created, and the catalog title
 * only exists once Grok has written a summary. The opening message is what the
 * user actually typed, so it is the most honest label available and needs no
 * round trip.
 */
export function sessionTitles(current: Projections): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const [id, projection] of Object.entries(current)) {
    const opening = projection.transcript.find((entry) => entry.role === "user");
    if (opening !== undefined) {
      const trimmed = opening.text.trim();
      titles[id] = trimmed.length > 48 ? `${trimmed.slice(0, 48)}\u2026` : trimmed;
    }
  }
  return titles;
}
