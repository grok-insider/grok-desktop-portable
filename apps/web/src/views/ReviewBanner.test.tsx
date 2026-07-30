import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewBanner } from "./ReviewBanner";

const RECORD = {
  recordId: "ir-1",
  operation: "Prompt",
  cause: "host_restart",
};

function renderBanner(overrides: Partial<Parameters<typeof ReviewBanner>[0]> = {}) {
  const props = {
    reviews: [RECORD],
    busy: false,
    onAcknowledge: vi.fn(),
    ...overrides,
  };
  render(<ReviewBanner {...props} />);
  return props;
}

describe("ReviewBanner", () => {
  it("shows nothing when there is nothing to review", () => {
    const { container } = render(
      <ReviewBanner reviews={[]} busy={false} onAcknowledge={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says the action was not retried", () => {
    // The user has to know Light did not quietly run it a second time.
    renderBanner();
    expect(screen.getByText(/not retried/i)).toBeInTheDocument();
  });

  it("never offers to retry or undo", () => {
    // Light cannot tell whether the effect happened, so offering either
    // would be claiming knowledge it does not have (plan §7.5).
    renderBanner();
    expect(screen.queryByRole("button", { name: /retry|try again|undo/i })).not.toBeInTheDocument();
  });

  it("explains why the outcome is unknown", () => {
    renderBanner();
    expect(screen.getByText(/restarted after recording it/i)).toBeInTheDocument();
  });

  it("does not invent a reason for a cause it does not know", () => {
    renderBanner({ reviews: [{ ...RECORD, cause: "something_new" }] });
    expect(screen.getByText(/could not confirm what happened/i)).toBeInTheDocument();
  });

  it("acknowledges the exact record", async () => {
    const props = renderBanner();
    await userEvent.click(screen.getByRole("button", { name: /mark prompt as reviewed/i }));
    expect(props.onAcknowledge).toHaveBeenCalledWith("ir-1");
  });

  it("lists every unresolved effect rather than collapsing them", () => {
    renderBanner({
      reviews: [RECORD, { recordId: "ir-2", operation: "DecidePermission", cause: "agent_exit" }],
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/2 actions were interrupted/i)).toBeInTheDocument();
  });

  it("cannot be acknowledged twice while the host is answering", async () => {
    const props = renderBanner({ busy: true });
    const button = screen.getByRole("button", { name: /mark prompt as reviewed/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(props.onAcknowledge).not.toHaveBeenCalled();
  });
});
