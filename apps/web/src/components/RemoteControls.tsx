import { useEffect, useState } from "react";
import { Button, Card } from "./ui";
import { remoteExperimentEnabled } from "../services/experiments";
import type { BrowserDevices, ControlTransferRequest, RemoteCapabilities, RemoteProjectsPage } from "../services/remoteControls";

export interface RemoteControlsProps {
  scopeKey: string;
  hostLabel?: string;
  capabilities?: RemoteCapabilities;
  connected: boolean;
  canControl: boolean;
  busy: boolean;
  error?: string;
  projects?: RemoteProjectsPage;
  browserDevices?: BrowserDevices;
  ownControlRequest?: ControlTransferRequest;
  onBrowseProjects: (request: {directoryId?: string; cursor?: string}) => void;
  onEnrollProject: (directoryId: string) => void;
  onRefreshDevices: () => void;
  onRequestControl: () => void;
  onCancelControl: (requestId: string) => void;
  onApproveControl: (requestId: string) => void;
  onRevokeBrowser: (sessionId: string, currentBrowser: boolean) => void;
}

export function RemoteControls(props: RemoteControlsProps) {
  const projects = remoteExperimentEnabled("remote-projects") && props.capabilities?.projects;
  const transfer = remoteExperimentEnabled("control-transfer") && props.capabilities?.controlTransfer;
  const devices = remoteExperimentEnabled("device-panel") && props.capabilities?.devicePanel;
  if (!projects && !transfer && !devices) return null;
  return <EnabledRemoteControls key={props.scopeKey} {...props} showProjects={Boolean(projects)} showTransfer={Boolean(transfer)} showDevices={Boolean(devices)} />;
}

