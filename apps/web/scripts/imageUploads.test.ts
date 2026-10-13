import {Blob as NativeBlob} from "node:buffer";
import {webcrypto} from "node:crypto";
import {afterEach, expect, it, vi} from "vitest";
import {LightClient} from "../src/services/client";
import {cropImage, imageDimensions, prepareImage, uploadImage, validateImageCrop, type PreparedImage} from "../src/services/imageUploads";
import {readImage, withImageReadSlot} from "../src/services/readImage";

const bytes = new Uint8Array(70_000).fill(9);
const digest = async () => [...new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
const prepared: PreparedImage = {id: "pick", name: "image.png", blob: new NativeBlob([bytes], {type: "image/png"}) as unknown as Blob, preview: "blob:local", width: 8, height: 8};
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

it("reads PNG dimensions from bytes rather than a filename or MIME label", () => {
  const png = new Uint8Array(24);
  png.set([137,80,78,71,13,10,26,10]); png.set([73,72,68,82], 12);
  const view = new DataView(png.buffer); view.setUint32(16, 400); view.setUint32(20, 300);
  expect(imageDimensions(png)).toEqual({width: 400, height: 300});
  expect(() => imageDimensions(new Uint8Array(100))).toThrow(/valid PNG/);
});

it("rejects undersized, fractional and out-of-bounds crops before decoding", async () => {
  const bitmap = vi.fn();
  vi.stubGlobal("createImageBitmap", bitmap);
  const source = {...prepared, width: 64, height: 64};
  for (const crop of [
    {x: -1, y: 0, width: 32, height: 32}, {x: 1, y: 0, width: 64, height: 64},
    {x: 0, y: 0, width: 7, height: 64}, {x: 0, y: 0, width: 8, height: 8},
    {x: .5, y: 0, width: 32, height: 32}, {x: 0, y: NaN, width: 32, height: 32},
  ]) await expect(cropImage(source, crop)).rejects.toThrow(/Choose a crop/);
  expect(bitmap).not.toHaveBeenCalled();
  expect(() => validateImageCrop({x: 56, y: 0, width: 8, height: 64}, source)).not.toThrow();
});

it("crops decoded pixels and creates a new metadata-free canvas encoding", async () => {
  const bitmap = {width: 64, height: 64, close: vi.fn()};
  const decode = vi.fn().mockResolvedValue(bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({fillRect: vi.fn(), drawImage} as never);
  const normalized = new NativeBlob(["new pixel encoding"], {type: "image/png"}) as unknown as Blob;
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(normalized));
  vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:crop")}));
  const source = {...prepared, width: 64, height: 64};
  const result = await cropImage(source, {x: 8, y: 16, width: 32, height: 32});
  expect(decode).toHaveBeenCalledWith(source.blob, {imageOrientation: "from-image"});
  expect(drawImage).toHaveBeenCalledWith(bitmap, 8, 16, 32, 32, 0, 0, 32, 32);
  expect(encode.mock.calls[0][1]).toBe("image/png");
  expect(result).toMatchObject({width: 32, height: 32, blob: normalized, name: source.name, preview: "blob:crop"});
  expect(result.id).not.toBe(source.id);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(source.blob).toBe(prepared.blob);
});

it("uses the decoded orientation before producing a normalized source for cropping", async () => {
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]); bytes.set([73,72,68,82], 12);
  const view = new DataView(bytes.buffer); view.setUint32(16, 32); view.setUint32(20, 16);
  const source = {size: bytes.length, name: "oriented.png", arrayBuffer: async () => bytes.buffer} as File;
  const bitmap = {width: 16, height: 32, close: vi.fn()};
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({fillRect: vi.fn(), drawImage} as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["pixels"], {type: "image/png"})));
  vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:oriented")}));
  expect(await prepareImage(source)).toMatchObject({width: 16, height: 32});
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 16, 32, 0, 0, 16, 32);
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it("cancellation during decode closes the bitmap without creating a preview", async () => {
  let finish!: (value: unknown) => void;
  const bitmap = {width: 64, height: 64, close: vi.fn()};
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => {finish = resolve;})));
  const createObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, {createObjectURL}));
  const controller = new AbortController();
  const cropping = cropImage({...prepared, width: 64, height: 64}, {x: 0, y: 0, width: 32, height: 32}, controller.signal);
  controller.abort(); finish(bitmap);
  await expect(cropping).rejects.toMatchObject({name: "AbortError"});
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("rounding normalized dimensions never exceeds the host pixel budget", async () => {
  const bytes = new Uint8Array(24);
  bytes.set([137,80,78,71,13,10,26,10]); bytes.set([73,72,68,82], 12);
  const view = new DataView(bytes.buffer); view.setUint32(16, 2000); view.setUint32(20, 2000);
  const bitmap = {width: 2000, height: 2000, close: vi.fn()};
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({fillRect: vi.fn(), drawImage: vi.fn()} as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["pixels"], {type: "image/png"})));
  vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:bounded")}));
  const normalized = await prepareImage({size: bytes.length, name: "large.png", arrayBuffer: async () => bytes.buffer} as File);
  expect(normalized.width * normalized.height).toBeLessThanOrEqual(2_408_448);
  expect(normalized.width).toBeLessThanOrEqual(2000);
  expect(normalized.height).toBeLessThanOrEqual(2000);
});

