import {Blob as NativeBlob} from "node:buffer";
import {act, renderHook, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {useImageComposer} from "../src/services/useImageComposer";
import {CommandReceiptStore} from "../src/services/commandReceipts";
import {DraftStore, forgetDraftScope} from "../src/services/drafts";
import {cropImage, prepareImage, uploadImage, type PreparedImage} from "../src/services/imageUploads";
import type {LightClient} from "../src/services/client";

vi.mock("../src/services/imageUploads", async original => ({...await original<object>(), cropImage: vi.fn(), prepareImage: vi.fn(), uploadImage: vi.fn()}));
const file = new File(["synthetic"], "test.png", {type: "image/png"});
const image = (): PreparedImage => ({id: crypto.randomUUID(), name: "test.png", width: 64, height: 64, blob: new NativeBlob([new Uint8Array(32)], {type: "image/png"}) as unknown as Blob, preview: "blob:synthetic"});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
function inputs() {
  const client = {send: vi.fn().mockResolvedValue({ok: true, value: {outcome: "promptAccepted"}})} as unknown as LightClient;
  return {client, receipts: new CommandReceiptStore(client, "computer"), sessionId: "A", scope: "computer", capable: true, canSend: true, onSent: vi.fn()};
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:recovered"), revokeObjectURL: vi.fn()}));
  vi.mocked(prepareImage).mockImplementation(async () => image());
  vi.mocked(cropImage).mockImplementation(async () => ({...image(), width: 32, height: 32, preview: "blob:crop"}));
  vi.mocked(uploadImage).mockResolvedValue({imageId: "host-image", image: {sha256: "a".repeat(64), mimeType: "image/png", byteLength: 32, width: 8, height: 8}});
});
afterEach(() => {vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();});

it("keeps selection by conversation and sends only after an explicit submit", async () => {
  const initial = inputs();
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  expect(initial.client.send).not.toHaveBeenCalled();
  hook.rerender({...initial, sessionId: "B"});
  expect(hook.result.current.images).toEqual([]);
  hook.rerender(initial);
  expect(hook.result.current.images).toHaveLength(1);
  await act(async () => hook.result.current.submit("  describe  ", false));
  expect(initial.client.send).toHaveBeenCalledWith({kind: "promptContent", sessionId: "A", text: "describe", imageIds: ["host-image"], sendNow: false}, {idempotencyKey: expect.any(String)});
  expect(hook.result.current.images).toEqual([]);
  expect(initial.onSent).toHaveBeenCalledWith("A", "  describe  ");
});

it("never copies image drafts across computer identity changes", async () => {
  const initial = inputs();
  await new DraftStore("computer").enable();
  await new DraftStore("other").enable();
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  await act(async () => hook.result.current.add([file]));
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  hook.rerender({...initial, scope: "other"});
  expect(hook.result.current.images).toEqual([]);
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  expect((await new DraftStore("other").readImages()).images).toEqual({});
  expect((await new DraftStore("computer").readImages()).images.A).toHaveLength(1);
});

