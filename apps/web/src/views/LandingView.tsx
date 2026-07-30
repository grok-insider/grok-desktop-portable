/**
 * Welcome / landing when the local bridge is missing, blocked, or unpaired.
 *
 * ADR light 0016: Work chrome is never shown until probe is ready and paired.
 */

import type { BridgeProbeState } from "../services/bridgeProbe";

const INSTALL_SNIPPET = `curl -fsSL https://desktop.grok.me/install.sh | sh
grok-bridge doctor
grok-bridge serve
grok-bridge open`;

export function LandingView({
  probe,
  onRetry,
}: {
  probe: BridgeProbeState;
  onRetry: () => void;
}) {
  let title = "Grok Desktop Portable";
  let body =
    "Drive your local Grok Build CLI from the browser. This site is only the UI — install and authentication stay on your machine.";
  switch (probe.kind) {
    case "checking":
      title = "Looking for the local bridge…";
      body = "Checking whether grok-bridge is running on this machine.";
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
      title = "Ready";
      body = "Connecting to Work…";
      break;
  }

  const showInstall =
    probe.kind === "bridge_missing" ||
    probe.kind === "needs_pairing" ||
    probe.kind === "checking" ||
    probe.kind === "error";

  return (
    <main
      className="landing"
      data-testid="landing-view"
      data-probe-kind={probe.kind}
    >
      <div className="landing-card">
        <p className="landing-kicker">Grok Desktop Portable</p>
        <h1>{title}</h1>
        <p className="landing-body">{body}</p>
        {showInstall ? (
          <>
            <p className="landing-steps-label">On this machine</p>
            <pre className="landing-install" data-testid="landing-install">
              {INSTALL_SNIPPET}
            </pre>
            <ol className="landing-steps">
              <li>Install the bridge (or confirm it is already installed).</li>
              <li>
                Run <code>grok-bridge serve</code> in a terminal.
              </li>
              <li>
                Run <code>grok-bridge open</code> and open the printed URL once
                to pair.
              </li>
            </ol>
          </>
        ) : null}
        {probe.kind === "blocked_lna" ? (
          <p className="landing-hint">
            In Chromium, look for a site permission for local network / loopback
            access for desktop.grok.me, allow it, then retry.
          </p>
        ) : null}
        <div className="landing-actions">
          <button type="button" className="landing-retry" onClick={onRetry}>
            Retry
          </button>
        </div>
        <p className="landing-trust">
          Portable runs the agent with your own authority and your own Grok
          configuration. It is a control surface, not a sandbox.
        </p>
      </div>
    </main>
  );
}
