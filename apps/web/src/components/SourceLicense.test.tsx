import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {SourceLicense} from "./SourceLicense";

const id = "a".repeat(64);
const digest = "b".repeat(64);
const source = {commit: "c".repeat(40), sha256: digest, dirty: false};
const metadata = {schema: 1, shellId: id, shellSha256: digest,
  archive: {path: `/sources/${digest}.tar.gz`, sha256: digest, bytes: 1000},
  license: {path: `/sources/${digest}.license.txt`, sha256: digest, spdx: "AGPL-3.0-or-later"},
  notices: {path: `/sources/${digest}.notices.txt`, sha256: digest},
  native: {version: "1.2.3", commit: source.commit}, sources: {portable: source, libs: source}};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {this.setAttribute("open", "");};
  HTMLDialogElement.prototype.close = function () {this.removeAttribute("open");};
  document.head.insertAdjacentHTML("beforeend", `<meta name="grok-shell-build" content="${id}">`);
});
afterEach(() => {vi.unstubAllGlobals(); document.head.querySelectorAll('meta[name="grok-shell-build"]').forEach(node => node.remove());});

it("loads only when opened, provides source and licenses, and restores focus after keyboard dismissal", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(metadata), {headers: {"content-type": "application/json"}}));
  vi.stubGlobal("fetch", fetch);
  render(<SourceLicense />);
  const trigger = screen.getByRole("button", {name: "Source and license"});
  expect(fetch).not.toHaveBeenCalled();
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  const link = await screen.findByRole("link", {name: /Download corresponding source/});
  expect(link).toHaveAttribute("href", metadata.archive.path);
  expect(screen.getByRole("link", {name: "Read license"})).toHaveAttribute("href", metadata.license.path);
  expect(screen.getByRole("link", {name: "Third-party notices"})).toHaveAttribute("href", metadata.notices.path);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", {cancelable: true}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("shows unavailable without source links for a review build, missing metadata or an old version", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({...metadata, shellId: digest}), {headers: {"content-type": "application/json"}})));
  render(<SourceLicense />);
  await userEvent.click(screen.getByRole("button", {name: "Source and license"}));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("unavailable for this app version"));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", {name: "Close source and license"}));
  document.head.querySelector('meta[name="grok-shell-build"]')?.remove();
  await userEvent.click(screen.getByRole("button", {name: "Source and license"}));
  expect(screen.getByRole("status")).toHaveTextContent("unavailable for this local build");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("cancels pending metadata when the dialog closes and does not render a late response", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((_path, options: RequestInit) => {signal = options.signal as AbortSignal; return new Promise<Response>(resolve => {finish = resolve;});}));
  render(<SourceLicense />);
  await userEvent.click(screen.getByRole("button", {name: "Source and license"}));
  expect(screen.getByRole("status")).toHaveTextContent("Checking");
  await userEvent.click(screen.getByRole("button", {name: "Close source and license"}));
  expect(signal?.aborted).toBe(true);
  finish(new Response(JSON.stringify(metadata), {headers: {"content-type": "application/json"}}));
  await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument());
});
