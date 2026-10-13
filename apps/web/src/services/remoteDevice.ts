import type { PairResult } from "./client";

export interface Grant {
  hostPublicKey: string;
  privateKey: Uint8Array;
  pair?: PairResult;
}

async function database(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("fabrials-remote-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("devices");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("device_storage_unavailable"));
    request.onblocked = () => reject(new Error("device_storage_unavailable"));
  }).catch(() => {throw new Error("device_storage_unavailable");});
}

export async function readGrant(hostId: string): Promise<Grant | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("devices", "readonly");
      const request = transaction.objectStore("devices").get(hostId);
      request.onsuccess = () => resolve(request.result as Grant | undefined);
      request.onerror = () => reject(new Error("device_storage_unavailable"));
    });
  } finally { db.close(); }
}

async function updateGrant(hostId: string, grant: Grant | undefined, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const db = await database();
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("devices", "readwrite");
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      const cancel = () => {
        cleanup();
        try {transaction.abort();} catch {}
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      transaction.oncomplete = () => {cleanup(); resolve();};
      transaction.onerror = () => {cleanup(); reject(new Error("device_storage_unavailable"));};
      transaction.onabort = () => {cleanup(); reject(signal?.aborted ? signal.reason : new Error("device_storage_unavailable"));};
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) {cancel(); return;}
      try {
        const store = transaction.objectStore("devices");
        if (grant) store.put(grant, hostId);
        else store.delete(hostId);
      } catch {cleanup(); reject(new Error("device_storage_unavailable"));}
    });
  } finally { db.close(); }
}

export function writeGrant(hostId: string, grant: Grant, signal?: AbortSignal): Promise<void> {
  return updateGrant(hostId, grant, signal);
}

export function deleteGrant(hostId: string, signal?: AbortSignal): Promise<void> {
  return updateGrant(hostId, undefined, signal);
}
