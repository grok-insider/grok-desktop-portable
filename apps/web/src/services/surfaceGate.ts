/**
 * Pure surface decision for hosted SPA (ADR light 0016).
 *
 * Work chrome must not host "broken app" errors — demote to landing instead.
 */

import type { BridgeProbeState } from "./bridgeProbe";
import type { ClientFailure } from "./client";

/** True only when the SPA may mount WorkShell / Home / Session. */
export function shouldShowWork(
  probe: BridgeProbeState,
  paired: boolean,
): boolean {
  return probe.kind === "ready" && paired;
}

/**
 * Probe state after pairing is lost or the host is gone while the user was in Work.
 */
export function probeAfterSessionLoss(failure: ClientFailure): BridgeProbeState {
  switch (failure.kind) {
    case "unreachable":
      return { kind: "bridge_missing" };
    case "not_paired":
    case "rejected":
      return { kind: "needs_pairing" };
    case "protocol_mismatch":
      return {
        kind: "error",
        message: `This page speaks a different protocol than the host (${failure.hostVersion}). Reload after updating.`,
      };
    case "refused":
    case "bad_request":
      return {
        kind: "error",
        message: "The host refused the request. Pair again with `grok-bridge open`.",
      };
  }
}

/** Host gone past reconnect budget — treat as missing bridge. */
export function probeAfterHostGone(): BridgeProbeState {
  return { kind: "bridge_missing" };
}

/**
 * Whether a client failure must leave Work for landing (not an in-shell banner).
 */
export function shouldDemoteFromWork(failure: ClientFailure): boolean {
  return (
    failure.kind === "not_paired" ||
    failure.kind === "unreachable" ||
    failure.kind === "rejected" ||
    failure.kind === "protocol_mismatch"
  );
}
