import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const [fixtureArgument, outputArgument, fixtureRole = "secondary"] = process.argv.slice(2);
assert.ok(fixtureArgument && outputArgument);
assert.ok(["primary", "additional", "secondary"].includes(fixtureRole));
const fixture = resolve(fixtureArgument), output = resolve(outputArgument);
await mkdir(output, {mode: 0o700});
const launch = JSON.parse(await readFile(join(fixture, "launch.json"), "utf8"));
const manifest = await readFile(join(fixture, "pwa/qualification-manifest.json"));
const requiredExperiments = ["drafts", "dictation", "speech-playback", "share-target", "remote-projects", "control-transfer", "device-panel", "push"];
const experiments = JSON.parse(manifest.toString()).experiments;
assert.ok(requiredExperiments.every(experiment => experiments.includes(experiment)), "The complete mobile controls must be enabled in the measured artifact");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
await writeFile(join(output, "source-manifest.json"), manifest, {mode: 0o600});
const report: any = {schema: 1, scope: "real-managed-PWA-responsive-layout", sourceManifestSha256: hash(manifest), scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), experiments, views: [], errors: [], notQualified: ["Physical Android keyboard", "Real screen reader", "NVIDIA composition", "Safari or iOS"]};
let browser: any, context: any, page: any, failure: unknown;
const stage = (value: string) => {report.stage = value;};
try {
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  browser = await chromium.connectOverCDP(process.env.REMOTE_QA_CDP ?? "http://127.0.0.1:40565");
  context = await browser.newContext({viewport: {width: 2560, height: 1440}, hasTouch: true});
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  stage("initial pairing");
  await page.goto(launch.alternatives[fixtureRole]);
  await page.getByRole("button", {name: "Pair and connect", exact: true}).click();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
  stage("service worker activation");
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.state === "activated", undefined, {timeout: 30_000});
  await page.evaluate(async () => {await navigator.serviceWorker.ready;});
  stage("service worker reload");
  await page.reload();
  stage("reconnect stored pairing");
  await page.locator(".remote-home").getByText(`Synthetic ${fixtureRole} QA - no Grok process`, {exact: true}).locator("..").getByRole("button", {name: "Connect", exact: true}).click();
  await page.getByText("Connected to host. Ready.", {exact: true}).waitFor();
  stage("service worker controller");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  report.serviceWorker = {active: true, controlsPage: true, permission: await page.evaluate(() => Notification.permission)};
  stage("notification readiness");
  await page.getByRole("button", {name: "Computer settings", exact: true}).click();
  await page.getByRole("button", {name: "Refresh notification status", exact: true}).click();
  await page.getByRole("button", {name: "Enable notifications for this computer", exact: true}).click({trial: true});
  await page.getByRole("button", {name: "Close computer settings", exact: true}).click();
  await page.getByRole("textbox", {name: "Message the agent", exact: true}).fill("SYNTHETIC_LAYOUT_DRAFT");
  const pointerTargets = ["Computer settings", "Share conversation", "Drafts off", "Dictate", "Read last answer", "Send prompt"];
  const checkPointerTarget = async (name: string) => {
    stage(`pointer: ${name}`);
    const target = page.getByRole("button", {name, exact: true});
    await target.click({trial: true});
    const result = await target.evaluate((button: HTMLButtonElement) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {width: box.width, height: box.height, top: box.top, bottom: box.bottom, withinViewport: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1, receivesPointer: hit === button || button.contains(hit)};
    });
    assert.ok(result.withinViewport && result.receivesPointer, `${name} must receive pointer input after normal scrolling`);
    assert.ok(result.width >= 43.9 && result.height >= 43.9, `${name} must retain a 44px touch target`);
    return {name, ...result};
  };
  const verifyDialogKeyboard = async (title: string) => {
    stage(`keyboard: ${title}`);
    const dialog = page.getByRole("dialog", {name: title, exact: true});
    await dialog.waitFor();
    const focused = () => dialog.evaluate((element: HTMLElement) => ({inside: element.contains(document.activeElement), documentFocused: document.hasFocus(), activeTag: document.activeElement?.tagName ?? null}));
    const initial = await focused();
    assert.ok(initial.inside, `${title} receives initial focus`);
    await page.keyboard.press("Shift+Tab");
    const backward = await focused();
    assert.ok(backward.inside || !backward.documentFocused && backward.activeTag === "BODY", `${title} does not move backward tab focus to background content`);
    await page.keyboard.press("Tab");
    const forward = await focused();
    assert.ok(forward.inside, `${title} receives forward tab focus, including return from browser chrome`);
    return {title, initial, backward, forward};
  };
  const verifyRestoredFocus = async (name: string) => {
    assert.ok(await page.getByRole("button", {name, exact: true}).evaluate((button: HTMLButtonElement) => button === document.activeElement), `${name} regains focus after closing the dialog`);
  };
  let browsersExpanded = false;
  for (const viewport of [{width: 2560, height: 1440}, {width: 390, height: 844}, {width: 384, height: 750}, {width: 384, height: 694}, {width: 844, height: 390}, {width: 384, height: 430}]) {
    stage(`resting layout: ${viewport.width}x${viewport.height}`);
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const visual = window.visualViewport;
      const expected = visual?.scale === 1 ? Math.min(innerHeight, visual.height) : innerHeight;
      return Math.abs(parseFloat(document.documentElement.style.getPropertyValue("--app-viewport-height")) - expected) < 0.1;
    });
    await page.locator(".work-header + div").evaluate((element: HTMLElement) => {element.scrollTop = 0;});
    assert.equal(await page.getByRole("dialog").count(), 0, "the resting conversation has no open configuration dialogs");
    assert.equal(await page.getByRole("button", {name: "Browse approved folders", exact: true}).count(), 0, "computer configuration stays out of the conversation");
    const resting = await page.locator('[aria-label="Prompt composer"]').evaluate((element: HTMLElement) => {const box = element.getBoundingClientRect();return {top: box.top, bottom: box.bottom, visible: box.top >= 0 && box.bottom <= innerHeight + 1};});
    if (viewport.height >= 694) assert.ok(resting.visible, "the resting composer is visible without scrolling");
    await page.screenshot({path: join(output, `${viewport.width}x${viewport.height}-conversation.png`)});
    const pointers = [];
    const keyboard = [];
    for (const name of pointerTargets) pointers.push(await checkPointerTarget(name));
    await page.getByRole("button", {name: "Computer settings", exact: true}).click();
    keyboard.push(await verifyDialogKeyboard("Computer settings"));
    for (const name of ["Browse approved folders", "Browsers and control", "Enable notifications for this computer", "Refresh notification status", "Close computer settings"]) pointers.push(await checkPointerTarget(name));
    if (!browsersExpanded) {
      await page.getByRole("button", {name: "Browsers and control", exact: true}).click();
      browsersExpanded = true;
    }
    await page.getByText("This connection controls the computer.", {exact: true}).waitFor();
    pointers.push(await checkPointerTarget("Refresh browsers"));
    await page.screenshot({path: join(output, `${viewport.width}x${viewport.height}-computer-settings.png`)});
    await page.keyboard.press("Escape");
    await verifyRestoredFocus("Computer settings");
    await page.getByRole("button", {name: "Drafts off", exact: true}).click();
    keyboard.push(await verifyDialogKeyboard("Draft storage"));
    pointers.push(await checkPointerTarget("Remember drafts on this device"));
    await page.getByRole("button", {name: "Remember drafts on this device", exact: true}).click();
    await page.locator('[data-draft-status="saved"]').waitFor();
    await verifyRestoredFocus("Saved draft");
    await page.getByRole("button", {name: "Saved draft", exact: true}).click();
    pointers.push(await checkPointerTarget("Delete saved drafts"));
    await page.getByRole("button", {name: "Delete saved drafts", exact: true}).click();
    await page.getByRole("button", {name: "Drafts off", exact: true}).waitFor();
    await verifyRestoredFocus("Drafts off");
    await page.getByRole("button", {name: "Dictate", exact: true}).click();
    keyboard.push(await verifyDialogKeyboard("Dictation"));
    pointers.push(await checkPointerTarget("Cancel dictation"));
    await page.screenshot({path: join(output, `${viewport.width}x${viewport.height}-dictation.png`)});
    await page.getByRole("button", {name: "Cancel dictation", exact: true}).click();
    await verifyRestoredFocus("Dictate");
    await checkPointerTarget("Send prompt");
    await page.locator("#composer").scrollIntoViewIfNeeded();
    const value = await page.evaluate(() => {
      const composer = document.querySelector<HTMLTextAreaElement>("#composer")!;
      const rectangle = composer.getBoundingClientRect();
      const actions = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(button => /approved folders|Browsers and control|Refresh browsers|Remove this browser|notifications|Dictate|Read last answer/i.test(button.textContent ?? "")).filter(button => button.getClientRects().length).map(button => {const box = button.getBoundingClientRect();return {name: button.textContent?.trim(), width: box.width, height: box.height};});
      return {viewport: {width: innerWidth, height: innerHeight}, documentWidth: document.documentElement.scrollWidth, composer: {x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, enabled: !composer.disabled, valueIntact: composer.value === "SYNTHETIC_LAYOUT_DRAFT"}, actions};
    });
    report.views.push({...value, resting, pointers, keyboard, interactions: ["computer settings opened, background content excluded from keyboard focus, closed with Escape", "draft persistence enabled and disabled by pointer", "dictation opened and dismissed without starting microphone", "focus returned to each dialog trigger"]});
    assert.ok(value.documentWidth <= viewport.width + 1, "no horizontal page overflow");
    assert.ok(value.composer.enabled && value.composer.valueIntact, "composer and draft remain usable");
    assert.ok(value.composer.x >= -1 && value.composer.x + value.composer.width <= viewport.width + 1 && value.composer.y >= -1 && value.composer.y + value.composer.height <= viewport.height + 1, "composer reachable within viewport");
    await page.screenshot({path: join(output, `${viewport.width}x${viewport.height}.png`)});
  }
  await page.getByRole("button", {name: "Forget this browser", exact: true}).click();
  await page.getByRole("heading", {name: "Your computers", exact: true}).waitFor();
  assert.equal(report.errors.length, 0);
} catch (error) {
  failure = error;
  const redact = (value: string) => value.replace(/https?:\/\/[^\s"')]+/g, value => {try {const url = new URL(value);return `${url.origin}${url.pathname}`;} catch {return "[redacted URL]";}});
  report.failure = redact(error instanceof Error ? error.message : String(error));
  report.stack = error instanceof Error && error.stack ? redact(error.stack) : undefined;
  if (page) {
    report.diagnostics = await page.evaluate(async () => ({path: location.pathname, viewport: {width: innerWidth, height: innerHeight}, serviceWorker: {controller: navigator.serviceWorker.controller?.state ?? null, registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => ({scope: new URL(registration.scope).pathname, active: registration.active?.state ?? null, waiting: registration.waiting?.state ?? null, installing: registration.installing?.state ?? null}))}, buttons: [...document.querySelectorAll("button")].filter(button => button.getClientRects().length).map(button => ({name: button.getAttribute("aria-label") ?? button.textContent?.trim(), disabled: button.disabled}))})).catch(() => ({unavailable: true}));
    await page.screenshot({path: join(output, "failure.png")}).catch(() => {});
  }
}
finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  report.result = failure ? "failed" : "passed";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
console.log(JSON.stringify({result: report.result, views: report.views.length, errors: report.errors.length}));
if (failure) process.exitCode = 1;
