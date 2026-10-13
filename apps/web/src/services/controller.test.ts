import { describe, expect, it } from "vitest";
import { controllerEpochAfterStatus } from "./controller";

describe("controller lease status", () => {
  it("retains the lease during an ACP restart and replay of lifecycle events", () => {
    let epoch = controllerEpochAfterStatus(undefined, "controlling:27");
    for (const status of ["agent_ready", "agent_restarting", "agent_ready"]) {
      epoch = controllerEpochAfterStatus(epoch, status);
      expect(epoch).toBe(27);
    }
  });

  it("revokes control only on watching and accepts a newly acquired epoch", () => {
    expect(controllerEpochAfterStatus(27, "watching")).toBeUndefined();
    expect(controllerEpochAfterStatus(undefined, "agent_ready")).toBeUndefined();
    expect(controllerEpochAfterStatus(27, "controlling:28")).toBe(28);
  });
});
