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
  }

  /** Whether this page has completed a pairing exchange. */
  get paired(): boolean {
    return this.#csrfToken !== null && this.#sessionToken !== null;
  }

  /** Drop in-memory pairing so a demotion cannot keep sending authed calls. */
  clearPairing(): void {
    this.#csrfToken = null;
    this.#sessionToken = null;
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
  }

  /**
   * Resume an existing pairing after a reload.
   */
  async resume(): Promise<ClientResult<PairResult>> {
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

const BRIDGE_PORT_KEY = "grok-bridge-port";

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
  if (port !== null && Number.isFinite(port) && typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(BRIDGE_PORT_KEY, String(port));
  }
  history.replaceState(null, "", location.pathname + location.search);
  return { nonce, port: port !== null && Number.isFinite(port) ? port : null };
}

/** Resolve loopback base URL from build env or last pair fragment port. */
export function resolveBridgeBaseUrl(explicit?: string): string {
  if (explicit !== undefined) {
    return explicit;
  }
  const fromEnv = defaultBridgeBaseUrl();
  if (fromEnv) {
    return fromEnv;
  }
  if (typeof sessionStorage !== "undefined") {
    const stored = sessionStorage.getItem(BRIDGE_PORT_KEY);
    if (stored && /^\d{2,5}$/.test(stored)) {
      return `http://127.0.0.1:${stored}`;
    }
  }
  // Hosted SPA without a known port cannot probe until `open` provides &p=.
  return "";
}
