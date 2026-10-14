import {useMemo, useSyncExternalStore} from "react";
import {commandReceipt, type ClientFailure, type ClientResult, type LightClient} from "./client";
import type {Operation} from "./protocol";
import {asSessionExecution, asSessionModels} from "./sessionExecution";

export type PendingCommandState = "sending" | "uncertain" | "unknown" | "queued" | "running" | "completed" | "failed" | "removed" | "needsReview" | "reviewed";
export interface PendingCommand {
  key: string;
  sessionId: string;
  kind: Operation["kind"];
  state: PendingCommandState;
  createdAt: number;
}

export interface CommandReceipts {
  pending: readonly PendingCommand[];
  storageFailed: boolean;
  submit(sessionId: string, operation: Operation): Promise<ClientResult<unknown>>;
  check(sessionId: string): Promise<PendingCommand | null>;
  acknowledge(sessionId: string, key: string): boolean;
}

const STATES: readonly string[] = ["sending", "uncertain", "unknown", "queued", "running", "completed", "failed", "removed", "needsReview", "reviewed"];
const REJECTED_BEFORE_EFFECT = new Set([
  "request_too_large", "queue_full", "queue_byte_limit", "command_history_full", "too_many_commands", "too_many_sessions", "idempotency_key_required",
  "queue_revision_conflict", "queue_revision_exhausted", "configuration_conflict", "invalid_configuration_change", "model_unavailable", "effort_not_supported", "turn_changed", "session_busy", "unknown_session", "unknown_workspace", "unknown_queue_entry",
  "remote_shell_disabled", "empty_prompt", "image_not_supported", "image_unavailable", "image_integrity", "invalid_command", "session_invalid", "client_upgrade_required",
  "targeted_cancel_unsupported", "targeted_interrupt_required", "unsupported_model", "unsupported_reasoning_effort",
]);

export function commandDefinitelyRejected(failure: ClientFailure): boolean {
  return failure.kind === "bad_request" || failure.kind === "protocol_mismatch" || failure.kind === "rejected"
    || (failure.kind === "refused" && REJECTED_BEFORE_EFFECT.has(failure.code));
}

const failure = (code: string): ClientResult<unknown> => ({ok: false, failure: {kind: "refused", code}});

function acceptedResult(operation: Operation, value: unknown, key: string, multiWriter: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as {outcome?: string; sessionId?: string};
  if (result.sessionId !== undefined && (!("sessionId" in operation) || result.sessionId !== operation.sessionId)) return false;
  if (result.outcome === "commandStatus" || result.outcome === "commandAccepted") return commandReceipt(value, key) !== null;
  if (!multiWriter && ["prompt", "sendNow", "promptContent"].includes(operation.kind)) return result.outcome === "promptAccepted" || result.outcome === "promptQueued";
  if (operation.kind === "setSessionConfiguration") return asSessionModels(value)?.sessionId === operation.sessionId;
  if (["removeQueued", "setQueuePaused", "clearQueuedPrompts", "reviewUncertainTurn", "cancelSessionTurn"].includes(operation.kind) && "sessionId" in operation) return asSessionExecution(value)?.sessionId === operation.sessionId;
  return false;
}


export class CommandReceiptStore {
  #client: LightClient;
  #authority: string | undefined;
  #key: string;
  #pending: readonly PendingCommand[] = [];
  #storageFailed = false;
  #listeners = new Set<() => void>();
  #checking = new Map<string, Promise<PendingCommand | null>>();

  constructor(client: LightClient, scope: string) {
    this.#client = client;
    this.#authority = client.receiptScope;
    this.#key = `grok-command-receipts.v1:${scope}`;
    try {
      const raw = sessionStorage.getItem(this.#key);
      if (!raw) return;
      if (raw.length > 64 * 1024) throw new Error();
      const stored: unknown = JSON.parse(raw);
      if (!Array.isArray(stored) || stored.length > 64 || stored.some(row => !row || typeof row !== "object" || Array.isArray(row)
        || typeof row.key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.key)
        || typeof row.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.sessionId)
        || typeof row.kind !== "string" || !/^[a-zA-Z]{1,64}$/.test(row.kind)
        || !STATES.includes(row.state) || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0)
        || new Set(stored.map(row => row.sessionId)).size !== stored.length) throw new Error();
      this.#pending = stored.map(({key, sessionId, kind, state, createdAt}) => ({key, sessionId, kind, state: state === "sending" ? "uncertain" : state, createdAt}));
    } catch {this.#storageFailed = true;}
  }

