import {afterEach, expect, it, vi} from "vitest";
import {loadSourceDistribution, parseSourceDistribution, shellBuildId} from "./sourceDistribution";

const id = "a".repeat(64);
const digest = "b".repeat(64);
const source = {commit: "c".repeat(40), sha256: digest, dirty: false};
const metadata = () => ({schema: 1, shellId: id, shellSha256: digest,
  archive: {path: `/sources/${digest}.tar.gz`, sha256: digest, bytes: 1000},
  license: {path: `/sources/${digest}.license.txt`, sha256: digest, spdx: "AGPL-3.0-or-later"},
  notices: {path: `/sources/${digest}.notices.txt`, sha256: digest},
  native: {version: "1.2.3", commit: source.commit}, sources: {portable: {...source}, libs: {...source}}});

afterEach(() => {vi.unstubAllGlobals(); document.head.querySelectorAll('meta[name="grok-shell-build"]').forEach(node => node.remove());});

it("uses exactly one build marker from the loaded document", () => {
  expect(shellBuildId(document)).toBeNull();
  document.head.insertAdjacentHTML("beforeend", `<meta name="grok-shell-build" content="${id}">`);
  expect(shellBuildId(document)).toBe(id);
  document.head.insertAdjacentHTML("beforeend", `<meta name="grok-shell-build" content="${digest}">`);
  expect(shellBuildId(document)).toBeNull();
});

it("accepts only clean source identities and content-addressed local paths matching this shell", () => {
  expect(parseSourceDistribution(metadata(), id)).toEqual(metadata());
  expect(parseSourceDistribution(metadata(), digest)).toBeNull();
  for (const path of ["https://example.invalid/source.tar.gz", "//example.invalid/source.tar.gz", "/sources/../source.tar.gz", `/sources/${digest}.tar.gz?next=other`]) {
    const value = metadata(); value.archive.path = path;
    expect(parseSourceDistribution(value, id)).toBeNull();
  }
  const dirty = metadata(); dirty.sources.libs.dirty = true;
  expect(parseSourceDistribution(dirty, id)).toBeNull();
  const large = metadata(); large.archive.bytes = 256 * 1024 * 1024 + 1;
  expect(parseSourceDistribution(large, id)).toBeNull();
});

it("fetches build-specific metadata without credentials or redirects", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(metadata()), {headers: {"content-type": "application/json; charset=utf-8"}}));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await loadSourceDistribution(id, signal)).toEqual(metadata());
  expect(fetch).toHaveBeenCalledWith(`/sources/${id}.json`, {credentials: "omit", redirect: "error", signal});
});

it.each(["missing", "html fallback", "old metadata", "invalid json"])("rejects %s rather than offering mismatched source", async kind => {
  const response = kind === "missing" ? new Response(null, {status: 404}) : kind === "html fallback" ? new Response("<html>SPA</html>", {headers: {"content-type": "text/html"}}) : new Response(kind === "invalid json" ? "{" : JSON.stringify({...metadata(), shellId: digest}), {headers: {"content-type": "application/json"}});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(loadSourceDistribution(id, new AbortController().signal)).rejects.toThrow();
});

it("bounds streamed metadata and cancels the response when the bound is exceeded", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(8193));}, cancel});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {headers: {"content-type": "application/json"}})));
  await expect(loadSourceDistribution(id, new AbortController().signal)).rejects.toThrow("could not be verified");
  expect(cancel).toHaveBeenCalledOnce();
});
