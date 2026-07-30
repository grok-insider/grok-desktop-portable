import { describe, expect, it } from "vitest";
import {
  applyDraftForBash,
  bashBody,
  bashCommandReady,
  bashSendText,
  enterBashMode,
  exitBashMode,
  isBashExitKey,
  isBashMode,
  shouldExitBashOnKey,
} from "./bashMode";

describe("bashMode", () => {
  it("detects leading bang as bash mode", () => {
    expect(isBashMode("! ls")).toBe(true);
    expect(isBashMode("ls")).toBe(false);
    expect(isBashMode("")).toBe(false);
  });

  it("formats CLI-compatible bang send text", () => {
    expect(bashSendText("!ls -la")).toBe("! ls -la");
    expect(bashSendText("! ls -la")).toBe("! ls -la");
    expect(bashSendText("!")).toBe("!");
  });

  it("requires a non-empty command after the bang", () => {
    expect(bashCommandReady("! ")).toBe(false);
    expect(bashCommandReady("! ls")).toBe(true);
  });

  it("enters and exits bash mode without losing body text", () => {
    expect(enterBashMode("echo hi")).toBe("! echo hi");
    expect(enterBashMode("")).toBe("! ");
    expect(exitBashMode("! echo hi")).toBe("echo hi");
    expect(exitBashMode("! ")).toBe("");
  });

  it("promotes a first-character bang into bash typing space", () => {
    expect(applyDraftForBash("!", "")).toBe("! ");
    expect(applyDraftForBash("!x", "!")).toBe("!x");
  });

  it("matches CLI exit keys for empty bash prompt (Backspace/Esc/Ctrl+W/U/C)", () => {
    // PromptInputMode::Bash is_exit_key in the Grok Build pager.
    expect(isBashExitKey({ key: "Backspace" })).toBe(true);
    expect(isBashExitKey({ key: "Escape" })).toBe(true);
    expect(isBashExitKey({ key: "w", ctrlKey: true })).toBe(true);
    expect(isBashExitKey({ key: "u", ctrlKey: true })).toBe(true);
    expect(isBashExitKey({ key: "c", ctrlKey: true })).toBe(true);
    expect(isBashExitKey({ key: "Enter" })).toBe(false);
    expect(isBashExitKey({ key: "a" })).toBe(false);
  });

  it("exits bash only when the body is empty and the key is an exit key", () => {
    expect(shouldExitBashOnKey("!", { key: "Backspace" })).toBe(true);
    expect(shouldExitBashOnKey("! ", { key: "Backspace" })).toBe(true);
    expect(shouldExitBashOnKey("! ", { key: "Escape" })).toBe(true);
    expect(shouldExitBashOnKey("! ls", { key: "Backspace" })).toBe(false);
    expect(shouldExitBashOnKey("hello", { key: "Backspace" })).toBe(false);
    expect(bashBody("! ")).toBe("");
  });
});
