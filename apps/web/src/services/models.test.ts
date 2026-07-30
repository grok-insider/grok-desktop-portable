import { describe, expect, it } from "vitest";
import {
  effortsForModel,
  pickDefaultEffort,
  pickDefaultModelId,
  type ModelProjection,
} from "./models";

const CATALOG: ModelProjection[] = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    supportsReasoningEffort: true,
    reasoningEfforts: [
      { id: "high", label: "High" },
      { id: "low", label: "Low" },
    ],
    defaultEffort: "high",
  },
  {
    id: "grok-build",
    name: "Grok Build",
    supportsReasoningEffort: false,
    reasoningEfforts: [],
  },
];

describe("models helpers", () => {
  it("exposes efforts only when the model supports them", () => {
    expect(effortsForModel(CATALOG, "grok-4.5")).toHaveLength(2);
    expect(effortsForModel(CATALOG, "grok-build")).toHaveLength(0);
    expect(effortsForModel(CATALOG, null)).toHaveLength(0);
  });

  it("prefers the host default model when present in the catalog", () => {
    expect(pickDefaultModelId(CATALOG, "grok-build")).toBe("grok-build");
    expect(pickDefaultModelId(CATALOG, "claude-opus")).toBe("grok-4.5");
    expect(pickDefaultModelId([], null)).toBeNull();
  });

  it("picks the model default effort", () => {
    expect(pickDefaultEffort(CATALOG, "grok-4.5")).toBe("high");
    expect(pickDefaultEffort(CATALOG, "grok-build")).toBeNull();
  });
});
