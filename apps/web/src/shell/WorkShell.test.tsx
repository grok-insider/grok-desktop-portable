import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import { THEME_STORAGE_KEY } from "../theme/theme";
import { WorkShell } from "./WorkShell";

function renderShell(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("WorkShell", () => {
  it("shows a running turn as a labelled chip", () => {
    renderShell(
      <WorkShell connected phase="streaming">
        <p>body</p>
      </WorkShell>,
    );
    expect(screen.getByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("draws no chip for a resting connection or a resting phase", () => {
    renderShell(
      <WorkShell connected phase="idle">
        <span />
      </WorkShell>,
    );
    // A permanent "Connected"/"Idle" pair trains the eye to skip the corner
    // where a disconnect has to be noticed. The live region still says both.
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/connected to host/i);
  });

  it("shows a chip once the connection drops", () => {
    renderShell(
      <WorkShell connected={false} phase="idle">
        <span />
      </WorkShell>,
    );
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("shows the workspace display name without treating it as a path", () => {
    renderShell(
      <WorkShell connected workspaceName="test" phase="idle">
        <span />
      </WorkShell>,
    );
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.queryByText(/\/home\//)).not.toBeInTheDocument();
  });

  it("announces disconnect for assistive tech", () => {
    renderShell(
      <WorkShell connected={false} phase="idle">
        <span />
      </WorkShell>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/disconnected/i);
  });

  it("exposes a theme control that cycles preference", async () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    renderShell(
      <WorkShell connected phase="idle">
        <span />
      </WorkShell>,
    );
    const toggle = screen.getByRole("button", { name: /theme:/i });
    expect(toggle).toHaveAccessibleName(/system/i);
    await userEvent.click(toggle);
    expect(toggle).toHaveAccessibleName(/light/i);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });
});
