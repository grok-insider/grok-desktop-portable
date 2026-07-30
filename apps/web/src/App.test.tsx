/**
 * Behaviour that only exists once several conversations are open.
 *
 * State that became per conversation when light ADR 0011 landed used to be
 * held in single slots, and every symptom of that only appeared when the user
 * switched between conversations. That is App's job, so it is tested here
 * rather than through a view that never sees more than one at a time.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { LightClient } from "./services/client";
import type { EventEnvelope } from "./services/protocol";
import { ThemeProvider } from "./theme/ThemeProvider";

interface Sent {
  operation: { kind: string; [key: string]: unknown };
}

/** A host that is already paired, with two conversations open. */
function fakeHost() {
  const sent: Sent[] = [];
  let emit: ((envelope: EventEnvelope) => void) | null = null;

  const openSessions = [
    {
      sessionId: "s-1",
      workspaceId: "w-1",
      workspaceName: "test",
      running: false,
      openedAtMs: 1,
    },
    {
      sessionId: "s-2",
      workspaceId: "w-1",
      workspaceName: "test",
      running: false,
      openedAtMs: 2,
    },
  ];

  let paired = true;
  /** When true, every send fails as not_paired (demotion path). */
  let failAllAsNotPaired = false;

  const client = {
    get paired() {
      return paired;
    },
    clearPairing() {
      paired = false;
    },
    get bridgeBaseUrl() {
      // Same-origin test host: skip hosted landing probe.
      return "";
    },
    setBridgeBaseUrl() {},
    async resume() {
      if (!paired) {
        return { ok: false as const, failure: { kind: "not_paired" as const } };
      }
      return {
        ok: true as const,
        value: {
          sessionId: "b-1",
          sessionToken: "tok",
          csrfToken: "c",
          protocolVersion: 2,
        },
      };
    },
    async pair() {
      return {
        ok: true as const,
        value: {
          sessionId: "b-1",
          sessionToken: "tok",
          csrfToken: "c",
          protocolVersion: 2,
        },
      };
    },
    async send(operation: Sent["operation"]) {
      sent.push({ operation });
      if (failAllAsNotPaired) {
        return {
          ok: false as const,
          failure: { kind: "not_paired" as const },
        };
      }
      if (operation.kind === "bootstrap" || operation.kind === "listWorkspaces") {
        return {
          ok: true as const,
          value: {
            outcome: "workspaces",
            workspaces: [{ id: "w-1", displayName: "test", available: true }],
            openSessions,
            pendingReviews: [],
          },
        };
      }
      if (operation.kind === "getSessionInspector") {
        return {
          ok: true as const,
          value: {
            outcome: "sessionInspector",
            inspector: {
              sessionId: operation.sessionId,
              modelDisplayName: "Grok 4.5",
              turns: 1,
              turnIndex: 0,
              availableChangeModes: ["git", "lastTurn"],
            },
          },
        };
      }
      if (operation.kind === "getSessionChanges") {
        return {
          ok: true as const,
          value: {
            outcome: "sessionChanges",
            sessionId: operation.sessionId,
            mode: operation.mode,
            changes: {
              sessionId: operation.sessionId,
              mode: operation.mode,
              comparison: "HEAD to working tree",
              files: [],
              additions: 0,
              deletions: 0,
              complete: true,
              omittedFiles: 0,
            },
          },
        };
      }
      if (operation.kind === "listTools") {
        return {
          ok: true as const,
          value: {
            outcome: "tools",
            tools: [
              { name: "exa", kind: "mcp", scope: "global", enabled: true },
              { name: "review", kind: "skill", scope: "global", enabled: true },
            ],
          },
        };
      }
      if (operation.kind === "diagnoseSession") {
        return {
          ok: true as const,
          value: {
            outcome: "sessionDiagnosis",
            diagnosis: {
              sessionId: operation.sessionId,
              status: "corrupt",
              report: {
                repaired: true,
                dryRun: true,
                resident: true,
                duplicatesRemoved: 1,
                syntheticResultsInserted: 0,
                strippedToolResultIds: ["t-1"],
              },
            },
          },
        };
      }
      if (operation.kind === "repairSession") {
        return {
          ok: true as const,
          value: {
            outcome: "sessionRepair",
            report: {
              repaired: true,
              dryRun: false,
              resident: true,
              duplicatesRemoved: 1,
              syntheticResultsInserted: 0,
              strippedToolResultIds: ["t-1"],
            },
          },
        };
      }
      return { ok: true as const, value: { outcome: "acknowledged" } };
    },
    openEvents(handlers: {
      onEvent: (envelope: EventEnvelope) => void;
      onOpen: () => void;
      onClose: () => void;
    }) {
      emit = handlers.onEvent;
      handlers.onOpen();
      return { close() {} } as unknown as WebSocket;
    },
  } as unknown as LightClient;

  return {
    client,
    sent,
    /** Subsequent send() calls fail with not_paired (demotion path). */
    failAllAsNotPaired() {
      failAllAsNotPaired = true;
    },
    emit(event: EventEnvelope["event"], sequence = 1) {
      emit?.({ protocolVersion: 2, eventSequence: sequence, event });
    },
  };
}

