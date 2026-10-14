import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, it, vi} from "vitest";
import {CommandReceiptNotice} from "./CommandReceiptNotice";
import type {CommandReceipts, PendingCommand} from "../services/commandReceipts";

const pending: PendingCommand = {sessionId: "s", key: "key", kind: "prompt", state: "uncertain", createdAt: 1};
const receipts = (): CommandReceipts => ({pending: [pending], storageFailed: false, submit: vi.fn(), check: vi.fn().mockResolvedValue({...pending, state: "queued"}), acknowledge: vi.fn().mockReturnValue(true)});

describe("uncertain action recovery", () => {
  it("checks only the receipt and requires explicit review before clearing a duplicate draft", async () => {
    const store = receipts();
    const clear = vi.fn();
    render(<CommandReceiptNotice receipts={store} sessionId="s" connected onClearDraft={clear} />);
    expect(screen.getByRole("button", {name: "Clear draft and continue"})).toBeDisabled();
    await userEvent.click(screen.getByRole("button", {name: "Check action status"}));
    expect(store.check).toHaveBeenCalledExactlyOnceWith("s");
    expect(store.submit).not.toHaveBeenCalled();
    expect(store.acknowledge).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", {name: "Clear draft and continue"}));
    expect(store.acknowledge).toHaveBeenCalledExactlyOnceWith("s", "key");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("can keep the draft after deliberate review without automatically sending it", async () => {
    const store = receipts();
    const clear = vi.fn();
    render(<CommandReceiptNotice receipts={store} sessionId="s" connected onClearDraft={clear} />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", {name: "Keep draft and continue"}));
    expect(clear).not.toHaveBeenCalled();
    expect(store.submit).not.toHaveBeenCalled();
    expect(store.acknowledge).toHaveBeenCalledExactlyOnceWith("s", "key");
  });

  it("does not let review clear a receipt while the command is being sent", () => {
    const store = {...receipts(), pending: [{...pending, state: "sending" as const}]};
    render(<CommandReceiptNotice receipts={store} sessionId="s" connected onClearDraft={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting");
  });

  it("cannot claim to clear a draft while its images are being processed", async () => {
    const store = receipts();
    const clear = vi.fn();
    render(<CommandReceiptNotice receipts={store} sessionId="s" connected clearDisabled onClearDraft={clear} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", {name: "Clear draft and continue"})).toBeDisabled();
    expect(clear).not.toHaveBeenCalled();
  });
});
