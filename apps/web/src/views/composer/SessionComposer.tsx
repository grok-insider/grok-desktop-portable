/**
 * Docked session composer: MCPs, model/effort, bash bang mode, + attach menu,
 * and the `@` / `/` completion menu.
 *
 * Visual language matches OpenCode’s compact floating card (soft ring, ~96px
 * idle height, icon-only send). Leading `!` enters bash mode (Grok Build CLI
 * shell): left toolbar fades out, mono placeholder, return-key send icon —
 * card geometry stays put. Model/effort are Grok-only host projections. A
 * completion is only ever *text* inserted into the draft: `@path` and
 * `/command` go to the agent exactly as typed (light ADR 0013). Browser-picked
 * files are inlined as text/base64 in the draft — the protocol has no binary
 * attachment channel.
 */

import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  CornerDownLeft,
  FileUp,
  Image,
  Plus,
  Plug,
  Slash,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconButton, cn } from "../../components/ui";
import { formatAttachments } from "../../services/attachments";
import {
  applyDraftForBash,
  bashBody,
  bashCommandReady,
  enterBashMode,
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

const PROMPT_PLACEHOLDER = "Ask anything, / for commands, @ for context…";
const SHELL_PLACEHOLDER = "Enter shell command… git status";
/** OpenCode-like input zone: 60px min, 180px max. */
const INPUT_MIN_PX = 60;
const INPUT_MAX_PX = 180;

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Dismissal is per-mention, not global: pressing Escape should close the
  // menu for the mention being typed without disabling completion for the
  // rest of the message.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);

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

  useEffect(() => {
    if (attachNotice === null) {
      return;
    }
    const timer = setTimeout(() => setAttachNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [attachNotice]);

  // Grow the textarea with content up to INPUT_MAX_PX (OpenCode max-h-[180px]).
  const displayValue = bash ? bashBody(draft) : draft;
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (element === null) {
      return;
    }
    element.style.height = "0px";
    const next = Math.min(
      INPUT_MAX_PX,
      Math.max(INPUT_MIN_PX, element.scrollHeight),
    );
    element.style.height = `${next}px`;
  }, [displayValue, bash]);

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

  function focusAt(nextCaret: number) {
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (element === null) {
        return;
      }
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }

  /** Insert plain text at the caret (or replace the selection). */
  function insertAtCaret(text: string) {
    if (bash) {
      return;
    }
    const element = inputRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    const nextCaret = start + text.length;
    onDraftChange(next);
    setDismissedAt(null);
    focusAt(nextCaret);
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
    focusAt(applied.caret);
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

  function insertFileMention() {
    insertAtCaret("@");
  }

  function insertCommandMention() {
    // Commands only open at the start of the message (mentions.ts / CLI).
    if (bash) {
      return;
    }
    if (draft.trim().length === 0) {
      onDraftChange("/");
      setDismissedAt(null);
      focusAt(1);
      return;
    }
    // Already mid-message: put `/` at the start so the menu can open.
    const next = draft.startsWith("/") ? draft : `/${draft}`;
    onDraftChange(next);
    setDismissedAt(null);
    focusAt(1);
  }

  function enterShell() {
    if (bash) {
      return;
    }
    const next = enterBashMode(draft);
    onDraftChange(next);
    focusAt(bashBody(next).length);
  }

  const hasMcp = configTools.some(
    (tool) => tool.kind === "mcp" && tool.name.length > 0,
  );

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function onFilesPicked(list: FileList | null) {
    if (list === null || list.length === 0 || bash) {
      return;
    }
    const { text, attached, skipped } = await formatAttachments(list);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = "";
    }
    if (attached === 0) {
      setAttachNotice(
        skipped > 0
          ? "Those files were too large to attach (200 KB each, 600 KB total)."
          : "No files could be attached.",
      );
      return;
    }
    if (skipped > 0) {
      setAttachNotice(
        `Attached ${attached}; skipped ${skipped} over the size limit.`,
      );
    } else {
      setAttachNotice(null);
    }
    const element = inputRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const padBefore = start > 0 && !/\s$/.test(draft.slice(0, start)) ? "\n\n" : "";
    const padAfter = end < draft.length && !/^\s/.test(draft.slice(end)) ? "\n" : "";
    const insert = `${padBefore}${text}${padAfter}`;
    const next = `${draft.slice(0, start)}${insert}${draft.slice(end)}`;
    onDraftChange(next);
    focusAt(start + insert.length);
  }

  const modelOptions = models.map((model) => ({
    id: model.id,
    label: model.name,
  }));
  const effortOptions = efforts.map((effort) => ({
    id: effort.id,
    label: effort.label,
  }));

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
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

        {attachNotice !== null ? (
          <p
            className="mb-2 truncate px-1 font-mono text-label text-subtle-foreground"
            aria-live="polite"
          >
            {attachNotice}
          </p>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          accept="image/*,.txt,.md,.json,.jsonc,.yml,.yaml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.rs,.go,.java,.sh,.bash,.sql,.csv,.svg,.pdf,.bin,text/*,application/json,application/pdf"
          aria-hidden="true"
          onChange={(event) => {
            void onFilesPicked(event.target.files);
          }}
        />

        {/*
          MCP sits *outside* the raised composer card (left of it). A fixed-width
          slot keeps the card from shifting when bash mode fades the control.
        */}
        <div className="flex items-end gap-2">
          {hasMcp ? (
            <div
              data-composer-chrome="mcp-slot"
              className={cn(
                "mb-2 flex h-7 w-16 shrink-0 items-center self-center transition-opacity duration-200",
                bash && "pointer-events-none opacity-0",
              )}
              aria-hidden={bash ? true : undefined}
              // Boolean only — empty-string inert is treated as false in React 19.
              inert={bash ? true : undefined}
            >
              <McpControl tools={configTools} />
            </div>
          ) : null}
          <div
            role="group"
            aria-label="Prompt composer"
            data-composer-chrome="card"
            className={cn(
              "flex min-h-24 min-w-0 flex-1 flex-col rounded-xl bg-card shadow-composer",
              "transition-[box-shadow] duration-150 ease-fluid",
            )}
          >
            <label htmlFor="composer" className="sr-only">
              {bash ? "Shell command" : "Message the agent"}
            </label>
            <textarea
              id="composer"
              ref={inputRef}
              rows={1}
              value={displayValue}
              disabled={!connected}
              spellCheck={!bash}
              // Deliberately not `role="combobox"`: that would override the
              // textarea's own role and lose multiline semantics for what is
              // a multiline prompt first and a completion field second.
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
                if (handleMenuKey(event)) {
                  return;
                }
                // Ctrl/Cmd+U opens the file picker (OpenCode parity).
                if (
                  !bash &&
                  event.key.toLowerCase() === "u" &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  openFilePicker();
                  return;
                }
                if (shouldExitBashOnKey(draft, event)) {
                  event.preventDefault();
                  onDraftChange("");
                  return;
                }
                if (event.key !== "Enter" || event.shiftKey) {
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
              placeholder={bash ? SHELL_PLACEHOLDER : PROMPT_PLACEHOLDER}
              className={cn(
                "w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 pt-4",
                "text-body leading-5 text-foreground outline-none",
                "placeholder:text-subtle-foreground",
                bash && "font-mono",
              )}
              style={{ minHeight: INPUT_MIN_PX, maxHeight: INPUT_MAX_PX }}
            />

            <div className="flex h-11 shrink-0 items-center px-2">
              {/*
                OpenCode technique: left tools stay mounted and fade out in bash
                so the card never jumps height or toolbar width.
              */}
              <div
                data-composer-chrome="left-toolbar"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1 transition-opacity duration-200",
                  bash && "pointer-events-none opacity-0",
                )}
                aria-hidden={bash ? true : undefined}
                // Boolean only — empty-string inert is treated as false in React 19.
                inert={bash ? true : undefined}
              >
                <ComposerPlusMenu
                  disabled={!connected || bash}
                  onAttachFiles={openFilePicker}
                  onCommands={insertCommandMention}
                  onContext={insertFileMention}
                  onShell={enterShell}
                />
                {modelOptions.length === 0 ? null : (
                  <ComposerSelect
                    label="Model"
                    value={modelId ?? ""}
                    options={modelOptions}
                    disabled={!connected || bash}
                    onChange={onModelChange}
                  />
                )}
                {effortOptions.length === 0 ? null : (
                  <ComposerSelect
                    label="Reasoning effort"
                    value={effortId ?? ""}
                    options={effortOptions}
                    disabled={!connected || bash}
                    onChange={onEffortChange}
                  />
                )}
              </div>

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
                    <ComposerSendButton
                      bash={bash}
                      disabled={!canSend}
                      onClick={onSubmit}
                      queue
                    />
                  </>
                ) : (
                  <ComposerSendButton
                    bash={bash}
                    disabled={!canSend}
                    onClick={onSubmit}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Icon-only primary send: ArrowUp for prompts, CornerDownLeft (return) for
 * shell — matches OpenCode’s 28×28 plate.
 */
function ComposerSendButton({
  bash,
  disabled,
  onClick,
  queue = false,
}: {
  bash: boolean;
  disabled: boolean;
  onClick: () => void;
  queue?: boolean;
}) {
  const label = queue
    ? "Queue this message"
    : bash
      ? "Run shell command"
      : "Send prompt";
  const title = queue
    ? "Wait for the turn in flight, then send (Enter)"
    : bash
      ? "Run shell command (Enter)"
      : "Send prompt (Enter)";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
        "bg-primary text-primary-foreground shadow-raised",
        "transition-[background-color,opacity,transform] duration-150 ease-fluid",
        "hover:bg-primary-hover active:scale-[.98]",
        "disabled:cursor-not-allowed disabled:opacity-48",
      )}
    >
      {bash && !queue ? (
        <CornerDownLeft size={14} aria-hidden="true" />
      ) : (
        <ArrowUp size={14} aria-hidden="true" />
      )}
    </button>
  );
}

