import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dictation, type Recognition } from "./Dictation";
import { SpeechPlayback, speechChunks } from "./SpeechPlayback";
import { OptionalDialogsBlockedContext } from "./ComposerDialog";

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
class FakeUtterance {
  onend?: () => void;
  onerror?: () => void;
  constructor(readonly text: string) {}
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
  FakeRecognition.latest = undefined as unknown as FakeRecognition;
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {speak:vi.fn(),cancel:vi.fn(),pause:vi.fn(),resume:vi.fn()});
});
afterEach(() => {cleanup();vi.unstubAllGlobals();vi.useRealTimers();});

function startDictation() {
  fireEvent.click(screen.getByRole("button", {name:"Dictate"}));
  fireEvent.click(screen.getByRole("button", {name:"Start microphone"}));
  return FakeRecognition.latest;
}

describe("dictation experiment", () => {
  it("opens a modal without starting the microphone and returns focus on cancel", async () => {
    const insert = vi.fn();
    render(<Dictation disabled={false} onInsert={insert} />);
    const trigger = screen.getByRole("button", {name: "Dictate"});
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {name: "Dictation"});
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByRole("heading", {name: "Dictation"})).toHaveFocus();
    expect(FakeRecognition.latest).toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", {cancelable: true}));
    expect(screen.queryByRole("dialog", {name: "Dictation"})).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("discards recording and stale callbacks when a required decision arrives", () => {
    const insert = vi.fn();
    const view = render(<OptionalDialogsBlockedContext.Provider value={false}><Dictation disabled={false} onInsert={insert} /></OptionalDialogsBlockedContext.Provider>);
    const recognition = startDictation();
    act(() => recognition.onresult?.({results:[{isFinal:true,0:{transcript:"discard me"}}]}));
    view.rerender(<OptionalDialogsBlockedContext.Provider value><Dictation disabled={false} onInsert={insert} /></OptionalDialogsBlockedContext.Provider>);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => recognition.onresult?.({results:[{isFinal:true,0:{transcript:"late words"}}]}));
    view.rerender(<OptionalDialogsBlockedContext.Provider value={false}><Dictation disabled={false} onInsert={insert} /></OptionalDialogsBlockedContext.Provider>);
    fireEvent.click(screen.getByRole("button", {name: "Dictate"}));
    expect(screen.queryByLabelText("Review dictation")).not.toBeInTheDocument();
    expect(insert).not.toHaveBeenCalled();
  });
  it("reports a browser constructor failure without starting a microphone", () => {
    vi.stubGlobal("SpeechRecognition", class {constructor() {throw new Error("disabled");}});
    const insert = vi.fn();
    render(<Dictation disabled={false} onInsert={insert} />);
    startDictation();
    expect(screen.getByRole("alert")).toHaveTextContent("supports speech recognition");
    expect(insert).not.toHaveBeenCalled();
  });
  it("requires reviewed insertion and preserves the review when the draft refuses it", () => {
    const insert = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Dictation disabled={false} onInsert={insert} />);
    const recognition = startDictation();
    act(() => recognition.onresult?.({results:[{isFinal:true,0:{transcript:"git status"}}]}));
    expect(insert).not.toHaveBeenCalled();
    expect(screen.getByRole("button", {name:"Insert into draft"})).toBeDisabled();
    act(() => recognition.onend?.());
    fireEvent.change(screen.getByLabelText("Review dictation"), {target:{value:"git diff"}});
    fireEvent.click(screen.getByRole("button", {name:"Insert into draft"}));
    expect(screen.getByLabelText("Review dictation")).toHaveValue("git diff");
    expect(screen.getByRole("alert")).toHaveTextContent("Your draft is unchanged");
    fireEvent.click(screen.getByRole("button", {name:"Insert into draft"}));
    expect(insert.mock.calls).toEqual([["git diff"],["git diff"]]);
    expect(screen.queryByLabelText("Review dictation")).not.toBeInTheDocument();
  });
  it("ignores results after cancel, disconnect and unmount", () => {
    const insert = vi.fn();
    const view = render(<Dictation disabled={false} onInsert={insert} />);
    const recognition = startDictation();
    fireEvent.click(screen.getByRole("button", {name:"Cancel dictation"}));
    act(() => recognition.onresult?.({results:[{isFinal:true,0:{transcript:"stale"}}]}));
    expect(screen.queryByLabelText("Review dictation")).not.toBeInTheDocument();
    startDictation();
    const active = FakeRecognition.latest;
    view.rerender(<Dictation disabled onInsert={insert} />);
    expect(active.abort).toHaveBeenCalled();
    view.unmount();
    act(() => active.onresult?.({results:[{isFinal:true,0:{transcript:"later"}}]}));
    expect(insert).not.toHaveBeenCalled();
  });
  it.each(["not-allowed", "no-speech", "network", "audio-capture"])("reports %s without writing a draft", error => {
    const insert = vi.fn();render(<Dictation disabled={false} onInsert={insert} />);
    const recognition = startDictation();
    act(() => recognition.onerror?.({error}));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(insert).not.toHaveBeenCalled();
    expect(recognition.abort).toHaveBeenCalled();
  });
});

