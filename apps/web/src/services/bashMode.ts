/**
 * Composer bash mode (`!` prefix), matching Grok Build CLI / pager semantics.
 *
 * Pager: `PromptInputMode::Bash` + empty text + exit key → Normal
 * (Backspace / Esc / Ctrl+W / Ctrl+U / Ctrl+C). Light mirrors that.
 */

/** True when the draft is in shell mode (leading `!`). */
export function isBashMode(draft: string): boolean {
  return draft.startsWith("!");
}

/** Command body without the bang chrome. */
export function bashBody(draft: string): string {
  return draft.replace(/^!\s?/, "");
}

/**
 * Text sent for a bash turn (`! cmd`), matching CLI history restore shape.
 */
export function bashSendText(draft: string): string {
  const command = draft.replace(/^!\s*/, "").trim();
  return command.length === 0 ? "!" : `! ${command}`;
}

/** Whether the draft has a non-empty shell command after the bang. */
export function bashCommandReady(draft: string): boolean {
  return draft.replace(/^!\s*/, "").trim().length > 0;
}

/**
 * Enter bash mode: ensure a leading `!` (and a space when empty for typing).
 */
export function enterBashMode(draft: string): string {
  if (draft.startsWith("!")) {
    return draft;
  }
  if (draft.length === 0) {
    return "! ";
  }
  return `! ${draft}`;
}

/** Leave bash mode: strip a leading bang (and optional space). */
export function exitBashMode(draft: string): string {
  return draft.replace(/^!\s?/, "");
}

/**
 * Apply a keystroke intent: typing `!` as the first character enters bash mode.
 */
export function applyDraftForBash(next: string, previous: string): string {
  if (next === "!" && !previous.startsWith("!")) {
    return "! ";
  }
  return next;
}

/**
 * Keys that exit Bash when the command body is empty — same set as
 * `PromptInputMode::Bash` in the Grok Build pager (`is_exit_key`).
 */
export function isBashExitKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (event.key === "Backspace" || event.key === "Escape") {
    return true;
  }
  // Ctrl+W / Ctrl+U / Ctrl+C (meta for macOS parity on the same letters)
  if (event.ctrlKey === true || event.metaKey === true) {
    const letter = event.key.toLowerCase();
    return letter === "w" || letter === "u" || letter === "c";
  }
  return false;
}

/**
 * Whether an exit-key press should leave bash mode (empty body + exit key).
 */
export function shouldExitBashOnKey(
  draft: string,
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean },
): boolean {
  if (!isBashMode(draft)) {
    return false;
  }
  if (bashBody(draft).length > 0) {
    return false;
  }
  return isBashExitKey(event);
}
