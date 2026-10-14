export const ACCOUNT_ORIGIN = "https://fabrials.com";
const BASE = `${ACCOUNT_ORIGIN}/api/spanreed/remote`;

export interface RemoteHost {
  id: string;
  label: string;
  publicKey: string;
  installationId: string;
  revoked: boolean;
  generation: number;
}

export interface RemotePairing {
  hostId: string;
  secret: string;
  hostPublicKey: string;
}

export interface PublicShare {
  id: string;
  hostId: string;
  sessionId: string;
  title: string;
  generation: number;
  active: boolean;
  url: string;
  syncedAt?: number | null;
}

export class RemoteAccountError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    const limits: Record<string, string> = {
      active_host_limit: "Your account has reached its computer limit. Revoke an unused computer before adding another.",
      host_history_full: "Your computer history is full. Contact Fabrials support before adding another computer.",
      active_share_limit: "Your account has reached its public-link limit. Withdraw an existing link before publishing another.",
      share_history_full: "Your public-link history is full. Contact Fabrials support before creating another link.",
      outstanding_ticket_limit: "Too many connections are being opened. Wait a minute, then reconnect.",
    };
    super(status === 401 ? "Sign in to Fabrials to see your computers." : status === 429 && code && Object.hasOwn(limits, code) ? limits[code] : "The account service is unavailable. Try again.");
  }
}

let accountQueue: Promise<unknown> = Promise.resolve();

export async function remoteAccount<T>(path: string, init?: RequestInit): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("The account service took too long. Try again.", "TimeoutError")), 30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  const run = async () => {
    signal.throwIfAborted();
    const response = await fetch(`${BASE}${path}`, {...init, signal, credentials: "include", headers: {"content-type": "application/json", ...init?.headers}, cache: "no-store"});
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : undefined;
      throw new RemoteAccountError(response.status, code);
    }
    return response.json() as Promise<T>;
  };
  let aborted: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    let attempt: Promise<T>;
    if (typeof navigator !== "undefined" && navigator.locks) {
      attempt = navigator.locks.request(`grok-remote-account:${ACCOUNT_ORIGIN}`, {mode: "exclusive", signal}, run);
    } else {
      attempt = accountQueue.then(run);
      accountQueue = attempt.then(() => undefined, () => undefined);
    }
    return await Promise.race([attempt, new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, {once: true});
      if (signal.aborted) aborted();
    })]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}

export function takeRemotePairing(fragment: string = location.hash): RemotePairing | null {
  if (!fragment.startsWith("#remotePair=")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const encoded = fragment.slice("#remotePair=".length);
    if (encoded.length > 2048) return null;
    const value = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))) as RemotePairing;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value.hostId) || !/^[a-f0-9]{64}$/i.test(value.secret) || !/^[a-f0-9]{64}$/i.test(value.hostPublicKey)) return null;
    return value;
  } catch {return null;}
}
