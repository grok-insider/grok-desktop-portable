import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { workerManifest } from "./worker-manifest.mjs";
import { buildOrigin, deploymentOrigin, deploymentConfigPath } from "./deployment-origin.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installers = ["install.sh", "install.ps1"];
const execute = promisify(execFile);

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: repository, stdio: "inherit", ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

async function git(directory, args) {
  const result = await execute("git", ["-C", directory, ...args], {encoding: "utf8", maxBuffer: 16 * 1024 * 1024});
  return result.stdout;
}

export async function sourceIdentity(directory) {
  const hash = createHash("sha256");
  const names = [...new Set((await git(directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean))].sort();
  for (const name of names) {
    hash.update(`${name}\0`);
    try {
      const file = join(directory, name);
      const metadata = await lstat(file);
      assert(!metadata.isSymbolicLink(), "Build sources must not contain symlinks");
      if (metadata.isFile()) hash.update(await readFile(file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("deleted");
    }
  }
  return {commit: (await git(directory, ["rev-parse", "HEAD"])).trim(), dirty: (await git(directory, ["status", "--porcelain", "--untracked-files=normal"])).length > 0, sha256: hash.digest("hex")};
}

async function payloadFiles(directory, prefix = "") {
  const result = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === "deployment.json") continue;
    const metadata = await lstat(join(directory, relative));
    assert(!metadata.isSymbolicLink(), `Artifact symlink is forbidden: ${relative}`);
    if (metadata.isDirectory()) result.push(...await payloadFiles(directory, relative));
    else {assert(metadata.isFile(), `Unexpected artifact entry: ${relative}`); result.push(relative);}
  }
  return result;
}

async function shellFiles(directory) {
  const sw = await readFile(join(directory, "sw.js"), "utf8");
  return workerManifest(sw).files;
}

async function shellId(directory) {
  const html = await readFile(join(directory, "index.html"), "utf8");
  const matches = [...html.matchAll(/<meta name="grok-shell-build" content="([a-f0-9]{64})">/g)];
  assert.equal(matches.length, 1, "Artifact requires one shell build identity");
  return matches[0][1];
}

async function sourceProof(spanreed, archive, dist, sources) {
  assert(spanreed, "Corresponding-source verification requires the reviewed Spanreed checkout (--spanreed)");
  const metadata = await lstat(archive);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 256 * 1024 * 1024, "Invalid corresponding-source archive");
  const result = await execute("python3", [join(spanreed, "scripts/source-bundle.py"), "pwa-proof", "--archive", archive, "--pwa-dist", dist], {encoding: "utf8", maxBuffer: 2 * 1024 * 1024});
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.schema, 1);
  assert.deepEqual(proof.sources, sources, "Source archive inputs differ from deployment source identities");
  assert.equal(proof.shellId, await shellId(dist), "Source archive belongs to another shell");
  assert.equal(proof.archiveSha256, digest(await readFile(archive)), "Source archive hash mismatch");
  assert.equal(proof.archiveBytes, metadata.size);
  assert(/^[a-f0-9]{64}$/.test(proof.shellSha256));
  assert(/^[a-f0-9]{40}$/.test(proof.native?.commit) && /^\d+\.\d+\.\d+$/.test(proof.native?.version));
  assert(typeof proof.licenseText === "string" && proof.licenseText.length > 0);
  assert(typeof proof.noticesText === "string" && proof.noticesText.length > 0);
  const distributionFiles = {};
  for (const name of ["site/install.sh", "site/install.ps1", "deploy/remote/build-output.json", "deploy/remote/qualification-build-output.json"]) distributionFiles[name] = digest(await readFile(join(repository, name)));
  assert.deepEqual(proof.distributionFiles, distributionFiles, "Installers or deployment configuration differ from corresponding source");
  return proof;
}

