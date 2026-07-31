import { describe, expect, it } from "vitest";
import {
  formatAttachment,
  formatAttachments,
  isTextishFile,
  MAX_ATTACH_BYTES,
} from "./attachments";

function fileOf(name: string, body: string, type = "text/plain"): File {
  return new File([body], name, { type });
}

describe("attachments", () => {
  it("treats common source extensions as text even without a MIME type", () => {
    expect(isTextishFile(fileOf("App.tsx", "x", ""))).toBe(true);
    expect(isTextishFile(fileOf("photo.png", "x", "image/png"))).toBe(false);
  });

  it("fences text file content with a safe filename header", async () => {
    const snippet = await formatAttachment(fileOf("notes.md", "hello\nworld"));
    expect(snippet).toContain("Attached: `notes.md`");
    expect(snippet).toContain("```\nhello\nworld\n```");
  });

  it("base64-encodes non-text files", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const file = new File([bytes], "blob.bin", { type: "application/octet-stream" });
    const snippet = await formatAttachment(file);
    expect(snippet).toContain("Attached: `blob.bin`");
    expect(snippet).toContain("base64");
    expect(snippet).toContain(btoa(String.fromCharCode(...bytes)));
  });

  it("skips files over the per-file cap", async () => {
    const big = new File([new Uint8Array(MAX_ATTACH_BYTES + 1)], "big.txt", {
      type: "text/plain",
    });
    expect(await formatAttachment(big)).toBeNull();
    const result = await formatAttachments([big, fileOf("ok.txt", "hi")]);
    expect(result.attached).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.text).toContain("ok.txt");
  });
});
