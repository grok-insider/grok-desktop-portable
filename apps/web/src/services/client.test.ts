import { DraftStore, privateDraftScope } from "./drafts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  PROTOCOL_VERSION,
  SESSION_HEADER,
  WS_SESSION_PROTOCOL_PREFIX,
  WS_SUBPROTOCOL,
} from "./protocol";
import {
  LightClient,
  pairingChangedInStorage,
  BRIDGE_PORT_KEY,
  BRIDGE_SESSION_KEY,
  PRIVATE_SESSION_KEY,
  readStoredPort,
  readStoredSession,
  takePairingNonce,
  writeStoredSession,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("pairing storage events", () => {
  const grant = {port: 20001, sessionToken: "token", csrfToken: "csrf", savedAtMs: 1};
  it.each([false, true])("ignores timestamp refreshes and notices changed authority (private: %s)", (privateOrigin) => {
    const key = privateOrigin ? PRIVATE_SESSION_KEY : BRIDGE_SESSION_KEY;
    const oldValue = JSON.stringify(grant);
    expect(pairingChangedInStorage({key, oldValue, newValue: JSON.stringify({...grant, savedAtMs: 2})}, privateOrigin)).toBe(false);
    expect(pairingChangedInStorage({key, oldValue, newValue: JSON.stringify({...grant, csrfToken: "replacement"})}, privateOrigin)).toBe(false);
    expect(pairingChangedInStorage({key, oldValue, newValue: JSON.stringify({...grant, sessionToken: "replacement"})}, privateOrigin)).toBe(true);
    expect(pairingChangedInStorage({key, oldValue, newValue: JSON.stringify({...grant, port: 20002})}, privateOrigin)).toBe(!privateOrigin);
    expect(pairingChangedInStorage({key, oldValue, newValue: null}, privateOrigin)).toBe(true);
    expect(pairingChangedInStorage({key, oldValue: null, newValue: oldValue}, privateOrigin)).toBe(true);
    expect(pairingChangedInStorage({key, oldValue, newValue: "malformed"}, privateOrigin)).toBe(true);
  });
  it("reacts to local port discovery and storage clearing, keeping private origins independent", () => {
    const event = {key: BRIDGE_PORT_KEY, oldValue: "20001", newValue: "20002"};
    expect(pairingChangedInStorage(event, false)).toBe(true);
    expect(pairingChangedInStorage({...event, newValue: event.oldValue}, false)).toBe(false);
    expect(pairingChangedInStorage(event, true)).toBe(false);
    expect(pairingChangedInStorage({...event, key: "unrelated"}, false)).toBe(false);
    expect(pairingChangedInStorage({key: null, oldValue: null, newValue: null}, true)).toBe(true);
  });
});

describe("LightClient", () => {
  it("adopts another tab's rotated CSRF without another session request", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(jsonResponse({sessionId: "browser", sessionToken: "token", csrfToken: "initial", protocolVersion: PROTOCOL_VERSION})).mockResolvedValueOnce(jsonResponse({result: {outcome: "ok"}}));
    vi.stubGlobal("fetch", fetchSpy);
    const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
    await client.pair("a".repeat(64));
    writeStoredSession({port: 20001, sessionToken: "token", csrfToken: "rotated", savedAtMs: Date.now()});
    expect(client.restoreFromStorage()).toBe(true);
    await client.send({kind: "listWorkspaces"});
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:20001/pair", "http://127.0.0.1:20001/command"]);
    expect(fetchSpy.mock.calls[1][1].headers[CSRF_HEADER]).toBe("rotated");
    localStorage.clear();
    sessionStorage.clear();
  });

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
  it("serializes recovery across tabs and reads the grant refreshed by the lock holder", async () => {
    let tail = Promise.resolve();
    const request = vi.fn((_name: string, _options: unknown, run: () => Promise<unknown>) => {
      const pending = tail.then(run);
      tail = pending.then(() => {});
      return pending;
    });
    vi.stubGlobal("navigator", {locks: {request}});
    writeStoredSession({port: 20001, sessionToken: "session", csrfToken: "stale", savedAtMs: Date.now()});
    let csrf = "current";
    let rotations = 0;
    let release: (() => void) | undefined;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (url.endsWith("/session")) {
        if (headers[CSRF_HEADER] !== csrf) csrf = `rotated-${++rotations}`;
        const response = jsonResponse({sessionId: "browser", sessionToken: "session", csrfToken: csrf, protocolVersion: PROTOCOL_VERSION});
        if (fetch.mock.calls.length === 1) await new Promise<void>(resolve => {release = resolve;});
        return response;
      }
      return headers[CSRF_HEADER] === csrf ? jsonResponse({result: {outcome: "ok"}}) : new Response(null, {status: 403});
    });
    vi.stubGlobal("fetch", fetch);
    const first = new LightClient();
    const second = new LightClient();
    const a = first.resume();
    const b = second.resume();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(fetch).toHaveBeenCalledOnce();
    release!();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(rotations).toBe(1);
    expect(request.mock.calls.map(([name]) => name)).toEqual([`${BRIDGE_SESSION_KEY}:resume`, `${BRIDGE_SESSION_KEY}:resume`]);
    expect((await first.send({kind: "listWorkspaces"})).ok).toBe(true);
    expect((await second.send({kind: "listWorkspaces"})).ok).toBe(true);
  });

  it("keeps the grant when acquiring the cross-tab recovery lock fails", async () => {
    const grant = {port: 20001, sessionToken: "session", csrfToken: "csrf", savedAtMs: Date.now()};
    writeStoredSession(grant);
    const request = vi.fn().mockRejectedValue(new DOMException("Timed out", "AbortError"));
    vi.stubGlobal("navigator", {locks: {request}});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new LightClient();
    expect(await client.resume()).toEqual({ok: false, failure: {kind: "unreachable"}});
    expect(client.paired).toBe(true);
    expect(readStoredSession()).toEqual(grant);
    expect(fetch).not.toHaveBeenCalled();
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a replacement grant only at its own loopback port", async () => {
    const original = {port: 20001, sessionToken: "first", csrfToken: "first-csrf", savedAtMs: Date.now()};
    const replacement = {...original, port: 20002, sessionToken: "second", csrfToken: "second-csrf"};
    writeStoredSession(original);
    const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
    client.restoreFromStorage();
    writeStoredSession(replacement);
    client.restoreFromStorage();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({sessionId: "second-browser", ...replacement, protocolVersion: PROTOCOL_VERSION}));
    vi.stubGlobal("fetch", fetch);
    expect((await client.resume()).ok).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:20002/session");
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({[SESSION_HEADER]: "second"});
  });

  it.each([200, 403])("discards an old authority's delayed resume response (%s)", async status => {
    const original = {port: 20001, sessionToken: "first", csrfToken: "first-csrf", savedAtMs: Date.now()};
    const replacement = {...original, port: 20002, sessionToken: "second", csrfToken: "second-csrf"};
    writeStoredSession(original);
    let deliver: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {deliver = resolve;})));
    const client = new LightClient();
    const pending = client.resume();
    await vi.waitFor(() => expect(deliver).toBeDefined());
    writeStoredSession(replacement);
    client.restoreFromStorage();
    deliver!(jsonResponse({sessionId: "old-browser", ...original, protocolVersion: PROTOCOL_VERSION}, status));
    expect(await pending).toEqual({ok: false, failure: {kind: "unreachable"}});
    expect(readStoredSession()).toEqual(replacement);
    expect(client.bridgeBaseUrl).toBe("http://127.0.0.1:20002");
    expect(client.paired).toBe(true);
  });

  it("does not resurrect a cleared pairing when its resume finishes", async () => {
    let deliver: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {deliver = resolve;})));
    const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
    const pending = client.resume();
    await vi.waitFor(() => expect(deliver).toBeDefined());
    client.clearPairing();
    deliver!(jsonResponse({sessionId: "old", sessionToken: "old", csrfToken: "old", protocolVersion: PROTOCOL_VERSION}));
    expect(await pending).toEqual({ok: false, failure: {kind: "unreachable"}});
    expect(client.paired).toBe(false);
    expect(readStoredSession()).toBeNull();
  });

  it("preserves pending receipts on initial hydration and drops them on authority replacement", () => {
    sessionStorage.setItem(`${BRIDGE_SESSION_KEY}:pending`, '["pending-turn"]');
    writeStoredSession({port: 20001, sessionToken: "first", csrfToken: "csrf", savedAtMs: Date.now()});
    const client = new LightClient();
    client.restoreFromStorage();
    expect(JSON.parse(sessionStorage.getItem(`${BRIDGE_SESSION_KEY}:pending`)!)).toEqual(["pending-turn"]);
    writeStoredSession({port: 20002, sessionToken: "second", csrfToken: "csrf", savedAtMs: Date.now()});
    client.restoreFromStorage();
    expect(JSON.parse(sessionStorage.getItem(`${BRIDGE_SESSION_KEY}:pending`)!)).toEqual([]);
  });

  it("does not turn an old command's 403 into a rejection of the replacement pairing", async () => {
    const original = {port: 20001, sessionToken: "first", csrfToken: "csrf", savedAtMs: Date.now()};
    const replacement = {...original, port: 20002, sessionToken: "second"};
    writeStoredSession(original);
    const client = new LightClient();
    client.restoreFromStorage();
    let deliver: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {deliver = resolve;})));
    const pending = client.send({kind: "listWorkspaces"});
    writeStoredSession(replacement);
    client.restoreFromStorage();
    deliver!(new Response(null, {status: 403}));
    expect(await pending).toEqual({ok: false, failure: {kind: "unreachable"}});
    expect(readStoredSession()).toEqual(replacement);
    expect(client.paired).toBe(true);
  });

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

  it("restores a stored grant and resumes without re-pairing", async () => {
    localStorage.clear();
    sessionStorage.clear();
    writeStoredSession({
      port: 20001,
      sessionToken: "stored-sess",
      csrfToken: "stored-csrf",
      savedAtMs: Date.now(),
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: "bs-1",
          sessionToken: "stored-sess",
          csrfToken: "stored-csrf",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const client = new LightClient({ bridgeBaseUrl: "" });
    expect(client.restoreFromStorage()).toBe(true);
    expect(client.paired).toBe(true);
    expect(client.bridgeBaseUrl).toBe("http://127.0.0.1:20001");

    const result = await client.resume();
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:20001/session");
    expect((init.headers as Record<string, string>)[SESSION_HEADER]).toBe("stored-sess");
  });

  it("clearPairing drops the grant but can keep the port", () => {
    localStorage.clear();
    sessionStorage.clear();
    writeStoredSession({
      port: 20001,
      sessionToken: "s",
      csrfToken: "c",
      savedAtMs: Date.now(),
    });
    const client = new LightClient({ bridgeBaseUrl: "http://127.0.0.1:20001" });
    client.restoreFromStorage();
    expect(client.paired).toBe(true);
    client.clearPairing();
    expect(client.paired).toBe(false);
    expect(readStoredSession()).toBeNull();
    expect(readStoredPort()).toBe(20001);
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

it.each([false, true])("coalesces strict-effect pairing and resume with an older stored grant %s", async (stored) => {
  let deliver: ((response: Response) => void) | undefined;
  const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => {deliver = resolve;}));
  vi.stubGlobal("fetch", fetchSpy);
  if (stored) writeStoredSession({port: 20001, sessionToken: "old", csrfToken: "old-csrf", savedAtMs: Date.now()});
  const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
  client.setBridgeBaseUrl("http://127.0.0.1:20002");
  const first = client.pair("a".repeat(64));
  expect(client.restoreFromStorage()).toBe(false);
  const second = client.resume();
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:20002/pair", expect.objectContaining({method: "POST"}));
  deliver?.(jsonResponse({sessionId: "s", sessionToken: "token", csrfToken: "csrf", protocolVersion: PROTOCOL_VERSION}));
  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(client.paired).toBe(true);
});

it.each(["resume", "pair"])("keeps the new pairing when an earlier %s completes late", async (operation) => {
  const deliveries: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((resolve) => {deliveries.push(resolve);}));
  vi.stubGlobal("fetch", fetch);
  const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
  const previous = operation === "resume" ? client.resume() : client.pair("a".repeat(64));
  await vi.waitFor(() => expect(deliveries).toHaveLength(1));
  const current = client.pair("b".repeat(64));
  expect(deliveries).toHaveLength(2);
  deliveries[1]!(jsonResponse({sessionId: "new", sessionToken: "new-token", csrfToken: "new-csrf", protocolVersion: PROTOCOL_VERSION}));
  expect((await current).ok).toBe(true);
  deliveries[0]!(jsonResponse({sessionId: "old", sessionToken: "old-token", csrfToken: "old-csrf", protocolVersion: PROTOCOL_VERSION}));
  expect(await previous).toEqual({ok: false, failure: {kind: "unreachable"}});
  expect(client.paired).toBe(true);
  expect(readStoredSession()?.sessionToken).toBe("new-token");
});

it.each(["disposed", "cleared", "replaced", "response body"])("does not restore obsolete pairing credentials after authority is %s", async change => {
  let deliver: ((response: Response) => void) | undefined;
  let finishBody: ((body: unknown) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => {deliver = resolve;})));
  const client = new LightClient({bridgeBaseUrl: "http://127.0.0.1:20001"});
  const pending = client.pair("a".repeat(64));
  const obsolete = {sessionId: "old", sessionToken: "old-token", csrfToken: "old-csrf", protocolVersion: PROTOCOL_VERSION};
  if (change === "response body") {
    const response = jsonResponse(obsolete);
    response.json = () => new Promise(resolve => {finishBody = resolve;});
    deliver!(response);
    await vi.waitFor(() => expect(finishBody).toBeDefined());
  }
  if (change === "disposed" || change === "response body") client.dispose();
  if (change === "cleared") client.clearPairing();
  const replacement = {port: 20002, sessionToken: "new-token", csrfToken: "new-csrf", savedAtMs: Date.now()};
  if (change !== "cleared") writeStoredSession(replacement);
  if (change === "response body") finishBody!(obsolete);
  else deliver!(jsonResponse(obsolete));
  expect(await pending).toEqual({ok: false, failure: {kind: "unreachable"}});
  expect(client.paired).toBe(false);
  expect(readStoredSession()).toEqual(change === "cleared" ? null : replacement);
});


it("uses authenticated private installation and pairing identities and deletes replaced scopes", async () => {
  vi.stubGlobal("location", {origin: "https://station.example", hostname: "station.example"});
  let pairingId = "first-pairing";
  const network = vi.fn(async () => jsonResponse({sessionId: pairingId, installationId: "install", sessionToken: "token", csrfToken: "csrf", protocolVersion: PROTOCOL_VERSION}));
  vi.stubGlobal("fetch", network);
  const client = new LightClient({bridgeBaseUrl: "", storageKey: PRIVATE_SESSION_KEY});
  expect(client.draftScope).toBeUndefined();
  await client.resume();
  const firstScope = privateDraftScope("https://station.example", "install", "first-pairing")!;
  expect(client.draftScope).toBe(firstScope);
  const store = new DraftStore(firstScope);
  await store.enable(); await store.write("conversation", "old pairing text");
  pairingId = "replacement-pairing";
  const replacement = new LightClient({bridgeBaseUrl: "", storageKey: PRIVATE_SESSION_KEY});
  await replacement.pair("new-nonce");
  expect(replacement.draftScope).not.toBe(firstScope);
  expect(await store.read()).toEqual({});
  expect(await store.enabled()).toBe(false);
});
