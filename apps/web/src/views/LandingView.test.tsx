import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LandingView } from "./LandingView";

describe("LandingView", () => {
  it("shows install guidance when the bridge is missing", () => {
    render(<LandingView probe={{ kind: "bridge_missing" }} onRetry={() => {}} />);
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "bridge_missing",
    );
    expect(screen.getByRole("heading", { name: /Start the local bridge/i })).toBeTruthy();
    expect(screen.getByText(/Install and run grok-bridge/i)).toBeTruthy();
    expect(screen.getByTestId("landing-install")).toHaveTextContent("grok-bridge serve");
    expect(screen.getByTestId("landing-install")).toHaveTextContent("grok-bridge open");
    expect(screen.queryByText(/Disconnected/i)).toBeNull();
    expect(screen.queryByText(/Pick a project/i)).toBeNull();
  });

  it("shows LNA help when local network is blocked", () => {
    render(<LandingView probe={{ kind: "blocked_lna" }} onRetry={() => {}} />);
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "blocked_lna",
    );
    expect(screen.getByRole("heading", { name: /Allow local network access/i })).toBeTruthy();
    expect(screen.getByText(/blocked connections from desktop\.grok\.me/i)).toBeTruthy();
  });

  it("shows pairing instructions when bridge is up but unpaired", () => {
    render(<LandingView probe={{ kind: "needs_pairing" }} onRetry={() => {}} />);
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "needs_pairing",
    );
    expect(screen.getByRole("heading", { name: /Pair this browser/i })).toBeTruthy();
    expect(screen.getByText(/The bridge is running/i)).toBeTruthy();
    expect(screen.getByTestId("landing-install")).toHaveTextContent("grok-bridge open");
    expect(screen.getByTestId("landing-install")).not.toHaveTextContent("install.sh");
  });

  it("emphasizes serve when a port was known but the bridge is down", () => {
    render(
      <LandingView
        probe={{ kind: "bridge_missing" }}
        onRetry={() => {}}
        hadPort
      />,
    );
    expect(screen.getByTestId("landing-view")).toHaveAttribute("data-had-port", "1");
    expect(screen.getByText(/remembers a local bridge port/i)).toBeTruthy();
    expect(screen.getByTestId("landing-install")).not.toHaveTextContent("install.sh");
    expect(screen.getByTestId("landing-install")).toHaveTextContent("grok-bridge serve");
  });

  it("shows checking state without Work chrome", () => {
    render(<LandingView probe={{ kind: "checking" }} onRetry={() => {}} />);
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "checking",
    );
    expect(screen.getByRole("heading", { name: /Looking for the local bridge/i })).toBeTruthy();
    expect(screen.queryByText(/Pick a project/i)).toBeNull();
  });

  it("shows error messages from the probe", () => {
    render(
      <LandingView
        probe={{ kind: "error", message: "unexpected mode: foo" }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId("landing-view")).toHaveAttribute(
      "data-probe-kind",
      "error",
    );
    expect(screen.getByText(/unexpected mode: foo/i)).toBeTruthy();
  });

  it("invokes Retry", async () => {
    const onRetry = vi.fn();
    render(<LandingView probe={{ kind: "bridge_missing" }} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("mentions product name and trust note", () => {
    render(<LandingView probe={{ kind: "bridge_missing" }} onRetry={() => {}} />);
    expect(screen.getAllByText(/Grok Desktop Portable/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not a sandbox/i)).toBeTruthy();
  });
});
