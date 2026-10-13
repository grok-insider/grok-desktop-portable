import {createServer} from "node:http";
import {createReadStream, existsSync, readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {resolve, join, extname, sep} from "node:path";
import assert from "node:assert/strict";

const artifact = process.argv[2] && resolve(process.argv[2]);
const evidence = process.argv[3] && resolve(process.argv[3]);
if (!artifact || !evidence || existsSync(evidence) || !process.env.PLAYWRIGHT_MODULE || !process.env.BROWSER_CDP) throw new Error("need flagged artifact, new evidence file, PLAYWRIGHT_MODULE and BROWSER_CDP");
if (!["127.0.0.1", "localhost"].includes(new URL(process.env.BROWSER_CDP).hostname)) throw new Error("local laboratory browser required");
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const source = readFileSync(new URL("../apps/web/src/services/shareInboxStore.js", import.meta.url), "utf8");
const worker = readFileSync(join(artifact, "sw.js"), "utf8");
assert(worker.includes(source.replace(/^export /gm, "")), "worker must contain exact source being tested");
const manifest = JSON.parse(readFileSync(join(artifact, "manifest.webmanifest"), "utf8"));
assert.equal(manifest.share_target?.method, "POST");
assert.equal(manifest.share_target?.action, "/share-inbox");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/__share-store.js") {response.writeHead(200, {"content-type": "text/javascript", "cache-control": "no-store"}).end(source); return;}
  if (url.pathname === "/__share-test.html" || url.pathname === "/") {response.writeHead(200, {"content-type": "text/html", "cache-control": "no-store"}).end("<!doctype html><title>Share target laboratory</title><main>Share target laboratory</main>"); return;}
  if (url.pathname === "/favicon.ico") {response.writeHead(204).end(); return;}
  let path;
  try {path = resolve(artifact, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);} catch {response.writeHead(400).end(); return;}
  if (!path.startsWith(artifact + sep) || !existsSync(path)) {response.writeHead(404).end(); return;}
  response.writeHead(200, {"content-type": ({".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".webmanifest": "application/manifest+json"})[extname(path)] ?? "application/octet-stream", "cache-control": "no-store"});
  const stream = createReadStream(path); stream.on("error", () => response.destroy()); stream.pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.connectOverCDP(process.env.BROWSER_CDP);
const context = await browser.newContext({viewport: {width: 2560, height: 1440}});
const page = await context.newPage();
const report = {browser: browser.version(), startedAt: new Date().toISOString(), tests: [], sourceSha256: createHash("sha256").update(source).digest("hex"), workerSha256: createHash("sha256").update(worker).digest("hex"), artifact, physicalAndroid: false, limitations: ["Synthetic browser multipart POST; Android OS share sheet and installation remain unqualified", "IndexedDB durability across Android process death and storage eviction remain unqualified"]};
try {
  await page.goto(`${origin}/__share-test.html`);
  const store = await page.evaluate(async () => {
    const api = await import("/__share-store.js");
    const checks = [];
    const check = (name, condition) => {if (!condition) throw new Error(name); checks.push(name);};
    const content = (text) => ({title: "", text, url: "", files: []});
    const clear = async () => {for (const entry of await api.readShareInbox()) await api.removeShare(entry.id);};
    const modify = async (run) => {
      const db = await new Promise((resolve, reject) => {const request = indexedDB.open("grok-share-inbox-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);});
      try {await new Promise((resolve, reject) => {const transaction = db.transaction("inbox", "readwrite"); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); run(transaction.objectStore("inbox"));});} finally {db.close();}
    };
    await clear();
    const concurrent = await Promise.allSettled(Array.from({length: 6}, (_, index) => api.enqueueSharedContent(content(`concurrent-${index}`))));
    check("concurrent enqueue admits exactly three", concurrent.filter((item) => item.status === "fulfilled").length === 3 && (await api.readShareInbox()).length === 3);
    check("full queue rejects explicitly", concurrent.filter((item) => item.status === "rejected").every((item) => item.reason.message === "share_inbox_full"));
    await clear();
    const duplicate = await Promise.all(Array.from({length: 6}, () => api.enqueueSharedContent(content("duplicate"))));
    check("atomic dedup shares one id", new Set(duplicate).size === 1 && (await api.readShareInbox()).length === 1);
    const id = duplicate[0];
    const claims = await Promise.allSettled([api.claimShare(id), api.claimShare(id)]);
    check("one concurrent claim succeeds", claims.filter((item) => item.status === "fulfilled").length === 1 && claims.filter((item) => item.status === "rejected").length === 1);
    const claim = claims.find((item) => item.status === "fulfilled").value;
    const wrong = await Promise.allSettled([api.removeShare(id, "wrong"), api.recoverShare(id, "wrong")]);
    check("wrong claims cannot delete or recover", wrong.every((item) => item.status === "rejected") && (await api.readShareInbox())[0].state === "claimed");
    await api.recoverShare(id, claim);
    check("explicit recovery returns pending", (await api.readShareInbox())[0].state === "pending");
    await api.removeShare(id, await api.claimShare(id));
    check("exact completed claim removed", (await api.readShareInbox()).length === 0);
    const ageId = await api.enqueueSharedContent(content("aged duplicate"));
    const aged = (await api.readShareInbox())[0];
    await modify((store) => store.put({...aged, createdAt: Date.now() - 10_001}));
    check("same share after ten seconds is distinct", await api.enqueueSharedContent(content("aged duplicate")) !== ageId);
    await modify((store) => {store.clear(); store.put({...aged, createdAt: Date.now() - api.SHARE_TTL_MS}); store.put({...aged, id: "malformed", content: {...aged.content, files: [null]}});});
    check("expired and corrupt records are evicted", (await api.readShareInbox()).length === 0);
    const form = (size, count = 1) => {const body = new FormData(); body.set("text", "file review"); for (let index = 0; index < count; index++) body.append("files", new File([new Uint8Array(size)], `sample-${index}.bin`, {type: "application/octet-stream"})); return new Request(`${location.origin}/share-inbox`, {method: "POST", body});};
    check("multipart permits exact 200KB file boundary", (await api.parseSharedRequest(form(200_000))).files[0].data.byteLength === 200_000);
    check("multipart permits three bounded files", (await api.parseSharedRequest(form(200_000, 3))).files.length === 3);
    for (const [name, request] of [["multipart rejects boundary plus one", form(200_001)], ["multipart rejects fourth file", form(1, 4)]]) {
      try {await api.parseSharedRequest(request); throw new Error("unexpected pass");} catch (error) {check(name, error.message === "share_too_large");}
    }
    const original = Object.getOwnPropertyDescriptor(window, "indexedDB");
    Object.defineProperty(window, "indexedDB", {configurable: true, value: {open() {throw new DOMException("denied", "SecurityError");}}});
    try {await api.readShareInbox(); throw new Error("unexpected pass");} catch (error) {check("denied storage rejects instead of silently accepting", error.name === "SecurityError" || error.message === "share_storage_unavailable");} finally {Object.defineProperty(window, "indexedDB", original);}
    return checks;
  });
  report.tests.push(...store);
  await page.evaluate(async () => {await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const workerChecks = await page.evaluate(async () => {
    const api = await import("/__share-store.js");
    const checks = [];
    const check = (name, condition) => {if (!condition) throw new Error(name); checks.push(name);};
    const form = new FormData(); form.set("title", "Synthetic OS share"); form.set("text", "must be reviewed"); form.set("url", "https://example.com/source");
    const response = await fetch("/share-inbox", {method: "POST", body: form, redirect: "follow"});
    const entries = await api.readShareInbox();
    check("active worker redirects POST to document", response.status === 200 && response.redirected && new URL(response.url).pathname === "/");
    check("worker persists content pending review", entries.length === 1 && entries[0].state === "pending" && entries[0].content.text === "must be reviewed");
    const duplicate = await fetch("/share-inbox", {method: "POST", body: form});
    check("repeated worker submission deduplicates", duplicate.ok && (await api.readShareInbox()).length === 1);
    const oversized = new FormData(); oversized.append("files", new File([new Uint8Array(200_001)], "large.bin"));
    const rejected = await fetch("/share-inbox", {method: "POST", body: oversized});
    check("worker gives bounded no-store failure", rejected.status === 413 && rejected.headers.get("cache-control") === "no-store" && (await api.readShareInbox()).length === 1);
    const cached = await caches.keys();
    for (const name of cached) {const cache = await caches.open(name); const keys = await cache.keys(); check(`shell cache excludes shares ${name}`, keys.every((key) => !key.url.includes("share-inbox") && !key.url.includes("must%20be%20reviewed")));}
    return checks;
  });
  report.tests.push(...workerChecks);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/" && /^#share=[a-f0-9-]{36}$/.test(url.hash)),
    page.evaluate(() => {
      const form = document.createElement("form"); form.action = "/share-inbox"; form.method = "POST"; form.enctype = "multipart/form-data";
      for (const [name, value] of Object.entries({title: "Synthetic OS share", text: "must be reviewed", url: "https://example.com/source"})) {const input = document.createElement("input"); input.name = name; input.value = value; form.append(input);}
      document.body.append(form); form.requestSubmit();
    }),
  ]);
  const navigation = await page.evaluate(async () => {const api = await import("/__share-store.js"); const entries = await api.readShareInbox(); return entries.length === 1 && location.hash === `#share=${entries[0].id}`;});
  assert(navigation, "real form navigation redirects with only opaque share id");
  report.tests.push("real form navigation redirects with only opaque share id");
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${origin}/__share-test.html`);
  const persisted = await reopened.evaluate(async () => {const api = await import("/__share-store.js"); const entries = await api.readShareInbox(); return entries.length === 1 && entries[0].state === "pending";});
  assert(persisted, "inbox survives page close without automatic consumption");
  report.tests.push("inbox survives page close without automatic consumption");
  await reopened.evaluate(async () => {const api = await import("/__share-store.js"); for (const entry of await api.readShareInbox()) await api.removeShare(entry.id); for (const worker of await navigator.serviceWorker.getRegistrations()) await worker.unregister(); for (const name of await caches.keys()) await caches.delete(name);});
  report.status = "passed";
} catch (error) {report.status = "failed"; report.error = String(error); process.exitCode = 1;}
finally {await context.close(); await browser.close(); await new Promise((done) => server.close(done)); report.finishedAt = new Date().toISOString(); writeFileSync(evidence, JSON.stringify(report, null, 2));}
process.stdout.write(JSON.stringify({status: report.status, tests: report.tests.length, error: report.error}) + "\n");