function EnabledRemoteControls({hostLabel, capabilities, connected, canControl, busy, error, projects, browserDevices, ownControlRequest, onBrowseProjects, onEnrollProject, onRefreshDevices, onRequestControl, onCancelControl, onApproveControl, onRevokeBrowser, showProjects, showTransfer, showDevices}: RemoteControlsProps & {showProjects: boolean; showTransfer: boolean; showDevices: boolean}) {
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [trail, setTrail] = useState<{directoryId: string; label: string}[]>([]);
  const [confirmRevoke, setConfirmRevoke] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {setConfirmRevoke(undefined);}, [canControl, connected]);
  useEffect(() => {
    if (!devicesOpen || !showTransfer || (!browserDevices?.controlTransferRequests.length && !ownControlRequest)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [devicesOpen, showTransfer, browserDevices?.controlTransferRequests.length, ownControlRequest]);
  const disabled = !connected || busy;
  const activeIndex = projects?.parentId ? trail.findIndex((entry) => entry.directoryId === projects.parentId) : -1;
  const activeTrail = trail.slice(0, activeIndex + 1);
  const currentBrowser = browserDevices?.devices.find((device) => device.currentBrowser);
  const requests = browserDevices?.controlTransferRequests ?? [];
  const ownRequest = ownControlRequest && ownControlRequest.expiresAt > now ? ownControlRequest : undefined;
  const confirmation = browserDevices?.devices.find((device) => device.sessionId === confirmRevoke);
  const openDirectory = (entry: {directoryId: string; label: string}) => {
    if (disabled) return;
    setTrail([...activeTrail, entry]);
    onBrowseProjects({directoryId: entry.directoryId});
  };
  return <section aria-label="Remote computer tools" className="mb-5 border-b border-border pb-5">
    <h2 className="font-semibold">{hostLabel ?? "Selected computer"}</h2>
    {!connected && <p role="status" className="mt-2 text-warning">The computer is disconnected. The information below may be out of date.</p>}
    {error && <p role="status" className="mt-2 text-warning">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {showProjects && <Button aria-expanded={projectsOpen} className="min-h-11" disabled={disabled} onClick={() => {setProjectsOpen(!projectsOpen); if (!projectsOpen) onBrowseProjects({});}}>Browse approved folders</Button>}
      {(showTransfer || showDevices) && <Button aria-expanded={devicesOpen} className="min-h-11" disabled={disabled} onClick={() => {setDevicesOpen(!devicesOpen); setConfirmRevoke(undefined); if (!devicesOpen) onRefreshDevices();}}>Browsers and control</Button>}
    </div>
    {projectsOpen && showProjects && <div className="mt-4 space-y-3">
      <p className="text-body-sm text-muted-foreground">Only folders approved on this computer are available. Select a folder to add it as a project.</p>
      <nav aria-label="Approved folder location" className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11" disabled={disabled} onClick={() => {if (!disabled) onBrowseProjects({});}}>Approved roots</Button>
        {activeTrail.map((entry) => <Button key={entry.directoryId} className="min-h-11 max-w-full break-all" disabled={disabled} aria-current={entry.directoryId === projects?.parentId ? "location" : undefined} onClick={() => {if (!disabled) onBrowseProjects({directoryId: entry.directoryId});}}>{entry.label}</Button>)}
      </nav>
      {projects?.parentId && <Button variant="primary" className="min-h-11" disabled={disabled || !canControl} onClick={() => {if (!disabled && canControl && projects.parentId) onEnrollProject(projects.parentId);}}>Use this folder as a project</Button>}
      {projects && !projects.entries.length && <p className="text-body-sm">{projects.parentId ? "No subfolders are available here." : "No approved roots are available. Add an allowed root in Spanreed on this computer."}</p>}
      <ul className="space-y-2">{projects?.entries.map((entry) => <li key={entry.directoryId} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
        <span className="min-w-0 flex-1 break-all">{entry.label}</span>
        <Button className="min-h-11" disabled={disabled} aria-label={`Browse ${entry.label}`} onClick={() => openDirectory(entry)}>Browse</Button>
        <Button className="min-h-11" disabled={disabled || !canControl} aria-label={`Add ${entry.label} as a project`} onClick={() => {if (!disabled && canControl) onEnrollProject(entry.directoryId);}}>Add project</Button>
      </li>)}</ul>
      {projects?.nextCursor && <Button className="min-h-11" disabled={disabled} onClick={() => {if (!disabled && projects.nextCursor) onBrowseProjects({...(projects.parentId ? {directoryId: projects.parentId} : {}), cursor: projects.nextCursor});}}>Next folders</Button>}
    </div>}
    {devicesOpen && (showTransfer || showDevices) && <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3"><p className="text-body-sm">{canControl ? "This connection controls the computer." : "This connection observes the computer."}</p><Button className="min-h-11" disabled={disabled} onClick={() => {if (!disabled) {setNow(Date.now()); onRefreshDevices();}}}>Refresh browsers</Button></div>
      {showTransfer && capabilities?.controlTransfer && !canControl && <div className="flex flex-wrap items-center gap-2">
        {ownRequest ? <><p role="status" className="text-body-sm">Waiting for the controlling browser · {Math.max(0, Math.ceil((ownRequest.expiresAt - now) / 1000))} seconds</p><Button className="min-h-11" disabled={disabled} onClick={() => {if (!disabled && ownRequest.expiresAt > Date.now()) onCancelControl(ownRequest.requestId);}}>Cancel control request</Button></> : <Button className="min-h-11" disabled={disabled || !currentBrowser} onClick={() => {if (!disabled && currentBrowser) onRequestControl();}}>Request control</Button>}
      </div>}
      {showTransfer && canControl && requests.filter((request) => request.expiresAt > now).map((request) => <Card key={request.requestId}>
        <p className="break-all text-body-sm">Browser {request.sessionId} requests control.</p>
        <p className="mt-1 text-body-sm text-muted-foreground">Expires in {Math.max(0, Math.ceil((request.expiresAt - now) / 1000))} seconds. Transferring makes this connection an observer.</p>
        <Button className="mt-2 min-h-11" disabled={disabled} onClick={() => {if (!disabled && canControl && request.expiresAt > Date.now()) onApproveControl(request.requestId);}}>Transfer control to this browser</Button>
      </Card>)}
      {showDevices && <ul className="space-y-2">{browserDevices?.devices.map((device) => <li key={device.sessionId}><Card>
        <p className="font-semibold">{device.currentBrowser ? "This browser" : "Paired browser"}{device.currentController ? " · A tab has control" : ""}</p>
        <p className="mt-1 break-all font-mono text-body-sm">{device.sessionId}</p>
        <p className="mt-1 text-body-sm text-muted-foreground">{device.connected ? `Connected · ${device.connectionCount} connection${device.connectionCount === 1 ? "" : "s"}` : "Disconnected"} · Last activity unavailable</p>
        <Button className="mt-2 min-h-11" variant="danger" disabled={disabled || (!device.currentBrowser && !canControl)} onClick={() => {if (!disabled && (device.currentBrowser || canControl)) setConfirmRevoke(device.sessionId);}}>{device.currentBrowser ? "Remove this browser" : "Remove browser access"}</Button>
      </Card></li>)}</ul>}
      {confirmation && showDevices && <Card>
        <p className="font-semibold">Remove {confirmation.currentBrowser ? "this browser" : "this paired browser"} from the computer?</p>
        <p className="mt-1 break-all text-body-sm">{confirmation.sessionId}</p>
        <p className="mt-2 text-body-sm">Its connections will close. Pairing again will be required.</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button className="min-h-11" variant="danger" disabled={disabled || (!confirmation.currentBrowser && !canControl)} onClick={() => {if (!disabled && (confirmation.currentBrowser || canControl)) {onRevokeBrowser(confirmation.sessionId, confirmation.currentBrowser); setConfirmRevoke(undefined);}}}>Confirm removal</Button><Button className="min-h-11" disabled={busy} onClick={() => setConfirmRevoke(undefined)}>Keep browser access</Button></div>
      </Card>}
    </div>}
  </section>;
}
