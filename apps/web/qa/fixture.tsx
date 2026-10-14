import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { ApplicationLayout } from "../src/components/ApplicationLayout";
import { LandingView } from "../src/views/LandingView";
import { SetupView } from "../src/views/SetupView";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { LightClient, type EventHandlers, type HostTransport } from "../src/services/client";
import type { EventEnvelope } from "../src/services/protocol";
import { readGrant, writeGrant, deleteGrant } from "../src/services/remoteDevice";
import { forgetDraftScope, managedDraftScope } from "../src/services/drafts";
import { enqueueSharedContent, readShareInbox } from "../src/services/shareInboxStore.js";
import type { ControlTransferRequest } from "../src/services/remoteControls";
import "../src/styles/layers.css";
import "@fabrials/ui/tokens.css";
import "../src/styles/fonts.css";
import "@fabrials/ui/styles.css";
import "@fabrials/ai-ui/styles.css";
import "sonner/dist/styles.css";
import "../src/styles.css";

history.pushState = () => {};
history.replaceState = () => {};
let handlers: EventHandlers | undefined;
let sequence = 1;
let online = true;
let observer = false;
let epoch = 1;
let pendingControl: ControlTransferRequest[] = [];
let otherBrowser = true;
let refusedFolder = false;
const draftScope = managedDraftScope("qa-account", {id:"qa-host",publicKey:"synthetic-key",installationId:"qa-installation"});
const commands: unknown[] = [];
const registration = Object.assign(new EventTarget(), {waiting: null as object | null, installing: null as (EventTarget & {state: string}) | null});
const serviceWorker = Object.assign(new EventTarget(), {controller: {}, register: async () => registration});
if (!(window as unknown as {remoteQaRealServiceWorker?: boolean}).remoteQaRealServiceWorker) Object.defineProperty(navigator, "serviceWorker", {value: serviceWorker, configurable: true});
const session = {sessionId: "synthetic-session", workspaceId: "synthetic-project", workspaceName: "Example project", running: false, openedAtMs: 1};
const transport: HostTransport = {
  async request(path, init) {
    if (!online) throw new Error("offline");
    if (path === "/session") return Response.json({sessionId: "fixture-browser", sessionToken: "synthetic", csrfToken: "synthetic", protocolVersion: 2});
    const command = JSON.parse(String(init?.body));
    commands.push(command);
    let result: unknown = {outcome: "ok"};
    if (["bootstrap", "listWorkspaces"].includes(command.operation.kind)) result = {outcome: "workspaces", workspaces: [{id: session.workspaceId, displayName: session.workspaceName, available: true}], openSessions: [session], pendingReviews: []};
    const operation = command.operation;
    if (operation.kind === "getRemoteCapabilities") result = {outcome:"remoteCapabilities",projects:true,controlTransfer:true,devicePanel:true,upstreamPrompt:null};
    if (operation.kind === "listRemoteProjects") result = {outcome:"remoteProjects",parentId:operation.directoryId ?? null,nextCursor:null,entries:operation.directoryId ? [] : [{directoryId:"opaque-root",label:"QA approved root"}]};
    if (operation.kind === "enrollRemoteProject") {
      if (observer) return Response.json({error:"controller_required"}, {status:403});
      if (refusedFolder) return Response.json({error:"remote_directory_changed"}, {status:409});
      result = {outcome:"workspaces",workspaces:[{id:session.workspaceId,displayName:session.workspaceName,available:true},{id:"enrolled-project",displayName:"QA approved root",available:true}],openSessions:[session],pendingReviews:[]};
    }
    if (operation.kind === "listBrowserDevices") result = {outcome:"browserDevices",devices:[{sessionId:"fixture-browser",currentBrowser:true,currentController:!observer,connected:true,connectionCount:1,lastSeen:null},...(otherBrowser ? [{sessionId:"fixture-other",currentBrowser:false,currentController:observer,connected:true,connectionCount:1,lastSeen:null}] : [])],controlTransferRequests:pendingControl};
    if (operation.kind === "requestControlTransfer") {
      const request = {requestId:crypto.randomUUID(),sessionId:"fixture-browser",expiresAt:Date.now()+120000};
      pendingControl = [request];
      result = {outcome:"controlTransferRequested",request};
    }
    if (operation.kind === "cancelControlTransfer") pendingControl = pendingControl.filter(request => request.requestId !== operation.requestId);
    if (operation.kind === "approveControlTransfer") {observer=true;pendingControl=[];emit({kind:"hostStatus",state:"watching"});}
    if (operation.kind === "revokeBrowserPairing") {if (observer) return Response.json({error:"controller_required"}, {status:403});otherBrowser=false;}
    if (command.operation.kind === "listSessions") result = {outcome: "sessions", sessions: []};
    if (command.operation.kind === "diagnoseSession") result = {outcome: "sessionDiagnosis", diagnosis: {sessionId: session.sessionId, status: "healthy"}};
    return Response.json({result});
  },
  openEvents(next) {
    handlers = next;
    queueMicrotask(() => {
      if (!online) {next.onClose(); return;}
      next.onOpen();
      emit({kind: "hostStatus", state: observer ? "watching" : `controlling:${epoch}`});
      emit({kind: "sessionSnapshot", sessionId: session.sessionId, messages: [{role: "user", text: "Review this example project"}, {role: "agent", text: "The project is ready for review. Your terminal and this device show the same conversation."}]});
    });
    return {close() {if (handlers === next) handlers = undefined;}, send() {}};
  },
};

