import { remoteAccount } from "./remoteAccount";

export class PushSetupError extends Error {}

export interface PushRegistration {id:string;endpoint:string;active:boolean;expiresAt:number;generation:number}
export interface HostNotificationStatus {outcome:"notificationStatus";enabled:boolean;registrations:{id:string;expiresAt:number;generation:number}[]}
export interface PushConfiguration {enabled:boolean;applicationServerKey?:string}
export interface PushBinding {id:string;bindingToken:string;expiresAt:number;generation:number}
const record = (value:unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value:unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const stamp = (value:unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function asPushConfiguration(value:unknown): PushConfiguration {
  if (!record(value) || typeof value.enabled !== "boolean" || (value.enabled && typeof value.applicationServerKey !== "string")) throw new PushSetupError("Notifications are unavailable at the account service.");
  if (value.enabled) applicationServerKey(value.applicationServerKey as string);
  return value as unknown as PushConfiguration;
}

export function applicationServerKey(value:string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{86,88}$/.test(value)) throw new PushSetupError("The notification service returned an unsupported public key.");
  let bytes: Uint8Array<ArrayBuffer>;
  try {bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), character => character.charCodeAt(0));}
  catch {throw new PushSetupError("The notification service returned an unsupported public key.");}
  if (bytes.length !== 65 || bytes[0] !== 4) throw new PushSetupError("The notification service returned an unsupported public key.");
  return bytes;
}

export function asPushRegistrations(value:unknown): PushRegistration[] {
  if (!record(value) || !Array.isArray(value.subscriptions) || value.subscriptions.length > 100 || !value.subscriptions.every(row => record(row) && identity(row.id) && typeof row.endpoint === "string" && row.endpoint.length <= 4096 && row.endpoint.startsWith("https://") && typeof row.active === "boolean" && stamp(row.expiresAt) && stamp(row.generation))) throw new PushSetupError("Notification status could not be verified.");
  if (new Set(value.subscriptions.map(row => row.id)).size !== value.subscriptions.length) throw new PushSetupError("Notification status could not be verified.");
  return value.subscriptions as PushRegistration[];
}

export function asNotificationStatus(value:unknown): HostNotificationStatus {
  if (!record(value) || value.outcome !== "notificationStatus" || typeof value.enabled !== "boolean" || !Array.isArray(value.registrations) || value.registrations.length > 100 || !value.registrations.every(row => record(row) && identity(row.id) && stamp(row.expiresAt) && stamp(row.generation))) throw new PushSetupError("The computer's notification status could not be verified.");
  if (new Set(value.registrations.map(row => row.id)).size !== value.registrations.length) throw new PushSetupError("The computer returned contradictory notification status.");
  return value as unknown as HostNotificationStatus;
}

export function asPushBinding(value:unknown): PushBinding {
  if (!record(value) || !identity(value.id) || !stamp(value.generation) || !stamp(value.expiresAt) || value.expiresAt <= Date.now() || typeof value.bindingToken !== "string" || value.bindingToken.length < 16 || value.bindingToken.length > 4096) throw new PushSetupError("The notification registration could not be verified.");
  return value as unknown as PushBinding;
}

export function bindingConfirmed(value:unknown, binding:PushBinding): boolean {
  return record(value) && value.outcome === "notificationsConfigured" && value.id === binding.id && value.generation === binding.generation && stamp(value.expiresAt) && value.expiresAt >= binding.expiresAt && value.expiresAt > Date.now() && value.active === true;
}

export function workerSupportsPush(worker:ServiceWorker | null, signal:AbortSignal): Promise<boolean> {
  if (!worker || signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const done = (supported:boolean) => {clearTimeout(timer);signal.removeEventListener("abort", abort);channel.port1.close();channel.port2.close();resolve(supported);};
    const abort = () => done(false);
    const timer = setTimeout(() => done(false), 2000);
    signal.addEventListener("abort", abort, {once:true});
    channel.port1.onmessage = event => done(event.data?.kind === "remotePushCapabilities" && event.data?.version === 1 && event.data?.enabled === true);
    try {worker.postMessage({kind:"remotePushCapabilities"}, [channel.port2]);} catch {done(false);}
  });
}

export async function readPushAccount(hostId:string, signal:AbortSignal) {
  const configuration = asPushConfiguration(await remoteAccount<unknown>("/push/config", {signal}));
  if (!configuration.enabled) return {configuration,registrations:[]};
  const registrations = asPushRegistrations(await remoteAccount<unknown>(`/push/subscriptions?hostId=${encodeURIComponent(hostId)}`, {signal}));
  return {configuration,registrations};
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) ? "unsupported" : Notification.permission;
}
