/**
 * Behaviour that only exists once several conversations are open.
 *
 * State that became per conversation when light ADR 0011 landed used to be
 * held in single slots, and every symptom of that only appeared when the user
 * switched between conversations. That is App's job, so it is tested here
 * rather than through a view that never sees more than one at a time.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DraftStore, forgetDraftScope } from "./services/drafts";
import {
  LightClient,
  BRIDGE_SESSION_KEY,
  readStoredPort,
  writeStoredPort,
  writeStoredSession,
} from "./services/client";
import type { EventEnvelope } from "./services/protocol";
import type { EventHandlers } from "./services/client";
import { ThemeProvider } from "./theme/ThemeProvider";
import { reloadDocument } from "./services/browser";
import * as clientServices from "./services/client";
import * as shareInbox from "./services/shareInboxStore.js";

vi.mock("./services/browser", async (original) => ({...await original<typeof import("./services/browser")>(), reloadDocument: vi.fn()}));

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
    dispose() {},
    restoreFromStorage() {
      return false;
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
        // Default healthy so ordinary tests do not get a repair banner from
        // automatic dry-run when a conversation settles.
        return {
          ok: true as const,
          value: {
            outcome: "sessionDiagnosis",
            diagnosis: {
              sessionId: operation.sessionId,
              status: "healthy",
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
      handlers.onEvent({protocolVersion: 2, eventSequence: 0, event: {kind: "hostStatus", state: "controlling:1"}});
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
    restoreFromStorage() {
      return false;
    },
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

async function openWork(host: ReturnType<typeof fakeHost>, remoteHostId?: string, draftScope?: string) {
  render(
    <ThemeProvider>
      <App client={host.client} remoteHostId={remoteHostId} draftScope={draftScope} />
    </ThemeProvider>,
  );
  // Two conversations are open as top-bar tabs; bootstrap restores the latest.
  await waitFor(() => {
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
}

function composer() {
  return screen.getByRole("textbox", { name: /message the agent/i });
}

/**
 * Pick a conversation by its position in the top-bar tab list.
 *
 * Tabs are titled by their first user message, and these tests exercise
 * conversations that have not been prompted yet, so position is the stable
 * handle. Order is the host's and never changes with activity, which is what
 * makes it stable.
 */
async function switchToRow(index: number) {
  const tabs = screen.getAllByRole("tab");
  const tab = tabs[index];
  if (tab === undefined) {
    throw new Error(`no conversation tab at position ${index}`);
  }
  await userEvent.click(tab);
}

beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "k-1" });
  // URL routing syncs to history; reset so a prior test cannot seed /s/:id.
  window.history.replaceState(null, "", "/");
});

describe("incoming pairing navigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("pairs an already open page on hash navigation with private HTTPS %s", async (privateOrigin) => {
    vi.spyOn(clientServices, "isPrivateDocumentOrigin").mockReturnValue(privateOrigin);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ok: true, mode: "bridge", protocolVersion: 2})));
    const host = fakeHost();
    vi.spyOn(host.client, "paired", "get").mockReturnValue(false);
    const resume = vi.spyOn(host.client, "resume").mockResolvedValue({ok: false, failure: {kind: "not_paired"}});
    const pair = vi.spyOn(host.client, "pair");
    render(<ThemeProvider><App client={host.client} /></ThemeProvider>);
    await waitFor(() => expect(screen.getByTestId("landing-view")).not.toHaveAttribute("data-probe-kind", "checking"));
    const nonce = "a".repeat(64);
    act(() => {
      history.replaceState(null, "", `/#pair=${nonce}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(pair).toHaveBeenCalledExactlyOnceWith(nonce);
    expect(location.hash).toBe("");
    expect(reloadDocument).not.toHaveBeenCalled();
    act(() => {
      history.replaceState(null, "", "/#unrelated");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(pair).toHaveBeenCalledOnce();
  });

  it("keeps an incoming pairing after the previous bootstrap reports an expired session", async () => {
    const host = fakeHost();
    vi.spyOn(host.client, "paired", "get").mockReturnValue(false);
    let finish: (result: Awaited<ReturnType<LightClient["resume"]>>) => void = () => {};
    vi.spyOn(host.client, "resume").mockImplementation(() => new Promise((resolve) => {finish = resolve;}));
    const clear = vi.spyOn(host.client, "clearPairing");
    render(<ThemeProvider><App client={host.client} /></ThemeProvider>);
    act(() => {
      history.replaceState(null, "", `/#pair=${"b".repeat(64)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    await act(async () => finish({ok: false, failure: {kind: "not_paired"}}));
    expect(screen.queryByTestId("landing-view")).not.toBeInTheDocument();
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("session model metadata", () => {
  it.each(["grok-4.6-build", "grok-unlisted"])("uses each session's confirmed %s settings without changing them on mount", async (confirmedModel) => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      if (operation.kind === "listModels") return {ok: true, value: {outcome: "models", defaultModelId: "grok-4.5", models: ["grok-4.5", "grok-4.6-build"].map((id) => ({id, name: id, supportsReasoningEffort: true, reasoningEfforts: [{id: "high", label: "High"}, {id: "low", label: "Low"}], defaultEffort: "high"}))}};
      if (operation.kind === "getSessionInspector") return {ok: true, value: {outcome: "sessionInspector", inspector: {sessionId: operation.sessionId, model: operation.sessionId === "s-2" ? confirmedModel : "grok-4.5", ...(operation.sessionId === "s-2" ? {reasoningEffort: "low"} : {}), turns: 0, turnIndex: 0, availableChangeModes: []}}};
      return original(operation, options);
    });
    await openWork(host);
    await waitFor(() => expect(screen.getByRole("button", {name: "Model"})).toHaveTextContent(confirmedModel));
    if (confirmedModel === "grok-4.6-build") expect(screen.getByRole("button", {name: "Reasoning effort"})).toHaveTextContent("Low");
    else expect(screen.queryByRole("button", {name: "Reasoning effort"})).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("tab")[0]!);
    await waitFor(() => expect(screen.getByRole("button", {name: "Model"})).toHaveTextContent("grok-4.5"));
    expect(screen.getByRole("button", {name: "Reasoning effort"})).toHaveTextContent("Effort unknown");
    expect(send.mock.calls.some(([operation]) => operation.kind === "setSessionModel")).toBe(false);
  });
});

