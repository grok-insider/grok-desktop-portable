import type { EventHandlers, HostTransport, PairResult } from "./client";
import type { CommandEnvelope, EventEnvelope } from "./protocol";
import { commandFits } from "./commandSize";
import { controllerEpochAfterStatus } from "./controller";
import { loadNoiseModule } from "./remoteCrypto";
import { readGrant, writeGrant, deleteGrant } from "./remoteDevice";
import { directEndpoint, directProfileId, readDirectProfile, saveDirectProfile, deleteDirectProfile, type DirectProfile } from "./directProfiles";

export interface RemoteTransportOptions {
  hostId: string;
  pairing?: { secret: string; hostPublicKey: string };
  signal?: AbortSignal;
}

export interface DirectNoiseOptions {
  endpoint: string;
  installationId: string;
  hostPublicKey: string;
  label?: string;
  nonce?: string;
  signal?: AbortSignal;
}

const API = "https://fabrials.com/api/spanreed/remote";
const RELAY = "wss://remote-relay.fabrials.com/connect";
const MAX_WIRE = 90 * 1024;
const MAX_PLAINTEXT = 2 * 1024 * 1024 + 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeAuthenticatedMessage(plaintext: Uint8Array): {type: string; id?: string; status?: number; body?: PairResult; event?: EventEnvelope} {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("protocol_error");
  const message = JSON.parse(decoder.decode(plaintext));
  if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("protocol_error");
  if (message.type === "closed") throw new Error(message.reason === "revoked" ? "revoked" : "host_offline");
  return message;
}

export function decodeFrame(value: string): Uint8Array {
  if (value.length > 87_380 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("protocol_error");
  const binary = atob(value);
  if (binary.length > 65_535) throw new Error("protocol_error");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeFrame(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hostKey(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("pairing_required");
  return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(new Error("connection_disposed"));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, {once: true});
    operation.then((value) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", cancel);
      reject(error);
    });
  });
}

export function createRemoteTransport(options: RemoteTransportOptions): Promise<HostTransport> {
  return createNoiseTransport(options);
}

export function createDirectNoiseTransport(options: DirectNoiseOptions): Promise<HostTransport> {
  return createNoiseTransport({hostId: options.installationId, signal: options.signal, ...(options.nonce ? {pairing: {secret: options.nonce, hostPublicKey: options.hostPublicKey}} : {})}, options);
}