  get pending(): readonly PendingCommand[] {return this.#pending;}
  get storageFailed(): boolean {return this.#storageFailed;}
  snapshot = (): readonly PendingCommand[] => this.#pending;
  subscribe = (listener: () => void): (() => void) => {this.#listeners.add(listener); return () => {this.#listeners.delete(listener);};};
  #notify() {for (const listener of this.#listeners) listener();}
  #commit(pending: readonly PendingCommand[]): boolean {
    if (this.#authority !== this.#client.receiptScope) {
      this.#pending = [];
      this.#notify();
      return false;
    }
    try {
      sessionStorage.setItem(this.#key, JSON.stringify(pending));
      this.#pending = pending;
      this.#storageFailed = false;
      this.#notify();
      return true;
    } catch {
      this.#storageFailed = true;
      this.#pending = this.#pending.map(row => row.state === "sending" ? {...row, state: "uncertain"} : row);
      this.#notify();
      return false;
    }
  }

  acknowledge = (sessionId: string, key: string): boolean => {
    const entry = this.#pending.find(row => row.sessionId === sessionId && row.key === key);
    if (!entry || entry.state === "sending" || this.#checking.has(sessionId)) return false;
    if (!this.#commit(this.#pending.filter(row => row !== entry))) return false;
    this.#client.acknowledgeCommandReceipt?.(key);
    return true;
  };

  submit = async (sessionId: string, operation: Operation): Promise<ClientResult<unknown>> => {
    if (this.#authority !== this.#client.receiptScope) return {ok: false, failure: {kind: "not_paired"}};
    if (this.#storageFailed) return failure("receipt_storage_unavailable");
    if (this.#pending.some(row => row.sessionId === sessionId)) return failure("command_outcome_unresolved");
    if (this.#pending.length >= 64) return failure("command_history_full");
    if (!("sessionId" in operation) || operation.sessionId !== sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return failure("invalid_command");
    const pending: PendingCommand = {key: crypto.randomUUID(), sessionId, kind: operation.kind, state: "sending", createdAt: Date.now()};
    if (!this.#commit([...this.#pending, pending])) return failure("receipt_storage_unavailable");
    const reply = await this.#client.send(operation, {idempotencyKey: pending.key}).catch(() => ({ok: false, failure: {kind: "unreachable"}} as const));
    if (this.#authority !== this.#client.receiptScope) return {ok: false, failure: {kind: "not_paired"}};
    const result = reply.ok && reply.value && typeof reply.value === "object" ? reply.value as {outcome?: string} : null;
    const receipt = commandReceipt(result, pending.key);
    const validResult = acceptedResult(operation, result, pending.key, this.#client.multiWriter);
    const uncertainReceipt = receipt?.state === "needsReview";
    const settled = (reply.ok && validResult && !uncertainReceipt) || (!reply.ok && commandDefinitelyRejected(reply.failure));
    if (!this.#commit(settled ? this.#pending.filter(row => row.key !== pending.key) : this.#pending.map(row => row.key === pending.key ? {...row, state: uncertainReceipt ? "needsReview" : "uncertain"} : row))) return failure("receipt_storage_unavailable");
    if (settled) this.#client.acknowledgeCommandReceipt?.(pending.key);
    if (reply.ok && (!validResult || uncertainReceipt)) return failure("command_outcome_unresolved");
    if (receipt?.state === "failed" || receipt?.state === "removed") return failure(receipt.error ?? (receipt.state === "failed" ? "command_failed" : "command_removed"));
    return reply;
  };

  check = (sessionId: string): Promise<PendingCommand | null> => {
    if (this.#authority !== this.#client.receiptScope) return Promise.resolve(null);
    const previous = this.#checking.get(sessionId);
    if (previous) return previous;
    const pending = this.#pending.find(row => row.sessionId === sessionId);
    if (!pending || pending.state === "sending") return Promise.resolve(pending ?? null);
    const attempt = (async () => {
      const reply = await this.#client.send({kind: "getCommandStatus", idempotencyKey: pending.key}).catch(() => ({ok: false, failure: {kind: "unreachable"}} as const));
      if (this.#authority !== this.#client.receiptScope) return null;
      const status = reply.ok && reply.value && typeof reply.value === "object" ? reply.value as {sessionId?: string} : null;
      const receipt = reply.ok && (status?.sessionId === undefined || status.sessionId === sessionId) ? commandReceipt(reply.value, pending.key) : null;
      const state: PendingCommandState = receipt?.state ?? (!reply.ok && reply.failure.kind === "refused" && reply.failure.code === "unknown_command" ? "unknown" : "uncertain");
      const current = this.#pending.find(row => row.key === pending.key);
      if (!current) return null;
      const next = {...current, state};
      if (!this.#commit(this.#pending.map(row => row === current ? next : row))) return current;
      return next;
    })();
    this.#checking.set(sessionId, attempt);
    void attempt.finally(() => {if (this.#checking.get(sessionId) === attempt) this.#checking.delete(sessionId);});
    return attempt;
  };
}

export function useCommandReceipts(client: LightClient, scope: string): CommandReceipts {
  const store = useMemo(() => new CommandReceiptStore(client, scope), [client, scope]);
  const pending = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return {pending, storageFailed: store.storageFailed, submit: store.submit, check: store.check, acknowledge: store.acknowledge};
}
