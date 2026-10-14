import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteTransport, createDirectNoiseTransport } from "./remoteConnector";
import { listDirectProfiles, saveDirectProfile, type DirectProfile } from "./directProfiles";
import { loadNoiseModule } from "./remoteCrypto";
import { readGrant, writeGrant, deleteGrant } from "./remoteDevice";
import { LightClient } from "./client";

vi.mock("./remoteCrypto", () => ({loadNoiseModule: vi.fn()}));
vi.mock("./remoteDevice", () => ({readGrant: vi.fn(), writeGrant: vi.fn(), deleteGrant: vi.fn()}));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pair: {sessionId: string; installationId?: string; sessionToken: string; csrfToken: string; protocolVersion: number} = {sessionId: "browser", sessionToken: "synthetic-token", csrfToken: "synthetic-csrf", protocolVersion: 2};
const credentials: unknown[] = [];
const identities: unknown[] = [];
const sockets: RelaySocket[] = [];

class TestNoise {
  constructor(...args: unknown[]) {identities.push(args);}
  start() {return new Uint8Array([1]);}
  authenticate(_frame: Uint8Array, auth: Uint8Array) {credentials.push(JSON.parse(decoder.decode(auth))); return new Uint8Array([2]);}
  encrypt(value: Uint8Array) {return [value];}
  decrypt(value: Uint8Array) {return value;}
  free() {}
}

class RelaySocket {
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: {data: string}) => void;
  channel = `channel-${sockets.length + 1}`;
  requests: {id: string; method: string; body?: unknown}[] = [];
  respond = true;
  raw: unknown[] = [];
  constructor(readonly url: string, readonly protocols?: string) {sockets.push(this); queueMicrotask(() => {this.readyState = 1; this.onopen?.(); if (this.url.endsWith("/remote")) this.frame({type: "ready", channelId: this.channel});});}
  send(data: string) {
    const frame = JSON.parse(data);
    this.raw.push(frame);
    if (frame.type === "authenticate") {this.frame({type: "ready", channelId: this.channel}); return;}
    const bytes = Uint8Array.from(atob(frame.payload), (character) => character.charCodeAt(0));
    if (bytes[0] === 1) {this.frame({type: "data", channelId: this.channel, payload: btoa("\u0003")}); return;}
    if (bytes[0] === 2) {this.host({type: "paired", body: pair}); return;}
    const request = JSON.parse(decoder.decode(bytes));
    this.requests.push(request);
    if (request.method === "subscribe") this.event({kind: "hostStatus", state: "controlling:27"}, 0);
    if (this.respond && request.method !== "heartbeat") this.host({type: "response", id: request.id, status: 200, body: {result: {outcome: "ok"}}});
  }
  frame(frame: unknown) {queueMicrotask(() => this.onmessage?.({data: JSON.stringify(frame)}));}
  host(message: unknown) {const bytes = encoder.encode(JSON.stringify(message)); this.frame({type: "data", channelId: this.channel, payload: btoa(String.fromCharCode(...bytes))});}
  event(event: unknown, eventSequence: number) {this.host({type: "event", event: {protocolVersion: 2, eventSequence, event}});}
  close() {if (this.readyState === 3) return; this.readyState = 3; this.onclose?.();}
}

beforeEach(() => {
  pair.protocolVersion = 2; delete pair.installationId;
  vi.clearAllMocks(); sockets.length = 0; credentials.length = 0; identities.length = 0;
  vi.mocked(loadNoiseModule).mockResolvedValue({default: async () => {}, generate_private_key: () => new Uint8Array(32).fill(7), NoiseClient: TestNoise});
  vi.mocked(readGrant).mockResolvedValue({hostPublicKey: "a".repeat(64), privateKey: new Uint8Array(32).fill(7), pair});
  vi.mocked(writeGrant).mockResolvedValue(); vi.mocked(deleteGrant).mockResolvedValue();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ticket: "synthetic-ticket", relayUrl: "wss://remote-relay.fabrials.com/connect"})));
  vi.stubGlobal("WebSocket", RelaySocket);
});
afterEach(() => {for (const socket of sockets) socket.close(); vi.unstubAllGlobals();});

