import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LandingView } from "./LandingView";

describe("LandingView", () => {
  it("shows install guidance when the bridge is missing", () => {
    render(<LandingView probe={{ kind: "bridge_missing" }} onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: /Start the local bridge/i })).toBeTruthy();
    expect(screen.getByText(/Install and run grok-bridge/i)).toBeTruthy();
    expect(screen.getByText(/install\.sh/)).toBeTruthy();
  });

  it("shows LNA help when local network is blocked", () => {
    render(<LandingView probe={{ kind: "blocked_lna" }} onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: /Allow local network access/i })).toBeTruthy();
    expect(screen.getByText(/blocked connections from desktop\.grok\.me/i)).toBeTruthy();
  });

  it("shows pairing instructions when bridge is up but unpaired", () => {
    render(<LandingView probe={{ kind: "needs_pairing" }} onRetry={() => {}} />);
    expect(screen.getByRole("heading", { name: /Pair this browser/i })).toBeTruthy();
    expect(screen.getByText(/The bridge is running/i)).toBeTruthy();
  });
});
