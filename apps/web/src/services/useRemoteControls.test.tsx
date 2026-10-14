import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRemoteControls } from "./useRemoteControls";
import type { LightClient } from "./client";
import { StrictMode } from "react";

const capabilities = {outcome:"remoteCapabilities",projects:true,devicePanel:true,controlTransfer:true};
const devices = {outcome:"browserDevices",devices:[{sessionId:"browser",currentBrowser:true,currentController:false,connected:true,connectionCount:2,lastSeen:null}],controlTransferRequests:[]};
const ok = (value: unknown) => ({ok:true as const,value});
function setup() {
  const send = vi.fn(async (operation: {kind:string}) => ok(operation.kind === "getRemoteCapabilities" ? capabilities : devices));
  const props = {client:{send} as unknown as LightClient,scopeKey:"one",connectionVersion:1,connected:true,canControl:false,onEnrolled:vi.fn(),onRevokeOwn:vi.fn(async () => {})};
  return {send,props};
}
afterEach(() => vi.unstubAllEnvs());

it("does not query optional host APIs in an ordinary build", () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "");
  const {send,props} = setup();
  const {result} = renderHook(() => useRemoteControls(props));
  act(() => {result.current.onRefreshDevices();result.current.onRequestControl();result.current.onBrowseProjects({});});
  expect(send).not.toHaveBeenCalled();
});

it("never treats another connection's request as its own browser request", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  send.mockImplementation(async operation => ok(operation.kind === "getRemoteCapabilities" ? capabilities : {...devices,controlTransferRequests:[{requestId:"other-tab",sessionId:"browser",expiresAt:Date.now()+30000}]}));
  const {result} = renderHook(() => useRemoteControls(props));
  await waitFor(() => expect(result.current.browserDevices?.controlTransferRequests).toHaveLength(1));
  expect(result.current.ownControlRequest).toBeUndefined();
  act(() => {result.current.onCancelControl("other-tab");result.current.onApproveControl("other-tab");});
  expect(send.mock.calls.some(([operation]) => ["cancelControlTransfer","approveControlTransfer"].includes(operation.kind))).toBe(false);
});

it("ignores a late control request after reconnect and does not replay it", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  let resolve: (result: ReturnType<typeof ok>) => void = () => {};
  send.mockImplementation(operation => operation.kind === "requestControlTransfer" ? new Promise(done => {resolve = done;}) : Promise.resolve(ok(operation.kind === "getRemoteCapabilities" ? capabilities : devices)));
  const view = renderHook(options => useRemoteControls(options), {initialProps:props});
  await waitFor(() => expect(view.result.current.capabilities?.controlTransfer).toBe(true));
  act(() => view.result.current.onRequestControl());
  expect(view.result.current.busy).toBe(true);
  view.rerender({...props,connectionVersion:2});
  await act(async () => resolve(ok({outcome:"controlTransferRequested",request:{requestId:"old",sessionId:"browser",expiresAt:Date.now()+30000}})));
  expect(view.result.current.ownControlRequest).toBeUndefined();
  expect(view.result.current.busy).toBe(false);
  expect(send.mock.calls.filter(([operation]) => operation.kind === "requestControlTransfer")).toHaveLength(1);
});

it("does not enroll twice after an uncertain disconnect", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects");
  const {send,props} = setup();
  let resolve: (result: ReturnType<typeof ok>) => void = () => {};
  send.mockImplementation(operation => operation.kind === "enrollRemoteProject" ? new Promise(done => {resolve = done;}) : Promise.resolve(ok(capabilities)));
  const controlled = {...props,canControl:true};
  const view = renderHook(options => useRemoteControls(options), {initialProps:controlled});
  await waitFor(() => expect(view.result.current.capabilities?.projects).toBe(true));
  act(() => view.result.current.onEnrollProject("opaque"));
  view.rerender({...controlled,connected:false});
  await act(async () => resolve(ok({outcome:"workspaces",workspaces:[]})));
  view.rerender({...controlled,connectionVersion:2});
  expect(props.onEnrolled).not.toHaveBeenCalled();
  expect(send.mock.calls.filter(([operation]) => operation.kind === "enrollRemoteProject")).toHaveLength(1);
  expect(send.mock.calls.some(([operation]) => operation.kind === "listBrowserDevices")).toBe(false);
});

