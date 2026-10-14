export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DRAFT_PREFIX = "grok-remote-drafts.v1:";
export const DRAFT_CHANGED = "grok-remote-drafts-changed";
export const DRAFT_DATABASE = "grok-remote-drafts.v2";
const MAX_DRAFT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const queues = new Map<string, Promise<unknown>>();
let queuedOperations = 0;
const barriers = new Map<string, number>();
const clearing = new Map<string, {promise: Promise<void>; operationId: string; revoked: boolean}>();

function serialize<T>(scope: string, action: () => Promise<T>, priority = false): Promise<T> {
  if (queuedOperations >= (priority ? 64 : 63)) return Promise.reject(new Error("Too many draft storage operations are pending. Keep a copy before closing."));
  queuedOperations++;
  const generation = barriers.get(scope) ?? 0;
  const result = (queues.get(scope) ?? Promise.resolve()).catch(() => {}).then(() => {
    if (generation !== (barriers.get(scope) ?? 0)) throw new Error("Draft storage was disabled before this change could be saved.");
    return action();
  });
  queues.set(scope, result);
  void result.finally(() => {queuedOperations--;if (queues.get(scope) === result) {queues.delete(scope);barriers.delete(scope);}}).catch(() => {});
  return result;
}

interface ScopeRecord {scope: string; epoch: string; enabled: boolean; excludedSessions?: string[]}
interface DraftRecord {scope: string; sessionId: string; text: string; savedAt: number; images?: StoredDraftImage[]}
export interface StoredDraftImage {id: string; name: string; blob: Blob; width: number; height: number}
const IMAGE_DRAFT_KEY = "\0images\0";
const MAX_IMAGE_DRAFT_BYTES = 100 * 1024 * 1024;
export interface DraftSnapshot {enabled: boolean; epoch: string; drafts: Record<string, string>}
export interface DraftChange {scope: string; revoked: boolean; enabled: boolean; operationId: string; epoch?: string | null}

export function managedDraftScope(accountId: string | undefined, host: {id: string; publicKey: string; installationId: string}): string | undefined {
  const values = [accountId, host.id, host.publicKey, host.installationId];
  return values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 512) ? JSON.stringify(["managed", ...values]) : undefined;
}

export function privateDraftScope(origin: string, installationId: string | undefined, pairingId: string | undefined): string | undefined {
  if (typeof installationId !== "string" || typeof pairingId !== "string" || !installationId || !pairingId || installationId.length > 512 || pairingId.length > 512) return undefined;
  return JSON.stringify(["private", origin, installationId, pairingId]);
}

export function draftScopePrefix(scope: string): string {return `${DRAFT_PREFIX}${encodeURIComponent(scope)}:`;}

function notify(change: DraftChange, broadcast = true): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, {detail: change}));
  try {if (broadcast && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(DRAFT_DATABASE);
    channel.postMessage(change);
    channel.close();
  }} catch {}
}

function validRecord(value: unknown, scope: string, now: number): value is DraftRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DraftRecord>;
  return row.scope === scope && typeof row.sessionId === "string" && typeof row.text === "string" && typeof row.savedAt === "number" && Number.isFinite(row.savedAt) && row.savedAt <= now && now - row.savedAt < DRAFT_TTL_MS && encoder.encode(row.text).length <= MAX_DRAFT_BYTES;
}

function validImage(image: StoredDraftImage): boolean {
  return Boolean(image && typeof image.id === "string" && image.id.length <= 128 && typeof image.name === "string" && image.name.length <= 200 && Object.prototype.toString.call(image.blob) === "[object Blob]" && image.blob.size > 0 && image.blob.size <= 1_500_000 && ["image/png", "image/jpeg"].includes(image.blob.type) && Number.isSafeInteger(image.width) && image.width >= 8 && Number.isSafeInteger(image.height) && image.height >= 8);
}

function checkText(text: string): void {
  if (encoder.encode(text).length > MAX_DRAFT_BYTES) throw new Error("This draft is too large to save on this device. Keep a separate copy before closing.");
}

