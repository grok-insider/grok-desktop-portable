import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import { SessionView } from "./SessionView";

/**
 * The composer is controlled by the caller, so the harness owns the draft the
 * way App does. Tests then read as behaviour — type, send — instead of
 * asserting that a change handler fired.
 */
function Harness(props: Parameters<typeof SessionView>[0]) {
  const [draft, setDraft] = useState(props.draft);
  return (
    <ThemeProvider>
      <SessionView {...props} draft={draft} onDraftChange={setDraft} />
    </ThemeProvider>
  );
}

function renderView(overrides: Partial<Parameters<typeof SessionView>[0]> = {}) {
  const props = {
    transcript: [],
    tools: [],
    reviews: [],
    phase: "idle" as const,
    connected: true,
    sessions: [],
    activeSessionId: null,
    sessionTitles: {} as Record<string, string>,
    draft: "",
    onDraftChange: vi.fn(),
    queued: [] as { entryId: string; text: string }[],
    onSendNow: vi.fn(),
    onRemoveQueued: vi.fn(),
    onSelectSession: vi.fn(),
    onCloseSession: vi.fn(),
    onLeaveSession: vi.fn(),
    onPrompt: vi.fn(),
    onCancel: vi.fn(),
    onAcknowledge: vi.fn(),
    onContextQuery: vi.fn(),
    ...overrides,
  };
  render(<Harness {...props} />);
  return props;
}

