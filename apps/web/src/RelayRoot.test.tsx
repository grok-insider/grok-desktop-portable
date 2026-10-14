import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RelayRoot as RemoteRoot } from "./RelayRoot";
import { createRemoteTransport } from "./services/remoteConnector";
import { remoteAccount } from "./services/remoteAccount";
import { ThemeProvider } from "./theme/ThemeProvider";
import { LightClient, type HostTransport } from "./services/client";

vi.mock("./App", () => ({App: ({onRevokeOwn}: {onRevokeOwn?: () => Promise<void>}) => <div>Connected conversation<button onClick={() => {void onRevokeOwn?.().catch(() => {});}}>Remove from device panel</button></div>}));
vi.mock("./services/remoteConnector", () => ({createRemoteTransport: vi.fn()}));
vi.mock("./services/remoteAccount", async (original) => ({...await original<typeof import("./services/remoteAccount")>(), remoteAccount: vi.fn()}));
afterEach(() => {vi.clearAllMocks(); vi.restoreAllMocks(); history.replaceState(null, "", "/");});

it.each([false, true])("accepts an incoming QR link with an existing connection %s", async (connected) => {
  const pairing = {hostId: "host", secret: "a".repeat(64), hostPublicKey: "b".repeat(64)};
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: pairing.hostPublicKey, revoked: false}], shares: []});
  const dispose = vi.fn();
  const forgetPairing = vi.fn();
  vi.mocked(createRemoteTransport).mockResolvedValue({request: vi.fn(), openEvents: vi.fn(), dispose, forgetPairing});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  const connect = await screen.findByRole("button", {name: "Connect"});
  if (connected) await userEvent.click(connect);
  act(() => {
    history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  const pair = await screen.findByRole("button", {name: "Pair and connect"});
  await waitFor(() => expect(pair).toBeEnabled());
  expect(location.hash).toBe("");
  expect(dispose).toHaveBeenCalledTimes(connected ? 1 : 0);
  expect(forgetPairing).not.toHaveBeenCalled();
  await userEvent.click(pair);
  expect(createRemoteTransport).toHaveBeenLastCalledWith({hostId: "host", signal: expect.any(AbortSignal), pairing: {secret: pairing.secret, hostPublicKey: pairing.hostPublicKey}});
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
});

