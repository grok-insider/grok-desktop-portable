import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  PROTOCOL_VERSION,
  WS_SESSION_PROTOCOL_PREFIX,
  WS_SUBPROTOCOL,
} from "./protocol";
import { LightClient, takePairingNonce } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LightClient", () => {
  it("refuses to send a command before pairing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await new LightClient().send({ kind: "bootstrap" });
    expect(result).toEqual({ ok: false, failure: { kind: "not_paired" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attaches the csrf token to every command after pairing", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: "bs-1",
          sessionToken: "sess",
          csrfToken: "csrf-value",
          protocolVersion: PROTOCOL_VERSION,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ accepted: "Bootstrap" }, 202));
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient();
    expect(client.paired).toBe(false);
    await client.pair("a".repeat(64));
    expect(client.paired).toBe(true);

    await client.send({ kind: "bootstrap" });
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe("csrf-value");
    expect(init.credentials).toBe("include");
  });

  it("refuses a host that speaks a different protocol version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ sessionId: "bs-1", csrfToken: "c", sessionToken: "sess", protocolVersion: 3 }),
      ),
    );

    const client = new LightClient();
    const result = await client.pair("a".repeat(64));
    expect(result).toEqual({
      ok: false,
      failure: { kind: "protocol_mismatch", hostVersion: 3 },
    });
    expect(client.paired).toBe(false);
  });

  it("reports a refused pairing rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const result = await new LightClient().pair("a".repeat(64));
    expect(result).toEqual({ ok: false, failure: { kind: "rejected" } });
  });

  it("reports an unreachable host rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));
    const result = await new LightClient().pair("a".repeat(64));
    expect(result).toEqual({ ok: false, failure: { kind: "unreachable" } });
  });

  it("maps a 403 on a command back to an unpaired state", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ sessionId: "bs-1", csrfToken: "c", sessionToken: "sess", protocolVersion: PROTOCOL_VERSION }),
      )
      .mockResolvedValueOnce(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient();
    await client.pair("a".repeat(64));
    const result = await client.send({ kind: "bootstrap" });
    expect(result).toEqual({ ok: false, failure: { kind: "not_paired" } });
  });

  it("carries the idempotency key a side-effecting command needs", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ sessionId: "bs-1", csrfToken: "c", sessionToken: "sess", protocolVersion: PROTOCOL_VERSION }),
      )
      .mockResolvedValueOnce(jsonResponse({}, 202));
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient();
    await client.pair("a".repeat(64));
    await client.send(
      { kind: "prompt", sessionId: "s-1", text: "hello" },
      { idempotencyKey: "key-1", controllerEpoch: 3 },
    );

    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.idempotencyKey).toBe("key-1");
    expect(body.controllerEpoch).toBe(3);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("only ever calls its own origin", async () => {
    // A fresh Response per call: a body can only be read once.
    const fetchSpy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            sessionId: "bs-1",
            sessionToken: "sess",
            csrfToken: "c",
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient();
    await client.pair("a".repeat(64));
    await client.send({ kind: "bootstrap" });

    for (const [url] of fetchSpy.mock.calls as [string][]) {
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });
});

describe("resume", () => {
  it("recovers the csrf token after a reload without re-pairing", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ sessionId: "bs-1", sessionToken: "sess", csrfToken: "fresh", protocolVersion: PROTOCOL_VERSION }),
      )
      .mockResolvedValueOnce(jsonResponse({}, 202));
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient();
    const result = await client.resume();
    expect(result.ok).toBe(true);
    expect(client.paired).toBe(true);

    await client.send({ kind: "bootstrap" });
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe("fresh");
  });

  it("reports an unpaired browser rather than failing loudly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    const result = await new LightClient().resume();
    expect(result).toEqual({ ok: false, failure: { kind: "not_paired" } });
  });

  it("does not call the public origin when the hosted SPA has no loopback port", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // jsdom location is http://localhost:3000 by default — force hosted origin.
    vi.stubGlobal("location", { ...location, origin: "https://desktop.grok.me" });

    const client = new LightClient({ bridgeBaseUrl: "" });
    const result = await client.resume();
    expect(result).toEqual({ ok: false, failure: { kind: "unreachable" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a session body that has CSRF but no session token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessionId: "bs-1",
          csrfToken: "only-csrf",
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    );
    const result = await new LightClient({ bridgeBaseUrl: "http://127.0.0.1:20001" }).resume();
    expect(result).toEqual({ ok: false, failure: { kind: "not_paired" } });
  });

  it("opens events with family protocol and gls.session token (no cookie path)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: "bs-1",
          csrfToken: "csrf",
          sessionToken: "a".repeat(64),
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const constructed: { url: string; protocols: string | string[] }[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      readyState = FakeWebSocket.OPEN;
      constructor(url: string, protocols?: string | string[]) {
        constructed.push({ url, protocols: protocols ?? [] });
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const client = new LightClient({ bridgeBaseUrl: "http://127.0.0.1:20001" });
    await client.pair("b".repeat(64));
    const socket = client.openEvents({
      onEvent: () => {},
      onOpen: () => {},
      onClose: () => {},
    });
    expect(socket).not.toBeNull();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.url).toBe("ws://127.0.0.1:20001/events");
    expect(constructed[0]?.protocols).toEqual([
      WS_SUBPROTOCOL,
      `${WS_SESSION_PROTOCOL_PREFIX}${"a".repeat(64)}`,
    ]);
  });

  it("refuses to open events before pairing", () => {
    const client = new LightClient({ bridgeBaseUrl: "http://127.0.0.1:20001" });
    expect(
      client.openEvents({ onEvent: () => {}, onOpen: () => {}, onClose: () => {} }),
    ).toBeNull();
  });
});

describe("takePairingNonce", () => {
  it("reads the nonce from the fragment and clears it", () => {
    const nonce = "b".repeat(64);
    window.history.replaceState(null, "", `/#pair=${nonce}`);

    expect(takePairingNonce()).toBe(nonce);
    // Cleared so it never reaches a bookmark.
    expect(window.location.hash).toBe("");
  });

  it("ignores a fragment that is not a well-formed nonce", () => {
    window.history.replaceState(null, "", "/#pair=short");
    expect(takePairingNonce()).toBeNull();
  });

  it("returns null when there is no fragment", () => {
    window.history.replaceState(null, "", "/");
    expect(takePairingNonce()).toBeNull();
  });
});
