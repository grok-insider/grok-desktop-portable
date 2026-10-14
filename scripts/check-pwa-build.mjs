import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { workerManifest } from "./worker-manifest.mjs";
import { buildOrigin, deploymentOrigin } from "./deployment-origin.mjs";

const directory = resolve(process.argv[2] ?? "apps/web/dist");
const requiredCrypto = process.argv.includes("--require-crypto");
const sw = await readFile(resolve(directory, "sw.js"), "utf8");
const {files, cache} = workerManifest(sw);
assert(Array.isArray(files) && new Set(files).size === files.length);
for (const name of files) {
  assert(/^(?:index\.html|manifest\.webmanifest|theme-init\.js|third-party-notices\.txt|icon-(?:192|512)\.png|assets\/[A-Za-z0-9_.-]+|crypto\/[a-f0-9]{20}\/fabrials_remote_noise(?:_bg\.wasm|\.js))$/.test(name), `Non-shell or unsafe cached path: ${name}`);
  assert((await stat(resolve(directory, name))).size > 0, `Empty shell file: ${name}`);
}
for (const name of ["index.html", "manifest.webmanifest", "theme-init.js", "icon-192.png", "icon-512.png", "third-party-notices.txt"]) assert(files.includes(name), `Missing shell entry: ${name}`);
const index = await readFile(resolve(directory, "index.html"), "utf8");
const origin = buildOrigin(index);
const originArgument = process.argv.indexOf("--origin");
if (originArgument >= 0) assert.equal(origin, deploymentOrigin(process.argv[originArgument + 1]), "Shell origin differs from requested deployment origin");
const decodedIndex = index.replaceAll("&#39;", "'");
const identities = [...index.matchAll(/<meta name="grok-shell-build" content="([a-f0-9]{64})">/g)];
assert.equal(identities.length, 1, "PWA requires one shell build identity");
assert.equal(cache, `grok-shell-${identities[0][1].slice(0, 16)}`, "HTML and worker must identify the same shell");
if (requiredCrypto) assert(index.includes("<title>Grok Remote</title>"), "Remote build must identify itself as Grok Remote");
assert(decodedIndex.includes("'wasm-unsafe-eval'") && decodedIndex.includes("worker-src 'self'"));
assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(index), "Inline bootstrap breaks the production CSP");
for (const [, source] of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert(source.startsWith("/"), `Relative entry URL breaks a session deep link: ${source}`);
  assert(files.includes(source.slice(1)), `Entry URL absent from the shell: ${source}`);
}
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.webmanifest"), "utf8"));
assert.equal(manifest.start_url, "/"); assert.equal(manifest.scope, "/"); assert.equal(manifest.display, "standalone");
for (const size of [192, 512]) {
  const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
  assert(icon?.src === `/icon-${size}.png` && icon.type === "image/png");
  const png = await readFile(resolve(directory, icon.src.slice(1)));
  assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
}
const crypto = files.filter((name) => name.startsWith("crypto/"));
if (requiredCrypto || crypto.length) {
  assert.equal(crypto.length, 2, "Remote requires the JS and WASM pair");
  assert.equal(crypto[0].split("/")[1], crypto[1].split("/")[1]);
  const wasm = await readFile(resolve(directory, crypto.find((name) => name.endsWith(".wasm"))));
  await WebAssembly.compile(wasm);
  const scripts = await Promise.all(files.filter((name) => name.startsWith("assets/") && name.endsWith(".js")).map((name) => readFile(resolve(directory, name), "utf8")));
  assert(scripts.some((script) => script.includes(crypto.find((name) => name.endsWith(".js")))), "The app does not load its versioned crypto asset");
}
console.log(`PWA build verified: ${files.length} shell files, ${crypto.length ? "compiled versioned crypto" : "desktop bundle"}.`);
