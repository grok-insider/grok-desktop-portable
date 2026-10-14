import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DirectNotifications } from "./DirectNotifications";
import { directPushRegistration, directWorkerReady } from "../services/directPushNotifications";
import type { LightClient } from "../services/client";

vi.mock("../services/directPushNotifications", async original => ({ ...await original<typeof import("../services/directPushNotifications")>(), directWorkerReady: vi.fn(async () => true) }));
const bytes = new Uint8Array(65); bytes[0] = 4;
const key = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
let configured = false;
let registration: { scope: string; pushManager: object; unregister: ReturnType<typeof vi.fn> } | undefined;
let subscription: typeof browserSubscription | null;
const permission = { permission: "default", requestPermission: vi.fn(async () => { permission.permission = "granted"; return "granted"; }) };
const browserSubscription = { endpoint: "https://fcm.googleapis.com/fcm/send/example", options: { applicationServerKey: bytes.buffer }, toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/example", keys: { p256dh: "synthetic", auth: "synthetic" } }), unsubscribe: vi.fn(async () => { subscription = null; return true; }) };
const subscribe = vi.fn(async () => { subscription = browserSubscription; return browserSubscription; });
const register = vi.fn(async (_script: string, options: { scope: string }) => {
  registration = { scope: new URL(options.scope, location.origin).href, pushManager: { getSubscription: async () => subscription, subscribe }, unregister: vi.fn(async () => true) };
  return registration;
});
function setup() {
  const send = vi.fn<LightClient["send"]>(async operation => {
    if (operation.kind === "configureDirectNotifications") { configured = true; return { ok: true, value: { outcome: "directNotificationsConfigured", expiresAt: Date.now() + 60000 } }; }
    if (operation.kind === "disableDirectNotifications") { configured = false; return { ok: true, value: { outcome: "acknowledged" } }; }
    return { ok: true, value: { outcome: "directNotificationStatus", enabled: true, applicationServerKey: key, configured, expiresAt: configured ? Date.now() + 60000 : null, subscriptionEndpoint: configured ? browserSubscription.endpoint : null } };
  });
  return { send, props: { client: { send } as unknown as LightClient, scopeKey: "local-profile", connectionVersion: 1, connected: true, capable: true } };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); configured = false; registration = undefined; subscription = null; permission.permission = "default";
  vi.mocked(directWorkerReady).mockResolvedValue(true);
  vi.stubGlobal("Notification", permission); vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => registration, register } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("cloud access is forbidden"); }));
});
afterEach(() => vi.unstubAllGlobals());

it("configures from a user gesture over the host connection without cloud fetch", async () => {
  const { props, send } = setup(); render(<DirectNotifications {...props} />);
  const enable = screen.getByRole("button", { name: "Enable notifications for this computer" });
  await waitFor(() => expect(enable).toBeEnabled());
  expect(permission.requestPermission).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  fireEvent.click(enable);
  await screen.findByText("Configured for this computer.");
  expect(permission.requestPermission).toHaveBeenCalledOnce(); expect(subscribe).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({ kind: "configureDirectNotifications", subscription: { endpoint: browserSubscription.endpoint, keys: { p256dh: "synthetic", auth: "synthetic" } } }, { idempotencyKey: expect.any(String) });
  expect(fetch).not.toHaveBeenCalled();
  expect(registration?.scope).not.toContain("local-profile");
  fireEvent.click(screen.getByRole("button", { name: "Disable notifications for this computer" }));
  await screen.findByText("Notifications are disabled for this computer.");
  expect(browserSubscription.unsubscribe).toHaveBeenCalledOnce();
  expect(registration?.unregister).toHaveBeenCalledOnce();
  expect(Object.keys(localStorage)).toHaveLength(0);
});

it("does not subscribe with an old service worker", async () => {
  vi.mocked(directWorkerReady).mockResolvedValue(false);
  render(<DirectNotifications {...setup().props} />);
  const enable = screen.getByRole("button", { name: "Enable notifications for this computer" });
  await waitFor(() => expect(enable).toBeEnabled()); fireEvent.click(enable);
  await screen.findByText("Update and reload the app before enabling notifications.");
  expect(subscribe).not.toHaveBeenCalled();
});

it("keeps host setup unconfirmed when the browser subscription is absent", async () => {
  configured = true; permission.permission = "granted";
  render(<DirectNotifications {...setup().props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh notification status" })).toBeEnabled());
  expect(screen.queryByText("Configured for this computer.")).not.toBeInTheDocument();
  expect(register).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
});

it("does not ask for permission or query a disconnected host", async () => {
  const { props, send } = setup(); render(<DirectNotifications {...props} connected={false} />);
  await act(async () => {});
  expect(send).not.toHaveBeenCalled(); expect(permission.requestPermission).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Enable notifications for this computer" })).toBeDisabled();
});

it("ignores completion from an old profile after switching computers", async () => {
  const old = setup(); const next = setup();
  let finish!: (value: unknown) => void;
  const waiting = new Promise(resolve => { finish = resolve; });
  old.send.mockImplementationOnce(async () => waiting as never);
  const view = render(<DirectNotifications {...old.props} scopeKey="old" />);
  view.rerender(<DirectNotifications {...next.props} scopeKey="new" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh notification status" })).toBeEnabled());
  await act(async () => { finish({ ok: true, value: { outcome: "directNotificationStatus", enabled: true, applicationServerKey: key, configured: true, expiresAt: Date.now() + 60000, subscriptionEndpoint: browserSubscription.endpoint } }); });
  expect(screen.queryByRole("button", { name: "Disable notifications for this computer" })).not.toBeInTheDocument();
  expect(register).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
});

it("keeps a VAPID key mismatch unconfirmed and reports a rejected resubscription", async () => {
  permission.permission = "granted";
  const { props } = setup(); render(<DirectNotifications {...props} />);
  const enable = screen.getByRole("button", { name: "Enable notifications for this computer" });
  await waitFor(() => expect(enable).toBeEnabled());
  subscribe.mockRejectedValueOnce(new Error("InvalidStateError: applicationServerKey changed"));
  fireEvent.click(enable);
  await screen.findByText("The computer could not confirm this change. Refresh before trying again.");
  expect(screen.queryByText("Configured for this computer.")).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("replaces only this computer's subscription after its VAPID key changes", async () => {
  permission.permission = "granted";
  await directPushRegistration("local-profile", true);
  const unsubscribe = vi.fn(async () => true);
  subscription = { ...browserSubscription, options: { applicationServerKey: new Uint8Array(65).buffer }, unsubscribe };
  render(<DirectNotifications {...setup().props} />);
  const enable = screen.getByRole("button", { name: "Enable notifications for this computer" });
  await waitFor(() => expect(enable).toBeEnabled()); fireEvent.click(enable);
  await screen.findByText("Configured for this computer.");
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledOnce();
  expect(registration?.unregister).not.toHaveBeenCalled();
});

it("contains a synchronous browser permission error without leaving setup busy", async () => {
  permission.requestPermission.mockImplementationOnce(() => { throw new Error("browser permission unavailable"); });
  render(<DirectNotifications {...setup().props} />);
  const enable = screen.getByRole("button", { name: "Enable notifications for this computer" });
  await waitFor(() => expect(enable).toBeEnabled()); fireEvent.click(enable);
  await screen.findByText("The computer could not confirm this change. Refresh before trying again.");
  expect(enable).toBeEnabled();
  expect(subscribe).not.toHaveBeenCalled();
});