describe("remote transport lifecycle with synthetic crypto and storage ports", () => {
  it("cancels setup before a delayed device read can start a relay connection", async () => {
    let finish: (value: Awaited<ReturnType<typeof readGrant>>) => void = () => {};
    vi.mocked(readGrant).mockImplementationOnce(() => new Promise((resolve) => {finish = resolve;}));
    const controller = new AbortController();
    const outcome = createRemoteTransport({hostId: "host", signal: controller.signal})
      .then(() => "connected", (error: Error) => error.message);
    await vi.waitFor(() => expect(readGrant).toHaveBeenCalledOnce());
    controller.abort();
    expect(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("pending"), 20))])).toBe("connection_disposed");
    finish({hostPublicKey: "a".repeat(64), privateKey: new Uint8Array(32), pair});
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(writeGrant).not.toHaveBeenCalled();
  });

  it("aborts a pending ticket and ignores its late response", async () => {
    let finish: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {finish = resolve;})));
    const controller = new AbortController();
    const pending = createRemoteTransport({hostId: "host", signal: controller.signal});
    const outcome = expect(pending).rejects.toThrow("connection_disposed");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const ticketSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    controller.abort();
    await outcome;
    expect(ticketSignal?.aborted).toBe(true);
    finish(Response.json({ticket: "late-ticket", relayUrl: "wss://remote-relay.fabrials.com/connect"}));
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    expect(writeGrant).not.toHaveBeenCalled();
  });

  it("keeps the new grant when an aborted pairing finishes storing its result late", async () => {
    let finish: () => void = () => {};
    let saved: Parameters<typeof writeGrant>[1] | undefined;
    vi.mocked(writeGrant).mockImplementationOnce(async (_host, grant, signal) => {
      await new Promise<void>((resolve) => {finish = resolve;});
      signal?.throwIfAborted();
      saved = grant;
    }).mockImplementation(async (_host, grant) => {saved = grant;});
    const controller = new AbortController();
    const pending = createRemoteTransport({hostId: "host", pairing: {secret: "a".repeat(64), hostPublicKey: "a".repeat(64)}, signal: controller.signal});
    const outcome = expect(pending).rejects.toThrow("connection_disposed");
    await vi.waitFor(() => expect(writeGrant).toHaveBeenCalledOnce());
    const oldSocket = sockets[0];
    const oldCallback = oldSocket.onmessage;
    controller.abort();
    await outcome;
    expect(vi.mocked(writeGrant).mock.calls[0][2]?.aborted).toBe(true);
    expect(oldSocket.readyState).toBe(3);
    const current = await createRemoteTransport({hostId: "host", pairing: {secret: "b".repeat(64), hostPublicKey: "a".repeat(64)}});
    const currentGrant = saved;
    finish();
    oldCallback?.({data: '{"type":"closed"}'});
    await Promise.resolve();
    await Promise.resolve();
    expect(saved).toBe(currentGrant);
    expect(writeGrant).toHaveBeenCalledTimes(2);
    expect(sockets[1].readyState).toBe(1);
    current.dispose?.();
  });

  it("removes abort listeners and socket callbacks when disposing a connected transport", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const transport = await createRemoteTransport({hostId: "host", signal: controller.signal});
    transport.dispose?.();
    for (const [name, callback] of add.mock.calls) expect(remove).toHaveBeenCalledWith(name, callback);
    expect(sockets[0].onmessage).toBeNull();
    expect(sockets[0].onopen).toBeNull();
    expect(sockets[0].onclose).toBeNull();
    expect(sockets[0].onerror).toBeNull();
    controller.abort();
    await expect(transport.request("/session")).rejects.toThrow("connection_disposed");
    expect(deleteGrant).not.toHaveBeenCalled();
  });

  it("authenticates in the first frame and preserves lease heartbeats through lifecycle replay", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()};
    const events = transport.openEvents(handlers, 9);
    await vi.waitFor(() => expect(handlers.onOpen).toHaveBeenCalledOnce());
    expect(sockets[0].url).toBe("wss://remote-relay.fabrials.com/connect");
    expect(sockets[0].raw[0]).toEqual({type: "authenticate", ticket: "synthetic-ticket"});
    expect(credentials).toEqual([{sessionToken: pair.sessionToken, csrfToken: pair.csrfToken}]);
    expect(sockets[0].requests[0].body).toEqual({afterSequence: 9, protocolVersion: 4});
    sockets[0].event({kind: "hostStatus", state: "agent_restarting"}, 10);
    sockets[0].event({kind: "hostStatus", state: "agent_ready"}, 11);
    await vi.waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(3));
    events.send('{"kind":"controllerHeartbeat"}');
    expect(sockets[0].requests.at(-1)).toMatchObject({method: "heartbeat", body: {epoch: 27, afterSequence: 11}});
    transport.dispose?.();
  });

  it("does not replay a command lost on disconnect and ignores stale socket callbacks", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    sockets[0].respond = false;
    const command = transport.request("/command", {method: "POST", body: JSON.stringify({operation: {kind: "prompt"}})});
    const result = expect(command).rejects.toThrow("connection_lost_check_command_status");
    await vi.waitFor(() => expect(sockets[0].requests).toHaveLength(1));
    const old = sockets[0]; old.close(); await result;
    const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()};
    transport.openEvents(handlers, 20);
    await vi.waitFor(() => expect(handlers.onOpen).toHaveBeenCalledOnce());
    old.onmessage?.({data: '{"type":"closed","reason":"revoked"}'}); old.onclose?.();
    await Promise.resolve();
    expect(sockets[1].requests.map((request) => request.method)).toEqual(["subscribe"]);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(sockets[1].readyState).toBe(1);
    transport.dispose?.();
  });

  it("delivers an authenticated response queued before the socket close event", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    const socket = sockets[0];
    socket.respond = false;
    const command = transport.request("/command", {method: "POST", body: JSON.stringify({operation: {kind: "forgetBrowserPairing"}})});
    const outcome = command.then(response => response.json(), error => ({error: error.message}));
    await vi.waitFor(() => expect(socket.requests).toHaveLength(1));
    socket.host({type: "response", id: socket.requests[0].id, status: 200, body: {result: {outcome: "acknowledged"}}});
    socket.host({type: "closed", reason: "revoked"});
    queueMicrotask(() => socket.close());
    expect(await outcome).toEqual({result: {outcome: "acknowledged"}});
    transport.dispose?.();
  });

  it.each(["confirmed", "lost", "invalid", "disposed", "close-first"])("settles explicit revocation before reporting the authenticated close (%s)", async mode => {
    const transport = await createRemoteTransport({hostId: "host"});
    const client = new LightClient({transport, storageKey: `revoke-close-${mode}`});
    expect((await client.resume()).ok).toBe(true);
    const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onFailure: vi.fn(() => client.clearPairing())};
    client.openEvents(handlers);
    await vi.waitFor(() => expect(handlers.onOpen).toHaveBeenCalledOnce());
    const socket = sockets[0];
    socket.respond = false;
    const outcome = client.revokePairing();
    await vi.waitFor(() => expect(socket.requests.at(-1)).toMatchObject({body: {operation: {kind: "getRemoteCapabilities"}}}));
    const capabilities = socket.requests.at(-1)!;
    socket.host({type: "response", id: capabilities.id, status: 200, body: {result: {outcome: "remoteCapabilities", projects: false, controlTransfer: false, devicePanel: false, multiWriter: true, multiWriterProtocolVersion: 4}}});
    await vi.waitFor(() => expect(socket.requests.at(-1)).toMatchObject({body: {operation: {kind: "forgetBrowserPairing"}}}));
    const forget = socket.requests.at(-1)!;
    if (mode === "disposed") client.dispose();
    if (mode === "close-first") socket.host({type: "closed", reason: "revoked"});
    if (mode !== "lost") socket.host({type: "response", id: forget.id, status: 200, body: {requestId: mode === "invalid" ? "different-request" : (forget.body as {requestId: string}).requestId, result: {outcome: "acknowledged"}}});
    socket.host({type: "closed", reason: "revoked"});
    queueMicrotask(() => socket.close());
    expect(await outcome).toEqual(mode === "confirmed" ? {ok: true, value: {outcome: "acknowledged"}} : {ok: false, failure: {kind: "unreachable"}});
    if (mode !== "disposed") expect(handlers.onFailure).toHaveBeenCalledExactlyOnceWith({kind: "not_paired"});
    expect(socket.requests.filter(request => (request.body as {operation?: {kind: string}})?.operation?.kind === "forgetBrowserPairing")).toHaveLength(1);
    client.dispose();
  });

  it("acknowledges multiwriter cursors without a controller lease through lifecycle events", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()};
    const events = transport.openEvents(handlers, 0);
    await vi.waitFor(() => expect(handlers.onOpen).toHaveBeenCalledOnce());
    sockets[0].event({kind: "hostStatus", state: "writable"}, 0);
    sockets[0].event({kind: "hostStatus", state: "agent_ready"}, 14);
    await vi.waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(3));
    events.send('{"kind":"controllerHeartbeat"}');
    expect(sockets[0].requests.at(-1)).toMatchObject({method: "heartbeat", body: {afterSequence: 14}});
    transport.dispose?.();
  });

  it.each([false, true])("trusts revocation only inside authenticated host data (%s)", async (authenticated) => {
    const transport = await createRemoteTransport({hostId: "host"});
    const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onFailure: vi.fn()};
    transport.openEvents(handlers, 0);
    await vi.waitFor(() => expect(handlers.onOpen).toHaveBeenCalledOnce());
    const closed = {type: "closed", reason: "revoked"};
    if (authenticated) sockets[0].host(closed); else sockets[0].frame(closed);
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenCalledOnce());
    if (authenticated) expect(handlers.onFailure).toHaveBeenCalledWith({kind: "not_paired"});
    else expect(handlers.onFailure).not.toHaveBeenCalled();
    expect(deleteGrant).not.toHaveBeenCalled();
    transport.dispose?.();
  });

  it("disposes without erasing the pinned device and refuses to reconnect", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    transport.dispose?.();
    await expect(transport.request("/session")).rejects.toThrow("connection_disposed");
    expect(deleteGrant).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it("forgets only one computer after durable storage deletion", async () => {
    const transport = await createRemoteTransport({hostId: "host"});
    await transport.forgetPairing?.();
    expect(deleteGrant).toHaveBeenCalledExactlyOnceWith("host", expect.any(AbortSignal));
    expect(sockets[0].readyState).toBe(3);
  });
});

