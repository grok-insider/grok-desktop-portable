import { describe, expect, it } from "vitest";
import {
  asSessionChanges,
  asSessionInspector,
  failureMessage,
  refusalMessage,
} from "./outcomes";

describe("failure messages", () => {
  it("tells a stale page to reload rather than showing the caller's fallback", () => {
    const message = failureMessage(
      { kind: "protocol_mismatch", hostVersion: 7 },
      "Something went wrong.",
    );
    expect(message).toMatch(/reload/i);
    expect(message).toContain("7");
    expect(message).not.toBe("Something went wrong.");
  });

  it("explains a lost pairing instead of a generic failure", () => {
    expect(failureMessage({ kind: "not_paired" }, "fallback")).toMatch(/grok-bridge open/);
  });

  it("passes a refusal through to its own wording", () => {
    expect(failureMessage({ kind: "refused", code: "unsupported" }, "fallback")).toBe(
      refusalMessage("unsupported"),
    );
  });

  it("falls back to the caller's context for a failure it cannot explain", () => {
    // The caller knows what the user was trying to do; a blank would not.
    expect(failureMessage({ kind: "bad_request" }, "The picker could not open.")).toBe(
      "The picker could not open.",
    );
  });
});

describe("refusal messages", () => {
  it("tells a missing capability apart from a broken CLI", () => {
    // The host separates these because the user's answer differs: one is
    // fixed by updating the CLI, the other by getting it running again.
    expect(refusalMessage("unsupported")).not.toBe(refusalMessage("agent_failed"));
  });

  it("points at the upgrade when the CLI lacks the feature", () => {
    expect(refusalMessage("unsupported")).toMatch(/updat/i);
  });

  it("never blames the user's setup for a capability their CLI lacks", () => {
    // "Check it is installed and authenticated" would send them chasing a
    // fault that is not there.
    expect(refusalMessage("unsupported")).not.toMatch(/authenticat/i);
  });

  it("says plainly that nothing ran when intent could not be recorded", () => {
    // The user needs to know this was a refusal, not an ambiguous outcome
    // they now have to go and check for in their workspace.
    expect(refusalMessage("intent_not_durable")).toMatch(/nothing ran/i);
  });

  it("falls back to a refusal rather than inventing a reason", () => {
    expect(refusalMessage("something_new_from_a_later_host")).toBe(
      "The host refused the request.",
    );
  });

  it("gives every code the host can emit its own explanation", () => {
    // Kept in step with `DispatchError::code` in
    // crates/grok-bridge/src/dispatch.rs. A code with no wording here
    // reaches the user as "the host refused the request", which explains
    // nothing and hides a limit they could act on.
    const codes = [
      "unknown_workspace",
      "session_already_active",
      "no_session",
      "agent_failed",
      "unsupported",
      "too_many_sessions",
      "unknown_session",
      "unknown_review_record",
      "intent_not_durable",
      "already_completed",
      "not_replayable",
      "permission_not_answerable",
      "picker_already_open",
      "unknown_permission",
    ];
    const fallback = refusalMessage("unknown_code");
    for (const code of codes) {
      expect(refusalMessage(code), code).not.toBe(fallback);
    }
    expect(new Set(codes.map(refusalMessage)).size).toBe(codes.length);
  });
});

describe("concurrency limits", () => {
  it("says what to do when too many conversations are open", () => {
    // Hitting the bound must name the way out, not just refuse.
    const message = refusalMessage("too_many_sessions");
    expect(message).toMatch(/close one/i);
  });

  it("explains a conversation that is no longer open", () => {
    expect(refusalMessage("unknown_session")).toMatch(/no longer open/i);
  });

  it("no longer claims Portable runs one conversation at a time", () => {
    // That wording predates light ADR 0011 and is now false.
    expect(refusalMessage("session_already_active")).not.toMatch(/one at a time/i);
  });
});

describe("session review projections", () => {
  const changes = {
    outcome: "sessionChanges",
    sessionId: "s-1",
    mode: "git",
    changes: {
      sessionId: "s-1",
      mode: "git",
      comparison: "HEAD to working tree",
      files: [
        {
          path: "src/main.ts",
          status: "modified",
          stage: "unstaged",
          additions: 1,
          deletions: 1,
          patch: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n",
          patchState: "complete",
        },
      ],
      additions: 1,
      deletions: 1,
      complete: true,
      omittedFiles: 0,
    },
  };

  it("accepts a complete bounded patch for the addressed session and mode", () => {
    expect(asSessionChanges(changes, "s-1", "git")?.changes?.files[0]?.path).toBe(
      "src/main.ts",
    );
  });

  it("rejects absolute and parent-traversing projected paths", () => {
    for (const path of ["/home/friend/secret", "../secret", "src/../../secret", "C:\\secret"]) {
      expect(
        asSessionChanges(
          {
            ...changes,
            changes: {
              ...changes.changes,
              files: [{ ...changes.changes.files[0], path }],
            },
          },
          "s-1",
          "git",
        ),
      ).toBeNull();
    }
  });

  it("rejects an oversized patch even if a peer labels it complete", () => {
    expect(
      asSessionChanges(
        {
          ...changes,
          changes: {
            ...changes.changes,
            files: [
              {
                ...changes.changes.files[0],
                patch: "x".repeat(256 * 1024 + 1),
              },
            ],
          },
        },
        "s-1",
        "git",
      ),
    ).toBeNull();
  });

  it("accepts an explicitly unavailable comparison without inventing files", () => {
    expect(
      asSessionChanges(
        { outcome: "sessionChanges", sessionId: "s-1", mode: "branch" },
        "s-1",
        "branch",
      ),
    ).toEqual({ outcome: "sessionChanges", sessionId: "s-1", mode: "branch" });
  });

  it("rejects non-finite cost and a response for another session", () => {
    const inspector = {
      outcome: "sessionInspector",
      inspector: {
        sessionId: "s-1",
        turns: 2,
        turnIndex: 1,
        availableChangeModes: ["git"],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          modelCalls: 1,
          numTurns: 1,
          apiDurationMs: 10,
          costUsd: Number.NaN,
          incomplete: false,
        },
      },
    };
    expect(asSessionInspector(inspector, "s-1")).toBeNull();
    expect(
      asSessionInspector(
        {
          outcome: "sessionInspector",
          inspector: {
            sessionId: "s-2",
            turns: 0,
            turnIndex: 0,
            availableChangeModes: [],
          },
        },
        "s-1",
      ),
    ).toBeNull();
  });
});
