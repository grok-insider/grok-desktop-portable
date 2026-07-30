/**
 * Dispatch outcomes, as the host serialises them.
 *
 * Mirrors `DispatchOutcome` in `crates/grok-bridge/src/dispatch.rs`. A
 * workspace here is an opaque id and a label; the host never sends a path.
 */

import type { ClientFailure } from "./client";
import { PROTOCOL_VERSION, type ChangeMode } from "./protocol";

/** A workspace as the browser sees it. */
export interface WorkspaceProjection {
  id: string;
  displayName: string;
  available: boolean;
  sessionCount?: number;
  lastActiveAt?: string;
}

/**
 * A project the user opened in Light, with its session-store activity.
 *
 * Only enrolled directories are projected (light ADR 0014), so `workspaceId`
 * is always present. Opaque ids only — never a filesystem path (light ADR
 * 0009).
 */
export interface ProjectProjection {
  projectId: string;
  displayName: string;
  sessionCount: number;
  lastActiveAt: string;
  available: boolean;
  workspaceId: string;
}

/** One Grok Build session for a workspace — metadata only, never a path. */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * An effect the host could not confirm.
 *
 * It names the operation and why it is unresolved, and nothing else. Light
 * cannot tell whether the effect happened, so it must not offer to retry or
 * undo it — only to say it has been seen.
 */
export interface ReviewProjection {
  recordId: string;
  operation: string;
  /** The conversation it belonged to, when it belonged to one. */
  sessionId?: string | null;
  cause: string;
}

/** Why the host cannot say whether an effect took place. */
export function reviewCauseMessage(cause: string): string {
  switch (cause) {
    case "controller_lost":
      return "the controlling tab went away while a permission was waiting";
    case "agent_exit":
      return "the Grok Build CLI exited mid-turn";
    case "host_restart":
      return "the host restarted after recording it";
    case "decision_timeout":
      return "a decision timed out before its result could be confirmed";
    default:
      return "the host could not confirm what happened";
  }
}

/**
 * One open conversation as the host projects it.
 *
 * Ordered by `openedAtMs` so a row never moves because another conversation
 * spoke; activity is shown in the row, not by its position.
 */
export interface SessionProjection {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  running: boolean;
  /** Prompts waiting for the turn in flight, in the order they were sent. */
  queued?: { entryId: string; text: string }[];
  openedAtMs: number;
  /** Whether this conversation is waiting on a decision from the user. */
  awaitingDecision?: boolean;
}

/** One category contributing to the current context window. */
export interface ContextCategoryProjection {
  label: string;
  tokens: number;
  detail?: string;
}

/** Current context-window state for one open session. */
export interface SessionContextProjection {
  used: number;
  total: number;
  free: number;
  usagePercent: number;
  autoCompactThresholdPercent: number;
  compactionCount: number;
  turnCount: number;
  toolCallCount: number;
  messageCount: number;
  systemPromptTokens: number;
  toolDefinitionTokens: number;
  categories: ContextCategoryProjection[];
}

/** Cumulative usage the qualified CLI can account for. */
export interface SessionUsageProjection {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;
  numTurns: number;
  apiDurationMs: number;
  /** Trustworthy USD cost only. Absence never means free. */
  costUsd?: number;
  incomplete: boolean;
}

/** Session-scoped data shown in the Context tab. */
export interface SessionInspectorProjection {
  sessionId: string;
  agentName?: string;
  model?: string;
  modelDisplayName?: string;
  turns: number;
  turnIndex: number;
  context?: SessionContextProjection;
  usage?: SessionUsageProjection;
  availableChangeModes: ChangeMode[];
  currentBranch?: string;
  defaultBranch?: string;
}

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked";

export type StageState = "staged" | "unstaged" | "mixed";
export type PatchState = "complete" | "binary" | "tooLarge" | "unavailable";

/** One workspace-relative changed file and its complete bounded patch. */
export interface ChangedFileProjection {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
  stage?: StageState;
  additions: number;
  deletions: number;
  patch?: string;
  patchState: PatchState;
}

/** One host-resolved, bounded change comparison. */
export interface SessionChangesProjection {
  sessionId: string;
  mode: ChangeMode;
  comparison: string;
  files: ChangedFileProjection[];
  additions: number;
  deletions: number;
  complete: boolean;
  omittedFiles: number;
}

