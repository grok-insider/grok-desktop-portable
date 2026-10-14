import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { DraftRecovery } from "./DraftRecovery";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});

it("updates the accessible control name through loading, consent, saving and failure", () => {
  const change = vi.fn();
  const view = render(<DraftRecovery enabled={false} busy status="loading" onChange={change} />);
  const button = screen.getByRole("button", {name: "Loading drafts…"});
  for (const state of [
    {status: "off" as const, enabled: false, label: "Drafts off"},
    {status: "saving" as const, enabled: false, label: "Saving…"},
    {status: "saved" as const, enabled: true, label: "Saved draft"},
    {status: "failed" as const, enabled: true, label: "Draft not saved"},
  ]) {
    view.rerender(<DraftRecovery enabled={state.enabled} busy={state.status === "saving"} status={state.status} onChange={change} />);
    expect(screen.getByRole("button", {name: state.label})).toBe(button);
  }
  expect(change).not.toHaveBeenCalled();
});

it("keeps retention details in a dialog and requires a separate consent action", async () => {
  const change = vi.fn();
  render(<DraftRecovery enabled={false} busy={false} status="off" onChange={change} />);
  const trigger = screen.getByRole("button", {name: "Drafts off"});
  expect(screen.queryByRole("button", {name: "Remember drafts on this device"})).not.toBeInTheDocument();
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", {name: "Draft storage"})).toBeInTheDocument();
  expect(screen.getByText(/Each edit is kept for seven days/)).toBeVisible();
  expect(change).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Remember drafts on this device"}));
  expect(change).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("lets users inspect and delete saved drafts explicitly", async () => {
  const change = vi.fn();
  render(<DraftRecovery enabled busy={false} status="saved" onChange={change} />);
  await userEvent.click(screen.getByRole("button", {name: "Saved draft"}));
  expect(change).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Delete saved drafts"}));
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
});

it("does not claim a draft is saved while saving and leaves failures visible outside the dialog", () => {
  const view = render(<DraftRecovery enabled busy status="saving" onChange={vi.fn()} />);
  expect(screen.getByRole("button", {name: "Saving…"})).toBeInTheDocument();
  expect(screen.queryByRole("button", {name: "Saved draft"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: "Saving…"}));
  expect(screen.getByRole("button", {name: "Delete saved drafts"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button", {name: "Close"}));
  view.rerender(<DraftRecovery enabled busy={false} status="failed" notice="Storage is full." onChange={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Not saved. Keep a copy");
  expect(screen.getByText("Storage is full.")).toBeVisible();
});

it("Escape closes the settings without changing consent", async () => {
  const change = vi.fn();
  render(<DraftRecovery enabled={false} busy={false} status="off" onChange={change} />);
  const trigger = screen.getByRole("button", {name: "Drafts off"});
  await userEvent.click(trigger);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", {cancelable: true}));
  expect(change).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});
