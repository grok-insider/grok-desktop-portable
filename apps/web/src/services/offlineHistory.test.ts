import {expect, it} from "vitest";
import {OfflineHistoryStore, offlineContent, offlineSignature} from "./offlineHistory";
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

it("keeps what the host left out with the saved copy and rejects malformed counts", async () => {
  const store = new OfflineHistoryStore("omission");
  await store.enable();
  const {epoch} = await store.load();
  await store.save("window", {...value("newest", 40), history: {omittedMessages: 400, omittedTools: 2, truncated: false}}, epoch);
  await store.save("complete", value("all of it", 41), epoch);
  const copies = Object.fromEntries((await store.load()).conversations.map(row => [row.sessionId, row]));
  expect(copies.window).toMatchObject({omittedMessages: 400, omittedTools: 2, historyTruncated: false});
  expect(copies.complete).not.toHaveProperty("omittedMessages");
  expect(copies.complete).not.toHaveProperty("historyTruncated");
  for (const [id, field] of [["negative", {omittedMessages: -1}], ["fraction", {omittedTools: 1.5}], ["text", {omittedMessages: "3"}], ["flag", {historyTruncated: "yes"}]] as const) {
    await store.drafts.write(id, JSON.stringify({version: 1, sessionId: id, savedAt: Date.now(), messages: [{id: "m", role: "user", text: id, seq: 1, unavailableImages: 0}], tools: [], ...field}), epoch);
  }
  expect((await store.load()).conversations.map(row => row.sessionId).sort()).toEqual(["complete", "window"]);
});

it("treats a different omission as changed content", () => {
  const rows = value("same rows");
  expect(offlineSignature(offlineContent("s", {...rows, history: {omittedMessages: 3, omittedTools: 0, truncated: false}}))).not.toBe(offlineSignature(offlineContent("s", {...rows, history: {omittedMessages: 4, omittedTools: 0, truncated: false}})));
  expect(offlineSignature(offlineContent("s", {...rows, history: {omittedMessages: 0, omittedTools: 0, truncated: true}}))).not.toBe(offlineSignature(offlineContent("s", rows)));
});
