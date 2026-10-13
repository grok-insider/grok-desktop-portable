import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionComposer } from "./SessionComposer";
import type { Recognition } from "../../components/Dictation";

class FakeRecognition implements Recognition {
  static latest: FakeRecognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: Recognition["onresult"] = null;
  onerror: Recognition["onerror"] = null;
  onend: Recognition["onend"] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {FakeRecognition.latest = this;}
}

beforeEach(() => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "dictation");
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});
afterEach(() => {vi.unstubAllEnvs();vi.unstubAllGlobals();});

function setup(draftFits?: (text: string) => boolean) {
  const submit = vi.fn();
  let replaceDraft: (text: string) => void = () => {};
  function Harness() {
    const [draft, setDraft] = useState("before OLD after");
    replaceDraft = setDraft;
    return <SessionComposer connected phase="idle" draft={draft} onDraftChange={setDraft} draftFits={draftFits} queued={[]} onRemoveQueued={vi.fn()} models={[]} modelId={null} effortId={null} onModelChange={vi.fn()} onEffortChange={vi.fn()} onSubmit={submit} onSendNow={vi.fn()} onCancel={vi.fn()} />;
  }
  render(<Harness />);
  const input = screen.getByRole("textbox", {name: "Message the agent"}) as HTMLTextAreaElement;
  input.focus();
  input.setSelectionRange(7, 10);
  return {input, submit, replaceDraft: (text: string) => act(() => replaceDraft(text))};
}

async function review(text: string) {
  await userEvent.click(screen.getByRole("button", {name: "Dictate"}));
  await userEvent.click(screen.getByRole("button", {name: "Start microphone"}));
  act(() => {
    FakeRecognition.latest.onresult?.({results: [{isFinal: true, 0: {transcript: text}}]});
    FakeRecognition.latest.onend?.();
  });
}

it("keeps unsupported shared shell drafts intact and offers no shell action", async () => {
  const submit = vi.fn();
  render(<SessionComposer connected shellEnabled={false} phase="idle" draft="! git status" onDraftChange={vi.fn()} queued={[]} onRemoveQueued={vi.fn()} models={[]} modelId={null} effortId={null} onModelChange={vi.fn()} onEffortChange={vi.fn()} onSubmit={submit} onSendNow={vi.fn()} onCancel={vi.fn()} />);
  const input = screen.getByRole("textbox", {name: "Message the agent"});
  expect(input).toHaveValue("! git status");
  expect(screen.getByRole("status")).toHaveTextContent("unavailable in shared conversations");
  expect(screen.getByRole("button", {name: /^Send/})).toBeDisabled();
  fireEvent.keyDown(input, {key: "Enter"});
  fireEvent.keyDown(input, {key: "Enter", ctrlKey: true});
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Add to message"}));
  expect(screen.queryByRole("menuitem", {name: /Shell/})).not.toBeInTheDocument();
});

it("keeps the editor mounted, replaces the original selection and returns its cursor without sending", async () => {
  const {input, submit} = setup();
  await review("new");
  const reviewed = screen.getByRole("textbox", {name: "Review dictation"});
  fireEvent.keyDown(reviewed, {key: "Enter"});
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Insert into draft"}));
  expect(screen.getByRole("textbox", {name: "Message the agent"})).toBe(input);
  expect(input).toHaveValue("before new after");
  await waitFor(() => expect(input).toHaveFocus());
  expect([input.selectionStart, input.selectionEnd]).toEqual([10, 10]);
  expect(submit).not.toHaveBeenCalled();
});

it("cancel leaves the original draft and selection intact", async () => {
  const {input, submit} = setup();
  await review("discarded");
  await userEvent.click(screen.getByRole("button", {name: "Cancel dictation"}));
  expect(input).toHaveValue("before OLD after");
  expect([input.selectionStart, input.selectionEnd]).toEqual([7, 10]);
  expect(screen.getByRole("button", {name: "Dictate"})).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();
});

it("keeps rejected oversized dictation available for correction in the modal", async () => {
  const {input, submit} = setup(text => text.length < 20);
  await review("this replacement is too long");
  await userEvent.click(screen.getByRole("button", {name: "Insert into draft"}));
  expect(input).toHaveValue("before OLD after");
  expect(screen.getByRole("dialog", {name: "Dictation"})).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("Your draft is unchanged");
  fireEvent.change(screen.getByRole("textbox", {name: "Review dictation"}), {target: {value: "new"}});
  await userEvent.click(screen.getByRole("button", {name: "Insert into draft"}));
  expect(input).toHaveValue("before new after");
  expect(submit).not.toHaveBeenCalled();
});

it("does not insert at a stale selection after an external draft change", async () => {
  const {input, submit, replaceDraft} = setup();
  await review("new");
  replaceDraft("updated elsewhere");
  await userEvent.click(screen.getByRole("button", {name: "Insert into draft"}));
  expect(input).toHaveValue("updated elsewhere");
  expect(screen.getByRole("textbox", {name: "Review dictation"})).toHaveValue("new");
  expect(screen.getByRole("alert")).toHaveTextContent("cancel and reopen dictation");
  expect(submit).not.toHaveBeenCalled();
});
