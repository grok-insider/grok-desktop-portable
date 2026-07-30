/**
 * The `@` / `/` completion menu, floating above the composer.
 *
 * Keyboard first: the composer keeps focus the whole time and forwards arrow
 * keys, Enter, Tab, and Escape. Moving focus into the list would have meant
 * the user could not keep typing to narrow it, which is the only way a
 * hundred-entry list is usable.
 *
 * Everything shown is host-projected — a workspace-relative path or an
 * agent-supplied command name — so it is rendered as text and never as markup.
 */

import { FileText, Folder, SlashSquare } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../components/ui";
import type { MentionKind, MentionOption } from "../../services/mentions";

export function MentionMenu({
  kind,
  options,
  activeIndex,
  loading,
  onSelect,
  id,
}: {
  kind: MentionKind;
  options: MentionOption[];
  activeIndex: number;
  /** The host has been asked but has not answered yet. */
  loading: boolean;
  onSelect: (option: MentionOption) => void;
  /** Ties the listbox to the composer's `aria-controls`. */
  id: string;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the highlighted row in view as the arrows move it. Without this the
  // selection walks off the bottom of a scrolled list and appears stuck.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const empty = options.length === 0;

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl",
        "border border-border bg-popover shadow-overlay",
      )}
    >
      <p className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 font-mono text-label font-semibold uppercase tracking-[0.06em] text-subtle-foreground">
        {kind === "context" ? "Workspace files" : "Commands"}
        {loading ? <span className="normal-case">· loading</span> : null}
      </p>
      {empty ? (
        <p className="px-3 py-3 text-body-sm text-muted-foreground">
          {loading
            ? "Looking…"
            : kind === "context"
              ? "Nothing here matches. Keep typing the name — the agent resolves it either way."
              : "This agent published no commands."}
        </p>
      ) : (
        /*
          A plain `div`, not a `ul`. Putting `role="listbox"` on a list means
          overriding a non-interactive element, and the options then sit one
          level below the listbox rather than being its direct children.
        */
        <div
          id={id}
          role="listbox"
          aria-label={kind === "context" ? "Workspace files" : "Commands"}
          className="max-h-64 overflow-y-auto p-1"
        >
          {options.map((option, index) => {
            const active = index === activeIndex;
            const Icon =
              kind === "command"
                ? SlashSquare
                : option.hint === "directory"
                  ? Folder
                  : FileText;
            return (
              /*
                The option *is* the button. With the role on a wrapper and the
                handler on a child, a click on the row hit the wrapper and did
                nothing — the handler was never on the thing being clicked.
              */
              <button
                key={option.value}
                type="button"
                ref={active ? activeRef : undefined}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={active}
                // The composer owns focus, so this must not steal it on the
                // way down or the caret is lost before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(option)}
                className={cn(
                  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left",
                  "transition-[background-color] duration-150 ease-fluid",
                  active ? "bg-accent/70" : "hover:bg-accent/40",
                )}
              >
                <Icon size={13} className="shrink-0 text-subtle-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-foreground">
                  {option.value}
                </span>
                {option.hint === undefined ||
                option.hint === "file" ||
                option.hint === "directory" ? null : (
                  <span className="min-w-0 max-w-[50%] shrink-0 truncate text-label text-subtle-foreground">
                    {option.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
