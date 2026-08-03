import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESENCE_URL,
  formatPresenceCount,
  getOrCreateClientId,
  heartbeatPresence,
  isUuidV4,
  presenceHeartbeatBody,
  PRESENCE_CLIENT_KEY,
  resolvePresenceUrl,
  shouldRunPresence,
  startPresenceLoop,
} from "./presence";
import { HOSTED_SPA_ORIGIN } from "./client";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("presence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates uuid v4", () => {
    expect(isUuidV4("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuidV4("not-uuid")).toBe(false);
  });

  it("persists an opaque client id", () => {
    const storage = memoryStorage();
    const a = getOrCreateClientId(storage);
    const b = getOrCreateClientId(storage);
    expect(a).toBe(b);
    expect(isUuidV4(a)).toBe(true);
    expect(storage.getItem(PRESENCE_CLIENT_KEY)).toBe(a);
  });

  it("heartbeat body contains only client_id", () => {
    const body = presenceHeartbeatBody("11111111-1111-4111-8111-111111111111");
    expect(Object.keys(body)).toEqual(["client_id"]);
    expect(body.client_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("runs on hosted origin by default", () => {
    expect(shouldRunPresence(HOSTED_SPA_ORIGIN, null)).toBe(true);
    expect(shouldRunPresence("http://127.0.0.1:7840", null)).toBe(false);
  });

  it("allows non-hosted origins when VITE_PRESENCE_URL is set", () => {
    expect(
      shouldRunPresence("http://127.0.0.1:5173", "http://127.0.0.1:3000/api/x"),
    ).toBe(true);
  });

  it("disables when env URL is empty string", () => {
    expect(shouldRunPresence(HOSTED_SPA_ORIGIN, "")).toBe(false);
    expect(resolvePresenceUrl("")).toBeNull();
  });

  it("defaults production URL on hosted origin", () => {
    vi.stubGlobal("location", { origin: HOSTED_SPA_ORIGIN });
    expect(resolvePresenceUrl(null)).toBe(DEFAULT_PRESENCE_URL);
  });

  it("POSTs heartbeat and returns stats", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ active: 2, total: 9, window_sec: 300 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const stats = await heartbeatPresence(
      "11111111-1111-4111-8111-111111111111",
      "https://example.test/count",
      fetchImpl,
    );
    expect(stats).toEqual({ active: 2, total: 9, window_sec: 300 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    const parsed = JSON.parse(String(init.body));
    expect(Object.keys(parsed)).toEqual(["client_id"]);
  });

  it("returns null on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const stats = await heartbeatPresence(
      "11111111-1111-4111-8111-111111111111",
      "https://example.test/count",
      fetchImpl,
    );
    expect(stats).toBeNull();
  });

  it("startPresenceLoop is a no-op when disabled", () => {
    const onStats = vi.fn();
    const stop = startPresenceLoop({ run: false, onStats });
    expect(onStats).toHaveBeenCalledWith(null);
    stop();
  });

  it("formats compact counts", () => {
    expect(formatPresenceCount(12)).toBe("12");
    expect(formatPresenceCount(1284)).toBe("1.3k");
    expect(formatPresenceCount(12_000)).toBe("12k");
  });
});