/** Hosted-style client that never pairs (landing must win). */
function unpairedHost() {
  const client = {
    get paired() {
      return false;
    },
    clearPairing() {},
    get bridgeBaseUrl() {
      return "";
    },
    setBridgeBaseUrl() {},
    async resume() {
      return { ok: false as const, failure: { kind: "not_paired" as const } };
    },
    async pair() {
      return { ok: false as const, failure: { kind: "rejected" as const } };
    },
    async send() {
      return { ok: false as const, failure: { kind: "not_paired" as const } };
    },
    openEvents() {
      return null;
    },
  } as unknown as LightClient;
  return client;
}

async function openWork(host: ReturnType<typeof fakeHost>) {
  render(
    <ThemeProvider>
      <App client={host.client} />
    </ThemeProvider>,
  );
  // Two conversations are open, so the Work surface is what appears.
  await waitFor(() => {
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
}

function composer() {
  return screen.getByRole("textbox", { name: /message the agent/i });
}

/**
 * Pick a conversation by its position in the sidebar.
 *
 * Rows are titled by their first user message, and these tests exercise
 * conversations that have not been prompted yet, so position is the stable
 * handle. Order is the host's and never changes with activity, which is what
 * makes it stable.
 */
async function switchToRow(index: number) {
  const rows = screen.getAllByRole("listitem");
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`no conversation at position ${index}`);
  }
  const select = row.querySelector("button");
  if (select === null) {
    throw new Error("conversation row has no selector");
  }
  await userEvent.click(select);
}

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "k-1" });
  // URL routing syncs to history; reset so a prior test cannot seed /s/:id.
  window.history.replaceState(null, "", "/");
});

describe("landing gate and demotion", () => {
  it("shows landing only when the browser is not paired", async () => {
    render(
      <ThemeProvider>
        <App client={unpairedHost()} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("landing-view")).toBeInTheDocument();
    });
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick a project/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "bridge_missing",
    );
  });

  it("demotes to landing when a command reports not_paired", async () => {
    const host = fakeHost();
    await openWork(host);
    expect(screen.queryByTestId("landing-view")).not.toBeInTheDocument();

    host.failAllAsNotPaired();
    await switchToRow(0);
    await userEvent.type(composer(), "still here");
    await userEvent.click(screen.getByRole("button", { name: /^send/i }));

    await waitFor(() => {
      expect(screen.getByTestId("landing-view")).toBeInTheDocument();
    });
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "needs_pairing",
    );
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pick a project/i)).not.toBeInTheDocument();
  });
});

describe("restored session configuration", () => {
  it("loads MCPs for a session restored directly into Work", async () => {
    const host = fakeHost();
    await openWork(host);

    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "listTools" &&
            call.operation.workspaceId === "w-1",
        ),
      ).toBe(true);
    });
    expect(screen.getByLabelText("1 MCP integration")).toBeInTheDocument();
    expect(screen.queryByText("review")).not.toBeInTheDocument();
  });
});

describe("drafts belong to their conversation", () => {
  it("does not carry what was typed in one conversation into another", async () => {
    // The reported bug: text written for one conversation followed the user to
    // the next, where pressing Send would have delivered it to the wrong one.
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    await switchToRow(0);
    await userEvent.type(composer(), "meant for the first one");
    await switchToRow(1);

    expect(composer()).toHaveValue("");
  });

  it("gives a draft back when the user returns to it", async () => {
    // Clearing on switch would fix the misdirection by throwing away the
    // user's own words, which is a different kind of surprise.
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    await switchToRow(0);
    await userEvent.type(composer(), "half a thought");
    await switchToRow(1);
    await switchToRow(0);

    expect(composer()).toHaveValue("half a thought");
  });

  it("sends to the conversation on screen", async () => {
    // No turn in flight here: a running conversation offers Stop rather than
    // Send, which is the case the queue covers.
    const host = fakeHost();
    await openWork(host);

    await switchToRow(1);
    await userEvent.type(composer(), "do this here");
    await userEvent.click(screen.getByRole("button", { name: /^send/i }));

    const prompts = host.sent.filter((call) => call.operation.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.operation.sessionId).toBe("s-2");
    expect(prompts[0]?.operation.text).toBe("do this here");
  });
});

