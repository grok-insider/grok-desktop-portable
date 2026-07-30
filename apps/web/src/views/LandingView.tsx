/**
 * Hosted landing when the local bridge is missing, blocked, or unpaired.
 */

import type { BridgeProbeState } from "../services/bridgeProbe";

export function LandingView({
  probe,
  onRetry,
}: {
  probe: BridgeProbeState;
  onRetry: () => void;
}) {
  let title = "Grok Desktop Portable";
  let body = "";
  switch (probe.kind) {
    case "checking":
      body = "Looking for the local bridge…";
      break;
    case "bridge_missing":
      title = "Start the local bridge";
      body =
        "Install and run grok-bridge on this machine, then retry. The site only drives your local Grok Build CLI through that bridge.";
      break;
    case "blocked_lna":
      title = "Allow local network access";
      body =
        "This browser blocked connections from desktop.grok.me to your machine. Allow local network (or loopback) access for this site, then retry.";
      break;
    case "needs_pairing":
      title = "Pair this browser";
      body =
        "The bridge is running. Run `grok-bridge open` and open the printed URL (or paste the #pair= link) so this tab can control your CLI.";
      break;
    case "error":
      title = "Bridge error";
      body = probe.message;
      break;
    case "ready":
      body = "Ready.";
      break;
  }

  return (
    <main className="landing" data-testid="landing-view">
      <h1>{title}</h1>
      <p>{body}</p>
      <pre className="landing-install">
        {`curl -fsSL https://desktop.grok.me/install.sh | sh
grok-bridge doctor
grok-bridge serve
grok-bridge open`}
      </pre>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </main>
  );
}