function reserveDraftBytes(store: IDBObjectStore, replacements: DraftRecord[], now: number, done: () => void, fail: (error: Error) => void): void {
  const request = store.getAll();
  request.onsuccess = () => {
    try {
      let bytes = replacements.reduce((sum, row) => sum + encoder.encode(row.text).length + (row.images ?? []).reduce((size, image) => size + image.blob.size, 0), 0);
      for (const row of request.result as DraftRecord[]) {
        const key = [row.scope, row.sessionId];
        if (!validRecord(row, row.scope, now)) {store.delete(key); continue;}
        if (replacements.some(next => next.scope === row.scope && next.sessionId === row.sessionId)) continue;
        bytes += encoder.encode(row.text).length + (row.images ?? []).reduce((size, image) => size + image.blob.size, 0);
      }
      if (bytes > MAX_IMAGE_DRAFT_BYTES) throw new Error("Saved drafts and history exceed 100 MiB in this browser. Delete some saved content before saving more.");
      for (const row of replacements) {
        if (row.text || row.images?.length) store.put(row);
        else store.delete([row.scope, row.sessionId]);
      }
      done();
    } catch (error) {fail(error instanceof Error ? error : new Error("Drafts could not be saved."));}
  };
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DRAFT_DATABASE, 1);
    let abandoned = false;
    const fail = () => {abandoned = true;clearTimeout(timer);reject(new Error("Draft storage is unavailable."));};
    const timer = setTimeout(fail, 3000);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("scopes", {keyPath: "scope"});
      request.result.createObjectStore("drafts", {keyPath: ["scope", "sessionId"]}).createIndex("scope", "scope");
    };
    request.onerror = request.onblocked = fail;
    request.onsuccess = () => {
      clearTimeout(timer);
      if (abandoned) request.result.close();
      else {request.result.onversionchange = () => request.result.close();resolve(request.result);}
    };
  });
}

export class DraftStore {
  readonly prefix: string;
  private epoch: string | undefined;

  constructor(readonly scope: string, private readonly suppliedStorage?: Storage, private readonly now: () => number = Date.now, private readonly factory?: IDBFactory) {
    this.prefix = draftScopePrefix(scope);
  }

  private get storage(): Storage {return this.suppliedStorage ?? localStorage;}

  private legacyKeys(): string[] {
    return Array.from({length: this.storage.length}, (_, index) => this.storage.key(index)).filter((key): key is string => key !== null && key.startsWith(this.prefix));
  }

  private removeLegacy(): void {for (const key of this.legacyKeys()) this.storage.removeItem(key);}

  private legacy(): {enabled: boolean; drafts: DraftRecord[]} {
    const enabled = this.storage.getItem(`${this.prefix}consent`) === "yes";
    const drafts: DraftRecord[] = [];
    if (enabled) for (const key of this.legacyKeys()) {
      if (!key.startsWith(`${this.prefix}session:`)) continue;
      try {
        const row = {...JSON.parse(this.storage.getItem(key) ?? "null"), scope: this.scope, sessionId: decodeURIComponent(key.slice(`${this.prefix}session:`.length))};
        if (validRecord(row, this.scope, this.now())) drafts.push(row);
      } catch {}
    }
    return {enabled, drafts};
  }