describe("permission requests belong to their conversation", () => {
  it("does not replace a decision the user is being asked for", async () => {
    // Held in one slot, a second request overwrote the first. The first stayed
    // pending in the host and blocking in the agent, invisible and
    // unanswerable.
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);
    await switchToRow(0);

    host.emit(
      {
        kind: "permissionRequest",
        sessionId: "s-1",
        requestId: "perm-1",
        options: ["allow-once", "reject-once"],
      },
      3,
    );
    host.emit(
      {
        kind: "permissionRequest",
        sessionId: "s-2",
        requestId: "perm-2",
        options: ["allow-once", "reject-once"],
      },
      4,
    );

    // The dialog on screen still belongs to the conversation being read.
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /allow once/i }));

    const decisions = host.sent.filter((call) => call.operation.kind === "decidePermission");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.operation.sessionId).toBe("s-1");
    expect(decisions[0]?.operation.requestId).toBe("perm-1");
  });

  it("announces a decision waiting in a conversation that is not on screen", async () => {
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);
    await switchToRow(0);

    host.emit(
      {
        kind: "permissionRequest",
        sessionId: "s-2",
        requestId: "perm-2",
        options: ["allow-once", "reject-once"],
      },
      3,
    );

    await waitFor(() => {
      expect(screen.getByText("Needs you")).toBeInTheDocument();
    });
    // And it does not seize the screen from the conversation being read.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("transcripts belong to their conversation", () => {
  it("keeps each conversation's output to itself", async () => {
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "answer for one" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "answer for two" }, 2);

    await switchToRow(0);
    expect(screen.getByText("answer for one")).toBeInTheDocument();
    expect(screen.queryByText("answer for two")).not.toBeInTheDocument();
  });
});

describe("history diagnosis belongs to its conversation", () => {
  it("does not apply repair to another conversation after a dry-run", async () => {
    // Dry-run of s-1 must never authorize apply on s-2 after a sidebar switch.
    const host = fakeHost();
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    await switchToRow(0);
    await userEvent.click(
      screen.getByRole("button", { name: /check conversation history pairing/i }),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });

    await switchToRow(1);
    // s-2 has no dry-run of its own: no repair banner and no apply button.
    expect(screen.queryByRole("button", { name: /repair history/i })).not.toBeInTheDocument();
    expect(
      host.sent.filter((call) => call.operation.kind === "repairSession"),
    ).toHaveLength(0);

    // Check history on s-2 only diagnoses s-2.
    await userEvent.click(
      screen.getByRole("button", { name: /check conversation history pairing/i }),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /repair history/i }));

    const repairs = host.sent.filter((call) => call.operation.kind === "repairSession");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.operation.sessionId).toBe("s-2");
    expect(repairs[0]?.operation.dryRun).toBe(false);
  });

  it("keeps a late diagnose response on the session that was checked", async () => {
    // Hold the diagnose response so we can switch before it lands.
    let releaseDiagnose: (() => void) | undefined;
    const diagnoseGate = new Promise<void>((resolve) => {
      releaseDiagnose = resolve;
    });

    const host = fakeHost();
    const originalSend = host.client.send.bind(host.client) as LightClient["send"];
    (host.client as { send: LightClient["send"] }).send = async (operation, options) => {
      if (operation.kind === "diagnoseSession") {
        host.sent.push({ operation: operation as Sent["operation"] });
        await diagnoseGate;
        return {
          ok: true as const,
          value: {
            outcome: "sessionDiagnosis",
            diagnosis: {
              sessionId: operation.sessionId,
              status: "corrupt",
              report: {
                repaired: true,
                dryRun: true,
                resident: true,
                duplicatesRemoved: 1,
                syntheticResultsInserted: 0,
                strippedToolResultIds: ["t-1"],
              },
            },
          },
        };
      }
      return originalSend(operation, options);
    };

    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    await switchToRow(0);
    await userEvent.click(
      screen.getByRole("button", { name: /check conversation history pairing/i }),
    );
    // User switches away before dry-run returns.
    await switchToRow(1);
    releaseDiagnose?.();

    // Still on s-2: the late s-1 diagnosis must not paint s-2.
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "diagnoseSession" &&
            call.operation.sessionId === "s-1",
        ),
      ).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /repair history/i })).not.toBeInTheDocument();

    // Returning to s-1 shows the diagnosis that belongs to s-1.
    await switchToRow(0);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });
  });
});

describe("session review belongs to the conversation on screen", () => {
  it("refreshes the newly selected session and responds to its invalidation event", async () => {
    const host = fakeHost();
    await openWork(host);

    await userEvent.click(screen.getByRole("button", { name: /open review panel/i }));
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "getSessionInspector" &&
            call.operation.sessionId === "s-2",
        ),
      ).toBe(true);
    });

    await switchToRow(0);
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "getSessionChanges" &&
            call.operation.sessionId === "s-1" &&
            call.operation.mode === "git",
        ),
      ).toBe(true);
    });

    const before = host.sent.filter(
      (call) =>
        call.operation.kind === "getSessionInspector" && call.operation.sessionId === "s-1",
    ).length;
    host.emit(
      {
        kind: "sessionReviewUpdated",
        sessionId: "s-1",
        changes: true,
        context: true,
      },
      5,
    );
    await waitFor(() => {
      const after = host.sent.filter(
        (call) =>
          call.operation.kind === "getSessionInspector" && call.operation.sessionId === "s-1",
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
