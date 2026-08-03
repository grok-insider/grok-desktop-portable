/**
 * Anonymous presence for the hosted landing badge.
 *
 * Talks to grok-insider-web (api.grokinsider.net), never to grok-bridge.
 * Payload is only an opaque client_id (UUID). No paths, ports, tokens, or
 * install-id.
 */

import { HOSTED_SPA_ORIGIN, isHostedDocumentOrigin } from "./client";

export const PRESENCE_CLIENT_KEY = "gdp-presence-client.v1";

/** Default production endpoint (proxy → Next /api/desktop/v1/portable/count). */
export const DEFAULT_PRESENCE_URL =
  "https://api.grokinsider.net/desktop/v1/portable/count";

export type PresenceStats = {
  active: number;
  total: number;
  window_sec: number;
};

const HEARTBEAT_INTERVAL_MS = 60_000;

function envPresenceUrl(): string | null {
  try {
    if (
      typeof import.meta !== "undefined" &&
      import.meta.env &&
      typeof import.meta.env.VITE_PRESENCE_URL === "string" &&
      import.meta.env.VITE_PRESENCE_URL.trim().length > 0
    ) {
      return import.meta.env.VITE_PRESENCE_URL.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Resolved presence endpoint, or null if presence is disabled. */
export function resolvePresenceUrl(
  envUrl: string | null = envPresenceUrl(),
): string | null {
  if (envUrl !== null && envUrl.length === 0) {
    // Explicit empty disables presence.
    return null;
  }
  if (envUrl) return envUrl;
  if (isHostedDocumentOrigin()) return DEFAULT_PRESENCE_URL;
  return null;
}

/**
 * Whether this document should send heartbeats / show the badge.
 * Hosted production always; other origins only when VITE_PRESENCE_URL is set.
 */
export function shouldRunPresence(
  origin: string = typeof location !== "undefined" ? location.origin : "",
  envUrl: string | null = envPresenceUrl(),
): boolean {
  if (envUrl !== null && envUrl.length === 0) return false;
  if (envUrl) return true;
  return origin === HOSTED_SPA_ORIGIN;
}

export function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function randomUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older engines (should not hit on supported browsers).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getOrCreateClientId(
  storage: Storage | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): string {
  if (!storage) return randomUuidV4();
  try {
    const existing = storage.getItem(PRESENCE_CLIENT_KEY);
    if (existing && isUuidV4(existing)) return existing;
    const id = randomUuidV4();
    storage.setItem(PRESENCE_CLIENT_KEY, id);
    return id;
  } catch {
    return randomUuidV4();
  }
}

function parseStats(data: unknown): PresenceStats | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const active = o.active;
  const total = o.total;
  const window_sec = o.window_sec;
  if (
    typeof active !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(active) ||
    !Number.isFinite(total) ||
    active < 0 ||
    total < 0
  ) {
    return null;
  }
  return {
    active: Math.floor(active),
    total: Math.floor(total),
    window_sec:
      typeof window_sec === "number" && Number.isFinite(window_sec)
        ? Math.floor(window_sec)
        : 300,
  };
}

/** Build the only allowed heartbeat body. */
export function presenceHeartbeatBody(clientId: string): { client_id: string } {
  return { client_id: clientId };
}

export async function fetchPresenceStats(
  url: string = resolvePresenceUrl() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<PresenceStats | null> {
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseStats(await res.json());
  } catch {
    return null;
  }
}

export async function heartbeatPresence(
  clientId: string,
  url: string = resolvePresenceUrl() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<PresenceStats | null> {
  if (!url || !isUuidV4(clientId)) return null;
  const body = presenceHeartbeatBody(clientId);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "omit",
      mode: "cors",
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return parseStats(await res.json());
  } catch {
    return null;
  }
}

/**
 * Start a background heartbeat loop. Returns a dispose function.
 * Safe to call when presence is disabled (no-op dispose).
 */
export function startPresenceLoop(options?: {
  onStats?: (stats: PresenceStats | null) => void;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
  url?: string | null;
  run?: boolean;
}): () => void {
  const run = options?.run ?? shouldRunPresence();
  const url = options?.url ?? resolvePresenceUrl();
  if (!run || !url) {
    options?.onStats?.(null);
    return () => {};
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const intervalMs = options?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const clientId = getOrCreateClientId(options?.storage);
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (cancelled) return;
    const stats = await heartbeatPresence(clientId, url, fetchImpl);
    if (!cancelled) options?.onStats?.(stats);
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
  };
}

export function formatPresenceCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 10_000) {
    const k = n / 1000;
    const s = k.toFixed(1).replace(/\.0$/, "");
    return `${s}k`;
  }
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m.toFixed(1).replace(/\.0$/, "")}m`;
}

export { HEARTBEAT_INTERVAL_MS };