it("reconciles Send now with its confirmed host echo", async () => {
  const host = fakeHost();
  const send = vi.spyOn(host.client, "send");
  await openWork(host);
  act(() => host.emit({kind: "sessionStatus", sessionId: "s-2", state: "running"}));
  await userEvent.type(composer(), "Use this message instead");
  await userEvent.click(screen.getByRole("button", {name: "Stop the current turn and send this now"}));
  const submitted = send.mock.calls.find(([operation]) => operation.kind === "sendNow");
  expect(submitted?.[1]?.idempotencyKey).toBe("k-1");
  act(() => host.emit({kind: "promptSent", sessionId: "s-2", text: "Use this message instead", idempotencyKey: "k-1"}, 3));
  expect(document.querySelectorAll('[data-turn-id^="u-"]')).toHaveLength(1);
  expect(document.querySelector('[data-turn-id="u-k-1"]')).toHaveTextContent("Use this message instead");
});

describe("connection readiness and retry budget", () => {
  afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

  it("bounds retries when sockets open and close without an authorized host greeting", async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    const handlers: EventHandlers[] = [];
    const open = vi.spyOn(host.client, "openEvents").mockImplementation((next) => {
      handlers.push(next);
      next.onOpen();
      return {close() {}, send() {}};
    });
    await act(async () => {render(<ThemeProvider><App client={host.client} /></ThemeProvider>);});
    expect(open).toHaveBeenCalledOnce();
    expect(composer()).toBeDisabled();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await act(async () => {
        handlers[attempt].onClose();
        await vi.advanceTimersByTimeAsync(Math.min(2_000 * 2 ** attempt, 30_000));
      });
    }
    expect(open).toHaveBeenCalledTimes(9);
    await act(async () => {handlers[8].onClose(); await vi.advanceTimersByTimeAsync(120_000);});
    expect(open).toHaveBeenCalledTimes(9);
    expect(screen.getByRole("button", {name: "Retry"})).toBeEnabled();
    expect(composer()).toBeDisabled();
  });

  it("times out silent sockets and accepts a watching greeting as a live connection", async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    const handlers: EventHandlers[] = [];
    const close = vi.fn();
    const open = vi.spyOn(host.client, "openEvents").mockImplementation((next) => {
      handlers.push(next);
      next.onOpen();
      return {close, send() {}};
    });
    await act(async () => {render(<ThemeProvider><App client={host.client} /></ThemeProvider>);});
    await act(async () => {await vi.advanceTimersByTimeAsync(10_000);});
    expect(close).toHaveBeenCalledOnce();
    await act(async () => {await vi.advanceTimersByTimeAsync(2_000);});
    expect(open).toHaveBeenCalledTimes(2);
    act(() => handlers[1].onEvent({protocolVersion: 2, eventSequence: 0, event: {kind: "hostStatus", state: "watching"}}));
    expect(screen.getByText(/Another browser tab has control/)).toBeInTheDocument();
    expect(composer()).toBeDisabled();
    await act(async () => {await vi.advanceTimersByTimeAsync(60_000);});
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    act(() => handlers[1].onEvent({protocolVersion: 2, eventSequence: 0, event: {kind: "hostStatus", state: "controlling:2"}}));
    expect(composer()).toBeEnabled();
  });
});

it("applies watching authority across the shell and restores creation only after control returns", async () => {
  const host = fakeHost();
  await openWork(host);
  const close = screen.getAllByRole("button", {name: /^Close New conversation$/})[0]!;
  close.focus();
  act(() => host.emit({kind: "hostStatus", state: "watching"}));
  expect(close).toBeDisabled();
  await userEvent.keyboard("{Enter} ");
  await userEvent.click(close);
  expect(host.sent.some(({operation}) => operation.kind === "closeSession")).toBe(false);
  await userEvent.click(screen.getAllByRole("tab")[0]!);
  expect(host.sent.some(({operation}) => operation.kind === "diagnoseSession" && operation.sessionId === "s-1")).toBe(false);
  await userEvent.click(screen.getByRole("button", {name: "Home"}));
  expect(screen.getByRole("button", {name: "Add a project"})).toBeDisabled();
  await userEvent.click(screen.getByRole("button", {name: "Open project test"}));
  for (const button of screen.getAllByRole("button", {name: "New session"})) {
    expect(button).toBeDisabled();
    await userEvent.click(button);
  }
  expect(host.sent.some(({operation}) => ["createSession", "openWorkspacePicker"].includes(operation.kind))).toBe(false);
  act(() => host.emit({kind: "hostStatus", state: "controlling:2"}));
  expect(screen.getByRole("button", {name: "Add a project"})).toBeEnabled();
  const create = screen.getAllByRole("button", {name: "New session"})[0]!;
  create.focus();
  await userEvent.keyboard("{Enter}");
  expect(host.sent.filter(({operation}) => operation.kind === "createSession")).toHaveLength(1);
});

