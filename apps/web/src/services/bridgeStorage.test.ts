import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGE_PORT_KEY,
  BRIDGE_SESSION_KEY,
  SESSION_GRANT_TTL_MS,
  clearStoredPort,
  clearStoredSessionGrant,
  hasStoredPort,
  portFromBridgeBase,
  readStoredPort,
  readStoredSession,
  resolveBridgeBaseUrl,
  writeStoredPort,
  writeStoredSession,
} from "./client";

describe("portFromBridgeBase", () => {
  it("parses loopback bases", () => {
    expect(portFromBridgeBase("http://127.0.0.1:29578")).toBe(29578);
    expect(portFromBridgeBase("http://localhost:20001")).toBe(20001);
    expect(portFromBridgeBase("")).toBeNull();
    expect(portFromBridgeBase("https://desktop.grok.me")).toBeNull();
  });
});

describe("stored port", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("writes to localStorage and sessionStorage", () => {
    writeStoredPort(29578);
    expect(localStorage.getItem(BRIDGE_PORT_KEY)).toBe("29578");
    expect(sessionStorage.getItem(BRIDGE_PORT_KEY)).toBe("29578");
    expect(readStoredPort()).toBe(29578);
    expect(hasStoredPort()).toBe(true);
  });

  it("promotes a sessionStorage-only port into localStorage", () => {
    sessionStorage.setItem(BRIDGE_PORT_KEY, "18765");
    expect(readStoredPort()).toBe(18765);
    expect(localStorage.getItem(BRIDGE_PORT_KEY)).toBe("18765");
  });

  it("resolveBridgeBaseUrl prefers durable port", () => {
    writeStoredPort(29578);
    expect(resolveBridgeBaseUrl()).toBe("http://127.0.0.1:29578");
  });

  it("clearStoredPort removes both stores", () => {
    writeStoredPort(29578);
    clearStoredPort();
    expect(readStoredPort()).toBeNull();
    expect(hasStoredPort()).toBe(false);
  });
});

describe("stored session grant", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("round-trips a valid grant", () => {
    const now = 1_700_000_000_000;
    writeStoredSession({
      port: 29578,
      sessionToken: "sess-token",
      csrfToken: "csrf-token",
      savedAtMs: now,
    });
    expect(readStoredSession(now)).toEqual({
      port: 29578,
      sessionToken: "sess-token",
      csrfToken: "csrf-token",
      savedAtMs: now,
    });
    expect(readStoredPort()).toBe(29578);
  });

  it("expires after TTL", () => {
    const now = 1_700_000_000_000;
    writeStoredSession({
      port: 29578,
      sessionToken: "sess-token",
      csrfToken: "csrf-token",
      savedAtMs: now,
    });
    expect(readStoredSession(now + SESSION_GRANT_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem(BRIDGE_SESSION_KEY)).toBeNull();
  });

  it("clearStoredSessionGrant keeps the port", () => {
    writeStoredSession({
      port: 29578,
      sessionToken: "sess-token",
      csrfToken: "csrf-token",
      savedAtMs: Date.now(),
    });
    clearStoredSessionGrant();
    expect(readStoredSession()).toBeNull();
    expect(readStoredPort()).toBe(29578);
  });
});