/** + menu: attach files, slash commands, @ context, shell bang. */
function ComposerPlusMenu({
  disabled,
  onAttachFiles,
  onCommands,
  onContext,
  onShell,
}: {
  disabled: boolean;
  onAttachFiles: () => void;
  onCommands: () => void;
  onContext: () => void;
  onShell: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(open, rootRef, () => setOpen(false));

  const items: {
    id: string;
    label: string;
    shortcut: string;
    icon: ReactNode;
    action: () => void;
  }[] = [
    {
      id: "files",
      label: "Images and files",
      shortcut: "Ctrl+U",
      icon: <Image size={14} aria-hidden="true" />,
      action: onAttachFiles,
    },
    {
      id: "commands",
      label: "Commands",
      shortcut: "/",
      icon: <Slash size={14} aria-hidden="true" />,
      action: onCommands,
    },
    {
      id: "context",
      label: "Context",
      shortcut: "@",
      icon: <AtSign size={14} aria-hidden="true" />,
      action: onContext,
    },
    {
      id: "shell",
      label: "Shell command",
      shortcut: "!",
      icon: <Terminal size={14} aria-hidden="true" />,
      action: onShell,
    },
  ];

  return (
    <div ref={rootRef} className="relative shrink-0">
      <IconButton
        size="sm"
        disabled={disabled}
        aria-label="Add to message"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add images, files, commands, or shell"
        onClick={() => setOpen((current) => !current)}
        className={open ? "bg-accent/60 text-foreground" : undefined}
      >
        <Plus size={14} aria-hidden="true" />
      </IconButton>
      {open ? (
        <div
          role="menu"
          aria-label="Add to message"
          className="absolute bottom-full left-0 z-40 mb-2 min-w-[15.5rem] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-overlay"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-body",
                "text-foreground transition-colors duration-150 ease-fluid",
                "hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none",
              )}
              onClick={() => {
                setOpen(false);
                item.action();
              }}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                {item.id === "files" ? (
                  <FileUp size={14} aria-hidden="true" />
                ) : (
                  item.icon
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="shrink-0 font-mono text-label text-subtle-foreground">
                {item.shortcut}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Custom model/effort menu — same keyboard and dismiss behaviour as MCP, with
 * a selected check and raised popover so it is not the browser's bare select.
 */
function ComposerSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useDismissOnOutside(open, rootRef, () => setOpen(false));

  const selected = options.find((option) => option.id === value);
  const display = selected?.label ?? label;

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-[11rem] shrink">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={display}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 max-w-full items-center gap-1 rounded-md border px-2",
          "text-body-sm outline-none transition-[background-color,border-color,color,box-shadow]",
          "duration-150 ease-fluid disabled:opacity-48",
          open
            ? "border-input bg-card text-foreground shadow-raised"
            : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{display}</span>
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 opacity-70 transition-transform duration-150 ease-fluid",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute bottom-full left-0 z-40 mb-2 max-h-56 min-w-full overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-overlay"
        >
          {options.map((option) => {
            const isSelected = option.id === value;
            return (
              <li key={option.id} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body-sm",
                    "transition-colors duration-150 ease-fluid",
                    isSelected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected ? (
                    <Check
                      size={14}
                      className="shrink-0 text-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
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

  useDismissOnOutside(open, rootRef, () => setOpen(false));

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

/** Outside pointer + Escape dismiss, only while open. */
function useDismissOnOutside(
  open: boolean,
  rootRef: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
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
        onDismiss();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, onDismiss]);
}
