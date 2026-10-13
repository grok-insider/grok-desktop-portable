export interface RemoteCapabilities {
  outcome: "remoteCapabilities";
  projects: boolean;
  contentProtocolVersion?: number;
  pushNotifications?: boolean;
  controlTransfer: boolean;
  devicePanel: boolean;
  upstreamPrompt?: {image: boolean; audio: boolean; embeddedContext: boolean} | null;
}

export interface RemoteProjectsPage {
  outcome: "remoteProjects";
  parentId: string | null;
  entries: {directoryId: string; label: string}[];
  nextCursor: string | null;
}

export interface BrowserDeviceProjection {
  sessionId: string;
  currentBrowser: boolean;
  currentController: boolean;
  connected: boolean;
  connectionCount: number;
  lastSeen: null;
}

export interface ControlTransferRequest {
  requestId: string;
  sessionId: string;
  expiresAt: number;
}

export interface BrowserDevices {
  outcome: "browserDevices";
  devices: BrowserDeviceProjection[];
  controlTransferRequests: ControlTransferRequest[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._-]+$/.test(value);
const unique = (values: string[]) => new Set(values).size === values.length;

export function asRemoteCapabilities(value: unknown): RemoteCapabilities | null {
  if (!record(value) || value.outcome !== "remoteCapabilities" || typeof value.projects !== "boolean" || typeof value.controlTransfer !== "boolean" || typeof value.devicePanel !== "boolean") return null;
  if (value.pushNotifications !== undefined && typeof value.pushNotifications !== "boolean") return null;
  if (value.contentProtocolVersion !== undefined && (!Number.isInteger(value.contentProtocolVersion) || Number(value.contentProtocolVersion) < 2)) return null;
  const prompt = value.upstreamPrompt;
  if (prompt !== undefined && prompt !== null && (!record(prompt) || ["image", "audio", "embeddedContext"].some((key) => typeof prompt[key] !== "boolean"))) return null;
  return value as unknown as RemoteCapabilities;
}

export function asRemoteProjects(value: unknown): RemoteProjectsPage | null {
  if (!record(value) || value.outcome !== "remoteProjects" || (value.parentId !== null && !id(value.parentId)) || (value.nextCursor !== null && !id(value.nextCursor)) || !Array.isArray(value.entries) || value.entries.length > 100 || !value.entries.every((entry) => record(entry) && id(entry.directoryId) && typeof entry.label === "string" && entry.label.length > 0 && entry.label.length <= 1024)) return null;
  if (!unique(value.entries.map((entry) => entry.directoryId))) return null;
  return value as unknown as RemoteProjectsPage;
}

export function asControlTransferRequest(value: unknown): ControlTransferRequest | null {
  if (!record(value) || !id(value.requestId) || !id(value.sessionId) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0) return null;
  return value as unknown as ControlTransferRequest;
}

export function asBrowserDevices(value: unknown): BrowserDevices | null {
  if (!record(value) || value.outcome !== "browserDevices" || !Array.isArray(value.devices) || value.devices.length > 1000 || !value.devices.every((device) => record(device) && id(device.sessionId) && ["currentBrowser", "currentController", "connected"].every((key) => typeof device[key] === "boolean") && typeof device.connectionCount === "number" && Number.isSafeInteger(device.connectionCount) && device.connectionCount >= 0 && device.lastSeen === null) || !Array.isArray(value.controlTransferRequests) || value.controlTransferRequests.length > 1000 || !value.controlTransferRequests.every((request) => asControlTransferRequest(request) !== null)) return null;
  if (!unique(value.devices.map((device) => device.sessionId)) || !unique(value.controlTransferRequests.map((request) => request.requestId)) || value.devices.filter((device) => device.currentBrowser).length > 1 || value.devices.filter((device) => device.currentController).length > 1) return null;
  return value as unknown as BrowserDevices;
}
