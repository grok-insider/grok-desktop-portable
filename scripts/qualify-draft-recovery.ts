import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {openSync, closeSync} from "node:fs";
import {mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {resolve, join} from "node:path";

const [fixtureArgument, outputArgument] = process.argv.slice(2);
assert.ok(fixtureArgument && outputArgument, "Usage: bun scripts/qualify-draft-recovery.ts <frozen-combined-fixture> <new-evidence-directory>");
const fixture = resolve(fixtureArgument);
const output = resolve(outputArgument);
await mkdir(output, {mode: 0o700});
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const html = await readFile(join(fixture, "index.html"));
const workerTemplate = await readFile(resolve(import.meta.dir, "../apps/web/scripts/service-worker.js"), "utf8");
const report: any = {schema: 1, scope: "real-browser-durable-indexeddb-and-product-worker-with-synthetic-remote-transport", scriptSha256: hash(await readFile(import.meta.path)), fixtureHtmlSha256: hash(html), workerTemplateSha256: hash(workerTemplate), checks: [], errors: [], notQualified: ["Android process eviction", "Physical power loss", "Authenticated host and account switching", "Participant utility"]};
const versions = ["grok-shell-draft-qa-v1", "grok-shell-draft-qa-v2"];
let version = 0;
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const headers = {"cache-control": "no-store"};
  if (path === "/" || path === "/index.html") return new Response(html, {headers: {...headers, "content-type": "text/html"}});
  if (path === "/sw.js") {
    const source = workerTemplate.replace("__SHELL__", '["index.html"]').replace("__CACHE__", JSON.stringify(versions[version])).replace("__SHARE_TARGET__", "disabled");
    return new Response(source, {headers: {...headers, "content-type": "text/javascript"}});
  }
  return new Response(null, {status: 404});
}});
let browser: any;
let context: any;
let failure: unknown;
const children: ReturnType<typeof spawn>[] = [];
const profile = join(output, "chrome-profile");
const nestedEnvironment = JSON.parse(await readFile(process.env.REMOTE_QA_NESTED_ENV ?? "/tmp/grok-remote-evaluation-ter17my1/hidden-chrome-environment.json", "utf8"));
assert.match(nestedEnvironment.WAYLAND_DISPLAY, /^wayland-\d+$/);
assert.equal(nestedEnvironment.XDG_RUNTIME_DIR, `/run/user/${process.getuid!()}`);
const chrome = process.env.REMOTE_QA_CHROME ?? "/nix/store/n8ci2jsv67c1b0p14k7mfvzcr3nxy7q5-google-chrome-155.0.8059.39/bin/google-chrome-stable";
async function launch(chromium: any) {
  await rm(join(profile, "DevToolsActivePort"), {force: true});
  const log = openSync(join(output, `chrome-${children.length}.log`), "wx", 0o600);
  const child = spawn(chrome, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--ozone-platform=wayland", "--password-store=basic", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--hide-crash-restore-bubble", "--start-fullscreen", "--window-size=2560,1440", "about:blank"], {env: {...process.env, ...nestedEnvironment}, detached: true, stdio: ["ignore", log, log]});
  closeSync(log);children.push(child);
  const deadline = Date.now() + 20_000;
  let port: number | undefined;
  while (!port) {
    assert.equal(child.exitCode, null, "dedicated hidden browser remains alive");
    assert.equal(child.signalCode, null, "dedicated hidden browser remains alive");
    assert.ok(Date.now() < deadline, "dedicated browser debugging port");
    try {port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]) || undefined;} catch {}
    if (!port) await Bun.sleep(50);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  context = browser.contexts()[0];
  await context.addInitScript(() => {Object.defineProperty(window, "remoteQaRealServiceWorker", {value: true});});
  return child;
}
async function stop(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  process.kill(-child.pid!, signal);
  await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), Bun.sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
  await Promise.race([new Promise(resolveExit => {if (child.exitCode !== null || child.signalCode !== null) resolveExit(undefined);else child.once("exit", resolveExit);}), Bun.sleep(2000)]);
}
async function draftRecords(expire = false): Promise<{scopes: any[]; drafts: any[]}> {
  return new Promise((resolveRecords, reject) => {
    const open = indexedDB.open("grok-remote-drafts.v2", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(["scopes", "drafts"], expire ? "readwrite" : "readonly", {durability: "strict"});
      const scopes = transaction.objectStore("scopes").getAll();
      const drafts = transaction.objectStore("drafts").getAll();
      drafts.onsuccess = () => {
        if (expire) for (const row of drafts.result) transaction.objectStore("drafts").put({...row, savedAt: Date.now() - 7 * 24 * 60 * 60 * 1000});
      };
      transaction.oncomplete = () => {database.close();resolveRecords({scopes: scopes.result, drafts: drafts.result});};
      transaction.onabort = transaction.onerror = () => {database.close();reject(transaction.error);};
    };
  });
}
const check = (name: string, value: unknown) => {assert.ok(value, name);report.checks.push(name);};
try {
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  let ownedBrowser = await launch(chromium);
  let page = await context.newPage();
  const observe = (target: any) => target.on("pageerror", (error: Error) => report.errors.push(error.message));
  observe(page);
  await page.goto(server.url.origin);
  const input = () => page.getByRole("textbox", {name: /message the agent/i});
  await input().waitFor();
  await page.getByRole("button", {name: "Remember drafts on this device"}).click();
  let draft = "Recover this synthetic unsent draft after worker replacement and browser process loss.";
  await input().fill(draft);
  await page.locator('[data-draft-status="saved"]').waitFor();
  await page.evaluate(async () => {await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;});
  await page.reload();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("draft_survives_first_worker_control", await input().inputValue() === draft && await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  version = 1;
  await page.evaluate(async () => {const registration = await navigator.serviceWorker.getRegistration();await registration!.update();});
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  await page.evaluate(async () => {(await navigator.serviceWorker.getRegistration())!.waiting!.postMessage({kind: "activateUpdate"});});
  await page.waitForFunction(async () => (await caches.keys()).includes("grok-shell-draft-qa-v2") && !(await caches.keys()).includes("grok-shell-draft-qa-v1"));
  await page.reload();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("worker_update_preserves_draft_and_cleans_old_shell", await input().inputValue() === draft);
  check("draft_excluded_from_shell_cache", await page.evaluate(async (text: string) => {
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) {
      const response = await (await caches.open(key)).match(request);
      if ((await response!.text()).includes(text)) return false;
    }
    return true;
  }, draft));
  await context.setOffline(true);
  await page.reload();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("offline_shell_restores_unsent_draft", await input().inputValue() === draft);
  await context.setOffline(false);
  draft += " Final durable edit immediately before SIGKILL.";
  await input().fill(draft);
  await page.locator('[data-draft-status="saved"]').waitFor();
  const lastSavedAt = Date.now();
  report.beforeProcessDeath = {storage: await page.evaluate(draftRecords), ageSinceObservedSaveMs: Date.now() - lastSavedAt};
  const killedPid = ownedBrowser.pid;
  await stop(ownedBrowser, "SIGKILL");
  assert.equal(ownedBrowser.signalCode, "SIGKILL", "browser was abruptly killed, not closed through its UI");
  await browser.close().catch(() => {});
  ownedBrowser = await launch(chromium);
  assert.notEqual(ownedBrowser.pid, killedPid);
  report.browserRestart = {previousPid: killedPid, candidatePid: ownedBrowser.pid, signal: "SIGKILL", persistentProfile: true};
  page = await context.newPage();
  observe(page);
  await page.goto(server.url.origin);
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  report.afterProcessDeath = {value: await input().inputValue(), storage: await page.evaluate(draftRecords)};
  check("browser_process_death_restores_last_saved_draft", await input().inputValue() === draft);
  check("recovery_never_dispatches_prompt", await page.evaluate(() => !(window as any).remoteQa.commands.some((command: any) => ["prompt", "sendNow"].includes(command.operation?.kind))));
  await page.evaluate(draftRecords, true);
  await page.reload();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("seven_day_expired_draft_removed_on_access", await input().inputValue() === "" && (await page.evaluate(draftRecords)).drafts.length === 0);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === "drafts") throw new DOMException("Fixture quota", "QuotaExceededError");
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await input().fill("This edit must remain in memory when saving is refused.");
  await page.getByText("This draft could not be saved. Keep a copy before closing this page.", {exact: true}).waitFor();
  check("storage_quota_failure_preserves_edit_without_dispatch", await input().inputValue() === "This edit must remain in memory when saving is refused." && await page.evaluate(() => !(window as any).remoteQa.commands.some((command: any) => ["prompt", "sendNow"].includes(command.operation?.kind))));
  check("no_uncaught_browser_errors", report.errors.length === 0);
} catch (error) {failure = error;report.failure = error instanceof Error ? error.message : String(error);}
finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children) await stop(child, "SIGTERM");
  server.stop(true);
  report.ownedProcessesStopped = children.every(child => child.exitCode !== null || child.signalCode !== null);
  report.result = failure ? "failed" : "passed";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
console.log(JSON.stringify({result: report.result, checks: report.checks.length, errors: report.errors.length}));
if (failure) throw failure;
