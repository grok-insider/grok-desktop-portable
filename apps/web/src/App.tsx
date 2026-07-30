/**
 * Grok Light application shell.
 *
 * Pairs on first load if the launcher put a nonce in the fragment, opens the
 * event channel, and projects host events into the session view. All durable
 * state lives in the host; this holds only what is on screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { detectBrowserSupport } from "./services/browser";
import {
  type BridgeProbeState,
  probeBridge,
} from "./services/bridgeProbe";
import {
  BRIDGE_PORT_KEY,
  BRIDGE_SESSION_KEY,
  LightClient,
  hasStoredPort,
  resolveBridgeBaseUrl,
  takePairingFragment,
  type ClientFailure,
} from "./services/client";
import {
  probeAfterHostGone,
  probeAfterSessionLoss,
  shouldDemoteFromWork,
  shouldShowWork,
} from "./services/surfaceGate";
import { LandingView } from "./views/LandingView";
import { isBashMode, bashSendText } from "./services/bashMode";
import {
  pickDefaultEffort,
  pickDefaultModelId,
  type ModelProjection,
} from "./services/models";
import {
  asContext,
  asHostStatus,
  asModels,
  asSessionChanges,
  asSessionDiagnosis,
  asSessionInspector,
  asSessionRepair,
  asSessions,
  asTools,
  asWorkspaces,
  failureMessage,
  type ContextEntry,
  type ProjectProjection,
  type ReviewProjection,
  type SessionChangesProjection,
  type SessionDiagnosis,
  type SessionInspectorProjection,
  type SessionProjection,
  type SessionSummary,
  type ToolProjection,
} from "./services/outcomes";
import type { ChangeMode, CommandProjection, EventEnvelope } from "./services/protocol";
import type { RenderableOption } from "./services/protocol";
import {
  canApplyRepair,
  diagnosisForSession,
  retainDiagnoses,
  storeDiagnosis,
} from "./services/sessionDiagnosis";
import {
  EMPTY_PROJECTIONS,
  closeProjection,
  nextLocalSeq,
  openProjection,
  projectionFor,
  project,
  sessionTitles,
  type Projections,
} from "./services/sessionProjection";
import { parsePath, syncUrl } from "./services/routes";
import { WorkShell } from "./shell/WorkShell";
import { PermissionDialog, type PermissionPrompt } from "./views/PermissionDialog";
import { ReviewBanner } from "./views/ReviewBanner";
import { HomeView, type WorkspaceSummary } from "./views/HomeView";
import { SetupView } from "./views/SetupView";
import { SessionView } from "./views/SessionView";

const RECONNECT_MS = 2_000;
/** Longest gap between attempts, so a host that is gone is not hammered. */
const RECONNECT_MAX_MS = 30_000;
/** Attempts before the page stops trying and says so. */
const RECONNECT_MAX_ATTEMPTS = 8;

interface InspectorLoad {
  data: SessionInspectorProjection | null;
  loading: boolean;
}

interface ChangesLoad {
  data: SessionChangesProjection | null;
  loading: boolean;
}

function retainLive<T>(values: Record<string, T>, live: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([id]) => live.has(id)));
}

function hostErrorMessage(code: string): string {
  switch (code) {
    case "controller_held":
      return "Another tab is already controlling this host. Close it or wait for the lease to expire.";
    case "picker_unavailable":
      return "The directory picker could not open. Enrol a path with `grok-bridge workspace add` instead.";
    case "workspace_enrolment_failed":
      return "That directory could not be enrolled.";
    case "picker_already_open":
      return "A directory picker is already open.";
    case "queued_prompt_failed":
      return "A message that was waiting could not be sent. The rest are still queued.";
    case "agent_exited":
      return "The Grok Build CLI stopped. Every open conversation closed with it; restart the host with `grok-bridge serve`, then resume from the session list.";
    default:
      return `The host reported an error (${code}).`;
  }
}


