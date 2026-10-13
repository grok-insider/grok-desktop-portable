import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";

const output = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: bun scripts/qualify-voice-browser.ts <new-evidence-directory>");
const web = resolve(import.meta.dir, "../apps/web");
await mkdir(output, {mode: 0o700});
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const inputs = [import.meta.path, join(web, "qa/voice.tsx"), join(web, "src/components/Dictation.tsx"), join(web, "src/components/SpeechPlayback.tsx"), join(web, "src/components/ui.tsx")];
const sources = await Promise.all(inputs.map(async path => ({path, sha256: hash(await readFile(path))})));
const report: any = {schema: 1, scope: "real-browser-product-components-with-simulated-platform-voice-events", sources, checks: [], errors: [], notQualified: ["Real microphone permission and speech recognition", "Actual synthesized audio and comprehension", "Ten paired physical-device tasks", "Full Remote transport and product styling"]};
const built = await Bun.build({entrypoints: [join(web, "qa/voice.tsx")], target: "browser", minify: true, define: {"process.env.NODE_ENV": JSON.stringify("production")}});
assert.ok(built.success, String(built.logs));
assert.equal(built.outputs.length, 1);
const javascript = new Uint8Array(await built.outputs[0].arrayBuffer());
report.javascriptSha256 = hash(javascript);
await writeFile(join(output, "voice.js"), javascript, {mode: 0o600});
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice fixture</title><div id="root"></div><script type="module" src="/voice.js"></script></html>';
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html, {headers: {"content-type": "text/html"}});
  if (path === "/voice.js") return new Response(javascript, {headers: {"content-type": "text/javascript"}});
  return new Response(null, {status: 404});
}});
let browser: any;
let context: any;
let failure: unknown;
const check = (name: string, value: unknown) => {assert.ok(value, name);report.checks.push(name);};
try {
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  browser = await chromium.connectOverCDP(process.env.REMOTE_QA_CDP ?? "http://127.0.0.1:40565");
  context = await browser.newContext({viewport: {width: 2560, height: 1440}});
  await context.addInitScript(() => {
    const qa: any = {recognitions: [], utterances: [], spoken: [], calls: {start: 0, stop: 0, abort: 0, pause: 0, resume: 0, cancel: 0}};
    class Recognition {
      lang = ""; continuous = false; interimResults = false;
      onresult: any; onerror: any; onend: any;
      constructor() {qa.recognitions.push(this);}
      start() {qa.calls.start++;}
      stop() {qa.calls.stop++;}
      abort() {qa.calls.abort++;}
    }
    class Utterance {onend: any; onerror: any; constructor(readonly text: string) {qa.utterances.push(this);}}
    Object.defineProperty(window, "SpeechRecognition", {configurable: true, value: Recognition});
    Object.defineProperty(window, "SpeechSynthesisUtterance", {configurable: true, value: Utterance});
    Object.defineProperty(window, "speechSynthesis", {configurable: true, value: {
      speak(utterance: Utterance) {qa.spoken.push(utterance.text);},
      pause() {qa.calls.pause++;}, resume() {qa.calls.resume++;}, cancel() {qa.calls.cancel++;},
    }});
    (window as any).voiceQa = qa;
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  await page.goto(server.url.origin);
  await page.getByRole("heading", {name: "Remote voice control fixture"}).waitFor();
  const calls = () => page.evaluate(() => ({...(window as any).voiceQa.calls}));
  const draft = page.getByRole("textbox", {name: "Message draft"});
  const start = async () => {
    if (await page.getByRole("button", {name: "Dictate", exact: true}).count()) await page.getByRole("button", {name: "Dictate", exact: true}).click();
    await page.getByRole("button", {name: "Start microphone"}).click();
    await page.getByText("Listening…", {exact: true}).waitFor();
  };
  check("no_microphone_or_audio_on_mount", Object.values(await calls()).every(value => value === 0));
  for (const error of ["not-allowed", "no-speech", "network", "audio-capture"]) {
    await start();
    await page.evaluate((value: string) => (window as any).voiceQa.recognitions.at(-1).onerror({error: value}), error);
    await page.getByRole("alert").waitFor();
    check(`platform_${error}_reported_without_insertion`, await draft.inputValue() === "" && await page.getByLabel("Insertions").textContent() === "0");
    await page.getByRole("button", {name: "Cancel dictation"}).click();
  }
  await start();
  await page.evaluate(() => (window as any).voiceQa.recognitions.at(-1).onresult({results: [{isFinal: true, 0: {transcript: "git status Type Script"}}]}));
  await page.getByLabel("Review dictation").waitFor();
  check("recognition_requires_review_and_never_submits", await draft.inputValue() === "" && await page.getByRole("button", {name: "Insert into draft"}).isDisabled() && await page.getByLabel("Submissions").textContent() === "0");
  await page.getByRole("button", {name: "Stop recording"}).click();
  await page.evaluate(() => (window as any).voiceQa.recognitions.at(-1).onend());
  await page.getByLabel("Review dictation").fill("git diff --stat; TypeScript");
  await page.getByLabel("Refuse insertion").check();
  await page.getByRole("button", {name: "Insert into draft"}).click();
  check("refused_draft_keeps_review", await page.getByLabel("Review dictation").inputValue() === "git diff --stat; TypeScript" && await draft.inputValue() === "");
  await page.getByLabel("Refuse insertion").uncheck();
  await page.getByRole("button", {name: "Insert into draft"}).click();
  check("edited_dictation_enters_draft_only_after_gesture", await draft.inputValue() === "git diff --stat; TypeScript" && await page.getByLabel("Insertions").textContent() === "1" && await page.getByLabel("Submissions").textContent() === "0");
  for (const action of ["cancel", "session", "access"]) {
    await start();
    const before = (await calls()).abort;
    if (action === "cancel") await page.getByRole("button", {name: "Cancel dictation"}).click();
    if (action === "session") await page.getByRole("button", {name: "Change session"}).click();
    if (action === "access") await page.getByLabel("Access unavailable").check();
    await page.evaluate(() => (window as any).voiceQa.recognitions.at(-1).onresult({results: [{isFinal: true, 0: {transcript: "late ignored result"}}]}));
    check(`dictation_${action}_aborts_and_ignores_late_result`, (await calls()).abort > before && await page.getByLabel("Review dictation").count() === 0 && !(await draft.inputValue()).includes("late ignored result"));
    if (action === "access") await page.getByLabel("Access unavailable").uncheck();
  }
  await page.getByRole("button", {name: "Read last answer"}).click();
  await page.getByRole("button", {name: "Pause playback"}).click();
  await page.getByRole("button", {name: "Resume playback"}).click();
  check("playback_pause_and_resume_reach_platform", (await calls()).pause === 1 && (await calls()).resume === 1);
  await page.getByRole("button", {name: "Stop playback"}).click();
  const stopped = await page.evaluate(() => (window as any).voiceQa.spoken.length);
  await page.evaluate(() => (window as any).voiceQa.utterances.at(-1).onend());
  check("playback_stop_ignores_late_completion", await page.evaluate(() => (window as any).voiceQa.spoken.length) === stopped);
  for (const action of ["session", "access"]) {
    await page.getByRole("button", {name: "Read last answer"}).click();
    const count = await page.evaluate(() => (window as any).voiceQa.spoken.length);
    const canceled = (await calls()).cancel;
    if (action === "session") await page.getByRole("button", {name: "Change session"}).click();
    else await page.getByLabel("Access unavailable").check();
    await page.evaluate(() => (window as any).voiceQa.utterances.at(-1).onend());
    check(`playback_${action}_cancels_without_queuing_more`, (await calls()).cancel > canceled && await page.evaluate(() => (window as any).voiceQa.spoken.length) === count);
    if (action === "access") await page.getByLabel("Access unavailable").uncheck();
  }
  await page.evaluate(() => {(window as any).voiceQa.spoken = [];});
  await page.getByRole("button", {name: "Read last answer"}).click();
  let iterations = 0;
  while (await page.getByRole("button", {name: "Stop playback"}).count()) {
    assert.ok(++iterations <= 100, "bounded playback completion");
    await page.evaluate(() => (window as any).voiceQa.utterances.at(-1).onend());
  }
  const spoken = await page.evaluate(() => (window as any).voiceQa.spoken as string[]);
  const answer = await page.locator("#answer").textContent();
  check("long_answer_chunks_complete_in_order", spoken.length > 10 && spoken.every((part: string) => part.length <= 500) && spoken.join(" ").replace(/\s/g, "") === answer.replace(/\s/g, ""));
  check("no_automatic_submissions", await page.getByLabel("Submissions").textContent() === "0");
  check("no_browser_errors", report.errors.length === 0);
} catch (error) {failure = error;report.failure = error instanceof Error ? error.message : String(error);}
finally {
  await context?.close();
  await browser?.close();
  server.stop(true);
  report.result = failure ? "failed" : "passed";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
console.log(JSON.stringify({result: report.result, checks: report.checks.length, errors: report.errors.length}));
if (failure) throw failure;