describe("landing gate and demotion", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it.each(["token", "port", "removed"])("refreshes unchanged grants without traffic and reloads when authority is %s", async (change) => {
    vi.mocked(reloadDocument).mockClear();
    const host = fakeHost();
    const resume = vi.spyOn(host.client, "resume");
    const restore = vi.spyOn(host.client, "restoreFromStorage");
    const dispose = vi.spyOn(host.client, "dispose");
    const close = vi.fn();
    const implementation = host.client.openEvents.bind(host.client);
    const open = vi.spyOn(host.client, "openEvents");
    open.mockImplementation((handlers) => {implementation(handlers); return {close, send() {}};});
    await openWork(host);
    const grant = {port: 20001, sessionToken: "token", csrfToken: "csrf", savedAtMs: 1};
    const calls = resume.mock.calls.length;
    act(() => window.dispatchEvent(new StorageEvent("storage", {key: BRIDGE_SESSION_KEY, oldValue: JSON.stringify(grant), newValue: JSON.stringify({...grant, savedAtMs: 2})})));
    expect(resume).toHaveBeenCalledTimes(calls);
    expect(screen.queryByTestId("landing-view")).not.toBeInTheDocument();
    const restores = restore.mock.calls.length;
    act(() => window.dispatchEvent(new StorageEvent("storage", {key: BRIDGE_SESSION_KEY, oldValue: JSON.stringify(grant), newValue: JSON.stringify({...grant, csrfToken: "rotated"})})));
    expect(resume).toHaveBeenCalledTimes(calls);
    expect(restore).toHaveBeenCalledTimes(restores + 1);
    expect(reloadDocument).not.toHaveBeenCalled();
    const replacement = change === "removed" ? null : JSON.stringify({...grant, ...(change === "port" ? {port: 20002} : {sessionToken: "replacement"})});
    act(() => window.dispatchEvent(new StorageEvent("storage", {key: BRIDGE_SESSION_KEY, oldValue: JSON.stringify(grant), newValue: replacement})));
    expect(resume).toHaveBeenCalledTimes(calls);
    expect(dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(reloadDocument).toHaveBeenCalledOnce();
  });

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

  it("keeps remembered port and serve-focused copy when healthz fails", async () => {
    // Real App path: durable port + dead loopback → bridge_missing with hadPort,
    // not full install (install.sh), and port remains for Retry.
    localStorage.clear();
    sessionStorage.clear();
    writeStoredPort(29578);
    writeStoredSession({
      port: 29578,
      sessionToken: "stale-sess",
      csrfToken: "stale-csrf",
      savedAtMs: Date.now(),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    const client = new LightClient();
    expect(client.bridgeBaseUrl).toBe("http://127.0.0.1:29578");

    render(
      <ThemeProvider>
        <App client={client} />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("landing-view")).toBeInTheDocument();
    });
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "bridge_missing",
    );
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-had-port",
      "1",
    );
    expect(screen.getByText(/remembers a local host port/i)).toBeInTheDocument();
    expect(screen.getByTestId("landing-install")).toHaveTextContent(
      "spanreed agent serve",
    );
    expect(screen.getByTestId("landing-install")).not.toHaveTextContent(
      "install.sh",
    );
    // Port must survive so Retry / serve can re-probe the same base.
    expect(readStoredPort()).toBe(29578);
    expect(client.paired).toBe(true);
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
  it("keeps tabs and unsent drafts when a restarted host has no resident sessions", async () => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    let restarted = false;
    const restored = new Set<string>();
    const complete = new Map<string, () => void>();
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "loadSession") {
        await new Promise<void>((resolve) => complete.set(operation.sessionId, resolve));
        restored.add(operation.sessionId);
        return {ok: true, value: {outcome: "sessionCreated", sessionId: operation.sessionId}};
      }
      if (operation.kind === "listWorkspaces" && restarted && result.ok) {
        const value = result.value as {outcome: "workspaces"; openSessions: {sessionId: string}[]};
        return {ok: true, value: {...value, openSessions: value.openSessions.filter((session) => restored.has(session.sessionId))}};
      }
      return result;
    });
    const open = vi.spyOn(host.client, "openEvents");
    await openWork(host);
    await switchToRow(0);
    await userEvent.type(composer(), "first unsent draft");
    await switchToRow(1);
    await userEvent.type(composer(), "S24_SUSPEND_KEEP");
    act(() => open.mock.calls.at(-1)?.[0].onClose());
    restarted = true;
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => host.emit({kind: "replayReset"}, 0));
    expect(composer()).toHaveValue("S24_SUSPEND_KEEP");
    expect(location.pathname).toBe("/s/s-2");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await waitFor(() => expect(send.mock.calls.some(([operation]) => operation.kind === "loadSession" && operation.sessionId === "s-2")).toBe(true));
    expect(composer()).toBeDisabled();
    await act(async () => host.emit({kind: "replayReset"}, 0));
    await act(async () => host.emit({kind: "workspacesChanged"}, 1));
    const loads = () => send.mock.calls.filter(([operation]) => operation.kind === "loadSession");
    expect(loads()).toHaveLength(1);
    expect(loads()[0]).toEqual([{kind: "loadSession", workspaceId: "w-1", sessionId: "s-2"}, {idempotencyKey: "k-1"}]);
    await act(async () => complete.get("s-2")?.());
    await waitFor(() => expect(composer()).toBeEnabled());
    await switchToRow(0);
    expect(composer()).toHaveValue("first unsent draft");
    expect(composer()).toBeDisabled();
    await waitFor(() => expect(loads()).toHaveLength(2));
    expect(loads()[1]?.[0]).toEqual({kind: "loadSession", workspaceId: "w-1", sessionId: "s-1"});
    await act(async () => complete.get("s-1")?.());
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(host.sent.some(({operation}) => operation.kind === "prompt" || operation.kind === "sendNow")).toBe(false);
  });

  it.each(["unreachable", "interrupted_needs_review"])("waits for control and retains a draft without retrying recovery after %s", async (failure) => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    let restarted = false;
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "loadSession") return {ok: false, failure: failure === "unreachable" ? {kind: "unreachable"} : {kind: "refused", code: failure}};
      if (operation.kind === "listWorkspaces" && restarted && result.ok) return {ok: true, value: {...result.value as object, openSessions: []}};
      return result;
    });
    await openWork(host);
    await userEvent.type(composer(), "keep after uncertain recovery");
    restarted = true;
    await act(async () => host.emit({kind: "hostStatus", state: "watching"}, 0));
    await act(async () => host.emit({kind: "replayReset"}, 0));
    const loads = () => send.mock.calls.filter(([operation]) => operation.kind === "loadSession");
    expect(loads()).toHaveLength(0);
    expect(composer()).toBeDisabled();
    await act(async () => host.emit({kind: "hostStatus", state: "controlling:2"}, 0));
    await waitFor(() => expect(loads()).toHaveLength(1));
    await act(async () => host.emit({kind: "workspacesChanged"}, 1));
    await act(async () => host.emit({kind: "replayReset"}, 0));
    expect(loads()).toHaveLength(1);
    expect(composer()).toHaveValue("keep after uncertain recovery");
    expect(composer()).toBeDisabled();
    expect(location.pathname).toBe("/s/s-2");
    await userEvent.click(screen.getByRole("button", {name: "Reopen conversation"}));
    await waitFor(() => expect(loads()).toHaveLength(2));
    expect(host.sent.some(({operation}) => operation.kind === "prompt" || operation.kind === "sendNow")).toBe(false);
  });

  it("removes a normally closed session without reopening it", async () => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    let closed = false;
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "closeSession" && operation.sessionId === "s-2") closed = true;
      if (operation.kind === "listWorkspaces" && closed && result.ok) {
        const value = result.value as {outcome: "workspaces"; openSessions: {sessionId: string}[]};
        return {ok: true, value: {...value, openSessions: value.openSessions.filter((session) => session.sessionId !== "s-2")}};
      }
      return result;
    });
    await openWork(host);
    await userEvent.type(composer(), "discard when closing");
    await userEvent.click(screen.getAllByRole("button", {name: "Close New conversation"})[1]!);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(location.pathname).toBe("/s/s-1");
    expect(send.mock.calls.some(([operation]) => operation.kind === "loadSession")).toBe(false);
  });

  it("ignores an empty workspace reply delivered after recovery confirms the session", async () => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    let restarted = false;
    let loaded = false;
    let holdListing = false;
    let finishLoad: (() => void) | undefined;
    let finishListing: (() => void) | undefined;
    vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "loadSession") {
        await new Promise<void>((resolve) => {finishLoad = resolve;});
        loaded = true;
        return {ok: true, value: {outcome: "sessionCreated", sessionId: operation.sessionId}};
      }
      if (operation.kind === "listWorkspaces" && restarted && result.ok) {
        const value = result.value as {outcome: "workspaces"; openSessions: {sessionId: string}[]};
        const snapshot = {ok: true as const, value: {...value, openSessions: loaded ? value.openSessions.filter((session) => session.sessionId === "s-2") : []}};
        if (holdListing) {
          holdListing = false;
          return new Promise((resolve) => {finishListing = () => resolve(snapshot);});
        }
        return snapshot;
      }
      return result;
    });
    await openWork(host);
    await userEvent.type(composer(), "keep after a late workspace reply");
    restarted = true;
    await act(async () => host.emit({kind: "replayReset"}, 0));
    await waitFor(() => expect(finishLoad).toBeDefined());
    holdListing = true;
    await act(async () => host.emit({kind: "workspacesChanged"}, 1));
    await waitFor(() => expect(finishListing).toBeDefined());
    await act(async () => finishLoad?.());
    await waitFor(() => expect(composer()).toBeEnabled());
    await act(async () => finishListing?.());
    expect(composer()).toHaveValue("keep after a late workspace reply");
    expect(location.pathname).toBe("/s/s-2");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it.each(["success", "failure"])("ignores an old recovery's late %s after pairing again in the same page", async (outcome) => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    const pair = host.client.pair.bind(host.client);
    let restarted = false;
    let finish: ((result: Awaited<ReturnType<LightClient["send"]>>) => void) | undefined;
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "loadSession") return new Promise((resolve) => {finish = resolve;});
      if (operation.kind === "listWorkspaces" && restarted && result.ok) return {ok: true, value: {...result.value as object, openSessions: []}};
      return result;
    });
    vi.spyOn(host.client, "pair").mockImplementation(async (nonce) => {
      restarted = false;
      return pair(nonce);
    });
    await openWork(host);
    await userEvent.type(composer(), "keep after new pairing");
    restarted = true;
    await act(async () => host.emit({kind: "replayReset"}, 0));
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => {
      history.replaceState(null, "", `/#pair=${"e".repeat(64)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(composer()).toBeEnabled());
    const reads = () => send.mock.calls.filter(([operation]) => operation.kind === "listWorkspaces" || operation.kind === "getSessionInspector").length;
    const before = reads();
    await act(async () => finish?.(outcome === "success" ? {ok: true, value: {outcome: "sessionCreated", sessionId: "s-2"}} : {ok: false, failure: {kind: "refused", code: "agent_failed"}}));
    expect(reads()).toBe(before);
    expect(screen.queryByText("The Grok Build CLI stopped responding. Check it is installed and authenticated.")).not.toBeInTheDocument();
    expect(composer()).toHaveValue("keep after new pairing");
    expect(composer()).toBeEnabled();
  });

  it("recovers under a new pairing while an older recovery remains pending", async () => {
    const host = fakeHost();
    const original = host.client.send.bind(host.client);
    let restarted = false;
    let loaded = false;
    const complete: Array<() => void> = [];
    const send = vi.spyOn(host.client, "send").mockImplementation(async (operation, options) => {
      const result = await original(operation, options);
      if (operation.kind === "loadSession") {
        const index = complete.length;
        await new Promise<void>((resolve) => complete.push(resolve));
        if (index === 1) loaded = true;
        return {ok: true, value: {outcome: "sessionCreated", sessionId: operation.sessionId}};
      }
      if (operation.kind === "listWorkspaces" && restarted && !loaded && result.ok) return {ok: true, value: {...result.value as object, openSessions: []}};
      return result;
    });
    await openWork(host);
    await userEvent.type(composer(), "preserve across pairing generations");
    restarted = true;
    await act(async () => host.emit({kind: "replayReset"}, 0));
    await waitFor(() => expect(complete).toHaveLength(1));
    await act(async () => {
      history.replaceState(null, "", `/#pair=${"f".repeat(64)}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(complete).toHaveLength(2));
    await act(async () => complete[0]?.());
    expect(screen.getByRole("button", {name: "Reopen conversation"})).toBeDisabled();
    expect(composer()).toBeDisabled();
    expect(composer()).toHaveValue("preserve across pairing generations");
    await act(async () => complete[1]?.());
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(send.mock.calls.filter(([operation]) => operation.kind === "loadSession")).toHaveLength(2);
    expect(host.sent.some(({operation}) => operation.kind === "prompt" || operation.kind === "sendNow")).toBe(false);
  });

  it("keeps each unsent draft through visibility changes, disconnection, and recovery", async () => {
    const host = fakeHost();
    const open = vi.spyOn(host.client, "openEvents");
    await openWork(host);
    await switchToRow(0);
    await userEvent.type(composer(), "first unsent draft");
    await switchToRow(1);
    await userEvent.type(composer(), "S24_DRAFT_KEEP_UNSENT");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(composer()).toHaveValue("S24_DRAFT_KEEP_UNSENT");
    act(() => open.mock.calls.at(-1)?.[0].onClose());
    expect(composer()).toBeDisabled();
    expect(composer()).toHaveValue("S24_DRAFT_KEEP_UNSENT");
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(composer()).toBeEnabled();
    expect(composer()).toHaveValue("S24_DRAFT_KEEP_UNSENT");
    await switchToRow(0);
    expect(composer()).toHaveValue("first unsent draft");
    expect(host.sent.some(({ operation }) => operation.kind === "prompt")).toBe(false);
  });

  it("withdraws sharing controls and an open publication dialog when the browser loses control", async () => {
    HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({shares: []}));
    const host = fakeHost();
    Object.defineProperty(host.client, "remote", {value: true});
    const send = host.client.send.bind(host.client);
    host.client.send = async (operation, options) => operation.kind === "previewPublication" ? {ok: true, value: {outcome: "publicationPreview", document: {title: "Review", entries: []}, availableImages: [], selectedImageHashes: [], previewDigest: "a".repeat(64), totalBytes: 0, totalEntries: 0}} : operation.kind === "getPublicationStatus" ? {ok: true, value: {outcome: "publicationStatus", authorized: true, publications: []}} : send(operation, options);
    await openWork(host, undefined, '["direct","synthetic-test-computer"]');
    await userEvent.click(screen.getByRole("button", {name: "Share conversation"}));
    expect(await screen.findByRole("dialog", {name: "Publish this conversation"})).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    act(() => host.emit({kind: "hostStatus", state: "watching"}, 0));
    expect(screen.queryByRole("dialog", {name: "Publish this conversation"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Share conversation"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Publish and sync"})).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fetch.mockRestore();
  });

  it("keeps the draft while watching and explicitly retries acquisition of control", async () => {
    const host = fakeHost();
    const open = vi.spyOn(host.client, "openEvents");
    await openWork(host);
    await userEvent.type(composer(), "draft kept while watching");
    act(() => host.emit({kind: "hostStatus", state: "watching"}, 0));
    expect(screen.getByRole("button", {name: /^send/i})).toBeDisabled();
    expect(screen.getByText(/Another browser tab has control/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", {name: "Retry control"}));
    expect(open).toHaveBeenCalledTimes(2);
    act(() => host.emit({kind: "hostStatus", state: "controlling:2"}, 0));
    expect(composer()).toHaveValue("draft kept while watching");
    expect(screen.getByRole("button", {name: /^send/i})).toBeEnabled();
    expect(host.sent.some((entry) => entry.operation.kind === "prompt")).toBe(false);
  });
  it.each(["promptQueued", "commandAccepted"])("removes only the correlated optimistic entry when a prompt is queued (%s)", async (outcome) => {
    const host = fakeHost();
    const send = host.client.send.bind(host.client);
    let key = "";
    host.client.send = async (operation, options) => {
      if (operation.kind === "prompt") {
        key = options?.idempotencyKey ?? "";
        return {ok: true, value: {outcome}};
      }
      return send(operation, options);
    };
    await openWork(host);
    await switchToRow(0);
    host.emit({kind: "promptSent", sessionId: "s-1", text: "same message"}, 5);
    host.emit({kind: "sessionStatus", sessionId: "s-1", state: "idle"}, 6);
    await userEvent.type(composer(), "same message");
    await userEvent.click(screen.getByRole("button", {name: /^send/i}));
    if (outcome === "commandAccepted") {
      expect(screen.getAllByRole("article", {name: "Your message"})).toHaveLength(2);
      host.emit({kind: "promptSent", sessionId: "s-1", text: "same message"}, 7);
      await switchToRow(1);
      host.emit({kind: "commandCompleted", idempotencyKey: key, result: {outcome: "promptQueued", sessionId: "s-1", entryId: "queue-1"}}, 8);
      await switchToRow(0);
      await waitFor(() => expect(screen.getAllByRole("article", {name: "Your message"})).toHaveLength(2));
      expect(document.querySelector('[data-turn-id="q-7"]')).not.toBeNull();
    } else {
      await waitFor(() => expect(screen.getAllByRole("article", {name: "Your message"})).toHaveLength(1));
    }
    expect(document.querySelector('[data-turn-id="q-5"]')).not.toBeNull();
    expect(document.querySelector(`[data-turn-id="u-${key}"]`)).toBeNull();
  });

  it("keeps a delivered prompt after asynchronous completion", async () => {
    const host = fakeHost();
    const send = host.client.send.bind(host.client);
    let key = "";
    host.client.send = async (operation, options) => {
      if (operation.kind === "prompt") {
        key = options?.idempotencyKey ?? "";
        return {ok: true, value: {outcome: "commandAccepted"}};
      }
      return send(operation, options);
    };
    await openWork(host);
    await userEvent.type(composer(), "delivered prompt");
    await userEvent.click(screen.getByRole("button", {name: /^send/i}));
    host.emit({kind: "commandCompleted", idempotencyKey: key, result: {outcome: "promptDone"}}, 9);
    await waitFor(() => expect(screen.getByRole("article", {name: "Your message"})).toHaveTextContent("delivered prompt"));
  });

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
  it("removes requests resolved in the terminal from both queues without losing unrelated requests or other sessions", async () => {
    HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
    HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
    const host = fakeHost();
    await openWork(host);
    await switchToRow(0);
    act(() => {
      host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "first", title: "First request", options: ["allow-once", "reject-once"]});
      host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "second", title: "Second request", options: ["allow-once", "reject-once"]}, 2);
      host.emit({kind: "permissionRequest", sessionId: "s-2", requestId: "first", title: "Other session request", options: ["allow-once", "reject-once"]}, 3);
      host.emit({kind: "interactionRequest", sessionId: "s-1", requestId: "plan-1", interactionKind: "plan", details: {planContent: "First plan"}}, 4);
      host.emit({kind: "interactionRequest", sessionId: "s-1", requestId: "plan-2", interactionKind: "plan", details: {planContent: "Second plan"}}, 5);
    });
    expect(screen.getByRole("alertdialog", {name: "First request"})).toBeInTheDocument();
    act(() => host.emit({kind: "interactionResolved", sessionId: "s-1", requestId: "first"}, 6));
    expect(screen.getByRole("alertdialog", {name: "Second request"})).toBeInTheDocument();
    act(() => host.emit({kind: "interactionResolved", sessionId: "s-1", requestId: "second"}, 7));
    expect(screen.getByText("First plan")).toBeInTheDocument();
    act(() => host.emit({kind: "interactionResolved", sessionId: "s-1", requestId: "plan-1"}, 8));
    expect(screen.getByText("Second plan")).toBeInTheDocument();
    expect(screen.queryByText("First plan")).not.toBeInTheDocument();
    await switchToRow(1);
    expect(screen.getByRole("alertdialog", {name: "Other session request"})).toBeInTheDocument();
    expect(host.sent.some((entry) => ["decidePermission", "answerInteraction"].includes(entry.operation.kind))).toBe(false);
  });

  it("answers simultaneous requests in order without overwriting the first", async () => {
    const host = fakeHost();
    await openWork(host);
    await switchToRow(0);
    act(() => {
      host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "first", title: "First request", options: ["allow-once", "reject-once"]});
      host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "second", title: "Second request", options: ["allow-once", "reject-once"]}, 2);
    });
    expect(screen.getByRole("alertdialog", {name: "First request"})).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", {name: "Allow once"}));
    expect(await screen.findByRole("alertdialog", {name: "Second request"})).toBeInTheDocument();
    expect(host.sent.find((entry) => entry.operation.kind === "decidePermission")?.operation.requestId).toBe("first");
  });

  it("keeps reconnect reachable inside a disconnected permission dialog", async () => {
    const host = fakeHost();
    const open = vi.spyOn(host.client, "openEvents");
    await openWork(host);
    await switchToRow(0);
    act(() => host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "first", title: "Pending request", options: ["allow-once", "reject-once"]}));
    act(() => open.mock.calls.at(-1)?.[0].onClose());
    expect(screen.getByRole("button", {name: "Allow once"})).toBeDisabled();
    await userEvent.click(screen.getByRole("button", {name: "Reconnect"}));
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alertdialog", {name: "Pending request"})).toBeInTheDocument();
  });

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
  function withCorruptDiagnose(host: ReturnType<typeof fakeHost>) {
    const originalSend = host.client.send.bind(host.client) as LightClient["send"];
    (host.client as { send: LightClient["send"] }).send = async (operation, options) => {
      if (operation.kind === "diagnoseSession") {
        host.sent.push({ operation: operation as Sent["operation"] });
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
  }

  it("auto-diagnoses when a conversation settles and offers repair only for corrupt", async () => {
    const host = fakeHost();
    withCorruptDiagnose(host);
    await openWork(host);

    // Bootstrap restores the latest tab (s-2); dry-run is automatic.
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "diagnoseSession" &&
            call.operation.sessionId === "s-2",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });
    // No permanent Check history control.
    expect(
      screen.queryByRole("button", { name: /check conversation history pairing/i }),
    ).not.toBeInTheDocument();
    // Apply is never automatic.
    expect(
      host.sent.filter((call) => call.operation.kind === "repairSession"),
    ).toHaveLength(0);
  });

  it("does not apply repair to another conversation after a dry-run", async () => {
    // Dry-run of s-1 must never authorize apply on s-2 after a tab switch.
    const host = fakeHost();
    withCorruptDiagnose(host);
    await openWork(host);
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });

    await switchToRow(0);
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "diagnoseSession" &&
            call.operation.sessionId === "s-1",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });

    await switchToRow(1);
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
    /** First open settles on s-2; hold only s-1 so we can race a late reply. */
    let holdS1 = false;

    const host = fakeHost();
    const originalSend = host.client.send.bind(host.client) as LightClient["send"];
    (host.client as { send: LightClient["send"] }).send = async (operation, options) => {
      if (operation.kind === "diagnoseSession") {
        host.sent.push({ operation: operation as Sent["operation"] });
        if (holdS1 && operation.sessionId === "s-1") {
          await diagnoseGate;
        }
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
    // s-2 auto-diagnose completes and may show a banner; dismiss is not required
    // for the race — we switch to s-1 and hold that dry-run.
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "diagnoseSession" &&
            call.operation.sessionId === "s-2",
        ),
      ).toBe(true);
    });
    host.emit({ kind: "messageDelta", sessionId: "s-1", text: "first" });
    host.emit({ kind: "messageDelta", sessionId: "s-2", text: "second" }, 2);

    holdS1 = true;
    await switchToRow(0);
    await waitFor(() => {
      expect(
        host.sent.some(
          (call) =>
            call.operation.kind === "diagnoseSession" &&
            call.operation.sessionId === "s-1",
        ),
      ).toBe(true);
    });
    // User switches away before s-1 dry-run returns.
    await switchToRow(1);
    releaseDiagnose?.();

    // Still on s-2: s-2's own prior diagnosis may show Repair; that is fine.
    // Returning to s-1 must show the diagnosis that belongs to s-1 (not lost).
    await switchToRow(0);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /repair history/i })).toBeInTheDocument();
    });
  });

  it("stays silent when automatic dry-run reports healthy", async () => {
    const host = fakeHost();
    await openWork(host);
    await waitFor(() => {
      expect(
        host.sent.some((call) => call.operation.kind === "diagnoseSession"),
      ).toBe(true);
    });
    expect(screen.queryByRole("button", { name: /repair history/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /check conversation history pairing/i }),
    ).not.toBeInTheDocument();
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


describe("computer settings and required decisions", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("offers direct source information without experiments and returns from its dialog without leaving settings or the conversation", async () => {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "");
    HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
    HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
    const host = fakeHost();
    Object.defineProperty(host.client, "remote", {value: true});
    await openWork(host);
    const input = composer();
    fireEvent.change(input, {target: {value: "Keep this unfinished message"}});
    await userEvent.click(screen.getByRole("button", {name: "Computer settings"}));
    const trigger = screen.getByRole("button", {name: "Source and license"});
    await userEvent.click(trigger);
    const sourceDialog = screen.getByRole("dialog", {name: "Source and license"});
    fireEvent(sourceDialog, new Event("cancel", {cancelable: true}));
    expect(screen.queryByRole("dialog", {name: "Source and license"})).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", {name: "Computer settings"})).toBeVisible();
    expect(trigger).toHaveFocus();
    await userEvent.click(screen.getByRole("button", {name: "Close computer settings"}));
    expect(composer()).toBe(input);
    expect(input).toHaveValue("Keep this unfinished message");
    expect(host.sent.some(({operation}) => ["listRemoteProjects", "listBrowserDevices", "requestControl", "prompt"].includes(operation.kind))).toBe(false);
  });
  it("yields settings to the active permission without replacing the composer or deciding anything", async () => {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects");
    HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
    HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
    const host = fakeHost();
    await openWork(host);
    await switchToRow(0);
    const input = composer();
    fireEvent.change(input, {target: {value: "Keep this unfinished message"}});
    await userEvent.click(screen.getByRole("button", {name: "Computer settings"}));
    expect(screen.getByRole("dialog", {name: "Computer settings"})).toBeVisible();
    act(() => host.emit({kind: "permissionRequest", sessionId: "s-1", requestId: "priority", title: "Confirm the action", options: ["allow-once", "reject-once"]}));
    expect(screen.queryByRole("dialog", {name: "Computer settings"})).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog", {name: "Confirm the action"})).toHaveFocus();
    expect(composer()).toBe(input);
    expect(input).toHaveValue("Keep this unfinished message");
    act(() => host.emit({kind: "interactionResolved", sessionId: "s-1", requestId: "priority"}, 2));
    expect(screen.queryByRole("dialog", {name: "Computer settings"})).not.toBeInTheDocument();
    expect(host.sent.some(({operation}) => ["decidePermission", "answerInteraction", "prompt"].includes(operation.kind))).toBe(false);
  });
});

