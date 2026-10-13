import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packageArtifact, run, sourceIdentity } from "./remote-artifact.mjs";
import { deploymentOrigin } from "./deployment-origin.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const execute = promisify(execFile);
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
assert(option("--libs") && option("--output"), "Usage: node scripts/build-remote-artifact.mjs --libs <canonical-libs-checkout> --output <new-artifact-directory> [--origin <reviewed-application-origin>] [--allow-dirty] [--source-archive <archive> --spanreed <reviewed-release-checkout>]");
const libs = resolve(option("--libs"));
const output = resolve(option("--output"));
const origin = deploymentOrigin(option("--origin"));
const sourceArchive = option("--source-archive") ? resolve(option("--source-archive")) : undefined;
const spanreed = option("--spanreed") ? resolve(option("--spanreed")) : undefined;
assert(!sourceArchive || spanreed, "A source archive requires the reviewed Spanreed checkout");
const identities = async () => ({portable: await sourceIdentity(root), libs: await sourceIdentity(libs)});
const before = await identities();
if (!args.includes("--allow-dirty")) assert(!before.portable.dirty && !before.libs.dirty, "Use clean reviewed source commits for a deployable artifact; --allow-dirty builds a local review artifact");
const crypto = await mkdtemp(join(tmpdir(), "fabrials-remote-crypto-"));
try {
  run("bash", [join(libs, "scripts/build-remote-crypto.sh"), crypto]);
  const target = join(libs, "crates/fabrials-remote-noise/target");
  run("cargo", ["build", "--locked", "--manifest-path", join(libs, "Cargo.toml"), "--target-dir", target, "-p", "fabrials-remote-noise", "--example", "interop"]);
  run(process.execPath, ["scripts/test-remote-crypto.mjs", crypto, join(target, "debug/examples/interop")]);
  run(process.execPath, ["scripts/build-remote.mjs"], {env: {...process.env, FABRIALS_REMOTE_CRYPTO_DIST: crypto, FABRIALS_REMOTE_ORIGIN: origin}});
  assert.deepEqual(await identities(), before, "Source changed while building; no deployment artifact was produced");
  const toolchain = {node: process.version, rustc: (await execute("rustc", ["--version"], {encoding: "utf8"})).stdout.trim(), pnpm: (await execute("corepack", ["pnpm", "--version"], {encoding: "utf8", cwd: root})).stdout.trim()};
  await packageArtifact(join(root, "apps/web/dist"), output, before, toolchain, {sourceArchive, spanreed, origin});
  console.log(`Remote ${sourceArchive ? "deployment candidate" : "review artifact (corresponding source not supplied)"} ready at ${output}; nothing deployed.`);
} finally {await rm(crypto, {recursive: true, force: true});}
