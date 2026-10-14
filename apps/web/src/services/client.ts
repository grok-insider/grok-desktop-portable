import { isKnownHostedOrigin } from "./deploymentOrigin";
/**
 * Transport to the local bridge.
 *
 * Production: document is `https://desktop.grok.me`, API is loopback
 * (ADR 0016). Session auth: HTTP uses `x-gl-session`; WebSocket uses a second
 * subprotocol `gls.<token>` (cookies are SameSite-blocked cross-site and WS
 * cannot set custom headers). Fallback: same-origin bridge SPA may use cookies.
 */

import {
  CSRF_HEADER,
  PROTOCOL_VERSION,
  MULTI_WRITER_PROTOCOL_VERSION,
  SESSION_HEADER,
  WS_SESSION_PROTOCOL_PREFIX,
  WS_SUBPROTOCOL,
  defaultBridgeBaseUrl,
  type CommandEnvelope,
  type EventEnvelope,
  type Operation,
} from "./protocol";
import { controllerEpochAfterStatus } from "./controller";
import { commandFits, COMMAND_ID_PLACEHOLDER } from "./commandSize";
import { forgetDraftScope, privateDraftScope } from "./drafts";
import { asRemoteCapabilities } from "./remoteControls";

/** Result of a successful pairing exchange. */
export interface PairResult {
  sessionId: string;
  installationId?: string;
  sessionToken?: string;
  csrfToken: string;
  protocolVersion: number;
}

/** Why a call failed, in terms the interface can explain to a person. */
export type ClientFailure =
  | { kind: "not_paired" }
  | { kind: "rejected" }
  | { kind: "refused"; code: string }
  | { kind: "protocol_mismatch"; hostVersion: number }
  | { kind: "unreachable" }
  | { kind: "bad_request" };

/** A call either produced a value or failed for a reason worth showing. */
export type ClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ClientFailure };

function unreachable<T>(): ClientResult<T> {
  return { ok: false, failure: { kind: "unreachable" } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function responseRecord(response: Response): Promise<Record<string, unknown> | null> {
  try {return record(await response.json());} catch {return null;}
}

export function commandReceipt(value: unknown, key: string): {state: "queued" | "running" | "completed" | "failed" | "removed" | "needsReview" | "reviewed"; result?: unknown; error?: string} | null {
  const body = record(value);
  if (!body || typeof body.outcome !== "string" || !["commandStatus", "commandAccepted"].includes(body.outcome)
    || (body.idempotencyKey !== undefined && body.idempotencyKey !== key)
    || typeof body.state !== "string" || !["queued", "running", "completed", "failed", "removed", "needsReview", "reviewed"].includes(body.state)
    || (body.error !== undefined && body.error !== null && typeof body.error !== "string")) return null;
  return {state: body.state as "queued" | "running" | "completed" | "failed" | "removed" | "needsReview" | "reviewed", result: body.result, ...(typeof body.error === "string" ? {error: body.error} : {})};
}

function contentProtocolVersion(operation: Operation): number {
  return ["startImageUpload", "appendImageUpload", "finishImageUpload", "discardImage", "promptContent", "readImageChunk"].includes(operation.kind) ? 3 : PROTOCOL_VERSION;
}

const resumeQueues = new Map<string, Promise<unknown>>();

async function withResumeLock<T>(name: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(10_000);
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, {mode: "exclusive", signal}, () => run(signal));
  }
  const previous = resumeQueues.get(name) ?? Promise.resolve();
  const attempt = previous.catch(() => {}).then(() => {
    signal.throwIfAborted();
    return run(signal);
  });
  resumeQueues.set(name, attempt);
  try {return await attempt;} finally {if (resumeQueues.get(name) === attempt) resumeQueues.delete(name);}
}

export interface LightClientOptions {
  /** Loopback API base, e.g. `http://127.0.0.1:20001`. Empty = same-origin. */
  bridgeBaseUrl?: string;
  transport?: HostTransport;
  storageKey?: string;
}

export interface EventConnection {
  close(): void;
  send(data: string): void;
}

export interface EventHandlers {
  onEvent: (envelope: EventEnvelope) => void;
  onOpen: () => void;
  onClose: () => void;
  onFailure?: (failure: ClientFailure) => void;
}

export interface HostTransport {
  request(path: string, init?: RequestInit): Promise<Response>;
  openEvents(handlers: EventHandlers, afterSequence: number): EventConnection;
  forgetPairing?(): Promise<void>;
  dispose?(): void;
}

