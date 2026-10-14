import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { cacheControl, dockerfile, mimeType, nginxConfiguration } from "./remote-coolify.mjs";

const execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const policy = JSON.parse(await readFile(new URL("../deploy/remote/qualification-build-output.json", import.meta.url), "utf8"));
const security = Object.assign({}, ...policy.routes.filter(route => route.continue && route.src === "/.*").map(route => route.headers));

function request(port, path = "/", {method = "GET", host = "grok.fabrials.com", headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({host: "127.0.0.1", port, path, method, headers: {Host: host, ...headers}, timeout: 10000}, response => {
      const bytes = [];
      response.on("data", part => bytes.push(part));
      response.on("end", () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(bytes)}));
    });
    call.on("error", reject);
    call.on("timeout", () => call.destroy(new Error("HTTP timeout")));
    call.end(body);
  });
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("real hardened nginx serves only the reviewed shell and source bytes", {timeout: 180000}, async t => {
  const root = await mkdtemp(join(tmpdir(), "remote-coolify-http-"));
  const context = process.env.REMOTE_COOLIFY_ADAPTER || root;
  const tag = `grok-coolify-test:${randomBytes(8).toString("hex")}`;
  let container;
  try {
    let names;
    if (process.env.REMOTE_COOLIFY_ADAPTER) {
      const manifest = JSON.parse(await readFile(join(context, "adapter.json"), "utf8"));
      names = Object.keys(manifest.files).filter(name => name.startsWith("static/")).map(name => name.slice(7));
    } else {
      const fixture = {"licenses.html": "<html><body>Licenses</body></html>", "index.html": "<html><head><title>Grok fixture</title></head><body>synthetic</body></html>", "theme-init.js": "void 0;", "sw.js": "self.addEventListener('fetch', () => {});", "manifest.webmanifest": '{"name":"Grok fixture"}', "assets/app.js": `const a = ${JSON.stringify("x".repeat(10000))};`, "assets/style.css": "body { color: black; }", "crypto/noise.wasm": Buffer.from([0,97,115,109,1,0,0,0]), "assets/font.woff2": "synthetic-font", "icon-192.png": "synthetic-icon", "install.sh": "#!/bin/sh\nexit 0\n", "install.ps1": "exit 0\n", "sources/aaaa.json": "{}", "sources/aaaa.tar.gz": "synthetic-source", "sources/aaaa.license.txt": "synthetic-license"};
      names = Object.keys(fixture).sort();
      for (const [name, bytes] of Object.entries(fixture)) {await mkdir(dirname(join(root, "static", name)), {recursive: true}); await writeFile(join(root, "static", name), bytes);}
      await writeFile(join(root, "nginx.conf"), nginxConfiguration(names, policy));
      await writeFile(join(root, "Dockerfile"), dockerfile());
    }
    await execute("docker", ["build", "--tag", tag, context], {maxBuffer: 2 * 1024 * 1024});
    const result = await execute("docker", ["run", "--detach", "--read-only", "--tmpfs", "/tmp:size=16m,mode=1777,noexec,nosuid", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "-p", "127.0.0.1::8080", tag]);
    container = result.stdout.trim();
    const inspection = JSON.parse((await execute("docker", ["inspect", container])).stdout)[0];
    assert(inspection.NetworkSettings.Ports["8080/tcp"], (await execute("docker", ["logs", container])).stderr || "Container stopped before publishing port");
    const port = Number(inspection.NetworkSettings.Ports["8080/tcp"][0].HostPort);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {ready = (await request(port, "/healthz")).status === 200;} catch {}
      if (ready) break;
      await delay(100);
    }
    assert(ready, "nginx did not become healthy");
    await t.test("runs unprivileged with a read-only root and bounded resources", () => {
      assert.equal(inspection.Config.User, "101:101");
      assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspection.HostConfig.Memory, 128 * 1024 * 1024);
      assert.equal(inspection.HostConfig.MemorySwap, inspection.HostConfig.Memory);
      assert(inspection.HostConfig.Tmpfs["/tmp"].includes("noexec,nosuid"));
      assert.equal(inspection.HostConfig.NanoCpus, 500000000);
      assert.equal(inspection.HostConfig.PidsLimit, 64);
      assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
    });
    await t.test("all static payloads retain their hashes, MIME and cache semantics", async () => {
      for (const name of names) {
        const result = await request(port, `/${name}`);
        assert.equal(result.status, 200, name);
        assert.equal(sha(result.body), sha(await readFile(join(context, "static", name))), name);
        assert.equal(result.headers["content-type"], mimeType(name), name);
        assert.equal(result.headers["cache-control"], cacheControl(name), name);
        assert.equal(result.headers["strict-transport-security"], "max-age=31536000");
        assert(result.headers.link.includes('</licenses>; rel="license"'));
        for (const [key, value] of Object.entries(security)) assert.equal(result.headers[key.toLowerCase()], value, name);
      }
    });
    await t.test("only root, setup and single-segment session routes receive HTML", async () => {
      const expected = await readFile(join(context, "static/index.html"));
      for (const path of ["/", "/setup", "/s/session_1.a-b", "/?opaque=never-log-this", "/setup?anything=ok"]) {
        const result = await request(port, path);
        assert.equal(result.status, 200, path);
        assert.equal(sha(result.body), sha(expected), path);
        assert.equal(result.headers["cache-control"], "no-cache");
      }
      for (const path of ["/api", "/api/health", "/setup/", "/s/", "/s/abc/def", "/missing", "/.env", "/sources/", "/assets/", "/unknown.js", "/assets/a.js.map", "/adapter.json", "/Dockerfile"]) {
        const result = await request(port, path);
        assert.equal(result.status, 404, path);
        assert.equal(result.headers["cache-control"], "no-store", path);
      }
    });
    await t.test("rejects mismatched Host including health probes", async () => {
      for (const host of ["localhost", "grok.fabrials.com:443", "grok.fabrials.com.", "grok.fabrials.com.evil.invalid", "desktop.grok.me", "GROK.FABRIALS.COM"]) {
        for (const path of ["/", "/healthz"]) assert.equal((await request(port, path, {host})).status, 404, `${host}${path}`);
      }
    });
    await t.test("rejects mutating methods, encoded paths and normalization bypasses", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {const rejected = await request(port, "/", {method}); assert.equal(rejected.status, 405, method); assert.equal(rejected.headers.allow, "GET, HEAD");}
      for (const path of ["/foo/../index.html", "/./index.html", "//index.html", "/%69ndex.html", "/%2e%2e/index.html", "/s/%2e", "/assets%2fapp.js", "/foo\\bar", "/sources/../index.html"]) assert([400, 404].includes((await request(port, path)).status), path);
      assert.equal((await request(port, "/", {headers: {"Content-Length": "2048"}, body: "x".repeat(2048)})).status, 413);
      assert.equal((await request(port, "/" + "x".repeat(18000))).status, 414);
    });
    await t.test("supports HEAD, worker scope, compression and conditional static requests", async () => {
      const head = await request(port, "/", {method: "HEAD"});
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(Number(head.headers["content-length"]), (await readFile(join(context, "static/index.html"))).length);
      const worker = await request(port, "/sw.js");
      assert.equal(worker.headers["service-worker-allowed"], "/");
      const asset = names.find(name => name.startsWith("assets/") && name.endsWith(".js"));
      assert(asset);
      const compressed = await request(port, `/${asset}`, {headers: {"Accept-Encoding": "gzip"}});
      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(sha(gunzipSync(compressed.body)), sha(await readFile(join(context, "static", asset))));
      const plain = await request(port, `/${asset}`);
      assert(plain.headers.etag);
      assert.equal((await request(port, `/${asset}`, {headers: {"If-None-Match": plain.headers.etag}})).status, 304);
      for (const encoding of ["identity", "gzip"]) {
        const range = await request(port, `/${asset}`, {headers: {Range: "bytes=0-9", "Accept-Encoding": encoding}});
        assert.equal(range.status, 206, encoding);
        assert.equal(range.headers["content-encoding"], undefined, encoding);
        assert.equal(range.body.length, 10);
        assert.equal(range.headers["content-range"], `bytes 0-9/${(await readFile(join(context, "static", asset))).length}`);
        assert.deepEqual(range.body, (await readFile(join(context, "static", asset))).subarray(0, 10));
      }
      for (const options of [{headers: {Range: "bytes=999999999999-"}}, {headers: {Range: "bytes=999999999999-", "Accept-Encoding": "gzip"}}, {method: "POST"}]) {
        const rejected = await request(port, `/${asset}`, options);
        assert([405, 416].includes(rejected.status));
        assert.deepEqual([...new Set(rejected.headers["cache-control"].split(", "))], ["no-store"]);
      }
    });
    await t.test("license supplements are discoverable without replacing original source metadata", async () => {
      const legal = await request(port, "/licenses");
      assert.equal(legal.status, 200);
      assert.equal(legal.headers["cache-control"], "no-cache");
      if (process.env.REMOTE_COOLIFY_ADAPTER) {
        const manifest = JSON.parse(await readFile(join(context, "adapter.json"), "utf8"));
        assert(manifest.supplements.length > 0);
        assert(legal.body.includes(Buffer.from('<link rel="icon" href="/icon-192.png">')));
        const legalHashes = [...legal.body.toString("utf8").matchAll(/<code>(.*?)<\/code>/g)].map(match => match[1]);
        assert.equal(legalHashes.length, manifest.inputs.length);
        for (const [i, hash] of legalHashes.entries()) {
          assert.match(hash, /^(?:[a-f0-9]{8}<wbr>){7}[a-f0-9]{8}$/);
          assert.equal(hash.replaceAll("<wbr>", ""), manifest.inputs[i].correspondingSource.split("/").at(-1).replace(".json", ""));
        }
        for (const [i, item] of manifest.supplements.entries()) {
          assert(legal.body.includes(Buffer.from(item.supplement.path)));
          const descriptor = JSON.parse(await readFile(join(context, item.descriptorPath), "utf8"));
          for (const compiled of i === 0 ? [descriptor.wasm, descriptor.javascript] : []) {
            const response = await request(port, compiled.path);
            assert(response.headers.link.includes(`<${item.supplement.path}>; rel="license"`));
          }
        }
      }
    });
    await t.test("global request limiting bounds bursts and recovers without failing health", async () => {
      const statuses = [];
      const asset = names.find(name => name.startsWith("assets/"));
      for (let batch = 0; batch < 8; batch++) {
        const results = await Promise.all(Array.from({length: 100}, () => request(port, `/${asset}`, {method: "HEAD"})));
        statuses.push(...results.map(result => result.status));
        for (const result of results.filter(result => result.status === 429)) assert.equal(result.headers["cache-control"], "no-store");
      }
      assert(statuses.includes(429), "Oversized request burst should be rate limited");
      assert(statuses.every(status => status === 200 || status === 429));
      assert.equal((await request(port, "/healthz")).status, 200);
      await delay(2500);
      assert.equal((await request(port, "/theme-init.js")).status, 200);
    });
    await t.test("request targets and query strings do not appear in container logs", async () => {
      const logs = await execute("docker", ["logs", container]);
      assert.equal(logs.stdout, "");
      assert.equal(logs.stderr, "");
      await execute("docker", ["exec", container, "wget", "-q", "-O", "/dev/null", "--header=Host: grok.fabrials.com", "http://127.0.0.1:8080/healthz"]);
    });
  } finally {
    if (container) await execute("docker", ["rm", "--force", container]).catch(() => {});
    await execute("docker", ["image", "rm", tag]).catch(() => {});
    await rm(root, {recursive: true, force: true});
  }
});
