import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";

const [fixtureArgument, outputArgument] = process.argv.slice(2);
assert.ok(fixtureArgument && outputArgument, "Usage: bun scripts/qualify-managed-browser.ts <managed-fixture> <new-evidence-directory>");
const fixture = resolve(fixtureArgument), output = resolve(outputArgument);
await mkdir(output, {mode: 0o700});
const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
const launch = JSON.parse(await readFile(join(fixture, "launch.json"), "utf8"));
const manifest = await readFile(join(fixture, "pwa/qualification-manifest.json"));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const report: any = {schema: 1, scope: "real-managed-product-pwa-account-noise-relay-native-with-synthetic-session", scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceManifestSha256: hash(manifest), startedAt: new Date().toISOString(), checks: [], errors: [], notQualified: ["Production OAuth", "Production TLS ingress", "Tailscale", "Grok inference", "Android", "Real Web Push delivery", "Human utility"]};
await writeFile(join(output, "source-manifest.json"), manifest, {mode: 0o600});
let browser: any;
const contexts: any[] = [];
let failure: unknown;
const check = (name: string, value: unknown) => {assert.ok(value, name);report.checks.push(name);};
const label = (role: string) => `Synthetic ${role} QA - no Grok process`;
const input = (page: any) => page.getByRole("textbox", {name: "Message the agent", exact: true});
async function paired(page: any, role: string) {
  await page.goto(launch.alternatives[role]);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).click();
  await input(page).waitFor();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
}
async function existing(page: any, role: string) {
  const card = page.locator(".remote-home").getByText(label(role), {exact: true}).locator("..");
  await card.getByRole("button", {name: "Connect", exact: true}).click();
  await input(page).waitFor();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
}
async function stored() {
  return new Promise<any>((resolveRows, reject) => {
    const open = indexedDB.open("grok-remote-drafts.v2", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(["scopes", "drafts"], "readonly");
      const drafts = transaction.objectStore("drafts").getAll();
      const scopes = transaction.objectStore("scopes").getAll();
      transaction.oncomplete = () => {database.close();resolveRows({drafts: drafts.result, scopes: scopes.result});};
      transaction.onerror = () => {database.close();reject(transaction.error);};
    };
  });
}
async function save(page: any, text: string) {
  const enable = page.getByRole("button", {name: "Remember drafts on this device", exact: true});
  if (await enable.isVisible()) await enable.click();
  await input(page).fill(text);
  await page.locator('[data-draft-status="saved"]').waitFor();
}
async function toolsPanel(page: any) {
  const toggle = page.getByRole("button", {name: "Browsers and control", exact: true});
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByRole("button", {name: "Refresh browsers", exact: true}).click();
  await page.getByText(/This connection (controls|observes) the computer\./).waitFor();
}
try {
  const playwright = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  const engine = process.env.REMOTE_QA_ENGINE;
  assert.ok(!engine || ["chromium", "firefox", "webkit"].includes(engine));
  browser = engine ? await playwright[engine!].launch({headless: true}) : await playwright.chromium.connectOverCDP(process.env.REMOTE_QA_CDP ?? "http://127.0.0.1:40565");
  report.browser = {engine: engine ?? "hidden-chrome-cdp", version: browser.version(), viewport: {width: 2560, height: 1440}};
  const first = await browser.newContext({viewport: {width: 2560, height: 1440}});
  contexts.push(first);
  const page = await first.newPage();
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  let wasmLoaded = false;
  page.on("response", (response: any) => {if (new URL(response.url()).pathname.endsWith("fabrials_remote_noise_bg.wasm") && response.ok()) wasmLoaded = true;});
  await paired(page, "primary");
  await page.getByText("Conversación sintética para comprobar borradores, dictado, lectura en voz alta y vista previa. No se ha ejecutado Grok.", {exact: true}).waitFor();
  report.wasmLoaded = wasmLoaded;
  check("real_noise_wasm_pairing_and_native_session", wasmLoaded);
  check("optional_drafts_require_explicit_consent", await page.getByRole("button", {name: "Remember drafts on this device", exact: true}).isVisible() && (await page.evaluate(stored)).drafts.length === 0);
  await save(page, "PRIMARY_ONLY_CANARY_42");
  await page.reload();
  await existing(page, "primary");
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("paired_reload_resumes_and_recovers_draft", await input(page).inputValue() === "PRIMARY_ONLY_CANARY_42");
  await paired(page, "additional");
  check("host_switch_does_not_expose_other_draft", await input(page).inputValue() === "" && await page.getByRole("button", {name: "Remember drafts on this device", exact: true}).isVisible());
  await save(page, "ADDITIONAL_ONLY_CANARY_73");
  await page.getByRole("button", {name: "Computers", exact: true}).click();
  check("same_account_lists_only_its_two_hosts", await page.locator(".remote-home").getByText(label("primary"), {exact: true}).isVisible() && await page.locator(".remote-home").getByText(label("additional"), {exact: true}).isVisible() && await page.locator(".remote-home").getByText(label("secondary"), {exact: true}).count() === 0);
  await existing(page, "primary");
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("return_to_first_host_restores_only_its_draft", await input(page).inputValue() === "PRIMARY_ONLY_CANARY_42");
  await paired(page, "secondary");
  check("account_switch_does_not_expose_other_drafts", await input(page).inputValue() === "");
  await page.getByRole("button", {name: "Computers", exact: true}).click();
  check("other_account_lists_only_its_host", await page.locator(".remote-home").getByText(label("secondary"), {exact: true}).isVisible() && await page.locator(".remote-home").getByText(label("primary"), {exact: true}).count() === 0 && await page.locator(".remote-home").getByText(label("additional"), {exact: true}).count() === 0);
  await page.goto(launch.alternatives.primary);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).waitFor();
  await page.goto(ready.origin);
  await existing(page, "primary");
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("account_return_preserves_original_scoped_draft", await input(page).inputValue() === "PRIMARY_ONLY_CANARY_42");
  await page.getByRole("button", {name: "Browse approved folders", exact: true}).click();
  await page.getByRole("button", {name: /Browse synthetic-projects/}).waitFor();
  await page.getByRole("button", {name: /Browse synthetic-projects/}).click();
  await page.getByRole("button", {name: "Add Second synthetic project as a project", exact: true}).waitFor();
  check("approved_root_browser_uses_native_folder_list", await page.getByRole("button", {name: "Use this folder as a project", exact: true}).isEnabled());
  await toolsPanel(page);
  check("device_panel_reports_real_control", await page.getByText("This connection controls the computer.", {exact: true}).isVisible());
  const second = await browser.newContext({viewport: {width: 2560, height: 1440}});
  contexts.push(second);
  const observer = await second.newPage();
  observer.on("pageerror", (error: Error) => report.errors.push(error.message));
  await observer.goto(launch.alternatives.primary);
  await observer.getByRole("button", {name: "Pair and connect", exact: true}).click();
  await input(observer).waitFor();
  await toolsPanel(observer);
  check("second_browser_is_observer_with_disabled_composer", await observer.getByText("This connection observes the computer.", {exact: true}).isVisible() && !await input(observer).isEnabled());
  await observer.getByRole("button", {name: "Request control", exact: true}).click();
  await page.getByRole("button", {name: "Refresh browsers", exact: true}).click();
  await page.getByRole("button", {name: "Transfer control to this browser", exact: true}).click();
  await observer.getByText("This connection controls the computer.", {exact: true}).waitFor();
  await page.getByText("This connection observes the computer.", {exact: true}).waitFor();
  check("explicit_control_transfer_changes_composer_authority", await input(observer).isEnabled() && !await input(page).isEnabled());
  await page.getByRole("button", {name: "Request control", exact: true}).click();
  await observer.getByRole("button", {name: "Refresh browsers", exact: true}).click();
  await observer.getByRole("button", {name: "Transfer control to this browser", exact: true}).click();
  await page.getByText("This connection controls the computer.", {exact: true}).waitFor();
  check("transfer_back_preserves_unsent_text", await input(page).inputValue() === "PRIMARY_ONLY_CANARY_42" && await input(page).isEnabled());
  const observerId = await observer.getByText(/^This browser(?: · A tab has control)?$/).locator("..").locator("p").nth(1).innerText();
  await page.getByRole("button", {name: "Refresh browsers", exact: true}).click();
  await page.locator("li").filter({has: page.getByText(observerId, {exact: true})}).getByRole("button", {name: "Remove browser access", exact: true}).click();
  await page.getByRole("button", {name: "Confirm removal", exact: true}).click();
  await observer.waitForFunction(() => {const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message the agent"]');return !textarea || textarea.disabled;});
  await observer.getByRole("button", {name: "Computers", exact: true}).click();
  await observer.locator(".remote-home").getByText(label("primary"), {exact: true}).locator("..").getByRole("button", {name: "Connect", exact: true}).click();
  await observer.getByText(/Pair this browser from your computer|This browser's access was revoked/).waitFor();
  check("controller_revokes_other_browser_and_denies_resume", await input(observer).count() === 0);
  await observer.goto(launch.alternatives.primary);
  await observer.getByRole("button", {name: "Pair and connect", exact: true}).click();
  await input(observer).waitFor();
  await toolsPanel(observer);
  await observer.getByRole("button", {name: "Remove this browser", exact: true}).click();
  await observer.getByRole("button", {name: "Confirm removal", exact: true}).click();
  await observer.getByRole("heading", {name: "Your computers", exact: true}).waitFor();
  check("own_revocation_returns_to_computers", await input(observer).count() === 0);
  await observer.locator(".remote-home").getByText(label("primary"), {exact: true}).locator("..").getByRole("button", {name: "Connect", exact: true}).click();
  await observer.getByText("Pair this browser from your computer with spanreed remote pair. Open its QR link here.", {exact: true}).waitFor();
  check("revoked_browser_cannot_silently_reconnect", await input(observer).count() === 0);
  await page.getByRole("button", {name: "Forget this browser", exact: true}).click();
  await page.getByRole("heading", {name: "Your computers", exact: true}).waitFor();
  const after = await page.evaluate(stored);
  check("revocation_erases_only_selected_host_drafts", !after.drafts.some((row: any) => row.text === "PRIMARY_ONLY_CANARY_42") && after.drafts.some((row: any) => row.text === "ADDITIONAL_ONLY_CANARY_73"));
  check("no_uncaught_browser_errors", report.errors.length === 0);
} catch (error) {failure = error;report.failure = error instanceof Error ? error.message : String(error);}
finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  report.result = failure ? "failed" : "passed";
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
console.log(JSON.stringify({result: report.result, checks: report.checks.length, errors: report.errors.length}));
if (failure) process.exitCode = 1;
