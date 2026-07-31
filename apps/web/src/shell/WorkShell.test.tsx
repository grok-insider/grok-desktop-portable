import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import { THEME_STORAGE_KEY } from "../theme/theme";
import { WorkShell } from "./WorkShell";

function renderShell(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("WorkShell", () => {
  it("shows Home as the primary navigation control", () => {
    renderShell(
      <WorkShell connected phase="streaming">
        <p>body</p>
      </WorkShell>,
    );
    expect(screen.getByRole("button", { name: /^home$/i })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("marks Home current on the catalogue surface", () => {
    renderShell(
      <WorkShell connected surface="home" phase="idle">
        <span />
      </WorkShell>,
    );
    expect(screen.getByRole("button", { name: /^home$/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders open conversations as tabs after a divider", async () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onGoHome = vi.fn();
    renderShell(
      <WorkShell
        connected
        surface="session"
        phase="idle"
        tabs={[
          {
            sessionId: "s-1",
            title: "Fix the installer",
            workspaceName: "desktop",
            running: true,
          },
          {
            sessionId: "s-2",
            title: "New conversation",
            workspaceName: "desktop",
            awaitingDecision: true,
          },
        ]}
        activeTabId="s-1"
        onGoHome={onGoHome}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onGoHome}
      >
        <span />
      </WorkShell>,
    );

    const tablist = screen.getByRole("tablist", { name: /open conversations/i });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText("Fix the installer")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /fix the installer/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await userEvent.click(screen.getByRole("tab", { name: /new conversation/i }));
    expect(onSelectTab).toHaveBeenCalledWith("s-2");

    await userEvent.click(screen.getByRole("button", { name: /close fix the installer/i }));
    expect(onCloseTab).toHaveBeenCalledWith("s-1");

    await userEvent.click(screen.getByRole("button", { name: /^home$/i }));
    expect(onGoHome).toHaveBeenCalled();
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