it.each(["success", "failure"])("ignores an old connection's late %s after a new pairing link", async (outcome) => {
  const pairing = {hostId: "host", secret: "c".repeat(64), hostPublicKey: "b".repeat(64)};
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: pairing.hostPublicKey, revoked: false}], shares: []});
  let finish: (transport: HostTransport) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  vi.mocked(createRemoteTransport).mockImplementationOnce(() => new Promise((resolve, reject) => {finish = resolve; fail = reject;}));
  vi.mocked(createRemoteTransport).mockResolvedValue({request: vi.fn(), openEvents: vi.fn()});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  const previousSignal = vi.mocked(createRemoteTransport).mock.calls[0]?.[0].signal;
  act(() => {
    history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(previousSignal?.aborted).toBe(true);
  const pair = await screen.findByRole("button", {name: "Pair and connect"});
  await waitFor(() => expect(pair).toBeEnabled());
  await userEvent.click(pair);
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
  const dispose = vi.fn();
  await act(async () => {
    if (outcome === "success") finish({request: vi.fn(), openEvents: vi.fn(), dispose});
    else fail(new Error("host_offline"));
  });
  expect(dispose).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
  expect(screen.getByText("Connected conversation")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each(["revocation", "storage"])("keeps a new pairing when the previous device's %s finishes late", async (stage) => {
  const pairing = {hostId: "host", secret: "d".repeat(64), hostPublicKey: "b".repeat(64)};
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: pairing.hostPublicKey, revoked: false}], shares: []});
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {finish = resolve;});
  vi.spyOn(LightClient.prototype, "revokePairing").mockImplementation(async () => {
    if (stage === "revocation") await pending;
    return {ok: true, value: {}};
  });
  const forgetPairing = vi.fn(() => stage === "storage" ? pending : Promise.resolve());
  vi.mocked(createRemoteTransport).mockResolvedValueOnce({request: vi.fn(), openEvents: vi.fn(), forgetPairing});
  vi.mocked(createRemoteTransport).mockResolvedValue({request: vi.fn(), openEvents: vi.fn()});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  await userEvent.click(await screen.findByRole("button", {name: "Forget this browser"}));
  act(() => {
    history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  const pair = await screen.findByRole("button", {name: "Pair and connect"});
  await waitFor(() => expect(pair).toBeEnabled());
  await userEvent.click(pair);
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
  await act(async () => finish());
  expect(forgetPairing).toHaveBeenCalledTimes(stage === "storage" ? 1 : 0);
  expect(screen.getByText("Connected conversation")).toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Forget this browser"})).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("consumes a successful QR grant once and resumes the existing device on the next connection", async () => {
  const pairing = {hostId: "host", secret: "a".repeat(64), hostPublicKey: "b".repeat(64)};
  history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: pairing.hostPublicKey, revoked: false}], shares: []});
  vi.mocked(createRemoteTransport).mockResolvedValue({request: vi.fn(), openEvents: vi.fn()});
  const user = userEvent.setup();
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await user.click(await screen.findByRole("button", {name: "Pair and connect"}));
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
  expect(location.hash).toBe("");
  await user.click(screen.getByRole("button", {name: "Computers"}));
  await user.click(await screen.findByRole("button", {name: "Connect"}));
  expect(vi.mocked(createRemoteTransport).mock.calls).toEqual([
    [{hostId: "host", signal: expect.any(AbortSignal), pairing: {secret: pairing.secret, hostPublicKey: pairing.hostPublicKey}}],
    [{hostId: "host", signal: expect.any(AbortSignal)}],
  ]);
});

it("disposes a connection that finishes after leaving the page", async () => {
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "a".repeat(64), revoked: false}], shares: []});
  let finish: (transport: HostTransport) => void = () => {};
  vi.mocked(createRemoteTransport).mockImplementation(() => new Promise((resolve) => {finish = resolve;}));
  const dispose = vi.fn();
  const {unmount} = render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  unmount();
  await act(async () => finish({request: vi.fn(), openEvents: vi.fn(), dispose}));
  expect(dispose).toHaveBeenCalledOnce();
});

it("closes the active transport when returning to computers without forgetting pairing", async () => {
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "a".repeat(64), revoked: false}], shares: []});
  const dispose = vi.fn();
  const forgetPairing = vi.fn();
  vi.mocked(createRemoteTransport).mockResolvedValue({request: vi.fn(), openEvents: vi.fn(), dispose, forgetPairing});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  await userEvent.click(await screen.findByRole("button", {name: "Computers"}));
  expect(dispose).toHaveBeenCalledOnce();
  expect(forgetPairing).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", {name: "Connect"})).toBeEnabled());
});

it("explains an identity mismatch before sending a pairing secret", async () => {
  const pairing = {hostId: "host", secret: "a".repeat(64), hostPublicKey: "b".repeat(64)};
  history.replaceState(null, "", `/#remotePair=${btoa(JSON.stringify(pairing))}`);
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "c".repeat(64), revoked: false}], shares: []});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Pair and connect"}));
  expect(await screen.findByRole("status")).toHaveTextContent("key has changed");
  expect(createRemoteTransport).not.toHaveBeenCalled();
});

it("does not claim the account has no computers when its listing failed", async () => {
  vi.mocked(remoteAccount).mockRejectedValue(new Error("Account service unavailable"));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  expect(await screen.findByText("Account service unavailable")).toBeInTheDocument();
  expect(screen.queryByText("Add your first computer")).toBeNull();
});

