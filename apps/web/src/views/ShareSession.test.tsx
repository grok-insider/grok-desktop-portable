import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareSession } from "./ShareSession";
import type { LightClient } from "../services/client";
import { OptionalDialogsBlockedContext } from "../components/ComposerDialog";

const publication = {id: "public-id", sessionId: "session", phase: "active", expiresAt: Date.now() + 86400000, revision: 1};
const preview = {outcome: "publicationPreview", document: {title: "Review", entries: [{kind: "message", role: "user", text: "Reviewed text"}]}, availableImages: [], selectedImageHashes: [], previewDigest: "a".repeat(64), totalBytes: 150, totalEntries: 1};
const ok = (value: unknown) => ({ok: true, value});
const receipt = (result: unknown) => ok({outcome: "publicationCommand", state: "completed", result});
function mockClient(active = false, authorized = true) {
  let shared = active;
  const send = vi.fn(async (operation: {kind: string}) => {
    if (operation.kind === "getPublicationStatus") return ok({outcome: "publicationStatus", authorized, publications: shared ? [publication] : []});
    if (operation.kind === "previewPublication") return ok(preview);
    if (operation.kind === "createPublication") {shared = true; return receipt({outcome: "publicationCreated", ...publication});}
    if (operation.kind === "stopPublication") {shared = false; return receipt({outcome: "publicationStopped", accessRevoked: true, keysDestroyed: true, storageCleanup: "pending"});}
    return ok({});
  });
  return {send, client: {send} as unknown as LightClient};
}
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});

describe("public conversation controls", () => {
  it("requires the host preview and explicit consent and sends its digest without a document or credentials", async () => {
    const {client, send} = mockClient();
    render(<ShareSession client={client} hostId="profile" sessionId="session" />);
    await userEvent.click(screen.getByRole("button", {name: "Share conversation"}));
    expect(await screen.findByText("Reviewed text")).toBeInTheDocument();
    const publish = screen.getByRole("button", {name: "Publish and sync"});
    expect(publish).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(publish);
    await screen.findByRole("button", {name: "Stop sharing"});
    expect(send.mock.calls.find(call => call[0].kind === "createPublication")?.[0]).toEqual({kind: "createPublication", sessionId: "session", imageHashes: [], previewDigest: preview.previewDigest, publishFutureText: true});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("discards a late preview when a required interaction interrupts control", async () => {
    const {client, send} = mockClient();
    let resolvePreview: (value: ReturnType<typeof ok>) => void = () => {};
    send.mockImplementation(async operation => operation.kind === "previewPublication" ? await new Promise(resolve => {resolvePreview = resolve;}) as ReturnType<typeof ok> : ok({outcome: "publicationStatus", authorized: true, publications: []}));
    const view = (blocked: boolean) => <OptionalDialogsBlockedContext.Provider value={blocked}><ShareSession compact client={client} hostId="profile" sessionId="session" /></OptionalDialogsBlockedContext.Provider>;
    const {rerender} = render(view(false));
    await userEvent.click(screen.getByRole("button", {name: "Share conversation"}));
    rerender(view(true)); rerender(view(false));
    await act(async () => resolvePreview(ok(preview)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(send.mock.calls.some(call => call[0].kind === "createPublication")).toBe(false);
  });
  it("keeps observer management on the first-party account without requiring a host mutation", async () => {
    const {client, send} = mockClient(true);
    render(<ShareSession client={client} hostId="profile" sessionId="session" canPublish={false} />);
    await screen.findByRole("link", {name: "Public conversation"});
    expect(screen.queryByRole("button", {name: "Stop sharing"})).not.toBeInTheDocument();
    expect(screen.getByRole("link", {name: /Manage all links/})).toHaveAttribute("href", "https://fabrials.com/account/publications");
    expect(send.mock.calls.every(call => call[0].kind === "getPublicationStatus")).toBe(true);
  });
  it("reports pending encrypted-file cleanup separately from confirmed key destruction", async () => {
    const {client} = mockClient(true);
    render(<ShareSession client={client} hostId="profile" sessionId="session" />);
    await userEvent.click(await screen.findByRole("button", {name: "Stop sharing"}));
    expect(await screen.findByRole("status")).toHaveTextContent("Encrypted file cleanup is pending");
    expect(screen.queryByRole("link", {name: "Public conversation"})).not.toBeInTheDocument();
  });
  it("does not claim deletion without both server confirmations", async () => {
    const {client, send} = mockClient(true);
    send.mockImplementation(async operation => operation.kind === "getPublicationStatus" ? ok({outcome: "publicationStatus", authorized: true, publications: [publication]}) : receipt({outcome: "publicationStopped", accessRevoked: true, keysDestroyed: false}));
    render(<ShareSession client={client} hostId="profile" sessionId="session" />);
    await userEvent.click(await screen.findByRole("button", {name: "Stop sharing"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permanent deletion has not been confirmed");
    expect(screen.getByRole("link", {name: "Public conversation"})).toBeInTheDocument();
  });
  it("disables new writes after an ambiguous response and offers receipt checks", async () => {
    const {client, send} = mockClient(true);
    send.mockImplementation(async operation => operation.kind === "getPublicationStatus" ? ok({outcome: "publicationStatus", authorized: true, publications: [publication]}) : ok({outcome: "publicationCommand", state: "needsReview"}));
    render(<ShareSession client={client} hostId="profile" sessionId="session" />);
    await userEvent.click(await screen.findByRole("button", {name: "Stop sharing"}));
    await screen.findByRole("button", {name: "Check action status"});
    expect(screen.getByRole("button", {name: "Stop sharing"})).toBeDisabled();
    await userEvent.click(screen.getByRole("button", {name: "Check action status"}));
    await waitFor(() => expect(send.mock.calls.filter(call => call[0].kind === "getPublicationCommandStatus")).toHaveLength(1));
    expect(send.mock.calls.filter(call => call[0].kind === "stopPublication")).toHaveLength(1);
  });
  it("requires account authorization separately without publishing a conversation", async () => {
    const {client, send} = mockClient(false, false);
    render(<ShareSession client={client} hostId="profile" sessionId="session" />);
    await userEvent.click(screen.getByRole("button", {name: "Share conversation"}));
    expect(await screen.findByRole("button", {name: "Authorize computer"})).toBeEnabled();
    expect(screen.getByRole("button", {name: "Publish and sync"})).toBeDisabled();
    expect(send.mock.calls.some(call => call[0].kind === "createPublication")).toBe(false);
  });
});
