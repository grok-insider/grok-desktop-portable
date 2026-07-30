/**
 * `light.local.v1` — the browser half of the local protocol.
 *
 * Mirrors `crates/grok-bridge/src/protocol.rs`. The union is closed on
 * purpose: there is no operation that sends raw ACP, runs a process, edits
 * configuration, or supplies a filesystem path. A workspace is always an
 * opaque id the host resolves.
 *
 * See docs/light/protocol.md.
 */

/** Wire version this client implements. */
export const PROTOCOL_VERSION = 2;

/** WebSocket subprotocol carrying the same version. */
export const WS_SUBPROTOCOL = "light.local.v1";

/**
 * Prefix for the session token as a second WebSocket subprotocol (`gls.<hex>`).
 * Required for hosted UI: no Cookie, no custom WS headers (ADR 0016).
 */
export const WS_SESSION_PROTOCOL_PREFIX = "gls.";

/** Header carrying the per-page CSRF token on mutations. */
export const CSRF_HEADER = "x-grok-light-csrf";

/** Session token for hosted cross-origin HTTP (ADR 0016). */
export const SESSION_HEADER = "x-gl-session";

/**
 * Default loopback API base for the hosted SPA.
 * Overridable via `VITE_BRIDGE_PORT` at build time.
 */
export function defaultBridgeBaseUrl(): string {
  const port =
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    typeof import.meta.env.VITE_BRIDGE_PORT === "string" &&
    import.meta.env.VITE_BRIDGE_PORT.length > 0
      ? import.meta.env.VITE_BRIDGE_PORT
      : "";
  // When empty, same-origin (loopback fallback SPA served by the bridge).
  if (!port) {
    return "";
  }
  return `http://127.0.0.1:${port}`;
}

/** Closed set of host-owned change comparisons. */
export type ChangeMode = "git" | "branch" | "lastTurn";

/** The closed set of operations the browser may request. */
export type Operation =
  | { kind: "bootstrap" }
  | { kind: "getHostStatus" }
  | { kind: "listWorkspaces" }
  | { kind: "openWorkspacePicker" }
  | { kind: "openProject"; projectId: string }
  | { kind: "listModels" }
  | {
      kind: "setSessionModel";
      sessionId: string;
      modelId: string;
      reasoningEffort?: string;
    }
  | { kind: "listTools"; workspaceId?: string }
  /**
   * What the user may mention with `@`, for one enrolled workspace.
   *
   * The browser sends an opaque workspace id and, at most, the substring it
   * has typed. It never sends a path; the host resolves the root itself and
   * answers with workspace-relative paths only (light ADR 0013).
   */
  | { kind: "listContext"; workspaceId: string; query?: string }
  | { kind: "getSessionInspector"; sessionId: string }
  | { kind: "getSessionChanges"; sessionId: string; mode: ChangeMode }
  | { kind: "removeWorkspace"; workspaceId: string }
  | { kind: "listSessions"; workspaceId: string }
  | { kind: "loadSession"; workspaceId: string; sessionId: string }
  | { kind: "createSession"; workspaceId: string }
  | { kind: "prompt"; sessionId: string; text: string; bash?: boolean }
  | { kind: "cancelTurn"; sessionId: string }
  | { kind: "sendNow"; sessionId: string; text: string; bash?: boolean }
  | { kind: "removeQueued"; sessionId: string; entryId: string }
  | { kind: "closeSession"; sessionId: string }
  | {
      kind: "decidePermission";
      sessionId: string;
      requestId: string;
      optionId: string;
    }
  | { kind: "acknowledgeEvents"; throughSequence: number }
  | { kind: "acknowledgeInterrupted"; recordId: string }
  /** Read-only dry-run of history pairing repair (light ADR 0015). */
  | { kind: "diagnoseSession"; sessionId: string }
  /**
   * User opt-in history repair. `dryRun: true` reports only; `false` applies
   * after host-journaled intent. Never auto-runs on load.
   */
  | { kind: "repairSession"; sessionId: string; dryRun: boolean }
  | { kind: "revokeBrowserPairing"; sessionId?: string };

/**
 * One slash command the agent accepts.
 *
 * The set belongs to the agent, which republishes it as it changes, so the
 * browser is told rather than left to guess. Both fields are agent-supplied
 * and therefore untrusted: rendered as text, never as markup.
 */