describe("direct Noise transport", () => {
  const direct = {endpoint: "https://station.example.ts.net", installationId: "installation", hostPublicKey: "a".repeat(64), nonce: "b".repeat(64)};
  const saved = (): DirectProfile => ({endpoint: direct.endpoint, installationId: direct.installationId, hostPublicKey: direct.hostPublicKey, label: "Station", privateKey: new Uint8Array(32).fill(7), pair: {...pair, installationId: direct.installationId}});

  it("pairs, sends and resumes with no account tickets, HTTP or relay fallback", async () => {
    pair.installationId = direct.installationId;
    const first = await createDirectNoiseTransport(direct);
    expect(fetch).not.toHaveBeenCalled();
    expect(sockets[0].url).toBe("wss://station.example.ts.net/remote");
    expect(sockets[0].protocols).toBe("fabrials.remote.v1");
    expect(identities[0]).toEqual([new Uint8Array(32).fill(7), new Uint8Array(32).fill(170), direct.installationId, "channel-1"]);
    expect(credentials).toEqual([{nonce: direct.nonce}]);
    expect(sockets[0].raw.every((frame: any) => frame.type === "data")).toBe(true);
    const profiles = await listDirectProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].pair.installationId).toBe(direct.installationId);
    first.dispose?.();
    const resumed = await createDirectNoiseTransport({...direct, nonce: undefined});
    expect(credentials[1]).toEqual({sessionToken: pair.sessionToken, csrfToken: pair.csrfToken});
    expect(fetch).not.toHaveBeenCalled();
    await resumed.request("/command", {method: "POST", body: JSON.stringify({protocolVersion: 2, requestId: "one", operation: {kind: "bootstrap"}})});
    expect(sockets[1].requests.at(-1)?.method).toBe("command");
    resumed.dispose?.();
  });

  it.each(["version", "malformed", "identity"])("preserves saved pairing on %s errors", async reason => {
    pair.installationId = direct.installationId;
    const original = saved();
    await saveDirectProfile(original);
    if (reason === "version") pair.protocolVersion = 999;
    if (reason === "identity") pair.installationId = "other";
    if (reason === "malformed") pair.csrfToken = "";
    try {
      await expect(createDirectNoiseTransport({...direct, nonce: undefined})).rejects.toThrow(reason === "version" ? "protocol_mismatch" : reason === "identity" ? "host_identity_changed" : "protocol_error");
      expect(await listDirectProfiles()).toEqual([original]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {pair.csrfToken = "synthetic-csrf";}
  });

  it("rejects a changed pinned host key before opening a network connection", async () => {
    await saveDirectProfile(saved());
    await expect(createDirectNoiseTransport({...direct, nonce: undefined, hostPublicKey: "f".repeat(64)})).rejects.toThrow("host_key_changed");
    expect(fetch).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it("forgets only the chosen direct host without touching relay grants", async () => {
    pair.installationId = direct.installationId;
    const transport = await createDirectNoiseTransport(direct);
    const second = {...saved(), endpoint: "https://other.example"};
    await saveDirectProfile(second);
    await transport.forgetPairing?.();
    expect(await listDirectProfiles()).toEqual([second]);
    expect(deleteGrant).not.toHaveBeenCalled();
  });
});
