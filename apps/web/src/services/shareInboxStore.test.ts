import { describe, expect, it, vi } from "vitest";
import { SHARE_BODY_BYTES, parseSharedRequest, enqueueSharedContent } from "./shareInboxStore.js";

function request(body: URLSearchParams | string, headers?: Record<string, string>) {
  return new Request("https://remote.example/share-inbox", {method: "POST", body, headers});
}

describe("shared content boundaries", () => {
  it("parses UTF8 text and URL without fetching or sending either", async () => {
    const content = await parseSharedRequest(request(new URLSearchParams({title: "Title", text: "🙂\nreview", url: "https://example.com/path"})));
    expect(content).toEqual({title: "Title", text: "🙂\nreview", url: "https://example.com/path", files: []});
  });
  it("rejects empty and duplicate fields rather than silently choosing one", async () => {
    await expect(parseSharedRequest(request(new URLSearchParams()))).rejects.toThrow("empty_share");
    await expect(parseSharedRequest(request(new URLSearchParams([["text", "first"], ["text", "second"]])))).rejects.toThrow("invalid_share");
  });
  it("bounds UTF8 field size separately from the multipart body", async () => {
    await expect(parseSharedRequest(request(new URLSearchParams({text: "🙂".repeat(33_000)})))).rejects.toThrow("share_too_large");
  });
  it("rejects an advertised oversized body before reading it", async () => {
    const read = vi.fn();
    const synthetic = {headers: new Headers({"content-length": String(SHARE_BODY_BYTES + 1)}), body: {getReader: read}} as unknown as Request;
    await expect(parseSharedRequest(synthetic)).rejects.toThrow("share_too_large");
    expect(read).not.toHaveBeenCalled();
  });
  it("cancels a chunked request as soon as it crosses the raw body cap", async () => {
    const cancel = vi.fn();
    let count = 0;
    const reader = {read: vi.fn(async () => ({done: false, value: new Uint8Array(count++ === 0 ? SHARE_BODY_BYTES : 1)})), cancel, releaseLock: vi.fn()};
    const synthetic = {headers: new Headers({"content-type": "multipart/form-data; boundary=test"}), body: {getReader: () => reader}} as unknown as Request;
    await expect(parseSharedRequest(synthetic)).rejects.toThrow("share_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
  it("rejects oversized direct storage inputs without opening IndexedDB", async () => {
    await expect(enqueueSharedContent({title: "", text: "x".repeat(129 * 1024), url: "", files: []})).rejects.toThrow("invalid_share");
  });
});