function sourceMetadata(proof) {
  const licenseSha256 = digest(proof.licenseText);
  const noticesSha256 = digest(proof.noticesText);
  return {schema: 1, shellId: proof.shellId, shellSha256: proof.shellSha256, native: proof.native, sources: proof.sources,
    archive: {path: `/sources/${proof.archiveSha256}.tar.gz`, sha256: proof.archiveSha256, bytes: proof.archiveBytes},
    license: {path: `/sources/${licenseSha256}.license.txt`, sha256: licenseSha256, spdx: "AGPL-3.0-or-later"},
    notices: {path: `/sources/${noticesSha256}.notices.txt`, sha256: noticesSha256}};
}

export async function verifyArtifact(directory, {forDeploy = false, spanreed, origin} = {}) {
  assert((await lstat(join(directory, "deployment.json"))).isFile(), "Deployment manifest must be a regular file");
  const manifest = JSON.parse(await readFile(join(directory, "deployment.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  deploymentOrigin(manifest.origin);
  if (origin !== undefined) assert.equal(manifest.origin, deploymentOrigin(origin), "Artifact origin differs from requested deployment origin");
  assert.equal(manifest.format, "vercel-build-output-v3");
  for (const source of [manifest.sources?.portable, manifest.sources?.libs]) {
    assert(/^[a-f0-9]{40}$/.test(source?.commit));
    assert(/^[a-f0-9]{64}$/.test(source?.sha256));
    assert.equal(typeof source.dirty, "boolean");
    if (forDeploy) assert(!source.dirty, "Deployment requires clean reviewed source commits");
  }
  const dist = join(directory, ".vercel/output/static");
  assert.equal(manifest.origin, buildOrigin(await readFile(join(dist, "index.html"), "utf8")), "Artifact origin differs from its built shell");
  const buildId = await shellId(dist);
  const sourcePaths = [];
  let distribution;
  assert.equal(manifest.deployCandidate, Boolean(manifest.correspondingSource), "Deployment candidacy must follow corresponding source");
  if (forDeploy) assert(manifest.correspondingSource, "Deployment requires matching corresponding source; this is a review artifact");
  if (manifest.correspondingSource) {
    assert.equal(manifest.correspondingSource, `/sources/${buildId}.json`, "Source metadata belongs to another shell version");
    assert((await lstat(join(dist, manifest.correspondingSource.slice(1)))).isFile(), "Source metadata must be a regular file");
    const metadataBytes = await readFile(join(dist, manifest.correspondingSource.slice(1)));
    assert(metadataBytes.length <= 8192, "Source metadata is oversized");
    distribution = JSON.parse(metadataBytes);
    assert.equal(distribution.schema, 1);
    assert.equal(distribution.shellId, buildId, "Source metadata belongs to another shell version");
    assert.deepEqual(distribution.sources, manifest.sources, "Source metadata inputs differ from the artifact");
    for (const [name, suffix] of [["archive", "tar.gz"], ["license", "license.txt"], ["notices", "notices.txt"]]) {
      const item = distribution[name];
      assert(/^[a-f0-9]{64}$/.test(item?.sha256));
      assert.equal(item.path, `/sources/${item.sha256}.${suffix}`, "Source links must name immutable local files");
      assert((await lstat(join(dist, item.path.slice(1)))).isFile(), "Source distribution files must be regular files");
      assert.equal(digest(await readFile(join(dist, item.path.slice(1)))), item.sha256, "Changed source distribution file");
      sourcePaths.push(item.path.slice(1));
    }
    sourcePaths.push(manifest.correspondingSource.slice(1));
    if (forDeploy || spanreed) {
      const proof = await sourceProof(spanreed, join(dist, distribution.archive.path.slice(1)), dist, manifest.sources);
      assert.deepEqual(distribution, sourceMetadata(proof), "Source metadata differs from its verified archive");
    }
  }
  const names = await payloadFiles(directory);
  const expected = [".vercel/output/config.json", ...[...await shellFiles(dist), "sw.js", ...installers, ...sourcePaths].map((name) => `.vercel/output/static/${name}`)];
  assert.deepEqual(names.sort(), expected.sort(), "Artifact must contain only the reviewed static PWA payload");
  assert.deepEqual(names.sort(), Object.keys(manifest.files).sort(), "Artifact contains missing or unexpected files");
  for (const name of names) assert.equal(digest(await readFile(join(directory, name))), manifest.files[name], `Changed artifact file: ${name}`);
  for (const name of installers) assert.equal(digest(await readFile(join(directory, ".vercel/output/static", name))), digest(await readFile(join(repository, "site", name))), `Installer differs from reviewed source: ${name}`);
  const config = await readFile(join(directory, ".vercel/output/config.json"), "utf8");
  assert.equal(config, await readFile(join(repository, deploymentConfigPath(manifest.origin)), "utf8"), "Remote deployment configuration differs from the reviewed configuration");
  run(process.execPath, [join(repository, "scripts/check-pwa-build.mjs"), join(directory, ".vercel/output/static"), "--require-crypto", "--origin", manifest.origin]);
  return manifest;
}

export async function packageArtifact(dist, output, sources, toolchain = {}, {spanreed, sourceArchive, origin: selectedOrigin} = {}) {
  const origin = deploymentOrigin(selectedOrigin);
  run(process.execPath, [join(repository, "scripts/check-pwa-build.mjs"), dist, "--require-crypto", "--origin", origin]);
  try {await lstat(output); throw new Error("Artifact output already exists; choose a new directory");} catch (error) {if (error.code !== "ENOENT") throw error;}
  await mkdir(dirname(output), {recursive: true});
  const temporary = await mkdtemp(join(dirname(output), ".remote-artifact-"));
  try {
    const files = await shellFiles(dist);
    for (const name of [...files, "sw.js"]) {
      const target = join(temporary, ".vercel/output/static", name);
      await mkdir(dirname(target), {recursive: true});
      assert(!(await lstat(join(dist, name))).isSymbolicLink(), "Static files must not be symlinks");
      await cp(join(dist, name), target);
    }
    for (const name of installers) await cp(join(repository, "site", name), join(temporary, ".vercel/output/static", name));
    await cp(join(repository, deploymentConfigPath(origin)), join(temporary, ".vercel/output/config.json"));
    let correspondingSource = null;
    if (sourceArchive) {
      const proof = await sourceProof(spanreed, sourceArchive, dist, sources);
      const distribution = sourceMetadata(proof);
      const staticRoot = join(temporary, ".vercel/output/static");
      correspondingSource = `/sources/${proof.shellId}.json`;
      await mkdir(join(staticRoot, "sources"));
      await cp(sourceArchive, join(staticRoot, distribution.archive.path.slice(1)));
      await writeFile(join(staticRoot, distribution.license.path.slice(1)), proof.licenseText);
      await writeFile(join(staticRoot, distribution.notices.path.slice(1)), proof.noticesText);
      await writeFile(join(staticRoot, correspondingSource.slice(1)), JSON.stringify(distribution, null, 2) + "\n");
    }
    const checksums = {};
    for (const name of await payloadFiles(temporary)) checksums[name] = digest(await readFile(join(temporary, name)));
    await writeFile(join(temporary, "deployment.json"), JSON.stringify({schema: 1, origin, format: "vercel-build-output-v3", sources, toolchain, correspondingSource, deployCandidate: Boolean(correspondingSource), files: checksums}, null, 2) + "\n");
    await verifyArtifact(temporary, {spanreed: sourceArchive ? spanreed : undefined});
    await rename(temporary, output);
  } finally {await rm(temporary, {recursive: true, force: true});}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2] === "verify" && process.argv[3], "Usage: node scripts/remote-artifact.mjs verify <artifact-directory> [--origin <reviewed-application-origin>] [--for-deploy --spanreed <reviewed-release-checkout>]");
  const sourceVerifier = process.argv.indexOf("--spanreed");
  const originArgument = process.argv.indexOf("--origin");
  await verifyArtifact(resolve(process.argv[3]), {forDeploy: process.argv.includes("--for-deploy"), spanreed: sourceVerifier >= 0 ? resolve(process.argv[sourceVerifier + 1]) : undefined, origin: originArgument >= 0 ? deploymentOrigin(process.argv[originArgument + 1]) : undefined});
  console.log("Remote artifact verified; nothing deployed.");
}
