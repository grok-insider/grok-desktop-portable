import {afterEach, expect, it, vi} from "vitest";
import {deleteGrant, readGrant, writeGrant, type Grant} from "./remoteDevice";

afterEach(() => vi.unstubAllGlobals());

it.each(["read", "write", "delete"])("reports denied IndexedDB access while attempting to %s a device", async (operation) => {
  vi.stubGlobal("indexedDB", {open: () => {throw new DOMException("Access denied", "SecurityError");}});
  const result = operation === "read" ? readGrant("host") : operation === "delete" ? deleteGrant("host") : writeGrant("host", {hostPublicKey: "a".repeat(64), privateKey: new Uint8Array(32)});
  await expect(result).rejects.toThrow("device_storage_unavailable");
});

function storageFixture() {
  const values = new Map<string, Grant>();
  const transactions: Array<{
    oncomplete?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    abort: ReturnType<typeof vi.fn>;
    commit: () => void;
    objectStore: () => {put: (value: Grant, key: string) => void; delete: (key: string) => void};
  }> = [];
  const close = vi.fn();
  const db = {
    close,
    transaction() {
      let apply: () => void = () => {};
      let aborted = false;
      const transaction: (typeof transactions)[number] = {
        abort: vi.fn(() => {aborted = true; transaction.onabort?.();}),
        commit() {if (!aborted) {apply(); transaction.oncomplete?.();}},
        objectStore: () => ({
          put: (value, key) => {apply = () => {values.set(key, value);};},
          delete: (key) => {apply = () => {values.delete(key);};},
        }),
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  const opens: Array<{result: typeof db; onsuccess?: () => void}> = [];
  vi.stubGlobal("indexedDB", {open() {const request = {result: db}; opens.push(request); return request;}});
  return {values, transactions, close, open: (index: number) => opens[index].onsuccess?.()};
}

it.each(["write", "delete"])("does not %s a newer grant when aborted during database opening", async (operation) => {
  const storage = storageFixture();
  const old: Grant = {hostPublicKey: "old", privateKey: new Uint8Array(32).fill(1)};
  const current: Grant = {hostPublicKey: "current", privateKey: new Uint8Array(32).fill(2)};
  const controller = new AbortController();
  const pending = operation === "write" ? writeGrant("host", old, controller.signal) : deleteGrant("host", controller.signal);
  const outcome = expect(pending).rejects.toMatchObject({name: "AbortError"});
  controller.abort();
  const replacement = writeGrant("host", current);
  storage.open(1);
  await vi.waitFor(() => expect(storage.transactions).toHaveLength(1));
  storage.transactions[0].commit();
  await replacement;
  storage.open(0);
  await outcome;
  expect(storage.values.get("host")).toBe(current);
  expect(storage.transactions).toHaveLength(1);
  expect(storage.close).toHaveBeenCalledTimes(2);
});

it.each(["write", "delete"])("aborts a pending %s transaction before it can affect a newer grant", async (operation) => {
  const storage = storageFixture();
  const old: Grant = {hostPublicKey: "old", privateKey: new Uint8Array(32).fill(1)};
  const current: Grant = {hostPublicKey: "current", privateKey: new Uint8Array(32).fill(2)};
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = operation === "write" ? writeGrant("host", old, controller.signal) : deleteGrant("host", controller.signal);
  const outcome = expect(pending).rejects.toMatchObject({name: "AbortError"});
  storage.open(0);
  await vi.waitFor(() => expect(storage.transactions).toHaveLength(1));
  controller.abort();
  await outcome;
  const replacement = writeGrant("host", current);
  storage.open(1);
  await vi.waitFor(() => expect(storage.transactions).toHaveLength(2));
  storage.transactions[1].commit();
  await replacement;
  storage.transactions[0].commit();
  expect(storage.transactions[0].abort).toHaveBeenCalledOnce();
  expect(storage.values.get("host")).toBe(current);
  for (const [name, callback] of add.mock.calls) expect(remove).toHaveBeenCalledWith(name, callback);
  expect(storage.close).toHaveBeenCalledTimes(2);
});

it("removes the cancellation listener after a successful storage transaction", async () => {
  const storage = storageFixture();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = writeGrant("host", {hostPublicKey: "current", privateKey: new Uint8Array(32)}, controller.signal);
  storage.open(0);
  await vi.waitFor(() => expect(storage.transactions).toHaveLength(1));
  storage.transactions[0].commit();
  await pending;
  for (const [name, callback] of add.mock.calls) expect(remove).toHaveBeenCalledWith(name, callback);
  controller.abort();
  expect(storage.transactions[0].abort).not.toHaveBeenCalled();
  expect(storage.values.has("host")).toBe(true);
});
