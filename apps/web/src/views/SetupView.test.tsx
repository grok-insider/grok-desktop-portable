import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../theme/ThemeProvider";
import { SetupView } from "./SetupView";

function renderSetup(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("SetupView", () => {
  it("explains unpaired setup without treating it as an error", () => {
    renderSetup(<SetupView />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText(/grok-light open/i).length).toBeGreaterThan(0);
  });

  it("explains an expired pairing link", () => {
    renderSetup(<SetupView mode={{ kind: "failure", failure: { kind: "rejected" } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/already used or has expired/i);
  });

  it("offers reload on protocol mismatch", async () => {
    const onReload = vi.fn();
    renderSetup(
      <SetupView
        mode={{ kind: "failure", failure: { kind: "protocol_mismatch", hostVersion: 99 } }}
        onReload={onReload}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/protocol/i);
    await userEvent.click(screen.getByRole("button", { name: /reload page/i }));
    expect(onReload).toHaveBeenCalled();
  });

  it("blocks WebKit with a clear engine diagnosis", () => {
    renderSetup(
      <SetupView
        mode={{
          kind: "unsupported_browser",
          reason: "This browser uses WebKit…",
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/not supported/i);
    expect(screen.getByText(/Chromium or Firefox/i)).toBeInTheDocument();
  });
});
