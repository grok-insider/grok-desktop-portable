import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const [fixtureArgument, outputArgument] = process.argv.slice(2);
assert.ok(fixtureArgument && outputArgument);
const fixture = resolve(fixtureArgument), output = resolve(outputArgument);
await mkdir(output, {mode: 0o700});
const launch = JSON.parse(await readFile(join(fixture, "launch.json"), "utf8"));
const manifest = await readFile(join(fixture, "pwa/qualification-manifest.json"));
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
await writeFile(join(output, "source-manifest.json"), manifest, {mode: 0o600});
const report: any = {schema: 1, scope: "managed-pwa-real-websocket-interruption-and-resume", scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceManifestSha256: hash(manifest), checks: [], errors: [], notQualified: ["Radio or Tailscale interruption", "Native host crash", "Android suspension", "OS process eviction", "Model command replay counter"]};
const check = (name: string, value: unknown) => {assert.ok(value, name);report.checks.push(name);};
let browser: any, context: any, failure: unknown;
try {
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  browser = await chromium.connectOverCDP(process.env.REMOTE_QA_CDP ?? "http://127.0.0.1:40565");
  context = await browser.newContext({viewport: {width: 2560, height: 1440}});
  const sockets: any[] = [];
  let paused = false;
  await context.routeWebSocket("**/qa-relay", (route: any) => {
    if (paused) {void route.close({code: 4001, reason: "Synthetic network interruption"});return;}
    const upstream = route.connectToServer();sockets.push({route, upstream});
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  await page.goto(launch.alternatives.additional);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).click();
  const input = page.getByRole("textbox", {name: "Message the agent", exact: true});
  await input.waitFor();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
  await page.getByRole("button", {name: "Browsers and control", exact: true}).click();
  await page.getByText("This connection controls the computer.", {exact: true}).waitFor();
  await input.fill("UNSENT_DRAFT_DURING_REAL_SOCKET_INTERRUPTION");
  const originalUrl = page.url(), originalTime = await page.evaluate(() => performance.timeOrigin);
  await page.getByText(/^Connected · [0-9]+ connections? · Last activity unavailable$/).first().waitFor();
  check("device_status_received_over_real_noise", sockets.length > 0);
  paused = true;
  for (const socket of sockets) {await socket.upstream.close({code: 4001, reason: "Synthetic network interruption"});await socket.route.close({code: 4001, reason: "Synthetic network interruption"});}
  await page.getByText("Reconnecting to your computer…", {exact: true}).waitFor();
  check("stale_device_panel_is_removed_with_explicit_reconnect_status", await page.getByRole("region", {name: "Remote computer tools", exact: true}).count() === 0 && !await input.isEnabled());
  check("interruption_preserves_in_memory_unsent_draft", await input.inputValue() === "UNSENT_DRAFT_DURING_REAL_SOCKET_INTERRUPTION");
  paused = false;
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor({timeout: 30_000});
  report.reconnected = {inputEnabled: await input.isEnabled(), beforeUrl: originalUrl, afterUrl: page.url(), beforeTimeOrigin: originalTime, afterTimeOrigin: await page.evaluate(() => performance.timeOrigin)};
  await page.waitForFunction(() => {const element = document.querySelector<HTMLTextAreaElement>("textarea#composer");return Boolean(element && !element.disabled);}, null, {timeout: 15_000});
  check("socket_reconnect_restores_control_without_navigation", await input.isEnabled() && page.url() === originalUrl && await page.evaluate(() => performance.timeOrigin) === originalTime);
  check("socket_reconnect_preserves_draft", await input.inputValue() === "UNSENT_DRAFT_DURING_REAL_SOCKET_INTERRUPTION");
  await page.getByRole("button", {name: "Browsers and control", exact: true}).click();
  await page.getByRole("button", {name: "Refresh browsers", exact: true}).click();
  await page.getByText("This connection controls the computer.", {exact: true}).waitFor();
  check("device_panel_refreshes_after_reconnect", await page.getByRole("button", {name: "Remove this browser", exact: true}).isEnabled());
  check("reconnect_leaves_one_live_connection", await page.getByText("This browser · A tab has control", {exact: true}).locator("..").getByText("Connected · 1 connection · Last activity unavailable", {exact: true}).isVisible());
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
