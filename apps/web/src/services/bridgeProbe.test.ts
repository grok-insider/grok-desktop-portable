import { describe, expect, it, vi } from "vitest";
import { classifyProbeResult, probeBridge } from "./bridgeProbe";

describe("classifyProbeResult", () => {
  it("maps network failure to bridge_missing", () => {
    expect(
      classifyProbeResult({ networkError: true, isPaired: false }),
    ).toEqual({ kind: "bridge_missing" });
  });

  it("maps LNA block", () => {
    expect(
      classifyProbeResult({
        networkError: true,
        isPaired: false,
        likelyLnaBlocked: true,
      }),
    ).toEqual({ kind: "blocked_lna" });
  });

  it("maps healthy unpaired to needs_pairing", () => {
    expect(
      classifyProbeResult({
        networkError: false,
        status: 200,
        body: { ok: true, mode: "bridge", protocolVersion: 2 },
        isPaired: false,
      }),
    ).toEqual({ kind: "needs_pairing" });
  });

  it("maps healthy paired to ready", () => {
    expect(
      classifyProbeResult({
        networkError: false,
        status: 200,
        body: { ok: true, mode: "bridge" },
        isPaired: true,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("maps bad body to error", () => {
    const state = classifyProbeResult({
      networkError: false,
      status: 500,
      body: null,
      isPaired: false,
    });
    expect(state.kind).toBe("error");
  });
});

describe("probeBridge", () => {
  it("classifies a successful healthz JSON response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, mode: "bridge", protocolVersion: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const state = await probeBridge({
      bridgeBaseUrl: "http://127.0.0.1:20001",
      isPaired: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(state).toEqual({ kind: "needs_pairing" });
    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:20001/healthz");
    expect(init.credentials).toBe("include");
  });

  it("classifies fetch failure as bridge_missing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const state = await probeBridge({
      bridgeBaseUrl: "http://127.0.0.1:20001",
      isPaired: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(state).toEqual({ kind: "bridge_missing" });
  });
});
