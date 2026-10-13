import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteControls, type RemoteControlsProps } from "./RemoteControls";

const devices = {outcome: "browserDevices" as const, devices: [
  {sessionId: "self-browser", currentBrowser: true, currentController: false, connected: true, connectionCount: 2, lastSeen: null},
  {sessionId: "other-browser", currentBrowser: false, currentController: true, connected: true, connectionCount: 1, lastSeen: null},
], controlTransferRequests: []};
const props = (): RemoteControlsProps => ({
  scopeKey: "account/host/install", hostLabel: "Test computer", capabilities: {outcome: "remoteCapabilities", projects: true, controlTransfer: true, devicePanel: true}, connected: true, canControl: true, busy: false,
  projects: {outcome: "remoteProjects", parentId: null, entries: [{directoryId: "opaque-root", label: "Approved project"}], nextCursor: null}, browserDevices: devices,
  onBrowseProjects: vi.fn(), onEnrollProject: vi.fn(), onRefreshDevices: vi.fn(), onRequestControl: vi.fn(), onCancelControl: vi.fn(), onApproveControl: vi.fn(), onRevokeBrowser: vi.fn(),
});
beforeEach(() => vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects,control-transfer,device-panel"));
afterEach(() => {vi.unstubAllEnvs(); vi.useRealTimers();});

describe("remote computer controls", () => {
  it("requires both the build experiment and the host capability", () => {
    const callbacks = props();
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "");
    const view = render(<RemoteControls {...callbacks} />);
    expect(screen.queryByRole("region", {name: "Remote computer tools"})).not.toBeInTheDocument();
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects,control-transfer,device-panel");
    view.rerender(<RemoteControls {...callbacks} capabilities={undefined} />);
    expect(screen.queryByRole("region", {name: "Remote computer tools"})).not.toBeInTheDocument();
    expect(callbacks.onBrowseProjects).not.toHaveBeenCalled();
    expect(callbacks.onRefreshDevices).not.toHaveBeenCalled();
  });
  it("browses and enrolls only the opaque folder chosen by the user", () => {
    const callbacks = props();
    const view = render(<RemoteControls {...callbacks} />);
    expect(callbacks.onBrowseProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Browse approved folders"}));
    expect(callbacks.onBrowseProjects).toHaveBeenCalledExactlyOnceWith({});
    fireEvent.click(screen.getByRole("button", {name: "Browse Approved project"}));
    expect(callbacks.onBrowseProjects).toHaveBeenLastCalledWith({directoryId: "opaque-root"});
    view.rerender(<RemoteControls {...callbacks} projects={{outcome: "remoteProjects", parentId: "opaque-root", entries: [], nextCursor: "opaque-cursor"}} />);
    fireEvent.click(screen.getByRole("button", {name: "Use this folder as a project"}));
    expect(callbacks.onEnrollProject).toHaveBeenCalledExactlyOnceWith("opaque-root");
    fireEvent.click(screen.getByRole("button", {name: "Next folders"}));
    expect(callbacks.onBrowseProjects).toHaveBeenLastCalledWith({directoryId: "opaque-root", cursor: "opaque-cursor"});
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("permits observers to browse but disables enrollment and revoking others", () => {
    const callbacks = props();
    render(<RemoteControls {...callbacks} canControl={false} />);
    fireEvent.click(screen.getByRole("button", {name: "Browse approved folders"}));
    expect(screen.getByRole("button", {name: "Browse Approved project"})).toBeEnabled();
    expect(screen.getByRole("button", {name: "Add Approved project as a project"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button", {name: "Browsers and control"}));
    expect(screen.getByRole("button", {name: "Remove browser access"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Remove this browser"})).toBeEnabled();
  });
  it("requires a separate explicit confirmation before revoking a selected browser", () => {
    const callbacks = props();
    render(<RemoteControls {...callbacks} />);
    fireEvent.click(screen.getByRole("button", {name: "Browsers and control"}));
    fireEvent.click(screen.getByRole("button", {name: "Remove browser access"}));
    expect(callbacks.onRevokeBrowser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Keep browser access"}));
    expect(callbacks.onRevokeBrowser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name: "Remove browser access"}));
    fireEvent.click(screen.getByRole("button", {name: "Confirm removal"}));
    expect(callbacks.onRevokeBrowser).toHaveBeenCalledExactlyOnceWith("other-browser", false);
  });
  it("drops pending confirmation on disconnection or account/host change", () => {
    const callbacks = props();
    const view = render(<RemoteControls {...callbacks} />);
    fireEvent.click(screen.getByRole("button", {name: "Browsers and control"}));
    fireEvent.click(screen.getByRole("button", {name: "Remove browser access"}));
    view.rerender(<RemoteControls {...callbacks} connected={false} />);
    expect(screen.queryByRole("button", {name: "Confirm removal"})).not.toBeInTheDocument();
    expect(screen.getByText(/information below may be out of date/)).toBeVisible();
    view.rerender(<RemoteControls {...callbacks} scopeKey="other-account/other-host" />);
    expect(screen.queryByText("other-browser")).not.toBeInTheDocument();
    expect(callbacks.onRevokeBrowser).not.toHaveBeenCalled();
  });
  it("does not treat another tab's request as this connection's own request", () => {
    const callbacks = props();
    const request = {requestId: "other-tab", sessionId: "self-browser", expiresAt: Date.now() + 30_000};
    const view = render(<RemoteControls {...callbacks} canControl={false} browserDevices={{...devices, controlTransferRequests: [request]}} />);
    fireEvent.click(screen.getByRole("button", {name: "Browsers and control"}));
    fireEvent.click(screen.getByRole("button", {name: "Request control"}));
    expect(callbacks.onRequestControl).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", {name: "Cancel control request"})).not.toBeInTheDocument();
    view.rerender(<RemoteControls {...callbacks} canControl={false} ownControlRequest={{...request, requestId: "this-connection"}} />);
    fireEvent.click(screen.getByRole("button", {name: "Cancel control request"}));
    expect(callbacks.onCancelControl).toHaveBeenCalledExactlyOnceWith("this-connection");
  });
  it("never approves an expired request even before the display timer catches up", () => {
    vi.useFakeTimers();
    const callbacks = props();
    const request = {requestId: "request", sessionId: "other-browser", expiresAt: Date.now() + 500};
    render(<RemoteControls {...callbacks} browserDevices={{...devices, controlTransferRequests: [request]}} />);
    fireEvent.click(screen.getByRole("button", {name: "Browsers and control"}));
    const approve = screen.getByRole("button", {name: "Transfer control to this browser"});
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(approve);
    expect(callbacks.onApproveControl).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole("button", {name: "Transfer control to this browser"})).not.toBeInTheDocument();
  });
});
