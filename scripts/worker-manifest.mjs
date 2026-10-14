import assert from "node:assert/strict";

export function workerManifest(worker) {
  const declarations = name => [...worker.matchAll(new RegExp(`^const ${name} = ([^\\r\\n]+);$`, "gm"))];
  const shell = declarations("SHELL");
  const cache = declarations("CACHE");
  assert.equal(shell.length, 1, "Worker requires one literal shell declaration");
  assert.equal(cache.length, 1, "Worker requires one literal cache declaration");
  const files = JSON.parse(shell[0][1]);
  const name = JSON.parse(cache[0][1]);
  assert(Array.isArray(files) && files.length > 0 && files.length <= 1000 && files.every(file => typeof file === "string"));
  assert(files.every(file => /^(?:index\.html|manifest\.webmanifest|theme-init\.js|third-party-notices\.txt|icon-(?:192|512)\.png|assets\/[A-Za-z0-9_.-]+|crypto\/[a-f0-9]{20}\/fabrials_remote_noise(?:_bg\.wasm|\.js))$/.test(file)), "Unsafe worker shell path");
  assert.equal(new Set(files).size, files.length, "Worker shell entries must be unique");
  assert(typeof name === "string" && /^grok-shell-[a-f0-9]{16}$/.test(name), "Invalid worker cache identity");
  return {files, cache: name};
}
