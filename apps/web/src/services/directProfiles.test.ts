import {afterEach, expect, it, vi} from "vitest";
import {deleteDirectProfile, directDraftScope, directEndpoint, directProfileId, listDirectProfiles, readDirectProfile, saveDirectProfile, takeDirectPairing, type DirectProfile} from "./directProfiles";

export const profileFixture = (endpoint = "https://station.example.ts.net", sessionId = "browser"): DirectProfile => ({endpoint, installationId: "station-id", hostPublicKey: "b".repeat(64), privateKey: new Uint8Array(32).fill(7), label: "Station", pair: {installationId: "station-id", sessionId, sessionToken: "synthetic-token", csrfToken: "synthetic-csrf", protocolVersion: 2}});

afterEach(() => {vi.unstubAllGlobals(); history.replaceState(null, "", "/");});

it("consumes a valid UTF-8 pairing fragment before storage or network work", () => {
  const pairing = {endpoint: "https://station.example.ts.net/", installationId: "station-id", hostPublicKey: "b".repeat(64), nonce: "a".repeat(64), label: "Estación"};
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(pairing))));
  history.replaceState(null, "", `/#directPair=${encoded}`);
  expect(takeDirectPairing()).toEqual({...pairing, endpoint: "https://station.example.ts.net"});
  expect(location.hash).toBe("");
});

it.each(["http://station.example", "https://user:password@station.example", "https://station.example/api", "https://station.example?token=secret", "https://station.example#secret", "https://fabrials.com", "https://remote.fabrials.com", "https://desktop.grok.me", "https://grok.fabrials.com", " https://station.example"])("rejects unsafe or hosted endpoint %s", endpoint => {
  expect(() => directEndpoint(endpoint)).toThrow();
});

it("removes malformed secrets from the address bar without attempting a pairing", () => {
  history.replaceState(null, "", "/#directPair=invalid!");
  expect(takeDirectPairing()).toBeNull();
  expect(location.hash).toBe("");
});

it("namespaces hosts and drafts by endpoint, installation and browser pairing", async () => {
  const a = profileFixture();
  const b = profileFixture("https://other.example");
  await saveDirectProfile(a);
  await saveDirectProfile(b);
  expect(await listDirectProfiles()).toHaveLength(2);
  expect(await readDirectProfile(directProfileId(a))).toEqual(a);
  expect(directDraftScope(a)).not.toBe(directDraftScope(b));
  expect(directDraftScope(a)).not.toBe(directDraftScope({...a, installationId: "new-install"}));
  expect(directDraftScope(a)).not.toBe(directDraftScope(profileFixture(a.endpoint, "new-pair")));
});

it("rejects a stale refresh or delete after a new pairing replaced the profile", async () => {
  const old = profileFixture();
  const current = profileFixture(old.endpoint, "new-browser");
  await saveDirectProfile(old);
  await saveDirectProfile(current);
  await expect(saveDirectProfile(old, old.pair.sessionId)).rejects.toThrow("pairing_changed");
  await expect(deleteDirectProfile(old)).rejects.toThrow("pairing_changed");
  expect(await readDirectProfile(directProfileId(current))).toEqual(current);
});

it("fails without claiming a saved grant when IndexedDB is unavailable", async () => {
  vi.stubGlobal("indexedDB", {open() {throw new Error("denied");}});
  await expect(saveDirectProfile(profileFixture())).rejects.toThrow("device_storage_unavailable");
});

it("enforces the profile bound atomically for concurrent additions", async () => {
  const results = await Promise.allSettled(Array.from({length: 40}, (_, i) => saveDirectProfile(profileFixture(`https://host-${i}.example`))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(32);
  expect(await listDirectProfiles()).toHaveLength(32);
});
