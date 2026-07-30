import { describe, expect, it } from "vitest";
import { detectBrowserSupport } from "./browser";

describe("detectBrowserSupport", () => {
  it("accepts Chromium and Edge", () => {
    expect(
      detectBrowserSupport(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ).ok,
    ).toBe(true);
    expect(
      detectBrowserSupport(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      ).ok,
    ).toBe(true);
  });

  it("accepts Firefox", () => {
    expect(
      detectBrowserSupport(
        "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
      ).ok,
    ).toBe(true);
  });

  it("blocks Safari / pure WebKit", () => {
    const result = detectBrowserSupport(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.engine).toBe("webkit");
      expect(result.reason).toMatch(/WebKit/i);
    }
  });
});

describe("agents that only look like WebKit", () => {
  it("does not block an agent carrying AppleWebKit without a Safari build", () => {
    // Blocking is this check's only hard failure, so a false positive costs a
    // user the whole product. jsdom is a live example of such an agent.
    const jsdom =
      "Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/27.0.0";
    expect(detectBrowserSupport(jsdom).ok).toBe(true);
  });

  it("still blocks a real Safari", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const support = detectBrowserSupport(safari);
    expect(support.ok).toBe(false);
    expect(support.ok === false && support.engine).toBe("webkit");
  });

  it("still blocks GNOME Web, which is WebKit with a Safari token", () => {
    const epiphany =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15 Epiphany/45.0";
    expect(detectBrowserSupport(epiphany).ok).toBe(false);
  });
});
