/**
 * Deciding when the composer is mid-mention, and what replaces it.
 *
 * Kept free of React so the rules can be tested directly: which sigil is
 * active, what has been typed after it, and exactly which slice of the draft a
 * selection replaces. Getting that slice wrong is what makes a completion menu
 * feel broken — it eats a character, or leaves the sigil behind.
 *
 * A trigger only counts at a word boundary. Without that, an email address or
 * a path already in the draft would open the menu on every keystroke.
 */

/** Which menu is open. */
export type MentionKind = "context" | "command";

/** A mention the user is part-way through typing. */
export interface ActiveMention {
  kind: MentionKind;
  /** What has been typed after the sigil, possibly empty. */
  query: string;
  /** Index of the sigil in the draft. */
  start: number;
  /** Index just past the typed query. */
  end: number;
}

const SIGILS: Record<string, MentionKind> = {
  "@": "context",
  "/": "command",
};

/**
 * A mention runs until whitespace.
 *
 * Deliberately permissive about the rest: a path may contain dots, dashes, and
 * slashes, and a command may contain a colon, so the terminator is the one
 * character none of them can hold.
 */
function isTerminator(character: string): boolean {
  return /\s/.test(character);
}

/**
 * The mention the caret currently sits inside, if any.
 *
 * `caret` is the selection start. Only text before the caret is considered:
 * completing against characters the user has not reached yet would replace
 * things they are still editing.
 */
export function activeMention(draft: string, caret: number): ActiveMention | null {
  const position = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, position);

  for (let index = before.length - 1; index >= 0; index -= 1) {
    const character = before[index]!;
    if (isTerminator(character)) {
      return null;
    }
    const kind = SIGILS[character];
    if (kind === undefined) {
      continue;
    }

    // A command is only a command at the very start of the message, which is
    // what the CLI accepts. Anywhere else a slash is just a slash — and it is
    // usually a path separator inside an `@` mention, so the scan continues
    // past it rather than giving up. Stopping here meant `@src/App` never
    // opened the menu at all.
    if (kind === "command") {
      if (index === 0) {
        return { kind, query: before.slice(1), start: 0, end: position };
      }
      continue;
    }

    // `@` only at a word boundary: `me@example.com` is an address, not a
    // mention, and treating it as one opened the menu while the user typed.
    if (index !== 0 && !isTerminator(draft[index - 1]!)) {
      return null;
    }
    return {
      kind,
      query: before.slice(index + 1),
      start: index,
      end: position,
    };
  }
  return null;
}

/** The draft and caret after accepting a completion. */
export interface AppliedMention {
  draft: string;
  caret: number;
}

/**
 * Replace the mention under the caret with the chosen value.
 *
 * A trailing space is added so the next keystroke starts a new word rather
 * than extending the mention and reopening the menu on the value just chosen.
 */
export function applyMention(
  draft: string,
  mention: ActiveMention,
  value: string,
): AppliedMention {
  const sigil = mention.kind === "context" ? "@" : "/";
  const rest = draft.slice(mention.end);
  // Only when there is not already one: completing mid-sentence otherwise left
  // a double space behind the mention.
  const separator = rest.startsWith(" ") || rest.startsWith("\n") ? "" : " ";
  const inserted = `${sigil}${value}${separator}`;
  return {
    draft: draft.slice(0, mention.start) + inserted + rest,
    caret: mention.start + inserted.length + (separator === "" ? 1 : 0),
  };
}

/** One row in the menu. */
export interface MentionOption {
  /** What gets inserted after the sigil. */
  value: string;
  /** Right-hand hint, when there is one. */
  hint?: string;
}

/**
 * Rank options for what has been typed.
 *
 * A prefix match beats a match anywhere, and a shorter candidate beats a
 * longer one at equal rank, so `src/App.tsx` is not buried under every file
 * that merely contains `app`. Ordering is otherwise the host's.
 */
export function rankMentions(
  options: MentionOption[],
  query: string,
  limit = 20,
): MentionOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return options.slice(0, limit);
  }

  const scored: { option: MentionOption; rank: number }[] = [];
  for (const option of options) {
    const haystack = option.value.toLowerCase();
    const at = haystack.indexOf(needle);
    if (at === -1) {
      // Also allow a match on the last segment, so typing `home` finds
      // `src/views/home.tsx` without typing the directories above it.
      const segment = haystack.slice(haystack.lastIndexOf("/") + 1);
      if (!segment.includes(needle)) {
        continue;
      }
      scored.push({ option, rank: 2 });
      continue;
    }
    scored.push({ option, rank: at === 0 ? 0 : 1 });
  }

  scored.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return left.option.value.length - right.option.value.length;
  });
  return scored.slice(0, limit).map((entry) => entry.option);
}
