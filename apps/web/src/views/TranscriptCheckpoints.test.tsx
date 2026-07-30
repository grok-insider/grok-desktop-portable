import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { checkpointPreview, TranscriptCheckpoints } from "./TranscriptCheckpoints";

describe("TranscriptCheckpoints", () => {
  it("renders nothing without user turns", () => {
    const { container } = render(
      <TranscriptCheckpoints turns={[]} onJump={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one mark per user turn and jumps on click", async () => {
    const onJump = vi.fn();
    render(
      <TranscriptCheckpoints
        turns={[
          { id: "u-1", preview: "first ask" },
          { id: "u-2", preview: "second ask" },
        ]}
        activeId="u-2"
        onJump={onJump}
      />,
    );
    const marks = screen.getAllByRole("button", { name: /jump to your message/i });
    expect(marks).toHaveLength(2);
    expect(marks[1]).toHaveAttribute("aria-current", "true");
    await userEvent.click(marks[0]!);
    expect(onJump).toHaveBeenCalledWith("u-1");
  });
});

describe("checkpointPreview", () => {
  it("collapses whitespace and truncates long text", () => {
    expect(checkpointPreview("  hello   world  ")).toBe("hello world");
    expect(checkpointPreview("x".repeat(60)).length).toBe(48);
  });
});
