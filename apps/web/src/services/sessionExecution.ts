import type { ImageDescriptor, Operation } from "./protocol";
import type { EffortOption, ModelProjection } from "./models";

export interface SessionExecution {
  outcome: "sessionExecution";
  sessionId: string;
  revision: number;
  paused: boolean;
  uncertain: boolean;
  externalTurnRunning?: boolean;
  canCancelTurn?: boolean;
  activeTurn?: {turnId: string; state: "starting" | "running" | "cancelling" | "uncertain"; originDeviceId: string} | null;
  queue: {entryId: string; text: string; originDeviceId: string; state: "pending" | "originRevoked"; images: ImageDescriptor[]}[];
}

export interface SessionModels {
  outcome: "sessionModels";
  sessionId: string;
  revision: number;
  source: "live" | "unavailable";
  currentModel?: string | null;
  selectableModels: ModelProjection[];
  currentEffort?: string | null;
  effortOptions: EffortOption[];
  canSetModel: boolean;
  canSetEffort: boolean;
  uncertain: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const optionalId = (value: unknown) => value === undefined || value === null || id(value);
const effort = (value: unknown) => record(value) && id(value.id) && typeof value.label === "string" && value.label.length <= 512;
const image = (value: unknown) => record(value) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && typeof value.mimeType === "string" && ["image/png", "image/jpeg"].includes(value.mimeType) && [value.byteLength, value.width, value.height].every(v => revision(v) && v > 0);

export function asSessionExecution(value: unknown): SessionExecution | null {
  if (!record(value) || value.outcome !== "sessionExecution" || !id(value.sessionId) || !revision(value.revision) || typeof value.paused !== "boolean" || typeof value.uncertain !== "boolean") return null;
  const turn = value.activeTurn;
  if ([value.externalTurnRunning, value.canCancelTurn].some(field => field !== undefined && typeof field !== "boolean")) return null;
  if (turn !== undefined && turn !== null && (!record(turn) || !id(turn.turnId) || !id(turn.originDeviceId) || (typeof turn.state !== "string" || !["starting", "running", "cancelling", "uncertain"].includes(turn.state)))) return null;
  if (!Array.isArray(value.queue) || value.queue.length > 16 || !value.queue.every(entry => record(entry) && id(entry.entryId) && typeof entry.text === "string" && id(entry.originDeviceId) && typeof entry.state === "string" && ["pending", "originRevoked"].includes(entry.state) && Array.isArray(entry.images) && entry.images.length <= 8 && entry.images.every(image))) return null;
  if (new Set(value.queue.map(entry => entry.entryId)).size !== value.queue.length) return null;
  return value as unknown as SessionExecution;
}

export function asSessionModels(value: unknown): SessionModels | null {
  if (!record(value) || value.outcome !== "sessionModels" || !id(value.sessionId) || !revision(value.revision) || (typeof value.source !== "string" || !["live", "unavailable"].includes(value.source)) || !optionalId(value.currentModel) || !optionalId(value.currentEffort) || [value.canSetModel, value.canSetEffort, value.uncertain].some(v => typeof v !== "boolean")) return null;
  if (!Array.isArray(value.effortOptions) || value.effortOptions.length > 64 || !value.effortOptions.every(effort)) return null;
  if (!Array.isArray(value.selectableModels) || value.selectableModels.length > 128 || !value.selectableModels.every(model => record(model) && id(model.id) && typeof model.name === "string" && model.name.length <= 512 && typeof model.supportsReasoningEffort === "boolean" && Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length <= 64 && model.reasoningEfforts.every(effort) && optionalId(model.defaultEffort))) return null;
  if (new Set(value.selectableModels.map(model => model.id)).size !== value.selectableModels.length || new Set(value.effortOptions.map(option => option.id)).size !== value.effortOptions.length) return null;
  return value as unknown as SessionModels;
}

export function stopCurrentTurn(execution: SessionExecution): Operation | null {
  if (!execution.activeTurn || !["starting", "running"].includes(execution.activeTurn.state) || execution.uncertain || execution.canCancelTurn === false) return null;
  return {kind: "cancelSessionTurn", sessionId: execution.sessionId, expectedTurnId: execution.activeTurn.turnId, queueDisposition: "pause"};
}

export function canChangeConfiguration(execution: SessionExecution | undefined, models: SessionModels | undefined): boolean {
  return Boolean(execution && models && !execution.uncertain && !models.uncertain && !execution.activeTurn && !execution.externalTurnRunning && (execution.paused || execution.queue.length === 0));
}