export function App({ client: injected }: { client?: LightClient } = {}) {
  // The client must survive every render. A default parameter value would be
  // re-evaluated on each one, producing a new instance that loses the CSRF
  // token and re-runs the event effect in a connect/disconnect loop.
  const [client] = useState(() => injected ?? new LightClient());
  const [paired, setPaired] = useState(client.paired);
  const [probe, setProbe] = useState<BridgeProbeState>({ kind: "checking" });
  const [failure, setFailure] = useState<ClientFailure | undefined>();
  const [connected, setConnected] = useState(false);
  const [projections, setProjections] = useState<Projections>(EMPTY_PROJECTIONS);
  // Both are per conversation. Held in one slot they leaked across a switch:
  // a draft written for one conversation could be sent to another, and a
  // second permission request silently replaced the first, leaving the agent
  // that raised it waiting on a decision the user could no longer see.
  const [prompts, setPrompts] = useState<Record<string, PermissionPrompt>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [projects, setProjects] = useState<ProjectProjection[]>([]);
  const [pendingReviews, setPendingReviews] = useState<ReviewProjection[]>([]);
  // Which conversation the transcript is showing. Several may be open at once
  // (light ADR 0011); this is only the one on screen. Initialised from the URL
  // so a refresh on `/s/:id` reopens that conversation when it is still open.
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const route = parsePath(window.location.pathname);
    return route.kind === "session" ? route.sessionId : null;
  });
  const [openSessions, setOpenSessions] = useState<SessionProjection[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** True while create/loadSession is in flight — avoids an empty flash. */
  const [sessionLoading, setSessionLoading] = useState(false);
  /**
   * History diagnosis keyed by conversation (light ADR 0015).
   *
   * A single slot would let a dry-run of A authorize repair on B after a
   * switch, and a late diagnose response would paint the wrong conversation.
   */
  const [diagnoses, setDiagnoses] = useState<Record<string, SessionDiagnosis>>({});
  const [repairBusyBySession, setRepairBusyBySession] = useState<
    Record<string, boolean>
  >({});
  const [cliNotice, setCliNotice] = useState<string | undefined>();
  const [models, setModels] = useState<ModelProjection[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [effortId, setEffortId] = useState<string | null>(null);
  const [configTools, setConfigTools] = useState<ToolProjection[]>([]);
  // Per conversation, because the agent publishes them per session and two
  // conversations may be running different agents' command sets.
  const [commands, setCommands] = useState<Record<string, CommandProjection[]>>({});
  // Candidates for the `@` menu. Workspace-relative paths only; the host
  // resolves the root and never sends an absolute path (light ADR 0013).
  const [contextEntries, setContextEntries] = useState<ContextEntry[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [changeModes, setChangeModes] = useState<Record<string, ChangeMode>>({});
  const [inspectors, setInspectors] = useState<Record<string, InspectorLoad>>({});
  const [sessionChanges, setSessionChanges] = useState<
    Record<string, Partial<Record<ChangeMode, ChangesLoad>>>
  >({});
  const [reviewRevisions, setReviewRevisions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>();
  const [deciding, setDeciding] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [wsGeneration, setWsGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  /** Sequences `listContext` replies so a slow one cannot overwrite a newer. */
  const contextTicket = useRef(0);
  const inspectorTickets = useRef<Record<string, number>>({});
  const changesTickets = useRef<Record<string, number>>({});
  const browserSupport = detectBrowserSupport();
  const activeChangeMode = sessionId === null ? "git" : (changeModes[sessionId] ?? "git");
  const activeInspector = sessionId === null ? undefined : inspectors[sessionId];
  const activeChanges =
    sessionId === null ? undefined : sessionChanges[sessionId]?.[activeChangeMode];
  const activeReviewRevision =
    sessionId === null ? 0 : (reviewRevisions[sessionId] ?? 0);

  /** Leave Work for landing when pairing dies or the host is gone. */
  const demoteToLanding = useCallback(
    (next: BridgeProbeState) => {
      // Always keep the remembered port: landing Retry and "serve then open"
      // need resolveBridgeBaseUrl to still point at the last loopback port.
      // Clear only the session grant (tokens). Port is discovery, not authority.
      client.clearPairing({ clearPort: false });
      setPaired(false);
      setConnected(false);
      setReconnecting(false);
      setRefusal(undefined);
      setProbe(next);
    },
    [client],
  );

  /**
   * Soft error inside Work, or demote when the failure means we are no longer
   * a live paired session (ADR 0016 / docs/ui.md demotion rule).
   */
  const reportClientFailure = useCallback(
    (failure: ClientFailure, fallback: string) => {
      if (shouldDemoteFromWork(failure)) {
        demoteToLanding(probeAfterSessionLoss(failure));
        return;
      }
      setRefusal(failureMessage(failure, fallback));
    },
    [demoteToLanding],
  );

  // Hosted UI: probe loopback bridge, then pair if needed (ADR 0016).
  // Same-origin fallback (empty bridge base) skips probe and pairs as before.
  // Resume store: restore tokens + port from document origin before resume.
  const runProbeAndPair = useCallback(() => {
    if (!browserSupport.ok) {
      return;
    }
    setProbe({ kind: "checking" });
    const fragment = takePairingFragment();
    if (fragment?.port) {
      client.setBridgeBaseUrl(`http://127.0.0.1:${fragment.port}`);
    } else {
      // Silent resume path: restore grant before reading base URL.
      client.restoreFromStorage();
    }
    const base = client.bridgeBaseUrl || resolveBridgeBaseUrl();
    if (base && !client.bridgeBaseUrl) {
      client.setBridgeBaseUrl(base);
    }
    const afterPairAttempt = (isPaired: boolean) => {
      if (!base && !client.bridgeBaseUrl) {
        // No known API port yet (hosted, never opened) → treat as missing bridge.
        // Same-origin tests inject an empty base with a paired resume → ready.
        setProbe(
          isPaired ? { kind: "ready" } : { kind: "bridge_missing" },
        );
        return;
      }
      const apiBase = client.bridgeBaseUrl || base;
      void probeBridge({
        bridgeBaseUrl: apiBase,
        isPaired,
      }).then((state) => {
        if (state.kind === "bridge_missing" || state.kind === "blocked_lna") {
          // Drop tokens so we do not look paired, but keep the port so
          // LandingView can show "serve" (hadPort) and Retry re-probes the same base.
          client.clearPairing({ clearPort: false });
        }
        setProbe(state);
      });
    };

    const nonce = fragment?.nonce ?? null;
    const attempt = nonce === null ? client.resume() : client.pair(nonce);
    void attempt.then((result) => {
      if (result.ok) {
        setPaired(true);
        setFailure(undefined);
        afterPairAttempt(true);
        return;
      }
      // Keep port always (discovery for Retry / sticky serve). Clear grant only.
      client.clearPairing({ clearPort: false });
      setPaired(false);
      setFailure(nonce === null ? undefined : result.failure);
      if (result.failure.kind === "protocol_mismatch") {
        setProbe(probeAfterSessionLoss(result.failure));
        return;
      }
      afterPairAttempt(false);
    });
  }, [browserSupport.ok, client]);

  useEffect(() => {
    runProbeAndPair();
  }, [runProbeAndPair]);

  // Other tabs that clear the resume grant re-run probe (storage event).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === BRIDGE_SESSION_KEY || event.key === BRIDGE_PORT_KEY) {
        runProbeAndPair();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [runProbeAndPair]);

  // Ask the host for the enrolment set. The reply also says whether a session
  // is already open, which is what decides the view.
  const refreshModels = useCallback(() => {
    void client.send({ kind: "listModels" }).then((result) => {
      if (!result.ok) {
        return;
      }
      const projected = asModels(result.value);
      if (projected === null) {
        return;
      }
      setModels(projected.models);
      setModelId((current) => {
        if (current !== null && projected.models.some((model) => model.id === current)) {
          return current;
        }
        return pickDefaultModelId(projected.models, projected.defaultModelId);
      });
    });
  }, [client]);

  const refreshTools = useCallback(
    (workspaceId: string | null) => {
      void client
        .send(
          workspaceId === null
            ? { kind: "listTools" }
            : { kind: "listTools", workspaceId },
        )
        .then((result) => {
          if (!result.ok) {
            return;
          }
          const projected = asTools(result.value);
          if (projected !== null) {
            setConfigTools(projected.tools);
          }
        });
    },
    [client],
  );

  /**
   * Ask the host what the user may mention with `@`.
   *
   * The browser sends the opaque workspace id and the substring typed so far;
   * it never sends a path (light ADR 0009 / 0013). Replies are sequenced
   * because a slower earlier query must not overwrite a newer, narrower one —
   * that is what makes a completion list flicker back to stale rows.
   */
  const refreshContext = useCallback(
    (workspaceId: string | null, query: string) => {
      if (workspaceId === null) {
        setContextEntries([]);
        return;
      }
      const ticket = contextTicket.current + 1;
      contextTicket.current = ticket;
      setContextLoading(true);
      void client
        .send({ kind: "listContext", workspaceId, query })
        .then((result) => {
          if (ticket !== contextTicket.current) {
            return;
          }
          setContextLoading(false);
          if (!result.ok) {
            // A refused listing is not worth an error banner: the user can
            // still type the path, and the agent resolves it either way.
            setContextEntries([]);
            return;
          }
          const projected = asContext(result.value);
          setContextEntries(projected === null ? [] : projected.entries);
        });
    },
    [client],
  );

  const refreshInspector = useCallback(
    (target: string) => {
      const ticket = (inspectorTickets.current[target] ?? 0) + 1;
      inspectorTickets.current[target] = ticket;
      setInspectors((current) => ({
        ...current,
        [target]: { data: current[target]?.data ?? null, loading: true },
      }));
      void client.send({ kind: "getSessionInspector", sessionId: target }).then((result) => {
        if (inspectorTickets.current[target] !== ticket) {
          return;
        }
        const projected = result.ok ? asSessionInspector(result.value, target) : null;
        setInspectors((current) => ({
          ...current,
          [target]: { data: projected?.inspector ?? null, loading: false },
        }));
        if (projected === null || projected.inspector.availableChangeModes.length === 0) {
          return;
        }
        setChangeModes((current) => {
          const selected = current[target] ?? "git";
          return projected.inspector.availableChangeModes.includes(selected)
            ? current
            : { ...current, [target]: projected.inspector.availableChangeModes[0] ?? "git" };
        });
      });
    },
    [client],
  );

  const refreshChanges = useCallback(
    (target: string, mode: ChangeMode) => {
      const key = `${target}:${mode}`;
      const ticket = (changesTickets.current[key] ?? 0) + 1;
      changesTickets.current[key] = ticket;
      setSessionChanges((current) => ({
        ...current,
        [target]: {
          ...current[target],
          [mode]: { data: current[target]?.[mode]?.data ?? null, loading: true },
        },
      }));
      void client
        .send({ kind: "getSessionChanges", sessionId: target, mode })
        .then((result) => {
          if (changesTickets.current[key] !== ticket) {
            return;
          }
          const projected = result.ok
            ? asSessionChanges(result.value, target, mode)
            : null;
          setSessionChanges((current) => ({
            ...current,
            [target]: {
              ...current[target],
              [mode]: { data: projected?.changes ?? null, loading: false },
            },
          }));
          if (projected !== null && projected.changes === undefined) {
            // The repository or qualified CLI cannot support this comparison.
            // Remove it from the visible selector rather than leaving a mode
            // that can only fail.
            setInspectors((current) => {
              const held = current[target];
              if (held?.data === null || held?.data === undefined) {
                return current;
              }
              return {
                ...current,
                [target]: {
                  ...held,
                  data: {
                    ...held.data,
                    availableChangeModes: held.data.availableChangeModes.filter(
                      (candidate) => candidate !== mode,
                    ),
                  },
                },
              };
            });
          }
        });
    },
    [client],
  );

  useEffect(() => {
    if (!reviewPanelOpen || sessionId === null) {
      return;
    }
    refreshInspector(sessionId);
    refreshChanges(sessionId, activeChangeMode);
  }, [
    activeChangeMode,
    activeReviewRevision,
    refreshChanges,
    refreshInspector,
    reviewPanelOpen,
    sessionId,
  ]);

  const refreshWorkspaces = useCallback(() => {
    setBusy(true);
    void client.send({ kind: "listWorkspaces" }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        reportClientFailure(result.failure, "The host refused the request.");
        return;
      }
      const projected = asWorkspaces(result.value);
      if (projected !== null) {
        setWorkspaces(projected.workspaces);
        setProjects(projected.projects ?? []);
        setPendingReviews(projected.pendingReviews ?? []);
        refreshModels();
        const open = projected.openSessions ?? [];
        setOpenSessions(open);
        // Track a projection per open conversation, and forget the ones the
        // host no longer holds so a closed session cannot keep a transcript
        // alive in the browser.
        setProjections((current) => {
          let next = current;
          for (const session of open) {
            next = openProjection(next, session.sessionId);
          }
          for (const id of Object.keys(next)) {
            if (!open.some((session) => session.sessionId === id)) {
              next = closeProjection(next, id);
            }
          }
          return next;
        });
        // A conversation the host no longer holds leaves nothing behind: its
        // draft and any request it raised go with it.
        const live = new Set(open.map((session) => session.sessionId));
        setDrafts((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
        );
        setPrompts((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
        );
        setInspectors((current) => retainLive(current, live));
        setSessionChanges((current) => retainLive(current, live));
        setChangeModes((current) => retainLive(current, live));
        setReviewRevisions((current) => retainLive(current, live));
        setDiagnoses((current) => retainDiagnoses(current, live));
        setRepairBusyBySession((current) => retainLive(current, live));
        setSessionId((current) => {
          if (current !== null && open.some((s) => s.sessionId === current)) {
            return current;
          }
          return open.at(-1)?.sessionId ?? null;
        });
      }
    });
  }, [client, refreshModels]);

  const refreshHostStatus = useCallback(() => {
    void client.send({ kind: "getHostStatus" }).then((result) => {
      if (!result.ok) {
        return;
      }
      const status = asHostStatus(result.value);
      if (status === null) {
        return;
      }
      if (status.cliQualified) {
        setCliNotice(undefined);
        return;
      }
      if (status.cliVersion) {
        setCliNotice(
          `Grok Build CLI ${status.cliVersion} is below the qualified minimum ${status.minCliVersion}. Upgrade for history integrity and full Light support.`,
        );
        return;
      }
      setCliNotice(
        status.cliReason ??
          `Grok Build CLI was not found. Install and authenticate a CLI ≥ ${status.minCliVersion}.`,
      );
    });
  }, [client]);

  useEffect(() => {
    if (paired) {
      refreshWorkspaces();
      refreshHostStatus();
    }
  }, [paired, refreshWorkspaces, refreshHostStatus]);

  // Keep the address bar in sync with the active conversation (and home).
  useEffect(() => {
    if (!paired) {
      return;
    }
    if (sessionId === null) {
      syncUrl({ kind: "home" }, "replace");
      return;
    }
    syncUrl({ kind: "session", sessionId }, "push");
  }, [paired, sessionId]);

  // Browser back/forward: only switch to sessions that are still open.
  useEffect(() => {
    const onPop = () => {
      const route = parsePath(window.location.pathname);
      if (route.kind === "session") {
        // Select the deep-linked id; if it is not open yet, the Work view will
        // empty until the user resumes or the host still holds it.
        setSessionId(route.sessionId);
        return;
      }
      setSessionId(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const sessionWorkspaceId =
      sessionId === null
        ? null
        : (openSessions.find((session) => session.sessionId === sessionId)?.workspaceId ??
          null);
    const workspaceId = sessionWorkspaceId ?? selectedWorkspaceId;
    if (workspaceId !== null) {
      refreshTools(workspaceId);
    }
  }, [openSessions, refreshTools, selectedWorkspaceId, sessionId]);

  useEffect(() => {
    setEffortId((current) => {
      const next = pickDefaultEffort(models, modelId);
      if (current !== null && models.some((model) =>
        model.id === modelId && model.reasoningEfforts.some((effort) => effort.id === current),
      )) {
        return current;
      }
      return next;
    });
  }, [modelId, models]);

  const refreshSessions = useCallback(
    (workspaceId: string) => {
      setBusy(true);
      setRefusal(undefined);
      void client.send({ kind: "listSessions", workspaceId }).then((result) => {
        setBusy(false);
        if (!result.ok) {
          reportClientFailure(result.failure, "The host could not list sessions.");
          return;
        }
        const listed = asSessions(result.value);
        if (listed !== null) {
          setSessions(listed.sessions);
        }
      });
    },
    [client],
  );

  const openWorkspace = useCallback(
    (workspaceId: string) => {
      setRefusal(undefined);
      const enrolled = workspaces.find((workspace) => workspace.id === workspaceId);
      setSelectedWorkspaceId(workspaceId);
      setWorkspaceName(enrolled?.displayName);
      refreshSessions(workspaceId);
    },
    [refreshSessions, workspaces],
  );

  const startSession = useCallback(
    (workspaceId: string) => {
      setBusy(true);
      setSessionLoading(true);
      setRefusal(undefined);
      // Loading is not a settled conversation: withhold any prior diagnosis so
      // a create cannot show repair UI for the previous active session.
      void client
        .send(
          { kind: "createSession", workspaceId },
          { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
        )
        .then((result) => {
          setBusy(false);
          setSessionLoading(false);
          if (result.ok) {
            refreshWorkspaces();
            return;
          }
          reportClientFailure(result.failure, "The host could not start a session.");
        });
    },
    [client, refreshWorkspaces],
  );

  const resumeSession = useCallback(
    (workspaceId: string, agentSessionId: string) => {
      setBusy(true);
      setSessionLoading(true);
      setRefusal(undefined);
      // Same loading rule as start: diagnosis is per settled conversation id.
      void client
        .send(
          { kind: "loadSession", workspaceId, sessionId: agentSessionId },
          { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
        )
        .then((result) => {
          setBusy(false);
          setSessionLoading(false);
          if (result.ok) {
            refreshWorkspaces();
            return;
          }
          reportClientFailure(result.failure, "The host could not resume that session.");
        });
    },
    [client, refreshWorkspaces],
  );

  const diagnoseSession = useCallback(() => {
    if (sessionId === null) {
      return;
    }
    // Capture the target at send time so a late response cannot paint another
    // conversation the user switched to while the dry-run was in flight.
    const target = sessionId;
    setRepairBusyBySession((held) => ({ ...held, [target]: true }));
    setRefusal(undefined);
    void client
      .send(
        { kind: "diagnoseSession", sessionId: target },
        { controllerEpoch: 1 },
      )
      .then((result) => {
        setRepairBusyBySession((held) => ({ ...held, [target]: false }));
        if (!result.ok) {
          reportClientFailure(result.failure, "The host could not diagnose this conversation's history.");
          return;
        }
        const diagnosis = asSessionDiagnosis(result.value);
        if (diagnosis !== null) {
          setDiagnoses((held) =>
            storeDiagnosis(held, target, diagnosis.diagnosis),
          );
        }
      });
  }, [client, sessionId]);

  const repairSession = useCallback(() => {
    if (sessionId === null) {
      return;
    }
    const activeDiagnosis = diagnosisForSession(diagnoses, sessionId, sessionLoading);
    // Dry-run-then-confirm: apply only with a corrupt diagnosis for **this**
    // conversation. A dry-run of A never authorizes repair of B.
    if (activeDiagnosis === null || !canApplyRepair(activeDiagnosis, sessionId)) {
      return;
    }
    const target = activeDiagnosis.sessionId;
    setRepairBusyBySession((held) => ({ ...held, [target]: true }));
    setRefusal(undefined);
    void client
      .send(
        { kind: "repairSession", sessionId: target, dryRun: false },
        {
          idempotencyKey: crypto.randomUUID(),
          controllerEpoch: 1,
        },
      )
      .then((result) => {
        setRepairBusyBySession((held) => ({ ...held, [target]: false }));
        if (!result.ok) {
          reportClientFailure(result.failure, "History repair failed. Nothing was retried automatically.");
          return;
        }
        const repaired = asSessionRepair(result.value);
        if (repaired !== null) {
          setDiagnoses((held) =>
            storeDiagnosis(held, target, {
              sessionId: target,
              status: "healthy",
              report: repaired.report,
            }),
          );
        }
      });
  }, [client, diagnoses, sessionId, sessionLoading]);

  const acknowledgeReview = useCallback(
    (recordId: string) => {
      setBusy(true);
      setRefusal(undefined);
      void client
        .send(
          { kind: "acknowledgeInterrupted", recordId },
          { controllerEpoch: 1, idempotencyKey: `ack-${recordId}` },
        )
        .then((result) => {
          setBusy(false);
          if (!result.ok) {
            reportClientFailure(result.failure, "The host could not record that you have seen this.");
            return;
          }
          // Acknowledging only changes what is shown, so the projection is
          // re-read rather than guessed at locally.
          refreshWorkspaces();
        });
    },
    [client, refreshWorkspaces],
  );

  const openPicker = useCallback(() => {
    setBusy(true);
    setRefusal(undefined);
    void client
      .send({ kind: "openWorkspacePicker" }, { controllerEpoch: 1 })
      .then((result) => {
        setBusy(false);
        if (!result.ok) {
          reportClientFailure(result.failure, "The host could not open a directory picker.");
        }
        // Nothing to refresh yet: the dialog is still open. The host emits
        // `workspacesChanged` once the user has chosen.
      });
  }, [client]);

  // There is no `openProject` here on purpose. The rail lists only projects
  // already enrolled (light ADR 0014), so the browser can never hold the id of
  // an unenrolled one. Enrolment goes through the host picker above, or
  // `grok-bridge workspace add`. The host operation still exists for the CLI.

  const handleEvent = useCallback((envelope: EventEnvelope) => {
    if (envelope.event.kind === "workspacesChanged") {
      // The host-owned picker finished. The command that opened it returned
      // immediately, so this is the only signal that a directory was enrolled.
      refreshWorkspaces();
      return;
    }
    if (envelope.event.kind === "commandsUpdated") {
      // The agent owns its command set and republishes it as it changes, so
      // the browser records what it was told rather than merging.
      const published = envelope.event;
      setCommands((current) => ({
        ...current,
        [published.sessionId]: published.commands,
      }));
      return;
    }
    if (envelope.event.kind === "permissionRequest") {
      const raised = envelope.event;
      setPrompts((current) => ({
        ...current,
        [raised.sessionId]: {
          sessionId: raised.sessionId,
          requestId: raised.requestId,
          options: raised.options,
        },
      }));
      return;
    }
    if (envelope.event.kind === "sessionReviewUpdated") {
      const updated = envelope.event;
      setReviewRevisions((current) => ({
        ...current,
        [updated.sessionId]: (current[updated.sessionId] ?? 0) + 1,
      }));
      return;
    }
    if (envelope.event.kind === "error") {
      // A host error names no session, so every conversation that was
      // streaming is released rather than leaving one stuck showing Stop.
      setRefusal(hostErrorMessage(envelope.event.code));
      setProjections((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, value]) => [
            id,
            value.phase === "streaming" ? { ...value, phase: "idle" } : value,
          ]),
        ),
      );
      return;
    }
    if (envelope.event.kind === "queueChanged") {
      // The host took a message out to run it, so the list is re-read rather
      // than guessed at here.
      refreshWorkspaces();
      return;
    }
    if (envelope.event.kind === "turnInterrupted") {
      // The event carries only an id. Operation and cause live in the host's
      // journal, and the user needs both to know what to go and check, so the
      // record is re-read rather than rendered from the id alone.
      refreshWorkspaces();
    }
    setProjections((current) => project(current, envelope));
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!paired) {
      return undefined;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const connect = () => {
      if (cancelled) {
        return;
      }
      setReconnecting(true);
      const socket = client.openEvents({
        onEvent: handleEvent,
        onOpen: () => {
          if (cancelled) {
            return;
          }
          setConnected(true);
          setReconnecting(false);
          // A successful connection is what makes the budget a budget: it
          // resets, so a long session survives many brief host restarts.
          attempts = 0;
        },
        onClose: () => {
          if (cancelled) {
            return;
          }
          setConnected(false);
          socketRef.current = null;
          attempts += 1;
          if (attempts > RECONNECT_MAX_ATTEMPTS) {
            // Host is gone: leave Work for landing (not a permanent Disconnected shell).
            demoteToLanding(probeAfterHostGone());
            return;
          }
          setReconnecting(true);
          // Back off so a host that stays down is polled at a slower and
          // slower rate rather than every two seconds for ever.
          const delay = Math.min(RECONNECT_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
          retryTimer = setTimeout(connect, delay);
        },
      });
      socketRef.current = socket;
      if (socket === null) {
        setConnected(false);
        setReconnecting(false);
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [client, demoteToLanding, handleEvent, paired, wsGeneration]);

  const sendPrompt = useCallback(
    (text: string) => {
      if (sessionId === null) {
        return;
      }
      const target = sessionId;
      setProjections((current) => {
        const existing = projectionFor(current, target);
        return {
          ...current,
          [target]: {
            ...existing,
            phase: "streaming",
            transcript: [
              ...existing.transcript,
              {
                  id: `u-${existing.transcript.length}`,
                  role: "user",
                  text,
                  seq: nextLocalSeq(existing),
                },
            ],
          },
        };
      });
      // The host also emits `sessionStatus: idle` when the turn ends; this is
      // the local backstop so a missed event still restores Send.
      const bash = isBashMode(text);
      const wire = bash ? bashSendText(text) : text;
      void client
        .send(
          { kind: "prompt", sessionId: target, text: wire, bash },
          {
            idempotencyKey: crypto.randomUUID(),
            controllerEpoch: 1,
          },
        )
        .then((result) => {
          // A queued message has not been said yet, so it comes back out of
          // the transcript and appears in the queue instead — showing it in
          // both would read as having been sent twice.
          const queued =
            result.ok &&
            typeof result.value === "object" &&
            result.value !== null &&
            (result.value as { outcome?: unknown }).outcome === "promptQueued";
          if (queued) {
            setProjections((held) => {
              const existing = held[target];
              if (existing === undefined) {
                return held;
              }
              return {
                ...held,
                [target]: {
                  ...existing,
                  transcript: existing.transcript.filter(
                    (entry) =>
                      !(
                        entry.role === "user" &&
                        (entry.text === text || entry.text === wire)
                      ),
                  ),
                },
              };
            });
            refreshWorkspaces();
            return;
          }
          setProjections((current) => {
            const existing = current[target];
            return existing?.phase === "streaming"
              ? { ...current, [target]: { ...existing, phase: "idle" } }
              : current;
          });
          if (!result.ok) {
            // A refused prompt used to vanish: the composer simply re-enabled
            // and the user was left guessing whether the agent had heard them.
            reportClientFailure(result.failure, "The host did not accept that prompt.");
          }
        });
    },
    [client, refreshWorkspaces, reportClientFailure, sessionId],
  );

  const closeSession = useCallback(
    (target: string) => {
      setRefusal(undefined);
      void client
        .send(
          { kind: "closeSession", sessionId: target },
          { idempotencyKey: `close-${target}`, controllerEpoch: 1 },
        )
        .then((result) => {
          if (!result.ok) {
            reportClientFailure(result.failure, "The host could not close that session.");
            return;
          }
          // The host decides what is still open; the browser re-reads rather
          // than assuming its own view of the list is now correct.
          refreshWorkspaces();
        });
    },
    [client, refreshWorkspaces, reportClientFailure],
  );

  const decide = useCallback(
    (optionId: RenderableOption) => {
      if (sessionId === null) {
        return;
      }
      const answered = prompts[sessionId];
      if (answered === undefined) {
        return;
      }
      setDeciding(true);
      void client
        .send(
          {
            kind: "decidePermission",
            sessionId: answered.sessionId,
            requestId: answered.requestId,
            optionId,
          },
          { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
        )
        .then(() => {
          setPrompts((current) => {
            const next = { ...current };
            delete next[answered.sessionId];
            return next;
          });
          setDeciding(false);
        });
    },
    [client, prompts, sessionId],
  );

  if (!browserSupport.ok) {
    return (
      <SetupView
        mode={{ kind: "unsupported_browser", reason: browserSupport.reason }}
      />
    );
  }

  // Work only when probe is ready and the client is still paired (ADR 0016).
  // Every other probe state — including checking — is the welcome landing.
  // Injected test clients with empty base + successful resume set probe ready.
  if (!shouldShowWork(probe, paired)) {
    return (
      <LandingView
        probe={probe}
        onRetry={runProbeAndPair}
        hadPort={hasStoredPort()}
      />
    );
  }

  const connectionStrip = !connected ? (
    <ConnectionBanner
      reconnecting={reconnecting}
      onRetry={() => setWsGeneration((value) => value + 1)}
    />
  ) : null;

  // A session must exist before the composer means anything, so an unpaired
  // browser sees setup, a paired one without a session picks a workspace (and
  // optionally resumes), and only then does the Work view appear.
  if (sessionId === null) {
    return (
      <WorkShell
        connected={connected}
        workspaceName={
          selectedWorkspaceId === null ? undefined : workspaceName
        }
      >
        {connectionStrip}
        <HomeView
          workspaces={workspaces}
          projects={projects}
          sessions={selectedWorkspaceId === null ? [] : sessions}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedWorkspaceName={workspaceName}
          busy={busy}
          error={refusal}
          banner={
            <ReviewBanner
              reviews={pendingReviews}
              busy={busy}
              onAcknowledge={acknowledgeReview}
            />
          }
          onOpenPicker={openPicker}
          onRefreshProjects={refreshWorkspaces}
          onRefreshSessions={() => {
            if (selectedWorkspaceId !== null) {
              refreshSessions(selectedWorkspaceId);
            }
          }}
          onSelectProject={openWorkspace}
          onNewSession={() => {
            if (selectedWorkspaceId !== null) {
              startSession(selectedWorkspaceId);
            }
          }}
          onResumeSession={(id) => {
            if (selectedWorkspaceId !== null) {
              resumeSession(selectedWorkspaceId, id);
            }
          }}
        />
      </WorkShell>
    );
  }

  // Only the conversation on screen may raise a modal. One that arrives for a
  // different conversation is announced in its sidebar row instead: a dialog
  // for something the user is not looking at is a hijack, and with several
  // running they would fight for the screen.
  const prompt = sessionId === null ? null : (prompts[sessionId] ?? null);
  const awaitingDecision = new Set(Object.keys(prompts));
  const shown = projectionFor(projections, sessionId);
  const current = openSessions.find((session) => session.sessionId === sessionId);
  // The host only reports `running` when the list is re-read, which is not
  // during a turn. The live signal is the conversation's own phase, so the two
  // are merged: the host covers a turn this page did not start (a reload
  // mid-turn), the phase covers the one it did.
  const sessionsWithActivity = openSessions.map((session) => ({
    ...session,
    running:
      session.running || projections[session.sessionId]?.phase === "streaming",
    awaitingDecision: awaitingDecision.has(session.sessionId),
  }));
  const activeDiagnosis = diagnosisForSession(
    diagnoses,
    sessionId,
    sessionLoading,
  );
  const repairBusy =
    sessionId === null ? false : (repairBusyBySession[sessionId] ?? false);

  return (
    <>
      <SessionView
        transcript={shown.transcript}
        tools={shown.tools}
        // The host is the only source: it knows the operation and the cause,
        // and a live interruption refreshes it. Rendering the id alone would
        // tell the user something was interrupted but not what.
        reviews={pendingReviews}
        phase={shown.phase}
        plan={shown.plan}
        connected={connected}
        sessionLoading={sessionLoading}
        diagnosis={activeDiagnosis}
        repairBusy={repairBusy}
        onDiagnoseSession={diagnoseSession}
        onRepairSession={repairSession}
        onDismissDiagnosis={() => {
          if (sessionId === null) {
            return;
          }
          const target = sessionId;
          setDiagnoses((held) => {
            const next = { ...held };
            delete next[target];
            return next;
          });
        }}
        workspaceName={current?.workspaceName ?? workspaceName}
        sessions={sessionsWithActivity}
        queued={current?.queued ?? []}
        models={models}
        modelId={modelId}
        effortId={effortId}
        configTools={configTools}
        commands={sessionId === null ? [] : (commands[sessionId] ?? [])}
        contextEntries={contextEntries}
        contextLoading={contextLoading}
        onContextQuery={(query) => refreshContext(current?.workspaceId ?? null, query)}
        reviewPanelOpen={reviewPanelOpen}
        onReviewPanelOpenChange={setReviewPanelOpen}
        inspector={activeInspector?.data ?? null}
        changes={activeChanges?.data ?? null}
        inspectorLoading={activeInspector?.loading ?? false}
        changesLoading={activeChanges?.loading ?? false}
        changeMode={activeChangeMode}
        onChangeMode={(mode) => {
          if (sessionId !== null) {
            setChangeModes((held) => ({ ...held, [sessionId]: mode }));
          }
        }}
        onModelChange={(nextModelId) => {
          setModelId(nextModelId);
          if (sessionId === null) {
            return;
          }
          const effort = pickDefaultEffort(models, nextModelId) ?? undefined;
          void client
            .send(
              {
                kind: "setSessionModel",
                sessionId,
                modelId: nextModelId,
                reasoningEffort: effort,
              },
              { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
            )
            .then((result) => {
              if (!result.ok) {
                reportClientFailure(result.failure, "The host could not change the model.");
              }
            });
        }}
        onEffortChange={(nextEffort) => {
          setEffortId(nextEffort);
          if (sessionId === null || modelId === null) {
            return;
          }
          void client
            .send(
              {
                kind: "setSessionModel",
                sessionId,
                modelId,
                reasoningEffort: nextEffort,
              },
              { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
            )
            .then((result) => {
              if (!result.ok) {
                reportClientFailure(result.failure, "The host could not change reasoning effort.");
              }
            });
        }}
        onSendNow={(text) => {
          if (sessionId === null) {
            return;
          }
          const target = sessionId;
          setProjections((held) => {
            const existing = projectionFor(held, target);
            return {
              ...held,
              [target]: {
                ...existing,
                phase: "streaming",
                transcript: [
                  ...existing.transcript,
                  {
                  id: `u-${existing.transcript.length}`,
                  role: "user",
                  text,
                  seq: nextLocalSeq(existing),
                },
                ],
              },
            };
          });
          const bash = isBashMode(text);
          const wire = bash ? bashSendText(text) : text;
          void client
            .send(
              { kind: "sendNow", sessionId: target, text: wire, bash },
              { idempotencyKey: crypto.randomUUID(), controllerEpoch: 1 },
            )
            .then((result) => {
              if (!result.ok) {
                reportClientFailure(result.failure, "The host could not send that now.");
              }
            });
        }}
        onRemoveQueued={(entryId) => {
          if (sessionId === null) {
            return;
          }
          void client
            .send(
              { kind: "removeQueued", sessionId, entryId },
              { idempotencyKey: `unqueue-${entryId}`, controllerEpoch: 1 },
            )
            .then((result) => {
              if (!result.ok) {
                reportClientFailure(result.failure, "The host could not remove that message.");
                return;
              }
              refreshWorkspaces();
            });
        }}
        draft={sessionId === null ? "" : (drafts[sessionId] ?? "")}
        onDraftChange={(text) => {
          if (sessionId === null) {
            return;
          }
          setDrafts((held) => ({ ...held, [sessionId]: text }));
        }}
        activeSessionId={sessionId}
        sessionTitles={sessionTitles(projections)}
        onSelectSession={(id) => {
          setSessionId(id);
        }}
        onCloseSession={closeSession}
        onLeaveSession={() => {
          setSessionId(null);
        }}
        connectionBanner={connectionStrip}
        hostMessage={refusal ?? cliNotice}
        onPrompt={sendPrompt}
        onCancel={() => {
          if (sessionId === null) {
            return;
          }
          const target = sessionId;
          void client
            .send(
              { kind: "cancelTurn", sessionId: target },
              {
                idempotencyKey: crypto.randomUUID(),
                controllerEpoch: 1,
              },
            )
            .then(() => {
              setProjections((value) => {
                const existing = value[target];
                return existing?.phase === "streaming"
                  ? { ...value, [target]: { ...existing, phase: "idle" } }
                  : value;
              });
            });
        }}
        onAcknowledge={acknowledgeReview}
      />
      {prompt !== null ? (
        <PermissionDialog prompt={prompt} onDecide={decide} busy={deciding} />
      ) : null}
    </>
  );
}
