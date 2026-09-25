/**
 * Event projection is the only place event semantics are interpreted, so it is
 * checked directly rather than through the DOM.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_PROJECTIONS,
  closeProjection,
  nextLocalSeq,
  openProjection,
  project,
  projectionFor,
  sessionTitles,
  type Projections,
} from "./sessionProjection";
import type { EventEnvelope, LightEvent } from "./protocol";

const S = "s-1";
const OTHER = "s-2";

function envelope(event: LightEvent, sequence = 1): EventEnvelope {
  return { protocolVersion: 2, eventSequence: sequence, event };
}

/** A tracked, empty conversation. */
function open(...ids: string[]): Projections {
  return ids.reduce(openProjection, EMPTY_PROJECTIONS);
}

/** The projection of the conversation under test. */
function one(state: Projections, id = S) {
  return projectionFor(state, id);
}

describe("project", () => {
  it("appends the first agent delta as a new turn", () => {
    const next = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "hello" }));
    expect(one(next).transcript).toHaveLength(1);
    expect(one(next).transcript[0]?.role).toBe("agent");
    expect(one(next).transcript[0]?.text).toBe("hello");
    expect(one(next).phase).toBe("streaming");
  });

  it("merges consecutive deltas into one turn instead of many bubbles", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "hello " }, 1));
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "world" }, 2));
    expect(one(state).transcript).toHaveLength(1);
    expect(one(state).transcript[0]?.text).toBe("hello world");
  });

  it("starts a new agent turn after the user speaks", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "one" }, 1));
    state = {
      ...state,
      [S]: {
        ...one(state),
        transcript: [...one(state).transcript, { id: "u-1", role: "user", text: "again", seq: 90 }],
      },
    };
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "two" }, 2));
    expect(one(state).transcript).toHaveLength(3);
    expect(one(state).transcript[2]?.text).toBe("two");
  });

  it("tracks a tool call from start to end", () => {
    let state = project(
      open(S),
      envelope({ kind: "toolStart", sessionId: S, toolCallId: "t-1", name: "write", action: "execute", readOnly: false }, 1),
    );
    expect(one(state).tools[0]).toMatchObject({ name: "write", finished: false });

    state = project(
      state,
      envelope({ kind: "toolProgress", sessionId: S, toolCallId: "t-1" }, 2),
    );
    expect(one(state).tools[0]).toMatchObject({ finished: false });

    state = project(
      state,
      envelope({ kind: "toolEnd", sessionId: S, toolCallId: "t-1", failed: false, truncated: true }, 3),
    );
    expect(one(state).tools[0]).toMatchObject({ finished: true, truncated: true });
  });

  it("does not stack duplicate tool rows for the same id", () => {
    let state = project(
      open(S),
      envelope({ kind: "toolStart", sessionId: S, toolCallId: "t-1", name: "read", action: "execute", readOnly: false }, 1),
    );
    state = project(
      state,
      envelope({ kind: "toolStart", sessionId: S, toolCallId: "t-1", name: "read (retry)", action: "execute", readOnly: false }, 2),
    );
    expect(one(state).tools).toHaveLength(1);
    expect(one(state).tools[0]?.name).toBe("read (retry)");
  });

  it("records an interrupted turn for review and never clears it itself", () => {
    const state = project(
      open(S),
      envelope({ kind: "turnInterrupted", sessionId: S, recordId: "ir-1" }, 1),
    );
    expect(one(state).phase).toBe("interrupted");
    expect(one(state).reviews).toEqual([{ recordId: "ir-1" }]);

    // Later events must not silently resolve it: only the user can.
    const later = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "x" }, 2));
    expect(one(later).reviews).toEqual([{ recordId: "ir-1" }]);
  });

  it("leaves the projection untouched for events it does not render", () => {
    for (const event of [
      { kind: "hostStatus", state: "ok" },
      { kind: "toolProgress", sessionId: S, toolCallId: "t-1" },
      { kind: "error", code: "boom" },
    ] satisfies LightEvent[]) {
      const start = open(S);
      expect(project(start, envelope(event))).toBe(start);
    }
  });

  it("streams thoughtDelta into a separate Thinking block, not the agent bubble", () => {
    let state = project(
      open(S),
      envelope({ kind: "thoughtDelta", sessionId: S, text: "consider " }, 1),
    );
    expect(one(state).thoughts).toEqual([
      { id: "th-1", text: "consider ", seq: 1 },
    ]);
    expect(one(state).transcript).toEqual([]);

    state = project(
      state,
      envelope({ kind: "thoughtDelta", sessionId: S, text: "options" }, 2),
    );
    expect(one(state).thoughts[0]?.text).toBe("consider options");

    state = project(
      state,
      envelope({ kind: "messageDelta", sessionId: S, text: "Done." }, 3),
    );
    expect(one(state).transcript[0]?.text).toBe("Done.");
    expect(one(state).thoughts[0]?.text).toBe("consider options");
  });

  it("opens a new thought block after a tool runs mid-turn", () => {
    let state = project(
      open(S),
      envelope({ kind: "thoughtDelta", sessionId: S, text: "first" }, 1),
    );
    state = project(
      state,
      envelope(
        {
          kind: "toolStart",
          sessionId: S,
          toolCallId: "t-1",
          name: "search",
          action: "search",
          readOnly: true,
        },
        2,
      ),
    );
    state = project(
      state,
      envelope({ kind: "thoughtDelta", sessionId: S, text: "second" }, 3),
    );
    expect(one(state).thoughts).toHaveLength(2);
    expect(one(state).thoughts[0]?.text).toBe("first");
    expect(one(state).thoughts[1]?.text).toBe("second");
  });

  it("keeps tools for a conversation when another is opened", () => {
    // Switching chats must not wipe in-memory tools via a false empty rehydrate.
    let state = project(
      open(S),
      envelope(
        {
          kind: "toolStart",
          sessionId: S,
          toolCallId: "t-live",
          name: "read",
          action: "read",
          readOnly: true,
          detail: "src/a.ts",
        },
        1,
      ),
    );
    state = project(
      state,
      envelope(
        { kind: "toolEnd", sessionId: S, toolCallId: "t-live", failed: false, truncated: false },
        2,
      ),
    );
    expect(one(state).tools).toHaveLength(1);

    // Host list refresh opens sibling conversations without replacing S.
    state = openProjection(state, "s-other");
    expect(one(state).tools).toHaveLength(1);
    expect(one(state).tools[0]?.id).toBe("t-live");

    // A snapshot for the *other* session must not touch S.
    state = project(
      state,
      envelope(
        {
          kind: "sessionSnapshot",
          sessionId: "s-other",
          messages: [{ role: "user", text: "hi", seq: 0 }],
          tools: [],
        },
        3,
      ),
    );
    expect(one(state).tools).toHaveLength(1);
    expect(projectionFor(state, "s-other").transcript).toHaveLength(1);
  });

  it("restores tool rows from a session snapshot", () => {
    const state = project(
      open(S),
      envelope(
        {
          kind: "sessionSnapshot",
          sessionId: S,
          messages: [
            { role: "user", text: "run it", seq: 0 },
            { role: "agent", text: "done", seq: 2 },
          ],
          tools: [
            {
              toolCallId: "t-1",
              name: "run_terminal_command",
              action: "execute",
              readOnly: false,
              detail: "echo hi",
              finished: true,
              failed: false,
              seq: 1,
            },
          ],
        },
        1,
      ),
    );
    const projection = one(state);
    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.id).toBe("t-1");
    expect(projection.tools[0]?.detail).toBe("echo hi");
    expect(projection.tools[0]?.finished).toBe(true);
    // Tool seq sits between the user and agent turns for timeline order.
    expect(projection.transcript[0]!.seq).toBeLessThan(projection.tools[0]!.seq);
    expect(projection.tools[0]!.seq).toBeLessThan(projection.transcript[1]!.seq);
  });

  it("replaces the agent plan when the host projects entries", () => {
    const state = project(
      open(S),
      envelope(
        {
          kind: "planUpdated",
          sessionId: S,
          entries: [
            { content: "Read files", status: "completed" },
            { content: "Ship fix", status: "in_progress" },
          ],
        },
        1,
      ),
    );
    expect(one(state).plan).toEqual([
      { content: "Read files", status: "completed" },
      { content: "Ship fix", status: "in_progress" },
    ]);
    // A later plan replaces rather than appends, so dropped steps disappear.
    const replaced = project(
      state,
      envelope(
        {
          kind: "planUpdated",
          sessionId: S,
          entries: [{ content: "Ship fix", status: "completed" }],
        },
        2,
      ),
    );
    expect(one(replaced).plan).toEqual([
      { content: "Ship fix", status: "completed" },
    ]);
  });

  it("clears streaming when the host reports the session is idle", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "done" }, 1));
    expect(one(state).phase).toBe("streaming");
    state = project(
      state,
      envelope({ kind: "sessionStatus", sessionId: S, state: "idle" }, 2),
    );
    expect(one(state).phase).toBe("idle");
  });

  it("starts a new bubble when a turn ended before the next delta", () => {
    // Two answers separated by an end-of-turn must stay two messages. Gluing
    // them would present a single reply the user cannot pull apart.
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "first" }, 1));
    state = project(state, envelope({ kind: "sessionStatus", sessionId: S, state: "idle" }, 2));
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "second" }, 3));

    expect(one(state).transcript).toHaveLength(2);
    expect(one(state).transcript[0]?.text).toBe("first");
    expect(one(state).transcript[1]?.text).toBe("second");
  });

  it("starts a new bubble after an interrupted turn", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "cut" }, 1));
    state = project(state, envelope({ kind: "turnInterrupted", sessionId: S, recordId: "ir-1" }, 2));
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "after" }, 3));

    expect(one(state).transcript).toHaveLength(2);
    expect(one(state).transcript[1]?.text).toBe("after");
    expect(one(state).reviews).toEqual([{ recordId: "ir-1" }]);
  });

  it("keeps merging while the same turn is still streaming", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "one " }, 1));
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "two" }, 2));

    expect(one(state).transcript).toHaveLength(1);
    expect(one(state).transcript[0]?.text).toBe("one two");
  });

  it("replaces the transcript when a session snapshot is restored", () => {
    let state = project(open(S), envelope({ kind: "messageDelta", sessionId: S, text: "stale" }, 1));
    state = project(
      state,
      envelope(
        {
          kind: "sessionSnapshot",
          sessionId: S,
          messages: [
            { role: "user", text: "hi" },
            { role: "agent", text: "hello" },
          ],
        },
        2,
      ),
    );
    expect(one(state).phase).toBe("idle");
    expect(one(state).transcript).toEqual([
      // Rehydrated history is numbered backwards from zero so it always sorts
      // before whatever sequence the host resumes at.
      { id: "restored-0", role: "user", text: "hi", seq: -2 },
      { id: "restored-1", role: "agent", text: "hello", seq: -1 },
    ]);
  });
});

