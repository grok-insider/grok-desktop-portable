import { describe, expect, it } from "vitest";
import { decodeAuthenticatedMessage, decodeFrame } from "./remoteConnector";

describe("authenticated host messages", () => {
  it("classifies encrypted revocation before pairing or active response dispatch", () => {
    const payload = new TextEncoder().encode(JSON.stringify({type: "closed", reason: "revoked"}));
    expect(() => decodeAuthenticatedMessage(payload)).toThrow("revoked");
  });

  it("does not call an unknown authenticated close reason a revoked device", () => {
    const payload = new TextEncoder().encode(JSON.stringify({type: "closed", reason: "restarting"}));
    expect(() => decodeAuthenticatedMessage(payload)).toThrow("host_offline");
  });

  it("preserves normal pairing and event messages", () => {
    for (const message of [{type: "paired", body: {protocolVersion: 2}}, {type: "event", event: {eventSequence: 1}}]) {
      expect(decodeAuthenticatedMessage(new TextEncoder().encode(JSON.stringify(message)))).toEqual(message);
    }
  });
});

describe("Noise relay frame boundary", () => {
  it("preserves every octet including zero and non-UTF8 bytes", () => {
    const bytes = Uint8Array.from({length: 256}, (_, index) => index);
    const encoded = btoa(String.fromCharCode(...bytes));
    expect(decodeFrame(encoded)).toEqual(bytes);
  });

  it("accepts exactly the Noise maximum and rejects larger allocations", () => {
    expect(decodeFrame(btoa("a".repeat(65_535)))).toHaveLength(65_535);
    expect(() => decodeFrame(btoa("a".repeat(65_536)))).toThrow("protocol_error");
  });

  it("rejects whitespace, non-base64, misplaced padding and broken encoding", () => {
    for (const value of ["Y Q==", "YQ==\n", "data:;base64,YQ==", "Y=Q=", "@@@@", "Y", "YQ===", "💥"]) expect(() => decodeFrame(value)).toThrow();
  });
});