async function createNoiseTransport(options: RemoteTransportOptions, direct?: DirectNoiseOptions): Promise<HostTransport> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.hostId)) throw new Error("pairing_required");
  if (options.signal?.aborted) throw new Error("connection_disposed");
  const wasm = await abortable(loadNoiseModule(), options.signal);
  if (options.signal?.aborted) throw new Error("connection_disposed");
  const endpoint = direct ? directEndpoint(direct.endpoint) : undefined;
  let directProfile = direct ? await abortable(readDirectProfile(directProfileId(direct)), options.signal) : undefined;
  if (directProfile && directProfile.hostPublicKey !== direct?.hostPublicKey && !options.pairing) throw new Error("host_key_changed");
  let grant = direct ? directProfile : await abortable(readGrant(options.hostId), options.signal);
  if (options.signal?.aborted) throw new Error("connection_disposed");
  let nonce = options.pairing?.secret;
  if (options.pairing) {
    hostKey(options.pairing.hostPublicKey);
    if (!/^[a-f0-9]{64}$/.test(nonce ?? "")) throw new Error("pairing_required");
    grant = { hostPublicKey: options.pairing.hostPublicKey, privateKey: wasm.generate_private_key() };
  }
  if (!grant || !(grant.privateKey instanceof Uint8Array) || grant.privateKey.length !== 32 || (!nonce && !grant.pair?.sessionToken)) throw new Error("pairing_required");
  const device: {hostPublicKey: string; privateKey: Uint8Array; pair?: PairResult} = grant;
  const pinnedKey = hostKey(device.hostPublicKey);
  let socket: WebSocket | undefined;
  let crypto: InstanceType<Awaited<ReturnType<typeof loadNoiseModule>>["NoiseClient"]> | undefined;
  let channelId = "";
  let connected = false;
  let connecting: Promise<void> | undefined;
  let events: EventHandlers | undefined;
  let sequence = 0;
  let epoch: number | undefined;
  let connectionVersion = 0;
  let disposed = false;
  const lifetime = new AbortController();
  let cancelHandshake: (() => void) | undefined;
  const pending = new Map<string, { resolve(value: Response): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  const sendFrame = (frame: Uint8Array) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 4 * 1024 * 1024) throw new Error("host_offline");
    socket.send(JSON.stringify({ type: "data", channelId, payload: encodeFrame(frame) }));
  };
  const send = (value: unknown) => {
    if (!connected || !crypto) throw new Error("host_offline");
    const bytes = encoder.encode(JSON.stringify(value));
    if (bytes.length > 256 * 1024) throw new Error("request_too_large");
    for (const frame of crypto.encrypt(bytes)) sendFrame(frame);
  };

  const reportFailure = (handlers: EventHandlers, error: unknown) => {
    if (error instanceof Error && (error.message === "revoked" || error.message === "account_required")) handlers.onFailure?.({kind: "not_paired"});
    else if (error instanceof Error && error.message === "protocol_mismatch") handlers.onFailure?.({kind: "protocol_mismatch", hostVersion: typeof error.cause === "number" ? error.cause : 0});
  };

  const fail = (error?: unknown) => {
    connected = false;
    epoch = undefined;
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error("connection_lost_check_command_status")); }
    pending.clear();
    crypto?.free();
    crypto = undefined;
    const current = events;
    events = undefined;
    if (current) reportFailure(current, error);
    current?.onClose();
  };

  const connect = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("connection_disposed"));
    if (connected) return Promise.resolve();
    if (connecting) return connecting;
    const version = ++connectionVersion;
    connecting = abortable((async () => {
      let ticket: {ticket: string; relayUrl: string} | undefined;
      if (!direct) {
        const ticketResponse = await fetch(`${API}/tickets`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ hostId: options.hostId, role: "browser" }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]),
          redirect: "error", cache: "no-store",
        });
        if (ticketResponse.status === 401) throw new Error("account_required");
        if (ticketResponse.status === 403 || ticketResponse.status === 404) throw new Error("revoked");
        if (!ticketResponse.ok) throw new Error("host_offline");
        ticket = await ticketResponse.json() as { ticket: string; relayUrl: string };
        if (ticket.relayUrl !== RELAY || typeof ticket.ticket !== "string" || ticket.ticket.length > 4096) throw new Error("protocol_error");
      } else if (directProfile && !nonce) {
        const current = await readDirectProfile(directProfileId(directProfile));
        if (!current || current.pair.sessionId !== directProfile.pair.sessionId) throw new Error("pairing_changed");
      }
      if (version !== connectionVersion) throw new Error("host_offline");
      await new Promise<void>((resolve, reject) => {
        const ws = direct ? new WebSocket(`${endpoint!.replace(/^https:/, "wss:")}/remote`, "fabrials.remote.v1") : new WebSocket(RELAY);
        socket = ws;
        let phase: "ready" | "handshake" | "paired" | "active" = "ready";
        let chain = Promise.resolve();
        let closingFailure: unknown;
        const timeout = setTimeout(() => { ws.close(); reject(new Error("host_offline")); }, 15_000);
        const cancel = () => {clearTimeout(timeout); reject(new Error("connection_disposed"));};
        cancelHandshake = cancel;
        const finishHandshake = () => {
          clearTimeout(timeout);
          if (cancelHandshake === cancel) cancelHandshake = undefined;
        };
        ws.onopen = () => {
          if (ticket && socket === ws && version === connectionVersion && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "authenticate", ticket: ticket.ticket }));
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          finishHandshake();
          if (socket === ws && version === connectionVersion) {socket = undefined; fail(closingFailure);}
          reject(new Error("host_offline"));
        };
        ws.onmessage = (event: MessageEvent) => {
          chain = chain.then(async () => {
            if (socket !== ws || version !== connectionVersion || ws.readyState !== WebSocket.OPEN) return;
            if (typeof event.data !== "string" || event.data.length > MAX_WIRE) throw new Error("protocol_error");
            const frame = JSON.parse(event.data) as { type: string; channelId?: string; payload?: string; reason?: string };
            if (frame.type === "closed") throw new Error("host_offline");
            if (phase === "ready") {
              if (frame.type !== "ready" || !frame.channelId || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.channelId)) throw new Error("protocol_error");
              channelId = frame.channelId;
              crypto = new wasm.NoiseClient(device.privateKey, pinnedKey, options.hostId, channelId);
              phase = "handshake";
              sendFrame(crypto.start());
              return;
            }
            if (frame.type !== "data" || frame.channelId !== channelId || typeof frame.payload !== "string" || !crypto) throw new Error("protocol_error");
            const ciphertext = decodeFrame(frame.payload);
            if (phase === "handshake") {
              const credentials = nonce ? { nonce } : { sessionToken: device.pair?.sessionToken, csrfToken: device.pair?.csrfToken };
              phase = "paired";
              sendFrame(crypto.authenticate(ciphertext, encoder.encode(JSON.stringify(credentials))));
              return;
            }
            const plaintext = crypto.decrypt(ciphertext);
            if (!plaintext) return;
            const message = decodeAuthenticatedMessage(plaintext);
            if (phase === "paired") {
              if (message.type !== "paired" || !message.body || !message.body.sessionToken || !message.body.csrfToken) throw new Error("protocol_error");
              if (message.body.protocolVersion !== 2) throw new Error("protocol_mismatch", {cause: message.body.protocolVersion});
              if (direct && message.body.installationId !== direct.installationId) throw new Error("host_identity_changed");
              if (directProfile && !nonce && message.body.sessionId !== directProfile.pair.sessionId) throw new Error("pairing_changed");
              device.pair = message.body;
              if (direct) {
                const next: DirectProfile = {endpoint: endpoint!, installationId: direct.installationId, hostPublicKey: direct.hostPublicKey, label: direct.label ?? directProfile?.label ?? new URL(endpoint!).hostname, privateKey: device.privateKey, pair: message.body};
                await saveDirectProfile(next, nonce ? undefined : directProfile?.pair.sessionId, lifetime.signal);
                directProfile = next;
              } else await writeGrant(options.hostId, device, lifetime.signal);
              if (socket !== ws || version !== connectionVersion || ws.readyState !== WebSocket.OPEN) throw new Error("host_offline");
              nonce = undefined;
              phase = "active";
              connected = true;
              finishHandshake();
              resolve();
            } else if (message.type === "event" && message.event) {
              const envelope = message.event;
              if (envelope.event.kind === "hostStatus") {
                epoch = controllerEpochAfterStatus(epoch, envelope.event.state);
              }
              sequence = envelope.event.kind === "replayReset" ? envelope.eventSequence : Math.max(sequence, envelope.eventSequence);
              events?.onEvent(envelope);
            } else if (message.type === "response" && message.id) {
              const request = pending.get(message.id);
              if (!request) return;
              pending.delete(message.id);
              clearTimeout(request.timer);
              request.resolve(Response.json(message.body, { status: message.status ?? 500 }));
            } else { throw new Error("protocol_error"); }
          }).catch((error: unknown) => { closingFailure = error; reject(error); ws.close(); });
        };
      });
    })(), lifetime.signal).finally(() => { connecting = undefined; });
    return connecting;
  };

  const request = async (method: string, body?: unknown): Promise<Response> => {
    await connect();
    if (pending.size >= 32) throw new Error("too_many_requests");
    const id = globalThis.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("command_status_required")); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, body }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };

  const closeTransport = () => {
    events = undefined;
    connectionVersion += 1;
    cancelHandshake?.();
    cancelHandshake = undefined;
    const previous = socket;
    socket = undefined;
    fail();
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onclose = null;
      previous.close();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    lifetime.abort(new Error("connection_disposed"));
    closeTransport();
  };
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener("abort", dispose, {once: true});
  try {await connect();} catch (error) {dispose(); throw error;}
  return {
    dispose,
    async forgetPairing() {
      if (directProfile) await deleteDirectProfile(directProfile);
      else await deleteGrant(options.hostId, lifetime.signal);
      dispose();
      device.privateKey.fill(0);
      device.pair = undefined;
    },
    async request(path, init) {
      try {
        if (path === "/session") { await connect(); return Response.json(device.pair); }
        if (path !== "/command" || init?.method !== "POST" || typeof init.body !== "string") return Response.json({ error: "unsupported_operation" }, { status: 400 });
        const command = JSON.parse(init.body) as CommandEnvelope;
        if (!commandFits(command, true)) return Response.json({ error: "request_too_large" }, { status: 413 });
        return await request("command", command);
      } catch (error) {
        if (error instanceof Error && (error.message === "revoked" || error.message === "account_required")) return Response.json({error: error.message}, {status: 403});
        throw error;
      }
    },
    openEvents(handlers, afterSequence) {
      let closed = false;
      events = handlers;
      sequence = afterSequence;
      void request("subscribe", { afterSequence }).then((response) => {
        if (!response.ok) throw new Error("subscription_rejected");
        if (!closed) handlers.onOpen();
      }).catch((error: unknown) => {
        if (!closed && events === handlers) { events = undefined; reportFailure(handlers, error); handlers.onClose(); }
      });
      return {
        close() {
          closed = true;
          if (events !== handlers) return;
          closeTransport();
        },
        send(data) {
          try {
            const value = JSON.parse(data) as { kind?: string };
            if (value.kind === "controllerHeartbeat" && epoch !== undefined) send({ id: globalThis.crypto.randomUUID(), method: "heartbeat", body: { epoch, afterSequence: sequence } });
          } catch { socket?.close(); }
        },
      };
    },
  };
}
