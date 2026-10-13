import type { LightClient } from "./client";
import type { ImageDescriptor, Operation } from "./protocol";

export const MAX_IMAGES = 8;
export const MAX_IMAGE_SOURCE = 25 * 1024 * 1024;
export const MAX_IMAGE_SELECTION = 100 * 1024 * 1024;
export const MAX_IMAGE_NORMALIZED = 5 * 1024 * 1024;
export interface PreparedImage {id: string; name: string; blob: Blob; preview: string; width: number; height: number}
export interface ImageCropRect {x: number; y: number; width: number; height: number}

export function validateImageCrop(crop: ImageCropRect, image: {width: number; height: number}) {
  if (![crop.x, crop.y, crop.width, crop.height, image.width, image.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 8 || crop.height < 8 || crop.width * crop.height < 512 || crop.x + crop.width > image.width || crop.y + crop.height > image.height) throw new Error("Choose a crop inside the image with at least 8 pixels on each side and 512 pixels in total.");
}

export function imageDimensions(bytes: Uint8Array): {width: number; height: number} {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const match = (offset: number, value: string) => value.split("").every((character, i) => bytes[offset + i] === character.charCodeAt(0));
  if (bytes.length >= 24 && bytes[0] === 137 && match(1, "PNG\r\n\x1a\n") && match(12, "IHDR")) return {width: data.getUint32(16), height: data.getUint32(20)};
  if (bytes.length >= 30 && match(0, "RIFF") && match(8, "WEBP")) {
    if (match(12, "VP8X")) return {width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)};
    if (match(12, "VP8 ") && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return {width: data.getUint16(26, true) & 16383, height: data.getUint16(28, true) & 16383};
    if (match(12, "VP8L") && bytes[20] === 47) return {width: 1 + bytes[21] + ((bytes[22] & 63) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10)};
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const size = data.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) return {height: data.getUint16(offset + 3), width: data.getUint16(offset + 5)};
      offset += size;
    }
  }
  throw new Error("Choose a valid PNG, JPEG or WebP image.");
}

async function renderPreparedImage(bitmap: ImageBitmap, name: string, crop: ImageCropRect, signal?: AbortSignal): Promise<PreparedImage> {
  validateImageCrop(crop, bitmap);
  signal?.throwIfAborted();
  const scale = Math.min(1, 2000 / Math.max(crop.width, crop.height), Math.sqrt(2_408_448 / (crop.width * crop.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.floor(crop.width * scale));
  canvas.height = Math.max(8, Math.floor(crop.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare images.");
  let blob: Blob | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal?.throwIfAborted();
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    blob = await new Promise(resolve => canvas.toBlob(resolve, attempt === 0 ? "image/png" : "image/jpeg", .85));
    signal?.throwIfAborted();
    if (blob && blob.size <= 1_500_000) break;
    if (attempt > 0) {canvas.width = Math.max(8, Math.round(canvas.width * .8)); canvas.height = Math.max(8, Math.round(canvas.height * .8));}
  }
  if (!blob || blob.size > 1_500_000 || canvas.width * canvas.height < 512) throw new Error("This image could not be reduced to the upload limit.");
  return {id: crypto.randomUUID(), name: name.slice(0, 200), blob, preview: URL.createObjectURL(blob), width: canvas.width, height: canvas.height};
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size > MAX_IMAGE_SOURCE || !file.size) throw new Error("Each image must be smaller than 25 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = imageDimensions(bytes);
  if (dimensions.width < 8 || dimensions.height < 8 || dimensions.width * dimensions.height < 512 || dimensions.width * dimensions.height > 50_000_000) throw new Error("Images must have at least 8 pixels on each side, at least 512 pixels in total and no more than 50 megapixels.");
  const bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
  try {
    return await renderPreparedImage(bitmap, file.name, {x: 0, y: 0, width: bitmap.width, height: bitmap.height});
  } finally {bitmap.close();}
}

export async function cropImage(image: PreparedImage, crop: ImageCropRect, signal?: AbortSignal): Promise<PreparedImage> {
  validateImageCrop(crop, image);
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(image.blob, {imageOrientation: "from-image"});
  try {
    signal?.throwIfAborted();
    if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error("The image dimensions changed. Select the image again before cropping.");
    return await renderPreparedImage(bitmap, image.name, crop, signal);
  } finally {bitmap.close();}
}

async function operation(client: LightClient, value: Operation, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const reply = await client.send(value);
  signal.throwIfAborted();
  if (!reply.ok) throw new Error(reply.failure.kind === "refused" ? reply.failure.code : "Image transfer interrupted. Reconnect before trying again.");
  if (!reply.value || typeof reply.value !== "object") throw new Error("The computer returned an invalid image response.");
  return reply.value as Record<string, unknown>;
}

export async function uploadImage(client: LightClient, sessionId: string, image: PreparedImage, signal: AbortSignal, progress: (sent: number) => void): Promise<{imageId: string; image: ImageDescriptor}> {
  const bytes = new Uint8Array(await image.blob.arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
  const started = await operation(client, {kind: "startImageUpload", sessionId, byteLength: bytes.length, sha256}, signal);
  if (started.outcome !== "imageUploadStarted" || typeof started.uploadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(started.uploadId) || started.chunkBytes !== 32768) throw new Error("The computer does not support this image transfer protocol.");
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const chunk = bytes.subarray(offset, offset + 32768);
    const result = await operation(client, {kind: "appendImageUpload", sessionId, uploadId: started.uploadId, offset, data: btoa(String.fromCharCode(...chunk))}, signal);
    if (result.outcome !== "imageChunkAccepted" || result.offset !== offset + chunk.length) throw new Error("The image transfer position changed. Start a new transfer.");
    progress(offset + chunk.length);
  }
  const finished = await operation(client, {kind: "finishImageUpload", sessionId, uploadId: started.uploadId}, signal);
  const descriptor = finished.image as ImageDescriptor | undefined;
  if (finished.outcome !== "imageReady" || typeof finished.imageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(finished.imageId) || !descriptor || !["image/png", "image/jpeg"].includes(descriptor.mimeType) || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength <= 0 || descriptor.byteLength > MAX_IMAGE_NORMALIZED || !Number.isSafeInteger(descriptor.width) || descriptor.width < 8 || !Number.isSafeInteger(descriptor.height) || descriptor.height < 8 || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error("The computer returned invalid image metadata.");
  return {imageId: finished.imageId, image: descriptor};
}
