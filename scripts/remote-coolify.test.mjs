import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { cacheControl, compose, dockerfile, image, mimeType, nginxConfiguration, packageCoolify, verifyAdapterContents } from "./remote-coolify.mjs";

const policy = JSON.parse(await readFile(new URL("../deploy/remote/qualification-build-output.json", import.meta.url), "utf8"));

test("qualification-only adapter rejects unsafe paths and unknown content types", () => {
  for (const name of ["../secret.txt", "a//b.js", "a/./b.js", "file.js.map", "a;return.js", "a$.js", "a\\b.js", "a b.js", "a%2e.js"]) assert.throws(() => nginxConfiguration(["index.html", name], policy), /Unsafe static path/);
  assert.throws(() => nginxConfiguration(["index.html", "file.exe"], policy), /Unreviewed content type/);
  assert.throws(() => nginxConfiguration(["theme-init.js"], policy));
  const changed = structuredClone(policy);
  changed.routes[0].missing[0].value.eq = "desktop.grok.me";
  assert.throws(() => nginxConfiguration(["index.html"], changed));
});

test("pins runtime image and constrains privileges and resource use", () => {
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  assert.match(dockerfile(), /USER 101:101/);
  assert.match(dockerfile(), /Host: grok.fabrials.com/);
  for (const property of ["read_only: true", "no-new-privileges:true", "pids_limit: 64", "mem_limit: 128m", "cpus: 0.50", "/tmp:size=16m"]) assert(compose().includes(property));
  const configuration = nginxConfiguration(["index.html"], policy);
  for (const property of ["access_log off", "error_log /dev/stderr emerg", "limit_conn all_connections 128", "rate=200r/s", "burst=400", "client_max_body_size 1k", "large_client_header_buffers 2 8k", "client_header_timeout 10s", "worker_connections 256"]) assert(configuration.includes(property));
  assert(!configuration.includes("real_ip_header") && !configuration.includes("X-Forwarded-For"));
});

test("defines browser-consumable MIME and deliberate cache policy", () => {
  assert.equal(mimeType("crypto/noise.wasm"), "application/wasm");
  assert.equal(mimeType("theme-init.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeType("manifest.webmanifest"), "application/manifest+json");
  for (const name of ["assets/a.js", "crypto/noise.wasm", "sources/a.tar.gz"]) assert.match(cacheControl(name), /immutable/);
  for (const name of ["install.sh", "install.ps1"]) assert.equal(cacheControl(name), "no-store");
  for (const name of ["index.html", "sw.js", "manifest.webmanifest", "theme-init.js", "icon-192.png"]) assert.equal(cacheControl(name), "no-cache");
});

test("requires existing full deployment proof before packaging", async () => {
  await assert.rejects(packageCoolify("/nonexistent-grok-artifact", "/nonexistent-grok-artifact-output"), /ENOENT/);
});


test("adapter verification rejects content tampering, forged checksums, added files and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-adapter-integrity-"));
  const hash = value => createHash("sha256").update(value).digest("hex");
  const expected = {schema: 1, files: {"static/index.html": hash("original"), "nginx.conf": hash("reviewed config")}};
  try {
    await mkdir(join(root, "static"));
    await writeFile(join(root, "static/index.html"), "original");
    await writeFile(join(root, "nginx.conf"), "reviewed config");
    await writeFile(join(root, "adapter.json"), JSON.stringify(expected));
    await verifyAdapterContents(root, expected);
    await writeFile(join(root, "static/index.html"), "tampered");
    await assert.rejects(verifyAdapterContents(root, expected), /Changed adapter file/);
    await writeFile(join(root, "static/index.html"), "original");
    const forged = structuredClone(expected);
    forged.files["nginx.conf"] = hash("malicious config");
    await writeFile(join(root, "nginx.conf"), "malicious config");
    await writeFile(join(root, "adapter.json"), JSON.stringify(forged));
    await assert.rejects(verifyAdapterContents(root, expected), /reviewed inputs/);
    await writeFile(join(root, "nginx.conf"), "reviewed config");
    await writeFile(join(root, "adapter.json"), JSON.stringify(expected));
    await writeFile(join(root, "static/extra.txt"), "extra");
    await assert.rejects(verifyAdapterContents(root, expected), /unexpected files/);
    await rm(join(root, "static/extra.txt"));
    await rm(join(root, "static/index.html"));
    await symlink("../nginx.conf", join(root, "static/index.html"));
    await assert.rejects(verifyAdapterContents(root, expected), /Symlink/);
  } finally {await rm(root, {recursive: true, force: true});}
});