it("explains blocked device storage without opening an unpersisted connection", async () => {
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "a".repeat(64), revoked: false}], shares: []});
  vi.mocked(createRemoteTransport).mockRejectedValue(new Error("device_storage_unavailable"));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  expect(await screen.findByRole("status")).toHaveTextContent("Allow site storage in your browser settings");
  expect(screen.getByRole("button", {name: "Connect"})).toBeEnabled();
  expect(screen.queryByText("Connected conversation")).not.toBeInTheDocument();
  expect(createRemoteTransport).toHaveBeenCalledOnce();
});

it("opens first-party publication management without opening the offline computer or using publication cookies cross-site", async () => {
  vi.mocked(remoteAccount).mockImplementation(async path => {
    if (path === "/hosts") return {hosts: [{id: "host", label: "Offline computer", publicKey: "a".repeat(64), revoked: false}]};
    throw new Error("Unexpected account request");
  });
  vi.mocked(createRemoteTransport).mockRejectedValue(new Error("host_offline"));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  expect(await screen.findByRole("link", {name: "Manage public links on Fabrials"})).toHaveAttribute("href", "https://fabrials.com/account/publications");
  expect(remoteAccount).not.toHaveBeenCalledWith("/shares", expect.anything());
  expect(vi.mocked(remoteAccount).mock.calls.every(([path]) => path === "/hosts")).toBe(true);
  expect(createRemoteTransport).not.toHaveBeenCalled();
  expect(screen.queryByText("Connected conversation")).not.toBeInTheDocument();
});

it.each(["Forget this browser", "Remove from device panel"])("returns to the managed computer list after %s confirms own removal", async (action) => {
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "a".repeat(64), installationId: "installation", revoked: false}], shares: []});
  let finish: () => void = () => {};
  vi.spyOn(LightClient.prototype, "revokePairing").mockImplementation(async () => {
    await new Promise<void>(resolve => {finish = resolve;});
    return {ok:true,value:{}};
  });
  const forgetPairing = vi.fn(async () => {});
  vi.mocked(createRemoteTransport).mockResolvedValue({request:vi.fn(),openEvents:vi.fn(),forgetPairing});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name:"Connect"}));
  await userEvent.click(await screen.findByRole("button", {name:action}));
  expect(screen.getByRole("button", {name:"Computers"})).toBeDisabled();
  expect(screen.getByRole("button", {name:"Forget this browser"})).toBeDisabled();
  expect(forgetPairing).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(await screen.findByRole("heading", {name:"Your computers"})).toBeInTheDocument();
  expect(forgetPairing).toHaveBeenCalledOnce();
  expect(screen.queryByText("Connected conversation")).not.toBeInTheDocument();
});

it.each(["refused", "exception", "storage"])("keeps managed removal actionable after %s", async (failure) => {
  vi.mocked(remoteAccount).mockResolvedValue({hosts: [{id: "host", label: "Computer", publicKey: "a".repeat(64), installationId: "installation", revoked: false}], shares: []});
  vi.spyOn(LightClient.prototype, "revokePairing").mockImplementation(async () => {
    if (failure === "exception") throw new Error("offline");
    if (failure === "refused") return {ok:false,failure:{kind:"unreachable"}};
    return {ok:true,value:{}};
  });
  const forgetPairing = vi.fn(async () => {throw new Error("denied");});
  vi.mocked(createRemoteTransport).mockResolvedValue({request:vi.fn(),openEvents:vi.fn(),forgetPairing});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name:"Connect"}));
  await userEvent.click(await screen.findByRole("button", {name:"Remove from device panel"}));
  expect(await screen.findByRole("status")).toHaveTextContent(failure === "storage" ? "browser storage could not be cleared" : "did not confirm revocation");
  expect(forgetPairing).toHaveBeenCalledTimes(failure === "storage" ? 1 : 0);
  expect(screen.getByText("Connected conversation")).toBeInTheDocument();
  expect(screen.getByRole("button", {name:"Forget this browser"})).toBeEnabled();
});
