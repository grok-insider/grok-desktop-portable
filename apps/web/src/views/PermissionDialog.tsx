/**
 * The permission decision.
 *
 * This is the one screen where a wrong label causes durable, unintended
 * authority, so it renders only the exact native options the agent offered
 * and that light ADR 0007 allows. It never synthesises an option, never shows
 * a persistent grant, and says plainly that a decision applies once.
 */

import { useEffect, useRef } from "react";
import { ShieldAlert } from "lucide-react";
import { Button, Disclosure } from "../components/ui";
import {
  OPTION_LABELS,
  hasSingleUseOption,
  renderableOptions,
  type RenderableOption,
} from "../services/protocol";

export interface PermissionPrompt {
  /** Conversation that raised it, so the answer goes back to the right one. */
  sessionId: string;
  requestId: string;
  options: string[];
}

export function PermissionDialog({
  prompt,
  onDecide,
  busy,
}: {
  prompt: PermissionPrompt;
  onDecide: (optionId: RenderableOption) => void;
  busy: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const options = renderableOptions(prompt.options);
  const answerable = hasSingleUseOption(prompt.options);

  // Focus moves into the dialog so a keyboard user is not stranded behind it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-6 backdrop-blur-[2px]"
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        aria-describedby="permission-body"
        tabIndex={-1}
        className="w-full max-w-[520px] rounded-xl border border-border bg-card p-5 shadow-dialog outline-none"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
            <ShieldAlert size={18} aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="permission-title" className="text-title-sm font-semibold text-foreground">
              The agent is asking permission
            </h2>
            <p id="permission-body" className="text-body text-muted-foreground">
              This decision applies to this request only. Grok Light cannot grant
              standing permission.
            </p>
          </div>
        </div>

        {answerable ? (
          <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            {options.map((option) => (
              <Button
                key={option}
                variant={
                  option === "reject-once"
                    ? "danger"
                    : option === "allow-once"
                      ? "primary"
                      : "secondary"
                }
                disabled={busy}
                onClick={() => onDecide(option)}
              >
                {OPTION_LABELS[option]}
              </Button>
            ))}
          </div>
        ) : (
          // The agent offered no single-use option. Showing only "Deny" would
          // look like a Light bug, so the incompatibility is named instead.
          <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
            <Disclosure>
              This version of the Grok Build CLI offered only options that create a
              standing grant, which Grok Light does not present. Answer this
              request in the Grok Build CLI itself.
            </Disclosure>
            <p className="font-mono text-body-sm text-subtle-foreground">
              offered: {prompt.options.join(", ") || "none"}
            </p>
          </div>
        )}

        <p className="mt-4 text-body-sm text-subtle-foreground">
          Persistent grants stay in the Grok Build CLI, where you can see and
          revoke them.
        </p>
      </div>
    </div>
  );
}
