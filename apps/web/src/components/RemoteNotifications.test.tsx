import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteNotifications } from "./RemoteNotifications";
import { remoteAccount } from "../services/remoteAccount";
import { workerSupportsPush } from "../services/pushNotifications";
import type { LightClient } from "../services/client";
import type { Operation } from "../services/protocol";

vi.mock("../services/remoteAccount", () => ({remoteAccount:vi.fn()}));
vi.mock("../services/pushNotifications", async original => ({...await original<typeof import("../services/pushNotifications")>(),workerSupportsPush:vi.fn(async()=>true)}));
const key = new Uint8Array(65);key[0]=4;
const encodedKey = btoa(String.fromCharCode(...key)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
let active = false;
let registered = false;
let subscription:object | null = null;
const permission = {permission:"default",requestPermission:vi.fn(async()=>{permission.permission="granted";return "granted";})};
const browserSubscription = {endpoint:"https://push.example/one",options:{applicationServerKey:key.buffer},toJSON:()=>({endpoint:"https://push.example/one",keys:{p256dh:"synthetic-public-key",auth:"synthetic-auth"}}),unsubscribe:vi.fn()};
const subscribe = vi.fn(async()=>{subscription=browserSubscription;return browserSubscription;});
const expiresAt = () => Date.now()+30*86400000;
const registrations = () => [{id:"registration",endpoint:browserSubscription.endpoint,active,expiresAt:expiresAt(),generation:1}];
const host = () => ({outcome:"notificationStatus",enabled:true,registrations:active ? [{id:"registration",expiresAt:expiresAt(),generation:1}] : []});
function setup() {
  const send=vi.fn<LightClient["send"]>(async(operation:Operation)=>{
    if(operation.kind === "configureNotifications") {active=true;return {ok:true,value:{outcome:"notificationsConfigured",id:"registration",generation:1,expiresAt:expiresAt(),active:true}};}
    if(operation.kind === "disableNotifications") {active=false;return {ok:true,value:{outcome:"acknowledged"}};}
    return {ok:true,value:host()};
  });
  return {send,props:{client:{send} as unknown as LightClient,hostId:"host",scopeKey:"account-host-install",connectionVersion:1,connected:true,capable:true}};
}
beforeEach(()=>{
  active=false;registered=false;subscription=null;permission.permission="default";
  vi.clearAllMocks();vi.stubEnv("VITE_REMOTE_EXPERIMENTS","push");
  vi.mocked(workerSupportsPush).mockResolvedValue(true);
  vi.stubGlobal("Notification",permission);vi.stubGlobal("PushManager",class {});
  vi.stubGlobal("navigator",{serviceWorker:{controller:{},getRegistration:async()=>({pushManager:{getSubscription:async()=>subscription,subscribe}})}});
  vi.mocked(remoteAccount).mockImplementation(async(path,init)=>{
    if(path === "/push/config") return {enabled:true,applicationServerKey:encodedKey};
    if(init?.method === "POST") {registered=true;return {id:"registration",bindingToken:"synthetic-binding-token",generation:1,expiresAt:Date.now()+120000};}
    if(init?.method === "DELETE") {registered=false;active=false;return {ok:true};}
    return {subscriptions:subscription && (registered || active) ? registrations() : []};
  });
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
const enable = () => screen.getByRole("button",{name:"Enable notifications for this computer"});

it.each(["flag","capability","managed-host"])("does not read or prompt without %s", async gate=>{
  const {props,send}=setup();
  if(gate === "flag")vi.stubEnv("VITE_REMOTE_EXPERIMENTS","");
  render(<RemoteNotifications {...props} capable={gate !== "capability"} hostId={gate === "managed-host" ? undefined : props.hostId} />);
  await act(async()=>{});
  expect(remoteAccount).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(permission.requestPermission).not.toHaveBeenCalled();
});

it.each(["default", "denied"])("does not query a browser subscription while permission is %s", async state => {
  permission.permission = state;
  const getSubscription = vi.fn(async () => null);
  vi.stubGlobal("navigator", {serviceWorker: {controller: {}, getRegistration: async () => ({pushManager: {getSubscription, subscribe}})}});
  render(<RemoteNotifications {...setup().props} />);
  await waitFor(() => expect(screen.getByRole("button", {name: "Refresh notification status"})).toBeEnabled());
  expect(getSubscription).not.toHaveBeenCalled();
  expect(permission.requestPermission).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});

it("registers only after a gesture and confirms both account and host binding",async()=>{
  const {props,send}=setup();render(<RemoteNotifications {...props} />);
  await waitFor(()=>expect(enable()).toBeEnabled());
  expect(permission.requestPermission).not.toHaveBeenCalled();expect(subscribe).not.toHaveBeenCalled();
  fireEvent.click(enable());
  await screen.findByText("Configured for this computer.");
  expect(permission.requestPermission).toHaveBeenCalledOnce();expect(subscribe).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({kind:"configureNotifications",id:"registration",bindingToken:"synthetic-binding-token",generation:1},{idempotencyKey:expect.any(String)});
  expect(vi.mocked(remoteAccount).mock.calls.filter(([,init])=>init?.method === "POST")).toHaveLength(1);
  expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument();
});

it("keeps old workers disabled without requesting permission",async()=>{
  vi.mocked(workerSupportsPush).mockResolvedValue(false);
  render(<RemoteNotifications {...setup().props} />);
  await screen.findByText("Update and reload the app before enabling notifications.");
  expect(enable()).toBeDisabled();expect(permission.requestPermission).not.toHaveBeenCalled();
});

it("keeps a disabled account service from prompting",async()=>{
  const original=vi.mocked(remoteAccount).getMockImplementation()!;
  vi.mocked(remoteAccount).mockImplementation((path,init)=>path === "/push/config" ? Promise.resolve({enabled:false}) : original(path,init));
  render(<RemoteNotifications {...setup().props} />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Refresh notification status"})).toBeEnabled());
  expect(enable()).toBeDisabled();expect(permission.requestPermission).not.toHaveBeenCalled();expect(subscribe).not.toHaveBeenCalled();
  expect(screen.getByText("Notifications are disabled at the account service.")).toBeInTheDocument();
  expect(remoteAccount).toHaveBeenCalledTimes(1);
});

it("explains unavailable browser APIs without requesting permission",async()=>{
  vi.stubGlobal("Notification",undefined);
  render(<RemoteNotifications {...setup().props} />);
  await screen.findByText(/This browser does not support notifications here/);
  expect(enable()).toBeDisabled();expect(permission.requestPermission).not.toHaveBeenCalled();expect(subscribe).not.toHaveBeenCalled();
});

it("invalidates a previous confirmation when refreshed account status is unavailable",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  render(<RemoteNotifications {...setup().props} />);
  await screen.findByText("Configured for this computer.");
  vi.mocked(remoteAccount).mockRejectedValueOnce(new Error("signed out"));
  fireEvent.click(screen.getByRole("button",{name:"Refresh notification status"}));
  await screen.findByText("Notification status could not be read.");
  expect(screen.queryByText("Configured for this computer.")).not.toBeInTheDocument();
  expect(enable()).toBeDisabled();
});

it("subscribes during the enabling gesture when permission is already granted",async()=>{
  permission.permission="granted";
  render(<RemoteNotifications {...setup().props} />);
  await waitFor(()=>expect(enable()).toBeEnabled());
  fireEvent.click(enable());
  expect(subscribe).toHaveBeenCalledOnce();expect(permission.requestPermission).not.toHaveBeenCalled();
  await screen.findByText("Configured for this computer.");
});

it("handles permission denial without subscribing or binding",async()=>{
  permission.requestPermission.mockResolvedValueOnce("denied");
  const {props,send}=setup();render(<RemoteNotifications {...props} />);
  await waitFor(()=>expect(enable()).toBeEnabled());fireEvent.click(enable());
  await screen.findByText(/Notifications were not enabled/);
  expect(subscribe).not.toHaveBeenCalled();expect(send.mock.calls.some(([operation])=>operation.kind === "configureNotifications")).toBe(false);
});

it("treats a lost binding acknowledgement as uncertain without cleanup or automatic replay",async()=>{
  const {props,send}=setup();send.mockImplementation(async operation=> operation.kind === "configureNotifications" ? {ok:false,failure:{kind:"unreachable"}} : {ok:true,value:host()});
  render(<RemoteNotifications {...props} />);await waitFor(()=>expect(enable()).toBeEnabled());fireEvent.click(enable());
  await screen.findByText(/did not confirm its binding/);
  expect(send.mock.calls.filter(([operation])=>operation.kind === "configureNotifications")).toHaveLength(1);
  expect(vi.mocked(remoteAccount).mock.calls.some(([,init])=>init?.method === "DELETE")).toBe(false);
  expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();expect(screen.queryByText("Configured for this computer.")).not.toBeInTheDocument();
});

it.each([false,true])("ignores registration arriving after a scope change (ABA=%s)",async aba=>{
  let finish!:(value:unknown)=>void;
  const original=vi.mocked(remoteAccount).getMockImplementation()!;
  vi.mocked(remoteAccount).mockImplementation((path,init)=>init?.method === "POST" ? new Promise(resolve=>{finish=resolve;}) : original(path,init));
  const {props,send}=setup();const view=render(<RemoteNotifications {...props} />);
  await waitFor(()=>expect(enable()).toBeEnabled());fireEvent.click(enable());
  await waitFor(()=>expect(finish).toBeDefined());
  view.rerender(<RemoteNotifications {...props} scopeKey="other" hostId="other-host" />);
  if(aba)view.rerender(<RemoteNotifications {...props} />);
  await act(async()=>finish({id:"registration",bindingToken:"synthetic-binding-token",generation:1,expiresAt:Date.now()+120000}));
  expect(send.mock.calls.some(([operation])=>operation.kind === "configureNotifications")).toBe(false);
  expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();
});

it("disables this host without unsubscribing a browser endpoint shared by other hosts",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  const {props,send}=setup();render(<RemoteNotifications {...props} />);
  await screen.findByText("Configured for this computer.");
  fireEvent.click(screen.getByRole("button",{name:"Disable notifications for this computer"}));
  await screen.findByText("Notifications were disabled for this browser and computer.");
  expect(send).toHaveBeenCalledWith({kind:"disableNotifications"},{idempotencyKey:expect.any(String)});
  expect(remoteAccount).toHaveBeenCalledWith("/push/subscriptions/registration",expect.objectContaining({method:"DELETE"}));
  expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();
});

it("allows confirmed account removal after the host disconnects",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  const {props,send}=setup();const view=render(<RemoteNotifications {...props} />);
  await screen.findByText("Configured for this computer.");
  view.rerender(<RemoteNotifications {...props} connected={false} capable={undefined} />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Disable notifications for this computer"})).toBeEnabled());
  fireEvent.click(screen.getByRole("button",{name:"Disable notifications for this computer"}));
  await screen.findByText(/Account notifications were disabled/);
  expect(send.mock.calls.some(([operation])=>operation.kind === "disableNotifications")).toBe(false);
  expect(remoteAccount).toHaveBeenCalledWith("/push/subscriptions/registration",expect.objectContaining({method:"DELETE"}));
});

it("can remove a saved account registration when opened with the host already offline",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  const {props,send}=setup();render(<RemoteNotifications {...props} connected={false} capable={undefined} />);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Disable notifications for this computer"})).toBeEnabled());
  expect(enable()).toBeDisabled();expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Disable notifications for this computer"}));
  await screen.findByText(/Account notifications were disabled/);
  expect(send).not.toHaveBeenCalled();expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();
});

it("requires affirmative account removal instead of assuming any response succeeded",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  const original=vi.mocked(remoteAccount).getMockImplementation()!;
  vi.mocked(remoteAccount).mockImplementation((path,init)=>init?.method === "DELETE" ? Promise.resolve({ok:false}) : original(path,init));
  render(<RemoteNotifications {...setup().props} />);
  await screen.findByText("Configured for this computer.");
  fireEvent.click(screen.getByRole("button",{name:"Disable notifications for this computer"}));
  await screen.findByText("Removal was not fully confirmed. Refresh the status before trying again.");
  expect(screen.queryByText("Notifications were disabled for this browser and computer.")).not.toBeInTheDocument();
  expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();
});