function emit(event: EventEnvelope["event"]) {handlers?.onEvent({protocolVersion: 2, eventSequence: sequence++, event});}

Object.assign(window, {remoteQa: {
  emit,
  commands,
  grants: {readGrant, writeGrant, deleteGrant},
  draftScope,
  shareInbox: {readShareInbox},
  async share(text: string) {const id = await enqueueSharedContent({title:"",text,url:"",files:[]});window.dispatchEvent(new HashChangeEvent("hashchange"));return id;},
  folderRefused(value: boolean) {refusedFolder=value;},
  otherRequestsControl() {pendingControl=[{requestId:crypto.randomUUID(),sessionId:"fixture-other",expiresAt:Date.now()+120000}];emit({kind:"remoteDevicesChanged"});},
  invalidateDevices() {emit({kind:"remoteDevicesChanged"});},
  offerInstall() {window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", {cancelable: true}), {prompt: async () => {}, userChoice: Promise.resolve({outcome: "dismissed"})}));},
  offerUpdate() {
    const worker = Object.assign(new EventTarget(), {state: "installing", postMessage: (message: unknown) => commands.push({workerMessage: message})});
    registration.installing = worker;
    registration.waiting = worker;
    registration.dispatchEvent(new Event("updatefound"));
    worker.state = "installed";
    worker.dispatchEvent(new Event("statechange"));
  },
  view(mode: "session" | "landing" | "setup" | "remote-error") {renderFixture(mode);},
  offline() {online = false; handlers?.onClose();},
  online() {online = true; window.dispatchEvent(new Event("online"));},
  watching(value: boolean) {observer = value; emit({kind: "hostStatus", state: value ? "watching" : `controlling:${++epoch}`});},
  permission(id = "permission-1") {emit({kind: "permissionRequest", sessionId: session.sessionId, requestId: id, options: ["reject-once", "allow-once"], title: "Run the example checks?", description: "This synthetic request runs the project's checks and does not publish anything.\n".repeat(8)});},
  question(id = "question-1") {emit({kind: "interactionRequest", sessionId: session.sessionId, requestId: id, interactionKind: "question", details: {questions: [{question: "Where should the example run?", options: [{label: "Preview", description: "Use the local preview"}, {label: "Staging", description: "Use the test service"}]}]}});},
}});

const root = createRoot(document.getElementById("root")!);
const sessionClient = new LightClient({transport, storageKey:"qa-synthetic-browser"});
const errorClient = new LightClient({transport:{...transport,request:async () => Response.json({error:"not_paired"},{status:401})}});
const revokeOwn = async () => {
  const result = await sessionClient.revokePairing();
  if (!result.ok) throw new Error("synthetic_revocation_failed");
  await forgetDraftScope(draftScope);
  await sessionClient.forgetPairing();
  root.render(<ThemeProvider><ApplicationLayout><main><h1>Your computers</h1><p>Synthetic own-browser removal completed.</p></main></ApplicationLayout></ThemeProvider>);
};
function renderFixture(mode: "session" | "landing" | "setup" | "remote-error" = "session") {
  const content = mode === "landing" ? <LandingView probe={{kind: "bridge_missing"}} onRetry={() => {}} />
    : mode === "setup" ? <SetupView mode={{kind: "unsupported_browser", reason: "This browser cannot establish the secure connection."}} />
    : mode === "remote-error" ? <App client={errorClient} />
    : <div className="remote-connected"><div className="remote-host-bar"><button type="button">Computers</button><span className="min-w-0 flex-1 truncate">Synthetic computer with a deliberately long name</span><button type="button">Forget this browser</button></div><App client={sessionClient} draftScope={draftScope} onRevokeOwn={revokeOwn} /></div>;
  root.render(<ThemeProvider><ApplicationLayout>{content}</ApplicationLayout></ThemeProvider>);
}
renderFixture();
