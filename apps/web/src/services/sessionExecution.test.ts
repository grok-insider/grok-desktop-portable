import {describe, expect, it} from "vitest";
import {asSessionExecution, asSessionModels, canChangeConfiguration, stopCurrentTurn, type SessionExecution} from "./sessionExecution";

const execution: SessionExecution = {outcome: "sessionExecution", sessionId: "session-a", revision: 7, paused: false, uncertain: false, queue: [], activeTurn: {turnId: "turn-1", state: "running", originDeviceId: "phone"}};
const model = {outcome: "sessionModels", sessionId: "session-a", revision: 3, source: "live", currentModel: "relay/custom", selectableModels: [{id: "relay/custom", name: "Custom", supportsReasoningEffort: true, reasoningEfforts: [{id: "balanced", label: "Balanced"}]}], currentEffort: "balanced", effortOptions: [{id: "balanced", label: "Balanced"}], canSetModel: true, canSetEffort: true, uncertain: false};

describe("multi-device session contracts", () => {
  it("binds stop to the displayed turn and preserves the pending queue", () => {
    expect(stopCurrentTurn(execution)).toEqual({kind: "cancelSessionTurn", sessionId: "session-a", expectedTurnId: "turn-1", queueDisposition: "pause"});
    expect(stopCurrentTurn({...execution, activeTurn: null})).toBeNull();
    expect(stopCurrentTurn({...execution, uncertain: true})).toBeNull();
    expect(stopCurrentTurn({...execution, activeTurn: {...execution.activeTurn!, state: "cancelling"}})).toBeNull();
  });
  it("requires an idle stable conversation and pauses a nonempty queue for configuration", () => {
    const models = asSessionModels(model)!;
    expect(models.currentModel).toBe("relay/custom");
    expect(canChangeConfiguration(execution, models)).toBe(false);
    const idle = {...execution, activeTurn: null};
    expect(canChangeConfiguration(idle, models)).toBe(true);
    const queued = {...idle, queue: [{entryId: "message-2", text: "follow-up", originDeviceId: "desktop", state: "pending" as const, images: []}]};
    expect(canChangeConfiguration(queued, models)).toBe(false);
    expect(canChangeConfiguration({...queued, paused: true}, models)).toBe(true);
    expect(canChangeConfiguration({...queued, paused: true}, {...models, uncertain: true})).toBe(false);
  });
  it("rejects malformed snapshots, duplicate entries and unsupported effort projections", () => {
    expect(asSessionExecution(execution)).not.toBeNull();
    expect(asSessionExecution({...execution, revision: Number.MAX_SAFE_INTEGER + 1})).toBeNull();
    expect(asSessionExecution({...execution, activeTurn: {...execution.activeTurn!, state: "finished"}})).toBeNull();
    expect(asSessionExecution({...execution, activeTurn: {...execution.activeTurn!, state: ["running"]}})).toBeNull();
    const row = {entryId: "queued-1", text: "one", originDeviceId: "phone", state: "pending", images: []};
    expect(asSessionExecution({...execution, queue: [row, row]})).toBeNull();
    expect(asSessionExecution({...execution, queue: [{...row, state: ["pending"]}]})).toBeNull();
    expect(asSessionModels({...model, source: ["live"]})).toBeNull();
    expect(asSessionModels({...model, effortOptions: [{id: "high"}]})).toBeNull();
    expect(asSessionModels({...model, selectableModels: [model.selectableModels[0], model.selectableModels[0]]})).toBeNull();
  });
});
