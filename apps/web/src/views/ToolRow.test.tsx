import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { defaultToolExpanded, ToolRow } from "./ToolRow";
import type { ToolEntry } from "./SessionView";

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: "t-1",
    name: "Execute `echo hello`",
    action: "execute",
    readOnly: false,
    provider: null,
    detail: "echo hello",
    finished: false,
    failed: false,
    truncated: false,
    seq: 1,
    ...overrides,
  };
}

describe("defaultToolExpanded", () => {
  it("keeps running, failed, truncated, and may-change rows open", () => {
    expect(defaultToolExpanded(tool({ finished: false }))).toBe(true);
    expect(defaultToolExpanded(tool({ finished: true, failed: true }))).toBe(
      true,
    );
    expect(
      defaultToolExpanded(
        tool({ finished: true, truncated: true, readOnly: true }),
      ),
    ).toBe(true);
    expect(defaultToolExpanded(tool({ finished: true, readOnly: false }))).toBe(
      true,
    );
  });

  it("folds quiet successful reads", () => {
    expect(
      defaultToolExpanded(
        tool({
          action: "read",
          readOnly: true,
          finished: true,
          failed: false,
          truncated: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("ToolRow", () => {
  it("sits inline rather than inside a card of its own", () => {
    // Tool calls used to be collected under a "Tool calls" heading below every
    // message, so a reader could see that a command ran but not which turn ran
    // it. The row is now a peer of the messages around it.
    render(<ToolRow tool={tool()} />);
    expect(screen.queryByText(/^tool calls$/i)).not.toBeInTheDocument();
  });

  it("says what the call acted on, not only what it was called", () => {
    // The whole point: `run_terminal_command · Done` named the mechanism and
    // hid the act.
    render(<ToolRow tool={tool()} />);
    expect(screen.getByText("Execute `echo hello`")).toBeInTheDocument();
    expect(screen.getByText("echo hello")).toBeInTheDocument();
    expect(screen.getByText("Run")).toBeInTheDocument();
  });

  it("warns when a call can change something", () => {
    render(<ToolRow tool={tool({ readOnly: false })} />);
    expect(screen.getByText(/may change things/i)).toBeInTheDocument();
  });

  it("stays quiet about a call that cannot", () => {
    render(<ToolRow tool={tool({ readOnly: true, action: "read" })} />);
    expect(screen.queryByText(/may change things/i)).not.toBeInTheDocument();
  });

  it("names the integration a tool came from", () => {
    // The user's own MCP servers are worth telling apart from the agent's
    // built-in toolset.
    render(<ToolRow tool={tool({ provider: "chrome-devtools" })} />);
    expect(screen.getByText("chrome-devtools")).toBeInTheDocument();
  });

  it("does not label a built-in as coming from somewhere", () => {
    render(<ToolRow tool={tool({ provider: null })} />);
    expect(screen.queryByTitle(/MCP server/i)).not.toBeInTheDocument();
  });

  it("does not report a failed call as done", () => {
    // Collapsing completed and failed into one green chip made a tool that
    // broke read as having worked.
    render(<ToolRow tool={tool({ finished: true, failed: true })} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("stays silent about a call that simply worked", () => {
    // A chip on every successful read is a column of green that trains the eye
    // to skip past the one that failed.
    render(
      <ToolRow tool={tool({ id: "t-1", finished: true, readOnly: true })} />,
    );
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("chips a truncated call", () => {
    render(
      <ToolRow tool={tool({ id: "t-2", finished: true, truncated: true })} />,
    );
    expect(screen.getByText("Truncated")).toBeInTheDocument();
  });

  it("chips a call that is still running", () => {
    render(<ToolRow tool={tool({ id: "t-3", finished: false })} />);
    expect(screen.getByText("Run…")).toBeInTheDocument();
  });

  it("renders an action it does not know without inventing one", () => {
    render(
      <ToolRow tool={tool({ action: "something_new", finished: false })} />,
    );
    expect(screen.getByText("Tool…")).toBeInTheDocument();
  });

  it("lets the user expand a quiet finished read", async () => {
    render(
      <ToolRow
        tool={tool({
          id: "t-read",
          name: "Read package.json",
          action: "read",
          readOnly: true,
          detail: "package.json",
          finished: true,
        })}
      />,
    );
    // Collapsed: detail is in the summary line, not the detail panel.
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.queryByText("No detail")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /expand read package\.json/i }),
    );
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse read package\.json/i }),
    ).toBeInTheDocument();
  });

  it("never interprets agent text as markup", () => {
    // The name and the detail are agent-supplied. They are shown, not parsed.
    const { container } = render(
      <ToolRow
        tool={tool({
          name: "<img src=x onerror=alert(1)>",
          detail: "<script>window.__xss=1</script>",
        })}
      />,
    );
    // What matters is that nothing became a node. The characters may appear
    // in the serialised HTML as escaped text, which is exactly correct.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(
      screen.getByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("<script>window.__xss=1</script>"),
    ).toBeInTheDocument();
  });
});
