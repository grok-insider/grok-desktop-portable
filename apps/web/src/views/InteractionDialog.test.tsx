import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionDialog } from "./InteractionDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});

describe("terminal interaction cards", () => {
  it("preserves a typed answer and offers reconnect while controls are suspended", async () => {
    const request = {kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "plan", details: {planContent: "Review this plan"}} as const;
    const answer = vi.fn();
    const reconnect = vi.fn();
    const {rerender} = render(<InteractionDialog request={request} busy={false} onAnswer={answer} />);
    await userEvent.type(screen.getByRole("textbox", {name: "Feedback for changes"}), "Keep these changes private");
    rerender(<InteractionDialog request={request} busy connected={false} onReconnect={reconnect} onAnswer={answer} />);
    expect(screen.getByRole("button", {name: "Approve plan"})).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", {name: "Approve plan"}).closest("form")!);
    await userEvent.click(screen.getByRole("button", {name: "Reconnect"}));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", {name: "Feedback for changes"})).toHaveValue("Keep these changes private");
  });

  it("does not approve a plan the host supplied without readable text", () => {
    render(<InteractionDialog request={{kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "plan", details: {planContent: {unreadable: true}}}} busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole("button", {name: "Approve plan"})).toBeDisabled();
  });
  it("returns selected labels keyed by the actual question", async () => {
    const answer = vi.fn();
    render(<InteractionDialog request={{kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "question", details: {questions: [{question: "Choose target", options: [{label: "Preview", description: "Keep private"}, {label: "Production"}]}]}}} busy={false} onAnswer={answer} />);
    expect(screen.getByRole("button", {name: "Send answer"})).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", {name: /Preview/}));
    await userEvent.click(screen.getByRole("button", {name: "Send answer"}));
    expect(answer).toHaveBeenCalledWith({outcome: "accepted", answers: {"Choose target": ["Preview"]}});
  });

  it("shows the proposed plan and sends requested changes without approving", async () => {
    const answer = vi.fn();
    render(<InteractionDialog request={{kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "plan", details: {planContent: "**Inspect** the project"}}} busy={false} onAnswer={answer} />);
    expect(screen.getByText("Inspect")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", {name: "Feedback for changes"}), "Only this workspace");
    await userEvent.click(screen.getByRole("button", {name: "Request changes"}));
    expect(answer).toHaveBeenCalledWith({outcome: "cancelled", feedback: "Only this workspace"});
  });

  it("does not offer a tool-provided executable URL", () => {
    render(<InteractionDialog request={{kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "mcp", details: {serverName: "Tool", mode: "url", url: "javascript:alert(1)"}}} busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole("button", {name: "Send answer"})).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/needs the terminal/)).toBeInTheDocument();
  });
});


it("accepts an explicit false for a required MCP boolean", async () => {
  const answer = vi.fn();
  render(<InteractionDialog request={{kind: "interactionRequest", sessionId: "s", requestId: "r", interactionKind: "mcp", details: {requestedSchema: {type: "object", properties: {remember: {type: "boolean", title: "Remember choice"}}, required: ["remember"]}}}} busy={false} onAnswer={answer} />);
  await userEvent.selectOptions(screen.getByRole("combobox", {name: "Remember choice"}), "false");
  await userEvent.click(screen.getByRole("button", {name: "Send answer"}));
  expect(answer).toHaveBeenCalledWith({outcome: "accept", content: {remember: false}});
});