describe("ordering", () => {
  it("gives a tool call the position of the event that started it", () => {
    let state = open(S);
    state = project(state, envelope({ kind: "promptSent", sessionId: S, text: "go" }, 5));
    state = project(
      state,
      envelope(
        {
          kind: "toolStart",
          sessionId: S,
          toolCallId: "t-1",
          name: "ls",
          action: "execute",
          readOnly: false,
        },
        6,
      ),
    );
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "done" }, 7));

    expect(one(state).transcript.map((entry) => entry.seq)).toEqual([5, 7]);
    expect(one(state).tools.map((tool) => tool.seq)).toEqual([6]);
  });

  it("holds a tool call in place when the agent restarts it", () => {
    // Re-stamping would slide the row to the end of the transcript, away from
    // the turn that actually ran it.
    let state = open(S);
    const start = (sequence: number) =>
      envelope(
        {
          kind: "toolStart",
          sessionId: S,
          toolCallId: "t-1",
          name: "ls",
          action: "execute",
          readOnly: true,
        },
        sequence,
      );
    state = project(state, start(2));
    state = project(state, start(9));
    expect(one(state).tools).toHaveLength(1);
    expect(one(state).tools[0]?.seq).toBe(2);
  });

  it("sorts restored history before anything the host emits next", () => {
    let state = project(
      EMPTY_PROJECTIONS,
      envelope(
        {
          kind: "sessionSnapshot",
          sessionId: S,
          messages: [
            { role: "user", text: "old" },
            { role: "agent", text: "older reply" },
          ],
        },
        1,
      ),
    );
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "new" }, 2));
    const sequences = one(state).transcript.map((entry) => entry.seq);
    expect(sequences).toEqual(sequences.toSorted((a, b) => a - b));
    expect(sequences.at(-1)).toBe(2);
  });
});