describe("speech playback experiment", () => {
  it("keeps the idle control compact and exposes active controls with accessible names", () => {
    render(<SpeechPlayback text="One answer." disabled={false} />);
    const read = screen.getByRole("button", {name: "Read last answer"});
    expect(read.textContent).toBe("");
    expect(read).toHaveAttribute("type", "button");
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    fireEvent.click(read);
    expect(screen.queryByRole("button", {name: "Read last answer"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Pause playback"})).toHaveAttribute("type", "button");
    fireEvent.click(screen.getByRole("button", {name: "Stop playback"}));
    expect(screen.getByRole("button", {name: "Read last answer"})).toBeEnabled();
    expect(window.speechSynthesis.cancel).toHaveBeenCalledOnce();
  });
  it("chunks long answers without breaking UTF-16 pairs or dropping words", () => {
    const text = ("🦀A ".repeat(5000)).trim();
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.join(" ").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk) && chunk.length <= 500)).toBe(true);
    expect(() => speechChunks("a".repeat(200001))).toThrow(/too long/);
  });
  it("pauses, resumes and cancels without accepting old callbacks", () => {
    const view = render(<SpeechPlayback text={"answer ".repeat(1000)} disabled={false} />);
    fireEvent.click(screen.getByRole("button", {name:"Read last answer"}));
    const engine = window.speechSynthesis;
    const utterance = vi.mocked(engine.speak).mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", {name:"Pause playback"}));
    expect(engine.pause).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", {name:"Resume playback"}));
    expect(engine.resume).toHaveBeenCalledOnce();
    view.rerender(<SpeechPlayback text="another session" disabled={false} />);
    expect(engine.cancel).toHaveBeenCalledOnce();
    act(() => (utterance as unknown as FakeUtterance).onend?.());
    expect(engine.speak).toHaveBeenCalledOnce();
  });
  it("only queues the next chunk on completion and stops on lost access", () => {
    const view = render(<SpeechPlayback text={"answer ".repeat(1000)} disabled={false} />);
    fireEvent.click(screen.getByRole("button", {name:"Read last answer"}));
    const engine = window.speechSynthesis;
    expect(engine.speak).toHaveBeenCalledOnce();
    const utterance = vi.mocked(engine.speak).mock.calls[0][0];
    act(() => (utterance as unknown as FakeUtterance).onend?.());
    expect(engine.speak).toHaveBeenCalledTimes(2);
    view.rerender(<SpeechPlayback text={"answer ".repeat(1000)} disabled />);
    expect(engine.cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", {name:"Read last answer"})).toBeDisabled();
  });
});