/** Talks to the local bridge API. */
export class LightClient {
  #csrfToken: string | null = null;
  #sessionToken: string | null = null;
  #browserSessionId: string | null = null;
  #installationId: string | undefined;
  #bridgeBaseUrl: string;
  #transport?: HostTransport;
  #storageKey: string;
  #controllerEpoch: number | undefined;
  #controllerToken: string | undefined;
  #eventsGeneration = 0;
  #eventSequence = 0;
  #multiWriter = false;
  #pendingCommands = new Set<string>();
  #pairAttempt: {nonce: string; generation: number; promise: Promise<ClientResult<PairResult>>} | null = null;
  #resumeAttempt: {generation: number; promise: Promise<ClientResult<PairResult>>} | null = null;
  #authorityGeneration = 0;
  #draftCleanup: Promise<void> = Promise.resolve();
  #revocationFailure: {generation: number; notify?: () => void} | null = null;

  constructor(options: LightClientOptions = {}) {
    this.#transport = options.transport;
    this.#storageKey = options.storageKey ?? (isPrivateDocumentOrigin() ? PRIVATE_SESSION_KEY : BRIDGE_SESSION_KEY);
    try {
      const keys = JSON.parse(sessionStorage.getItem(`${this.#storageKey}:pending`) ?? "[]") as unknown;
      if (Array.isArray(keys)) this.#pendingCommands = new Set(keys.filter((key): key is string => typeof key === "string" && key.length <= 128).slice(0, 100));
    } catch {}
    this.#bridgeBaseUrl =
      options.bridgeBaseUrl !== undefined
        ? options.bridgeBaseUrl
        : resolveBridgeBaseUrl();
  }

  get remote(): boolean {
    return this.#transport !== undefined;
  }

  get draftScope(): string | undefined {
    return !this.remote && isPrivateDocumentOrigin() ? privateDraftScope(location.origin, this.#installationId, this.#browserSessionId ?? undefined) : undefined;
  }

  get receiptScope(): string | undefined {
    return this.#browserSessionId ? JSON.stringify([this.#storageKey, this.#bridgeBaseUrl, this.#installationId ?? null, this.#browserSessionId]) : undefined;
  }

  get controllerEpoch(): number | undefined {
    return this.#controllerEpoch;
  }

  get multiWriter(): boolean {
    return this.#multiWriter;
  }

  #commandVersion(operation: Operation): number {
    return this.#multiWriter ? MULTI_WRITER_PROTOCOL_VERSION : contentProtocolVersion(operation);
  }