export interface CommandProjection {
  /** Command name, without the leading slash. */
  name: string;
  /** One line saying what it does, when the agent supplies one. */
  description?: string | null;
}

/**
 * One step of an agent plan.
 *
 * Content is agent-supplied and rendered as text. Status is a closed set
 * projected by the host (`pending` | `in_progress` | `completed`).
 */
export interface PlanEntryProjection {
  content: string;
  status: string;
}

/** A command as sent to the host. */
export interface CommandEnvelope {
  protocolVersion: number;
  requestId: string;
  idempotencyKey?: string;
  controllerEpoch?: number;
  expectedRevision?: number;
  deadlineMs?: number;
  operation: Operation;
}

/** Server-to-client events. */
export type LightEvent =
  | { kind: "hostStatus"; state: string }
  | {
      kind: "sessionSnapshot";
      sessionId: string;
      messages?: Array<{ role: string; text: string; seq?: number }>;
      /** Restored tool rows (no bodies). Absent/empty when history had none. */
      tools?: Array<{
        toolCallId: string;
        name: string;
        action: string;
        readOnly: boolean;
        provider?: string | null;
        detail?: string | null;
        finished: boolean;
        failed: boolean;
        seq: number;
      }>;
    }
  | { kind: "sessionStatus"; sessionId: string; state: string }
  | { kind: "messageDelta"; sessionId: string; text: string }
  | { kind: "thoughtDelta"; sessionId: string; text: string }
  | {
      kind: "toolStart";
      sessionId: string;
      toolCallId: string;
      name: string;
      action: string;
      readOnly: boolean;
      provider?: string | null;
      detail?: string | null;
    }
  | {
      kind: "toolProgress";
      sessionId: string;
      toolCallId: string;
      title?: string | null;
      detail?: string | null;
    }
  | {
      kind: "toolEnd";
      sessionId: string;
      toolCallId: string;
      failed: boolean;
      truncated: boolean;
    }
  | {
      kind: "planUpdated";
      sessionId: string;
      /** Bounded steps from the agent; empty when none survived projection. */
      entries?: PlanEntryProjection[];
    }
  | { kind: "commandsUpdated"; sessionId: string; commands: CommandProjection[] }
  | { kind: "workspacesChanged" }
  | { kind: "queueChanged"; sessionId: string }
  | {
      kind: "sessionReviewUpdated";
      sessionId: string;
      changes: boolean;
      context: boolean;
    }
  | { kind: "promptSent"; sessionId: string; text: string }
  | { kind: "permissionRequest"; sessionId: string; requestId: string; options: string[] }
  | { kind: "turnInterrupted"; sessionId: string; recordId: string }
  | { kind: "error"; code: string };

/** An event with its cursor position. */
export interface EventEnvelope {
  protocolVersion: number;
  eventSequence: number;
  sessionRevision?: number;
  event: LightEvent;
}

/**
 * The three native permission options Light may render.
 *
 * Light never fabricates an option and never renders a persistent grant: the
 * host refuses those, and so does this client. See light ADR 0007.
 */
export const RENDERABLE_OPTIONS = [
  "allow-once",
  "allow-edits-session",
  "reject-once",
] as const;

/** A permission option identifier Light is allowed to present. */
export type RenderableOption = (typeof RENDERABLE_OPTIONS)[number];

/** Human labels for the options Light renders. */
export const OPTION_LABELS: Record<RenderableOption, string> = {
  "allow-once": "Allow once",
  "allow-edits-session": "Allow edits this session",
  "reject-once": "Deny",
};

/**
 * Keep only the options this client is allowed to show, in a stable order.
 *
 * The host already projects the agent's offer, but the browser re-applies the
 * same rule so a surprising payload cannot put a persistent grant on screen.
 */
export function renderableOptions(offered: readonly string[]): RenderableOption[] {
  return RENDERABLE_OPTIONS.filter((option) => offered.includes(option));
}

/** Whether the offer can be answered without creating a durable grant. */
export function hasSingleUseOption(offered: readonly string[]): boolean {
  return offered.includes("allow-once") && offered.includes("reject-once");
}