it("does not announce removal if a concurrent tab has enabled notifications again",async()=>{
  active=true;subscription=browserSubscription;permission.permission="granted";
  const original=vi.mocked(remoteAccount).getMockImplementation()!;
  vi.mocked(remoteAccount).mockImplementation((path,init)=>{
    if(init?.method === "DELETE"){active=true;registered=true;return Promise.resolve({ok:true});}
    return original(path,init);
  });
  render(<RemoteNotifications {...setup().props} />);
  await screen.findByText("Configured for this computer.");
  fireEvent.click(screen.getByRole("button",{name:"Disable notifications for this computer"}));
  await screen.findByText("A notification registration remains or was enabled again. Refresh the status before trying again.");
  expect(screen.queryByText("Notifications were disabled for this browser and computer.")).not.toBeInTheDocument();
});

it("rejects mismatched subscription keys without exposing endpoint errors or unsubscribing",async()=>{
  permission.permission="granted";
  subscription={...browserSubscription,options:{applicationServerKey:new Uint8Array([4]).buffer}};
  render(<RemoteNotifications {...setup().props} />);await waitFor(()=>expect(enable()).toBeEnabled());fireEvent.click(enable());
  await screen.findByText(/another notification key/);
  expect(subscribe).not.toHaveBeenCalled();expect(browserSubscription.unsubscribe).not.toHaveBeenCalled();
});

it("does not claim configuration when this browser no longer has its subscription",async()=>{
  active=true;permission.permission="granted";
  const original=vi.mocked(remoteAccount).getMockImplementation()!;
  vi.mocked(remoteAccount).mockImplementation((path,init)=>path.startsWith("/push/subscriptions?") ? Promise.resolve({subscriptions:registrations()}) : original(path,init));
  render(<RemoteNotifications {...setup().props} />);
  await waitFor(()=>expect(enable()).toBeEnabled());
  expect(screen.queryByText("Configured for this computer.")).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Disable notifications for this computer"})).toBeEnabled();
});