/**
 * An MCP server the user's Grok Build is configured with.
 *
 * Name and state only. The host never sends an address, a command, or a
 * header, because that file holds the user's credentials.
 */
export interface Integration {
  name: string;
  enabled: boolean;
  transport: "remote" | "local";
}

/** What the host did with a command. */
export type DispatchOutcome =
  | { outcome: "projection"; operation: string }
  | {
      outcome: "workspaces";
      workspaces: WorkspaceProjection[];
      projects?: ProjectProjection[];
      openSessions: SessionProjection[];
      integrations?: Integration[];
      pendingReviews: ReviewProjection[];
    }
  | { outcome: "sessionCreated"; sessionId: string }
  | {
      outcome: "sessions";
      workspaceId: string;
      sessions: SessionSummary[];
    }
  | {
      outcome: "models";
      models: import("./models").ModelProjection[];
      defaultModelId?: string | null;
    }
  | {
      outcome: "tools";
      tools: ToolProjection[];
    }
  | {
      outcome: "context";
      workspaceId: string;
      entries: ContextEntry[];
    }
  | { outcome: "sessionInspector"; inspector: SessionInspectorProjection }
  | {
      outcome: "sessionChanges";
      sessionId: string;
      mode: ChangeMode;
      changes?: SessionChangesProjection;
    }
  | {
      outcome: "modelSet";
      sessionId: string;
      modelId: string;
      reasoningEffort?: string | null;
    }
  | { outcome: "promptAccepted" }
  | { outcome: "permissionAnswered"; optionId: string }
  | { outcome: "cancelled" }
  | { outcome: "closed" }
  | { outcome: "acknowledged" }
  | { outcome: "pickerOpened" }
  | {
      outcome: "hostStatus";
      cliVersion?: string | null;
      cliQualified: boolean;
      minCliVersion: string;
      cliReason?: string | null;
    }
  | {
      outcome: "sessionDiagnosis";
      diagnosis: SessionDiagnosis;
    }
  | {
      outcome: "sessionRepair";
      report: RepairReport;
    };

/** Closed diagnosis of tool-pairing history (light ADR 0015). */
export type DiagnosisStatus = "healthy" | "corrupt" | "unsupported";

/** Bounded repair report from the host — counts only, never history bodies. */
export interface RepairReport {
  repaired: boolean;
  dryRun: boolean;
  resident: boolean;
  duplicatesRemoved: number;
  syntheticResultsInserted: number;
  strippedToolResultIds: string[];
}

/** Host diagnosis of one session's pairing integrity. */
export interface SessionDiagnosis {
  sessionId: string;
  status: DiagnosisStatus;
  report?: RepairReport | null;
}

/**
 * Something the user may mention, named relative to the workspace root.
 *
 * Never absolute and never containing a parent segment: the host strips its
 * own root before projecting and refuses anything it cannot express relative
 * to it (light ADR 0013).
 */
export interface ContextEntry {
  /** Workspace-relative path, `/`-separated on every platform. */
  path: string;
  kind: "file" | "directory" | string;
}

/** MCP or skill name projected by the host. */
export interface ToolProjection {
  name: string;
  kind: "mcp" | "skill" | string;
  scope: "global" | "project" | string;
  enabled: boolean;
  transport?: string | null;
}

/** Narrow an unknown response to the workspace projection. */
export function asWorkspaces(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "workspaces" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "workspaces"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "workspaces" }>;
  }
  return null;
}

/** Narrow a host-status outcome (CLI product integrity). */
export function asHostStatus(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "hostStatus" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "hostStatus"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "hostStatus" }>;
  }
  return null;
}

/** Narrow a session diagnosis outcome. */
export function asSessionDiagnosis(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "sessionDiagnosis" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "sessionDiagnosis"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "sessionDiagnosis" }>;
  }
  return null;
}

/** Narrow a session repair outcome. */
export function asSessionRepair(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "sessionRepair" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "sessionRepair"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "sessionRepair" }>;
  }
  return null;
}

/** Narrow an unknown response to a session list. */
export function asSessions(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "sessions" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "sessions"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "sessions" }>;
  }
  return null;
}

/** Narrow an unknown response to a models list. */
export function asModels(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "models" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "models"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "models" }>;
  }
  return null;
}

/** Narrow an unknown response to tools. */
export function asTools(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "tools" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "tools"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "tools" }>;
  }
  return null;
}

