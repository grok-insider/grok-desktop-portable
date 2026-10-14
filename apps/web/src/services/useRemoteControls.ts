import { useCallback, useEffect, useRef, useState } from "react";
import type { LightClient } from "./client";
import type { Operation } from "./protocol";
import { remoteExperimentEnabled } from "./experiments";
import { asBrowserDevices, asControlTransferRequest, asRemoteCapabilities, asRemoteProjects, type BrowserDevices, type ControlTransferRequest, type RemoteCapabilities, type RemoteProjectsPage } from "./remoteControls";

interface ControlsState {
  context: number;
  capabilities?: RemoteCapabilities;
  projects?: RemoteProjectsPage;
  browserDevices?: BrowserDevices;
  ownControlRequest?: ControlTransferRequest;
  busy: boolean;
  error?: string;
}

interface Inputs {
  client: LightClient;
  scopeKey: string;
  connectionVersion: number;
  connected: boolean;
  canControl: boolean;
  onEnrolled: () => void;
  onRevokeOwn: () => Promise<void>;
}

export function useRemoteControls(inputs: Inputs) {
  const enabled = inputs.client.remote || inputs.client.multiWriter || ["push", "remote-projects", "control-transfer", "device-panel"].some(name => remoteExperimentEnabled(name as "push" | "remote-projects" | "control-transfer" | "device-panel"));
  const latest = useRef(inputs);
  const controlGeneration = useRef(0);
  if (latest.current.canControl !== inputs.canControl) controlGeneration.current++;
  latest.current = inputs;
  const key = JSON.stringify([inputs.scopeKey, inputs.connectionVersion, inputs.connected, enabled]);
  const lifecycle = useRef({key, client:inputs.client, epoch:0, mounted:true, busy:false, devicesRead:0});
  if (lifecycle.current.key !== key || lifecycle.current.client !== inputs.client) lifecycle.current = {key, client:inputs.client, epoch:lifecycle.current.epoch + 1, mounted:true, busy:false, devicesRead:0};
  const [state, setState] = useState<ControlsState>({context:0,busy:false});
  const current = state.context === lifecycle.current.epoch ? state : {context:lifecycle.current.epoch,busy:false};
  const capabilities = useRef(current.capabilities);
  capabilities.current = current.capabilities;
  const active = (epoch: number) => lifecycle.current.mounted && epoch === lifecycle.current.epoch && latest.current.connected;

  const refreshDevices = useCallback(() => {
    if (!latest.current.connected || !(capabilities.current?.devicePanel || capabilities.current?.controlTransfer)) return;
    const epoch = lifecycle.current.epoch;
    const ticket = ++lifecycle.current.devicesRead;
    void latest.current.client.send({kind:"listBrowserDevices"}).then(result => {
      if (!active(epoch) || ticket !== lifecycle.current.devicesRead) return;
      const devices = result.ok ? asBrowserDevices(result.value) : null;
      setState(previous => ({...previous,context:epoch,...(devices ? {browserDevices:devices, ownControlRequest:!latest.current.canControl && previous.ownControlRequest && devices.controlTransferRequests.some(request => request.requestId === previous.ownControlRequest?.requestId && request.sessionId === previous.ownControlRequest?.sessionId) ? previous.ownControlRequest : undefined} : {error:"Browser status could not be refreshed. Reconnect or refresh to try again."})}));
    }).catch(() => {
      if (active(epoch) && ticket === lifecycle.current.devicesRead) setState(previous => ({...previous,error:"Browser status could not be refreshed."}));
    });
  }, []);

  useEffect(() => {
    lifecycle.current.mounted = true;
    const epoch = lifecycle.current.epoch;
    setState({context:epoch,busy:false});
    if (enabled && inputs.connected) {
      void inputs.client.send({kind:"getRemoteCapabilities"}).then(result => {
        if (!active(epoch)) return;
        const offered = result.ok ? asRemoteCapabilities(result.value) : null;
        if (!offered) return;
        const discovered = {...offered,pushNotifications:offered.pushNotifications === true && (inputs.scopeKey.startsWith('["direct",') || offered.multiWriter || remoteExperimentEnabled("push")),projects:offered.projects && (offered.multiWriter || remoteExperimentEnabled("remote-projects")),controlTransfer:!offered.multiWriter && offered.controlTransfer && remoteExperimentEnabled("control-transfer"),devicePanel:offered.devicePanel && (offered.multiWriter || remoteExperimentEnabled("device-panel"))};
        capabilities.current = discovered;
        setState(previous => ({...previous,context:epoch,capabilities:discovered}));
        refreshDevices();
      }).catch(() => {});
    }
    return () => {lifecycle.current.mounted = false; lifecycle.current.epoch++; lifecycle.current.busy = false; lifecycle.current.devicesRead++;};
  }, [inputs.client, key, enabled, inputs.connected, refreshDevices]);

  useEffect(() => {
    if (inputs.canControl) setState(previous => ({...previous,ownControlRequest:undefined}));
  }, [inputs.canControl]);

  const run = async (operation: Operation, apply: (value: unknown) => boolean | void, requiresControl = false) => {
    if (!enabled || !latest.current.connected || lifecycle.current.busy || (requiresControl && !latest.current.canControl)) return;
    const epoch = lifecycle.current.epoch;
    lifecycle.current.busy = true;
    setState(previous => ({...previous,context:epoch,busy:true,error:undefined}));
    try {
      const result = await latest.current.client.send(operation, operation.kind === "listRemoteProjects" ? undefined : {idempotencyKey:crypto.randomUUID()});
      if (!active(epoch)) return;
      if (!result.ok) {
        const code = result.failure.kind === "refused" ? result.failure.code : "";
        const messages: Record<string,string> = {unknown_remote_directory:"The folder selection expired. Open Approved roots and choose again.",remote_directory_changed:"This folder changed on the computer. Select it again before adding it.",controller_required:"This connection no longer controls the computer.",control_transfer_expired:"The control request expired. The other browser must request again."};
        setState(previous => ({...previous,error:messages[code] ?? "The computer did not confirm this action. Refresh its state before trying again."}));
      } else if (apply(result.value) === false) setState(previous => ({...previous,error:"The computer returned an unsupported response. Refresh before trying again."}));
    } catch {
      if (active(epoch)) setState(previous => ({...previous,error:"The connection was interrupted. Check the current state before trying again."}));
    } finally {
      if (active(epoch)) {
        lifecycle.current.busy = false;
        setState(previous => ({...previous,busy:false}));
      }
    }
  };

  return {
    ...current,
    scopeKey:inputs.scopeKey,
    connected:inputs.connected,
    canControl:inputs.canControl,
    onRefreshDevices:refreshDevices,
    onBrowseProjects:(request: {directoryId?:string;cursor?:string}) => {
      if (!capabilities.current?.projects) return;
      void run({kind:"listRemoteProjects",...request}, value => {
        const page = asRemoteProjects(value);
        if (!page) return false;
        setState(previous => ({...previous,projects:page}));
      });
    },
    onEnrollProject:(directoryId: string) => {
      if (!capabilities.current?.projects) return;
      void run({kind:"enrollRemoteProject",directoryId}, () => latest.current.onEnrolled(), true);
    },
    onRequestControl:() => {
      if (!capabilities.current?.controlTransfer || latest.current.canControl) return;
      const generation = controlGeneration.current;
      void run({kind:"requestControlTransfer"}, value => {
        const outcome = value as {outcome?:string;request?:unknown} | null;
        const request = outcome?.outcome === "controlTransferRequested" ? asControlTransferRequest(outcome.request) : null;
        if (!request) return false;
        if (!latest.current.canControl && generation === controlGeneration.current) setState(previous => ({...previous,ownControlRequest:request}));
        refreshDevices();
      });
    },
    onCancelControl:(requestId: string) => {
      if (!capabilities.current?.controlTransfer || current.ownControlRequest?.requestId !== requestId) return;
      void run({kind:"cancelControlTransfer",requestId}, () => {setState(previous => ({...previous,ownControlRequest:undefined}));refreshDevices();});
    },
    onApproveControl:(requestId: string) => {
      if (!capabilities.current?.controlTransfer) return;
      void run({kind:"approveControlTransfer",requestId}, () => refreshDevices(), true);
    },
    onRevokeBrowser:(sessionId: string, currentBrowser: boolean) => {
      if (!capabilities.current?.devicePanel) return;
      if (!currentBrowser) {void run({kind:"revokeBrowserPairing",sessionId}, () => refreshDevices(), true);return;}
      if (!latest.current.connected || lifecycle.current.busy) return;
      const epoch = lifecycle.current.epoch;
      lifecycle.current.busy = true;
      setState(previous => ({...previous,busy:true,error:undefined}));
      void latest.current.onRevokeOwn().catch(() => {if (active(epoch)) setState(previous => ({...previous,error:"Removal could not be confirmed. Refresh or revoke this browser from the computer."}));}).finally(() => {
        if (active(epoch)) {lifecycle.current.busy = false;setState(previous => ({...previous,busy:false}));}
      });
    },
  };
}
