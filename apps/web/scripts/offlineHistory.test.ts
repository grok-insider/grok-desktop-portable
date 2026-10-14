import {expect, it} from "vitest";
import {Blob as NativeBlob} from "node:buffer";
import {DRAFT_TTL_MS, DraftStore, forgetDraftScope, offlineHistoryScope} from "../src/services/drafts";
import {OfflineHistoryStore} from "../src/services/offlineHistory";
import {EMPTY_PROJECTION, type Projection} from "../src/services/sessionProjection";

function projection(text = "Synthetic history"): Projection {return {...EMPTY_PROJECTION, transcript: [{id: "m", role: "user", text, seq: 1}], thoughts: [{id: "private", seq: 2, text: "Never persist reasoning"}], reviews: [{recordId: "pending-permission"}]};}

it("requires independent consent, persists only the read-only projection and isolates computers", async () => {
  const store = new OfflineHistoryStore("a");
  await new DraftStore("a").enable({session: "unsent"});
  await expect(store.save("session", projection(), "unknown")).rejects.toThrow();
  await store.enable();
  const {epoch} = await store.load();
  await store.save("session", projection(), epoch);
  const first = await store.load();
  expect(first.conversations[0].messages[0].text).toBe("Synthetic history");
  expect(JSON.stringify(first)).not.toContain("Never persist reasoning");
  expect(JSON.stringify(first)).not.toContain("pending-permission");
  expect((await new OfflineHistoryStore("b").load()).conversations).toEqual([]);
  expect((await new DraftStore("a").load()).drafts).toEqual({session: "unsent"});
});

it("expires after seven days without renewing on reads and purges expired payloads", async () => {
  let now = 1000;
  const store = new OfflineHistoryStore("a", () => now);
  await store.enable(); await store.save("s", projection(), (await store.load()).epoch);
  now += DRAFT_TTL_MS - 1;
  expect((await store.load()).conversations).toHaveLength(1);
  now++;
  expect((await store.load()).conversations).toEqual([]);
  expect((await store.drafts.read())).toEqual({});
});

it("deleting one conversation excludes late writes from every tab but retains others", async () => {
  const first = new OfflineHistoryStore("a");
  const second = new OfflineHistoryStore("a");
  await first.enable(); const {epoch} = await second.load();
  await first.save("s", projection(), epoch); await first.save("other", projection("other"), epoch);
  const pending = second.save("s", projection("queued"), epoch);
  await first.remove("s"); await pending;
  await expect(second.save("s", projection("late"), epoch)).rejects.toThrow(/disabled/);
  expect((await first.load()).conversations.map(row => row.sessionId)).toEqual(["other"]);
  await first.disable(); await first.enable();
  await first.save("s", projection("explicit new consent"), (await first.load()).epoch);
  expect((await first.load()).conversations).toHaveLength(1);
});

it("revocation deletes both histories and drafts, then rejects stale epochs after new consent", async () => {
  const first = new OfflineHistoryStore("a");
  const other = new OfflineHistoryStore("b");
  await first.enable(); await other.enable(); const {epoch} = await first.load();
  await first.save("s", projection(), epoch);
  await other.save("s", projection(), (await other.load()).epoch);
  await new DraftStore("a").enable({s: "unsent"});
  await forgetDraftScope("a");
  expect((await first.load())).toMatchObject({enabled: false, conversations: []});
  expect((await new DraftStore("a").load()).drafts).toEqual({});
  expect((await other.load()).conversations).toHaveLength(1);
  await first.enable();
  await expect(first.save("s", projection("late"), epoch)).rejects.toThrow(/no longer enabled/);
});

it("shares the global 100 MiB quota with image and text drafts and preserves previous history on failure", async () => {
  const history = new OfflineHistoryStore("a");
  await history.enable(); const {epoch} = await history.load();
  await history.save("s", projection("original"), epoch);
  const piece = {id: "image", name: "synthetic.png", width: 32, height: 32, blob: new NativeBlob([new Uint8Array(1_310_720)], {type: "image/png"}) as unknown as Blob};
  for (let i = 0; i < 19; i++) {const drafts = new DraftStore(`image-${i}`); await drafts.enable(); await drafts.writeImages("s", [piece, piece, piece, piece]);}
  const text = new DraftStore("text"); await text.enable();
  for (let i = 0; i < 4; i++) await text.write(String(i), "x".repeat(1024 * 1024));
  await text.write("last", "x".repeat(1024 * 1024 - 400));
  await expect(history.save("s", projection("new".repeat(1000)), epoch)).rejects.toThrow(/100 MiB/);
  expect((await history.load()).conversations[0].messages[0].text).toBe("original");
});

it("rejects oversized snapshots and untrusted stored shapes without rendering them", async () => {
  const store = new OfflineHistoryStore("a");
  await store.enable(); const {epoch} = await store.load();
  await expect(store.save("s", projection("x".repeat(1024 * 1024)), epoch)).rejects.toThrow(/1 MiB/);
  const raw = new DraftStore(offlineHistoryScope("a")); await raw.load();
  await raw.write("s", JSON.stringify({version: 1, sessionId: "s", savedAt: Date.now(), messages: [{text: "bad"}], tools: []}));
  expect((await store.load()).conversations).toEqual([]);
});