  acknowledgeCommandReceipt(key: string): void {
    if (this.#pendingCommands.delete(key)) this.#storePending();
  }

  async forgetPairing(): Promise<void> {
    await this.#transport?.forgetPairing?.();
    this.clearPairing();
    await this.#draftCleanup;
    this.#pendingCommands.clear();
    this.#storePending();
  }

  async revokePairing(): Promise<ClientResult<unknown>> {
    if (this.#transport) {
      if (!this.#browserSessionId) {
        const restored = await this.resume();
        if (!restored.ok) return restored;
      }
      const capabilities = await this.send({kind: "getRemoteCapabilities"});
      if (!capabilities.ok) return capabilities;
      if (!asRemoteCapabilities(capabilities.value)) return unreachable();
    }
    if (!this.#browserSessionId) return {ok: false, failure: {kind: "not_paired"}};
    if (this.#revocationFailure) return unreachable();
    const revocation: {generation: number; notify?: () => void} = {generation: this.#authorityGeneration};
    this.#revocationFailure = revocation;
    try {return await this.send({kind: "forgetBrowserPairing"}, {idempotencyKey: crypto.randomUUID()});}
    finally {
      if (this.#revocationFailure === revocation) this.#revocationFailure = null;
      if (revocation.generation === this.#authorityGeneration) revocation.notify?.();
    }
  }

  dispose(): void {
    this.#multiWriter = false;
    this.#authorityGeneration++;
    this.#eventsGeneration++;
    this.#transport?.dispose?.();
    this.#csrfToken = null;
    this.#sessionToken = null;
    this.#controllerEpoch = undefined;
    this.#controllerToken = undefined;
  }

  #storePending(): void {
    try {sessionStorage.setItem(`${this.#storageKey}:pending`, JSON.stringify([...this.#pendingCommands]));} catch {}
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    return this.#transport ? this.#transport.request(path, init) : fetch(this.#url(path), init);
  }

  /** Update API base after learning the port from a pair URL. */
  setBridgeBaseUrl(base: string): void {
    if (this.#bridgeBaseUrl !== base) this.#resetAuthority();
    this.#bridgeBaseUrl = base;
    const port = portFromBridgeBase(base);
    if (port !== null) {
      writeStoredPort(port);
    }
  }

  /** Whether this page has completed a pairing exchange. */
  get paired(): boolean {
    return this.#csrfToken !== null && this.#sessionToken !== null;
  }

  /**
   * Drop in-memory pairing. By default also clears the document-origin session
   * grant but keeps the remembered port (bridge may still be up).
   */
  clearPairing(options: { clearPort?: boolean } = {}): void {
    const scope = this.receiptScope;
    try {
      if (scope) sessionStorage.removeItem(`grok-command-receipts.v1:${scope}`);
      sessionStorage.removeItem(`${this.#storageKey}:pending`);
    } catch {}
    this.#pendingCommands.clear();
    this.#multiWriter = false;
    this.#draftCleanup = forgetDraftScope(this.draftScope ?? this.#storedPrivateDraftScope());
    void this.#draftCleanup.catch(() => {});
    this.#authorityGeneration++;
    this.#eventsGeneration++;
    this.#csrfToken = null;
    this.#sessionToken = null;
    this.#browserSessionId = null;
    this.#installationId = undefined;
    this.#controllerEpoch = undefined;
    this.#controllerToken = undefined;
    this.#eventSequence = 0;
    try { localStorage.removeItem(this.#storageKey); } catch {}
    if (options.clearPort) {
      clearStoredPort();
    }
  }

  /** Restore tokens from the document-origin resume store (if still valid). */
  restoreFromStorage(nowMs: number = Date.now()): boolean {
    if (this.#transport) return false;
    if (this.#pairAttempt?.generation === this.#authorityGeneration) return false;
    if (this.#storageKey !== BRIDGE_SESSION_KEY) {
      try {
        const stored = JSON.parse(localStorage.getItem(this.#storageKey) ?? "null") as StoredBridgeSession | null;
        if (!stored || typeof stored.sessionToken !== "string" || !stored.sessionToken || typeof stored.csrfToken !== "string" || !stored.csrfToken || !Number.isFinite(stored.savedAtMs) || nowMs - stored.savedAtMs > SESSION_GRANT_TTL_MS) return false;
        if (this.#sessionToken !== stored.sessionToken) this.#resetAuthority();
        this.#sessionToken = stored.sessionToken;
        this.#csrfToken = stored.csrfToken;
        return true;
      } catch { return false; }
    }
    const stored = readStoredSession(nowMs);
    if (stored === null) {
      return false;
    }
    const base = `http://127.0.0.1:${stored.port}`;
    if (this.#sessionToken !== stored.sessionToken || portFromBridgeBase(this.#bridgeBaseUrl) !== stored.port) this.#resetAuthority();
    this.#sessionToken = stored.sessionToken;
    this.#csrfToken = stored.csrfToken;
    this.#bridgeBaseUrl = base;
    return true;
  }

  #resetAuthority(): void {
    this.#multiWriter = false;
    this.#authorityGeneration++;
    this.#eventsGeneration++;
    this.#browserSessionId = null;
    this.#installationId = undefined;
    this.#controllerEpoch = undefined;
    this.#controllerToken = undefined;
    this.#eventSequence = 0;
    if (this.#sessionToken !== null) {
      this.#pendingCommands.clear();
      this.#storePending();
    }
  }

  #storedGrant(): string | null {
    try {return localStorage.getItem(this.#storageKey);} catch {return null;}
  }

  /** API base URL (empty when same-origin). */
  get bridgeBaseUrl(): string {
    return this.#bridgeBaseUrl;
  }

  #url(path: string): string {
    if (!this.#bridgeBaseUrl) {
      return path;
    }
    return `${this.#bridgeBaseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /**
   * Hosted SPA must never treat the public origin as the bridge API.
   * Empty base + desktop.grok.me would hit Vercel demo stubs and look "paired".
   */
  #requiresLoopbackBridge(): boolean {
    return !this.#transport && !this.#bridgeBaseUrl && isHostedDocumentOrigin();
  }

  #authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.#sessionToken) {
      headers[SESSION_HEADER] = this.#sessionToken;
    }
    if (this.#csrfToken) {
      headers[CSRF_HEADER] = this.#csrfToken;
    }
    if (this.#controllerToken) headers["x-grok-light-controller"] = this.#controllerToken;
    return headers;
  }

  #storedPrivateDraftScope(): string | undefined {
    if (this.remote || !isPrivateDocumentOrigin()) return undefined;
    try {
      const stored = JSON.parse(localStorage.getItem(this.#storageKey) ?? "null") as {installationId?: string; browserSessionId?: string} | null;
      return privateDraftScope(location.origin, stored?.installationId, stored?.browserSessionId);
    } catch {return undefined;}
  }

  async #rememberPair(value: PairResult, generation: number, stored: string | null): Promise<boolean> {
    const previousScope = this.#storedPrivateDraftScope();
    const nextScope = !this.remote && isPrivateDocumentOrigin() ? privateDraftScope(location.origin, value.installationId, value.sessionId) : undefined;
    if (previousScope && previousScope !== nextScope) await forgetDraftScope(previousScope);
    if (generation !== this.#authorityGeneration || (!this.#transport && pairingChangedInStorage({key: this.#storageKey, oldValue: stored, newValue: this.#storedGrant()}, this.#storageKey !== BRIDGE_SESSION_KEY))) return false;
    this.#installationId = typeof value.installationId === "string" ? value.installationId : undefined;
    this.#browserSessionId = value.sessionId;
    this.#csrfToken = value.csrfToken;
    if (value.sessionToken) {
      this.#sessionToken = value.sessionToken;
    }
    this.#persistGrantIfComplete();
    return true;
  }

  #persistGrantIfComplete(): void {
    if (this.#transport) return;
    if (this.#sessionToken === null || this.#csrfToken === null) {
      return;
    }
    if (this.#storageKey !== BRIDGE_SESSION_KEY) {
      try {
        localStorage.setItem(this.#storageKey, JSON.stringify({sessionToken: this.#sessionToken, csrfToken: this.#csrfToken, savedAtMs: Date.now(), ...(this.#installationId ? {installationId: this.#installationId, browserSessionId: this.#browserSessionId} : {})}));
      } catch {}
      return;
    }
    const port = portFromBridgeBase(this.#bridgeBaseUrl) ?? readStoredPort();
    if (port === null) {
      return;
    }
    writeStoredPort(port);
    writeStoredSession({
      port,
      sessionToken: this.#sessionToken,
      csrfToken: this.#csrfToken,
      savedAtMs: Date.now(),
    });
  }

  /**
   * Resume an existing pairing after a reload.
   */
  async resume(): Promise<ClientResult<PairResult>> {
    if (this.#pairAttempt?.generation === this.#authorityGeneration) return this.#pairAttempt.promise;
    if (!this.#transport) this.restoreFromStorage();
    if (this.#resumeAttempt?.generation === this.#authorityGeneration) return this.#resumeAttempt.promise;
    const generation = this.#authorityGeneration;
    const run = async (signal: AbortSignal) => {
      if (generation !== this.#authorityGeneration) return unreachable<PairResult>();
      if (!this.#transport) this.restoreFromStorage();
      return this.#resumeSession(signal);
    };
    const attempt = (this.#transport ? run(AbortSignal.timeout(10_000)) : withResumeLock(`${this.#storageKey}:resume`, run)).catch(() => unreachable<PairResult>());
    const pending = {generation: this.#authorityGeneration, promise: attempt};
    this.#resumeAttempt = pending;
    try {return await attempt;} finally {if (this.#resumeAttempt === pending) this.#resumeAttempt = null;}
  }

  async #resumeSession(signal: AbortSignal): Promise<ClientResult<PairResult>> {
    if (this.#requiresLoopbackBridge()) {
      // No known loopback port yet — do not call the public origin's /session.
      return unreachable();
    }
    const generation = this.#authorityGeneration;
    const stored = this.#storedGrant();
    let response: Response;
    try {
      response = await this.#request("/session", {
        credentials: "include",
        headers: this.#authHeaders(),
        signal,
      });
    } catch {
      return unreachable();
    }
    if (generation !== this.#authorityGeneration || (!this.#transport && pairingChangedInStorage({key: this.#storageKey, oldValue: stored, newValue: this.#storedGrant()}, this.#storageKey !== BRIDGE_SESSION_KEY))) return unreachable();
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? { ok: false, failure: { kind: "not_paired" } }
        : unreachable();
    }
    const body = await responseRecord(response);
    if (!body) return unreachable();
    const value = body as unknown as PairResult;
    if (typeof value.protocolVersion !== "number" || !Number.isSafeInteger(value.protocolVersion)
      || typeof value.sessionId !== "string" || !value.sessionId || typeof value.csrfToken !== "string" || !value.csrfToken
      || (value.sessionToken !== undefined && typeof value.sessionToken !== "string")) return unreachable();
    if (generation !== this.#authorityGeneration || (!this.#transport && pairingChangedInStorage({key: this.#storageKey, oldValue: stored, newValue: this.#storedGrant()}, this.#storageKey !== BRIDGE_SESSION_KEY))) return unreachable();
    if (value.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        failure: { kind: "protocol_mismatch", hostVersion: value.protocolVersion },
      };
    }
    // Require a session token so a demo/stub CSRF-only body cannot look paired.
    if (!value.sessionToken && !this.#sessionToken) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    try {if (!await this.#rememberPair(value, generation, stored)) return unreachable();} catch {return unreachable();}
    // Host echoes session token on resume; keep prior if missing.
    if (!this.#sessionToken && value.sessionToken) {
      this.#sessionToken = value.sessionToken;
    }
    return { ok: true, value };
  }

  /**
   * Redeem a single-use pairing nonce from the URL fragment.
   */
  async pair(nonce: string): Promise<ClientResult<PairResult>> {
    if (this.#pairAttempt?.nonce === nonce && this.#pairAttempt.generation === this.#authorityGeneration) return this.#pairAttempt.promise;
    this.#resetAuthority();
    this.#pendingCommands.clear();
    this.#storePending();
    const attempt = this.#redeemPair(nonce).catch(() => unreachable<PairResult>());
    const pending = {nonce, generation: this.#authorityGeneration, promise: attempt};
    this.#pairAttempt = pending;
    try {return await attempt;} finally {if (this.#pairAttempt === pending) this.#pairAttempt = null;}
  }

  async #redeemPair(nonce: string): Promise<ClientResult<PairResult>> {
    if (this.#requiresLoopbackBridge()) {
      // Pairing without &p= would POST to the public origin, not the bridge.
      return { ok: false, failure: { kind: "rejected" } };
    }
    const generation = this.#authorityGeneration;
    const stored = this.#storedGrant();
    const isCurrent = () => generation === this.#authorityGeneration && (this.#transport || !pairingChangedInStorage({key: this.#storageKey, oldValue: stored, newValue: this.#storedGrant()}, this.#storageKey !== BRIDGE_SESSION_KEY));
    let response: Response;
    try {
      response = await this.#request("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        credentials: "include",
      });
    } catch {
      return unreachable();
    }
    if (!isCurrent()) return unreachable();
    if (!response.ok) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    const body = await responseRecord(response);
    if (!body) return unreachable();
    const value = body as unknown as PairResult;
    if (typeof value.protocolVersion !== "number" || !Number.isSafeInteger(value.protocolVersion)
      || typeof value.sessionId !== "string" || !value.sessionId || typeof value.csrfToken !== "string" || !value.csrfToken
      || (value.sessionToken !== undefined && typeof value.sessionToken !== "string")) return unreachable();
    if (!isCurrent()) return unreachable();
    if (value.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        failure: { kind: "protocol_mismatch", hostVersion: value.protocolVersion },
      };
    }
    if (!value.sessionToken) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    try {if (!await this.#rememberPair(value, generation, stored)) return unreachable();} catch {return unreachable();}
    return { ok: true, value };
  }

  commandFits(operation: Operation, options: { idempotencyKey?: string; controllerEpoch?: number } = {}): boolean {
    return commandFits({
      protocolVersion: this.#commandVersion(operation),
      requestId: COMMAND_ID_PLACEHOLDER,
      operation,
      ...(options.idempotencyKey === undefined ? {} : {idempotencyKey: options.idempotencyKey}),
      ...((options.controllerEpoch ?? this.#controllerEpoch) === undefined ? {} : {controllerEpoch: options.controllerEpoch ?? this.#controllerEpoch}),
    }, this.remote);
  }

  async send(
    operation: Operation,
    options: { idempotencyKey?: string; controllerEpoch?: number } = {},
  ): Promise<ClientResult<unknown>> {
    if (this.#csrfToken === null || this.#sessionToken === null) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    const envelope: CommandEnvelope = {
      protocolVersion: this.#commandVersion(operation),
      requestId: crypto.randomUUID(),
      operation,
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
      ...((options.controllerEpoch ?? this.#controllerEpoch) === undefined
        ? {}
        : { controllerEpoch: options.controllerEpoch ?? this.#controllerEpoch }),
    };
    if (!commandFits(envelope, this.remote)) return {ok: false, failure: {kind: "refused", code: "request_too_large"}};
    const bodyText = JSON.stringify(envelope);
    if ((operation.kind === "prompt" || operation.kind === "sendNow" || operation.kind === "promptContent" || operation.kind === "interruptAndEnqueue") && options.idempotencyKey) {
      this.#pendingCommands.add(options.idempotencyKey);
      this.#storePending();
    }

    const generation = this.#authorityGeneration;
    let response: Response;
    try {
      response = await this.#request("/command", {
        method: "POST",
        headers: this.#authHeaders({ "content-type": "application/json" }),
        body: bodyText,
        credentials: "include",
      });
    } catch {
      return unreachable();
    }

    if (generation !== this.#authorityGeneration) return unreachable();

    const settle = () => {
      if (options.idempotencyKey && this.#pendingCommands.delete(options.idempotencyKey)) this.#storePending();
    };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    if (response.status === 413) {
      settle();
      return {ok: false, failure: {kind: "refused", code: "request_too_large"}};
    }
    if (response.status === 400) {
      settle();
      return { ok: false, failure: { kind: "bad_request" } };
    }
    if (!response.ok && response.status !== 409 && response.status !== 422) return unreachable();
    const body = await responseRecord(response);
    if (generation !== this.#authorityGeneration || !body) return unreachable();
    const error = typeof body.error === "string" ? body.error : record(body.error)?.code;
    if (response.status === 409) {
      if (typeof body.protocolVersion === "number" && (error === "unsupported_protocol_version" || ![PROTOCOL_VERSION, 3, MULTI_WRITER_PROTOCOL_VERSION].includes(body.protocolVersion))) {
        return { ok: false, failure: { kind: "protocol_mismatch", hostVersion: body.protocolVersion } };
      }
      if (typeof error !== "string" || !error) return unreachable();
      return { ok: false, failure: { kind: "refused", code: error } };
    }
    if (response.status === 422) {
      if (typeof error !== "string" || !error) return unreachable();
      return { ok: false, failure: { kind: "refused", code: error } };
    }
    if (!("result" in body) || (body.requestId !== undefined && body.requestId !== envelope.requestId)) return unreachable();
    if (operation.kind === "getRemoteCapabilities") {
      const capabilities = asRemoteCapabilities(body.result);
      if (capabilities) this.#multiWriter = capabilities.multiWriter === true;
    }
    if (options.idempotencyKey && this.#pendingCommands.has(options.idempotencyKey)) {
      const outcome = record(body.result)?.outcome;
      if (outcome === "commandAccepted" || outcome === "commandStatus") {
        const receipt = commandReceipt(body.result, options.idempotencyKey);
        if (!receipt) return unreachable();
        if (["completed", "failed", "removed", "reviewed"].includes(receipt.state)) settle();
      } else if (typeof outcome === "string") settle();
      else return unreachable();
    }
    return { ok: true, value: body.result };
  }

  openEvents(handlers: EventHandlers): EventConnection | null {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let connection: EventConnection | null = null;
    this.#controllerEpoch = undefined;
    this.#controllerToken = undefined;
    const generation = ++this.#eventsGeneration;
    const current = () => generation === this.#eventsGeneration;
    const invalidate = () => {
      clearInterval(heartbeat);
      if (current()) {
        this.#eventsGeneration++;
        this.#controllerEpoch = undefined;
        this.#controllerToken = undefined;
      }
    };
    const receive = (envelope: EventEnvelope) => {
      if (!current() || envelope.protocolVersion !== PROTOCOL_VERSION) return;
      if (envelope.event.kind === "hostStatus") {
        if (envelope.event.state === "writable") this.#multiWriter = true;
        this.#controllerEpoch = controllerEpochAfterStatus(this.#controllerEpoch, envelope.event.state);
        if (envelope.event.state === "watching") this.#controllerToken = undefined;
        if (/^controlling:\d+$/.test(envelope.event.state)) this.#controllerToken = /^[0-9a-f]{64}$/.test(envelope.event.controllerToken ?? "") ? envelope.event.controllerToken : undefined;
      }
      if (envelope.event.kind === "replayReset") this.#eventSequence = 0;
      if (envelope.event.kind !== "hostStatus" && envelope.event.kind !== "replayReset" && envelope.eventSequence > 0 && envelope.eventSequence <= this.#eventSequence) return;
      if (envelope.event.kind === "commandCompleted" && this.#pendingCommands.delete(envelope.event.idempotencyKey)) this.#storePending();
      this.#eventSequence = Math.max(this.#eventSequence, envelope.eventSequence);
      handlers.onEvent(envelope);
    };
    const wrapped: EventHandlers = {
      onFailure: (failure) => {
        if (!current()) return;
        const revocation = this.#revocationFailure;
        if (failure.kind === "not_paired" && revocation?.generation === this.#authorityGeneration) revocation.notify = () => handlers.onFailure?.(failure);
        else handlers.onFailure?.(failure);
      },
      onEvent: receive,
      onOpen: () => {
        if (!current()) return;
        heartbeat = setInterval(() => {if (current()) connection?.send(JSON.stringify({kind: "controllerHeartbeat"}));}, 5_000);
        handlers.onOpen();
        for (const idempotencyKey of this.#pendingCommands) {
          void this.send({kind: "getCommandStatus", idempotencyKey}).then((reply) => {
            if (!current()) return;
            if (!reply.ok) {
              if (reply.failure.kind === "refused" && reply.failure.code === "unknown_command") {
                handlers.onEvent({protocolVersion: PROTOCOL_VERSION, eventSequence: 0, event: {kind: "commandCompleted", idempotencyKey, error: "command_outcome_unknown"}});
              }
              return;
            }
            const status = commandReceipt(reply.value, idempotencyKey);
            if (!status || status.state === "running" || status.state === "queued") return;
            if (status.state !== "needsReview" && this.#pendingCommands.delete(idempotencyKey)) this.#storePending();
            const error = status.error ?? (status.state === "needsReview" ? "interrupted_needs_review" : status.state === "failed" ? "command_failed" : status.state === "removed" ? "command_removed" : status.state === "reviewed" ? "command_reviewed" : undefined);
            handlers.onEvent({protocolVersion: PROTOCOL_VERSION, eventSequence: 0, event: {kind: "commandCompleted", idempotencyKey, result: status.result, ...(error ? {error} : {})}});
          });
        }
      },
      onClose: () => {
        clearInterval(heartbeat);
        if (!current()) return;
        invalidate();
        handlers.onClose();
      },
    };
    if (this.#transport) {
      connection = this.#transport.openEvents(wrapped, this.#eventSequence);
      return {send: (data) => {if (current()) connection?.send(data);}, close: () => {invalidate(); connection?.close();}};
    }
    if (typeof WebSocket === "undefined") {
      return null;
    }
    if (this.#sessionToken === null) {
      return null;
    }
    const httpBase = this.#bridgeBaseUrl || location.origin;
    const url = `${httpBase.replace(/^http/, "ws")}/events?protocolVersion=${MULTI_WRITER_PROTOCOL_VERSION}${this.#eventSequence > 0 ? `&afterSequence=${this.#eventSequence}` : ""}`;
    // Family protocol + session token (hosted cannot send Cookie or headers).
    const protocols = [WS_SUBPROTOCOL, `${WS_SESSION_PROTOCOL_PREFIX}${this.#sessionToken}`];
    const socket = new WebSocket(url, protocols);
    connection = socket;
    socket.addEventListener("message", (message: MessageEvent) => {
      try {
        receive(JSON.parse(String(message.data)) as EventEnvelope);
      } catch {
        // drop
      }
    });
    socket.addEventListener("open", wrapped.onOpen);
    socket.addEventListener("close", wrapped.onClose);
    socket.addEventListener("error", () => socket.close());
    return {send: (data) => { if (current() && socket.readyState === WebSocket.OPEN) socket.send(data); }, close: () => {invalidate(); socket.close();}};
  }
}

/** localStorage / sessionStorage key for the last known loopback port. */
export const BRIDGE_PORT_KEY = "grok-bridge-port";

/** Document-origin resume grant (session token + CSRF + port). */
export const BRIDGE_SESSION_KEY = "grok-bridge-session.v1";
export const PRIVATE_SESSION_KEY = "grok-private-session.v1";

export function pairingChangedInStorage(event: Pick<StorageEvent, "key" | "oldValue" | "newValue">, privateOrigin = isPrivateDocumentOrigin()): boolean {
  if (event.key === null) return true;
  if (!privateOrigin && event.key === BRIDGE_PORT_KEY) return event.oldValue !== event.newValue;
  if (event.key !== (privateOrigin ? PRIVATE_SESSION_KEY : BRIDGE_SESSION_KEY)) return false;
  if (event.oldValue === event.newValue) return false;
  if (event.oldValue === null || event.newValue === null) return true;
  try {
    const before = JSON.parse(event.oldValue) as StoredBridgeSession | null;
    const after = JSON.parse(event.newValue) as StoredBridgeSession | null;
    return (!privateOrigin && before?.port !== after?.port) || before?.sessionToken !== after?.sessionToken;
  } catch {return true;}
}

/** Soft TTL for the resume grant (7 days). */
export const SESSION_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredBridgeSession {
  port: number;
  sessionToken: string;
  csrfToken: string;
  savedAtMs: number;
}

function isValidPortString(value: string): boolean {
  return /^\d{2,5}$/.test(value);
}

function parsePort(value: string | null): number | null {
  if (value === null || !isValidPortString(value)) {
    return null;
  }
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) && port >= 10 && port <= 65535 ? port : null;
}

/** Extract port from `http://127.0.0.1:PORT` (or localhost). */
export function portFromBridgeBase(base: string): number | null {
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})$/i.exec(base.trim());
  if (match === null) {
    return null;
  }
  return parsePort(match[1] ?? null);
}

/** Read last known loopback port (localStorage, then sessionStorage; promote). */
export function readStoredPort(): number | null {
  try {
    if (typeof localStorage !== "undefined") {
      const fromLocal = parsePort(localStorage.getItem(BRIDGE_PORT_KEY));
      if (fromLocal !== null) {
        return fromLocal;
      }
    }
    if (typeof sessionStorage !== "undefined") {
      const fromSession = parsePort(sessionStorage.getItem(BRIDGE_PORT_KEY));
      if (fromSession !== null) {
        // Promote legacy tab-only port to durable storage.
        writeStoredPort(fromSession);
        return fromSession;
      }
    }
  } catch {
    // Storage may be blocked (private mode).
  }
  return null;
}

/** Persist loopback port for multi-tab / restart discovery. */
export function writeStoredPort(port: number): void {
  if (!Number.isFinite(port) || port < 10 || port > 65535) {
    return;
  }
  const value = String(port);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(BRIDGE_PORT_KEY, value);
    }
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(BRIDGE_PORT_KEY, value);
    }
  } catch {
    // ignore
  }
}

/** Forget remembered port (e.g. after confirmed bridge_missing). */
export function clearStoredPort(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(BRIDGE_PORT_KEY);
    }
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(BRIDGE_PORT_KEY);
    }
  } catch {
    // ignore
  }
}

/** True when a port has ever been remembered on this profile. */
export function hasStoredPort(): boolean {
  return readStoredPort() !== null;
}

/** Read a non-expired document-origin session grant. */
export function readStoredSession(nowMs: number = Date.now()): StoredBridgeSession | null {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    const raw = localStorage.getItem(BRIDGE_SESSION_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredBridgeSession>;
    if (
      typeof parsed.port !== "number" ||
      typeof parsed.sessionToken !== "string" ||
      typeof parsed.csrfToken !== "string" ||
      typeof parsed.savedAtMs !== "number" ||
      parsed.sessionToken.length === 0 ||
      parsed.csrfToken.length === 0
    ) {
      clearStoredSessionGrant();
      return null;
    }
    if (nowMs - parsed.savedAtMs > SESSION_GRANT_TTL_MS) {
      clearStoredSessionGrant();
      return null;
    }
    const port = parsed.port;
    if (!Number.isFinite(port) || port < 10 || port > 65535) {
      clearStoredSessionGrant();
      return null;
    }
    return {
      port,
      sessionToken: parsed.sessionToken,
      csrfToken: parsed.csrfToken,
      savedAtMs: parsed.savedAtMs,
    };
  } catch {
    return null;
  }
}

/** Persist session grant for silent resume (new tab / browser restart). */
export function writeStoredSession(session: StoredBridgeSession): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(BRIDGE_SESSION_KEY, JSON.stringify(session));
    writeStoredPort(session.port);
  } catch {
    // ignore
  }
}

/** Clear session tokens only; keep remembered port. */
export function clearStoredSessionGrant(): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(BRIDGE_SESSION_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Read and immediately clear a pairing nonce (and optional API port) from the
 * URL fragment: `#pair=<64-hex>[&p=<port>]`.
 */
export function takePairingNonce(): string | null {
  return takePairingFragment()?.nonce ?? null;
}

/** Fragment params from `spanreed agent open` for hosted UI. */
export function takePairingFragment(): { nonce: string; port: number | null } | null {
  if (typeof location === "undefined") {
    return null;
  }
  const match = /^#pair=([0-9a-f]{64})(?:&p=(\d{2,5}))?$/.exec(location.hash);
  if (match === null) {
    return null;
  }
  const nonce = match[1] ?? null;
  if (!nonce) {
    return null;
  }
  const portRaw = match[2];
  const port =
    portRaw !== undefined && portRaw.length > 0 ? Number.parseInt(portRaw, 10) : null;
  if (port !== null && Number.isFinite(port)) {
    writeStoredPort(port);
  }
  history.replaceState(null, "", location.pathname + location.search);
  return { nonce, port: port !== null && Number.isFinite(port) ? port : null };
}

/**
 * Production Work UI document origin (ADR light 0016).
 * Same-origin fetch here is the public site (or a demo stub), never the bridge.
 */
export const HOSTED_SPA_ORIGIN = "https://desktop.grok.me";
export const REMOTE_SPA_ORIGIN = "https://remote.fabrials.com";

export function isPrivateDocumentOrigin(origin: string = typeof location !== "undefined" ? location.origin : ""): boolean {
  return origin.startsWith("https://") && !isKnownHostedOrigin(origin);
}

/** True when this document is the hosted SPA, not the loopback fallback UI. */
export function isHostedDocumentOrigin(
  origin: string = typeof location !== "undefined" ? location.origin : "",
): boolean {
  return isKnownHostedOrigin(origin);
}

/** Resolve loopback base URL from build env or last remembered port. */
export function resolveBridgeBaseUrl(explicit?: string): string {
  if (explicit !== undefined) {
    return explicit;
  }
  if (isPrivateDocumentOrigin()) return "";
  const fromEnv = defaultBridgeBaseUrl();
  if (fromEnv) {
    return fromEnv;
  }
  const port = readStoredPort();
  if (port !== null) {
    return `http://127.0.0.1:${port}`;
  }
  // Hosted SPA without a known port cannot probe until `open` provides &p=.
  return "";
}
