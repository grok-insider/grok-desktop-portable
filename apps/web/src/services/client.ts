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
  SESSION_HEADER,
  WS_SESSION_PROTOCOL_PREFIX,
  WS_SUBPROTOCOL,
  defaultBridgeBaseUrl,
  type CommandEnvelope,
  type EventEnvelope,
  type Operation,
} from "./protocol";

/** Result of a successful pairing exchange. */
export interface PairResult {
  sessionId: string;
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

export interface LightClientOptions {
  /** Loopback API base, e.g. `http://127.0.0.1:20001`. Empty = same-origin. */
  bridgeBaseUrl?: string;
}

/** Talks to the local bridge API. */
export class LightClient {
  #csrfToken: string | null = null;
  #sessionToken: string | null = null;
  #bridgeBaseUrl: string;

  constructor(options: LightClientOptions = {}) {
    this.#bridgeBaseUrl =
      options.bridgeBaseUrl !== undefined
        ? options.bridgeBaseUrl
        : resolveBridgeBaseUrl();
  }

  /** Update API base after learning the port from a pair URL. */
  setBridgeBaseUrl(base: string): void {
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
    this.#csrfToken = null;
    this.#sessionToken = null;
    clearStoredSessionGrant();
    if (options.clearPort) {
      clearStoredPort();
    }
  }

  /** Restore tokens from the document-origin resume store (if still valid). */
  restoreFromStorage(nowMs: number = Date.now()): boolean {
    const stored = readStoredSession(nowMs);
    if (stored === null) {
      return false;
    }
    this.#sessionToken = stored.sessionToken;
    this.#csrfToken = stored.csrfToken;
    if (!this.#bridgeBaseUrl) {
      this.#bridgeBaseUrl = `http://127.0.0.1:${stored.port}`;
    }
    return true;
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
    return !this.#bridgeBaseUrl && isHostedDocumentOrigin();
  }

  #authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.#sessionToken) {
      headers[SESSION_HEADER] = this.#sessionToken;
    }
    if (this.#csrfToken) {
      headers[CSRF_HEADER] = this.#csrfToken;
    }
    return headers;
  }

  #rememberPair(value: PairResult): void {
    this.#csrfToken = value.csrfToken;
    if (value.sessionToken) {
      this.#sessionToken = value.sessionToken;
    }
    this.#persistGrantIfComplete();
  }

  #persistGrantIfComplete(): void {
    if (this.#sessionToken === null || this.#csrfToken === null) {
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
    if (this.#requiresLoopbackBridge()) {
      // No known loopback port yet — do not call the public origin's /session.
      return unreachable();
    }
    let response: Response;
    try {
      response = await fetch(this.#url("/session"), {
        credentials: "include",
        headers: this.#authHeaders(),
      });
    } catch {
      return unreachable();
    }
    if (!response.ok) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    const value = (await response.json()) as PairResult;
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
    this.#rememberPair(value);
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
    if (this.#requiresLoopbackBridge()) {
      // Pairing without &p= would POST to the public origin, not the bridge.
      return { ok: false, failure: { kind: "rejected" } };
    }
    let response: Response;
    try {
      response = await fetch(this.#url("/pair"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        credentials: "include",
      });
    } catch {
      return unreachable();
    }
    if (!response.ok) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    const value = (await response.json()) as PairResult;
    if (value.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        failure: { kind: "protocol_mismatch", hostVersion: value.protocolVersion },
      };
    }
    if (!value.sessionToken) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    this.#rememberPair(value);
    return { ok: true, value };
  }

  async send(
    operation: Operation,
    options: { idempotencyKey?: string; controllerEpoch?: number } = {},
  ): Promise<ClientResult<unknown>> {
    if (this.#csrfToken === null || this.#sessionToken === null) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    const envelope: CommandEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      operation,
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
      ...(options.controllerEpoch === undefined
        ? {}
        : { controllerEpoch: options.controllerEpoch }),
    };

    let response: Response;
    try {
      response = await fetch(this.#url("/command"), {
        method: "POST",
        headers: this.#authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(envelope),
        credentials: "include",
      });
    } catch {
      return unreachable();
    }

    if (response.status === 403) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    if (response.status === 409) {
      const body = (await response.json()) as { protocolVersion?: number };
      return {
        ok: false,
        failure: {
          kind: "protocol_mismatch",
          hostVersion: body.protocolVersion ?? PROTOCOL_VERSION,
        },
      };
    }
    if (response.status === 400) {
      return { ok: false, failure: { kind: "bad_request" } };
    }
    if (response.status === 422) {
      const body = (await response.json()) as { error?: string };
      return { ok: false, failure: { kind: "refused", code: body.error ?? "refused" } };
    }
    if (!response.ok) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    const body = (await response.json()) as { result?: unknown };
    return { ok: true, value: body.result };
  }

  openEvents(handlers: {
    onEvent: (envelope: EventEnvelope) => void;
    onOpen: () => void;
    onClose: () => void;
  }): WebSocket | null {
    if (typeof WebSocket === "undefined") {
      return null;
    }
    if (this.#sessionToken === null) {
      return null;
    }
    const httpBase = this.#bridgeBaseUrl || location.origin;
    const url = `${httpBase.replace(/^http/, "ws")}/events`;
    // Family protocol + session token (hosted cannot send Cookie or headers).
    const protocols = [WS_SUBPROTOCOL, `${WS_SESSION_PROTOCOL_PREFIX}${this.#sessionToken}`];
    const socket = new WebSocket(url, protocols);
    socket.addEventListener("message", (message: MessageEvent) => {
      try {
        handlers.onEvent(JSON.parse(String(message.data)) as EventEnvelope);
      } catch {
        // drop
      }
    });
    socket.addEventListener("open", handlers.onOpen);
    socket.addEventListener("close", handlers.onClose);
    socket.addEventListener("error", () => socket.close());
    return socket;
  }
}

/** localStorage / sessionStorage key for the last known loopback port. */
export const BRIDGE_PORT_KEY = "grok-bridge-port";

/** Document-origin resume grant (session token + CSRF + port). */
export const BRIDGE_SESSION_KEY = "grok-bridge-session.v1";

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

/** Fragment params from `grok-bridge open` for hosted UI. */
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

/** True when this document is the hosted SPA, not the loopback fallback UI. */
export function isHostedDocumentOrigin(
  origin: string = typeof location !== "undefined" ? location.origin : "",
): boolean {
  return origin === HOSTED_SPA_ORIGIN;
}

/** Resolve loopback base URL from build env or last remembered port. */
export function resolveBridgeBaseUrl(explicit?: string): string {
  if (explicit !== undefined) {
    return explicit;
  }
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