it("clears its pending request when the host invalidates it during another transfer", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  const request = {requestId:"own-request",sessionId:"browser",expiresAt:Date.now()+30000};
  let pending: typeof request[] = [];
  send.mockImplementation(async operation => {
    if (operation.kind === "getRemoteCapabilities") return ok(capabilities);
    if (operation.kind === "requestControlTransfer") {pending=[request];return ok({outcome:"controlTransferRequested",request});}
    return ok({...devices,controlTransferRequests:pending});
  });
  const view = renderHook(() => useRemoteControls(props));
  await waitFor(() => expect(view.result.current.browserDevices).toBeDefined());
  act(() => view.result.current.onRequestControl());
  await waitFor(() => expect(view.result.current.ownControlRequest?.requestId).toBe("own-request"));
  pending=[];
  act(() => view.result.current.onRefreshDevices());
  await waitFor(() => expect(view.result.current.ownControlRequest).toBeUndefined());
  act(() => view.result.current.onRequestControl());
  await waitFor(() => expect(send.mock.calls.filter(([operation]) => operation.kind === "requestControlTransfer")).toHaveLength(2));
});

it.each([false,true])("ignores a late request after promotion, including a later demotion (%s)", async (demoteAgain) => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  let resolve: (value: ReturnType<typeof ok>) => void = () => {};
  let reads=0;
  send.mockImplementation(operation => {
    if (operation.kind === "getRemoteCapabilities") return Promise.resolve(ok(capabilities));
    if (operation.kind === "requestControlTransfer") return new Promise(done => {resolve=done;});
    return ++reads === 1 ? Promise.resolve(ok(devices)) : new Promise(() => {});
  });
  const view = renderHook(options => useRemoteControls(options), {initialProps:props});
  await waitFor(() => expect(view.result.current.browserDevices).toBeDefined());
  act(() => view.result.current.onRequestControl());
  view.rerender({...props,canControl:true});
  if (demoteAgain) view.rerender(props);
  await act(async () => resolve(ok({outcome:"controlTransferRequested",request:{requestId:"late",sessionId:"browser",expiresAt:Date.now()+30000}})));
  expect(view.result.current.ownControlRequest).toBeUndefined();
});

it("invalidates the first StrictMode effect before accepting the second effect's capabilities", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  const resolve: ((value: ReturnType<typeof ok>) => void)[] = [];
  send.mockImplementation(operation => operation.kind === "getRemoteCapabilities" ? new Promise(done => resolve.push(done)) : Promise.resolve(ok(devices)));
  const view = renderHook(() => useRemoteControls(props), {wrapper:StrictMode});
  await waitFor(() => expect(resolve).toHaveLength(2));
  await act(async () => resolve[1](ok({...capabilities,controlTransfer:false})));
  expect(view.result.current.capabilities?.controlTransfer).toBe(false);
  await act(async () => resolve[0](ok(capabilities)));
  expect(view.result.current.capabilities?.controlTransfer).toBe(false);
  expect(send.mock.calls.some(([operation]) => operation.kind === "listBrowserDevices")).toBe(false);
});

it("does not accept an old client's response when the scope string is unchanged", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "control-transfer");
  const {send,props} = setup();
  let resolve: (value: ReturnType<typeof ok>) => void = () => {};
  send.mockImplementation(() => new Promise(done => {resolve=done;}));
  const view = renderHook(options => useRemoteControls(options), {initialProps:props});
  const replacement = {send:vi.fn(async () => ok({...capabilities,controlTransfer:false}))} as unknown as LightClient;
  view.rerender({...props,client:replacement});
  await waitFor(() => expect(view.result.current.capabilities?.controlTransfer).toBe(false));
  await act(async () => resolve(ok(capabilities)));
  expect(view.result.current.capabilities?.controlTransfer).toBe(false);
});

it("does not call enrollment callbacks after unmount and remount", async () => {
  vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "remote-projects");
  const {send,props} = setup();
  let resolve: (value: ReturnType<typeof ok>) => void = () => {};
  send.mockImplementation(operation => operation.kind === "enrollRemoteProject" ? new Promise(done => {resolve=done;}) : Promise.resolve(ok(capabilities)));
  const options = {...props,canControl:true};
  const first = renderHook(() => useRemoteControls(options));
  await waitFor(() => expect(first.result.current.capabilities?.projects).toBe(true));
  act(() => first.result.current.onEnrollProject("folder"));
  first.unmount();
  const second = renderHook(() => useRemoteControls(options));
  await waitFor(() => expect(second.result.current.capabilities?.projects).toBe(true));
  await act(async () => resolve(ok({outcome:"workspaces",workspaces:[]})));
  expect(props.onEnrolled).not.toHaveBeenCalled();
  expect(second.result.current.busy).toBe(false);
});
