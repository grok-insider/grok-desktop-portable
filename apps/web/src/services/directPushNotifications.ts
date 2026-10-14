import { applicationServerKey, PushSetupError } from "./pushNotifications";

export interface DirectNotificationStatus {
  outcome: "directNotificationStatus";
  enabled: boolean;
  applicationServerKey: string;
  configured: boolean;
  expiresAt: number | null;
  subscriptionEndpoint?: string | null;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const scopePrefix = "grok-direct-push-scope:";
const pathPattern = /^\/push\/[0-9a-f-]{36}\/$/;

export function asDirectNotificationStatus(value: unknown): DirectNotificationStatus {
  if (!record(value) || value.outcome !== "directNotificationStatus" || typeof value.enabled !== "boolean" || typeof value.configured !== "boolean" || typeof value.applicationServerKey !== "string" || (value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0)) || (value.configured && (typeof value.subscriptionEndpoint !== "string" || !value.subscriptionEndpoint.startsWith("https://") || value.subscriptionEndpoint.length > 4096 || value.expiresAt === null))) throw new PushSetupError("The computer returned an invalid notification status.");
  applicationServerKey(value.applicationServerKey);
  return value as unknown as DirectNotificationStatus;
}

export function directPushScope(profile: string, create = false): string | undefined {
  const key = scopePrefix + profile;
  const existing = localStorage.getItem(key);
  if (existing) {
    if (!pathPattern.test(existing)) throw new PushSetupError("This computer's local notification profile is invalid.");
    return existing;
  }
  if (!create) return undefined;
  if (Object.keys(localStorage).filter(key => key.startsWith(scopePrefix)).length >= 64) throw new PushSetupError("Disable notifications for an old computer before adding another.");
  const path = `/push/${crypto.randomUUID()}/`;
  localStorage.setItem(key, path);
  return path;
}

export async function directPushRegistration(profile: string, create = false): Promise<ServiceWorkerRegistration | undefined> {
  const scope = directPushScope(profile, create);
  if (!scope) return undefined;
  const existing = await navigator.serviceWorker.getRegistration(scope);
  if (existing?.scope === new URL(scope, location.origin).href) return existing;
  if (!create) return undefined;
  return navigator.serviceWorker.register("/sw.js", { scope });
}

export function directWorkerReady(registration: ServiceWorkerRegistration, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let channel: MessageChannel | undefined;
    let worker: ServiceWorker | null | undefined;
    let finished = false;
    const done = (supported: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      registration.installing?.removeEventListener("statechange", observe);
      registration.waiting?.removeEventListener("statechange", observe);
      worker?.removeEventListener("statechange", observe);
      channel?.port1.close(); channel?.port2.close();
      resolve(supported);
    };
    const aborted = () => done(false);
    const observe = () => {
      worker = registration.active ?? registration.waiting ?? registration.installing;
      if (!worker || worker.state !== "activated") { worker?.addEventListener("statechange", observe, { once: true }); return; }
      if (channel) return;
      channel = new MessageChannel();
      channel.port1.onmessage = event => done(event.data?.kind === "remotePushCapabilities" && event.data?.directVersion === 1);
      try { worker.postMessage({ kind: "remotePushCapabilities" }, [channel.port2]); } catch { done(false); }
    };
    const timer = setTimeout(() => done(false), 5000);
    signal.addEventListener("abort", aborted, { once: true });
    observe();
  });
}

export function directSubscriptionMatches(status: DirectNotificationStatus, subscription: PushSubscription | null): boolean {
  if (!subscription || !status.configured || !status.expiresAt || status.expiresAt <= Date.now() || subscription.endpoint !== status.subscriptionEndpoint) return false;
  return directSubscriptionKeyMatches(status.applicationServerKey, subscription);
}

export function directSubscriptionKeyMatches(publicKey: string, subscription: PushSubscription): boolean {
  const expected = applicationServerKey(publicKey);
  const actual = subscription.options.applicationServerKey;
  if (!actual || actual.byteLength !== expected.byteLength) return false;
  return new Uint8Array(actual).every((value, index) => value === expected[index]);
}

export async function removeDirectPushRegistration(profile: string): Promise<void> {
  const worker = await directPushRegistration(profile);
  const subscription = worker ? await worker.pushManager.getSubscription() : null;
  if (subscription) await subscription.unsubscribe();
  if (worker) await worker.unregister();
  localStorage.removeItem(scopePrefix + profile);
}
