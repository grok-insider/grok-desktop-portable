import { describe, expect, it } from "vitest";
import type { SessionDiagnosis } from "./outcomes";
import {
  canApplyRepair,
  diagnosisForSession,
  retainDiagnoses,
  storeDiagnosis,
} from "./sessionDiagnosis";

const corruptA: SessionDiagnosis = {
  sessionId: "s-a",
  status: "corrupt",
  report: {
    repaired: true,
    dryRun: true,
    resident: true,
    duplicatesRemoved: 1,
    syntheticResultsInserted: 0,
    strippedToolResultIds: ["t-1"],
  },
};

const healthyB: SessionDiagnosis = {
  sessionId: "s-b",
  status: "healthy",
};

describe("diagnosisForSession", () => {
  it("shows only the active conversation's diagnosis", () => {
    const map = storeDiagnosis({}, "s-a", corruptA);
    expect(diagnosisForSession(map, "s-a", false)?.sessionId).toBe("s-a");
    expect(diagnosisForSession(map, "s-b", false)).toBeNull();
  });

  it("hides diagnosis while a session is loading", () => {
    const map = storeDiagnosis({}, "s-a", corruptA);
    expect(diagnosisForSession(map, "s-a", true)).toBeNull();
  });

  it("rejects a map entry whose sessionId does not match the key", () => {
    // A mis-keyed record must not authorize recovery for the wrong conversation.
    const map = { "s-b": corruptA };
    expect(diagnosisForSession(map, "s-b", false)).toBeNull();
  });
});

describe("canApplyRepair", () => {
  it("requires dry-run corrupt diagnosis for the same session", () => {
    expect(canApplyRepair(corruptA, "s-a")).toBe(true);
    expect(canApplyRepair(corruptA, "s-b")).toBe(false);
    expect(canApplyRepair(healthyB, "s-b")).toBe(false);
    expect(canApplyRepair(null, "s-a")).toBe(false);
  });
});

describe("storeDiagnosis", () => {
  it("keys the record by the session that was diagnosed", () => {
    const map = storeDiagnosis({}, "s-a", {
      ...corruptA,
      sessionId: "wrong",
    });
    expect(map["s-a"]?.sessionId).toBe("s-a");
    expect(map["wrong"]).toBeUndefined();
  });
});

describe("retainDiagnoses", () => {
  it("drops closed conversations", () => {
    let map = storeDiagnosis({}, "s-a", corruptA);
    map = storeDiagnosis(map, "s-b", healthyB);
    map = retainDiagnoses(map, new Set(["s-b"]));
    expect(map["s-a"]).toBeUndefined();
    expect(map["s-b"]?.status).toBe("healthy");
  });
});