  private transaction<T>(action: (transaction: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void, priority = false): Promise<T> {
    return serialize(this.scope, () => this.runTransaction(action), priority);
  }

  private async runTransaction<T>(action: (transaction: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const database = await openDatabase(this.factory ?? indexedDB);
    try {
      return await new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(["scopes", "drafts"], "readwrite", {durability: "strict"});
          if (transaction.durability !== "strict") {transaction.abort();throw new Error("This browser cannot confirm durable draft storage.");}
        } catch (error) {reject(error);return;}
        let value: T;
        let completed = false;
        let failure: Error | undefined;
        const fail = (error: Error) => {failure = error;try {transaction.abort();} catch {}reject(error);};
        const timer = setTimeout(() => fail(new Error("Draft storage took too long. Keep a copy before closing.")), 10000);
        transaction.oncomplete = () => {clearTimeout(timer);if (completed) resolve(value);else reject(new Error("Draft storage returned no result."));};
        transaction.onerror = transaction.onabort = () => {clearTimeout(timer);reject(failure ?? transaction.error ?? new Error("Draft storage could not be committed."));};
        try {action(transaction, result => {value = result;completed = true;}, fail);} catch (error) {fail(error instanceof Error ? error : new Error("Draft storage is unavailable."));}
      });
    } finally {database.close();}
  }

  async load(): Promise<DraftSnapshot> {
    let migrated = false;
    const snapshot = await this.transaction<DraftSnapshot>((transaction, done, fail) => {
      const scopes = transaction.objectStore("scopes");
      const drafts = transaction.objectStore("drafts");
      const request = scopes.get(this.scope);
      request.onsuccess = () => {
        try {
          let metadata = request.result as ScopeRecord | undefined;
          let legacyDrafts: DraftRecord[] = [];
          if (!metadata) {
            const legacy = this.legacy();
            metadata = {scope: this.scope, epoch: crypto.randomUUID(), enabled: legacy.enabled};
            scopes.put(metadata);
            legacyDrafts = legacy.drafts;
            migrated = true;
          }
          if (metadata.scope !== this.scope || typeof metadata.enabled !== "boolean" || typeof metadata.epoch !== "string" || !metadata.epoch || metadata.excludedSessions !== undefined && (!Array.isArray(metadata.excludedSessions) || metadata.excludedSessions.length > 256 || !metadata.excludedSessions.every(id => typeof id === "string" && id.length <= 512))) throw new Error("Draft storage metadata is invalid.");
          const state = metadata;
          const readRows = () => {
          const rows = drafts.index("scope").getAll(this.scope);
          rows.onsuccess = () => {
            try {
            const restored: Record<string, string> = {};
            for (const row of rows.result as DraftRecord[]) {
              if (!state.enabled || !validRecord(row, this.scope, this.now())) drafts.delete([this.scope, row.sessionId]);
              else if (!row.sessionId.startsWith(IMAGE_DRAFT_KEY)) Object.defineProperty(restored, row.sessionId, {value: row.text, enumerable: true, configurable: true, writable: true});
            }
            done({enabled: state.enabled, epoch: state.epoch, drafts: restored});
            } catch (error) {fail(error instanceof Error ? error : new Error("Draft storage is invalid."));}
          };
          };
          if (legacyDrafts.length) reserveDraftBytes(drafts, legacyDrafts, this.now(), readRows, fail);
          else readRows();
        } catch (error) {fail(error instanceof Error ? error : new Error("Old drafts could not be migrated."));}
      };
    });
    this.epoch = snapshot.epoch;
    if (migrated) this.removeLegacy();
    return snapshot;
  }

  async readImages(): Promise<{enabled: boolean; epoch: string; images: Record<string, StoredDraftImage[]>}> {
    const snapshot = await this.load();
    if (!snapshot.enabled) return {enabled: false, epoch: snapshot.epoch, images: {}};
    return this.transaction((transaction, done, fail) => {
      const meta = transaction.objectStore("scopes").get(this.scope);
      meta.onsuccess = () => {
        if (!meta.result?.enabled || meta.result.epoch !== snapshot.epoch) {done({enabled: false, epoch: snapshot.epoch, images: {}}); return;}
        const request = transaction.objectStore("drafts").index("scope").getAll(this.scope);
        request.onsuccess = () => {
          try {
            const images: Record<string, StoredDraftImage[]> = {};
            for (const row of request.result as DraftRecord[]) if (row.sessionId.startsWith(IMAGE_DRAFT_KEY) && validRecord(row, this.scope, this.now())) {
              if (!Array.isArray(row.images) || row.images.length > 8 || !row.images.every(validImage)) throw new Error("Saved images could not be read.");
              images[row.sessionId.slice(IMAGE_DRAFT_KEY.length)] = row.images;
            }
            done({enabled: true, epoch: snapshot.epoch, images});
          } catch (error) {fail(error instanceof Error ? error : new Error("Saved images could not be read."));}
        };
      };
    });
  }

  async writeImages(sessionId: string, images: StoredDraftImage[], epoch = this.epoch): Promise<void> {
    if (!epoch) throw new Error("Draft recovery is no longer enabled for this computer.");
    if (images.length > 8 || !images.every(validImage) || images.reduce((sum, image) => sum + image.blob.size, 0) > 5 * 1024 * 1024) throw new Error("Image drafts exceed the per-message limit.");
    return this.transaction((transaction, done, fail) => {
      const store = transaction.objectStore("drafts");
      const request = transaction.objectStore("scopes").get(this.scope);
      request.onsuccess = () => {
        if (!request.result?.enabled || request.result.epoch !== epoch) {fail(new Error("Draft recovery is no longer enabled for this computer.")); return;}
        reserveDraftBytes(store, [{scope: this.scope, sessionId: IMAGE_DRAFT_KEY + sessionId, text: "", savedAt: this.now(), images}], this.now(), done, fail);
      };
    });
  }

  async enabled(): Promise<boolean> {return (await this.load()).enabled;}
  async read(): Promise<Record<string, string>> {return (await this.load()).drafts;}

  async enable(initial: Record<string, string> = {}): Promise<DraftSnapshot> {
    initial = {...initial};
    if (Object.keys(initial).length > 64 || Object.values(initial).reduce((sum, text) => sum + encoder.encode(text).length, 0) > 4 * MAX_DRAFT_BYTES) throw new Error("Too many draft contents are pending. Keep a copy before closing.");
    for (const text of Object.values(initial)) checkText(text);
    const snapshot = await this.transaction<DraftSnapshot>((transaction, done, fail) => {
      const scopes = transaction.objectStore("scopes");
      const drafts = transaction.objectStore("drafts");
      const request = scopes.get(this.scope);
      request.onsuccess = () => {
        try {
        const existing = request.result as ScopeRecord | undefined;
        const metadata = {scope: this.scope, enabled: true, epoch: existing?.enabled ? existing.epoch : crypto.randomUUID(), ...(existing?.excludedSessions ? {excludedSessions: existing.excludedSessions} : {})};
        if (Object.keys(initial).some(id => metadata.excludedSessions?.includes(id))) throw new Error("Saving this conversation was disabled. Turn history off and on to save it again.");
        scopes.put(metadata);
        reserveDraftBytes(drafts, Object.entries(initial).map(([sessionId, text]) => ({scope: this.scope, sessionId, text, savedAt: this.now()})), this.now(), () => done({...metadata, drafts: initial}), fail);
        } catch (error) {fail(error instanceof Error ? error : new Error("Draft storage is unavailable."));}
      };
    });
    this.epoch = snapshot.epoch;
    this.removeLegacy();
    notify({scope: this.scope, enabled: true, revoked: false, operationId: crypto.randomUUID()});
    return snapshot;
  }

  async write(sessionId: string, text: string, epoch = this.epoch, reconcile?: (previous: string | undefined) => {text: string; savedAt: number} | undefined): Promise<void> {
    checkText(text);
    if (!epoch) throw new Error("Draft recovery is no longer enabled for this computer.");
    await this.transaction<void>((transaction, done, fail) => {
      const request = transaction.objectStore("scopes").get(this.scope);
      request.onsuccess = () => {
        try {
        const metadata = request.result as ScopeRecord | undefined;
        if (!metadata?.enabled || metadata.epoch !== epoch) {fail(new Error("Draft recovery is no longer enabled for this computer."));return;}
        if (metadata.excludedSessions?.includes(sessionId)) {fail(new Error("Saving this conversation was disabled. Turn history off and on to save it again."));return;}
        const drafts = transaction.objectStore("drafts");
        if (reconcile) {
          const previous = drafts.get([this.scope, sessionId]);
          previous.onsuccess = () => {
            try {
              const next = reconcile(previous.result?.text);
              if (!next) {done(); return;}
              checkText(next.text);
              reserveDraftBytes(drafts, [{scope: this.scope, sessionId, ...next}], this.now(), done, fail);
            } catch (error) {fail(error instanceof Error ? error : new Error("History could not be saved."));}
          };
        } else reserveDraftBytes(drafts, [{scope: this.scope, sessionId, text, savedAt: this.now()}], this.now(), done, fail);
        } catch (error) {fail(error instanceof Error ? error : new Error("Draft storage is unavailable."));}
      };
    });
  }

  async excludeSession(sessionId: string): Promise<void> {
    await this.transaction<void>((transaction, done, fail) => {
      const scopes = transaction.objectStore("scopes");
      const request = scopes.get(this.scope);
      request.onsuccess = () => {
        const metadata = request.result as ScopeRecord | undefined;
        if (!metadata?.enabled) {done(); return;}
        const excludedSessions = [...new Set([...(metadata.excludedSessions ?? []), sessionId])];
        if (excludedSessions.length > 256) {fail(new Error("Turn history off to delete all saved conversations before saving more.")); return;}
        scopes.put({...metadata, excludedSessions});
        transaction.objectStore("drafts").delete([this.scope, sessionId]);
        done();
      };
    }, true);
  }

  async excludedSessions(): Promise<string[]> {
    return this.transaction((transaction, done) => {
      const request = transaction.objectStore("scopes").get(this.scope);
      request.onsuccess = () => done(request.result?.excludedSessions ?? []);
    });
  }

  async clear(revoked = false): Promise<void> {
    this.epoch = undefined;
    const pending = clearing.get(this.scope);
    if (pending) {
      if (revoked) {pending.revoked = true;notify({scope: this.scope, enabled: false, revoked, operationId: pending.operationId}, false);}
      return pending.promise;
    }
    const operationId = crypto.randomUUID();
    barriers.set(this.scope, (barriers.get(this.scope) ?? 0) + 1);
    const entry = {promise: Promise.resolve(), operationId, revoked};
    clearing.set(this.scope, entry);
    let previousEpoch: string | null = null;
    const promise = (async () => {
      await this.transaction<void>((transaction, done, fail) => {
        const scopes = transaction.objectStore("scopes");
        const metadata = scopes.get(this.scope);
        metadata.onsuccess = () => {previousEpoch = typeof metadata.result?.epoch === "string" ? metadata.result.epoch : null;};
        scopes.put({scope: this.scope, epoch: crypto.randomUUID(), enabled: false});
        const drafts = transaction.objectStore("drafts");
        const rows = drafts.index("scope").getAllKeys(this.scope);
        rows.onsuccess = () => {
          try {for (const key of rows.result) drafts.delete(key);done();}
          catch (error) {fail(error instanceof Error ? error : new Error("Saved drafts could not be deleted."));}
        };
      }, true);
      this.removeLegacy();
      notify({scope: this.scope, enabled: false, revoked: entry.revoked, operationId, epoch: previousEpoch});
    })();
    entry.promise = promise;
    notify({scope: this.scope, enabled: false, revoked, operationId}, false);
    try {await promise;} finally {if (clearing.get(this.scope)?.promise === promise) clearing.delete(this.scope);}
  }

}

export async function forgetDraftScope(scope: string | undefined): Promise<void> {
  if (scope) {
    const outcomes = await Promise.allSettled([new DraftStore(scope).clear(true), new DraftStore(offlineHistoryScope(scope)).clear(true)]);
    for (const result of outcomes) if (result.status === "rejected") throw result.reason;
  }
}

export function offlineHistoryScope(scope: string): string {return JSON.stringify(["offline-history", scope]);}
