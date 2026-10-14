import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareInbox } from "./ShareInbox";
import * as inbox from "../services/shareInboxStore.js";

vi.mock("../services/shareInboxStore.js", () => ({readShareInbox: vi.fn(), claimShare: vi.fn(), removeShare: vi.fn(), recoverShare: vi.fn()}));
const entry = {id: "id", createdAt: 1, digest: "digest", state: "pending" as const, content: {title: "Title", text: "review me", url: "https://example.com", files: []}};
beforeEach(() => {vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "share-target"); vi.mocked(inbox.readShareInbox).mockResolvedValue([entry]); vi.mocked(inbox.claimShare).mockResolvedValue("claim"); vi.mocked(inbox.removeShare).mockResolvedValue();});
afterEach(() => {vi.clearAllMocks(); vi.unstubAllEnvs(); history.replaceState(null, "", "/");});

describe("share inbox experiment", () => {
  it("does not read local content when the experiment is disabled", () => {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", ""); render(<ShareInbox />);
    expect(inbox.readShareInbox).not.toHaveBeenCalled();
  });
  it("allows review while signed out and requires a selected target before insertion", async () => {
    render(<ShareInbox />);
    expect(await screen.findByLabelText("Shared text")).toHaveValue("Title\n\nreview me\n\nhttps://example.com");
    expect(screen.getByRole("button", {name: /Add to/})).toBeDisabled();
    expect(inbox.claimShare).not.toHaveBeenCalled();
  });
  it("preserves unrelated pairing fragments", async () => {
    history.replaceState(null, "", "/#share=token&pair=nonce"); render(<ShareInbox />);
    await screen.findByLabelText("Shared text");
    expect(location.hash).toBe("#pair=nonce");
  });
  it("preflights before claim and preserves rejected content", async () => {
    const append = vi.fn();
    render(<ShareInbox targetId="host/session" canAppend={() => false} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", {name: /Add to/}));
    await screen.findByText(/would exceed the command limit/);
    expect(inbox.claimShare).not.toHaveBeenCalled();
    expect(inbox.removeShare).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
  it("adds reviewed text only after explicit click and a successful atomic claim", async () => {
    const append = vi.fn(() => true);
    render(<ShareInbox targetId="host/session" canAppend={() => true} onAppend={append} />);
    const input = await screen.findByLabelText("Shared text");
    expect(append).not.toHaveBeenCalled();
    fireEvent.change(input, {target: {value: "edited"}});
    fireEvent.click(screen.getByRole("button", {name: /Add to/}));
    await waitFor(() => expect(inbox.removeShare).toHaveBeenCalledWith("id", "claim"));
    expect(append).toHaveBeenCalledExactlyOnceWith("edited", []);
  });
  it("does not paste into a changed destination while claiming", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(inbox.claimShare).mockImplementationOnce(() => new Promise((done) => {resolve = done;}));
    const append = vi.fn(() => true);
    const view = render(<ShareInbox targetId="host/one" canAppend={() => true} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", {name: /Add to/}));
    await waitFor(() => expect(inbox.claimShare).toHaveBeenCalled());
    view.rerender(<ShareInbox targetId="host/two" canAppend={() => true} onAppend={append} />);
    await act(async () => resolve("claim"));
    expect(append).not.toHaveBeenCalled();
    expect(inbox.removeShare).not.toHaveBeenCalled();
  });
  it("does not insert after leaving and returning to the same destination during a claim", async () => {
    let resolve!: (value: string) => void;
    vi.mocked(inbox.claimShare).mockImplementationOnce(() => new Promise((done) => {resolve = done;}));
    const append = vi.fn(() => true);
    const view = render(<ShareInbox targetId="host/one" canAppend={() => true} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", {name: /Add to/}));
    await waitFor(() => expect(inbox.claimShare).toHaveBeenCalled());
    view.rerender(<ShareInbox targetId="host/two" canAppend={() => true} onAppend={append} />);
    view.rerender(<ShareInbox targetId="host/one" canAppend={() => true} onAppend={append} />);
    await act(async () => resolve("claim"));
    expect(append).not.toHaveBeenCalled();
    expect(inbox.removeShare).not.toHaveBeenCalled();
    expect(inbox.readShareInbox).toHaveBeenCalledTimes(2);
  });
  it("requires recovery and a separate add action for an interrupted transfer", async () => {
    vi.mocked(inbox.readShareInbox).mockResolvedValue([{...entry, state: "claimed", claimId: "earlier-claim"}]);
    const append = vi.fn(() => true);
    render(<ShareInbox targetId="host/session" canAppend={() => true} onAppend={append} />);
    expect(await screen.findByText(/Check the destination draft for duplicates/)).toBeVisible();
    expect(screen.queryByRole("button", {name: /Add to/})).not.toBeInTheDocument();
    vi.mocked(inbox.readShareInbox).mockResolvedValue([entry]);
    fireEvent.click(screen.getByRole("button", {name: "Review again"}));
    await screen.findByRole("button", {name: /Add to/});
    expect(inbox.recoverShare).toHaveBeenCalledExactlyOnceWith("id", "earlier-claim");
    expect(append).not.toHaveBeenCalled();
    expect(inbox.claimShare).not.toHaveBeenCalled();
  });
  it("discards without appending or claiming", async () => {
    const append = vi.fn(() => true);
    render(<ShareInbox targetId="host/session" canAppend={() => true} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", {name: "Discard shared item"}));
    await waitFor(() => expect(inbox.removeShare).toHaveBeenCalledExactlyOnceWith("id"));
    expect(append).not.toHaveBeenCalled();
    expect(inbox.claimShare).not.toHaveBeenCalled();
  });
  it("retains a claimed item after draft insertion if cleanup fails", async () => {
    vi.mocked(inbox.removeShare).mockRejectedValueOnce(new Error("share_storage_unavailable"));
    const append = vi.fn(() => true);
    render(<ShareInbox targetId="host/session" canAppend={() => true} onAppend={append} />);
    fireEvent.click(await screen.findByRole("button", {name: /Add to/}));
    vi.mocked(inbox.readShareInbox).mockResolvedValue([{...entry, state: "claimed", claimId: "claim"}]);
    expect(await screen.findByRole("button", {name: "Review again"})).toBeVisible();
    expect(append).toHaveBeenCalledOnce();
    expect(inbox.recoverShare).not.toHaveBeenCalled();
  });
});
