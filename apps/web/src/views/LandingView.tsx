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

const SERVE_SNIPPET = `grok-bridge serve
grok-bridge open`;

const OPEN_SNIPPET = `grok-bridge open`;

const X_PROFILE_URL = "https://x.com/GrokInsider";
const GITHUB_REPO_URL =
  "https://github.com/grok-insider/grok-desktop-portable";

/** Brand marks as inline SVGs — lucide-react 1.x no longer ships Github/X. */
function XIcon() {
  return (
    <svg
      className="landing-social-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg
      className="landing-social-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
      />
    </svg>
  );
}

export function LandingView({
  probe,
  onRetry,
  hadPort = false,
}: {
  probe: BridgeProbeState;
  onRetry: () => void;
  /** True when this profile has a remembered loopback port (even if host is down). */
  hadPort?: boolean;
}) {
  let title = "Grok Desktop Portable";
  let body =
    "Drive your local Grok Build CLI from the browser. This site is only the UI — install and authentication stay on your machine.";
  let snippet = INSTALL_SNIPPET;
  let steps: string[] = [
    "Install the bridge (or confirm it is already installed).",
    "Run grok-bridge serve in a terminal.",
    "Run grok-bridge open and open the printed URL once to pair.",
  ];

  switch (probe.kind) {
    case "checking":
      title = "Looking for the local bridge…";
      body = "Checking whether grok-bridge is running on this machine.";
      snippet = hadPort ? SERVE_SNIPPET : INSTALL_SNIPPET;
      break;
    case "bridge_missing":
      if (hadPort) {
        title = "Start the local bridge";
        body =
          "This browser remembers a local bridge port, but nothing answered. Start grok-bridge on this machine, then retry.";
        snippet = SERVE_SNIPPET;
        steps = [
          "In a terminal, run grok-bridge serve.",
          "If the port changed, run grok-bridge open and open the new URL once.",
          "Then press Retry.",
        ];
      } else {
        title = "Start the local bridge";
        body =
          "Install and run grok-bridge on this machine, then retry. The site only drives your local Grok Build CLI through that bridge.";
        snippet = INSTALL_SNIPPET;
        steps = [
          "Install the bridge (or confirm it is already installed).",
          "Run grok-bridge serve in a terminal.",
          "Run grok-bridge open and open the printed URL once to pair.",
        ];
      }
      break;
    case "blocked_lna":
      title = "Allow local network access";
      body =
        "This browser blocked connections from desktop.grok.me to your machine. Allow local network (or loopback) access for this site, then retry.";
      snippet = SERVE_SNIPPET;
      steps = [];
      break;
    case "needs_pairing":
      title = "Pair this browser";
      body =
        "The bridge is running. Run `grok-bridge open` and open the printed URL (or paste the #pair= link) so this tab can control your CLI.";
      snippet = OPEN_SNIPPET;
      steps = [
        "Run grok-bridge open in a terminal.",
        "Open the printed URL once in this browser.",
      ];
      break;
    case "error":
      title = "Bridge error";
      body = probe.message;
      snippet = hadPort ? SERVE_SNIPPET : INSTALL_SNIPPET;
      break;
    case "ready":
      title = "Ready";
      body = "Connecting to Work…";
      steps = [];
      break;
  }

  const showCommands =
    probe.kind === "bridge_missing" ||
    probe.kind === "needs_pairing" ||
    probe.kind === "checking" ||
    probe.kind === "error";

  return (
    <main
      className="landing"
      data-testid="landing-view"
      data-probe-kind={probe.kind}
      data-had-port={hadPort ? "1" : "0"}
    >
      <div className="landing-card">
        <p className="landing-kicker">Grok Desktop Portable</p>
        <h1>{title}</h1>
        <p className="landing-body">{body}</p>
        {showCommands ? (
          <>
            <p className="landing-steps-label">On this machine</p>
            <pre className="landing-install" data-testid="landing-install">
              {snippet}
            </pre>
            {steps.length > 0 ? (
              <ol className="landing-steps">
                {steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
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
      <nav className="landing-social" aria-label="Social links">
        <a
          className="landing-social-link"
          href={X_PROFILE_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GrokInsider on X"
        >
          <XIcon />
        </a>
        <a
          className="landing-social-link"
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Source on GitHub"
        >
          <GithubIcon />
        </a>
      </nav>
    </main>
  );
}
