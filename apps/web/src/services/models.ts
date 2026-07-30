/**
 * Client-side model catalog helpers (Grok-only filter is enforced on the host;
 * these helpers shape UI state from host projections).
 */

export interface EffortOption {
  id: string;
  label: string;
}

export interface ModelProjection {
  id: string;
  name: string;
  supportsReasoningEffort: boolean;
  reasoningEfforts: EffortOption[];
  defaultEffort?: string | null;
}

/** Effort options for the selected model, or empty when unsupported. */
export function effortsForModel(
  models: ModelProjection[],
  modelId: string | null,
): EffortOption[] {
  if (modelId === null) {
    return [];
  }
  const model = models.find((entry) => entry.id === modelId);
  if (model === undefined || !model.supportsReasoningEffort) {
    return [];
  }
  return model.reasoningEfforts;
}

/** Pick a default model id from catalog + host default. */
export function pickDefaultModelId(
  models: ModelProjection[],
  hostDefault: string | null | undefined,
): string | null {
  if (hostDefault !== undefined && hostDefault !== null) {
    if (models.some((model) => model.id === hostDefault)) {
      return hostDefault;
    }
  }
  return models[0]?.id ?? null;
}

/** Default effort for a model, if any. */
export function pickDefaultEffort(
  models: ModelProjection[],
  modelId: string | null,
): string | null {
  if (modelId === null) {
    return null;
  }
  const model = models.find((entry) => entry.id === modelId);
  if (model === undefined) {
    return null;
  }
  if (model.defaultEffort !== undefined && model.defaultEffort !== null) {
    return model.defaultEffort;
  }
  return model.reasoningEfforts[0]?.id ?? null;
}