describe("nextLocalSeq", () => {
  it("places an unnumbered prompt after everything on screen", () => {
    let state = open(S);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "a" }, 4));
    state = project(
      state,
      envelope(
        {
          kind: "toolStart",
          sessionId: S,
          toolCallId: "t-1",
          name: "ls",
          action: "read",
          readOnly: true,
        },
        11,
      ),
    );
    expect(nextLocalSeq(one(state))).toBe(12);
  });

  it("starts at one for a conversation that has said nothing", () => {
    expect(nextLocalSeq(projectionFor(EMPTY_PROJECTIONS, null))).toBe(1);
  });
});

describe("routing between conversations", () => {
  it("keeps each conversation's output to itself", () => {
    // The whole point of light ADR 0011: one session streaming must never
    // print inside another's transcript.
    let state = open(S, OTHER);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "mine" }, 1));
    state = project(
      state,
      envelope({ kind: "messageDelta", sessionId: OTHER, text: "theirs" }, 2),
    );

    expect(one(state, S).transcript.map((entry) => entry.text)).toEqual(["mine"]);
    expect(one(state, OTHER).transcript.map((entry) => entry.text)).toEqual(["theirs"]);
  });

  it("does not invent a conversation from a stray event", () => {
    // A delta for a session the host has not listed is dropped: showing it
    // would put work on screen the user never started.
    const state = project(
      open(S),
      envelope({ kind: "messageDelta", sessionId: "s-unknown", text: "ghost" }, 1),
    );
    expect(Object.keys(state)).toEqual([S]);
  });

  it("leaves other conversations untouched when one is folded", () => {
    let state = open(S, OTHER);
    const before = one(state, OTHER);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "x" }, 1));
    expect(one(state, OTHER)).toBe(before);
  });

  it("forgets a conversation the host has closed", () => {
    let state = open(S, OTHER);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "x" }, 1));
    state = closeProjection(state, S);

    expect(Object.keys(state)).toEqual([OTHER]);
    // Its transcript must not survive: a closed session leaves no content
    // behind in the browser.
    expect(projectionFor(state, S).transcript).toHaveLength(0);
  });

  it("keeps what a conversation already said when it is re-listed", () => {
    let state = open(S);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "kept" }, 1));
    state = openProjection(state, S);
    expect(one(state, S).transcript[0]?.text).toBe("kept");
  });

  it("reports an empty projection for a conversation with nothing on screen", () => {
    expect(projectionFor(EMPTY_PROJECTIONS, null).transcript).toHaveLength(0);
    expect(projectionFor(EMPTY_PROJECTIONS, "s-none").phase).toBe("idle");
  });
});


