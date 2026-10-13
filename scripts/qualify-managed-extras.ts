import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const [fixtureArgument, outputArgument] = process.argv.slice(2);
assert.ok(fixtureArgument && outputArgument);
const fixture = resolve(fixtureArgument), output = resolve(outputArgument);
await mkdir(output, {mode: 0o700});
const ready = JSON.parse(await readFile(join(fixture, "ready.json"), "utf8"));
const launch = JSON.parse(await readFile(join(fixture, "launch.json"), "utf8"));
const manifest = await readFile(join(fixture, "pwa/qualification-manifest.json"));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
await writeFile(join(output, "source-manifest.json"), manifest, {mode: 0o600});
const report: any = {schema: 1, scope: "managed-pwa-real-worker-share-inbox-and-native-public-preview", sourceManifestSha256: hash(manifest), scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), checks: [], errors: [], notQualified: ["Android share sheet", "PWA installation", "Publication start", "Actual push delivery", "Audible speech", "Human utility"]};
let browser: any, context: any, failure: unknown;
const check = (name: string, value: unknown) => {assert.ok(value, name);report.checks.push(name);};
const role = "additional";
const label = `Synthetic ${role} QA - no Grok process`;
let page: any;
const input = () => page.getByRole("textbox", {name: "Message the agent", exact: true});
async function connect() {
  await page.locator(".remote-home").getByText(label, {exact: true}).locator("..").getByRole("button", {name: "Connect", exact: true}).click();
  await input().waitFor();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
}
async function share() {
  const navigation = page.waitForNavigation({waitUntil: "domcontentloaded"});
  const response = page.waitForResponse((value: any) => new URL(value.url()).pathname === "/share-inbox" && value.request().method() === "POST" && value.status() === 303 && value.fromServiceWorker());
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.method = "POST";form.action = "/share-inbox";form.enctype = "multipart/form-data";
    for (const [name, value] of Object.entries({title: "SYNTHETIC_SHARED_TITLE", text: "SYNTHETIC_SHARED_TEXT", url: "https://example.invalid/synthetic"})) {
      const field = document.createElement("input");field.name = name;field.value = value;form.append(field);
    }
    const file = document.createElement("input");file.type = "file";file.name = "files";
    const data = new DataTransfer();data.items.add(new File(["SYNTHETIC_FILE_CONTENT"], "synthetic.txt", {type: "text/plain"}));
    file.files = data.files;form.append(file);document.body.append(form);form.submit();
  });
  await Promise.all([navigation, response]);
  await page.getByRole("heading", {name: "Shared with Grok", exact: true}).waitFor();
}
try {
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  browser = await chromium.connectOverCDP(process.env.REMOTE_QA_CDP ?? "http://127.0.0.1:40565");
  context = await browser.newContext({viewport: {width: 2560, height: 1440}});
  page = await context.newPage();
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  let grants = 0, shareResponses = 0;
  page.on("request", (request: any) => {if (request.method() === "POST" && new URL(request.url()).pathname === "/api/spanreed/remote/shares") grants++;});
  page.on("response", (response: any) => {if (new URL(response.url()).pathname === "/share-inbox" && response.status() === 303 && response.fromServiceWorker()) shareResponses++;});
  await page.goto(launch.alternatives[role]);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).click();
  await input().waitFor();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
  await page.getByRole("button", {name: "Share conversation", exact: true}).click();
  const dialog = page.getByRole("dialog", {name: "Publish this conversation", exact: true});
  await dialog.waitFor();
  check("native_public_preview_contains_actual_synthetic_history", (await dialog.locator("article").count()) === 2 && (await dialog.locator("article").allTextContents()).some((value: string) => value.includes("No es una respuesta de Grok")));
  check("public_consent_is_unchecked_and_publish_disabled", !await dialog.getByRole("checkbox").isChecked() && !await dialog.getByRole("button", {name: "Publish and sync", exact: true}).isEnabled() && grants === 0);
  await dialog.getByRole("checkbox").check();
  check("consent_enables_explicit_publish_without_creating_grant", await dialog.getByRole("button", {name: "Publish and sync", exact: true}).isEnabled() && grants === 0);
  await dialog.getByRole("button", {name: "Cancel", exact: true}).click();
  const shares = await page.evaluate(async () => (await fetch("/api/spanreed/remote/shares")).json());
  check("cancel_leaves_no_public_share", grants === 0 && shares.shares.length === 0);
  await page.evaluate(async () => {await navigator.serviceWorker.ready;});
  await page.reload();
  await connect();
  check("product_worker_controls_reloaded_page", await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
  await page.getByRole("button", {name: "Remember drafts on this device", exact: true}).click();
  await input().fill("ORIGINAL_DRAFT_CANARY");
  await page.locator('[data-draft-status="saved"]').waitFor();
  await share();
  check("actual_worker_accepts_multipart_text_url_and_file", shareResponses === 1 && (await page.getByRole("textbox", {name: "Shared text", exact: true}).inputValue()).includes("https://example.invalid/synthetic") && await page.getByText(/synthetic.txt ·/).isVisible());
  check("share_requires_explicit_host_and_conversation", !await page.getByRole("button", {name: "Add to selected conversation draft", exact: true}).isEnabled());
  await share();
  check("duplicate_pending_intent_is_one_item", await page.getByRole("textbox", {name: "Shared text", exact: true}).count() === 1);
  await context.clearCookies();
  await page.reload();
  await page.getByRole("link", {name: "Sign in to Fabrials", exact: true}).waitFor();
  check("signed_out_share_remains_reviewable_without_destination", await page.getByRole("textbox", {name: "Shared text", exact: true}).count() === 1 && !await page.getByRole("button", {name: "Add to selected conversation draft", exact: true}).isEnabled());
  await page.close();
  page = await context.newPage();
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  await page.goto(launch.alternatives[role]);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).waitFor();
  await page.goto(ready.origin);
  await connect();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("closed_page_reopen_preserves_inbox_and_original_draft", await input().inputValue() === "ORIGINAL_DRAFT_CANARY" && await page.getByRole("textbox", {name: "Shared text", exact: true}).count() === 1);
  await page.getByRole("textbox", {name: "Shared text", exact: true}).fill("REVIEWED_SHARED_TEXT_CANARY");
  await page.getByRole("button", {name: /^Add to .+ draft$/}).click();
  await page.getByRole("heading", {name: "Shared with Grok", exact: true}).waitFor({state: "hidden"});
  await page.locator('[data-draft-status="saved"]').waitFor();
  const draft = await input().inputValue();
  check("reviewed_text_and_file_append_once_to_existing_draft", draft.startsWith("ORIGINAL_DRAFT_CANARY") && draft.includes("REVIEWED_SHARED_TEXT_CANARY") && draft.includes("SYNTHETIC_FILE_CONTENT") && draft.split("REVIEWED_SHARED_TEXT_CANARY").length === 2 && !draft.includes("SYNTHETIC_SHARED_TEXT"));
  await page.reload();
  await connect();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("share_consumption_survives_reload_without_duplicate", await input().inputValue() === draft && await page.getByRole("textbox", {name: "Shared text", exact: true}).count() === 0);
  await share();
  await page.getByRole("button", {name: "Discard shared item", exact: true}).click();
  await page.getByRole("heading", {name: "Shared with Grok", exact: true}).waitFor({state: "hidden"});
  await connect();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("discard_does_not_change_destination_draft", await input().inputValue() === draft);
  await page.getByRole("button", {name: "Refresh notification status", exact: true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Enable notifications for this computer" && !button.disabled));
  check("actual_push_account_host_and_worker_ready_without_consent", await page.getByRole("button", {name: "Enable notifications for this computer", exact: true}).isEnabled());
  await page.screenshot({path: join(output, "combined-desktop.png"), fullPage: true});
  await page.getByRole("button", {name: "Forget this browser", exact: true}).click();
  await page.getByRole("heading", {name: "Your computers", exact: true}).waitFor();
  check("no_uncaught_browser_errors", report.errors.length === 0);
} catch (error) {failure = error;report.failure = error instanceof Error ? error.message : String(error);}
finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  report.result = failure ? "failed" : "passed";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
console.log(JSON.stringify({result: report.result, checks: report.checks.length, errors: report.errors.length}));
if (failure) process.exitCode = 1;
