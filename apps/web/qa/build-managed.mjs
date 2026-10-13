import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "vite";

const [origin, output] = process.argv.slice(2);
const web = fileURLToPath(new URL("..", import.meta.url));
assert.ok(origin && output && resolve(output) === output);
const parsed = new URL(origin);
assert.ok(parsed.protocol === "http:" && parsed.hostname === "localhost" && parsed.port && parsed.pathname === "/");
assert.equal(parsed.origin, origin);
assert.ok(process.env.FABRIALS_REMOTE_CRYPTO_DIST, "Frozen Noise assets required");
await mkdir(output, {mode: 0o700});
const sha = data => createHash("sha256").update(data).digest("hex");
async function sourceIdentity() {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const directory of ["src", "public", "scripts", "qa"]) await collect(join(web, directory));
  files.push(join(web, "vite.config.ts"), join(web, "index.html"), join(web, "package.json"), resolve(web, "../../pnpm-lock.yaml"));
  return Promise.all(files.sort().map(async path => ({path, sha256: sha(await readFile(path))})));
}
const sources = await sourceIdentity();
const boundarySources = [];
const transformed = [];
const expected = new Set(["remoteAccount.ts", "remoteConnector.ts", "client.ts"]);
const plugin = {
  name: "managed-acceptance-loopback-boundaries",
  enforce: "pre",
  transform(source, id) {
    const relative = id.replaceAll("\\", "/").split("/src/services/")[1];
    if (!expected.has(relative)) return;
    boundarySources.push({path: id, sha256: sha(source)});
    let result = source;
    const substitute = (before, after) => {
      assert.equal(result.split(before).length, 2, `One exact fixture boundary required: ${relative}`);
      result = result.replace(before, after);
    };
    if (relative === "remoteAccount.ts") substitute('export const ACCOUNT_ORIGIN = "https://fabrials.com";', `export const ACCOUNT_ORIGIN = ${JSON.stringify(origin)};`);
    if (relative === "remoteConnector.ts") {
      substitute('const API = "https://fabrials.com/api/spanreed/remote";', `const API = ${JSON.stringify(`${origin}/api/spanreed/remote`)};`);
      substitute('const RELAY = "wss://remote-relay.fabrials.com/connect";', `const RELAY = ${JSON.stringify(`${origin.replace("http:", "ws:")}/qa-relay`)};`);
    }
    if (relative === "client.ts") substitute('export const REMOTE_SPA_ORIGIN = "https://remote.fabrials.com";', `export const REMOTE_SPA_ORIGIN = ${JSON.stringify(origin)};`);
    assert.notEqual(result, source, `Fixture boundary remains explicit: ${relative}`);
    transformed.push(relative);
    return result;
  },
};
process.env.VITE_REMOTE = "1";
process.env.VITE_REMOTE_EXPERIMENTS = "drafts,dictation,speech-playback,share-target,remote-projects,control-transfer,device-panel,push";
await build({configFile: join(web, "vite.config.ts"), root: web, plugins: [plugin], build: {outDir: output, emptyOutDir: false}});
assert.deepEqual(new Set(transformed), expected);
assert.deepEqual(await sourceIdentity(), sources, "Product sources must remain unchanged throughout the build");
const workerPath = join(output, "sw.js");
const worker = await readFile(workerPath, "utf8");
const needle = 'const PUSH_ACCOUNT_ORIGIN = "https://fabrials.com";';
assert.ok(worker.includes(needle), "Push worker must expose its fixed production boundary before fixture substitution");
await writeFile(workerPath, worker.replace(needle, `const PUSH_ACCOUNT_ORIGIN = ${JSON.stringify(origin)};`));
const artifacts = [];
async function scan(directory, prefix = "") {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await scan(join(directory, entry.name), `${name}/`);
    else artifacts.push({path: name, sha256: sha(await readFile(join(directory, entry.name)))});
  }
}
await scan(output);
await writeFile(join(output, "qualification-manifest.json"), JSON.stringify({schema: 1, origin, sources, boundarySources, artifacts, experiments: process.env.VITE_REMOTE_EXPERIMENTS.split(","), boundaries: ["HTTP localhost account proxy using a synthetic browser family", "Loopback WebSocket proxy to the real relay fixture", "Remote entry selected on fixture origin", "Worker account origin changed only in generated fixture"], notQualified: ["Unmodified production-origin bundle", "Production OAuth and HTTPS ingress", "Real Grok inference"]}, null, 2), {mode: 0o600});
