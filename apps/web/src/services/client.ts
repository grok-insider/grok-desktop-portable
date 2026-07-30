/**
 * Transport to the local host.
 *
 * Commands go over same-origin HTTP with the CSRF token the pairing exchange
 * returned; events arrive on a WebSocket carrying the exact versioned
 * subprotocol. Nothing here talks to any other origin, and there is no
 * fallback that would.
 */

import {
  CSRF_HEADER,
  PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  type CommandEnvelope,
  type EventEnvelope,
  type Operation,
} from "./protocol";

/** Result of a successful pairing exchange. */
export interface PairResult {
  sessionId: string;
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

/** Talks to the host that served this page. */
export class LightClient {
  #csrfToken: string | null = null;

  /** Whether this page has completed a pairing exchange. */
  get paired(): boolean {
    return this.#csrfToken !== null;
  }

  /**
   * Resume an existing pairing after a reload.
   *
   * The CSRF token lives in page memory only, so a refresh loses it while the
   * pairing cookie survives. This asks the host for a fresh one rather than
   * sending the user back to setup for a pairing they already completed.
   */
  async resume(): Promise<ClientResult<PairResult>> {
    let response: Response;
    try {
      response = await fetch("/session", { credentials: "same-origin" });
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
    this.#csrfToken = value.csrfToken;
    return { ok: true, value };
  }

  /**
   * Redeem a single-use pairing nonce.
   *
   * The nonce arrives in the URL fragment, which never reaches the server, and
   * the caller clears it immediately afterwards.
   */
  async pair(nonce: string): Promise<ClientResult<PairResult>> {
    let response: Response;
    try {
      response = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        credentials: "same-origin",
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
    this.#csrfToken = value.csrfToken;
    return { ok: true, value };
  }

  /**
   * Send one command.
   *
   * A side-effecting operation must carry an idempotency key so a retry after
   * an ambiguous outcome cannot execute twice; the host enforces this too.
   */
  async send(
    operation: Operation,
    options: { idempotencyKey?: string; controllerEpoch?: number } = {},
  ): Promise<ClientResult<unknown>> {
    if (this.#csrfToken === null) {
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
      response = await fetch("/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: this.#csrfToken,
        },
        body: JSON.stringify(envelope),
        credentials: "same-origin",
      });
    } catch {
      return unreachable();
    }

    if (response.status === 403) {
      return { ok: false, failure: { kind: "not_paired" } };
    }
    if (response.status === 409) {
      // This page outlived a host upgrade. The body may no longer parse at
      // the host's version, so it answers on version alone and this becomes a
      // reload rather than an error the user cannot act on.
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
      // A refused command, not a transport failure: the host explains why.
      const body = (await response.json()) as { error?: string };
      return { ok: false, failure: { kind: "refused", code: body.error ?? "refused" } };
    }
    if (!response.ok) {
      return { ok: false, failure: { kind: "rejected" } };
    }
    const body = (await response.json()) as { result?: unknown };
    return { ok: true, value: body.result };
  }

  /**
   * Open the event channel.
   *
   * The versioned subprotocol is required: a host that does not accept it is a
   * version mismatch, which fails closed rather than negotiating down.
   */
  openEvents(handlers: {
    onEvent: (envelope: EventEnvelope) => void;
    onOpen: () => void;
    onClose: () => void;
  }): WebSocket | null {
    if (typeof WebSocket === "undefined") {
      return null;
    }
    const url = `${location.origin.replace(/^http/, "ws")}/events`;
    const socket = new WebSocket(url, WS_SUBPROTOCOL);
    socket.addEventListener("message", (message: MessageEvent) => {
      try {
        handlers.onEvent(JSON.parse(String(message.data)) as EventEnvelope);
      } catch {
        // A frame we cannot parse is dropped rather than crashing the view.
      }
    });
    socket.addEventListener("open", handlers.onOpen);
    socket.addEventListener("close", handlers.onClose);
    socket.addEventListener("error", () => socket.close());
    return socket;
  }
}

/**
 * Read and immediately clear a pairing nonce from the URL fragment.
 *
 * The fragment is never sent to the server, and clearing it keeps the nonce
 * out of the bookmark the user is about to make.
 */
export function takePairingNonce(): string | null {
  if (typeof location === "undefined") {
    return null;
  }
  const match = /^#pair=([0-9a-f]{64})$/.exec(location.hash);
  if (match === null) {
    return null;
  }
  const nonce = match[1];
  history.replaceState(null, "", location.pathname + location.search);
  return nonce ?? null;
}
