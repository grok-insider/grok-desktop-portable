import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteAccount, takeRemotePairing } from "./remoteAccount";

afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {resolve = done;});
  return {promise, resolve};
}

describe("remote account and pairing boundaries", () => {
  it("consumes the pairing secret from the fragment before any account request", async () => {
    const pairing = {hostId: "host-1", secret: "a".repeat(64), hostPublicKey: "b".repeat(64)};
    history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
    expect(takeRemotePairing()).toEqual(pairing);
    expect(location.hash).toBe("");
    const fetch = vi.fn(async (url, init) => {
      expect(location.hash).toBe("");
      expect(String(url)).not.toContain(pairing.secret);
      expect(init.body).toBeUndefined();
      return Response.json({hosts: []});
    });
    vi.stubGlobal("fetch", fetch);
    await remoteAccount("/hosts");
    expect(fetch).toHaveBeenCalledWith("https://fabrials.com/api/spanreed/remote/hosts", expect.objectContaining({credentials: "include", cache: "no-store"}));
  });

  it("clears an invalid pairing fragment without treating it as authorization", () => {
    history.replaceState(null, "", "/#remotePair=invalid");
    expect(takeRemotePairing()).toBeNull();
    expect(location.hash).toBe("");
  });

  it.each([
    ["active_host_limit", "Revoke an unused computer"],
    ["host_history_full", "Contact Fabrials support"],
    ["active_share_limit", "Withdraw an existing link"],
    ["share_history_full", "Contact Fabrials support"],
    ["outstanding_ticket_limit", "Wait a minute"],
  ])("explains recovery for %s without retrying the account operation", async (code, text) => {
    const fetch = vi.fn(async () => Response.json({error: code}, {status: 429}));
    vi.stubGlobal("fetch", fetch);
    await expect(remoteAccount("/shares", {method: "POST"})).rejects.toThrow(text);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>upstream failure</html>", JSON.stringify({error: "untrusted service text"}), JSON.stringify({error: "constructor"})])("uses safe fallback copy for unknown or non-JSON errors", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {status: 429})));
    await expect(remoteAccount("/shares")).rejects.toThrow("The account service is unavailable. Try again.");
  });
});

describe("account cookie rotation concurrency", () => {
  it("serializes concurrent panels without Web Locks through response decoding", async () => {
    vi.stubGlobal("navigator", {});
    const body = deferred<{hosts: never[]}>();
    let rotated = false;
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return {ok: true, json: () => body.promise.then((value) => {rotated = true; return value;})};
      return rotated ? Response.json({shares: []}) : Response.json({error: "unauthorized"}, {status: 401});
    });
    vi.stubGlobal("fetch", fetch);
    const hosts = remoteAccount("/hosts");
    const shares = remoteAccount("/shares");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    body.resolve({hosts: []});
    await expect(hosts).resolves.toEqual({hosts: []});
    await expect(shares).resolves.toEqual({shares: []});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses one exclusive Web Lock across independently loaded clients", async () => {
    let queue: Promise<unknown> = Promise.resolve();
    const request = vi.fn((_name: string, _options: LockOptions, run: () => Promise<unknown>) => {
      const attempt = queue.then(run);
      queue = attempt.catch(() => undefined);
      return attempt;
    });
    vi.stubGlobal("navigator", {locks: {request}});
    vi.resetModules();
    const {remoteAccount: otherTab} = await import("./remoteAccount");
    const body = deferred<{hosts: never[]}>();
    let rotated = false;
    const fetch = vi.fn(async () => {
      if (fetch.mock.calls.length === 1) return {ok: true, json: () => body.promise.then((value) => {rotated = true; return value;})};
      return rotated ? Response.json({shares: []}) : Response.json({error: "unauthorized"}, {status: 401});
    });
    vi.stubGlobal("fetch", fetch);
    const hosts = remoteAccount("/hosts");
    const shares = otherTab("/shares");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    body.resolve({hosts: []});
    await expect(Promise.all([hosts, shares])).resolves.toEqual([{hosts: []}, {shares: []}]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [name, options] of request.mock.calls) {
      expect(name).toBe("grok-remote-account:https://fabrials.com");
      expect(options.mode).toBe("exclusive");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("releases the fallback queue after a rejected operation without replaying it", async () => {
    vi.stubGlobal("navigator", {});
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(Response.json({hosts: []}));
    vi.stubGlobal("fetch", fetch);
    const failed = expect(remoteAccount("/shares", {method: "DELETE"})).rejects.toThrow("offline");
    const next = remoteAccount("/hosts");
    await failed;
    await expect(next).resolves.toEqual({hosts: []});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued call immediately without issuing it after the lock clears", async () => {
    vi.stubGlobal("navigator", {});
    const first = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({shares: []}));
    vi.stubGlobal("fetch", fetch);
    const hosts = remoteAccount("/hosts");
    const controller = new AbortController();
    const cancelled = expect(remoteAccount("/shares", {method: "DELETE", signal: controller.signal})).rejects.toMatchObject({name: "AbortError"});
    const shares = remoteAccount("/shares");
    controller.abort();
    await cancelled;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    first.resolve(Response.json({hosts: []}));
    await expect(hosts).resolves.toEqual({hosts: []});
    await expect(shares).resolves.toEqual({shares: []});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init.method !== "DELETE")).toBe(true);
  });

  it("aborts a hung request at its deadline so the next queued call can proceed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {});
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      if (fetch.mock.calls.length > 1) return Promise.resolve(Response.json({shares: []}));
      return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {once: true}));
    });
    vi.stubGlobal("fetch", fetch);
    const failed = expect(remoteAccount("/hosts")).rejects.toMatchObject({name: "TimeoutError"});
    await vi.advanceTimersByTimeAsync(29_000);
    const next = remoteAccount("/shares");
    await vi.advanceTimersByTimeAsync(1_000);
    await failed;
    await expect(next).resolves.toEqual({shares: []});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out waiting for another tab without bypassing the Web Lock", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_name: string, options: LockOptions) => new Promise<never>((_, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {once: true})));
    vi.stubGlobal("navigator", {locks: {request}});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const failed = expect(remoteAccount("/hosts")).rejects.toMatchObject({name: "TimeoutError"});
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
