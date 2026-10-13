import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import { DraftStore, DRAFT_TTL_MS, draftScopePrefix, managedDraftScope, privateDraftScope } from "./drafts";
import { remoteExperimentEnabled } from "./experiments";

const host = {id: "host", publicKey: "a".repeat(64), installationId: "installation"};
const scope = managedDraftScope("account", host)!;
beforeEach(() => localStorage.clear());
afterEach(() => {vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("opt-in durable drafts", () => {
  it("is excluded from ordinary builds and refuses writes without consent", async () => {
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "");
    expect(remoteExperimentEnabled("drafts")).toBe(false);
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "not-drafts");
    expect(remoteExperimentEnabled("drafts")).toBe(false);
    vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "drafts");
    expect(remoteExperimentEnabled("drafts")).toBe(true);
    const store = new DraftStore(scope);
    expect(await store.enabled()).toBe(false);
    await expect(store.write("session", "unsent")).rejects.toThrow();
    expect(localStorage.length).toBe(0);
  });
  it("acknowledges only strict transaction completion and recovers exact text", async () => {
    const store = new DraftStore(scope);
    await store.enable({one: "🙂\nunsent\"!", two: "different"});
    let committed = false;
    const underlying = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names, mode, options) {
      expect(options?.durability).toBe("strict");
      const value = underlying.call(this, names, mode, options);
      value.addEventListener("complete", () => {committed = true;});
      return value;
    });
    await store.write("one", "latest🙂");
    expect(committed).toBe(true);
    expect(await new DraftStore(scope).read()).toEqual({one: "latest🙂", two: "different"});
    await store.write("one", "");
    expect(await new DraftStore(scope).read()).toEqual({two: "different"});
  });
  it("separates account, host key, installation, host ID and session", async () => {
    const store = new DraftStore(scope);
    await store.enable({"same-session": "private draft"});
    const scopes = [managedDraftScope("other", host), managedDraftScope("account", {...host, publicKey: "b".repeat(64)}), managedDraftScope("account", {...host, installationId: "other"}), managedDraftScope("account", {...host, id: "other"})];
    for (const other of scopes) expect(await new DraftStore(other!).read()).toEqual({});
    expect(managedDraftScope(undefined, host)).toBeUndefined();
    expect(managedDraftScope("account", {...host, installationId: ""})).toBeUndefined();
    expect(privateDraftScope("https://private.example", undefined, "browser")).toBeUndefined();
    expect(privateDraftScope("https://private.example", "install", "one")).not.toBe(privateDraftScope("https://private.example", "install", "two"));
  });
  it("expires at exactly seven days", async () => {
    let now = 1000;
    const store = new DraftStore(scope, localStorage, () => now);
    await store.enable({session: "old"});
    now += DRAFT_TTL_MS - 1;
    expect(await store.read()).toEqual({session: "old"});
    now += 1;
    expect(await store.read()).toEqual({});
  });
  it("migrates valid v1 entries once and removes invalid, expired and future entries", async () => {
    const prefix = draftScopePrefix(scope);
    localStorage.setItem(`${prefix}consent`, "yes");
    localStorage.setItem(`${prefix}session:valid`, JSON.stringify({text: "valid", savedAt: Date.now()}));
    localStorage.setItem(`${prefix}session:future`, JSON.stringify({text: "future", savedAt: Date.now() + 60000}));
    localStorage.setItem(`${prefix}session:expired`, JSON.stringify({text: "expired", savedAt: Date.now() - DRAFT_TTL_MS}));
    localStorage.setItem(`${prefix}session:bad`, "broken");
    localStorage.setItem(`${prefix}session:%`, JSON.stringify({text: "bad key", savedAt: Date.now()}));
    expect(await new DraftStore(scope).read()).toEqual({valid: "valid"});
    expect(localStorage.length).toBe(0);
    localStorage.setItem(`${prefix}session:valid`, JSON.stringify({text: "stale", savedAt: Date.now()}));
    expect(await new DraftStore(scope).read()).toEqual({valid: "valid"});
  });
  it("preserves legacy storage if its migration transaction aborts", async () => {
    const prefix = draftScopePrefix(scope);
    localStorage.setItem(`${prefix}consent`, "yes");
    localStorage.setItem(`${prefix}session:valid`, JSON.stringify({text: "recover", savedAt: Date.now()}));
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {throw new DOMException("Full", "QuotaExceededError");});
    await expect(new DraftStore(scope).read()).rejects.toThrow();
    expect(localStorage.getItem(`${prefix}session:valid`)).not.toBeNull();
    vi.restoreAllMocks();
    expect(await new DraftStore(scope).read()).toEqual({valid: "recover"});
  });
  it("makes consent and the initial content atomic on failure", async () => {
    const store = new DraftStore(scope);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "drafts") throw new DOMException("Full", "QuotaExceededError");
      return original.call(this, value, key);
    });
    await expect(store.enable({session: "unsent"})).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await store.enabled()).toBe(false);
    expect(await store.read()).toEqual({});
  });
  it("serializes rapid writes in invocation order", async () => {
    const store = new DraftStore(scope);
    await store.enable();
    await Promise.all(Array.from({length: 30}, (_, index) => store.write("session", String(index))));
    expect(await store.read()).toEqual({session: "29"});
  });
  it("cancels obsolete queued writes before performing a deletion", async () => {
    const store = new DraftStore(scope);
    await store.enable({session: "original"});
    const writes = Array.from({length: 30}, (_, index) => store.write("session", String(index)));
    const settled = Promise.allSettled(writes);
    await store.clear(true);
    expect((await settled).every(value => value.status === "rejected")).toBe(true);
    expect(await store.read()).toEqual({});
  });
  it("preserves the deletion barrier while an active open completes and queued writes are cancelled", async () => {
    const store = new DraftStore(scope);
    await store.enable({session: "original"});
    let release!: () => void;
    let opened!: () => void;
    const opening = new Promise<void>(resolve => {opened = resolve;});
    const original = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementationOnce((...args) => {
      const request = original(...args);
      Object.defineProperty(request, "onsuccess", {set(handler) {
        request.addEventListener("success", event => {release = () => handler.call(request, event);opened();}, {once: true});
      }});
      return request;
    });
    const active = store.write("session", "active");
    await opening;
    const queued = Promise.allSettled([store.write("session", "queued1"), store.write("session", "queued2")]);
    const clearing = store.clear(true);
    release();
    await active;
    await clearing;
    expect((await queued).every(value => value.status === "rejected")).toBe(true);
    expect(await store.read()).toEqual({});
  });
  it("joins concurrent cleanup for the same scope without reporting a false failure", async () => {
    const store = new DraftStore(scope);
    await store.enable({session: "remove"});
    await Promise.all([store.clear(), new DraftStore(scope).clear(true), store.clear(true)]);
    expect(await store.read()).toEqual({});
    expect(await store.enabled()).toBe(false);
  });
  it("invalidates stale consent epochs across clear and re-enable", async () => {
    const store = new DraftStore(scope);
    const stale = new DraftStore(scope);
    const unrelated = new DraftStore(managedDraftScope("other", host)!);
    await store.enable({session: "sensitive"});
    const old = await stale.load();
    await unrelated.enable({session: "keep"});
    await store.clear(true);
    await store.enable({session: "new consent"});
    await expect(stale.write("session", "resurrected", old.epoch)).rejects.toThrow();
    expect(await store.read()).toEqual({session: "new consent"});
    expect(await unrelated.read()).toEqual({session: "keep"});
  });
  it("does not resurrect v1 entries even if deletion could not clean localStorage", async () => {
    const prefix = draftScopePrefix(scope);
    const store = new DraftStore(scope);
    await store.enable({session: "sensitive"});
    localStorage.setItem(`${prefix}consent`, "yes");
    localStorage.setItem(`${prefix}session:old`, JSON.stringify({text: "old", savedAt: Date.now()}));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {throw new DOMException("Denied", "SecurityError");});
    await expect(store.clear()).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await new DraftStore(scope).read()).toEqual({});
    expect(await new DraftStore(scope).enabled()).toBe(false);
  });
  it("refuses oversized UTF8 writes without erasing the saved draft", async () => {
    const store = new DraftStore(scope);
    await store.enable({session: "keep"});
    await expect(store.write("session", "🙂".repeat(262145))).rejects.toThrow(/too large/);
    expect(await store.read()).toEqual({session: "keep"});
  });
});
