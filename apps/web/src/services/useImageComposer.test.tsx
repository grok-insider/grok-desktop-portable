import {act, renderHook} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {LightClient} from "./client";
import {useCommandReceipts} from "./commandReceipts";
import {prepareImage, uploadImage} from "./imageUploads";
import {useImageComposer} from "./useImageComposer";

vi.mock("./imageUploads", async importOriginal => ({...await importOriginal<typeof import("./imageUploads")>(), prepareImage: vi.fn(), uploadImage: vi.fn()}));

afterEach(() => {sessionStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals();});

function setup(reply: unknown) {
  const send = vi.fn(async (_operation: unknown, _options?: unknown) => reply);
  const client = {send, multiWriter: true} as unknown as LightClient;
  const onSent = vi.fn();
  vi.stubGlobal("URL", class extends URL {static revokeObjectURL = vi.fn();});
  vi.mocked(prepareImage).mockResolvedValue({id: "image", name: "private.png", blob: new Blob(["picture"], {type: "image/png"}), preview: "blob:image", width: 32, height: 32});
  vi.mocked(uploadImage).mockResolvedValue({imageId: "uploaded-image", image: {byteLength: 7, mimeType: "image/png", width: 32, height: 32, sha256: "a".repeat(64)}});
  const hook = renderHook(() => {
    const receipts = useCommandReceipts(client, "computer");
    return {receipts, images: useImageComposer({client, receipts, sessionId: "session", capable: true, canSend: true, onSent})};
  });
  return {hook, send, onSent};
}

describe("image submission receipt recovery", () => {
  it.each([
    {ok: false, failure: {kind: "unreachable"}},
    {ok: false, failure: {kind: "refused", code: "result_not_durable"}},
  ])("keeps the selection and prevents another upload or prompt after uncertainty: %j", async reply => {
    const {hook, send, onSent} = setup(reply);
    await act(async () => {await hook.result.current.images.add([new File(["data"], "private.png", {type: "image/png"})]);});
    await act(async () => {await hook.result.current.images.submit("Analyze the picture", false);});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({kind: "promptContent", sessionId: "session", imageIds: ["uploaded-image"]});
    expect(hook.result.current.images.images).toHaveLength(1);
    expect(hook.result.current.receipts.pending).toEqual([expect.objectContaining({kind: "promptContent", state: "uncertain"})]);
    expect(onSent).not.toHaveBeenCalled();
    await act(async () => {await hook.result.current.images.submit("Analyze the picture", false);});
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("clears an acknowledged selection and refuses a mismatched interrupt before uploading", async () => {
    const {hook, send, onSent} = setup({ok: true, value: {outcome: "commandAccepted", state: "queued"}});
    await act(async () => {await hook.result.current.images.add([new File(["data"], "private.png")]);});
    await act(async () => {await hook.result.current.images.submit("Analyze the picture", true);});
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await act(async () => {await hook.result.current.images.submit("Analyze the picture", false);});
    expect(hook.result.current.images.images).toEqual([]);
    expect(hook.result.current.receipts.pending).toEqual([]);
    expect(onSent).toHaveBeenCalledWith("session", "Analyze the picture");
    hook.unmount();
  });

  it("does not start uploading when a reloaded action has an unresolved receipt", async () => {
    sessionStorage.setItem("grok-command-receipts.v1:computer", JSON.stringify([{key: "previous", sessionId: "session", kind: "promptContent", state: "sending", createdAt: 1}]));
    const {hook, send} = setup({ok: true});
    await act(async () => {await hook.result.current.images.add([new File(["data"], "private.png")]);});
    await act(async () => {await hook.result.current.images.submit("Analyze the picture", false);});
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(hook.result.current.images.images).toHaveLength(1);
    hook.unmount();
  });
});
