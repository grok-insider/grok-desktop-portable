import type { PairResult } from "./client";

export interface DirectPairing {
  endpoint: string;
  installationId: string;
  nonce: string;
  hostPublicKey: string;
  label?: string;
}

export interface DirectProfile {
  endpoint: string;
  installationId: string;
  label: string;
  hostPublicKey: string;
  privateKey: Uint8Array;
  pair: PairResult;
}

export const DIRECT_PROFILES_CHANGED = "grok-direct-profiles-changed";
const DATABASE = "grok-direct-hosts-v1";
const STORE = "profiles";
const MAX_PROFILES = 32;

export function directEndpoint(value: string): string {
  if (typeof value !== "string" || value.length > 2048 || value.trim() !== value) throw new Error("invalid_endpoint");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_endpoint");
  if (url.hostname === "fabrials.com" || url.hostname.endsWith(".fabrials.com") || url.hostname === "grok.me" || url.hostname.endsWith(".grok.me")) throw new Error("invalid_endpoint");
  return url.origin;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function directProfileId(profile: Pick<DirectProfile, "endpoint" | "installationId">): string {
  return JSON.stringify(["direct", directEndpoint(profile.endpoint), profile.installationId]);
}

export function directDraftScope(profile: DirectProfile): string {
  return JSON.stringify(["direct", profile.endpoint, profile.installationId, profile.hostPublicKey, profile.pair.sessionId]);
}

export function takeDirectPairing(fragment: string = location.hash): DirectPairing | null {
  if (!fragment.startsWith("#directPair=")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const encoded = fragment.slice("#directPair=".length);
    if (encoded.length > 4096 || !/^[A-Za-z0-9_+/=-]+$/.test(encoded)) return null;
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    if (!value || typeof value !== "object" || !("endpoint" in value) || !("installationId" in value) || !("nonce" in value) || !("hostPublicKey" in value)) return null;
    if (typeof value.endpoint !== "string" || !identifier(value.installationId) || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce) || typeof value.hostPublicKey !== "string" || !/^[a-f0-9]{64}$/.test(value.hostPublicKey)) return null;
    const label = "label" in value && typeof value.label === "string" ? value.label.trim().slice(0, 80) : undefined;
    return {endpoint: directEndpoint(value.endpoint), installationId: value.installationId, nonce: value.nonce, hostPublicKey: value.hostPublicKey, ...(label ? {label} : {})};
  } catch {return null;}
}

function validatedProfile(value: unknown): DirectProfile {
  if (!value || typeof value !== "object") throw new Error("device_storage_invalid");
  const profile = value as DirectProfile;
  if (directEndpoint(profile.endpoint) !== profile.endpoint || !identifier(profile.installationId) || typeof profile.label !== "string" || profile.label.length > 80 || !/^[a-f0-9]{64}$/.test(profile.hostPublicKey) || (Object.prototype.toString.call(profile.privateKey) !== "[object Uint8Array]") || profile.privateKey.length !== 32 || !profile.pair || !identifier(profile.pair.sessionId) || profile.pair.installationId !== profile.installationId || typeof profile.pair.sessionToken !== "string" || !profile.pair.sessionToken || typeof profile.pair.csrfToken !== "string" || !profile.pair.csrfToken || !Number.isInteger(profile.pair.protocolVersion)) throw new Error("device_storage_invalid");
  return {...profile, privateKey: Uint8Array.from(profile.privateKey)};
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {expired = true; reject(new Error("device_storage_unavailable"));}, 10_000);
    try {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result);};
      request.onerror = request.onblocked = () => {clearTimeout(timer); expired = true; reject(new Error("device_storage_unavailable"));};
    } catch {clearTimeout(timer); reject(new Error("device_storage_unavailable"));}
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: Error) => void) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const db = await database();
  try {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode, mode === "readwrite" ? {durability: "strict"} : undefined);
      let result: T;
      let failure: Error | undefined;
      const timer = setTimeout(() => {failure = new Error("device_storage_unavailable"); tx.abort();}, 10_000);
      const cancel = () => {try {tx.abort();} catch {}};
      const cleanup = () => {clearTimeout(timer); signal?.removeEventListener("abort", cancel);};
      tx.oncomplete = () => {cleanup(); resolve(result);};
      tx.onerror = tx.onabort = () => {cleanup(); reject(signal?.aborted ? signal.reason : failure ?? new Error("device_storage_unavailable"));};
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) {cancel(); return;}
      const fail = (error: Error) => {failure = error; tx.abort();};
      try {action(tx.objectStore(STORE), value => {result = value;}, fail);} catch (error) {fail(error instanceof Error ? error : new Error("device_storage_unavailable"));}
    });
  } finally {db.close();}
}

export async function listDirectProfiles(): Promise<DirectProfile[]> {
  return transaction("readonly", (store, done, fail) => {
    const request = store.getAll(undefined, MAX_PROFILES + 1);
    request.onsuccess = () => {
      try {
        if (request.result.length > MAX_PROFILES) throw new Error("device_storage_invalid");
        done(request.result.map(validatedProfile));
      } catch {fail(new Error("device_storage_invalid"));}
    };
  });
}

export async function readDirectProfile(id: string): Promise<DirectProfile | undefined> {
  return transaction("readonly", (store, done, fail) => {
    const request = store.get(id);
    request.onsuccess = () => {
      try {done(request.result === undefined ? undefined : validatedProfile(request.result));}
      catch {fail(new Error("device_storage_invalid"));}
    };
  });
}

function notify(id: string): void {
  window.dispatchEvent(new CustomEvent(DIRECT_PROFILES_CHANGED, {detail: id}));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(DATABASE);
    channel.postMessage(id);
    channel.close();
  }
}

export function observeDirectProfiles(listener: () => void): () => void {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DATABASE) : undefined;
  if (channel) channel.onmessage = listener;
  window.addEventListener(DIRECT_PROFILES_CHANGED, listener);
  return () => {channel?.close(); window.removeEventListener(DIRECT_PROFILES_CHANGED, listener);};
}

export async function saveDirectProfile(profile: DirectProfile, expectedSessionId?: string, signal?: AbortSignal): Promise<void> {
  validatedProfile(profile);
  const id = directProfileId(profile);
  await transaction<void>("readwrite", (store, done, fail) => {
    const existing = store.get(id);
    existing.onsuccess = () => {
      if (expectedSessionId !== undefined && existing.result?.pair.sessionId !== expectedSessionId) {fail(new Error("pairing_changed")); return;}
      const count = store.count();
      count.onsuccess = () => {
        if (!existing.result && count.result >= MAX_PROFILES) {fail(new Error("computer_limit")); return;}
        store.put(profile, id);
        done();
      };
    };
  }, signal);
  notify(id);
}

export async function deleteDirectProfile(profile: DirectProfile): Promise<void> {
  const id = directProfileId(profile);
  await transaction<void>("readwrite", (store, done, fail) => {
    const existing = store.get(id);
    existing.onsuccess = () => {
      if (existing.result && existing.result.pair.sessionId !== profile.pair.sessionId) {fail(new Error("pairing_changed")); return;}
      store.delete(id);
      done();
    };
  });
  notify(id);
}