describe("sessionTitles", () => {
  it("labels a conversation by what the user asked for", () => {
    let state = open(S);
    state = {
      ...state,
      [S]: {
        ...one(state),
        transcript: [
          { id: "u-1", role: "user", text: "  fix the parser  ", seq: 1 },
          { id: "a-1", role: "agent", text: "on it", seq: 2 },
        ],
      },
    };
    expect(sessionTitles(state)[S]).toBe("fix the parser");
  });

  it("leaves a conversation with nothing said unlabelled", () => {
    // The sidebar decides what to show for an unnamed one; inventing a title
    // here would put words in the user's mouth.
    expect(sessionTitles(open(S))[S]).toBeUndefined();
  });

  it("shortens a long opening message rather than breaking the row", () => {
    let state = open(S);
    state = {
      ...state,
      [S]: {
        ...one(state),
        transcript: [{ id: "u-1", role: "user", text: "x".repeat(200), seq: 1 }],
      },
    };
    const title = sessionTitles(state)[S] ?? "";
    expect(title.length).toBeLessThanOrEqual(49);
    expect(title.endsWith("\u2026")).toBe(true);
  });

  it("ignores an agent turn that arrived before any user text", () => {
    let state = open(S);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "hi there" }, 1));
    expect(sessionTitles(state)[S]).toBeUndefined();
  });
});

describe("resuming a conversation", () => {
  it("accepts a snapshot for a conversation the list has not caught up to", () => {
    // Resuming emits the snapshot before the session list is re-read. Dropping
    // it left the user looking at an empty transcript for a conversation that
    // plainly had history.
    const state = project(
      EMPTY_PROJECTIONS,
      envelope(
        {
          kind: "sessionSnapshot",
          sessionId: S,
          messages: [
            { role: "user", text: "earlier question" },
            { role: "agent", text: "earlier answer" },
          ],
        },
        1,
      ),
    );

    expect(one(state).transcript.map((entry) => entry.text)).toEqual([
      "earlier question",
      "earlier answer",
    ]);
  });

  it("still refuses to invent a conversation from a delta", () => {
    // The snapshot exception must not widen: a stray delta would put work on
    // screen the user never started.
    const state = project(
      EMPTY_PROJECTIONS,
      envelope({ kind: "messageDelta", sessionId: S, text: "ghost" }, 1),
    );
    expect(Object.keys(state)).toHaveLength(0);
  });
});

describe("a queued message", () => {
  it("appears as the user's turn when the host sends it", () => {
    // The browser adds its own turns as it sends them; a queued one leaves
    // later and from the host, so without this the reply arrived with no
    // question above it.
    let state = open(S);
    state = project(
      state,
      envelope({ kind: "promptSent", sessionId: S, text: "the queued one" }, 1),
    );
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "answer" }, 2));

    expect(one(state).transcript.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "the queued one"],
      ["agent", "answer"],
    ]);
  });

  it("starts a fresh agent bubble rather than joining the previous answer", () => {
    let state = open(S);
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "first" }, 1));
    state = project(
      state,
      envelope({ kind: "promptSent", sessionId: S, text: "and now this" }, 2),
    );
    state = project(state, envelope({ kind: "messageDelta", sessionId: S, text: "second" }, 3));

    expect(one(state).transcript).toHaveLength(3);
    expect(one(state).transcript[2]?.text).toBe("second");
  });
});
