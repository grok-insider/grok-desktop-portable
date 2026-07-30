/**
 * What an unpaired or blocked browser sees.
 *
 * Opening the bookmark cannot start a stopped host, and pairing is only
 * possible from the terminal in the owning account. WebKit is refused per
 * light ADR 0008 before any pairing attempt looks broken.
 */

import { PROTOCOL_VERSION } from "../services/protocol";
import {
  AlertTriangle,
  Globe,
  KeyRound,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { Button, Card, Disclosure, SectionLabel } from "../components/ui";
import type { ClientFailure } from "../services/client";
import { ThemeToggle } from "../theme/ThemeToggle";

export type SetupMode =
  | { kind: "unpaired" }
  | { kind: "failure"; failure: ClientFailure }
  | { kind: "unsupported_browser"; reason: string };

function failureTitle(failure: ClientFailure): string {
  switch (failure.kind) {
    case "rejected":
      return "Pairing link unusable";
    case "protocol_mismatch":
      return "Host version mismatch";
    case "unreachable":
      return "Host not reachable";
    case "not_paired":
      return "Not paired";
    case "refused":
    case "bad_request":
      return "Request refused";
  }
}

function failureMessage(failure: ClientFailure): string {
  switch (failure.kind) {
    case "rejected":
      return "That pairing link was already used or has expired. Run `grok-bridge open` again for a fresh one.";
    case "protocol_mismatch":
      return `This page speaks protocol ${PROTOCOL_VERSION} and the host speaks ${failure.hostVersion}. Reload after rebuilding or restarting the host.`;
    case "unreachable":
      return "The local host stopped responding. Start it with `grok-bridge serve`, then open a fresh pairing link.";
    case "refused":
    case "not_paired":
    case "bad_request":
      return "The host refused the request. If you expected to be paired, run `grok-bridge open` again.";
  }
}

function failureSteps(failure: ClientFailure): string[] {
  switch (failure.kind) {
    case "unreachable":
      return [
        "In the account that owns the host, run: grok-bridge serve",
        "Then run: grok-bridge open",
        "Open the new URL in this browser (Chromium or Firefox 84+).",
      ];
    case "protocol_mismatch":
      return [
        "Update or rebuild grok-bridge so SPA and host match.",
        "Restart with: grok-bridge serve",
        "Hard-reload this page (or open a new pairing URL).",
      ];
    case "rejected":
      return [
        "Run: grok-bridge open",
        "Use the new single-use link once; do not bookmark the #pair= fragment.",
      ];
    default:
      return [
        "Run: grok-bridge open",
        "Open the printed URL once to pair this browser.",
      ];
  }
}

export function SetupView({
  mode = { kind: "unpaired" },
  onReload,
}: {
  mode?: SetupMode;
  /** Optional hard reload for version mismatch. */
  onReload?: () => void;
}) {
  const alert =
    mode.kind === "failure"
      ? { title: failureTitle(mode.failure), body: failureMessage(mode.failure) }
      : mode.kind === "unsupported_browser"
        ? { title: "Browser not supported", body: mode.reason }
        : null;

  const steps =
    mode.kind === "unsupported_browser"
      ? [
          "Install Chromium or Firefox 84+ on this machine.",
          "Run grok-bridge open and open the URL in that browser.",
        ]
      : mode.kind === "failure"
        ? failureSteps(mode.failure)
        : [
            "Run this in a terminal, in the account that owns the host: grok-bridge open",
            "Open the URL it prints. It pairs this browser once, then clears the fragment.",
          ];

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-[720px] flex-col justify-center gap-6 px-6 py-12">
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <header className="flex flex-col gap-2">
        <h1 className="text-title-lg font-semibold text-foreground">Grok Light</h1>
        <p className="text-body-lg text-muted-foreground">
          A local interface for the Grok Build CLI you already installed and
          authenticated.
        </p>
      </header>

      {alert === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md bg-destructive-soft px-3 py-3 text-body text-destructive"
        >
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={16} aria-hidden="true" />
            {alert.title}
          </p>
          <p>{alert.body}</p>
          {mode.kind === "failure" &&
          mode.failure.kind === "protocol_mismatch" &&
          onReload !== undefined ? (
            <div>
              <Button variant="secondary" onClick={onReload}>
                <RefreshCw size={14} aria-hidden="true" />
                Reload page
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <Card>
        <SectionLabel>
          {mode.kind === "unsupported_browser" ? "Use a supported browser" : "Pair this browser"}
        </SectionLabel>
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-3">
              {index === 0 && mode.kind === "unsupported_browser" ? (
                <Globe size={16} className="mt-0.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              ) : index === 0 ? (
                <TerminalSquare
                  size={16}
                  className="mt-0.5 shrink-0 text-subtle-foreground"
                  aria-hidden="true"
                />
              ) : (
                <KeyRound
                  size={16}
                  className="mt-0.5 shrink-0 text-subtle-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="text-body text-foreground">{step}</p>
                {index === 0 && mode.kind !== "unsupported_browser" ? (
                  <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-body-sm text-foreground">
                    {mode.kind === "failure" && mode.failure.kind === "unreachable"
                      ? "grok-bridge serve\ngrok-bridge open"
                      : "grok-bridge open"}
                  </pre>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Disclosure>
        Grok Light runs the agent with your own authority, using your own Grok
        configuration. It is a control surface, not a sandbox. Supported
        browsers: Chromium and Firefox 84+. WebKit is not supported.
      </Disclosure>

      <p className="text-body-sm text-subtle-foreground">
        Opening this page cannot start a stopped host. Only{" "}
        <span className="font-mono">grok-bridge serve</span> can.
      </p>
    </main>
  );
}
