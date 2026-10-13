import {expect, it} from "vitest";
import {OfflineHistoryStore} from "./offlineHistory";
import {EMPTY_PROJECTION, project} from "./sessionProjection";

const value = (text: string, observedThrough?: number) => ({...EMPTY_PROJECTION, observedThrough, transcript: [{id: "m", role: "user" as const, seq: 1, text}]});

it("rejects an older tab atomically and does not extend retention for unchanged newer observations", async () => {
  let now = 1000;
  const first = new OfflineHistoryStore("watermark", () => now);
  const second = new OfflineHistoryStore("watermark", () => now);
  await first.enable();
  const {epoch} = await first.load();
  await first.save("s", value("latest", 20), epoch);
  now = 2000;
  await second.save("s", value("old", 10), epoch);
  expect((await first.load()).conversations[0].messages[0].text).toBe("latest");
  await second.save("s", value("latest", 30), epoch);
  const copy = (await first.load()).conversations[0];
  expect(copy.savedAt).toBe(1000);
  expect(copy.observedThrough).toBe(30);
  await first.save("s", value("conflicting same observation", 30), epoch);
  await first.save("s", value("unversioned old client"), epoch);
  expect((await first.load()).conversations[0]).toEqual(copy);
  now = 3000;
  await first.save("s", value("new content", 31), epoch);
  expect((await first.load()).conversations[0].savedAt).toBe(3000);
});

it("waits for the atomic snapshot watermark before persisting a replacement", async () => {
  let projections = project({}, {protocolVersion: 2, eventSequence: 0, event: {kind: "sessionSnapshot", sessionId: "s", messages: [{role: "user", text: "snapshot"}]}});
  const store = new OfflineHistoryStore("snapshot");
  await store.enable();
  const {epoch} = await store.load();
  await store.save("s", projections.s, epoch);
  expect((await store.load()).conversations).toEqual([]);
  projections = project(projections, {protocolVersion: 2, eventSequence: 25, event: {kind: "workspacesChanged"}});
  await store.save("s", projections.s, epoch);
  expect((await store.load()).conversations[0].observedThrough).toBe(25);
});

it("accepts a restarted host's lower sequence and fences late observations from its predecessor", async () => {
  let now = 1000;
  const store = new OfflineHistoryStore("restart-epoch", () => now);
  await store.enable();
  const {epoch} = await store.load();
  await store.save("s", {...value("old", 500), observationEpoch: 1}, epoch);
  now = 2000;
  let projections = project({}, {protocolVersion: 2, observationEpoch: 2, eventSequence: 0, event: {kind: "sessionSnapshot", sessionId: "s", messages: [{role: "user", text: "new"}]}});
  projections = project(projections, {protocolVersion: 2, observationEpoch: 2, eventSequence: 0, event: {kind: "workspacesChanged"}});
  await store.save("s", projections.s, epoch);
  await store.save("s", {...value("late old tab", 1000), observationEpoch: 1}, epoch);
  await store.save("s", value("legacy tab", 2000), epoch);
  const copy = (await store.load()).conversations[0];
  expect(copy.observationEpoch).toBe(2);
  expect(copy.observedThrough).toBe(0);
  expect(copy.messages[0].text).toBe("new");
  expect(copy.savedAt).toBe(2000);
  now = 3000;
  await store.save("s", {...projections.s, observationEpoch: 3}, epoch);
  expect((await store.load()).conversations[0].savedAt).toBe(2000);
});
