/**
 * Docked session composer: MCPs, model/effort, bash bang mode, and the `@` / `/`
 * completion menu.
 *
 * Leading `!` enters bash mode (Grok Build CLI shell). Model/effort are
 * Grok-only host projections. Behaviour matches docs/light/ui.md.
 *
 * A completion is only ever *text* inserted into the draft: `@path` and
 * `/command` go to the agent exactly as typed, and the host neither parses nor
 * acts on them (light ADR 0013).
 */

import { Plus, Plug, Send, Square, Terminal, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton, cn } from "../../components/ui";
import {
  applyDraftForBash,
  bashBody,
  bashCommandReady,
  isBashMode,
  shouldExitBashOnKey,
} from "../../services/bashMode";
import {
  activeMention,
  applyMention,
  rankMentions,
  type MentionOption,
} from "../../services/mentions";
import type { CommandProjection } from "../../services/protocol";
import type { ContextEntry, ToolProjection } from "../../services/outcomes";
import type { ModelProjection } from "../../services/models";
import { effortsForModel } from "../../services/models";
import type { SessionPhase } from "../SessionView";
import { MentionMenu } from "./MentionMenu";
import { PromptQueue } from "./PromptQueue";

export function SessionComposer({
  connected,
  phase,
  draft,
  onDraftChange,
  queued,
  onRemoveQueued,
  configTools = [],
  models,
  modelId,
  effortId,
  onModelChange,
  onEffortChange,
  onSubmit,
  onSendNow,
  onCancel,
  commands = [],
  contextEntries = [],
  contextLoading = false,
  onContextQuery,
}: {
  connected: boolean;
  phase: SessionPhase;
  draft: string;
  onDraftChange: (text: string) => void;
  queued: { entryId: string; text: string }[];
  onRemoveQueued: (entryId: string) => void;
  /** Host-projected configuration entries; only MCP names are rendered. */
  configTools?: ToolProjection[];
  models: ModelProjection[];
  modelId: string | null;
  effortId: string | null;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effortId: string) => void;
  onSubmit: () => void;
  onSendNow: () => void;
  onCancel: () => void;
  /** Slash commands the agent published for this conversation. */
  commands?: CommandProjection[];
  /** Workspace-relative paths the host projected for the last `@` query. */
  contextEntries?: ContextEntry[];
  contextLoading?: boolean;
  /** Ask the host to refresh the `@` candidates for what has been typed. */
  onContextQuery?: (query: string) => void;
}) {
  const bash = isBashMode(draft);
  const efforts = effortsForModel(models, modelId);
  const canSend = connected && (bash ? bashCommandReady(draft) : draft.trim().length > 0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Dismissal is per-mention, not global: pressing Escape should close the
  // menu for the mention being typed without disabling completion for the
  // rest of the message.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // Bash mode is a shell command, not a prompt: `@` and `/` are ordinary shell
  // characters there and must not open a menu.
  const mention = bash ? null : activeMention(draft, caret);
  const dismissed = mention !== null && dismissedAt === mention.start;
  const menuOpen = mention !== null && !dismissed;

  const options = useMemo((): MentionOption[] => {
    if (mention === null) {
      return [];
    }
    if (mention.kind === "command") {
      return rankMentions(
        commands.map((command) => ({
          value: command.name,
          hint: command.description ?? undefined,
        })),
        mention.query,
      );
    }
    return rankMentions(
      contextEntries.map((entry) => ({ value: entry.path, hint: entry.kind })),
      mention.query,
    );
  }, [mention, commands, contextEntries]);

  // Ask the host for candidates as the query changes. Commands arrive over the
  // event stream and need no request.
  const contextQuery = mention?.kind === "context" ? mention.query : null;
  useEffect(() => {
    if (contextQuery === null || onContextQuery === undefined) {
      return;
    }
    const timer = setTimeout(() => onContextQuery(contextQuery), 120);
    return () => clearTimeout(timer);
  }, [contextQuery, onContextQuery]);

  // A narrowing query can shorten the list under the highlight, so the index
  // is clamped rather than left pointing past the end.
  useEffect(() => {
    setActiveIndex((current) => (current >= options.length ? 0 : current));
  }, [options.length]);

  /** Track the caret so the menu follows it, including on click and arrows. */
  function syncCaret() {
    const element = inputRef.current;
    if (element === null) {
      return;
    }
    // Bash mode strips the leading `! ` from the value, so the offset only
    // lines up with the draft when it is not in play. It has no menu anyway.
    setCaret(element.selectionStart ?? 0);
  }

  function choose(option: MentionOption) {
    if (mention === null) {
      return;
    }
    const applied = applyMention(draft, mention, option.value);
    onDraftChange(applied.draft);
    setDismissedAt(null);
    // The caret must land after the inserted text, which React will not do on
    // its own once the value is replaced from outside.
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (element === null) {
        return;
      }
      element.focus();
      element.setSelectionRange(applied.caret, applied.caret);
      setCaret(applied.caret);
    });
  }

  /**
   * Keys the menu owns while it is open.
   *
   * Returns true when the key was consumed, so the composer's own Enter and
   * Escape handling does not also fire — accepting a completion must not
   * submit the prompt.
   */
  function handleMenuKey(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!menuOpen) {
      return false;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedAt(mention.start);
      return true;
    }
    if (options.length === 0) {
      return false;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % options.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + options.length) % options.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const option = options[activeIndex] ?? options[0];
      if (option !== undefined) {
        choose(option);
      }
      return true;
    }
    return false;
  }

  /**
   * Insert `@` at the caret so the workspace-file menu opens.
   *
   * Light never takes a filesystem path from the browser (light ADR 0013);
   * this only types a mention the agent resolves, the same as the user would.
   */
  function insertFileMention() {
    if (bash) {
      return;
    }
    const element = inputRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}@${draft.slice(end)}`;
    const caret = start + 1;
    onDraftChange(next);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      const target = inputRef.current;
      if (target === null) {
        return;
      }
      target.focus();
      target.setSelectionRange(caret, caret);
      setCaret(caret);
    });
  }

  return (
    <div className="shrink-0 border-t border-border px-6 pb-4 pt-3">
      <div className="relative mx-auto w-[min(760px,100%)]">
        {menuOpen ? (
          <MentionMenu
            id={listboxId}
            kind={mention.kind}
            options={options}
            activeIndex={activeIndex}
            loading={mention.kind === "context" && contextLoading}
            onSelect={choose}
          />
        ) : null}

        <PromptQueue queued={queued} onRemove={onRemoveQueued} />

        {/*
          MCP sits *outside* the raised composer card (left of it), so the
          card's toolbar stays model/effort/send. The plug is ambient context
          for the conversation, not a prompt control.
        */}
        <div className="flex items-end gap-2">
          {bash ? null : (
            <div className="mb-2 shrink-0 self-center">
              <McpControl tools={configTools} />
            </div>
          )}
          <div
            role="group"
            aria-label="Prompt composer"
            className={cn(
              "flex min-h-24 min-w-0 flex-1 flex-col rounded-xl border bg-card shadow-overlay",
              "transition-[border-color,box-shadow] duration-150 ease-fluid",
              bash ? "border-warning/50" : "border-input focus-within:border-input-hover",
            )}
          >
          {bash ? (
            <p
              className="flex items-center gap-1.5 px-4 pt-1 font-mono text-label font-semibold text-warning"
              role="status"
            >
              <Terminal size={12} aria-hidden="true" />
              Bash mode — runs a shell command with your authority
            </p>
          ) : null}

          <label htmlFor="composer" className="sr-only">
            {bash ? "Shell command" : "Message the agent"}
          </label>
          <div className="flex flex-1 items-start gap-1 px-2">
            {bash ? (
              <span
                className="select-none pl-2 pt-2 font-mono text-body-lg font-semibold text-warning"
                aria-hidden="true"
              >
                !
              </span>
            ) : null}
            <textarea
              id="composer"
              ref={inputRef}
              rows={3}
              value={bash ? bashBody(draft) : draft}
              disabled={!connected}
              // Deliberately not `role="combobox"`: that would override the
              // textarea's own role and lose multiline semantics for what is
              // a multiline prompt first and a completion field second.
              //
              // `aria-expanded` goes with it — ARIA does not allow it on a
              // textbox. The open menu is still reachable and announced
              // through `aria-controls` and `aria-activedescendant`.
              aria-controls={menuOpen ? listboxId : undefined}
              aria-activedescendant={
                menuOpen && options.length > 0
                  ? `${listboxId}-option-${activeIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              onSelect={syncCaret}
              onClick={syncCaret}
              onChange={(event) => {
                setCaret(event.target.selectionStart ?? 0);
                // Any edit reopens a menu the user dismissed, because they are
                // now typing a different mention than the one they closed.
                setDismissedAt(null);
                const body = event.target.value;
                if (bash) {
                  // Empty body keeps bash chrome until an exit key (CLI: mode
                  // stays until Backspace/Esc on empty). Hold a lone "!".
                  onDraftChange(body.length === 0 ? "!" : `! ${body}`);
                  return;
                }
                onDraftChange(applyDraftForBash(body, draft));
              }}
              onKeyDown={(event) => {
                // The menu takes arrows, Enter, Tab, and Escape first, so
                // accepting a completion cannot also send the prompt.
                if (handleMenuKey(event)) {
                  return;
                }
                // Grok Build pager: empty bash prompt + Backspace/Esc/Ctrl+W/U/C
                // returns to Normal mode.
                if (shouldExitBashOnKey(draft, event)) {
                  event.preventDefault();
                  onDraftChange("");
                  return;
                }
                if (event.key !== "Enter" || event.shiftKey) {
                  // Arrows move the caret, so the menu has to follow it. The
                  // event fires before the move lands, hence the deferral.
                  requestAnimationFrame(syncCaret);
                  return;
                }
                event.preventDefault();
                if ((event.ctrlKey || event.metaKey) && phase === "streaming") {
                  onSendNow();
                  return;
                }
                onSubmit();
              }}
              placeholder={
                bash
                  ? "shell command… (Backspace exits when empty)"
                  : "Describe the task — @ for files, / for commands, ! for bash"
              }
              className="min-h-[4.5rem] flex-1 resize-none bg-transparent px-2 pb-1 pt-2.5 text-body-lg text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </div>

          {/*
            The control bar. Send now and Stop are icon-only: they are
            modifiers on the one action the user came here to take, and as three
            equal filled buttons they weighed more than the message itself.
            Their meaning is carried by `title` as well as the accessible name,
            because an icon alone does not explain itself.
          */}
          <div className="flex h-11 items-center gap-1 px-2">
            {bash ? null : (
              <IconButton
                size="sm"
                onClick={insertFileMention}
                disabled={!connected}
                title="Mention a workspace file (@)"
                aria-label="Add workspace file mention"
              >
                <Plus size={14} aria-hidden="true" />
              </IconButton>
            )}
            {models.length === 0 ? null : (
              <select
                value={modelId ?? ""}
                disabled={!connected || bash}
                onChange={(event) => onModelChange(event.target.value)}
                className={SELECT_CLASS}
                aria-label="Model"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            )}
            {efforts.length === 0 ? null : (
              <select
                value={effortId ?? ""}
                disabled={!connected || bash}
                onChange={(event) => onEffortChange(event.target.value)}
                className={SELECT_CLASS}
                aria-label="Reasoning effort"
              >
                {efforts.map((effort) => (
                  <option key={effort.id} value={effort.id}>
                    {effort.label}
                  </option>
                ))}
              </select>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-1">
              {phase === "streaming" ? (
                <>
                  <IconButton
                    size="sm"
                    onClick={onSendNow}
                    disabled={!canSend}
                    title="Stop the current turn and run this message next (Ctrl+Enter)"
                    aria-label="Stop the current turn and send this now"
                  >
                    <Zap size={14} aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={onCancel}
                    title="Stop the current turn and send nothing"
                    aria-label="Stop the current turn"
                  >
                    <Square size={14} aria-hidden="true" />
                  </IconButton>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={onSubmit}
                    disabled={!canSend}
                    title="Wait for the turn in flight, then send (Enter)"
                    aria-label="Queue this message"
                  >
                    <Send size={14} aria-hidden="true" />
                    Queue
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onSubmit}
                  disabled={!canSend}
                  aria-label={bash ? "Run shell command" : "Send prompt"}
                >
                  <Send size={14} aria-hidden="true" />
                  {bash ? "Run" : "Send"}
                </Button>
              )}
            </div>
          </div>

          {bash ? (
            <p className="px-4 pb-2 font-mono text-label text-subtle-foreground">
              Esc exits bash · runs with your authority
            </p>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function McpControl({ tools }: { tools: ToolProjection[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const byName = new Map<string, boolean>();
  for (const tool of tools) {
    if (tool.kind !== "mcp" || tool.name.length === 0) {
      continue;
    }
    byName.set(tool.name, (byName.get(tool.name) ?? false) || tool.enabled);
  }
  const mcps = Array.from(byName, ([name, enabled]) => ({ name, enabled }));

  // Dismiss like a menu: outside pointer and Escape. Listen only while open so
  // idle composers do not pay for document listeners.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (root === null || !(event.target instanceof Node)) {
        return;
      }
      if (!root.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (mcps.length === 0) {
    return null;
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5",
          "text-body-sm text-muted-foreground transition-[background-color,color] duration-150 ease-fluid",
          "hover:bg-accent/60 hover:text-foreground",
          open && "bg-accent/60 text-foreground",
        )}
        aria-label={`${mcps.length} MCP ${mcps.length === 1 ? "integration" : "integrations"}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        <Plug size={12} aria-hidden="true" />
        <span>MCP</span>
        <span className="font-mono text-label text-subtle-foreground">{mcps.length}</span>
      </button>
      {open ? (
        <div
          className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-lg border border-border bg-popover p-2 shadow-overlay"
          role="listbox"
          aria-label="MCP integrations"
        >
          <p className="px-1 font-mono text-label font-semibold uppercase tracking-[0.06em] text-subtle-foreground">
            MCP integrations
          </p>
          <ul className="mt-1 max-h-48 overflow-y-auto">
            {mcps.map((mcp) => (
              <li
                key={mcp.name}
                className="flex min-h-7 items-center gap-2 rounded-md px-1 text-body-sm text-muted-foreground"
                role="option"
                aria-selected={false}
                aria-label={`${mcp.name}, ${mcp.enabled ? "on" : "off"}`}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    mcp.enabled ? "bg-success" : "bg-destructive",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate" title={mcp.name}>
                  {mcp.name}
                </span>
                <span
                  className={cn(
                    "font-mono text-label",
                    mcp.enabled ? "text-success" : "text-destructive",
                  )}
                >
                  {mcp.enabled ? "on" : "off"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Ghost pill until hovered.
 *
 * Native `<select>` on purpose: a hand-rolled menu would need a popover
 * primitive Light does not have, and would have to re-earn the keyboard and
 * screen-reader behaviour the platform control already has.
 */
const SELECT_CLASS = cn(
  "h-7 max-w-[12rem] truncate rounded-md border border-transparent bg-transparent px-1.5",
  "text-body-sm text-muted-foreground outline-none",
  "transition-[background-color,border-color,color] duration-150 ease-fluid",
  "hover:bg-accent/60 hover:text-foreground focus:border-input focus:bg-card",
  "disabled:opacity-48",
);
