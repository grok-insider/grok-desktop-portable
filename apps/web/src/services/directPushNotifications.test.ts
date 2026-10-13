import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { directPushRegistration, directPushScope } from "./directPushNotifications";
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
it("isolates per-host VAPID registrations behind random local scopes", () => {
  const first = directPushScope("https://private-host.one#installation", true);
  const second = directPushScope("https://private-host.two#installation", true);
  expect(first).not.toBe(second);
  expect(first).toMatch(/^\/push\/[a-f0-9-]{36}\/$/);
  expect(first).not.toContain("private-host");
  expect(directPushScope("https://private-host.one#installation", true)).toBe(first);
});
it("does not reuse the main registration returned by prefix lookup", async () => {
  directPushScope("host", true);
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn(async () => ({ scope: new URL("/", location.origin).href })) } });
  expect(await directPushRegistration("host")).toBeUndefined();
});
it("fails closed when stored scope points outside its isolated namespace", () => {
  localStorage.setItem("grok-direct-push-scope:host", "/");
  expect(() => directPushScope("host")).toThrow();
});
