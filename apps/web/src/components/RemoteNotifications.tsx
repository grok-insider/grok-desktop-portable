import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import type { LightClient } from "../services/client";
import { remoteExperimentEnabled } from "../services/experiments";
import { remoteAccount } from "../services/remoteAccount";
import { PushSetupError, applicationServerKey, asNotificationStatus, asPushBinding, bindingConfirmed, notificationPermission, readPushAccount, workerSupportsPush, type HostNotificationStatus, type PushConfiguration, type PushRegistration } from "../services/pushNotifications";

interface Props {client:LightClient;hostId?:string;scopeKey:string;connectionVersion:number;connected:boolean;capable?:boolean}
interface State {busy:boolean;permission:NotificationPermission | "unsupported";configuration?:PushConfiguration;registrations:PushRegistration[];host?:HostNotificationStatus;subscription?:PushSubscription | null;worker?:ServiceWorkerRegistration;workerReady:boolean;notice?:string}

export function RemoteNotifications(props:Props) {
  const previous = useRef({scopeKey:props.scopeKey,hostId:props.hostId,client:props.client,known:false,epoch:0});
  if (previous.current.scopeKey !== props.scopeKey || previous.current.hostId !== props.hostId || previous.current.client !== props.client) previous.current = {scopeKey:props.scopeKey,hostId:props.hostId,client:props.client,known:false,epoch:previous.current.epoch+1};
  if (props.capable === true) previous.current.known = true;
  if (!remoteExperimentEnabled("push") || !props.hostId || !previous.current.known && props.connected) return null;
  return <NotificationControls key={JSON.stringify([props.scopeKey,props.connectionVersion,props.connected,previous.current.epoch])} {...props} hostId={props.hostId} />;
}

