/**
 * Top-right anonymous presence badge for the hosted landing.
 */

import { formatPresenceCount, type PresenceStats } from "../services/presence";

export function LandingPresence({
  stats,
}: {
  stats: PresenceStats | null;
}) {
  if (!stats) return null;

  const label = `${formatPresenceCount(stats.active)} online · ${formatPresenceCount(stats.total)} total`;

  return (
    <div
      className="landing-presence"
      data-testid="landing-presence"
      title="Anonymous visitor counts from this site only. Random browser id; no accounts, paths, or credentials."
      aria-label={`Anonymous presence: ${stats.active} online, ${stats.total} total`}
    >
      <span className="landing-presence-dot" aria-hidden="true" />
      <span className="landing-presence-text">{label}</span>
    </div>
  );
}
