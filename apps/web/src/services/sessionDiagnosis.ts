/**
 * Session-scoped history diagnosis (light ADR 0015).
 *
 * Diagnosis and repair must never leak across conversations: a dry-run of A
 * cannot authorize an apply on B, and a late response for A must not paint B.
 */

import type { SessionDiagnosis } from "./outcomes";

/**
 * Which diagnosis, if any, the active conversation may show.
 *
 * While a create/load is in flight the surface is not a settled conversation,
 * so any leftover diagnosis is withheld rather than shown against a loading
 * empty state.
 */
export function diagnosisForSession(
  diagnoses: Record<string, SessionDiagnosis>,
  sessionId: string | null,
  sessionLoading: boolean,
): SessionDiagnosis | null {
  if (sessionLoading || sessionId === null) {
    return null;
  }
  const held = diagnoses[sessionId];
  if (held === undefined || held.sessionId !== sessionId) {
    return null;
  }
  return held;
}

/**
 * Whether the user may apply repair for the conversation on screen.
 *
 * Apply requires a prior dry-run diagnosis of **this** session that reported
 * corrupt pairing. A diagnosis for another conversation never authorizes apply.
 */
export function canApplyRepair(
  diagnosis: SessionDiagnosis | null,
  sessionId: string | null,
): boolean {
  return (
    sessionId !== null &&
    diagnosis !== null &&
    diagnosis.sessionId === sessionId &&
    diagnosis.status === "corrupt"
  );
}

/** Store a diagnosis under the session it was requested for. */
export function storeDiagnosis(
  current: Record<string, SessionDiagnosis>,
  targetSessionId: string,
  diagnosis: SessionDiagnosis,
): Record<string, SessionDiagnosis> {
  return {
    ...current,
    [targetSessionId]: {
      ...diagnosis,
      // The key is the conversation we asked about; keep the record aligned.
      sessionId: targetSessionId,
    },
  };
}

/** Drop diagnoses for conversations the host no longer holds. */
export function retainDiagnoses(
  current: Record<string, SessionDiagnosis>,
  live: ReadonlySet<string>,
): Record<string, SessionDiagnosis> {
  return Object.fromEntries(
    Object.entries(current).filter(([id]) => live.has(id)),
  );
}
