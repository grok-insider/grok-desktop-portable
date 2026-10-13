import {act, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {beforeEach, expect, it, vi} from "vitest";
import {OfflineHistory} from "./OfflineHistory";
import {OfflineHistoryStore} from "../services/offlineHistory";
import {EMPTY_PROJECTION} from "../services/sessionProjection";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
});

it("opens saved content without a connection and deletes it without resuming or sending a prompt", async () => {
  const store = new OfflineHistoryStore("a");
  await store.enable();
  await store.save("s", {...EMPTY_PROJECTION, transcript: [{id: "u", role: "user", text: "A saved question", seq: 1}, {id: "a", role: "agent", text: "A saved answer", seq: 2, unavailableImages: 1}]}, (await store.load()).epoch);
  const request = vi.spyOn(globalThis, "fetch");
  render(<OfflineHistory scope="a" />);
  await userEvent.click(screen.getByRole("button", {name: "Offline history"}));
  await userEvent.click(await screen.findByRole("button", {name: "A saved question"}));
  expect(screen.getByText("A saved answer")).toBeInTheDocument();
  expect(screen.getByText("1 image unavailable in this offline copy.")).toBeInTheDocument();
  expect(screen.queryByRole("button", {name: /Send|Resume|Reopen/})).toBeNull();
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Delete this saved conversation"}));
  await waitFor(() => expect(screen.queryByText("A saved answer")).toBeNull());
  expect((await store.load()).conversations).toEqual([]);
  request.mockRestore();
});

it("updates an open viewer immediately when another tab revokes storage", async () => {
  const store = new OfflineHistoryStore("a");
  await store.enable(); await store.save("s", {...EMPTY_PROJECTION, transcript: [{id: "m", role: "user", text: "private copy", seq: 1}]}, (await store.load()).epoch);
  render(<OfflineHistory scope="a" />);
  await userEvent.click(screen.getByRole("button", {name: "Offline history"}));
  await userEvent.click(await screen.findByRole("button", {name: "private copy"}));
  await act(async () => {await store.disable();});
  expect(screen.queryByText("private copy")).toBeNull();
  expect(screen.getByRole("button", {name: "Save history on this device"})).toBeInTheDocument();
});
