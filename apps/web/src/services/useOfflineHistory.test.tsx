import {act, renderHook, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {useOfflineHistory} from "./useOfflineHistory";
import {OfflineHistoryStore, type HistorySnapshot} from "./offlineHistory";
import {EMPTY_PROJECTION, type Projections} from "./sessionProjection";
import {forgetDraftScope} from "./drafts";

const projections: Projections = {s: {...EMPTY_PROJECTION, transcript: [{id: "m", role: "user", text: "Synthetic transcript", seq: 1}]}};
afterEach(() => {vi.restoreAllMocks();});

it("does not save without consent, saves after consent, and removes on revocation", async () => {
  const hook = renderHook(() => useOfflineHistory("a", projections));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect((await new OfflineHistoryStore("a").load()).conversations).toEqual([]);
  await act(async () => {await hook.result.current.action("enable");});
  await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1), {timeout: 2500});
  await act(async () => {await forgetDraftScope("a");});
  expect(hook.result.current.conversations).toEqual([]);
  expect(hook.result.current.enabled).toBe(false);
});

it("does not show another computer's copy after a scope switch or accept a late load", async () => {
  let release!: (value: HistorySnapshot) => void;
  const original = OfflineHistoryStore.prototype.load;
  vi.spyOn(OfflineHistoryStore.prototype, "load").mockImplementation(function (this: OfflineHistoryStore) {
    if (this.scope.includes('slow')) return new Promise(resolve => {release = resolve;});
    return original.call(this);
  });
  const hook = renderHook(({scope}) => useOfflineHistory(scope), {initialProps: {scope: "slow"}});
  hook.rerender({scope: "fresh"});
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {release({enabled: true, epoch: "old", excluded: [], conversations: [{version: 1, sessionId: "s", savedAt: Date.now(), messages: [{id: "m", role: "user", text: "old private copy", seq: 1, unavailableImages: 0}], tools: []}]});});
  expect(hook.result.current.enabled).toBe(false);
  expect(hook.result.current.conversations).toEqual([]);
});

it("deletion from another view prevents a mounted live projection from saving it again", async () => {
  const hook = renderHook(({values}) => useOfflineHistory("a", values), {initialProps: {values: projections}});
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {await hook.result.current.action("enable");});
  await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1), {timeout: 2500});
  await act(async () => {await new OfflineHistoryStore("a").remove("s");});
  await waitFor(() => expect(hook.result.current.excluded).toEqual(["s"]));
  hook.rerender({values: {s: {...projections.s, transcript: [{id: "new", role: "user", text: "later", seq: 2}]}}});
  expect(hook.result.current.conversations).toEqual([]);
  await expect(new OfflineHistoryStore("a").save("s", projections.s, hook.result.current.epoch)).rejects.toThrow(/disabled/);
});

it("reopening identical content under new snapshot ids does not renew its expiry", async () => {
  const store = new OfflineHistoryStore("a");
  await store.enable(); await store.save("s", projections.s, (await store.load()).epoch);
  const before = (await store.load()).conversations[0].savedAt;
  const save = vi.spyOn(OfflineHistoryStore.prototype, "save");
  const hook = renderHook(() => useOfflineHistory("a", {s: {...projections.s, transcript: [{...projections.s.transcript[0], id: "restored-0", seq: -10}]}}));
  await waitFor(() => expect(hook.result.current.conversations).toHaveLength(1));
  await act(async () => {await new Promise(resolve => setTimeout(resolve, 1100));});
  expect(save).not.toHaveBeenCalled();
  expect((await store.load()).conversations[0].savedAt).toBe(before);
});

it("keeps one save batch and coalesces later sessions to their latest projection", async () => {
  let release!: () => void;
  const original = OfflineHistoryStore.prototype.save;
  let held = false, active = 0, maximum = 0;
  const writes: Array<[string, string]> = [];
  vi.spyOn(OfflineHistoryStore.prototype, "save").mockImplementation(async function (this: OfflineHistoryStore, id, projection, epoch) {
    active++; maximum = Math.max(maximum, active);
    writes.push([id, projection.transcript[0].text]);
    if (id === "a" && !held) {held = true; await new Promise<void>(resolve => {release = resolve;});}
    try {await original.call(this, id, projection, epoch);} finally {active--;}
  });
  const value = (text: string) => ({...EMPTY_PROJECTION, transcript: [{id: "m", role: "user" as const, text, seq: 1}]});
  const hook = renderHook(({values}) => useOfflineHistory("a", values), {initialProps: {values: {a: value("a-old"), b: value("b-old")}}});
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {await hook.result.current.action("enable");});
  await waitFor(() => expect(held).toBe(true), {timeout: 2500});
  hook.rerender({values: {a: value("a-new"), b: value("b-new")}});
  await act(async () => {await new Promise(resolve => setTimeout(resolve, 1100));});
  expect(writes).toEqual([["a", "a-old"]]);
  await act(async () => {release();});
  await waitFor(() => expect(hook.result.current.saving).toBe(false), {timeout: 3000});
  expect(maximum).toBe(1);
  expect(writes).toEqual([["a", "a-old"], ["b", "b-new"], ["a", "a-new"]]);
  expect((await new OfflineHistoryStore("a").load()).conversations.map(row => row.messages[0].text).sort()).toEqual(["a-new", "b-new"]);
});