describe("experimental durable drafts", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("recovers per-session drafts after remount without sending anything", async () => {
    HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
    HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "drafts");
    const host = fakeHost();
    const first = render(<ThemeProvider><App client={host.client} draftScope="managed-test" /></ThemeProvider>);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    fireEvent.change(composer(), {target: {value: "durable unsent"}});
    await userEvent.click(await screen.findByRole("button", {name: "Drafts off"}));
    await waitFor(() => expect(screen.getByRole("button", {name: "Remember drafts on this device"})).toBeEnabled());
    await userEvent.click(screen.getByRole("button", {name: "Remember drafts on this device"}));
    expect(await new DraftStore("managed-test").read()).toEqual({"s-2": "durable unsent"});
    first.unmount();
    const next = fakeHost();
    render(<ThemeProvider><App client={next.client} draftScope="managed-test" /></ThemeProvider>);
    await waitFor(() => expect(composer()).toHaveValue("durable unsent"));
    expect(next.sent.some(({operation}) => ["prompt", "sendNow"].includes(operation.kind))).toBe(false);
    await act(async () => forgetDraftScope("managed-test"));
    expect(composer()).toHaveValue("");
    expect(screen.getByRole("button", {name: "Drafts off"})).toBeVisible();
  });
  it("does not offer or read saved drafts in ordinary builds", async () => {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "");
    const store = new DraftStore("managed-disabled"); await store.enable(); await store.write("s-2", "do not read");
    const host = fakeHost();
    render(<ThemeProvider><App client={host.client} draftScope="managed-disabled" /></ThemeProvider>);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(composer()).toHaveValue("");
    expect(screen.queryByRole("button", {name: "Delete saved drafts"})).not.toBeInTheDocument();
  });
});

