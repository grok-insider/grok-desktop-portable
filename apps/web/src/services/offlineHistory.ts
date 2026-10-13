import {DRAFT_CHANGED, DRAFT_DATABASE, DRAFT_TTL_MS, DraftStore, offlineHistoryScope, type DraftChange} from "./drafts";
import type {Projection} from "./sessionProjection";

export const HISTORY_CHANGED = "grok-offline-history-changed";
export interface OfflineMessage {id: string; role: "user" | "agent"; text: string; seq: number; unavailableImages: number}
export interface OfflineTool {id: string; name: string; detail: string; seq: number; finished: boolean; failed: boolean}
export interface OfflineConversation {version: 1; sessionId: string; savedAt: number; observationEpoch?: number; observedThrough?: number; messages: OfflineMessage[]; tools: OfflineTool[]}
export interface HistorySnapshot {enabled: boolean; epoch: string; conversations: OfflineConversation[]; excluded: string[]}

export function offlineContent(sessionId: string, projection: Projection): Omit<OfflineConversation, "savedAt"> {
  return {version: 1, sessionId, ...(projection.observedThrough === undefined ? {} : {observedThrough: projection.observedThrough, observationEpoch: projection.observationEpoch ?? 0}), messages: projection.transcript.map(entry => ({id: entry.id, role: entry.role, text: entry.text, seq: entry.seq, unavailableImages: (entry.images?.length ?? 0) + (entry.liveImages?.length ?? 0) + (entry.unavailableImages ?? 0)})), tools: projection.tools.map(tool => ({id: tool.id, name: tool.name, detail: tool.detail ?? "", seq: tool.seq, finished: tool.finished, failed: tool.failed}))};
}

export function offlineSignature(value: Omit<OfflineConversation, "savedAt">): string {
  const rows = [...value.messages.map(row => ({kind: "message", ...row})), ...value.tools.map(row => ({kind: "tool", ...row}))];
  return JSON.stringify(rows.sort((a, b) => a.seq - b.seq).map(({id: _, seq: __, ...row}) => row));
}

function parseConversation(text: string, sessionId: string, now: number): OfflineConversation | undefined {
  try {
    const value: OfflineConversation = JSON.parse(text);
    if (value.observationEpoch !== undefined && (!Number.isSafeInteger(value.observationEpoch) || value.observationEpoch < 0)) return;
    if (value.observedThrough !== undefined && (!Number.isSafeInteger(value.observedThrough) || value.observedThrough < 0)) return;
    if (value.version !== 1 || value.sessionId !== sessionId || !Number.isFinite(value.savedAt) || value.savedAt > now || now - value.savedAt >= DRAFT_TTL_MS || !Array.isArray(value.messages) || !Array.isArray(value.tools) || value.messages.length + value.tools.length > 10000) return;
    if (!value.messages.every(row => typeof row.id === "string" && (row.role === "user" || row.role === "agent") && typeof row.text === "string" && Number.isFinite(row.seq) && Number.isSafeInteger(row.unavailableImages) && row.unavailableImages >= 0 && row.unavailableImages <= 10000)) return;
    if (!value.tools.every(row => typeof row.id === "string" && typeof row.name === "string" && typeof row.detail === "string" && Number.isFinite(row.seq) && typeof row.finished === "boolean" && typeof row.failed === "boolean")) return;
    return value;
  } catch {return;}
}

function changed(scope: string): void {
  const detail = {scope, history: true};
  window.dispatchEvent(new CustomEvent(HISTORY_CHANGED, {detail}));
  try {const channel = new BroadcastChannel(DRAFT_DATABASE); channel.postMessage(detail); channel.close();} catch {}
}

export class OfflineHistoryStore {
  readonly scope: string;
  readonly drafts: DraftStore;
  constructor(scope: string, private readonly now: () => number = Date.now) {
    this.scope = offlineHistoryScope(scope);
    this.drafts = new DraftStore(this.scope, undefined, now);
  }
  async load(): Promise<HistorySnapshot> {
    const snapshot = await this.drafts.load();
    const excluded = await this.drafts.excludedSessions();
    const conversations = Object.entries(snapshot.drafts).flatMap(([id, text]) => {
      const value = parseConversation(text, id, this.now());
      return value && !excluded.includes(id) ? [value] : [];
    }).sort((a, b) => b.savedAt - a.savedAt);
    return {enabled: snapshot.enabled, epoch: snapshot.epoch, conversations, excluded};
  }
  async enable(): Promise<void> {await this.drafts.enable(); changed(this.scope);}
  async disable(): Promise<void> {await this.drafts.clear(true); changed(this.scope);}
  async remove(sessionId: string): Promise<void> {await this.drafts.excludeSession(sessionId); changed(this.scope);}
  async save(sessionId: string, projection: Projection, epoch: string): Promise<void> {
    if (projection.observationEpoch !== undefined && (!Number.isSafeInteger(projection.observationEpoch) || projection.observationEpoch < 0)) return;
    if (projection.observedThrough !== undefined && (!Number.isSafeInteger(projection.observedThrough) || projection.observedThrough < 0)) return;
    const value = {...offlineContent(sessionId, projection), savedAt: this.now(), ...(projection.observedThrough === undefined ? {} : {observedThrough: projection.observedThrough})};
    if (value.messages.length + value.tools.length > 10000) throw new Error("This conversation is too long for offline storage. Its previous copy is preserved.");
    if (!value.messages.length && !value.tools.length) return;
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("This conversation exceeds the 1 MiB offline limit. Its previous copy is preserved.");
    await this.drafts.write(sessionId, text, epoch, previous => {
      const old = previous ? parseConversation(previous, sessionId, this.now()) : undefined;
      if (old?.observedThrough !== undefined && (value.observedThrough === undefined || (value.observationEpoch ?? 0) < (old.observationEpoch ?? 0) || ((value.observationEpoch ?? 0) === (old.observationEpoch ?? 0) && value.observedThrough <= old.observedThrough))) return;
      const savedAt = old && offlineSignature(old) === offlineSignature(value) ? old.savedAt : value.savedAt;
      return {text: JSON.stringify({...value, savedAt}), savedAt};
    });
    changed(this.scope);
  }
}

export function observeOfflineHistory(scope: string, callback: (revoked: boolean) => void): () => void {
  const receive = (value: unknown) => {
    const detail = value as Partial<DraftChange> & {history?: boolean};
    if (detail?.scope === scope) callback(detail.enabled === false);
  };
  const local = (event: Event) => {if (event instanceof CustomEvent) receive(event.detail);};
  window.addEventListener(HISTORY_CHANGED, local);
  window.addEventListener(DRAFT_CHANGED, local);
  let channel: BroadcastChannel | undefined;
  try {channel = new BroadcastChannel(DRAFT_DATABASE); channel.onmessage = event => receive(event.data);} catch {}
  return () => {window.removeEventListener(HISTORY_CHANGED, local); window.removeEventListener(DRAFT_CHANGED, local); channel?.close();};
}
