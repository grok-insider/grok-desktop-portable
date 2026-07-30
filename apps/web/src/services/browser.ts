/**
 * Supported engine check for light ADR 0008.
 *
 * Chromium and Firefox 84+ treat `*.localhost` as trustworthy and resolve it
 * to loopback. WebKit does not; Light must not pretend to work there.
 */

export type BrowserSupport =
  | { ok: true; engine: "chromium" | "firefox" | "other" }
  | { ok: false; engine: "webkit"; reason: string };

/**
 * Classify the current browser for Light's loopback origin.
 *
 * Detection is best-effort from `navigator.userAgent`. A false "other" still
 * proceeds; only WebKit is hard-blocked.
 */
export function detectBrowserSupport(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): BrowserSupport {
  const ua = userAgent;
  // WebKit-based: Safari, GNOME Web, older iOS shells. `AppleWebKit` alone is
  // not enough — Chromium carries it too, and so do non-browser agents — so a
  // real WebKit browser is identified by its `Safari/` build token with no
  // Chromium or Gecko brand alongside it. Blocking is the one hard failure
  // this check can produce, so it errs towards letting an unknown agent
  // through rather than shutting out a browser that would have worked.
  const isWebKit =
    /AppleWebKit/i.test(ua) &&
    /Safari\//i.test(ua) &&
    !/Chrome|Chromium|Edg|OPR|Firefox/i.test(ua);
  if (isWebKit) {
    return {
      ok: false,
      engine: "webkit",
      reason:
        "This browser uses WebKit, which does not treat *.localhost as a secure loopback origin. Use Chromium or Firefox 84+.",
    };
  }
  if (/Firefox\//i.test(ua)) {
    return { ok: true, engine: "firefox" };
  }
  if (/Chrome|Chromium|Edg|OPR/i.test(ua)) {
    return { ok: true, engine: "chromium" };
  }
  return { ok: true, engine: "other" };
}
