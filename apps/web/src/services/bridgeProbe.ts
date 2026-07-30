/**
 * Probe the local bridge for hosted UI (ADR light 0016).
 *
 * Pure state machine + injectable fetch so tests do not need a live host.
 */

export type BridgeProbeState =
  | { kind: "checking" }
  | { kind: "bridge_missing" }
  | { kind: "blocked_lna" }
  | { kind: "needs_pairing" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface HealthzBody {
  ok?: boolean;
  mode?: string;
  protocolVersion?: number;
}

export interface ProbeOptions {
  /** Base URL of the loopback API, e.g. `http://127.0.0.1:20001`. */
  bridgeBaseUrl: string;
  /** Whether the page already completed pairing (session + csrf in memory). */
  isPaired: boolean;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Optional timeout ms (default 2500). */
  timeoutMs?: number;
}

/**
 * Classify a probe result from raw healthz outcome.
 */
export function classifyProbeResult(input: {
  networkError: boolean;
  status?: number;
  body?: HealthzBody | null;
  isPaired: boolean;
  /** Browser blocked local network (best-effort heuristic). */
  likelyLnaBlocked?: boolean;
}): BridgeProbeState {
  if (input.likelyLnaBlocked) {
    return { kind: "blocked_lna" };
  }
  if (input.networkError || input.status === undefined) {
    return { kind: "bridge_missing" };
  }
  if (input.status !== 200 || !input.body || input.body.ok !== true) {
    return {
      kind: "error",
      message: `Bridge answered HTTP ${input.status ?? "?"} without a healthy body.`,
    };
  }
  if (input.body.mode && input.body.mode !== "bridge") {
    return {
      kind: "error",
      message: `Unexpected bridge mode: ${input.body.mode}`,
    };
  }
  if (!input.isPaired) {
    return { kind: "needs_pairing" };
  }
  return { kind: "ready" };
}

/**
 * Probe loopback healthz once.
 */
export async function probeBridge(options: ProbeOptions): Promise<BridgeProbeState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2500;
  const base = options.bridgeBaseUrl.replace(/\/$/, "");
  const url = `${base}/healthz`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      credentials: "include",
      mode: "cors",
    });
    let body: HealthzBody | null = null;
    try {
      body = (await response.json()) as HealthzBody;
    } catch {
      body = null;
    }
    return classifyProbeResult({
      networkError: false,
      status: response.status,
      body,
      isPaired: options.isPaired,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    // Chromium may surface LNA as a TypeError / Failed to fetch; we cannot
    // distinguish reliably from a stopped bridge without Permissions API.
    return classifyProbeResult({
      networkError: true,
      isPaired: options.isPaired,
      likelyLnaBlocked: name === "NotAllowedError",
    });
  } finally {
    clearTimeout(timer);
  }
}
