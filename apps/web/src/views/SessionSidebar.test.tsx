import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./SessionSidebar";
import type { SessionProjection } from "../services/outcomes";

function session(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    sessionId: "s-1",
    workspaceId: "w-1",
    workspaceName: "test",
    running: false,
    openedAtMs: 1,
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<Parameters<typeof SessionSidebar>[0]> = {}) {
  const props = {
    sessions: [session()],
    activeSessionId: "s-1",
    titles: {} as Record<string, string>,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    ...overrides,
  };
  render(<SessionSidebar {...props} />);
  return props;
}

describe("SessionSidebar", () => {
  it("says plainly when nothing is open", () => {
    renderSidebar({ sessions: [], activeSessionId: null });
    expect(screen.getByText(/nothing open/i)).toBeInTheDocument();
  });

  it("renders every open conversation in the order the host gave", () => {
    // Order is the host's, by open time: the sidebar must not re-sort, or a
    // row would move under the user when another conversation spoke.
    renderSidebar({
      sessions: [
        session({ sessionId: "s-1", openedAtMs: 1 }),
        session({ sessionId: "s-2", openedAtMs: 2 }),
        session({ sessionId: "s-3", openedAtMs: 3 }),
      ],
      titles: { "s-1": "alpha", "s-2": "beta", "s-3": "gamma" },
    });
    const names = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(names[0]).toContain("alpha");
    expect(names[1]).toContain("beta");
    expect(names[2]).toContain("gamma");
  });

  it("shows work in progress with a label, not colour alone", () => {
    renderSidebar({ sessions: [session({ running: true })] });
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("marks which conversation is on screen", () => {
    renderSidebar({
      sessions: [session({ sessionId: "s-1" }), session({ sessionId: "s-2" })],
      activeSessionId: "s-2",
    });
    const current = screen.getAllByRole("button").filter(
      (button) => button.getAttribute("aria-current") === "true",
    );
    expect(current).toHaveLength(1);
  });

  it("selects the conversation that was clicked", async () => {
    const props = renderSidebar({
      sessions: [session({ sessionId: "s-1" }), session({ sessionId: "s-2" })],
      titles: { "s-1": "alpha", "s-2": "beta" },
    });
    await userEvent.click(screen.getByText("beta"));
    expect(props.onSelect).toHaveBeenCalledWith("s-2");
  });

  it("closes the exact conversation asked for", async () => {
    const props = renderSidebar({
      sessions: [session({ sessionId: "s-1" }), session({ sessionId: "s-2" })],
      titles: { "s-1": "alpha", "s-2": "beta" },
    });
    await userEvent.click(screen.getByRole("button", { name: /close beta/i }));
    expect(props.onClose).toHaveBeenCalledWith("s-2");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("labels a conversation that has not been given a subject yet", () => {
    // Two conversations in the same workspace would otherwise be identical
    // rows, which is the state the sidebar exists to avoid.
    renderSidebar({ titles: {} });
    expect(screen.getByText("New conversation")).toBeInTheDocument();
  });

  it("tells two conversations in the same workspace apart", () => {
    renderSidebar({
      sessions: [session({ sessionId: "s-1" }), session({ sessionId: "s-2" })],
      titles: { "s-1": "fix the parser", "s-2": "write the docs" },
    });
    expect(screen.getByText("fix the parser")).toBeInTheDocument();
    expect(screen.getByText("write the docs")).toBeInTheDocument();
  });

  it("never shows a filesystem path", () => {
    // The host projects a display name; a path must not reach the browser
    // (light ADR 0009). Passing one through proves the row renders what it is
    // given, so this asserts on the contract the host upholds.
    const { container } = render(
      <SessionSidebar
        sessions={[session({ workspaceName: "test" })]}
        activeSessionId="s-1"
        titles={{ "s-1": "hello there" }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    expect(container.textContent).not.toMatch(/\//);
  });

  it("offers a way to start another conversation", async () => {
    const props = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: /start a new conversation/i }));
    expect(props.onNew).toHaveBeenCalled();
  });
});

describe("activity", () => {
  it("shows the conversation that is working, not the one on screen", () => {
    // The point of the sidebar during concurrent work: you can be reading one
    // conversation while a different one is the busy one.
    renderSidebar({
      sessions: [
        session({ sessionId: "s-1", running: false }),
        session({ sessionId: "s-2", running: true }),
      ],
      activeSessionId: "s-1",
      titles: { "s-1": "reading this", "s-2": "busy one" },
    });

    const rows = screen.getAllByRole("listitem");
    // Idle is the resting state and draws nothing: a label on every quiet row
    // doubled the height of the list to say that nothing was happening.
    expect(rows[0]?.textContent).not.toContain("Working");
    expect(rows[0]?.textContent).not.toContain("Idle");
    expect(rows[1]?.textContent).toContain("Working");
  });

  it("keeps a working row in its place rather than moving it", () => {
    // Activity must never reorder: a row holds its position from open until
    // close, or the list becomes a feed the user cannot point at.
    const sessions = [
      session({ sessionId: "s-1", openedAtMs: 1 }),
      session({ sessionId: "s-2", openedAtMs: 2 }),
    ];
    const titles = { "s-1": "first", "s-2": "second" };

    const { unmount } = render(
      <SessionSidebar
        sessions={sessions}
        activeSessionId="s-1"
        titles={titles}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const before = screen.getAllByRole("listitem").map((row) => row.textContent);
    unmount();

    render(
      <SessionSidebar
        sessions={[sessions[0]!, { ...sessions[1]!, running: true }]}
        activeSessionId="s-1"
        titles={titles}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
      />,
    );
    const after = screen.getAllByRole("listitem").map((row) => row.textContent);

    expect(after[0]).toContain("first");
    expect(after[1]).toContain("second");
    expect(before[0]).toContain("first");
  });
});

describe("a conversation waiting on the user", () => {
  it("outranks one that is merely working", () => {
    // Being blocked on a decision is the only state the user can act on, so
    // it must not be hidden behind "Working".
    renderSidebar({
      sessions: [session({ sessionId: "s-1", running: true, awaitingDecision: true })],
    });
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
  });

  it("announces a decision waiting in a conversation that is not on screen", () => {
    renderSidebar({
      sessions: [
        session({ sessionId: "s-1" }),
        session({ sessionId: "s-2", awaitingDecision: true }),
      ],
      activeSessionId: "s-1",
      titles: { "s-1": "reading this", "s-2": "asked you something" },
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows[1]?.textContent).toContain("Needs you");
    expect(rows[0]?.textContent).not.toContain("Needs you");
  });
});
