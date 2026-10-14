import {act, renderHook, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import type {ClientResult, LightClient} from "./client";
import type {Operation} from "./protocol";
import {useSessionRuntime} from "./useSessionRuntime";

function deferred() {
  let resolve!: (value: ClientResult<unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ClientResult<unknown>>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const execution = (revision: number, sessionId = "session") => ({ok: true as const, value: {outcome: "sessionExecution", sessionId, revision, paused: false, uncertain: false, queue: []}});
const models = (revision: number, sessionId = "session") => ({ok: true as const, value: {outcome: "sessionModels", sessionId, revision, source: "live", selectableModels: [], effortOptions: [], canSetModel: false, canSetEffort: false, uncertain: false}});

function host() {
  const requests: {operation: Operation; result: ReturnType<typeof deferred>}[] = [];
  const send = vi.fn((operation: Operation) => {const result = deferred(); requests.push({operation, result}); return result.promise;});
  return {client: {send, multiWriter: true} as unknown as LightClient, requests, send};
}

describe("per-conversation runtime refresh", () => {
  it("coalesces event storms and never applies an older revision", async () => {
    const {client, requests, send} = host();
    const hook = renderHook(() => useSessionRuntime(client, true, "session"));
    expect(send).toHaveBeenCalledTimes(2);
    act(() => {for (let i = 0; i < 100; i++) hook.result.current.refresh("session");});
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => {requests[0].result.resolve(execution(8)); requests[1].result.resolve(models(9));});
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    await act(async () => {requests[2].result.resolve(execution(7)); requests[3].result.resolve(models(4));});
    expect(hook.result.current.execution.session.revision).toBe(8);
    expect(hook.result.current.models.session.revision).toBe(9);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("accepts independent successes and rejects data from a previous connection", async () => {
    const {client, requests} = host();
    const hook = renderHook(({connected}) => useSessionRuntime(client, connected, "session"), {initialProps: {connected: true}});
    await act(async () => {requests[0].result.resolve(execution(2)); requests[1].result.reject(new Error("network"));});
    expect(hook.result.current.execution.session.revision).toBe(2);
    expect(hook.result.current.models).toEqual({});
    act(() => hook.result.current.refresh("session"));
    hook.rerender({connected: false});
    expect(hook.result.current.execution).toEqual({});
    hook.rerender({connected: true});
    await act(async () => {requests[2].result.resolve(execution(500)); requests[3].result.resolve(models(500)); requests[4].result.resolve(execution(1)); requests[5].result.resolve(models(1));});
    expect(hook.result.current.execution.session.revision).toBe(1);
    expect(hook.result.current.models.session.revision).toBe(1);
  });

  it("keeps each conversation and host isolated while a fetch is in flight", async () => {
    const first = host();
    const second = host();
    const hook = renderHook(({client, sessionId}) => useSessionRuntime(client, true, sessionId), {initialProps: {client: first.client, sessionId: "session"}});
    hook.rerender({client: first.client, sessionId: "other"});
    await act(async () => {first.requests[0].result.resolve(execution(3)); first.requests[1].result.resolve(models(3)); first.requests[2].result.resolve(execution(4, "other")); first.requests[3].result.resolve(models(4, "wrong"));});
    expect(Object.keys(hook.result.current.execution)).toEqual(["session", "other"]);
    expect(hook.result.current.models.other).toBeUndefined();
    act(() => hook.result.current.refresh("session"));
    hook.rerender({client: second.client, sessionId: "session"});
    await act(async () => {first.requests[4].result.resolve(execution(20)); first.requests[5].result.resolve(models(20)); second.requests[0].result.resolve(execution(1)); second.requests[1].result.resolve(models(1));});
    expect(hook.result.current.execution).toEqual({session: execution(1).value});
    expect(hook.result.current.models).toEqual({session: models(1).value});
  });

  it("does not send v4 operations before negotiation or while disconnected", () => {
    const {client, send} = host();
    Object.defineProperty(client, "multiWriter", {value: false});
    const hook = renderHook(() => useSessionRuntime(client, true, "session"));
    act(() => hook.result.current.refresh("session"));
    expect(send).not.toHaveBeenCalled();
  });
});
