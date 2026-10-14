import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { packageArtifact, verifyArtifact } from "./remote-artifact.mjs";
import { workerManifest } from "./worker-manifest.mjs";
import { buildOrigin, deploymentOrigin } from "./deployment-origin.mjs";

const root = await mkdtemp(join(tmpdir(), "remote-artifact-test-"));
const fixture = join(root, "synthetic-dist");
const original = join(root, "original");
const crypto = "crypto/0123456789abcdefabcd";
const shellId = "a".repeat(64);
const identity = {commit: "1".repeat(40), dirty: false, sha256: "2".repeat(64)};
let sequence = 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = async (name, data) => {await mkdir(dirname(join(fixture, name)), {recursive: true}); await writeFile(join(fixture, name), data);};
const copy = async () => {const target = join(root, `copy-${++sequence}`); await cp(original, target, {recursive: true}); return target;};
const amend = async (target, mutate) => {const path = join(target, "deployment.json"); const value = JSON.parse(await readFile(path, "utf8")); mutate(value); await writeFile(path, JSON.stringify(value));};

before(async () => {
  const shell = ["index.html", "manifest.webmanifest", "theme-init.js", "third-party-notices.txt", "icon-192.png", "icon-512.png", "assets/app.js", `${crypto}/fabrials_remote_noise.js`, `${crypto}/fabrials_remote_noise_bg.wasm`];
  await put("index.html", `<html><head><title>Grok Remote</title><meta name="grok-app-origin" content="https://desktop.grok.me"><meta name="grok-shell-build" content="${shellId}"><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'"><link rel="manifest" href="/manifest.webmanifest"></head><body><script src="/assets/app.js"></script></body></html>`);
  await put("manifest.webmanifest", JSON.stringify({start_url: "/", scope: "/", display: "standalone", icons: [192, 512].map((size) => ({src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png"}))}));
  await put("theme-init.js", "void 0;");
  await put("third-party-notices.txt", "Synthetic dependency notices\n");
  for (const size of [192, 512]) {const header = Buffer.alloc(24); header.writeUInt32BE(size, 16); header.writeUInt32BE(size, 20); await put(`icon-${size}.png`, header);}
  await put("assets/app.js", `import('/${crypto}/fabrials_remote_noise.js');`);
  await put(`${crypto}/fabrials_remote_noise.js`, "export const syntheticFixture = true;");
  await put(`${crypto}/fabrials_remote_noise_bg.wasm`, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await put("sw.js", `const CACHE = "grok-shell-${shellId.slice(0, 16)}";\nconst SHELL = ${JSON.stringify(shell)};\nself.addEventListener('fetch', () => {});`);
  await put(".env", "synthetic-secret-file");
  await put("api/demo.json", "{}");
  await put("assets/app.js.map", "{}");
  await packageArtifact(fixture, original, {portable: identity, libs: identity}, {fixture: "synthetic boundary test; not a production crypto build"});
});

after(async () => {await rm(root, {recursive: true, force: true});});

test("reads literal worker metadata without executing artifact code", () => {
  const worker = `const SHELL = ["index.html"];\nconst CACHE = "grok-shell-aaaaaaaaaaaaaaaa";\nthrow new Error('Worker code must never run during verification');`;
  assert.deepEqual(workerManifest(worker), {files: ["index.html"], cache: "grok-shell-aaaaaaaaaaaaaaaa"});
  assert.throws(() => workerManifest(worker.replace('["index.html"]', '(() => ["index.html"])()')));
  assert.throws(() => workerManifest(worker + '\nconst SHELL = ["another.html"];'), /one literal shell declaration/);
});

test("artifact verification never executes a tampered worker before checking its hash", async () => {
  const target = await copy();
  const name = ".vercel/output/static/sw.js";
  await writeFile(join(target, name), await readFile(join(target, name), "utf8") + "\nthrow new Error('Worker execution escaped');");
  await assert.rejects(verifyArtifact(target), /Changed artifact file/);
});

test("packages the PWA shell, reviewed installers and configuration, excluding unrelated dist content", async () => {
  const result = await verifyArtifact(original);
  assert.equal(Object.keys(result.files).length, 13);
  assert(!Object.keys(result.files).some((name) => name.includes(".env") || name.includes("api/") || name.endsWith(".map")));
  assert.equal(result.deployCandidate, false);
  await assert.rejects(verifyArtifact(original, {forDeploy: true}), /matching corresponding source/);
  assert.equal(result.origin, "https://desktop.grok.me");
  const config = JSON.parse(await readFile(join(original, ".vercel/output/config.json"), "utf8"));
  const csp = config.routes.find(route => route.headers?.["Content-Security-Policy"]).headers["Content-Security-Policy"];
  const directives = Object.fromEntries(csp.split(";").map(part => part.trim().split(/\s+/)).map(([key, ...values]) => [key, values]));
  assert(directives["connect-src"].includes("https:") && directives["connect-src"].includes("wss:"), "Direct user-owned hosts must be reachable through the deployed response CSP");
  assert(directives["img-src"].includes("blob:"), "Verified local image URLs must be displayable");
  assert(!directives["script-src"].includes("'unsafe-inline'") && !directives["connect-src"].includes("http:"));
  assert.equal(await readFile(join(original, ".vercel/output/static/install.sh"), "utf8"), await readFile(new URL("../site/install.sh", import.meta.url), "utf8"));
});

test("never overwrites an existing review artifact", async () => {
  await assert.rejects(packageArtifact(fixture, original, {portable: identity, libs: identity}), /already exists/);
  await verifyArtifact(original);
});

test("rejects a tampered shell file", async () => {
  const target = await copy();
  await writeFile(join(target, ".vercel/output/static/assets/app.js"), "tampered");
  await assert.rejects(verifyArtifact(target), /Changed artifact file/);
});

test("rejects missing and unexpected payload files even with rewritten checksums", async () => {
  const missing = await copy();
  await rm(join(missing, ".vercel/output/static/theme-init.js"));
  await amend(missing, (manifest) => {delete manifest.files[".vercel/output/static/theme-init.js"];});
  await assert.rejects(verifyArtifact(missing), /only the reviewed static PWA payload/);
  const extra = await copy();
  await writeFile(join(extra, ".vercel/output/static/secret.txt"), "unexpected");
  await amend(extra, (manifest) => {manifest.files[".vercel/output/static/secret.txt"] = digest("unexpected");});
  await assert.rejects(verifyArtifact(extra), /only the reviewed static PWA payload/);
});

test("rejects deployment config changes even when the manifest is updated", async () => {
  const target = await copy();
  const name = ".vercel/output/config.json";
  const changed = JSON.stringify({version: 3, routes: []});
  await writeFile(join(target, name), changed);
  await amend(target, (manifest) => {manifest.files[name] = digest(changed);});
  await assert.rejects(verifyArtifact(target), /differs from the reviewed configuration/);
});

test("rejects a different deployment origin", async () => {
  const target = await copy();
  await amend(target, (manifest) => {manifest.origin = "https://remote.fabrials.com";});
  await assert.rejects(verifyArtifact(target));
});

test("rejects malformed, unreviewed and ambiguous origin markers", () => {
  for (const origin of ["http://grok.fabrials.com", "https://grok.fabrials.com/", "https://grok.fabrials.com:443", "https://grok.fabrials.com.evil.invalid", "https://unreviewed.fabrials.com", ""]) assert.throws(() => deploymentOrigin(origin));
  assert.throws(() => buildOrigin("<html></html>"), /one application origin/);
  assert.throws(() => buildOrigin('<meta name="grok-app-origin" content="https://desktop.grok.me"><meta name="grok-app-origin" content="https://grok.fabrials.com">'), /one application origin/);
});

test("qualification artifacts bind shell, exact origin and hosting config without weakening the source gate", async () => {
  const dist = join(root, `qualification-dist-${++sequence}`);
  await cp(fixture, dist, {recursive: true});
  const index = await readFile(join(dist, "index.html"), "utf8");
  await writeFile(join(dist, "index.html"), index.replace('content="https://desktop.grok.me"', 'content="https://grok.fabrials.com"'));
  const target = join(root, `qualification-artifact-${++sequence}`);
  await assert.rejects(packageArtifact(dist, target, {portable: identity, libs: identity}), /failed/);
  await packageArtifact(dist, target, {portable: identity, libs: identity}, {}, {origin: "https://grok.fabrials.com"});
  const result = await verifyArtifact(target, {origin: "https://grok.fabrials.com"});
  assert.equal(result.origin, "https://grok.fabrials.com");
  assert.equal(result.deployCandidate, false);
  await assert.rejects(verifyArtifact(target, {origin: "https://desktop.grok.me"}), /requested deployment origin/);
  await assert.rejects(verifyArtifact(target, {forDeploy: true, origin: "https://grok.fabrials.com"}), /matching corresponding source/);
  const configName = ".vercel/output/config.json";
  const config = JSON.parse(await readFile(join(target, configName), "utf8"));
  const hostCondition = config.routes[0].missing[0];
  assert.equal(hostCondition.type, "host");
  assert.deepEqual(hostCondition.value, {eq: "grok.fabrials.com"});
  const matchesHost = host => typeof hostCondition.value === "string" ? new RegExp(hostCondition.value).test(host) : host === hostCondition.value.eq;
  assert(matchesHost("grok.fabrials.com"));
  for (const host of ["grokxfabrialsycom", "other.grok.fabrials.com", "grok.fabrials.com.evil.invalid", "grok.fabrials.com:443", "desktop.grok.me", "remote.fabrials.com"]) assert(!matchesHost(host), `Qualification host guard must reject ${host}`);
  assert.equal(config.routes[0].status, 404);
  assert(config.routes.some(route => route.headers?.["X-Robots-Tag"] === "noindex, nofollow, noarchive"));
  assert(!config.routes.some(route => route.headers?.Location));
  const production = await readFile(new URL("../deploy/remote/build-output.json", import.meta.url), "utf8");
  await writeFile(join(target, configName), production);
  await amend(target, manifest => {manifest.files[configName] = digest(production);});
  await assert.rejects(verifyArtifact(target), /reviewed configuration/);
});

test("changing only the manifest cannot retarget a built production shell", async () => {
  const target = await copy();
  await amend(target, manifest => {manifest.origin = "https://grok.fabrials.com";});
  await assert.rejects(verifyArtifact(target), /its built shell/);
});

test("rejects substituted installers even with updated checksums", async () => {
  const target = await copy();
  const name = ".vercel/output/static/install.sh";
  await writeFile(join(target, name), "substituted installer");
  await amend(target, manifest => { manifest.files[name] = digest("substituted installer"); });
  await assert.rejects(verifyArtifact(target), /Installer differs from reviewed source/);
});

test("allows dirty review artifacts but rejects them for deployment", async () => {
  const target = await copy();
  await amend(target, (manifest) => {manifest.sources.libs.dirty = true;});
  await verifyArtifact(target);
  await assert.rejects(verifyArtifact(target, {forDeploy: true}), /clean reviewed source commits/);
});

test("rejects payload and manifest symlinks", async () => {
  const target = await copy();
  const name = ".vercel/output/static/theme-init.js";
  await rm(join(target, name));
  await symlink(join(original, name), join(target, name));
  await assert.rejects(verifyArtifact(target), /symlink is forbidden/);
  const linkedManifest = await copy();
  await rm(join(linkedManifest, "deployment.json"));
  await symlink(join(original, "deployment.json"), join(linkedManifest, "deployment.json"));
  await assert.rejects(verifyArtifact(linkedManifest), /regular file/);
});

async function sourceAdapter(overrides = {}) {
  const spanreed = join(root, `synthetic-verifier-${++sequence}`);
  const archive = join(spanreed, "source.tar.gz");
  await mkdir(join(spanreed, "scripts"), {recursive: true});
  const bytes = Buffer.from("Synthetic adapter fixture; real archive integrity is tested by Spanreed.");
  await writeFile(archive, bytes);
  const distributionFiles = {};
  for (const name of ["site/install.sh", "site/install.ps1", "deploy/remote/build-output.json", "deploy/remote/qualification-build-output.json"]) distributionFiles[name] = digest(await readFile(new URL(`../${name}`, import.meta.url)));
  const proof = {schema: 1, sources: {portable: identity, libs: identity}, shellId, shellSha256: "b".repeat(64), archiveSha256: digest(bytes), archiveBytes: bytes.length, native: {version: "1.2.3", commit: "c".repeat(40)}, licenseText: "Synthetic own license\n", noticesText: "Synthetic dependency notices\n", distributionFiles, ...overrides};
  const script = `import argparse, hashlib, json\nfrom pathlib import Path\np = argparse.ArgumentParser()\np.add_argument('command', choices=['pwa-proof'])\np.add_argument('--archive', type=Path)\np.add_argument('--pwa-dist', type=Path)\na = p.parse_args()\nproof = json.loads(${JSON.stringify(JSON.stringify(proof))})\nassert hashlib.sha256(a.archive.read_bytes()).hexdigest() == proof['archiveSha256']\nassert proof['shellId'] in (a.pwa_dist / 'index.html').read_text()\nprint(json.dumps(proof))\n`;
  await writeFile(join(spanreed, "scripts/source-bundle.py"), script);
  return {spanreed, sourceArchive: archive};
}

test("deployment requires the exact source proof and packages only immutable local source links", async () => {
  const adapter = await sourceAdapter();
  const target = join(root, `source-artifact-${++sequence}`);
  await packageArtifact(fixture, target, {portable: identity, libs: identity}, {}, adapter);
  const result = await verifyArtifact(target, {forDeploy: true, spanreed: adapter.spanreed});
  assert.equal(result.deployCandidate, true);
  assert.equal(Object.keys(result.files).length, 17);
  assert.equal(result.correspondingSource, `/sources/${shellId}.json`);
  await assert.rejects(verifyArtifact(target, {forDeploy: true}), /reviewed Spanreed checkout/);
  const metadata = JSON.parse(await readFile(join(target, ".vercel/output/static", result.correspondingSource), "utf8"));
  assert.equal(metadata.archive.path, `/sources/${digest(await readFile(adapter.sourceArchive))}.tar.gz`);
  await writeFile(join(target, ".vercel/output/static", metadata.archive.path), "changed archive");
  await assert.rejects(verifyArtifact(target), /Changed source distribution file/);
});

test("refuses an archive built from different inputs and leaves no artifact behind", async () => {
  const adapter = await sourceAdapter({sources: {portable: {...identity, commit: "d".repeat(40)}, libs: identity}});
  const target = join(root, `mismatched-source-${++sequence}`);
  await assert.rejects(packageArtifact(fixture, target, {portable: identity, libs: identity}, {}, adapter), /inputs differ/);
  await assert.rejects(readFile(join(target, "deployment.json")), {code: "ENOENT"});
});

test("refuses source archives whose installers or deployment config differ from the payload", async () => {
  const adapter = await sourceAdapter({distributionFiles: {"site/install.sh": "d".repeat(64)}});
  await assert.rejects(packageArtifact(fixture, join(root, `old-installers-${++sequence}`), {portable: identity, libs: identity}, {}, adapter), /configuration differ from corresponding source/);
});

test("refuses old-shell metadata, missing metadata, and license changes even with updated manifest hashes", async () => {
  const adapter = await sourceAdapter();
  for (const change of ["old-shell", "missing", "license"]) {
    const target = join(root, `${change}-${++sequence}`);
    await packageArtifact(fixture, target, {portable: identity, libs: identity}, {}, adapter);
    const name = `.vercel/output/static/sources/${shellId}.json`;
    const metadata = JSON.parse(await readFile(join(target, name), "utf8"));
    if (change === "old-shell") {
      metadata.shellId = "d".repeat(64);
      const bytes = JSON.stringify(metadata);
      await writeFile(join(target, name), bytes);
      await amend(target, manifest => {manifest.files[name] = digest(bytes);});
      await assert.rejects(verifyArtifact(target), /another shell version/);
    } else if (change === "missing") {
      await rm(join(target, name));
      await assert.rejects(verifyArtifact(target), {code: "ENOENT"});
    } else {
      await writeFile(join(target, ".vercel/output/static", metadata.license.path), "changed license");
      await amend(target, manifest => {manifest.files[`.vercel/output/static${metadata.license.path}`] = digest("changed license");});
      await assert.rejects(verifyArtifact(target), /Changed source distribution file/);
    }
  }
});