/** Narrow an unknown response to the mention-context projection. */
export function asContext(
  value: unknown,
): Extract<DispatchOutcome, { outcome: "context" }> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "context"
  ) {
    return value as Extract<DispatchOutcome, { outcome: "context" }>;
  }
  return null;
}

const CHANGE_MODES = ["git", "branch", "lastTurn"] as const;
const CHANGE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typeChanged",
  "untracked",
] as const;
const STAGE_STATES = ["staged", "unstaged", "mixed"] as const;
const PATCH_STATES = ["complete", "binary", "tooLarge", "unavailable"] as const;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_PATCH_LINES = 5_000;
const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function hasOptionalString(
  value: Record<string, unknown>,
  key: string,
  max: number,
): boolean {
  return value[key] === undefined || isBoundedString(value[key], max);
}

function isOpaqueId(value: unknown): value is string {
  return (
    isBoundedString(value, 128) &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isChangeMode(value: unknown): value is ChangeMode {
  return CHANGE_MODES.some((mode) => mode === value);
}

function isRelativePath(value: unknown): value is string {
  if (!isBoundedString(value, 256) || value.includes("\\") || value.startsWith("/")) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContextProjection(value: unknown): value is SessionContextProjection {
  if (!isRecord(value)) {
    return false;
  }
  const counts = [
    "used",
    "total",
    "free",
    "usagePercent",
    "autoCompactThresholdPercent",
    "compactionCount",
    "turnCount",
    "toolCallCount",
    "messageCount",
    "systemPromptTokens",
    "toolDefinitionTokens",
  ];
  if (!counts.every((key) => isCount(value[key]))) {
    return false;
  }
  if (
    (value.usagePercent as number) > 100 ||
    (value.autoCompactThresholdPercent as number) > 100 ||
    !Array.isArray(value.categories) ||
    value.categories.length > 32
  ) {
    return false;
  }
  return value.categories.every(
    (category) =>
      isRecord(category) &&
      isBoundedString(category.label, 128) &&
      isCount(category.tokens) &&
      hasOptionalString(category, "detail", 256),
  );
}

function isUsageProjection(value: unknown): value is SessionUsageProjection {
  if (!isRecord(value)) {
    return false;
  }
  const counts = [
    "inputTokens",
    "outputTokens",
    "cachedReadTokens",
    "reasoningTokens",
    "totalTokens",
    "modelCalls",
    "numTurns",
    "apiDurationMs",
  ];
  if (!counts.every((key) => isCount(value[key])) || typeof value.incomplete !== "boolean") {
    return false;
  }
  return (
    value.costUsd === undefined ||
    (typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0)
  );
}

function isInspectorProjection(value: unknown): value is SessionInspectorProjection {
  if (
    !isRecord(value) ||
    !isOpaqueId(value.sessionId) ||
    !isCount(value.turns) ||
    !isCount(value.turnIndex) ||
    !hasOptionalString(value, "agentName", 128) ||
    !hasOptionalString(value, "model", 128) ||
    !hasOptionalString(value, "modelDisplayName", 128) ||
    !hasOptionalString(value, "currentBranch", 128) ||
    !hasOptionalString(value, "defaultBranch", 128) ||
    !Array.isArray(value.availableChangeModes) ||
    value.availableChangeModes.length > CHANGE_MODES.length ||
    !value.availableChangeModes.every(isChangeMode)
  ) {
    return false;
  }
  if (new Set(value.availableChangeModes).size !== value.availableChangeModes.length) {
    return false;
  }
  return (
    (value.context === undefined || isContextProjection(value.context)) &&
    (value.usage === undefined || isUsageProjection(value.usage))
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isChangedFile(value: unknown): value is ChangedFileProjection {
  if (
    !isRecord(value) ||
    !isRelativePath(value.path) ||
    !CHANGE_STATUSES.some((status) => status === value.status) ||
    !isCount(value.additions) ||
    !isCount(value.deletions) ||
    !PATCH_STATES.some((state) => state === value.patchState) ||
    (value.previousPath !== undefined && !isRelativePath(value.previousPath)) ||
    (value.stage !== undefined && !STAGE_STATES.some((stage) => stage === value.stage))
  ) {
    return false;
  }
  if (value.patchState !== "complete") {
    return value.patch === undefined;
  }
  return (
    typeof value.patch === "string" &&
    utf8Length(value.patch) <= MAX_PATCH_BYTES &&
    value.patch.split("\n").length <= MAX_PATCH_LINES
  );
}

function isChangesProjection(
  value: unknown,
  sessionId: string,
  mode: ChangeMode,
): value is SessionChangesProjection {
  if (
    !isRecord(value) ||
    value.sessionId !== sessionId ||
    value.mode !== mode ||
    !isBoundedString(value.comparison, 256) ||
    !Array.isArray(value.files) ||
    value.files.length > 200 ||
    !value.files.every(isChangedFile) ||
    !isCount(value.additions) ||
    !isCount(value.deletions) ||
    typeof value.complete !== "boolean" ||
    !isCount(value.omittedFiles)
  ) {
    return false;
  }
  const total = value.files.reduce(
    (sum, file) => sum + (file.patch === undefined ? 0 : utf8Length(file.patch)),
    0,
  );
  return total <= MAX_TOTAL_PATCH_BYTES;
}

/** Strictly narrow a session-inspector response, failing closed on any drift. */
export function asSessionInspector(
  value: unknown,
  expectedSessionId: string,
): Extract<DispatchOutcome, { outcome: "sessionInspector" }> | null {
  if (
    !isRecord(value) ||
    value.outcome !== "sessionInspector" ||
    !isInspectorProjection(value.inspector) ||
    value.inspector.sessionId !== expectedSessionId
  ) {
    return null;
  }
  return value as Extract<DispatchOutcome, { outcome: "sessionInspector" }>;
}

/** Strictly narrow one bounded change response, including every patch body. */
export function asSessionChanges(
  value: unknown,
  expectedSessionId: string,
  expectedMode: ChangeMode,
): Extract<DispatchOutcome, { outcome: "sessionChanges" }> | null {
  if (
    !isRecord(value) ||
    value.outcome !== "sessionChanges" ||
    value.sessionId !== expectedSessionId ||
    value.mode !== expectedMode ||
    (value.changes !== undefined &&
      !isChangesProjection(value.changes, expectedSessionId, expectedMode))
  ) {
    return null;
  }
  return value as Extract<DispatchOutcome, { outcome: "sessionChanges" }>;
}

/**
 * Human explanation for any failure a command can produce.
 *
 * The caller supplies what to say when the host merely refused for a reason
 * this build has no wording for, so a new host code degrades to the caller's
 * context instead of a blank.
 */
export function failureMessage(failure: ClientFailure, fallback: string): string {
  switch (failure.kind) {
    case "refused":
      return refusalMessage(failure.code);
    case "protocol_mismatch":
      return `This page speaks protocol ${PROTOCOL_VERSION} and the host speaks ${failure.hostVersion}. Reload to pick up the host's version.`;
    case "not_paired":
      return "This browser is no longer paired. Run `grok-bridge open` to pair it again.";
    case "unreachable":
      return "The local host stopped responding. Start it with `grok-bridge serve`.";
    default:
      return fallback;
  }
}

/** Human explanation for a refusal code the host returned. */
export function refusalMessage(code: string): string {
  switch (code) {
    case "unknown_workspace":
      return "That workspace is no longer enrolled.";
    case "queue_full":
      return "Too many messages are already waiting in this conversation.";
    case "unknown_queue_entry":
      return "That message has already been sent or removed.";
    case "too_many_sessions":
      return "Too many conversations are open. Close one to start another.";
    case "unknown_session":
      return "That conversation is no longer open. It may have been closed in another tab.";
    case "unknown_review_record":
      return "That record has already been reviewed.";
    case "session_already_active":
      return "That conversation is already open.";
    case "no_session":
      return "No agent session is open yet.";
    case "agent_failed":
      return "The Grok Build CLI stopped responding. Check it is installed and authenticated.";
    case "unsupported":
      return "Your Grok Build CLI does not support this yet. Updating it should add it.";
    case "intent_not_durable":
      return "The host could not record this before running it, so nothing ran. Check its state directory is writable.";
    case "already_completed":
      return "That action was already carried out.";
    case "not_replayable":
      return "That action was interrupted and will not be retried automatically.";
    case "permission_not_answerable":
      return "Grok Light cannot answer that permission option.";
    case "picker_already_open":
      return "A directory picker is already open. Finish or close it first.";
    case "unknown_permission":
      return "That permission request is no longer waiting for an answer.";
    default:
      return "The host refused the request.";
  }
}
