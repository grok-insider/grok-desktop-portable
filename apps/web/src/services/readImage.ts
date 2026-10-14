import type { LightClient } from "./client";
import type { ImageDescriptor } from "./protocol";

export async function readImage(client: LightClient, sessionId: string, image: ImageDescriptor, signal: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(image.byteLength) || image.byteLength <= 0 || image.byteLength > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(image.sha256) || !["image/png", "image/jpeg"].includes(image.mimeType)) throw new Error("invalid_image_descriptor");
  const bytes = new Uint8Array(image.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const response = await client.send({kind: "readImageChunk", sessionId, sha256: image.sha256, offset});
    signal.throwIfAborted();
    if (!response.ok) throw new Error("image_unavailable");
    const chunk = response.value as {outcome?: string; sha256?: string; offset?: number; nextOffset?: number; totalBytes?: number; data?: string};
    if (chunk?.outcome !== "imageChunk" || chunk.sha256 !== image.sha256 || chunk.offset !== offset || chunk.totalBytes !== image.byteLength || typeof chunk.data !== "string" || chunk.data.length > 43692 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)) throw new Error("invalid_image_chunk");
    const value = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
    if (!value.length || value.length > 32768 || offset + value.length > bytes.length || chunk.nextOffset !== offset + value.length) throw new Error("invalid_image_chunk");
    bytes.set(value, offset);
    offset += value.length;
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  if (digest !== image.sha256) throw new Error("image_hash_mismatch");
  return new Blob([bytes], {type: image.mimeType});
}

let activeReads = 0;
const pendingReads: Array<() => void> = [];

export async function withImageReadSlot<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (activeReads >= 2) {
    if (pendingReads.length >= 64) throw new Error("image_read_busy");
    await new Promise<void>((resolve, reject) => {
      const run = () => {signal.removeEventListener("abort", cancel); resolve();};
      const cancel = () => {const index = pendingReads.indexOf(run); if (index >= 0) pendingReads.splice(index, 1); reject(signal.reason);};
      signal.addEventListener("abort", cancel, {once: true});
      pendingReads.push(run);
    });
  } else activeReads++;
  try {signal.throwIfAborted(); return await operation();}
  finally {const next = pendingReads.shift(); if (next) next(); else activeReads--;}
}
