import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(share = false) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fetch = vi.fn(async () => new Response("network"));
  const entries = new Map<string, Response>([["https://remote.fabrials.com/index.html", new Response("shell")], ["https://remote.fabrials.com/assets/app-123.js", new Response("shell")]]);
  const cache = {addAll: vi.fn(), put: vi.fn(async (url: string, response: Response) => {entries.set(url, response.clone());}), match: vi.fn(async (url: string | {url: string}) => entries.get(typeof url === "string" ? url : url.url)?.clone())};
  const shareInbox = {parseSharedRequest: vi.fn(async () => ({text: "shared"})), enqueueSharedContent: vi.fn(async () => "11111111-1111-4111-8111-111111111111")};
  const source = readFileSync("scripts/service-worker.js", "utf8").replace("__SHELL__", JSON.stringify(["index.html", "assets/app-123.js", "manifest.webmanifest"])).replace("__CACHE__", '"grok-shell-test"').replace("__SHARE_TARGET__", share ? "enabled" : "disabled").replace("const shareInboxApi = null;", "const shareInboxApi = shareInbox;");
  runInNewContext(source, {self: {registration: {scope: "https://remote.fabrials.com/"}, location: {origin: "https://remote.fabrials.com"}, addEventListener: (name: string, callback: (event: unknown) => void) => {listeners[name] = callback;}}, URL, Response, Error, fetch, shareInbox, caches: {open: async () => cache, match: cache.match}});
  return {listeners, fetch, cache, shareInbox};
}

