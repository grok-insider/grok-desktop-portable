import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PublicationAuthorization } from "./PublicationAuthorization";
import type { LightClient } from "../services/client";

it("never submits authorization to a different paired profile and clears its code after the intended host confirms", async () => {
  const callback = { code: "c".repeat(43), nonce: "n".repeat(43), profileId: "original-pairing", expiresAt: Date.now() + 300_000 };
  const send = vi.fn(async () => ({ok: true, value: {outcome: "publicationCommand", state: "completed", result: {outcome: "publicationAuthorized"}}}));
  const onComplete = vi.fn();
  const client = {send} as unknown as LightClient;
  const {rerender} = render(<PublicationAuthorization client={client} profileId="other-pairing" callback={callback} onComplete={onComplete} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
  rerender(<PublicationAuthorization client={client} profileId="original-pairing" callback={callback} onComplete={onComplete} />);
  await userEvent.click(screen.getByRole("button", {name: "Finish publication authorization"}));
  expect(send).toHaveBeenCalledWith({kind: "completePublicationAuthorization", code: "c".repeat(43), nonce: "n".repeat(43)}, {idempotencyKey: expect.any(String)});
  expect(callback.code).toBe("");
  expect(onComplete).toHaveBeenCalledOnce();
});

it("checks an ambiguous authorization receipt without replaying the one-time code", async () => {
  const callback = { code: "c".repeat(43), nonce: "n".repeat(43), profileId: "profile", expiresAt: Date.now() + 300_000 };
  const send = vi.fn().mockResolvedValueOnce({ok: true, value: {outcome: "publicationCommand", state: "running"}}).mockResolvedValueOnce({ok: true, value: {outcome: "publicationCommand", state: "completed", result: {outcome: "publicationAuthorized"}}});
  render(<PublicationAuthorization client={{send} as unknown as LightClient} profileId="profile" callback={callback} />);
  await userEvent.click(screen.getByRole("button", {name: "Finish publication authorization"}));
  await userEvent.click(await screen.findByRole("button", {name: "Check authorization status"}));
  expect(send.mock.calls.map(call => call[0].kind)).toEqual(["completePublicationAuthorization", "getPublicationCommandStatus"]);
  expect(callback.code).toBe("");
});

it("expires an unused callback without sending it to the host", async () => {
  const send = vi.fn();
  const callback = { code: "c".repeat(43), nonce: "n".repeat(43), profileId: "profile", expiresAt: Date.now() - 1 };
  render(<PublicationAuthorization client={{send} as unknown as LightClient} profileId="profile" callback={callback} />);
  await userEvent.click(screen.getByRole("button", {name: "Finish publication authorization"}));
  expect(screen.getByRole("alert")).toHaveTextContent("expired");
  expect(send).not.toHaveBeenCalled();
});