it("uploads exact bounded chunks and stops before finishing when offsets disagree", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const sha256 = await digest();
  const data: Uint8Array[] = [];
  const send = vi.fn(async (operation: any) => {
    if (operation.kind === "startImageUpload") return {ok: true, value: {outcome: "imageUploadStarted", uploadId: "upload", chunkBytes: 32768}};
    if (operation.kind === "appendImageUpload") {
      const chunk = Uint8Array.from(atob(operation.data), value => value.charCodeAt(0)); data.push(chunk);
      return {ok: true, value: {outcome: "imageChunkAccepted", offset: operation.offset + chunk.length}};
    }
    return {ok: true, value: {outcome: "imageReady", imageId: "ready", image: {width: 8, height: 8, byteLength: bytes.length, mimeType: "image/png", sha256}}};
  });
  const progress = vi.fn();
  const reply = await uploadImage({send} as unknown as LightClient, "session", prepared, new AbortController().signal, progress);
  expect(reply.imageId).toBe("ready");
  expect(data.map(chunk => chunk.length)).toEqual([32768,32768,4464]);
  expect(Uint8Array.from(data.flatMap(chunk => [...chunk]))).toEqual(bytes);
  expect(progress).toHaveBeenLastCalledWith(bytes.length);
  send.mockImplementationOnce(async () => ({ok: true, value: {outcome: "imageUploadStarted", uploadId: "upload", chunkBytes: 32768}})).mockImplementationOnce(async () => ({ok: true, value: {outcome: "imageChunkAccepted", offset: 0}}));
  await expect(uploadImage({send} as unknown as LightClient, "session", prepared, new AbortController().signal, progress)).rejects.toThrow(/position changed/);
});

it("uses protocol3 for typed images and preserves protocol2 for normal commands", async () => {
  const request = vi.fn(async (path: string) => Response.json(path === "/session" ? {sessionId: "browser", sessionToken: "token", csrfToken: "csrf", protocolVersion: 2} : {result: {outcome: "ok"}}));
  const client = new LightClient({transport: {request, openEvents: vi.fn()}});
  await client.resume();
  await client.send({kind: "startImageUpload", sessionId: "s", byteLength: 8, sha256: "a".repeat(64)});
  expect(JSON.parse((request.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string).protocolVersion).toBe(3);
  await client.send({kind: "bootstrap"});
  expect(JSON.parse((request.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string).protocolVersion).toBe(2);
  client.dispose();
});

it("verifies the full restored image hash and rejects corrupted chunks", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const sha256 = await digest();
  let corrupt = false;
  const send = vi.fn(async (operation: any) => {
    const value = bytes.slice(operation.offset, operation.offset + 32768);
    if (corrupt) value[0] ^= 1;
    return {ok: true, value: {outcome: "imageChunk", sha256, offset: operation.offset, data: btoa(String.fromCharCode(...value)), nextOffset: operation.offset + value.length, totalBytes: bytes.length}};
  });
  const descriptor = {byteLength: bytes.length, mimeType: "image/png" as const, width: 8, height: 8, sha256};
  expect((await readImage({send} as unknown as LightClient, "session", descriptor, new AbortController().signal)).size).toBe(bytes.length);
  corrupt = true;
  await expect(readImage({send} as unknown as LightClient, "session", descriptor, new AbortController().signal)).rejects.toThrow("image_hash_mismatch");
});

it("limits concurrent image reads to two and cancels queued reads without starving later work", async () => {
  const finish: Array<() => void> = [];
  let active = 0; let maximum = 0;
  const run = () => {active++; maximum = Math.max(maximum, active); return new Promise<void>(resolve => finish.push(() => {active--; resolve();}));};
  const controller = new AbortController();
  const first = withImageReadSlot(new AbortController().signal, run);
  const second = withImageReadSlot(new AbortController().signal, run);
  const third = withImageReadSlot(controller.signal, run);
  const cancelled = expect(third).rejects.toMatchObject({name: "AbortError"});
  controller.abort(); await cancelled;
  finish.shift()!(); finish.shift()!(); await first; await second;
  expect(maximum).toBe(2);
  await withImageReadSlot(new AbortController().signal, async () => {});
});