describe("PWA shell cache", () => {
  it.each(["offline", "unhealthy"])("shows the static shell when navigation cannot reach a healthy host (%s)", async (failure) => {
    const {listeners, fetch, cache} = worker();
    if (failure === "offline") fetch.mockRejectedValueOnce(new Error("offline"));
    else fetch.mockResolvedValueOnce(new Response("Proxy unavailable", {status: 503}));
    const respondWith = vi.fn();
    listeners.fetch({request: {url: "https://remote.fabrials.com/s/session", method: "GET", mode: "navigate"}, respondWith});
    expect(await (await respondWith.mock.calls[0][0]).text()).toBe("shell");
    expect(cache.match).toHaveBeenCalledWith("https://remote.fabrials.com/index.html");
    expect(cache.addAll).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never intercepts conversation, auth, API, external requests or mutations", () => {
    const {listeners} = worker();
    for (const [path, method, mode] of [["/session", "GET", "cors"], ["/command", "POST", "cors"], ["/api/spanreed/remote/hosts", "GET", "cors"], ["/assets/private.json", "GET", "cors"], ["/index.html?sessionToken=secret", "GET", "navigate"], ["https://fabrials.com/api/private", "GET", "cors"]]) {
      const respondWith = vi.fn();
      listeners.fetch({request: {url: new URL(path, "https://remote.fabrials.com").href, method, mode}, respondWith});
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
  it("serves only its build's exact static assets from the shell cache", async () => {
    const {listeners, fetch, cache} = worker();
    const respondWith = vi.fn();
    listeners.fetch({request: {url: "https://remote.fabrials.com/assets/app-123.js", method: "GET", mode: "cors"}, respondWith});
    expect(await (await respondWith.mock.calls[0][0]).text()).toBe("shell");
    expect(cache.match).toHaveBeenCalledWith({url: "https://remote.fabrials.com/assets/app-123.js", method: "GET", mode: "cors"});
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("experimental share target routing", () => {
  it("does not intercept share POST in ordinary workers", () => {
    const {listeners, shareInbox} = worker();
    const respondWith = vi.fn();
    listeners.fetch({request: {url: "https://remote.fabrials.com/share-inbox", method: "POST"}, respondWith});
    expect(respondWith).not.toHaveBeenCalled();
    expect(shareInbox.parseSharedRequest).not.toHaveBeenCalled();
  });
  it("stores a bounded intent and redirects with only an opaque reference", async () => {
    const {listeners, shareInbox, cache} = worker(true);
    const respondWith = vi.fn();
    listeners.fetch({request: {url: "https://remote.fabrials.com/share-inbox", method: "POST"}, respondWith});
    const response = await respondWith.mock.calls[0][0] as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://remote.fabrials.com/#share=11111111-1111-4111-8111-111111111111");
    expect(shareInbox.enqueueSharedContent).toHaveBeenCalledWith({text: "shared"});
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.addAll).not.toHaveBeenCalled();
  });
  it("rejects an over-limit body without enqueuing content", async () => {
    const {listeners, shareInbox} = worker(true);
    shareInbox.parseSharedRequest.mockRejectedValueOnce(new Error("share_too_large"));
    const respondWith = vi.fn();
    listeners.fetch({request: {url: "https://remote.fabrials.com/share-inbox", method: "POST"}, respondWith});
    const response = await respondWith.mock.calls[0][0] as Response;
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(shareInbox.enqueueSharedContent).not.toHaveBeenCalled();
  });
  it("does not intercept another origin or a token-bearing query", () => {
    const {listeners} = worker(true);
    for (const url of ["https://example.com/share-inbox", "https://remote.fabrials.com/share-inbox?secret=x"]) {
      const respondWith = vi.fn();
      listeners.fetch({request: {url, method: "POST"}, respondWith});
      expect(respondWith).not.toHaveBeenCalled();
    }
  });
});

describe("shell updates and rollback", () => {
  function versionedWorker(version: string, values = new Map<string, Map<string, Response>>()) {
    const scope = "https://remote.fabrials.com/";
    const listeners: Record<string, (event: any) => void> = {};
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const store = (name: string) => {
      if (!values.has(name)) values.set(name, new Map());
      const entries = values.get(name)!;
      return {
        async addAll(urls: string[]) {for (const url of urls) entries.set(url, new Response(`${version}:${url}`));},
        async put(url: string, response: Response) {entries.set(url, response.clone());},
        async match(value: string | {url: string}) {return entries.get(typeof value === "string" ? value : value.url)?.clone();},
      };
    };
    const source = readFileSync("scripts/service-worker.js", "utf8").replace("__SHELL__", JSON.stringify(["index.html", `assets/app-${version}.js`])).replace("__CACHE__", JSON.stringify(`grok-shell-${version}`)).replace("__SHARE_TARGET__", "disabled");
    const skipWaiting = vi.fn();
    runInNewContext(source, {self: {registration: {scope}, location: {origin: new URL(scope).origin}, skipWaiting, addEventListener: (name: string, listener: (event: any) => void) => {listeners[name] = listener;}}, fetch, URL, Response, Error, caches: {open: async (name: string) => store(name), keys: async () => [...values.keys()], delete: async (name: string) => values.delete(name)}});
    const run = async (name: string, extras: object = {}) => {
      let pending: Promise<unknown> = Promise.resolve();
      listeners[name]({...extras, waitUntil: (promise: Promise<unknown>) => {pending = promise;}});
      await pending;
    };
    const navigate = async (path = "/s/test", mode = "navigate") => {
      let response: Promise<Response> | undefined;
      listeners.fetch({request: {url: new URL(path, scope).href, method: "GET", mode}, respondWith: (value: Promise<Response>) => {response = value;}});
      return response;
    };
    return {values, listeners, run, navigate, fetch, skipWaiting};
  }

  it("returns a complete cached deep-link shell immediately when the network blackholes", async () => {
    const worker = versionedWorker("a");
    await worker.run("install");
    await worker.run("activate");
    expect(await (await worker.navigate())?.text()).toBe("a:https://remote.fabrials.com/index.html");
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(worker.skipWaiting).not.toHaveBeenCalled();
  });

  it("retains exactly the previous build and rolls its whole asset graph back without network", async () => {
    const a = versionedWorker("a");
    await a.run("install"); await a.run("activate");
    const b = versionedWorker("b", a.values);
    await b.run("install"); await b.run("activate");
    const c = versionedWorker("c", a.values);
    await c.run("install"); await c.run("activate");
    expect([...a.values.keys()].filter(key => key.startsWith("grok-shell-"))).toEqual(["grok-shell-b", "grok-shell-c"]);
    const postMessage = vi.fn();
    await c.run("message", {data: {kind: "shellStatus"}, ports: [{postMessage}]});
    expect(postMessage).toHaveBeenLastCalledWith({canRollback: true});
    await c.run("message", {data: {kind: "rollbackShell"}, ports: [{postMessage}]});
    expect(postMessage).toHaveBeenLastCalledWith({ok: true});
    expect(await (await c.navigate())?.text()).toBe("b:https://remote.fabrials.com/index.html");
    expect(await (await c.navigate("/assets/app-b.js", "cors"))?.text()).toBe("b:https://remote.fabrials.com/assets/app-b.js");
    expect(c.fetch).not.toHaveBeenCalled();
    const restarted = versionedWorker("c", a.values);
    expect(await (await restarted.navigate())?.text()).toBe("b:https://remote.fabrials.com/index.html");
  });
});
