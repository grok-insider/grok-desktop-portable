import {afterEach, describe, expect, it, vi} from "vitest";
import {CommandReceiptStore} from "./commandReceipts";
import type {LightClient} from "./client";

const operation = {kind: "prompt" as const, sessionId: "session", text: "private message"};
const client = (send: ReturnType<typeof vi.fn>) => ({send}) as unknown as LightClient;
afterEach(() => {sessionStorage.clear(); vi.restoreAllMocks();});

describe("durable command receipt gate", () => {
  it("writes intent before dispatch and blocks another effect after a lost reply, including after reload", async () => {
    const send = vi.fn(async () => {
      expect(JSON.parse(sessionStorage.getItem("grok-command-receipts.v1:computer")!)).toEqual([expect.objectContaining({sessionId: "session", kind: "prompt", state: "sending"})]);
      throw new Error("connection_lost");
    });
    const store = new CommandReceiptStore(client(send), "computer");
    expect((await store.submit("session", operation)).ok).toBe(false);
    const key = store.pending[0].key;
    expect(sessionStorage.getItem("grok-command-receipts.v1:computer")).not.toContain("private message");
    expect((await store.submit("session", operation)).ok).toBe(false);
    const restored = new CommandReceiptStore(client(send), "computer");
    expect(restored.pending[0]).toMatchObject({key, state: "uncertain"});
    expect((await restored.submit("session", operation)).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["queue_storage_unavailable", "result_not_durable", "completion_not_durable", "agent_failed", "idempotency_conflict"])("retains the receipt after the ambiguous host refusal %s", async code => {
    const send = vi.fn(async () => ({ok: false, failure: {kind: "refused", code}}));
    const store = new CommandReceiptStore(client(send), "computer");
    await store.submit("session", operation);
    await store.submit("session", operation);
    expect(store.pending).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["queue_full", "queue_revision_conflict", "turn_changed"])("allows correction after the definite refusal %s", async code => {
    const send = vi.fn(async () => ({ok: false, failure: {kind: "refused", code}}));
    const store = new CommandReceiptStore(client(send), "computer");
    await store.submit("session", operation);
    expect(store.pending).toEqual([]);
    await store.submit("session", operation);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("queries only the saved receipt and requires review before releasing an uncertain draft", async () => {
    const send = vi.fn().mockResolvedValueOnce({ok: false, failure: {kind: "unreachable"}});
    const store = new CommandReceiptStore(client(send), "computer");
    await store.submit("session", operation);
    const key = store.pending[0].key;
    send.mockResolvedValueOnce({ok: true, value: {outcome: "commandStatus", idempotencyKey: key, state: "queued"}});
    expect(await store.check("session")).toMatchObject({key, state: "queued"});
    expect(send.mock.calls[1]).toEqual([{kind: "getCommandStatus", idempotencyKey: key}]);
    await store.submit("session", operation);
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.acknowledge("session", "different-key")).toBe(false);
    expect(store.acknowledge("session", key)).toBe(true);
    expect(store.pending).toEqual([]);
  });

  it.each(["needsReview", "unknown", "invalid"])("keeps %s outcomes unresolved without retrying their operation", async state => {
    const send = vi.fn().mockResolvedValueOnce({ok: false, failure: {kind: "unreachable"}});
    const store = new CommandReceiptStore(client(send), "computer");
    await store.submit("session", operation);
    send.mockResolvedValueOnce(state === "unknown" ? {ok: false, failure: {kind: "refused", code: "unknown_command"}} : {ok: true, value: {outcome: "commandStatus", state}});
    expect(await store.check("session")).toMatchObject({state: state === "invalid" ? "uncertain" : state});
    expect((await store.submit("session", operation)).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails before dispatch if intent storage is unavailable or corrupt", async () => {
    const send = vi.fn();
    sessionStorage.setItem("grok-command-receipts.v1:corrupt", "[{}");
    const corrupt = new CommandReceiptStore(client(send), "corrupt");
    expect((await corrupt.submit("session", operation)).ok).toBe(false);
    const unavailable = new CommandReceiptStore(client(send), "unavailable");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
    expect((await unavailable.submit("session", operation)).ok).toBe(false);
    expect(unavailable.storageFailed).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("retains a durable uncertain record when storing the acknowledgement fails", async () => {
    const send = vi.fn(async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("quota");});
      return {ok: true, value: {outcome: "commandAccepted", state: "queued"}};
    });
    const store = new CommandReceiptStore(client(send), "computer");
    expect((await store.submit("session", operation)).ok).toBe(false);
    vi.restoreAllMocks();
    const restored = new CommandReceiptStore(client(send), "computer");
    expect(restored.pending).toEqual([expect.objectContaining({state: "uncertain"})]);
    expect((await restored.submit("session", operation)).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["queued", "running", "completed"])("releases a confirmed %s receipt without retaining message contents", async state => {
    const send = vi.fn(async () => ({ok: true, value: {outcome: "commandAccepted", state}}));
    const store = new CommandReceiptStore(client(send), "computer");
    expect((await store.submit("session", operation)).ok).toBe(true);
    expect(store.pending).toEqual([]);
    expect(sessionStorage.getItem("grok-command-receipts.v1:computer")).toBe("[]");
  });
});

it.each([
  {outcome: "unrelated"},
  {outcome: "promptAccepted"},
  {outcome: "commandAccepted", state: "queued", sessionId: "another-session"},
  {outcome: "commandAccepted", state: "queued", idempotencyKey: "another-command"},
])("keeps a v4 prompt unresolved when its result is not a matching acknowledgement: %j", async value => {
  const send = vi.fn(async () => ({ok: true, value}));
  const target = client(send);
  Object.defineProperty(target, "multiWriter", {value: true});
  const store = new CommandReceiptStore(target, "computer");
  expect((await store.submit("session", operation)).ok).toBe(false);
  expect(store.pending).toEqual([expect.objectContaining({state: "uncertain"})]);
});

it("requires a valid configuration projection from the intended session", async () => {
  const model = {outcome: "sessionModels", sessionId: "session", revision: 1, source: "live", selectableModels: [], effortOptions: [], canSetModel: false, canSetEffort: false, uncertain: false};
  const send = vi.fn().mockResolvedValueOnce({ok: true, value: {...model, sessionId: "another-session"}}).mockResolvedValueOnce({ok: true, value: model});
  const store = new CommandReceiptStore(client(send), "computer");
  const change = {kind: "setSessionConfiguration" as const, sessionId: "session", expectedConfigRevision: 0, modelId: "grok"};
  expect((await store.submit("session", change)).ok).toBe(false);
  expect(store.acknowledge("session", store.pending[0].key)).toBe(true);
  expect((await store.submit("session", change)).ok).toBe(true);
  expect(store.pending).toEqual([]);
});

it("cannot recreate purged metadata or dispatch to another pairing after an authority change", async () => {
  let finish!: (reply: unknown) => void;
  const send = vi.fn(() => new Promise(resolve => {finish = resolve;}));
  const target = client(send);
  let authority: string | undefined = "original";
  Object.defineProperty(target, "receiptScope", {get: () => authority});
  const store = new CommandReceiptStore(target, "computer");
  const pending = store.submit("session", operation);
  expect(sessionStorage.getItem("grok-command-receipts.v1:computer")).not.toBeNull();
  authority = undefined;
  sessionStorage.removeItem("grok-command-receipts.v1:computer");
  finish({ok: true, value: {outcome: "commandAccepted", state: "queued"}});
  expect(await pending).toEqual({ok: false, failure: {kind: "not_paired"}});
  expect(sessionStorage.getItem("grok-command-receipts.v1:computer")).toBeNull();
  expect(await store.submit("session", operation)).toEqual({ok: false, failure: {kind: "not_paired"}});
  expect(await store.check("session")).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
