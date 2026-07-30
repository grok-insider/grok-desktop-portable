import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionRepairBanner } from "./SessionRepairBanner";
import type { SessionDiagnosis } from "../services/outcomes";

describe("SessionRepairBanner", () => {
  it("renders nothing without a diagnosis", () => {
    const { container } = render(
      <SessionRepairBanner
        diagnosis={null}
        busy={false}
        onDiagnose={() => undefined}
        onRepair={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("never offers retry language for corrupt history", () => {
    const diagnosis: SessionDiagnosis = {
      sessionId: "s-1",
      status: "corrupt",
      report: {
        repaired: true,
        dryRun: true,
        resident: true,
        duplicatesRemoved: 1,
        syntheticResultsInserted: 0,
        strippedToolResultIds: ["t-1"],
      },
    };
    render(
      <SessionRepairBanner
        diagnosis={diagnosis}
        busy={false}
        onDiagnose={() => undefined}
        onRepair={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(/history only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("calls repair only when the user confirms the apply button", async () => {
    const user = userEvent.setup();
    const onRepair = vi.fn();
    const diagnosis: SessionDiagnosis = {
      sessionId: "s-1",
      status: "corrupt",
      report: {
        repaired: true,
        dryRun: true,
        resident: false,
        duplicatesRemoved: 2,
        syntheticResultsInserted: 1,
        strippedToolResultIds: [],
      },
    };
    render(
      <SessionRepairBanner
        diagnosis={diagnosis}
        busy={false}
        onDiagnose={() => undefined}
        onRepair={onRepair}
        onDismiss={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: /repair history/i }));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("explains unsupported without inventing a healthy state", () => {
    render(
      <SessionRepairBanner
        diagnosis={{ sessionId: "s-1", status: "unsupported" }}
        busy={false}
        onDiagnose={() => undefined}
        onRepair={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /repair history/i })).toBeNull();
  });
});
