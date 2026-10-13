import {Blob as NativeBlob} from "node:buffer";
import {expect, it} from "vitest";
import {DraftStore, DRAFT_TTL_MS, draftScopePrefix, type StoredDraftImage} from "../src/services/drafts";

function image(size = 32): StoredDraftImage {return {id: "image", name: "synthetic.png", width: 8, height: 8, blob: new NativeBlob([new Uint8Array(size)], {type: "image/png"}) as unknown as Blob};}

it("stores blobs only after consent, separately from the text draft, and recovers exact bytes", async () => {
  const store = new DraftStore("images");
  await expect(store.writeImages("session", [image()])).rejects.toThrow();
  await store.enable({session: "words"});
  await store.writeImages("session", [image()]);
  expect(await store.read()).toEqual({session: "words"});
  const restored = await new DraftStore("images").readImages();
  expect(restored.enabled).toBe(true);
  expect(restored.images.session[0].blob.size).toBe(32);
  expect(new Uint8Array(await restored.images.session[0].blob.arrayBuffer())).toEqual(new Uint8Array(32));
  expect(JSON.stringify(Object.values(localStorage))).not.toContain("synthetic.png");
});

it("deletes text and image blobs atomically and rejects a late image write from the old consent", async () => {
  const first = new DraftStore("images");
  await first.enable({session: "words"});
  await first.writeImages("session", [image()]);
  await new DraftStore("images").clear(true);
  await expect(first.writeImages("session", [image()])).rejects.toThrow(/no longer enabled/);
  expect(await first.readImages()).toMatchObject({enabled: false, images: {}});
  expect(await first.read()).toEqual({});
});

it("does not renew the seven day expiry when image drafts are read", async () => {
  let now = 1000;
  const store = new DraftStore("images", localStorage, () => now);
  await store.enable(); await store.writeImages("session", [image()]);
  now += DRAFT_TTL_MS - 1;
  expect((await store.readImages()).images.session).toHaveLength(1);
  now++;
  expect((await store.readImages()).images).toEqual({});
});

it("reserves the 100 MiB browser total atomically across different computer scopes", async () => {
  const piece = image(1_310_720);
  const stores = Array.from({length: 24}, (_, index) => new DraftStore(`computer-${index}`));
  await Promise.all(stores.map(store => store.enable()));
  const results = await Promise.allSettled(stores.map(store => store.writeImages("session", [piece, {...piece, id: "two"}, {...piece, id: "three"}, {...piece, id: "four"}])));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(20);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(4);
  await expect(stores[0].write("text", "a")).rejects.toThrow(/100 MiB/);
  const legacyPrefix = draftScopePrefix("legacy-computer");
  localStorage.setItem(`${legacyPrefix}consent`, "yes");
  localStorage.setItem(`${legacyPrefix}session:old`, JSON.stringify({text: "legacy text", savedAt: Date.now()}));
  await expect(new DraftStore("legacy-computer").load()).rejects.toThrow(/100 MiB/);
  expect(localStorage.getItem(`${legacyPrefix}session:old`)).not.toBeNull();

  await expect(new DraftStore("new-computer").enable({text: "a"})).rejects.toThrow(/100 MiB/);
  await stores[0].writeImages("session", []);
  expect(await new DraftStore("legacy-computer").read()).toEqual({old: "legacy text"});
  expect(localStorage.getItem(`${legacyPrefix}session:old`)).toBeNull();
  await stores[0].write("text", "a");
  expect(await stores[0].read()).toEqual({text: "a"});
});
