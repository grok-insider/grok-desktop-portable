import { describe, expect, it } from "vitest";
import { commandFits, commandWireBytes, COMMAND_ID_PLACEHOLDER, MAX_COMMAND_BYTES } from "./commandSize";
import { formatAttachment } from "./attachments";
import type { CommandEnvelope } from "./protocol";

function envelope(text: string, kind: "prompt" | "sendNow" = "prompt"): CommandEnvelope {
  return {protocolVersion: 2, requestId: COMMAND_ID_PLACEHOLDER, idempotencyKey: COMMAND_ID_PLACEHOLDER, controllerEpoch: 120, operation: {kind, sessionId: "conversation", text, bash: false}};
}

describe("serialized command bounds", () => {
  it.each([false, true])("measures exact limit minus one, at limit, plus one (remote %s)", (remote) => {
    for (const kind of ["prompt", "sendNow"] as const) {
      const empty = envelope("", kind);
      const capacity = MAX_COMMAND_BYTES - commandWireBytes(empty, remote);
      for (const offset of [-1, 0, 1]) {
        const command = envelope("a".repeat(capacity + offset), kind);
        expect(commandWireBytes(command, remote)).toBe(MAX_COMMAND_BYTES + offset);
        expect(commandFits(command, remote)).toBe(offset <= 0);
      }
    }
  });
  it("includes UTF8, escaped quotes, line breaks and the encrypted channel envelope", () => {
    const command = envelope('🙂\n"\\é');
    const expected = new TextEncoder().encode(JSON.stringify({id: COMMAND_ID_PLACEHOLDER, method: "command", body: command})).length;
    expect(commandWireBytes(command, true)).toBe(expected);
    expect(commandWireBytes(command, true)).toBeGreaterThan(JSON.stringify(command).length);
  });
  it("rejects the 200 KB image after base64 expansion", async () => {
    const image = new File([new Uint8Array(200_000)], "image.png", {type: "image/png"});
    const text = await formatAttachment(image);
    expect(text).not.toBeNull();
    expect(commandFits(envelope(text!), true)).toBe(false);
  });
  it("accounts for existing draft and multiple individually accepted attachments", async () => {
    const first = await formatAttachment(new File(["a".repeat(120_000)], "first.txt", {type: "text/plain"}));
    const second = await formatAttachment(new File(["b".repeat(120_000)], "second.txt", {type: "text/plain"}));
    expect(commandFits(envelope(first!), true)).toBe(true);
    expect(commandFits(envelope(second!), true)).toBe(true);
    expect(commandFits(envelope("preface".repeat(5_000) + first + second), true)).toBe(false);
  });
});
