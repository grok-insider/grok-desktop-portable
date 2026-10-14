import { useEffect, useRef, useState } from "react";
import type { LightClient } from "../services/client";
import { applicationServerKey, notificationPermission, PushSetupError } from "../services/pushNotifications";
import { asDirectNotificationStatus, directPushRegistration, directSubscriptionKeyMatches, directSubscriptionMatches, directWorkerReady, removeDirectPushRegistration, type DirectNotificationStatus } from "../services/directPushNotifications";
import { Button } from "./ui";

interface Props { client: LightClient; scopeKey: string; connectionVersion: number; connected: boolean; capable?: boolean }
export function DirectNotifications(props: Props) {
  return <Controls key={JSON.stringify([props.scopeKey, props.connectionVersion, props.connected])} {...props} />;
}
function Controls({ client, scopeKey, connected, capable }: Props) {
  const [status, setStatus] = useState<DirectNotificationStatus>();
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [permission, setPermission] = useState(notificationPermission);
  const lifetime = useRef<AbortController | null>(null);
  const active = useRef(false);
  async function refresh(signal: AbortSignal) {
    const response = await client.send({ kind: "getDirectNotificationStatus" });
    if (signal.aborted) return;
    if (!response.ok) throw new PushSetupError("Notification status could not be read from this computer.");
    const current = asDirectNotificationStatus(response.value);
    const state = notificationPermission();
    const worker = state === "granted" ? await directPushRegistration(scopeKey) : undefined;
    const subscription = worker ? await worker.pushManager.getSubscription() : null;
    if (signal.aborted) return;
    setPermission(state); setStatus(current); setConfirmed(directSubscriptionMatches(current, subscription));
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (!connected || !capable) { setBusy(false); return () => controller.abort(); }
    void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setNotice("Notification status could not be read. Refresh to try again."); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); lifetime.current = null; };
  }, [client, scopeKey, connected, capable]);
  function perform(action: (signal: AbortSignal) => Promise<void>) {
    const controller = lifetime.current;
    if (active.current || !controller || controller.signal.aborted) return;
    active.current = true; setBusy(true); setNotice(undefined);
    void action(controller.signal).catch(error => { if (!controller.signal.aborted) { setConfirmed(false); setNotice(error instanceof PushSetupError ? error.message : "The computer could not confirm this change. Refresh before trying again."); } }).finally(() => { active.current = false; if (!controller.signal.aborted) setBusy(false); });
  }
  function outcome(value: unknown, expected: string): boolean {
    return typeof value === "object" && value !== null && "outcome" in value && value.outcome === expected;
  }
  function enable() {
    if (!status || !connected || active.current) return;
    perform(async signal => {
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (signal.aborted) return;
      setPermission(permission);
      if (permission !== "granted") throw new PushSetupError("Allow notifications in this browser's settings to enable them.");
      const worker = await directPushRegistration(scopeKey, true);
      if (!worker || !await directWorkerReady(worker, signal)) throw new PushSetupError("Update and reload the app before enabling notifications.");
      if (signal.aborted) return;
      const previous = await worker.pushManager.getSubscription();
      if (signal.aborted) return;
      if (previous && !directSubscriptionKeyMatches(status.applicationServerKey, previous)) {
        if (!await previous.unsubscribe()) throw new PushSetupError("The browser could not replace this computer's old notification subscription.");
        if (signal.aborted) return;
      }
      const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.applicationServerKey) });
      if (signal.aborted) return;
      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) throw new PushSetupError("The browser returned an incomplete notification subscription.");
      const response = await client.send({ kind: "configureDirectNotifications", subscription: { endpoint: serialized.endpoint, expirationTime: serialized.expirationTime, keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth } } }, { idempotencyKey: crypto.randomUUID() });
      if (signal.aborted) return;
      if (!response.ok || !outcome(response.value, "directNotificationsConfigured")) throw new PushSetupError("The computer did not confirm notification setup. Refresh before trying again.");
      await refresh(signal);
    });
  }
  function disable() {
    perform(async signal => {
      const result = await client.send({ kind: "disableDirectNotifications" }, { idempotencyKey: crypto.randomUUID() });
      if (signal.aborted) return;
      if (!result.ok || !outcome(result.value, "acknowledged")) throw new PushSetupError("The computer did not confirm notification removal.");
      await removeDirectPushRegistration(scopeKey);
      await refresh(signal);
      if (!signal.aborted) setNotice("Notifications are disabled for this computer.");
    });
  }
  return <section aria-label="Computer notifications" className="border-b border-border px-4 py-3">
    <h2 className="font-semibold">Notifications</h2>
    <p className="mt-1 text-body-sm text-muted-foreground">Optional activity notices sent by your computer through the browser's push provider. Conversation text and approval details stay private.</p>
    <p className="mt-2 text-body-sm">{confirmed ? "Configured for this computer." : "Not configured for this computer."}</p>
    {permission === "unsupported" && <p className="mt-2 text-body-sm">This browser does not support notifications here.</p>}
    {permission === "denied" && <p className="mt-2 text-body-sm">Notifications are blocked in this browser's settings.</p>}
    {!connected && <p className="mt-2 text-body-sm">Connect to the computer to manage notifications.</p>}
    {notice && <p role="status" className="mt-2 text-body-sm">{notice}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button className="min-h-11" disabled={busy || !connected || !capable || !status?.enabled || permission === "unsupported" || permission === "denied"} onClick={enable}>{confirmed ? "Reconnect notifications" : "Enable notifications for this computer"}</Button>
      {status?.configured && <Button className="min-h-11" disabled={busy || !connected} onClick={disable}>Disable notifications for this computer</Button>}
      <Button className="min-h-11" disabled={busy || !connected || !capable} onClick={() => perform(refresh)}>Refresh notification status</Button>
    </div>
  </section>;
}
