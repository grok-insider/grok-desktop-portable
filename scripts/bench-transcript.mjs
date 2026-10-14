import {createServer} from "node:http";
import {createReadStream, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {resolve, join, extname, sep} from "node:path";
import {loadavg, totalmem, freemem, cpus} from "node:os";

const root = process.argv[2] && resolve(process.argv[2]);
const output = process.argv[3] && resolve(process.argv[3]);
if (!root || !output || existsSync(output) || !process.env.PLAYWRIGHT_MODULE) throw new Error("need build root, new evidence directory and PLAYWRIGHT_MODULE");
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
mkdirSync(output, {recursive: true});
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
for (const build of manifest.builds) for (const file of build.files) {
  if (createHash("sha256").update(readFileSync(join(root, build.variant, file.name))).digest("hex") !== file.sha256) throw new Error("build integrity mismatch");
}
const server = createServer((request, response) => {
  if (request.url === "/favicon.ico") {response.writeHead(204).end(); return;}
  let path;
  try {path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);} catch {response.writeHead(400).end(); return;}
  if (!path.startsWith(root + sep) || !existsSync(path)) {response.writeHead(404).end(); return;}
  const mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2"}[extname(path)] ?? "application/octet-stream";
  response.writeHead(200, {"content-type": mime, "cache-control": "no-store"});
  const stream = createReadStream(path); stream.on("error", () => response.destroy()); stream.pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const attached = Boolean(process.env.BROWSER_CDP);
if (attached && !["127.0.0.1", "localhost"].includes(new URL(process.env.BROWSER_CDP).hostname)) throw new Error("only a local laboratory browser is supported");
const browser = attached ? await chromium.connectOverCDP(process.env.BROWSER_CDP) : await chromium.launch({headless: true, args: ["--enable-precise-memory-info"]});
const viewport = {width: Number(process.env.TRANSCRIPT_WIDTH ?? 2560), height: Number(process.env.TRANSCRIPT_HEIGHT ?? 1440)};
const protocol = {blocks: 8, warmups: 50, samples: 200, sizes: [100, 1000, 10000], actions: ["input", "stream"], seed: 18391, primaryMetric: "layoutMs", secondaryMetric: "nextFrameMs", realDevice: false, renderer: attached ? "external laboratory Chromium; graphics qualification recorded separately" : "headless Chromium, software graphics", contexts: "isolated, one active page per variant", heapProtocol: "full GC after warmup and after samples, outside timed steps"};
let randomState = protocol.seed;
const random = () => {randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296;};
const order = ["AB", "AB", "AB", "AB", "BA", "BA", "BA", "BA"];
for (let i = order.length - 1; i > 0; i--) {const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]];}
writeFileSync(join(output, "protocol.json"), JSON.stringify({...protocol, order, browser: browser.version(), cpus: cpus().length, totalmem: totalmem(), createdAt: new Date().toISOString(), viewport, runnerSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), manifestSha256: createHash("sha256").update(readFileSync(join(root, "manifest.json"))).digest("hex")}, null, 2));
const records = [];
const temperatures = () => {
  const measurements = [];
  try {for (const directory of readdirSync("/sys/class/hwmon")) {
    const path = join("/sys/class/hwmon", directory);
    let name;
    try {name = readFileSync(join(path, "name"), "utf8").trim();} catch {continue;}
    for (const file of readdirSync(path).filter((name) => /^temp\d+_input$/.test(name))) {
      try {measurements.push({device: name, sensor: file, celsius: Number(readFileSync(join(path, file), "utf8")) / 1000});} catch {}
    }
  }} catch {}
  return measurements;
};
let failure;
try {
  for (const size of protocol.sizes) for (const action of protocol.actions) for (let block = 0; block < protocol.blocks; block++) {
    for (const label of order[block]) {
      const variant = label === "A" ? "reference" : "candidate";
      const context = await browser.newContext({viewport, colorScheme: "light", reducedMotion: "reduce"});
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {if (message.type() === "error") errors.push(message.text());});
      const address = `http://127.0.0.1:${port}/${variant}/experiments/transcript.html?size=${size}`;
      const startedAt = new Date().toISOString();
      const loadBefore = loadavg();
      const freeBefore = freemem();
      const temperaturesBefore = temperatures();
      try {
        await page.goto(address, {waitUntil: "networkidle", timeout: 120_000});
        await page.waitForFunction(() => Boolean(window.transcriptBenchmark), undefined, {timeout: 120_000});
        const inspection = await page.evaluate(() => window.transcriptBenchmark.inspect());
        if (inspection.variant !== variant || inspection.messages !== size / 2 || inspection.visibility !== "visible") throw new Error("fixture identity or visibility mismatch");
        for (let iteration = 0; iteration < protocol.warmups; iteration++) await page.evaluate(({action, iteration}) => window.transcriptBenchmark.step(action, iteration), {action, iteration});
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        await cdp.send("HeapProfiler.collectGarbage");
        const heapBefore = await cdp.send("Runtime.getHeapUsage");
        const before = await cdp.send("Performance.getMetrics");
        const samples = [];
        for (let iteration = 0; iteration < protocol.samples; iteration++) {
          samples.push(await page.evaluate(({action, iteration}) => window.transcriptBenchmark.step(action, iteration + 1000), {action, iteration}));
        }
        const after = await cdp.send("Performance.getMetrics");
        await cdp.send("HeapProfiler.collectGarbage");
        const heapAfter = await cdp.send("Runtime.getHeapUsage");
        const final = await page.evaluate(() => window.transcriptBenchmark.inspect());
        if (final.messages !== size / 2 || errors.length) throw new Error("fixture validation failed: " + errors.join(","));
        const record = {size, action, block, order: order[block], variant, startedAt, endedAt: new Date().toISOString(), loadBefore, loadAfter: loadavg(), freeBefore, freeAfter: freemem(), temperaturesBefore, temperaturesAfter: temperatures(), metricsBefore: before.metrics, metricsAfter: after.metrics, heapBefore, heapAfter, samples, inspection: {messages: final.messages, carets: final.carets, first: final.first, last: final.last, viewport: final.viewport, visibility: final.visibility}, errors};
        records.push(record);
        appendFileSync(join(output, "blocks.jsonl"), JSON.stringify(record) + "\n");
        process.stdout.write(JSON.stringify({size, action, block, variant, completed: records.length, total: 96}) + "\n");
      } finally {await context.close();}
    }
  }
} catch (error) {failure = String(error);}
finally {await browser.close(); await new Promise((resolve) => server.close(resolve));}
writeFileSync(join(output, "completion.json"), JSON.stringify({completed: records.length, expected: 96, browserConnectionClosed: true, externalBrowserOwned: !attached, serverClosed: true, failure: failure ?? null, endedAt: new Date().toISOString()}, null, 2));
if (failure) throw new Error(failure);