describe("shared items enter the selected draft", () => {
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllEnvs();});
  function sharedItem() {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "share-target");
    vi.spyOn(shareInbox, "readShareInbox").mockResolvedValue([{id:"item", createdAt:Date.now(), digest:"digest", state:"pending", content:{title:"",text:"Shared text",url:"",files:[]}}]);
    vi.spyOn(shareInbox, "removeShare").mockResolvedValue();
    return vi.spyOn(shareInbox, "claimShare").mockResolvedValue("claim");
  }
  it("preserves existing text, appends once and never dispatches a prompt", async () => {
    const claim = sharedItem();
    const host = fakeHost();
    await openWork(host);
    fireEvent.change(composer(), {target:{value:"Existing draft"}});
    await userEvent.click(await screen.findByRole("button", {name:"Add to selected conversation draft"}));
    await waitFor(() => expect(composer()).toHaveValue("Existing draft\n\nShared text"));
    expect(claim).toHaveBeenCalledOnce();
    expect(shareInbox.removeShare).toHaveBeenCalledWith("item", "claim");
    expect(host.sent.some(({operation}) => ["prompt", "sendNow"].includes(operation.kind))).toBe(false);
  });
  it("retains an uncertain item when the destination changes during its claim", async () => {
    const claim = sharedItem();
    let finish: (value: string) => void = () => {};
    claim.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const host = fakeHost();
    await openWork(host);
    fireEvent.change(composer(), {target:{value:"Second draft"}});
    await userEvent.click(await screen.findByRole("button", {name:"Add to selected conversation draft"}));
    await waitFor(() => expect(claim).toHaveBeenCalledOnce());
    await switchToRow(0);
    await act(async () => finish("claim"));
    expect(composer()).toHaveValue("");
    expect(shareInbox.removeShare).not.toHaveBeenCalled();
    await switchToRow(1);
    expect(composer()).toHaveValue("Second draft");
  });
  it("rejects the combined draft before claiming an item that cannot fit", async () => {
    const claim = sharedItem();
    const host = fakeHost();
    host.client.commandFits = operation => !("text" in operation) || operation.text.length < 25;
    await openWork(host);
    fireEvent.change(composer(), {target:{value:"Existing draft long"}});
    await userEvent.click(await screen.findByRole("button", {name:"Add to selected conversation draft"}));
    await screen.findByText(/would exceed the command limit/);
    expect(composer()).toHaveValue("Existing draft long");
    expect(claim).not.toHaveBeenCalled();
  });
});

it("preserves a pairing and durable drafts when resume reports an incompatible version", async () => {
  const host = fakeHost();
  Object.defineProperty(host.client, "remote", {value: true});
  vi.spyOn(host.client, "resume").mockResolvedValue({ok: false, failure: {kind: "protocol_mismatch", hostVersion: 99}});
  const clear = vi.spyOn(host.client, "clearPairing");
  const store = new DraftStore("version-retention", localStorage);
  await store.enable();
  await store.write("s-1", "Keep this draft");
  render(<ThemeProvider><App client={host.client} draftScope="version-retention" /></ThemeProvider>);
  await waitFor(() => expect(host.client.resume).toHaveBeenCalled());
  expect(clear).not.toHaveBeenCalled();
  expect((await store.load()).drafts["s-1"]).toBe("Keep this draft");
  await forgetDraftScope("version-retention");
});