it("does not resurrect images if pairing is revoked while decoding", async () => {
  const pending = deferred<PreparedImage>();
  vi.mocked(prepareImage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(useImageComposer, {initialProps: inputs()});
  let adding!: Promise<boolean>;
  act(() => {adding = hook.result.current.add([file]);});
  await act(async () => forgetDraftScope("computer"));
  await act(async () => {pending.resolve(image()); await adding;});
  expect(hook.result.current.images).toEqual([]);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
});

it.each(["canSend", "capable"] as const)("aborts upload on loss of %s, retains drafts and never dispatches", async key => {
  const initial = inputs();
  const pending = deferred<Awaited<ReturnType<typeof uploadImage>>>();
  let signal!: AbortSignal;
  vi.mocked(uploadImage).mockImplementationOnce((_client, _session, _image, value) => {signal = value; return pending.promise;});
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  let sending!: Promise<void>;
  act(() => {sending = hook.result.current.submit("describe", false);});
  hook.rerender({...initial, [key]: false});
  expect(signal.aborted).toBe(true);
  await act(async () => {pending.resolve({imageId: "host-image", image: {sha256: "a".repeat(64), mimeType: "image/png", byteLength: 32, width: 8, height: 8}}); await sending;});
  expect(initial.client.send).toHaveBeenCalledTimes(1);
  expect(initial.client.send).toHaveBeenCalledWith({kind: "discardImage", imageId: "host-image"});
  expect(hook.result.current.images).toHaveLength(1);
  expect(hook.result.current.error).toMatch(/no message was resent/);
});

it("preserves an ambiguous prompt and does not discard possibly accepted images", async () => {
  const initial = inputs();
  vi.mocked(initial.client.send).mockResolvedValue({ok: false, failure: {kind: "unreachable"}});
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  await act(async () => hook.result.current.submit("describe", false));
  expect(initial.client.send).toHaveBeenCalledTimes(1);
  expect(hook.result.current.images).toHaveLength(1);
  expect(hook.result.current.error).toMatch(/uncertain/);
  expect(initial.onSent).not.toHaveBeenCalled();
});

it("requires consent for blob recovery and preserves memory when consent is disabled", async () => {
  const initial = inputs();
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  expect((await new DraftStore("computer").readImages()).images).toEqual({});
  await act(async () => new DraftStore("computer").enable());
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  hook.unmount();
  const restored = renderHook(useImageComposer, {initialProps: initial});
  await waitFor(() => expect(restored.result.current.images).toHaveLength(1));
  await act(async () => new DraftStore("computer").clear(false));
  expect(restored.result.current.images).toHaveLength(1);
  expect((await new DraftStore("computer").readImages()).images).toEqual({});
  await act(async () => forgetDraftScope("computer"));
  expect(restored.result.current.images).toEqual([]);
});

it("replaces a crop locally, preserves its selection id and persists only to the current scope", async () => {
  const initial = inputs();
  await new DraftStore(initial.scope).enable();
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  await act(async () => hook.result.current.add([file]));
  const original = hook.result.current.images[0];
  await act(async () => expect(await hook.result.current.crop(original.id, {x: 0, y: 0, width: 32, height: 32})).toBe(true));
  expect(hook.result.current.images).toHaveLength(1);
  expect(hook.result.current.images[0]).toMatchObject({id: original.id, width: 32, height: 32, preview: "blob:crop"});
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(original.preview);
  expect(initial.client.send).not.toHaveBeenCalled();
  await waitFor(() => expect(hook.result.current.storage).toBe("saved"));
  expect((await new DraftStore(initial.scope).readImages()).images.A[0]).toMatchObject({id: original.id, width: 32, height: 32});
  expect((await new DraftStore("another-computer").readImages()).images).toEqual({});
});

it.each(["decode failure", "oversized crop"])("keeps the selected original and draft when cropping fails: %s", async failure => {
  const initial = inputs();
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  const original = hook.result.current.images[0];
  if (failure === "decode failure") vi.mocked(cropImage).mockRejectedValueOnce(new Error("Decode failed"));
  else vi.mocked(cropImage).mockResolvedValueOnce({...image(), preview: "blob:too-large", blob: new NativeBlob([new Uint8Array(5 * 1024 * 1024 + 1)]) as unknown as Blob});
  await act(async () => expect(await hook.result.current.crop(original.id, {x: 0, y: 0, width: 32, height: 32})).toBe(false));
  expect(hook.result.current.images[0]).toBe(original);
  expect(hook.result.current.error).toBeTruthy();
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original.preview);
  if (failure === "oversized crop") expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:too-large");
  expect(initial.client.send).not.toHaveBeenCalled();
});

it.each(["cancel", "session", "client", "revocation"])("does not commit a late crop after %s", async interruption => {
  const initial = inputs();
  const pending = deferred<PreparedImage>();
  vi.mocked(cropImage).mockReturnValueOnce(pending.promise);
  const hook = renderHook(useImageComposer, {initialProps: initial});
  await act(async () => hook.result.current.add([file]));
  const original = hook.result.current.images[0];
  const controller = new AbortController();
  let cropping!: Promise<boolean>;
  act(() => {cropping = hook.result.current.crop(original.id, {x: 0, y: 0, width: 32, height: 32}, controller.signal);});
  if (interruption === "cancel") controller.abort();
  if (interruption === "session") {hook.rerender({...initial, sessionId: "B"}); hook.rerender(initial);}
  if (interruption === "client") hook.rerender({...initial, client: inputs().client});
  if (interruption === "revocation") await act(async () => forgetDraftScope(initial.scope));
  await act(async () => {pending.resolve({...image(), preview: "blob:late-crop"}); expect(await cropping).toBe(false);});
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late-crop");
  if (interruption === "cancel" || interruption === "session") expect(hook.result.current.images[0]).toBe(original);
  else expect(hook.result.current.images).toEqual([]);
  expect(initial.client.send).not.toHaveBeenCalled();
});
