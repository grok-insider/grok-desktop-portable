import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LightClient, type EventHandlers, type HostTransport } from "./client";
import { PROTOCOL_VERSION } from "./protocol";

function harness() {
  let handlers: EventHandlers;
  const cursors: number[] = [];
  const connection = {send: vi.fn(), close: vi.fn()};
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const body = path === "/session" ? {sessionId: "browser", sessionToken: "secret", csrfToken: "csrf", protocolVersion: PROTOCOL_VERSION} : {result: {outcome: "ok"}};
    return new Response(JSON.stringify(body));
  });
  const transport: HostTransport = {request, openEvents: (next, cursor) => {handlers = next; cursors.push(cursor); return connection;}};
  return {transport, request, connection, cursors, emit: (kind: string, eventSequence: number, payload: Record<string, unknown> = {}) => handlers.onEvent({protocolVersion: PROTOCOL_VERSION, eventSequence, event: {kind, ...payload} as never}), open: () => handlers.onOpen(), close: () => handlers.onClose()};
}

beforeEach(() => {localStorage.clear(); sessionStorage.clear();});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe("remote host transport", () => {
  it("never falls back to HTTP when the secure channel fails and never writes its session grant to localStorage", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const host = harness();
    const client = new LightClient({transport: host.transport, storageKey: "remote:test"});
    expect((await client.resume()).ok).toBe(true);
    expect(localStorage.getItem("remote:test")).toBeNull();
    host.request.mockRejectedValueOnce(new Error("offline"));
    expect(await client.send({kind: "listWorkspaces"})).toEqual({ok: false, failure: {kind: "unreachable"}});
    expect(client.paired).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it("uses the acquired lease epoch, keeps it alive, resumes the cursor and resets expired projections", async () => {
    vi.useFakeTimers();
    const host = harness();
    const client = new LightClient({transport: host.transport});
    await client.resume();
    const seen = vi.fn();
    const listener = {onEvent: seen, onOpen: vi.fn(), onClose: vi.fn()};
    const first = client.openEvents(listener);
    host.open();
    host.emit("hostStatus", 0, {state: "controlling:27"});
    host.emit("messageDelta", 50, {sessionId: "session", text: "One"});
    host.emit("messageDelta", 50, {sessionId: "session", text: "One"});
    await client.send({kind: "cancelTurn", sessionId: "session"}, {idempotencyKey: "cancel"});
    const command = JSON.parse(String(host.request.mock.calls.at(-1)?.[1]?.body));
    expect(command.controllerEpoch).toBe(27);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.connection.send).toHaveBeenCalledWith('{"kind":"controllerHeartbeat"}');
    first?.close();
    host.close();
    const second = client.openEvents(listener);
    expect(host.cursors).toEqual([0, 50]);
    host.open();
    host.emit("hostStatus", 0, {state: "controlling:28"});
    expect(client.controllerEpoch).toBe(28);
    host.emit("replayReset", 0);
    host.emit("sessionSnapshot", 1, {sessionId: "session", messages: []});
    expect(seen.mock.calls.map(([value]) => value.event.kind)).toEqual(["hostStatus", "messageDelta", "hostStatus", "replayReset", "sessionSnapshot"]);
    second?.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queries a pending prompt after reconnect without submitting it twice", async () => {
    const host = harness();
    const client = new LightClient({transport: host.transport});
    await client.resume();
    host.request.mockImplementationOnce(async () => new Response(JSON.stringify({result: {outcome: "commandAccepted", idempotencyKey: "turn-1", state: "running"}})));
    await client.send({kind: "prompt", sessionId: "s", text: "Run once"}, {idempotencyKey: "turn-1"});
    host.request.mockImplementationOnce(async () => new Response(JSON.stringify({result: {outcome: "commandStatus", state: "completed", result: {outcome: "promptDone"}}})));
    const onEvent = vi.fn();
    const events = client.openEvents({onEvent, onOpen: vi.fn(), onClose: vi.fn()});
    host.open();
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
    const operations = host.request.mock.calls.filter(([path]) => path === "/command").map(([, init]) => JSON.parse(String(init?.body)).operation.kind);
    expect(operations).toEqual(["prompt", "getCommandStatus"]);
    events?.close();
  });

  it("keeps commands authorized and heartbeats active through agent restart and replay", async () => {
    vi.useFakeTimers();
    const host = harness();
    const client = new LightClient({transport: host.transport});
    await client.resume();
    const connection = client.openEvents({onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()});
    host.open();
    host.emit("hostStatus", 0, {state: "controlling:27"});
    host.emit("hostStatus", 41, {state: "agent_ready"});
    host.emit("hostStatus", 42, {state: "agent_restarting"});
    host.emit("replayReset", 0);
    host.emit("hostStatus", 43, {state: "agent_ready"});
    await client.send({kind: "cancelTurn", sessionId: "s"}, {idempotencyKey: "cancel-restarted"});
    expect(JSON.parse(String(host.request.mock.calls.at(-1)?.[1]?.body)).controllerEpoch).toBe(27);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.connection.send).toHaveBeenCalledTimes(2);
    host.emit("hostStatus", 0, {state: "watching"});
    expect(client.controllerEpoch).toBeUndefined();
    connection?.close();
  });

  it.each([
    {error: "controller_required"},
    {protocolVersion: PROTOCOL_VERSION, error: "controller_required"},
  ])("treats lease contention as a refusal and keeps the pairing: %j", async (body) => {
    const host = harness();
    const client = new LightClient({transport: host.transport});
    await client.resume();
    host.request.mockImplementationOnce(async () => Response.json(body, {status: 409}));
    expect(await client.send({kind: "cancelTurn", sessionId: "s"}, {idempotencyKey: "cancel-contention"})).toEqual({ok: false, failure: {kind: "refused", code: "controller_required"}});
    expect(client.paired).toBe(true);
  });

  it("still rejects a command response from a different protocol version", async () => {
    const host = harness();
    const client = new LightClient({transport: host.transport});
    await client.resume();
    host.request.mockImplementationOnce(async () => Response.json({protocolVersion: 3, error: {code: "unsupported_protocol_version"}}, {status: 409}));
    expect(await client.send({kind: "bootstrap"})).toEqual({ok: false, failure: {kind: "protocol_mismatch", hostVersion: 3}});
  });
});

