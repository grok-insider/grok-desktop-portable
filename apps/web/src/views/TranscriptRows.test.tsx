import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TranscriptRows, type TimelineItem } from "./TranscriptRows";

const history: TimelineItem[] = [
  {kind: "message", entry: {id: "user", role: "user", text: "Find exact content", seq: 1}},
  {kind: "thought", thought: {id: "thought", text: "Consider the problem", seq: 2}},
  {kind: "tool", tool: {id: "tool", name: "test tool", action: "read", readOnly: true, detail: "fixture.txt", finished: true, failed: false, truncated: false, seq: 3}},
  {kind: "message", entry: {id: "agent", role: "agent", text: "**Result** and `code`", seq: 4}},
];

describe("memoized transcript experiment", () => {
  it("preserves full DOM content, order, safe markdown and streaming state", () => {
    const {container, rerender} = render(<TranscriptRows timeline={history} agentId="agent" />);
    expect(container.children).toHaveLength(4);
    expect(container.children[0]).toHaveAttribute("data-turn-id", "user");
    expect(container.children[3]).toHaveAttribute("data-turn-id", "agent");
    expect(screen.getByText("Find exact content")).toBeInTheDocument();
    expect(screen.getByText("Result").tagName).toBe("STRONG");
    expect(screen.getByTestId("streaming-caret")).toBeInTheDocument();
    const held = container.children[0];
    const updated = history.map((item) => item.kind === "message" && item.entry.id === "agent" ? {...item, entry: {...item.entry, text: "Updated response"}} : item);
    rerender(<TranscriptRows timeline={updated} />);
    expect(screen.getByText("Updated response")).toBeInTheDocument();
    expect(container.children[0]).toBe(held);
    expect(screen.queryByTestId("streaming-caret")).not.toBeInTheDocument();
  });
  it("retains expanded tool state across unrelated stream updates", async () => {
    const {rerender} = render(<TranscriptRows timeline={history} />);
    const tool = screen.getByRole("button", {name: /fixture.txt/});
    await userEvent.click(tool);
    expect(tool).toHaveAttribute("aria-expanded", "true");
    rerender(<TranscriptRows timeline={[...history, {kind: "message", entry: {id: "new", role: "agent", text: "Later", seq: 5}}]} agentId="new" />);
    expect(tool).toHaveAttribute("aria-expanded", "true");
  });
});