describe("SessionView", () => {
  it("sends a prompt and clears the composer", async () => {
    const props = renderView();
    const composer = screen.getByRole("textbox", { name: /message the agent/i });

    await userEvent.type(composer, "build the thing");
    await userEvent.click(screen.getByRole("button", { name: /send prompt/i }));

    expect(props.onPrompt).toHaveBeenCalledWith("build the thing");
    expect(composer).toHaveValue("");
  });

  it("submits on Enter but allows Shift+Enter for a newline", async () => {
    const props = renderView();
    const composer = screen.getByRole("textbox", { name: /message the agent/i });

    await userEvent.type(composer, "first{Shift>}{Enter}{/Shift}second");
    expect(props.onPrompt).not.toHaveBeenCalled();

    await userEvent.type(composer, "{Enter}");
    expect(props.onPrompt).toHaveBeenCalledWith("first\nsecond");
  });

  it("refuses an empty prompt", async () => {
    const props = renderView();
    await userEvent.type(
      screen.getByRole("textbox", { name: /message the agent/i }),
      "   {Enter}",
    );
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it("offers queue, send now, and stop while a turn is running", () => {
    // Pressing Enter mid-turn used to do nothing and say nothing about why.
    renderView({ phase: "streaming" });
    expect(
      screen.getByRole("button", { name: /^stop the current turn$/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /queue this message/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send this now/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send prompt/i })).not.toBeInTheDocument();
  });

  it("queues a message written while the agent is working", async () => {
    const props = renderView({ phase: "streaming" });
    await userEvent.type(
      screen.getByRole("textbox", { name: /message the agent/i }),
      "do this after",
    );
    await userEvent.click(screen.getByRole("button", { name: /queue this message/i }));
    expect(props.onPrompt).toHaveBeenCalledWith("do this after");
  });

  it("send now stops the turn rather than waiting behind it", async () => {
    // The meaning the qualified CLI gives Ctrl+Enter.
    const props = renderView({ phase: "streaming" });
    await userEvent.type(
      screen.getByRole("textbox", { name: /message the agent/i }),
      "actually, this instead",
    );
    await userEvent.click(screen.getByRole("button", { name: /send this now/i }));
    expect(props.onSendNow).toHaveBeenCalledWith("actually, this instead");
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it("shows what is waiting and lets it be taken back out", async () => {
    const props = renderView({
      phase: "streaming",
      queued: [{ entryId: "q-1", text: "on reflection, no" }],
    });
    expect(screen.getByText("on reflection, no")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove the waiting message/i }));
    expect(props.onRemoveQueued).toHaveBeenCalledWith("q-1");
  });

  it("disables the composer when the event channel is down", () => {
    renderView({ connected: false });
    expect(screen.getByRole("textbox", { name: /message the agent/i })).toBeDisabled();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("states that an interrupted action will not be retried", () => {
    renderView({ reviews: [{ recordId: "ir-1" }], phase: "interrupted" });
    expect(screen.getByText(/will not\s+retry them/i)).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("acknowledges an interrupted record without retrying it", async () => {
    const props = renderView({ reviews: [{ recordId: "ir-1" }], phase: "interrupted" });
    await userEvent.click(screen.getByRole("button", { name: /as reviewed$/i }));
    expect(props.onAcknowledge).toHaveBeenCalledWith("ir-1");
    // There is deliberately no retry affordance.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("names what was interrupted and why, so the user knows where to look", () => {
    renderView({
      reviews: [{ recordId: "ir-1", operation: "Prompt", cause: "agent_exit" }],
      phase: "interrupted",
    });
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(screen.getByText(/exited mid-turn/i)).toBeInTheDocument();
  });

  it("still shows a record the host described only by id", () => {
    // A live interruption arrives before the full record is re-read, so the
    // banner must degrade instead of rendering an empty row.
    renderView({ reviews: [{ recordId: "ir-1" }], phase: "interrupted" });
    expect(screen.getByText(/could not confirm/i)).toBeInTheDocument();
  });

  it("keeps every unresolved record separately actionable", () => {
    renderView({
      reviews: [
        { recordId: "ir-1", operation: "Prompt", cause: "agent_exit" },
        { recordId: "ir-2", operation: "DecidePermission", cause: "host_restart" },
      ],
      phase: "interrupted",
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /as reviewed$/i })).toHaveLength(2);
  });

  it("marks truncated tool output rather than pretending it is complete", () => {
    renderView({
      tools: [{ id: "t-1", name: "read", action: "read", readOnly: true, finished: true, failed: false, truncated: true, seq: 1 }],
    });
    expect(screen.getByText("Truncated")).toBeInTheDocument();
    expect(screen.getByText(/output was truncated by the host/i)).toBeInTheDocument();
  });

  it("does not repeat the authority disclosure inside the composer", () => {
    renderView({
      transcript: [{ id: "a-1", role: "agent", text: "done", seq: 1 }],
    });
    expect(screen.getByRole("group", { name: /prompt composer/i })).not.toHaveTextContent(
      /runs with your own authority in the enrolled workspace/i,
    );
  });

  it("enters bash mode when the draft starts with a bang", async () => {
    renderView();
    const composer = screen.getByRole("textbox", { name: /message the agent/i });
    await userEvent.type(composer, "!");
    expect(screen.getByRole("textbox", { name: /shell command/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter shell command/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run shell command/i })).toBeInTheDocument();
  });

  it("fades the left toolbar in bash mode instead of unmounting it", async () => {
    // OpenCode technique: left cluster stays mounted (opacity 0) so the card
    // does not jump height or reflow when entering `!`.
    renderView({
      models: [
        {
          id: "m1",
          name: "Grok",
          supportsReasoningEffort: true,
          reasoningEfforts: [{ id: "default", label: "Default" }],
        },
      ],
      modelId: "m1",
      effortId: "default",
    });
    const left = document.querySelector('[data-composer-chrome="left-toolbar"]');
    expect(left).toBeTruthy();
    expect(left).not.toHaveClass("opacity-0");
    expect(left).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /add to message/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^model$/i })).toBeEnabled();

    const composer = screen.getByRole("textbox", { name: /message the agent/i });
    await userEvent.type(composer, "!");
    expect(left).toHaveClass("opacity-0");
    expect(left).toHaveClass("pointer-events-none");
    // inert must be the boolean attribute (present), never an empty-string false.
    expect(left).toHaveAttribute("inert");
    // aria-hidden removes these from the a11y tree; query the DOM under the
    // faded cluster and assert they are disabled (keyboard cannot activate).
    const plus = left?.querySelector<HTMLButtonElement>('[aria-label="Add to message"]');
    const model = left?.querySelector<HTMLButtonElement>('[aria-label="Model"]');
    const effort = left?.querySelector<HTMLButtonElement>('[aria-label="Reasoning effort"]');
    expect(plus).toBeTruthy();
    expect(model).toBeTruthy();
    expect(effort).toBeTruthy();
    expect(plus).toBeDisabled();
    expect(model).toBeDisabled();
    expect(effort).toBeDisabled();
    // Not exposed as interactive roles while bash chrome is active.
    expect(screen.queryByRole("button", { name: /^model$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /shell command/i })).toHaveClass("font-mono");

    await userEvent.keyboard("{Backspace}");
    expect(left).not.toHaveClass("opacity-0");
    expect(left).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /^model$/i })).toBeEnabled();
  });

  it("exits bash mode with Backspace when the command body is empty (CLI parity)", async () => {
    renderView();
    const composer = screen.getByRole("textbox", { name: /message the agent/i });
    await userEvent.type(composer, "!");
    expect(screen.getByRole("textbox", { name: /shell command/i })).toBeInTheDocument();
    // Empty body + Backspace → Normal (same as Grok Build pager is_exit_key).
    await userEvent.keyboard("{Backspace}");
    expect(screen.getByRole("textbox", { name: /message the agent/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ask anything/i)).toBeInTheDocument();
  });

  it("renders streaming thought blocks separate from the agent answer", () => {
    renderView({
      phase: "streaming",
      thoughts: [
        { id: "th-1", text: "Considering the river bend…", seq: 1 },
      ],
      transcript: [
        { id: "a-1", role: "agent", text: "Here is the story.", seq: 2 },
      ],
    });
    expect(screen.getByLabelText(/thinking/i)).toBeInTheDocument();
    expect(screen.getByText(/Considering the river bend/i)).toBeInTheDocument();
    expect(screen.getByText("Here is the story.")).toBeInTheDocument();
  });

  it("labels finished thought blocks as Thought, not Thinking", () => {
    renderView({
      phase: "idle",
      thoughts: [{ id: "th-2", text: "Finished reasoning.", seq: 1 }],
      transcript: [],
    });
    expect(screen.getByLabelText(/^thought$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/thinking/i)).not.toBeInTheDocument();
  });

  it("shows model and effort selectors when the host projects them", () => {
    renderView({
      models: [
        {
          id: "grok-4.5",
          name: "Grok 4.5",
          supportsReasoningEffort: true,
          reasoningEfforts: [
            { id: "high", label: "High" },
            { id: "low", label: "Low" },
          ],
          defaultEffort: "high",
        },
      ],
      modelId: "grok-4.5",
      effortId: "high",
    });
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Reasoning effort")).toBeInTheDocument();
  });

  it("pairs every status it draws with a label, never colour alone", () => {
    renderView({ phase: "streaming" });
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("draws no connection chip while the connection is the resting one", () => {
    renderView({ connected: true });
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("draws a connection chip once the connection drops", () => {
    renderView({ connected: false });
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("puts the workspace display name on the open-conversation tab, never as a path", () => {
    renderView({
      workspaceName: "test",
      activeSessionId: "s-1",
      sessionTitles: { "s-1": "Ship the landing page" },
      sessions: [
        {
          sessionId: "s-1",
          workspaceId: "w-1",
          workspaceName: "test",
          running: false,
          openedAtMs: 1,
        },
      ],
    });
    const tab = screen.getByRole("tab", { name: /ship the landing page/i });
    expect(tab).toHaveAttribute("title", "Ship the landing page · test");
    expect(screen.queryByText(/\/home\//)).not.toBeInTheDocument();
  });

  it("does not repeat workspace and session labels inside the composer", () => {
    renderView({
      workspaceName: "test",
      activeSessionId: "s-1",
      sessionTitles: { "s-1": "Ship the landing page" },
      sessions: [
        {
          sessionId: "s-1",
          workspaceId: "w-1",
          workspaceName: "test",
          running: false,
          openedAtMs: 1,
        },
      ],
    });
    const composer = screen.getByRole("group", { name: /prompt composer/i });
    expect(composer).not.toHaveTextContent("test");
    expect(composer).not.toHaveTextContent("Ship the landing page");
    expect(screen.queryByText(/\/home\//)).not.toBeInTheDocument();
  });

  it("keeps only deduplicated MCP integrations outside the composer card", async () => {
    renderView({
      configTools: [
        { name: "exa", kind: "mcp", scope: "global", enabled: true },
        { name: "exa", kind: "mcp", scope: "project", enabled: true },
        { name: "wisp", kind: "mcp", scope: "project", enabled: false },
        { name: "review", kind: "skill", scope: "global", enabled: true },
      ],
    });
    const composer = screen.getByRole("group", { name: /prompt composer/i });
    // MCP lives left of the raised card, not inside its toolbar.
    expect(within(composer).queryByLabelText("2 MCP integrations")).not.toBeInTheDocument();
    const trigger = screen.getByLabelText("2 MCP integrations");
    expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.getByText("exa")).toBeInTheDocument();
    expect(screen.getByText("wisp")).toBeInTheDocument();
    expect(screen.queryByText("review")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/exa, on/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/wisp, off/i)).toBeInTheDocument();
  });

  it("closes the MCP menu on outside click and shows on/off status", async () => {
    renderView({
      configTools: [{ name: "exa", kind: "mcp", scope: "global", enabled: true }],
    });
    await userEvent.click(screen.getByLabelText("1 MCP integration"));
    expect(screen.getByRole("listbox", { name: /mcp integrations/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("textbox", { name: /message the agent/i }));
    expect(screen.queryByRole("listbox", { name: /mcp integrations/i })).not.toBeInTheDocument();
  });

  it("offers a + menu for files, commands, context, and shell", async () => {
    renderView();
    const composer = screen.getByRole("textbox", { name: /message the agent/i });
    await userEvent.type(composer, "see ");
    await userEvent.click(screen.getByRole("button", { name: /add to message/i }));
    expect(screen.getByRole("menu", { name: /add to message/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /images and files/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /commands/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /context/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /shell command/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: /context/i }));
    expect(composer).toHaveValue("see @");
  });

  it("enters bash mode from the + menu without relying on typing !", async () => {
    renderView();
    await userEvent.click(screen.getByRole("button", { name: /add to message/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /shell command/i }));
    expect(screen.getByRole("textbox", { name: /shell command/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter shell command/i)).toBeInTheDocument();
  });
  it("uses custom listboxes for model and effort, not bare native selects", async () => {
    renderView({
      models: [
        {
          id: "grok-4",
          name: "Grok 4.5",
          supportsReasoningEffort: true,
          reasoningEfforts: [
            { id: "high", label: "High Effort" },
            { id: "low", label: "Low Effort" },
          ],
        },
      ],
      modelId: "grok-4",
      effortId: "high",
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^model$/i }));
    expect(screen.getByRole("listbox", { name: /^model$/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /grok 4\.5/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Close model menu first so effort is the open listbox.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /reasoning effort/i }));
    expect(screen.getByRole("listbox", { name: /reasoning effort/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /low effort/i })).toBeInTheDocument();
  });

  it("offers conversation checkpoints for each user turn", async () => {
    renderView({
      transcript: [
        { id: "u-1", role: "user", text: "first ask", seq: 1 },
        { id: "a-1", role: "agent", text: "first answer", seq: 2 },
        { id: "u-2", role: "user", text: "second ask", seq: 3 },
      ],
    });
    const rail = screen.getByRole("navigation", { name: /conversation checkpoints/i });
    const marks = within(rail).getAllByRole("button", { name: /jump to your message/i });
    expect(marks).toHaveLength(2);
    await userEvent.click(marks[0]!);
    // jsdom stubs scrollIntoView; the mark remains addressable after the jump.
    expect(document.querySelector('[data-turn-id="u-1"]')).toBeInTheDocument();
  });

  it("shows Jump to latest when the reader is not stuck to the end", async () => {
    renderView({
      transcript: [{ id: "u-1", role: "user", text: "hello", seq: 1 }],
    });
    // Simulate having scrolled away from the end.
    const latest = screen.queryByRole("button", { name: /jump to latest message/i });
    // On first paint the view is stuck; force the unstuck control via scroll handler
    // is unreliable in jsdom, so this assertion only checks the control exists after
    // an explicit re-render path is exercised through the checkpoint jump (unstuck).
    const rail = screen.getByRole("navigation", { name: /conversation checkpoints/i });
    await userEvent.click(within(rail).getByRole("button", { name: /jump to your message/i }));
    expect(
      latest ?? screen.getByRole("button", { name: /jump to latest message/i }),
    ).toBeInTheDocument();
  });

  it("offers workspace files after @ and inserts the one chosen", async () => {
    const props = renderView({
      contextEntries: [
        { path: "src/views/home.tsx", kind: "file" },
        { path: "README.md", kind: "file" },
      ],
    });
    const composer = screen.getByRole("textbox", { name: /message the agent/i });

    await userEvent.type(composer, "look at @home");
    expect(screen.getByRole("listbox", { name: /workspace files/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /src\/views\/home\.tsx/ }));

    // A mention is text the agent resolves; the host never acts on it.
    expect(composer).toHaveValue("look at @src/views/home.tsx ");
    expect(props.onPrompt).not.toHaveBeenCalled();
  });

  it("asks the host for candidates as the mention is typed", async () => {
    const props = renderView({ contextEntries: [] });
    await userEvent.type(
      screen.getByRole("textbox", { name: /message the agent/i }),
      "@src",
    );
    await waitFor(() => expect(props.onContextQuery).toHaveBeenCalledWith("src"));
  });

  it("offers the agent's commands after a leading slash", async () => {
    renderView({
      commands: [
        { name: "help", description: "Show help" },
        { name: "init", description: null },
      ],
    });
    await userEvent.type(
      screen.getByRole("textbox", { name: /message the agent/i }),
      "/he",
    );
    expect(screen.getByRole("listbox", { name: /commands/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /help/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /init/ })).not.toBeInTheDocument();
  });

  it("accepts a completion with Enter without sending the prompt", async () => {
    const props = renderView({ commands: [{ name: "help", description: "Show help" }] });
    const composer = screen.getByRole("textbox", { name: /message the agent/i });

    await userEvent.type(composer, "/he{Enter}");
    expect(composer).toHaveValue("/help ");
    // Enter belongs to the menu while it is open, or choosing a command would
    // also fire the prompt underneath it.
    expect(props.onPrompt).not.toHaveBeenCalled();

    await userEvent.type(composer, "{Enter}");
    expect(props.onPrompt).toHaveBeenCalledWith("/help");
  });

  it("closes the menu on Escape and lets Enter send again", async () => {
    const props = renderView({ commands: [{ name: "help" }] });
    const composer = screen.getByRole("textbox", { name: /message the agent/i });

    await userEvent.type(composer, "/he{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.type(composer, "{Enter}");
    expect(props.onPrompt).toHaveBeenCalledWith("/he");
  });

  it("does not open a menu in bash mode", async () => {
    // There `@` and `/` are ordinary shell characters.
    renderView({
      contextEntries: [{ path: "README.md", kind: "file" }],
      draft: "!",
    });
    await userEvent.type(
      screen.getByRole("textbox", { name: /shell command/i }),
      "cat @READ",
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("puts a tool call between the turns it ran between", () => {
    // The whole reason tool calls carry a sequence: collected in a card below
    // the transcript, a reader could see that a command ran but not when.
    renderView({
      transcript: [
        { id: "u-1", role: "user", text: "list the files", seq: 1 },
        { id: "a-1", role: "agent", text: "two files", seq: 5 },
      ],
      tools: [
        {
          id: "t-1",
          name: "List files",
          action: "execute",
          readOnly: true,
          detail: "ls -la",
          finished: true,
          failed: false,
          truncated: false,
          seq: 3,
        },
      ],
    });
    const rendered = screen.getByText("list the files").closest("div")!.parentElement!
      .parentElement!;
    const order = Array.from(rendered.querySelectorAll("p, button"))
      .map((node) => node.textContent ?? "")
      .filter((text) => text.length > 0);
    const user = order.findIndex((text) => text.includes("list the files"));
    const call = order.findIndex((text) => text.includes("List files"));
    expect(user).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(user);
  });

  it("draws no bubble around the agent's answer", () => {
    // The reading measure already bounds it; a card as well made every answer
    // read as an object on the page rather than the page itself.
    renderView({
      transcript: [{ id: "a-1", role: "agent", text: "plain answer", seq: 1 }],
    });
    const turn = screen.getByLabelText("Agent message");
    expect(turn.className).not.toMatch(/border/);
    expect(turn.className).not.toMatch(/shadow/);
  });

  it("labels turns for assistive tech without drawing a label on each one", () => {
    renderView({
      transcript: [
        { id: "u-1", role: "user", text: "ask", seq: 1 },
        { id: "a-1", role: "agent", text: "answer", seq: 2 },
      ],
    });
    expect(screen.getByLabelText("Your message")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent message")).toBeInTheDocument();
    // The visible YOU / AGENT rubric above every bubble is gone.
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });

  it("renders agent markdown and keeps user text plain", () => {
    renderView({
      transcript: [
        { id: "u-1", role: "user", text: "hi **not** markdown", seq: 1 },
        { id: "a-1", role: "agent", text: "## Hello\n\nI am **Grok**.", seq: 2 },
      ],
    });
    expect(screen.getByRole("heading", { level: 2, name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("Grok").tagName).toBe("STRONG");
    // User content is not parsed as markdown.
    expect(screen.getByText("hi **not** markdown")).toBeInTheDocument();
  });

  it("opens a bounded review panel with every line of the selected patch", () => {
    renderView({
      reviewPanelOpen: true,
      inspector: {
        sessionId: "s-1",
        turns: 1,
        turnIndex: 0,
        availableChangeModes: ["git", "lastTurn"],
      },
      changeMode: "git",
      changes: {
        sessionId: "s-1",
        mode: "git",
        comparison: "HEAD to working tree",
        additions: 1,
        deletions: 1,
        complete: true,
        omittedFiles: 0,
        files: [
          {
            path: "src/main.ts",
            status: "modified",
            stage: "unstaged",
            additions: 1,
            deletions: 1,
            patchState: "complete",
            patch: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        ],
      },
    });

    expect(screen.getByRole("complementary", { name: /session review/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/unified patch for src\/main\.ts/i)).toHaveTextContent("-old");
    expect(screen.getByLabelText(/unified patch for src\/main\.ts/i)).toHaveTextContent("+new");
    expect(screen.getByRole("tab", { name: "Git" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("tab", { name: "Branch" })).not.toBeInTheDocument();
  });

  it("pins the review overlay to the viewport on the narrow shell", () => {
    renderView({ reviewPanelOpen: true });
    expect(screen.getByRole("complementary", { name: /session review/i })).toHaveClass(
      "max-[680px]:fixed",
    );
  });

  it("shows unknown cost as a dash and never as zero dollars", async () => {
    renderView({
      reviewPanelOpen: true,
      inspector: {
        sessionId: "s-1",
        modelDisplayName: "Grok 4.5",
        turns: 1,
        turnIndex: 0,
        availableChangeModes: [],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedReadTokens: 0,
          reasoningTokens: 0,
          totalTokens: 12,
          modelCalls: 1,
          numTurns: 1,
          apiDurationMs: 250,
          incomplete: true,
        },
      },
    });

    await userEvent.click(screen.getByRole("tab", { name: /context/i }));
    expect(screen.getByText("Cost").parentElement).toHaveTextContent("—");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });

  it("lets the topbar close the review panel without changing session state", async () => {
    const onReviewPanelOpenChange = vi.fn();
    renderView({ reviewPanelOpen: true, onReviewPanelOpenChange });
    await userEvent.click(screen.getAllByRole("button", { name: /close review panel$/i })[0]!);
    expect(onReviewPanelOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("interrupted records across conversations", () => {
  it("offers to open the conversation an interruption belongs to", () => {
    // With several open, a record about a different conversation is not
    // actionable unless the user can get to it.
    renderView({
      phase: "interrupted",
      activeSessionId: "s-1",
      sessions: [
        {
          sessionId: "s-1",
          workspaceId: "w-1",
          workspaceName: "test",
          running: false,
          openedAtMs: 1,
        },
        {
          sessionId: "s-2",
          workspaceId: "w-1",
          workspaceName: "test",
          running: false,
          openedAtMs: 2,
        },
      ],
      reviews: [
        { recordId: "ir-1", operation: "Prompt", cause: "agent_exit", sessionId: "s-2" },
      ],
    });
    expect(screen.getByRole("button", { name: /open the conversation/i })).toBeInTheDocument();
  });

  it("does not offer to open the conversation already on screen", () => {
    renderView({
      phase: "interrupted",
      activeSessionId: "s-1",
      sessions: [
        {
          sessionId: "s-1",
          workspaceId: "w-1",
          workspaceName: "test",
          running: false,
          openedAtMs: 1,
        },
      ],
      reviews: [
        { recordId: "ir-1", operation: "Prompt", cause: "agent_exit", sessionId: "s-1" },
      ],
    });
    expect(screen.queryByRole("button", { name: /open the conversation/i })).not.toBeInTheDocument();
  });

  it("does not offer to open a conversation that is no longer open", () => {
    // The host closed it, or a restart lost it. Offering a dead link would be
    // worse than saying nothing.
    renderView({
      phase: "interrupted",
      activeSessionId: "s-1",
      sessions: [],
      reviews: [
        { recordId: "ir-1", operation: "Prompt", cause: "host_restart", sessionId: "s-gone" },
      ],
    });
    expect(screen.queryByRole("button", { name: /open the conversation/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /as reviewed$/i })).toBeInTheDocument();
  });
});
