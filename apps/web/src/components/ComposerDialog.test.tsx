import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { ComposerDialog, OptionalDialogsBlockedContext } from "./ComposerDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});

it("retains child state while closed and restores focus on an ordinary close", async () => {
  const mounted = vi.fn();
  function Child() {useEffect(() => {mounted();}, []);return <input aria-label="Persistent field" />;}
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open tools</button><ComposerDialog open={open} title="Tools" onClose={() => setOpen(false)}><Child /></ComposerDialog></>;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", {name: "Open tools"});
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(trigger);
  await userEvent.type(screen.getByRole("textbox"), "kept");
  await userEvent.click(screen.getByRole("button", {name: "Close tools"}));
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.click(trigger);
  expect(screen.getByRole("textbox")).toHaveValue("kept");
  expect(mounted).toHaveBeenCalledOnce();
});

it("closes optional top-layer UI before a required decision takes focus", async () => {
  const close = vi.fn();
  function Required() {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {ref.current?.focus();}, []);
    return <div role="alertdialog" aria-label="Required decision"><button ref={ref}>Reject once</button></div>;
  }
  function Harness({blocked}: {blocked: boolean}) {
    const [open, setOpen] = useState(false);
    return <OptionalDialogsBlockedContext.Provider value={blocked}><button onClick={() => setOpen(true)}>Open tools</button><ComposerDialog open={open} title="Tools" onClose={() => {close();setOpen(false);}}>Optional details</ComposerDialog>{blocked && <Required />}</OptionalDialogsBlockedContext.Provider>;
  }
  const view = render(<Harness blocked={false} />);
  await userEvent.click(screen.getByRole("button", {name: "Open tools"}));
  expect(screen.getByRole("dialog", {name: "Tools"})).toHaveAttribute("open");
  view.rerender(<Harness blocked />);
  expect(screen.queryByRole("dialog", {name: "Tools"})).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Reject once"})).toHaveFocus();
  expect(close).toHaveBeenCalledOnce();
  view.rerender(<Harness blocked={false} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: "Open tools"}));
  expect(screen.getByRole("dialog", {name: "Tools"})).toBeInTheDocument();
});
