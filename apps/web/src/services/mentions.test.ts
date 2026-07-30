import { describe, expect, it } from "vitest";
import { activeMention, applyMention, rankMentions } from "./mentions";

describe("activeMention", () => {
  it("opens on a bare sigil at the start", () => {
    expect(activeMention("@", 1)).toEqual({
      kind: "context",
      query: "",
      start: 0,
      end: 1,
    });
    expect(activeMention("/", 1)).toEqual({
      kind: "command",
      query: "",
      start: 0,
      end: 1,
    });
  });

  it("collects what has been typed after the sigil", () => {
    expect(activeMention("look at @src/App", 16)).toMatchObject({
      kind: "context",
      query: "src/App",
      start: 8,
      end: 16,
    });
  });

  it("closes once the mention is terminated by whitespace", () => {
    expect(activeMention("@src/App.tsx and then", 21)).toBeNull();
  });

  it("ignores a sigil that is not at a word boundary", () => {
    // Otherwise an address or a URL opened the menu on every keystroke.
    expect(activeMention("mail me@example.com", 19)).toBeNull();
    expect(activeMention("see http://x/y", 14)).toBeNull();
  });

  it("treats a slash as a command only at the very start", () => {
    expect(activeMention("/help", 5)).toMatchObject({ kind: "command" });
    // Mid-sentence a slash is just a slash, which is what the CLI accepts too.
    expect(activeMention("and /help", 9)).toBeNull();
  });

  it("only considers text before the caret", () => {
    // Completing against characters the user has not reached yet would replace
    // something they are still editing.
    expect(activeMention("@abc", 2)).toMatchObject({ query: "a", end: 2 });
  });

  it("returns nothing when there is no mention", () => {
    expect(activeMention("", 0)).toBeNull();
    expect(activeMention("plain text", 10)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces exactly the typed mention and leaves the rest alone", () => {
    const draft = "look at @src/Ap and fix it";
    const mention = activeMention(draft, 15)!;
    expect(applyMention(draft, mention, "src/App.tsx").draft).toBe(
      "look at @src/App.tsx and fix it",
    );
  });

  it("adds a trailing space so the menu does not reopen on the choice", () => {
    const mention = activeMention("@", 1)!;
    expect(applyMention("@", mention, "README.md")).toEqual({
      draft: "@README.md ",
      caret: 11,
    });
  });

  it("does not double the space when the draft already has one", () => {
    const draft = "look at @src and fix it";
    const mention = activeMention(draft, 12)!;
    const applied = applyMention(draft, mention, "src/App.tsx");
    expect(applied.draft).toBe("look at @src/App.tsx and fix it");
    expect(applied.draft).not.toContain("  ");
    // The caret lands after the space that was already there.
    expect(applied.draft.slice(0, applied.caret)).toBe("look at @src/App.tsx ");
  });

  it("completes a mention that contains a path separator", () => {
    // The backwards scan must not mistake `/` inside a path for a command.
    const draft = "look at @src/vie";
    const mention = activeMention(draft, draft.length)!;
    expect(mention.kind).toBe("context");
    expect(applyMention(draft, mention, "src/views/home.tsx").draft).toBe(
      "look at @src/views/home.tsx ",
    );
  });

  it("keeps the command sigil when completing a command", () => {
    const mention = activeMention("/he", 3)!;
    expect(applyMention("/he", mention, "help").draft).toBe("/help ");
  });
});

describe("rankMentions", () => {
  const options = [
    { value: "docs/apple.md" },
    { value: "app.ts" },
    { value: "src/views/home.tsx" },
    { value: "src/application/index.ts" },
  ];

  it("returns the host order when nothing has been typed", () => {
    expect(rankMentions(options, "").map((option) => option.value)).toEqual([
      "docs/apple.md",
      "app.ts",
      "src/views/home.tsx",
      "src/application/index.ts",
    ]);
  });

  it("puts a prefix match first, then shorter candidates", () => {
    // `app.ts` must not be buried under everything that merely contains "app".
    expect(rankMentions(options, "app").map((option) => option.value)).toEqual([
      "app.ts",
      "docs/apple.md",
      "src/application/index.ts",
    ]);
  });

  it("matches the last segment so directories need not be typed", () => {
    expect(rankMentions(options, "home").map((option) => option.value)).toEqual([
      "src/views/home.tsx",
    ]);
  });

  it("is case insensitive", () => {
    expect(rankMentions(options, "HOME")).toHaveLength(1);
  });

  it("caps the number of rows", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      value: `file-${index}.ts`,
    }));
    expect(rankMentions(many, "file", 5)).toHaveLength(5);
  });
});