function NotificationControls({client,hostId,connected,capable}:Props & {hostId:string}) {
  const [state,setState] = useState<State>({busy:true,permission:notificationPermission(),registrations:[],workerReady:false});
  const lifetime = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const refresh = async (signal:AbortSignal, notice?:string) => {
    const permission = notificationPermission();
    const worker = permission === "unsupported" ? undefined : await navigator.serviceWorker.getRegistration("/");
    const workerReady = Boolean(worker && await workerSupportsPush(navigator.serviceWorker.controller,signal));
    const subscription = worker && permission === "granted" ? await worker.pushManager.getSubscription() : null;
    const account = await readPushAccount(hostId,signal);
    const result = connected ? await client.send({kind:"getNotificationStatus"}) : null;
    if (signal.aborted) return;
    const host = result?.ok ? asNotificationStatus(result.value) : undefined;
    const confirmed = permission === "granted" && host?.enabled === true && account.registrations.some(row => row.endpoint === subscription?.endpoint && row.active && row.expiresAt > Date.now() && host.registrations.some(binding => binding.id === row.id && binding.generation === row.generation && binding.expiresAt > Date.now()));
    setState({busy:false,permission,worker,workerReady,subscription,configuration:account.configuration,registrations:account.registrations,host,notice:notice ?? (permission === "unsupported" ? "This browser does not support notifications here. On iPhone, install the app before enabling notifications." : !account.configuration.enabled ? "Notifications are disabled at the account service." : !workerReady ? "Update and reload the app before enabling notifications." : host?.enabled === false ? "Notifications are disabled on this computer." : undefined)});
    return {confirmed,registrations:account.registrations,subscription,host};
  };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    busy.current = false;
    void refresh(controller.signal).catch(() => {if (!controller.signal.aborted) setState(previous => ({...previous,busy:false,notice:"Notification status could not be read. Refresh to try again."}));});
    return () => {controller.abort();lifetime.current = null;};
  }, [client,hostId,connected]);
  const current = () => lifetime.current && !lifetime.current.signal.aborted ? lifetime.current : null;
  const begin = () => {
    const controller = current();
    if (!controller || busy.current || state.busy) return null;
    busy.current = true;setState(previous => ({...previous,busy:true,notice:undefined}));
    return controller;
  };
  const finish = (controller:AbortController) => {if (!controller.signal.aborted) {busy.current=false;setState(previous=>({...previous,busy:false,permission:notificationPermission()}));}};
  const matching = state.registrations.filter(row => row.endpoint === state.subscription?.endpoint || state.host?.registrations.some(binding => binding.id === row.id && binding.generation === row.generation));
  const configured = state.permission === "granted" && state.host?.enabled === true && matching.some(row => row.endpoint === state.subscription?.endpoint && row.active && row.expiresAt > Date.now() && state.host?.registrations.some(binding => binding.id === row.id && binding.generation === row.generation && binding.expiresAt > Date.now()));
  const enable = () => {
    if (!connected || !capable || !state.workerReady || !state.worker || !state.configuration?.enabled || !state.host?.enabled || !state.configuration.applicationServerKey || state.permission === "unsupported" || state.permission === "denied") return;
    const controller = begin();if (!controller) return;
    const subscribe = () => {
      if (controller.signal.aborted) throw new DOMException("Notification setup was cancelled.","AbortError");
      const key = applicationServerKey(state.configuration!.applicationServerKey!);
      if (state.subscription) {
        const previous = state.subscription.options.applicationServerKey ? new Uint8Array(state.subscription.options.applicationServerKey) : new Uint8Array();
        if (previous.length !== key.length || previous.some((byte,index) => byte !== key[index])) throw new PushSetupError("This browser uses another notification key. Reset notification permission in browser settings before enabling again; this affects every linked computer.");
      }
      return state.worker!.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    };
    let subscriptionRequest:Promise<PushSubscription>;
    try {subscriptionRequest = state.permission === "granted" ? subscribe() : Notification.requestPermission().then(permission => {
      if (permission !== "granted") throw new PushSetupError("Notifications were not enabled. You can change this browser's notification permission in its settings.");
      return subscribe();
    });}
    catch (error) {finish(controller);setState(previous=>({...previous,notice:error instanceof PushSetupError ? error.message : "This browser could not request notification permission."}));return;}
    void (async () => {
      const subscription = await subscriptionRequest;
      if (controller.signal.aborted) return;
      const serialized = subscription.toJSON();
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) throw new PushSetupError("This browser returned an incomplete notification subscription.");
      const binding = asPushBinding(await remoteAccount<unknown>("/push/subscriptions",{method:"POST",signal:controller.signal,body:JSON.stringify({hostId,subscription:{endpoint:serialized.endpoint,keys:serialized.keys},consent:true})}));
      if (controller.signal.aborted) return;
      const result = await client.send({kind:"configureNotifications",id:binding.id,bindingToken:binding.bindingToken,generation:binding.generation},{idempotencyKey:crypto.randomUUID()});
      if (controller.signal.aborted) return;
      if (!result.ok || !bindingConfirmed(result.value,binding)) throw new PushSetupError("The account registration exists, but the computer did not confirm its binding. Refresh the status, then explicitly enable again if needed.");
      const status = await refresh(controller.signal);
      if (!controller.signal.aborted) setState(previous=>({...previous,notice:status?.confirmed ? "Notifications are configured for this computer. Delivery still depends on the browser and operating system." : "The registration was accepted, but its current account and computer status do not agree. Refresh before trying again."}));
    })().catch(error => {if (!controller.signal.aborted) setState(previous => ({...previous,notice:error instanceof PushSetupError ? error.message : "Notifications could not be enabled. Refresh before trying again."}));}).finally(()=>finish(controller));
  };
  const disable = () => {
    const controller = begin();if (!controller) return;
    const registrations = [...matching];
    void (async () => {
      let hostConfirmed = false;
      if (connected) {
        try {
          const result = await client.send({kind:"disableNotifications"},{idempotencyKey:crypto.randomUUID()});
          hostConfirmed = result.ok && typeof result.value === "object" && result.value !== null && "outcome" in result.value && result.value.outcome === "acknowledged";
        } catch {}
      }
      if (controller.signal.aborted) return;
      for (const row of registrations) {
        const removed = await remoteAccount<{ok?:unknown}>(`/push/subscriptions/${encodeURIComponent(row.id)}`,{method:"DELETE",signal:controller.signal});
        if (removed?.ok !== true) throw new PushSetupError("Account notification removal was not confirmed.");
        if (controller.signal.aborted) return;
      }
      const status = await refresh(controller.signal);
      if (controller.signal.aborted || !status) return;
      const remaining = status.registrations.some(row => row.endpoint === status.subscription?.endpoint || registrations.some(previous => previous.id === row.id));
      const notice = remaining || hostConfirmed && status.host?.registrations.length ? "A notification registration remains or was enabled again. Refresh the status before trying again." : hostConfirmed && status.host ? "Notifications were disabled for this browser and computer." : "Account notifications were disabled. The computer could not confirm removal of its local binding.";
      setState(previous=>({...previous,notice}));
    })().catch(()=>{if (!controller.signal.aborted) setState(previous=>({...previous,configuration:undefined,host:undefined,notice:"Removal was not fully confirmed. Refresh the status before trying again."}));}).finally(()=>finish(controller));
  };
  return <section aria-label="Computer notifications" className="border-b border-border px-4 py-3">
    <h2 className="font-semibold">Notifications</h2>
    <p className="mt-1 text-body-sm text-muted-foreground">Experimental · Optional generic activity notices. Conversation text and approval requests are never included.</p>
    <p className="mt-2 text-body-sm">{configured ? "Configured for this computer." : "Not confirmed for this computer."}</p>
    {state.permission === "denied" && <p className="mt-2 text-body-sm">Notifications are blocked in this browser's settings.</p>}
    {state.notice && <p role="status" className="mt-2 text-body-sm">{state.notice}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button className="min-h-11" disabled={state.busy || !connected || !capable || !state.workerReady || !state.configuration?.enabled || !state.host?.enabled || state.permission === "unsupported" || state.permission === "denied"} onClick={enable}>{configured ? "Reconnect notifications" : "Enable notifications for this computer"}</Button>
      {matching.length > 0 && <Button className="min-h-11" disabled={state.busy} onClick={disable}>Disable notifications for this computer</Button>}
      <Button className="min-h-11" disabled={state.busy} onClick={()=>{const controller=begin();if(controller)void refresh(controller.signal).catch(()=>{if(!controller.signal.aborted)setState(previous=>({...previous,configuration:undefined,host:undefined,notice:"Notification status could not be read."}));}).finally(()=>finish(controller));}}>Refresh notification status</Button>
    </div>
  </section>;
}
