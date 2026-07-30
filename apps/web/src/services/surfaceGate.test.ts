import { describe, expect, it } from "vitest";
import {
  probeAfterHostGone,
  probeAfterSessionLoss,
  shouldDemoteFromWork,
  shouldShowWork,
} from "./surfaceGate";

describe("shouldShowWork", () => {
  it("is false for every non-ready probe, even if paired flags are true", () => {
    expect(shouldShowWork({ kind: "checking" }, true)).toBe(false);
    expect(shouldShowWork({ kind: "bridge_missing" }, true)).toBe(false);
    expect(shouldShowWork({ kind: "blocked_lna" }, false)).toBe(false);
    expect(shouldShowWork({ kind: "needs_pairing" }, false)).toBe(false);
    expect(shouldShowWork({ kind: "error", message: "x" }, true)).toBe(false);
  });

  it("is true only when ready and paired", () => {
    expect(shouldShowWork({ kind: "ready" }, true)).toBe(true);
    expect(shouldShowWork({ kind: "ready" }, false)).toBe(false);
  });
});

describe("probeAfterSessionLoss", () => {
  it("maps not_paired and rejected to needs_pairing", () => {
    expect(probeAfterSessionLoss({ kind: "not_paired" })).toEqual({
      kind: "needs_pairing",
    });
    expect(probeAfterSessionLoss({ kind: "rejected" })).toEqual({
      kind: "needs_pairing",
    });
  });

  it("maps unreachable to bridge_missing", () => {
    expect(probeAfterSessionLoss({ kind: "unreachable" })).toEqual({
      kind: "bridge_missing",
    });
  });

  it("maps protocol_mismatch to error", () => {
    const state = probeAfterSessionLoss({
      kind: "protocol_mismatch",
      hostVersion: 9,
    });
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toMatch(/9/);
    }
  });
});

describe("probeAfterHostGone", () => {
  it("is bridge_missing", () => {
    expect(probeAfterHostGone()).toEqual({ kind: "bridge_missing" });
  });
});

describe("shouldDemoteFromWork", () => {
  it("demotes pairing and reachability failures", () => {
    expect(shouldDemoteFromWork({ kind: "not_paired" })).toBe(true);
    expect(shouldDemoteFromWork({ kind: "unreachable" })).toBe(true);
    expect(shouldDemoteFromWork({ kind: "rejected" })).toBe(true);
    expect(
      shouldDemoteFromWork({ kind: "protocol_mismatch", hostVersion: 1 }),
    ).toBe(true);
  });

  it("keeps ordinary refusals in-shell", () => {
    expect(shouldDemoteFromWork({ kind: "refused", code: "busy" })).toBe(false);
    expect(shouldDemoteFromWork({ kind: "bad_request" })).toBe(false);
  });
});
