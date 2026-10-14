export interface SourceDistribution {
  schema: 1;
  shellId: string;
  shellSha256: string;
  archive: {path: string; sha256: string; bytes: number};
  license: {path: string; sha256: string; spdx: "AGPL-3.0-or-later"};
  notices: {path: string; sha256: string};
  native: {version: string; commit: string};
  sources: {portable: {commit: string; sha256: string; dirty: false}; libs: {commit: string; sha256: string; dirty: false}};
}

const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function shellBuildId(document: Document): string | null {
  const values = document.querySelectorAll('meta[name="grok-shell-build"]');
  const value = values.length === 1 ? values[0].getAttribute("content") : null;
  return value && sha256.test(value) ? value : null;
}

export function parseSourceDistribution(value: unknown, shellId: string): SourceDistribution | null {
  if (!record(value) || value.schema !== 1 || !sha256.test(shellId) || value.shellId !== shellId || !sha256.test(String(value.shellSha256))) return null;
  const {archive, license, notices, native, sources} = value;
  if (!record(archive) || !sha256.test(String(archive.sha256)) || archive.path !== `/sources/${archive.sha256}.tar.gz` || !Number.isSafeInteger(archive.bytes) || Number(archive.bytes) <= 0 || Number(archive.bytes) > 256 * 1024 * 1024) return null;
  if (!record(license) || license.spdx !== "AGPL-3.0-or-later" || !sha256.test(String(license.sha256)) || license.path !== `/sources/${license.sha256}.license.txt`) return null;
  if (!record(notices) || !sha256.test(String(notices.sha256)) || notices.path !== `/sources/${notices.sha256}.notices.txt`) return null;
  if (!record(native) || !/^\d+\.\d+\.\d+$/.test(String(native.version)) || !commit.test(String(native.commit)) || !record(sources)) return null;
  for (const source of [sources.portable, sources.libs]) if (!record(source) || !commit.test(String(source.commit)) || !sha256.test(String(source.sha256)) || source.dirty !== false) return null;
  return value as unknown as SourceDistribution;
}

export async function loadSourceDistribution(shellId: string, signal: AbortSignal): Promise<SourceDistribution> {
  if (!sha256.test(shellId)) throw new Error("Source information is unavailable for this build.");
  const response = await fetch(`/sources/${shellId}.json`, {credentials: "omit", redirect: "error", signal});
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !response.body) throw new Error("Source information is unavailable for this build.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new Error("Source information could not be verified.");
      text += decoder.decode(part.value, {stream: true});
    }
    text += decoder.decode();
  } finally {await reader.cancel().catch(() => {});}
  const value = parseSourceDistribution(JSON.parse(text), shellId);
  if (!value) throw new Error("Source information does not match this app version.");
  return value;
}
