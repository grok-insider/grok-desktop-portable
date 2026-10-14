import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionalDialogsBlockedContext } from "./ComposerDialog";
import { RemoteControls, type RemoteControlsProps } from "./RemoteControls";
import { RemoteToolsNotice, RemoteToolsPanel, useRemoteControlAttention } from "./RemoteToolsPanel";
import { ThemeProvider } from "../theme/ThemeProvider";

const props = (): RemoteControlsProps => ({
  scopeKey: "synthetic-computer", connected: true, canControl: true, busy: false,
  capabilities: {outcome: "remoteCapabilities", projects: true, controlTransfer: true, devicePanel: true},
  projects: {outcome: "remoteProjects", parentId: null, entries: [{directoryId: "opaque-root", label: "Example project"}], nextCursor: null},
  browserDevices: {outcome: "browserDevices", devices: [], controlTransferRequests: []},
  onBrowseProjects: vi.fn(), onEnrollProject: vi.fn(), onRefreshDevices: vi.fn(), onRequestControl: vi.fn(), onCancelControl: vi.fn(), onApproveControl: vi.fn(), onRevokeBrowser: vi.fn(),
});

function Harness({controls, blocked = false}: {controls: RemoteControlsProps; blocked?: boolean}) {
  const [open, setOpen] = useState(false);
  const attention = useRemoteControlAttention(controls);
  return <ThemeProvider><OptionalDialogsBlockedContext.Provider value={blocked}>
    <RemoteToolsPanel open={open} onOpenChange={setOpen} attention={attention} error={controls.error} connected={controls.connected} available={Boolean(controls.capabilities)}><RemoteControls {...controls} /></RemoteToolsPanel>
    <RemoteToolsNotice attention={attention} error={controls.error} onOpen={() => setOpen(true)} />
  </OptionalDialogsBlockedContext.Provider></ThemeProvider>;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects,control-transfer,device-panel");
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});
afterEach(() => {vi.unstubAllEnvs();vi.useRealTimers();});

describe("computer settings", () => {
  it("keeps settings out of the conversation and preserves folder navigation when closed", async () => {
    const controls = props();
    render(<Harness controls={controls} />);
    expect(screen.queryByRole("button", {name: "Browse approved folders"})).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", {name: "Computer settings"});
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {name: "Computer settings"});
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("heading", {name: "Computer settings"})).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", {name: "Browse approved folders"}));
    expect(within(dialog).getByRole("button", {name: "Browse Example project"})).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", {name: "Close computer settings"}));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(within(dialog).getByRole("button", {name: "Browse Example project"})).toBeVisible();
    expect(controls.onBrowseProjects).toHaveBeenCalledExactlyOnceWith({});
    expect(document.querySelectorAll('[aria-label="Remote computer tools"]')).toHaveLength(1);
    fireEvent(dialog, new Event("cancel", {cancelable: true}));
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("announces incoming and outgoing requests while settings are closed and expires them", () => {
    vi.useFakeTimers();
    const controls = props();
    controls.browserDevices!.controlTransferRequests = [{requestId: "incoming", sessionId: "other-browser", expiresAt: Date.now() + 1_000}];
    const view = render(<Harness controls={controls} />);
    expect(screen.getByRole("status")).toHaveTextContent("A browser is requesting control.");
    fireEvent.click(screen.getByRole("button", {name: "Review computer settings"}));
    expect(screen.getByRole("dialog", {name: "Computer settings"})).toBeVisible();
    fireEvent.click(screen.getByRole("button", {name: "Close computer settings"}));
    act(() => vi.advanceTimersByTime(1_001));
    expect(screen.queryByRole("button", {name: "Review computer settings"})).not.toBeInTheDocument();
    view.rerender(<Harness controls={{...controls, canControl: false, ownControlRequest: {requestId: "own", sessionId: "this-browser", expiresAt: Date.now() + 1_000}}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Your control request is waiting for approval.");
    expect(controls.onApproveControl).not.toHaveBeenCalled();
    expect(controls.onRequestControl).not.toHaveBeenCalled();
  });

  it("keeps action failures visible after closing and returns to their settings", async () => {
    render(<Harness controls={{...props(), error: "The folder selection expired. Open Approved roots and choose again."}} />);
    expect(screen.getByRole("status")).toHaveTextContent("The folder selection expired");
    await userEvent.click(screen.getByRole("button", {name: "Review computer settings"}));
    expect(screen.getByRole("dialog", {name: "Computer settings"})).toBeVisible();
    expect(screen.getByRole("button", {name: /Theme: System/})).toBeVisible();
  });

  it("closes for a required decision without reopening or changing computer authority", async () => {
    const controls = props();
    const view = render(<Harness controls={controls} />);
    await userEvent.click(screen.getByRole("button", {name: "Computer settings"}));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(<Harness controls={controls} blocked />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<Harness controls={controls} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(controls.onApproveControl).not.toHaveBeenCalled();
    expect(controls.onRevokeBrowser).not.toHaveBeenCalled();
  });
});
