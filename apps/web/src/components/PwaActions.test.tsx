import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PwaActions } from "./PwaActions";
import { registerShellWorker } from "../services/pwa";

vi.mock("../services/pwa", () => ({registerShellWorker: vi.fn(), shellWorkerMessage: vi.fn(async () => ({}))}));
let offerUpdate: (registration: ServiceWorkerRegistration) => void;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(registerShellWorker).mockImplementation(async (callback) => {offerUpdate = callback;});
});
afterEach(() => vi.unstubAllGlobals());

it("offers installation again after Later and reports an installation failure", async () => {
  render(<PwaActions />);
  const offer = () => Object.assign(new Event("beforeinstallprompt", {cancelable: true}), {prompt: vi.fn(async () => {throw new Error("unavailable");}), userChoice: Promise.resolve({outcome: "dismissed"})});
  act(() => {window.dispatchEvent(offer());});
  await userEvent.click(screen.getByRole("button", {name: "Later"}));
  expect(screen.queryByRole("button", {name: "Install app"})).toBeNull();
  act(() => {window.dispatchEvent(offer());});
  await userEvent.click(screen.getByRole("button", {name: "Install app"}));
  expect(await screen.findByRole("status")).toHaveTextContent("Installation could not start");
  expect(screen.getByRole("button", {name: "Install app"})).toBeEnabled();
});

it("activates an update only on explicit request and cleans up the reload listener", async () => {
  const serviceWorker = new EventTarget();
  const add = vi.spyOn(serviceWorker, "addEventListener");
  const remove = vi.spyOn(serviceWorker, "removeEventListener");
  vi.stubGlobal("navigator", {serviceWorker});
  const postMessage = vi.fn();
  const {unmount} = render(<PwaActions />);
  act(() => offerUpdate({waiting: {postMessage}} as unknown as ServiceWorkerRegistration));
  expect(postMessage).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Update and reload"}));
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({kind: "activateUpdate"});
  expect(screen.getByRole("button", {name: "Update and reload"})).toBeDisabled();
  unmount();
  expect(remove).toHaveBeenCalledWith("controllerchange", add.mock.calls[0][1]);
});

it("does not wait forever for an update another tab already activated", async () => {
  const {unmount} = render(<PwaActions />);
  act(() => offerUpdate({waiting: null} as ServiceWorkerRegistration));
  await userEvent.click(screen.getByRole("button", {name: "Update and reload"}));
  await waitFor(() => expect(screen.queryByRole("button", {name: "Update and reload"})).toBeNull());
  unmount();
  act(() => offerUpdate({waiting: {}} as ServiceWorkerRegistration));
  expect(screen.queryByRole("complementary")).toBeNull();
});
