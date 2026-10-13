import { afterEach, expect, it, vi } from "vitest";
import { LightClient, PRIVATE_SESSION_KEY, takePairingFragment, writeStoredSession } from "./client";

afterEach(() => {vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear();});

it("pairs and resumes at the private HTTPS origin despite fragment and remembered loopback ports", async () => {
  localStorage.clear();
  sessionStorage.clear();
  writeStoredSession({port: 29999, sessionToken: "old-loopback-token", csrfToken: "old-loopback-csrf", savedAtMs: Date.now()});
  const nonce = "a".repeat(64);
  vi.stubGlobal("location", {origin: "https://station.example.ts.net", hostname: "station.example.ts.net", pathname: "/", search: "", hash: `#pair=${nonce}&p=20001`});
  const fragment = takePairingFragment();
  expect(fragment?.nonce).toBe(nonce);
  const fetch = vi.fn(async (_path: string) => Response.json({sessionId: "private", sessionToken: "private-token", csrfToken: "private-csrf", protocolVersion: 2}));
  vi.stubGlobal("fetch", fetch);
  const client = new LightClient();
  expect(client.bridgeBaseUrl).toBe("");
  expect(client.restoreFromStorage()).toBe(false);
  expect((await client.pair(fragment!.nonce)).ok).toBe(true);
  expect(fetch.mock.calls[0]?.[0]).toBe("/pair");
  const resumed = new LightClient();
  expect(resumed.restoreFromStorage()).toBe(true);
  expect(resumed.bridgeBaseUrl).toBe("");
  expect((await resumed.resume()).ok).toBe(true);
  expect(fetch.mock.calls[1]?.[0]).toBe("/session");
  const sockets: string[] = [];
  class PrivateWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor(url: string) {sockets.push(url);}
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", PrivateWebSocket);
  resumed.openEvents({onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()})?.close();
  expect(sockets).toEqual(["wss://station.example.ts.net/events?protocolVersion=4"]);
});

it("keeps controller credentials in their websocket and never gives them to an observer", async () => {
  vi.stubGlobal("location", {origin: "https://station.example.ts.net", hostname: "station.example.ts.net"});
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => Response.json(path === "/command" ? {result: {outcome: "ok"}} : {sessionId: "browser", sessionToken: "paired", csrfToken: "csrf", protocolVersion: 2}));
  vi.stubGlobal("fetch", fetch);
  const sockets: PrivateWebSocket[] = [];
  class PrivateWebSocket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map<string, (event: {data: string}) => void>();
    constructor(_url: string) {sockets.push(this);}
    addEventListener(name: string, listener: (event: {data: string}) => void) {this.listeners.set(name, listener);}
    status(state: string, controllerToken?: string) {this.listeners.get("message")?.({data: JSON.stringify({protocolVersion: 2, eventSequence: 0, event: {kind: "hostStatus", state, ...(controllerToken ? {controllerToken} : {})}})});}
    close() {this.listeners.get("close")?.({data: ""});}
  }
  vi.stubGlobal("WebSocket", PrivateWebSocket);
  const owner = new LightClient();
  await owner.pair("a".repeat(64));
  const observer = new LightClient();
  await observer.resume();
  const handlers = {onEvent: vi.fn(), onOpen: vi.fn(), onClose: vi.fn()};
  const first = owner.openEvents(handlers);
  const watching = observer.openEvents(handlers);
  const controllerToken = "b".repeat(64);
  sockets[0].status("controlling:1", controllerToken);
  sockets[1].status("watching");
  await owner.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({"x-grok-light-controller": controllerToken});
  await observer.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("x-grok-light-controller");
  expect(localStorage.getItem(PRIVATE_SESSION_KEY)).not.toContain(controllerToken);
  expect(JSON.stringify(Object.values(sessionStorage))).not.toContain(controllerToken);
  sockets[0].status("agent_restarting");
  sockets[0].status("agent_ready");
  await owner.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({"x-grok-light-controller": controllerToken});
  sockets[0].status("watching");
  await owner.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("x-grok-light-controller");
  const second = owner.openEvents(handlers);
  const nextToken = "c".repeat(64);
  sockets[2].status("controlling:2", nextToken);
  sockets[0].status("watching");
  sockets[0].close();
  first?.close();
  await owner.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).toMatchObject({"x-grok-light-controller": nextToken});
  expect(owner.controllerEpoch).toBe(2);
  second?.close();
  await owner.send({kind: "cancelTurn", sessionId: "s"});
  expect(fetch.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("x-grok-light-controller");
  watching?.close();
});

it("keeps every tab usable after cookie recovery when storage and browser locks are unavailable", async () => {
  vi.stubGlobal("location", {origin: "https://station.example.ts.net", hostname: "station.example.ts.net"});
  vi.stubGlobal("navigator", {});
  const unavailable = () => {throw new DOMException("Storage blocked", "SecurityError");};
  vi.stubGlobal("localStorage", {getItem: unavailable, setItem: unavailable, removeItem: unavailable});
  vi.stubGlobal("sessionStorage", {getItem: unavailable, setItem: unavailable, removeItem: unavailable});
  const original = "a".repeat(64);
  const recovered = "b".repeat(64);
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/command") {
      const csrf = new Headers(init?.headers).get("x-grok-light-csrf");
      return csrf === original || csrf === recovered
        ? Response.json({result: {outcome: "ok"}}, {status: 202})
        : new Response(null, {status: 403});
    }
    return Response.json({sessionId: "browser", sessionToken: "paired", csrfToken: path === "/pair" ? original : recovered, protocolVersion: 2});
  });
  vi.stubGlobal("fetch", fetch);
  const owner = new LightClient();
  expect((await owner.pair("c".repeat(64))).ok).toBe(true);
  const first = new LightClient();
  const second = new LightClient();
  expect(first.restoreFromStorage()).toBe(false);
  expect(second.restoreFromStorage()).toBe(false);
  expect((await Promise.all([first.resume(), second.resume()])).every(result => result.ok)).toBe(true);
  for (const client of [owner, first, second]) {
    expect((await client.send({kind: "bootstrap"})).ok).toBe(true);
    client.dispose();
  }
});