it("forgets only the selected computer and drops its in-memory authorization", async () => {
  const host = harness();
  const forget = vi.fn(async () => {});
  host.transport.forgetPairing = forget;
  localStorage.setItem("grok-private-session.v1", "unrelated-private-origin-grant");
  const client = new LightClient({transport: host.transport, storageKey: "remote:host-1"});
  await client.resume();
  expect(client.paired).toBe(true);
  await client.forgetPairing();
  expect(forget).toHaveBeenCalledOnce();
  expect(client.paired).toBe(false);
  expect(localStorage.getItem("grok-private-session.v1")).toBe("unrelated-private-origin-grant");
});

it("surfaces an unknown receipt after reconnect without silently resending", async () => {
  const host = harness();
  const client = new LightClient({transport: host.transport});
  await client.resume();
  host.request.mockRejectedValueOnce(new Error("connection_lost"));
  await client.send({kind: "prompt", sessionId: "s", text: "Maybe delivered"}, {idempotencyKey: "uncertain"});
  host.request.mockImplementationOnce(async () => Response.json({error: "unknown_command"}, {status: 422}));
  const onEvent = vi.fn();
  const connection = client.openEvents({onEvent, onOpen: vi.fn(), onClose: vi.fn()});
  host.open();
  await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({event: {kind: "commandCompleted", idempotencyKey: "uncertain", error: "command_outcome_unknown"}})));
  const operations = host.request.mock.calls.filter(([path]) => path === "/command").map(([, init]) => JSON.parse(String(init?.body)).operation.kind);
  expect(operations).toEqual(["prompt", "getCommandStatus"]);
  connection?.close();
});

it("revokes only this browser's pairing, never the host's other devices", async () => {
  const host = harness();
  const client = new LightClient({transport: host.transport});
  await client.resume();
  await client.revokePairing();
  const envelope = JSON.parse(String(host.request.mock.calls.at(-1)?.[1]?.body));
  expect(envelope.operation).toEqual({kind: "forgetBrowserPairing"});
  expect(envelope.idempotencyKey).toEqual(expect.any(String));
});


describe("command payload bounds", () => {
  it.each(["prompt", "sendNow"] as const)("rejects oversized %s before transport and pending receipt storage", async (kind) => {
    const host = harness();
    const client = new LightClient({transport: host.transport, storageKey: "bounds"});
    await client.resume();
    host.request.mockClear();
    const result = await client.send({kind, sessionId: "s", text: "🙂\"\n".repeat(40_000)}, {idempotencyKey: "oversized"});
    expect(result).toEqual({ok: false, failure: {kind: "refused", code: "request_too_large"}});
    expect(host.request).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("bounds:pending")).toBeNull();
  });
});
