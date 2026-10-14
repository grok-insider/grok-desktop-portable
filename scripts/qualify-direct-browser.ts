import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, readdir, rm} from "node:fs/promises";
import {closeSync, openSync} from "node:fs";
import {createInterface} from "node:readline";
import {resolve, join} from "node:path";
import {buildOrigin, deploymentOrigin, deploymentConfigPath, origins} from "./deployment-origin.mjs";
import {verifyArtifact} from "./remote-artifact.mjs";
import {qualifyDirectMultiHost} from "./qa/direct-multihost";
import {qualifyDirectSoak} from "./qa/direct-soak";
import {openDirectFirefox} from "./qa/direct-firefox";

const [directoryArgument] = process.argv.slice(2);
assert.ok(directoryArgument, "Usage: bun scripts/qualify-direct-browser.ts <private-directory-with-cert.pem-and-key.pem>");
const engine=process.env.REMOTE_QA_ENGINE ?? "chromium";
assert.ok(["chromium","firefox"].includes(engine),"Direct browser qualification supports Chromium or Firefox");
if(engine==="chromium") assert.ok(process.env.REMOTE_QA_CHROME?.startsWith("/nix/store/") && process.env.REMOTE_QA_CHROME.includes("google-chrome-"), "REMOTE_QA_CHROME must name the actual Nix Chrome package, never the daily-profile wrapper");
const directory = resolve(directoryArgument);
const artifact = process.env.REMOTE_QA_ARTIFACT ? resolve(process.env.REMOTE_QA_ARTIFACT) : undefined;
const dist = artifact ? join(artifact, ".vercel/output/static") : resolve("apps/web/dist");
const upgradeArtifact = process.env.REMOTE_QA_UPGRADE_ARTIFACT ? resolve(process.env.REMOTE_QA_UPGRADE_ARTIFACT) : undefined;
const upgradeReadOnly = process.env.REMOTE_QA_UPGRADE_READ_ONLY === "1";
let servedDist = dist;
const origin = deploymentOrigin(process.env.REMOTE_QA_ORIGIN ?? buildOrigin(await readFile(join(dist, "index.html"), "utf8")));
assert.equal(buildOrigin(await readFile(join(dist, "index.html"), "utf8")), origin, "Browser qualification must use the built shell's exact origin");
const hostname = new URL(origin).hostname;
const cropDist = process.env.REMOTE_QA_CROP_DIST ? resolve(process.env.REMOTE_QA_CROP_DIST) : undefined;
const soak = process.env.REMOTE_QA_SOAK === "1";
assert.ok(!soak || engine==="chromium","Firefox soak has not been qualified");
if(engine==="firefox") assert.ok(process.env.REMOTE_QA_FIREFOX?.startsWith("/"),"Firefox requires an explicit executable path");
const multiwriter = process.env.REMOTE_QA_MULTIWRITER === "1" || soak;
const multihost = process.env.REMOTE_QA_MULTIHOST === "1";
assert.ok(!multihost || !multiwriter, "Multi-host qualification uses separate hosts without the multiwriter fixture");
const layoutImages = process.env.REMOTE_QA_LAYOUT_IMAGES === "1";
assert.ok(engine!=="firefox" || (!cropDist && !upgradeArtifact && !layoutImages),"Firefox qualification currently covers base, multiwriter and multihost modes only");
const deployment = JSON.parse(await readFile(artifact ? join(artifact, ".vercel/output/config.json") : resolve(deploymentConfigPath(origin)), "utf8"));
const report: any = {schema: 1, startedAt: new Date().toISOString(), origin, checks: [], errors: [], transport: [], notQualified: ["Production TLS trust: laboratory self-signed certificate", "Actual hosting and CDN routing", "Tailscale", "Physical Android and Apple hardware", "Grok inference: synthetic history only", "Real push delivery", "GPU performance: hidden software compositor"]};
const processes: {name: string; child: ChildProcess}[] = [];
const spawnFailures: string[] = [];
const cleanEnv = {...process.env};
for (const name of Object.keys(cleanEnv)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(name)) delete cleanEnv[name];
let browser: any, page: any, server: any, syl: ChildProcess | undefined;
let firefoxRuntime: Awaited<ReturnType<typeof openDirectFirefox>> | undefined;
const check = (name: string, value: unknown) => {assert.ok(value, name); report.checks.push(name);};
const waitFor = async (ready: () => Promise<boolean>, timeout = 15000) => {const end = Date.now() + timeout; while (!await ready()) {assert.ok(Date.now() < end, "fixture readiness deadline"); await Bun.sleep(50);}};
const start = (name: string, command: string, args: string[], env: Record<string,string | undefined> = cleanEnv) => {
  const fd = openSync(join(directory, `${name}.log`), "wx", 0o600);
  const child = spawn(command, args, {env, detached: true, stdio: ["ignore", fd, fd]});
  closeSync(fd); child.on("error", () => spawnFailures.push(name)); processes.push({name, child}); return child;
};
let rpcId = 0;
const pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>();
const rpc = (method: string, params: object) => new Promise<any>((resolveReply, reject) => {
  const id = ++rpcId;
  const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Syl ${method} timed out`));}, 15000);
  pending.set(id, {resolve: value => {clearTimeout(timer); resolveReply(value);}, reject: error => {clearTimeout(timer); reject(error);}});
  syl!.stdin!.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
});
let nativePort = 0, denyAppNetwork = false, denyHostNetwork = false;
const nativeHosts = new Map<string, number>();
const blockedHosts = new Set<string>();
const hostUpstreams = new Map<string, Set<WebSocket>>();
let sourceMetadataPath = "", syntheticSourceMetadata: any;
let sourceNoticesPath = "", sourceNotices = "";
let sourceUnavailable = true;
const expectedResourceErrors = new Set<string>();
const upstreams = new Set<WebSocket>();
const heldDownstreams = new Set<number>();
const bufferedDownstreams = new Map<number, (() => void)[]>();
let nextConnection = 0;
const releaseDownstream = (connection: number) => {heldDownstreams.delete(connection); for (const deliver of bufferedDownstreams.get(connection) ?? []) deliver(); bufferedDownstreams.delete(connection);};
try {
  if (artifact) {
    assert.ok(process.env.REMOTE_QA_SPANREED, "Artifact qualification requires REMOTE_QA_SPANREED for the real corresponding-source proof");
    const manifest = await verifyArtifact(artifact, {forDeploy: true, spanreed: resolve(process.env.REMOTE_QA_SPANREED!), origin});
    report.deploymentManifestSha256 = createHash("sha256").update(await readFile(join(artifact, "deployment.json"))).digest("hex");
    report.sources = manifest.sources;
    check("deployment_candidate_and_real_corresponding_source_verified", manifest.deployCandidate);
  }
  if (upgradeArtifact) {
    assert.ok(artifact && multiwriter && process.env.REMOTE_QA_UPGRADE_SPANREED, "Upgrade qualification requires two real artifacts, their source checkouts and multiwriter mode");
    const manifest = await verifyArtifact(upgradeArtifact, {forDeploy: true, spanreed: resolve(process.env.REMOTE_QA_UPGRADE_SPANREED!), origin});
    report.upgrade = {deploymentManifestSha256: createHash("sha256").update(await readFile(join(upgradeArtifact, "deployment.json"))).digest("hex"), sources: manifest.sources, intermediateReadOnly: upgradeReadOnly};
    check("upgrade_candidate_and_real_corresponding_source_verified", manifest.deployCandidate);
  }
  report.runnerSha256 = createHash("sha256").update(await readFile(import.meta.filename)).digest("hex");
  report.artifactSha256 = createHash("sha256").update(await readFile(join(dist, "index.html"))).update(await readFile(join(dist, "sw.js"))).digest("hex");
  const nativeBinary = process.env.DIRECT_QA_NATIVE_BINARY ?? "/tmp/fabrials-remote-integration/target/debug/examples/direct_browser_fixture";
  report.nativeFixtureSha256 = createHash("sha256").update(await readFile(nativeBinary)).digest("hex");
  if (soak) {
    assert.ok(process.env.DIRECT_QA_FIXTURE_MANIFEST,"Soak requires a recorded fixture source and binary seal");
    const bytes=await readFile(process.env.DIRECT_QA_FIXTURE_MANIFEST!);
    const seal=JSON.parse(bytes.toString());
    assert.equal(seal.binarySha256,report.nativeFixtureSha256);
    assert.equal(seal.fakeAgentSha256,createHash("sha256").update(await readFile(join(resolve(nativeBinary,".."),"fake_multiwriter_agent"))).digest("hex"));
    report.fixtureSeal={...seal,sealSha256:createHash("sha256").update(bytes).digest("hex")};
  }
  const state = join(directory, "native");
  await mkdir(state, {mode: 0o700});
  start("native", nativeBinary, [], {...cleanEnv, DIRECT_BROWSER_QA_DIRECTORY: state, DIRECT_BROWSER_QA_WEB_ORIGIN: origin, DIRECT_BROWSER_QA_ACP: multiwriter ? "1" : "0", DIRECT_BROWSER_QA_DURATION_SECS: soak ? "90000" : undefined, DIRECT_BROWSER_QA_IMAGES: layoutImages ? "1" : "0", GROK_HOME: join(state, "synthetic-grok")});
  await waitFor(async () => {try {await readFile(join(state, "ready.json")); return true;} catch {return false;}});
  const native = JSON.parse(await readFile(join(state, "ready.json"), "utf8"));
  nativePort = native.port;
  nativeHosts.set(new URL(native.pairing.endpoint).hostname, nativePort);
  let secondNative: any;
  const secondMarker = "Synthetic second host history. This text belongs only to computer B.";
  if (multihost) {
    const secondState = join(directory, "native-b");
    await mkdir(secondState, {mode:0o700});
    start("native-b", nativeBinary, [], {...cleanEnv, DIRECT_BROWSER_QA_DIRECTORY: secondState, DIRECT_BROWSER_QA_WEB_ORIGIN: origin, DIRECT_BROWSER_QA_ENDPOINT: "https://direct-fixture-b.test", DIRECT_BROWSER_QA_LABEL: "Synthetic computer B", DIRECT_BROWSER_QA_MARKER: secondMarker, DIRECT_BROWSER_QA_ACP: "0", GROK_HOME: join(secondState, "synthetic-grok")});
    await waitFor(async () => {try {await readFile(join(secondState, "ready.json")); return true;} catch {return false;}});
    secondNative = JSON.parse(await readFile(join(secondState, "ready.json"), "utf8"));
    check("two_real_native_hosts_have_distinct_endpoint_installation_and_identity", secondNative.pairing.endpoint !== native.pairing.endpoint && secondNative.pairing.installationId !== native.pairing.installationId && secondNative.pairing.hostPublicKey !== native.pairing.hostPublicKey && secondNative.port !== native.port);
    nativeHosts.set(new URL(secondNative.pairing.endpoint).hostname, secondNative.port);
    report.multihost = {nativeFixtureSha256: report.nativeFixtureSha256, runnerSha256:createHash("sha256").update(await readFile(new URL("./qa/direct-multihost.ts", import.meta.url))).digest("hex"), runtime: "Two instances of the same fixture binary with isolated state and synthetic GROK_HOME; no Grok process or deployed CLI", hosts: 2, fixtureHistorySessionIds: "Deliberately identical to exercise host scoping", trustedTls: false};
  }
  server = Bun.serve<{upstream?: WebSocket; queued: string[]; origin: string; host: string; port: number}>({hostname: "127.0.0.1", port: 0, tls: {key: Bun.file(join(directory, "key.pem")), cert: Bun.file(join(directory, "cert.pem"))}, async fetch(request, serving) {
    const url = new URL(request.url);
    if (url.pathname === "/remote") report.transport.push({at:"proxy",host:url.hostname,origin:request.headers.get("origin")});
    if (nativeHosts.has(url.hostname) && url.pathname === "/remote") {
      if (denyHostNetwork || blockedHosts.has(url.hostname)) return new Response(null, {status: 503});
      if (serving.upgrade(request, {data: {queued: [], origin: request.headers.get("origin") ?? "", host:url.hostname, port:nativeHosts.get(url.hostname)!}, headers: {"sec-websocket-protocol": "fabrials.remote.v1"}})) return;
      return new Response(null, {status: 400});
    }
    if (url.hostname === "remote.fabrials.com" && origin === origins.production) return Response.redirect(origins.production + url.pathname + url.search, 308);
    const cropPath = cropDist && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.startsWith("/crop-qa/");
    if (url.hostname !== hostname && !cropPath) return new Response(null, {status: 404});
    if (denyAppNetwork && !cropPath) return new Promise(() => {});
    if (url.pathname === sourceMetadataPath) {
      if (sourceUnavailable) {
        expectedResourceErrors.add(url.href);
        return new Response(null, {status:404});
      }
      if (syntheticSourceMetadata) return Response.json(syntheticSourceMetadata, {headers:{"cache-control":"no-store"}});
    }
    if (!artifact && url.pathname === sourceNoticesPath) return new Response(sourceNotices, {headers:{"content-type":"text/plain;charset=utf-8","cache-control":"no-store"}});
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response(null, {status: 404});
    const file = Bun.file(cropPath ? join(cropDist!, path.slice("/crop-qa/".length)) : join(servedDist, path));
    if (!await file.exists()) return new Response(null, {status: 404});
    const headers = new Headers({"cache-control":"no-store", ...(path.endsWith(".js") ? {"content-type":"text/javascript"} : {})});
    for (const route of deployment.routes) if (route.src && !route.has && !route.missing && route.headers && new RegExp(`^${route.src}$`).test(url.pathname)) {
      for (const [name, value] of Object.entries(route.headers)) headers.set(name, String(value));
    }
    return new Response(file, {headers});
  }, websocket: {
    open(socket) {
      const connection = ++nextConnection;
      const upstream = new WebSocket(`ws://127.0.0.1:${socket.data.port}/remote`, {headers: {Host: socket.data.host, Origin: socket.data.origin, "Sec-WebSocket-Protocol": "fabrials.remote.v1"}});
      socket.data.upstream = upstream; upstreams.add(upstream);
      const scoped = hostUpstreams.get(socket.data.host) ?? new Set<WebSocket>();
      scoped.add(upstream); hostUpstreams.set(socket.data.host, scoped);
      upstream.onopen = () => {for (const value of socket.data.queued) upstream.send(value); socket.data.queued = [];};
      upstream.onmessage = event => {report.transport.push({at:"native-frame",connection,type:typeof event.data,bytes:event.data.length,kind:typeof event.data === "string" ? JSON.parse(event.data).type : "binary"}); if (heldDownstreams.has(connection)) {const buffered = bufferedDownstreams.get(connection) ?? []; assert.ok(buffered.length < 512, "bounded synthetic downstream delay"); buffered.push(() => socket.send(event.data)); bufferedDownstreams.set(connection, buffered);} else socket.send(event.data);};
      upstream.onclose = () => {upstreams.delete(upstream); scoped.delete(upstream); socket.close();};
      upstream.onerror = event => {report.transport.push({at:"native-error",message:event.message}); socket.close();};
    },
    message(socket, message) {report.transport.push({at:"browser-frame",bytes:message.length}); const value = typeof message === "string" ? message : message.toString(); if (socket.data.upstream?.readyState === 1) socket.data.upstream.send(value); else if (socket.data.queued.length < 16) socket.data.queued.push(value); else socket.close();},
    close(socket) {socket.data.upstream?.close();},
  }});
  const playwright=await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  let context: any;
  if(engine==="firefox") {
    firefoxRuntime=await openDirectFirefox({firefox:playwright.firefox,executablePath:process.env.REMOTE_QA_FIREFOX!,port:server.port,hosts:[...new Set([new URL(origins.production).hostname,new URL(origins.qualification).hostname,...nativeHosts.keys(),"remote.fabrials.com"])],environment:cleanEnv,owned(child){processes.push({name:"firefox",child});},report});
    ({browser,context}=firefoxRuntime);
    check("firefox_proxy_refuses_non_fixture_authorities",report.firefox.proxy.outsideAuthorityDenied);
    report.notQualified.push("Firefox touchscreen/mobile-keyboard emulation and native installation prompt; Chromium CDP-only checks are omitted");
    report.omittedChecks={reason:"Firefox does not implement Chromium CDP touch emulation",touchMediaQueries:7,touchShortViewports:[{width:750,height:136},{width:667,height:136}],shortViewportAssertions:16};
  } else {
    const sylLog = openSync(join(directory, "syl.log"), "wx", 0o600);
    syl = spawn("syl", ["mcp"], {env: {...cleanEnv, SYL_MCP_PROFILE: "visual", SYL_NESTED_RES: "2560x1440", ...(soak ? {DBUS_SESSION_BUS_ADDRESS:"unix:path=/dev/null"} : {})}, detached: true, stdio: ["pipe", "pipe", sylLog]});
    closeSync(sylLog);
    syl.on("error", () => spawnFailures.push("syl"));
    createInterface({input: syl.stdout!}).on("line", line => {const value = JSON.parse(line); const entry = pending.get(value.id); if (entry) {pending.delete(value.id); if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result);}});
    await rpc("initialize", {protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"direct-browser-qualification",version:"1"}});
    const nested = await rpc("tools/call", {name:"gui_open",arguments:{target:"nested",app:"foot"}});
    const display = nested.content?.map((item: any) => item.text ?? "").join(" ").match(/display=(wayland-\d+)/)?.[1];
    assert.ok(display, "real hidden Syl compositor, never its stub backend");
    const profile = join(directory, "chrome-profile");
    await mkdir(profile, {mode: 0o700});
    start("chrome", process.env.REMOTE_QA_CHROME!, [`--user-data-dir=${profile}`,"--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--ozone-platform=wayland","--password-store=basic","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync","--no-proxy-server","--ignore-certificate-errors",`--host-resolver-rules=MAP ${new URL(origins.production).hostname} 127.0.0.1:${server.port}, MAP ${new URL(origins.qualification).hostname} 127.0.0.1:${server.port}, ${[...nativeHosts.keys()].map(host => `MAP ${host} 127.0.0.1:${server.port}`).join(", ")}, MAP remote.fabrials.com 127.0.0.1:${server.port}`,"--start-fullscreen","--window-size=2560,1440","about:blank"], {...cleanEnv, WAYLAND_DISPLAY: display, ...(soak ? {DBUS_SESSION_BUS_ADDRESS:"unix:path=/dev/null"} : {})});
    let cdpPort = 0;
    await waitFor(async () => {try {cdpPort = Number((await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]); return Boolean(cdpPort);} catch {return false;}});
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    context = browser.contexts()[0];
  }
  report.browser=browser.version();
  report.engine=engine;
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const cloudRequests: string[] = [];
  const networkRoute = (route: any) => {
    const url = new URL(route.request().url());
    const app = url.origin === origin;
    const host = url.protocol === "https:" && nativeHosts.has(url.hostname) && !url.port;
    const alias = origin === origins.production && url.origin === "https://remote.fabrials.com" && route.request().isNavigationRequest();
    const crop = cropDist && url.origin === `https://127.0.0.1:${server.port}` && url.pathname.startsWith("/crop-qa/");
    if (app || host || alias || crop || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    cloudRequests.push(url.hostname);
    return route.abort();
  };
  await context.route("**/*", networkRoute);
  page.on("websocket", (socket: any) => {socket.on("socketerror", (message: string) => report.transport.push({at:"browser-error",message}));});
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  page.on("console", (message: any) => {
    if (message.type() !== "error") return;
    if ([...blockedHosts].some(host => message.text().includes(host) && (/WebSocket|503/.test(message.text()) || (engine === "firefox" && message.text().includes(`Firefox can’t establish a connection to the server at wss://${host}/remote.`))))) {
      (report.expectedConnectionErrors ??= []).push({reason:"deliberately blocked private host", message:message.text().slice(0,500)});
    } else if (expectedResourceErrors.has(message.location().url) && message.text().includes("404")) {
      (report.expectedResourceErrors ??= []).push({url:message.location().url, status:404});
    } else report.errors.push(message.text().slice(0, 500));
  });
  const input = () => page.getByRole("textbox", {name:"Message the agent",exact:true});
  const launch = `${origin === origins.production ? "https://remote.fabrials.com" : origin}/#directPair=${Buffer.from(JSON.stringify(native.pairing)).toString("base64url")}`;
  const initialResponse = await page.goto(launch);
  check("deployment_response_csp_enforced", Boolean(initialResponse?.headers()["content-security-policy"]?.includes("frame-ancestors 'none'")));
  await page.getByRole("button", {name:"Pair and connect",exact:true}).waitFor();
  check(origin === origins.production ? "alias_redirect_preserves_pairing_fragment_and_uses_canonical_origin" : "qualification_pairing_uses_its_exact_origin", new URL(page.url()).origin === origin);
  const shellId = await page.locator('meta[name="grok-shell-build"]').getAttribute("content");
  check("source_identity_binds_the_loaded_shell", /^[a-f0-9]{64}$/.test(shellId ?? ""));
  sourceMetadataPath = `/sources/${shellId}.json`;
  const sourceButton = () => page.getByRole("button", {name:"Source and license",exact:true});
  const sourceDialog = () => page.getByRole("dialog", {name:"Source and license",exact:true});
  await sourceButton().focus(); await sourceButton().press("Enter");
  await sourceDialog().getByText("Source information is unavailable for this app version. Connect to the website and try again.", {exact:true}).waitFor();
  check("unavailable_source_reports_failure_without_false_links", await sourceDialog().getByRole("link").count() === 0);
  await page.screenshot({path:join(directory,"source-unavailable.png")});
  await page.keyboard.press("Escape");
  check("source_dialog_returns_keyboard_focus", await sourceButton().evaluate((element: HTMLElement) => element === document.activeElement));
  let sourceMetadata: any;
  if (artifact) {
    sourceMetadata = JSON.parse(await readFile(join(dist, sourceMetadataPath), "utf8"));
    sourceNoticesPath = sourceMetadata.notices.path;
    sourceNotices = await readFile(join(dist, sourceNoticesPath), "utf8");
    report.sourceDistribution = {metadata:"Real verified corresponding-source archive", native:sourceMetadata.native, archiveSha256:sourceMetadata.archive.sha256, noticesSha256:sourceMetadata.notices.sha256};
  } else {
    sourceNotices = await readFile(join(dist,"third-party-notices.txt"),"utf8");
    const noticesHash = createHash("sha256").update(sourceNotices).digest("hex");
    sourceNoticesPath = `/sources/${noticesHash}.notices.txt`;
    const syntheticHash = "a".repeat(64), syntheticCommit = "b".repeat(40);
    syntheticSourceMetadata = {schema:1,shellId,shellSha256:syntheticHash,archive:{path:`/sources/${syntheticHash}.tar.gz`,sha256:syntheticHash,bytes:1024},license:{path:`/sources/${syntheticHash}.license.txt`,sha256:syntheticHash,spdx:"AGPL-3.0-or-later"},notices:{path:sourceNoticesPath,sha256:noticesHash},native:{version:"0.0.0",commit:syntheticCommit},sources:{portable:{commit:syntheticCommit,sha256:syntheticHash,dirty:false},libs:{commit:syntheticCommit,sha256:syntheticHash,dirty:false}}};
    report.sourceUiFixture = {metadata:"Synthetic success metadata; real missing response and real emitted third-party notices",sourceArchiveDownloadQualified:false,noticesSha256:noticesHash};
  }
  sourceUnavailable = false;
  await sourceButton().click();
  await sourceDialog().getByRole("link",{name:"Third-party notices",exact:true}).waitFor();
  check(artifact ? "source_dialog_loads_real_version_bound_metadata" : "source_dialog_accepts_version_bound_synthetic_metadata", await sourceDialog().getByRole("link").count() === 3);
  if (artifact) {
    for (const name of ["archive", "license", "notices"]) {
      const item = sourceMetadata[name];
      check(`source_dialog_exposes_verified_${name}_link`, await sourceDialog().locator(`a[href="${item.path}"]`).count() === 1);
      const downloaded = await page.evaluate(async (path: string) => {
        const response = await fetch(path, {credentials:"omit", redirect:"error"});
        const bytes = await response.arrayBuffer();
        const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
        return {status:response.status, bytes:bytes.byteLength, sha256};
      }, item.path);
      check(`browser_downloads_exact_real_${name}`, downloaded.status === 200 && downloaded.sha256 === item.sha256 && (name !== "archive" || downloaded.bytes === item.bytes));
    }
    report.sourceDistribution.sourceArchiveDownloadQualified = true;
  }
  const servedNotices = await page.evaluate(async (path: string) => (await fetch(path)).text(), sourceNoticesPath);
  check("source_dialog_notices_preserve_font_icon_and_generated_style_attributions", servedNotices === sourceNotices && servedNotices.includes("IBM Corp.") && servedNotices.includes("Lucide Icons") && servedNotices.includes("Tailwind Labs") && servedNotices.includes("vite@"));
  await page.setViewportSize({width:390,height:844});
  check("source_dialog_fits_mobile_viewport", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:join(directory,"source-available-mobile.png")});
  await page.keyboard.press("Escape");
  await page.setViewportSize({width:2560,height:1440});
  await page.getByRole("button", {name:"Pair and connect",exact:true}).click();
  await input().waitFor();
  await page.getByText("Synthetic direct connection QA. No Grok process is running.", {exact:true}).waitFor();
  check("real_direct_noise_pairing_restores_synthetic_native_history", true);
  const handshakes = report.transport.filter((entry: any) => entry.at === "proxy");
  check("private_handshake_preserves_the_real_browser_origin", handshakes.length > 0 && handshakes.every((entry: any) => entry.origin === origin));
  check("pairing_fragment_erased", new URL(page.url()).hash === "");
  await page.getByRole("button",{name:"Computer settings",exact:true}).click();
  await sourceButton().click();
  await sourceDialog().getByRole("link",{name:"Third-party notices",exact:true}).waitFor();
  await page.keyboard.press("Escape");
  check("closing_source_preserves_computer_settings_and_connection", await page.getByRole("dialog",{name:"Computer settings",exact:true}).isVisible() && await sourceButton().evaluate((element: HTMLElement) => element === document.activeElement));
  await page.getByRole("button",{name:"Close computer settings",exact:true}).click();
  check("source_information_does_not_disconnect_the_private_session", await input().isVisible());
  if (multiwriter) {
    report.multiwriter = {fixture: "Actual Noise host with deterministic synthetic ACP; no inference", sessions: 1, browserContexts: 2, schedulerBound: "Covered by Rust saturation tests; browser checks convergence and exactly-once transcript"};
    report.notQualified.push("Cancellation GUI execution: the synthetic ACP intentionally does not advertise qualified targeted cancellation");
    const firstConnection = nextConnection;
    await writeFile(join(state, "pair-next"), "", {mode:0o600});
    await waitFor(async () => {try {await readFile(join(state,"pair-next.json")); return true;} catch {return false;}});
    const secondPairing = JSON.parse(await readFile(join(state, "pair-next.json"), "utf8"));
    const secondary = await browser.newContext({viewport:{width:390,height:844}, ...(engine==="chromium" ? {hasTouch:true,isMobile:true} : {ignoreHTTPSErrors:true})});
    await secondary.route("**/*", networkRoute);
    const other = await secondary.newPage();
    other.setDefaultTimeout(15000);
    other.on("pageerror", (error: Error) => report.errors.push(`second client: ${error.message}`));
    other.on("console", (message: any) => {if (message.type() === "error") report.errors.push(`second client: ${message.text().slice(0,500)}`);});
    const sessionId = "synthetic-direct-session";
    const ledger = async () => JSON.parse(await readFile(join(state,"session-execution.json"),"utf8"));
    const execution = async () => (await ledger()).sessions[sessionId];
    const errorReceipts = async (code: string) => {
      try {return Object.values(JSON.parse(await readFile(join(state,"command-receipts.json"),"utf8")).entries).filter((value: any) => value.receipt.error === code).length;} catch {return 0;}
    };
    const queueText = async (target: any) => target.getByRole("list",{name:"Waiting to be sent",exact:true}).locator("li").allTextContents();
    const both = [page,other];
    const waitQueue = async (expected: string[]) => {
      await waitFor(async () => JSON.stringify((await execution())?.queue.map((entry: any) => entry.text)) === JSON.stringify(expected));
      for (const target of both) await waitFor(async () => {const text=await queueText(target); return text.length === expected.length && text.every((value: string,index: number) => value.includes(expected[index]));});
    };
    const send = async (target: any, text: string) => {
      const composer=target.getByRole("textbox",{name:"Message the agent",exact:true});
      await composer.fill(text); await composer.press("Enter");
      await waitFor(async () => await composer.inputValue() === "");
    };
    const select = async (target: any,label: string,value: string) => {
      await target.getByRole("button",{name:label,exact:true}).click();
      await target.getByRole("option",{name:value,exact:true}).click();
    };
    const confirmed = async (target: any,label: string,value: string) => waitFor(async () => (await target.getByRole("button",{name:label,exact:true}).textContent())?.includes(value) === true);
    const ephemeralConflict = async (message: string,name: string) => {
      await page.locator("[data-sonner-toast]").getByText(message,{exact:true}).waitFor();
      check(`${name}_is_explained_as_a_transient_notice`,await page.getByRole("alert").filter({hasText:message}).count() === 0);
      await page.getByText(message,{exact:true}).waitFor({state:"hidden",timeout:10000});
      check(`${name}_dismisses_without_a_persistent_error`,await page.getByText("The host refused the request.",{exact:true}).count() === 0);
    };
    try {
      await other.goto(`${origin}/#directPair=${Buffer.from(JSON.stringify(secondPairing)).toString("base64url")}`);
      await other.getByRole("button",{name:"Pair and connect",exact:true}).click();
      await other.getByText("Synthetic direct connection QA. No Grok process is running.",{exact:true}).waitFor();
      check("two_independent_pairings_are_simultaneously_writable_without_takeover", await Promise.all(both.map(target => target.getByRole("button",{name:"Pause queue",exact:true}).isEnabled())).then(values => values.every(Boolean)));
      await confirmed(page,"Model","Synthetic custom model"); await confirmed(other,"Model","Synthetic custom model");
      await select(page,"Model","Synthetic alternate model");
      for (const target of both) await confirmed(target,"Model","Synthetic alternate model");
      await select(other,"Reasoning effort","Synthetic high");
      for (const target of both) await confirmed(target,"Reasoning effort","Synthetic high");
      check("custom_model_and_effort_roundtrip_converges_across_devices",true);
      const staleBefore=await errorReceipts("configuration_conflict");
      await page.getByRole("button",{name:"Model",exact:true}).click();
      heldDownstreams.add(firstConnection);
      await select(other,"Model","Synthetic custom model");
      await confirmed(other,"Model","Synthetic custom model");
      await page.getByRole("option",{name:"Synthetic custom model",exact:true}).click();
      await waitFor(async () => await errorReceipts("configuration_conflict") === staleBefore + 1);
      releaseDownstream(firstConnection);
      await confirmed(page,"Model","Synthetic custom model");
      check("stale_model_revision_is_refused_without_overwriting_newer_device_choice",true);
      await ephemeralConflict("The model settings changed on another device. Review the current settings before trying again. Nothing was changed by this action.","model_revision_conflict");
      await page.getByRole("button",{name:"Pause queue",exact:true}).click();
      for (const target of both) await target.getByRole("button",{name:"Resume queue",exact:true}).waitFor();
      await send(page,"MW_FIRST"); await waitQueue(["MW_FIRST"]);
      await send(other,"MW_SECOND"); await waitQueue(["MW_FIRST","MW_SECOND"]);
      check("paused_fifo_preserves_distinct_device_origins_without_starting_inference", (await execution()).activeTurn === null && new Set((await execution()).queue.map((entry: any) => entry.originDeviceId)).size === 2);
      check("paused_queue_fits_mobile_viewport",await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await other.screenshot({path:join(directory,"multiwriter-queue-mobile.png")});
      const clearBefore=await errorReceipts("queue_revision_conflict");
      await page.getByRole("button",{name:"Clear pending messages",exact:true}).click();
      await send(other,"MW_CONCURRENT"); await waitQueue(["MW_FIRST","MW_SECOND","MW_CONCURRENT"]);
      await page.getByRole("button",{name:"Confirm clear",exact:true}).click();
      await waitFor(async () => await errorReceipts("queue_revision_conflict") === clearBefore + 1);
      await waitQueue(["MW_FIRST","MW_SECOND","MW_CONCURRENT"]);
      check("stale_clear_revision_preserves_concurrently_enqueued_messages",true);
      await ephemeralConflict("The queue changed on another device. Review the current messages before trying again. Nothing was changed by this action.","queue_revision_conflict");
      await other.getByRole("button",{name:"Remove the waiting message: MW_CONCURRENT",exact:true}).click();
      await waitQueue(["MW_FIRST","MW_SECOND"]);
      await page.getByRole("button",{name:"Resume queue",exact:true}).click();
      await waitFor(async () => (await execution()).activeTurn?.entry.text === "MW_FIRST");
      await waitQueue(["MW_SECOND"]);
      for (const target of both) {
        await target.getByText("accepted:MW_FIRST",{exact:true}).waitFor();
        check(target === page ? "first_device_model_changes_disabled_during_turn" : "second_device_model_changes_disabled_during_turn", await target.getByRole("button",{name:"Model",exact:true}).isDisabled());
        check(target === page ? "first_device_unqualified_stop_disabled" : "second_device_unqualified_stop_disabled", await target.getByRole("button",{name:"Stop the current turn",exact:true}).isDisabled());
      }
      const beforeReload=(await execution()).activeTurn.turnId;
      const beforeReceipts=Object.keys((await ledger()).receipts).length;
      await other.reload();
      await other.getByRole("button",{name:"Connect",exact:true}).click();
      await other.getByText("accepted:MW_FIRST",{exact:true}).waitFor();
      await waitQueue(["MW_SECOND"]);
      check("second_device_reconnect_preserves_active_turn_queue_and_receipt_count", (await execution()).activeTurn.turnId === beforeReload && Object.keys((await ledger()).receipts).length === beforeReceipts);
      if (upgradeArtifact) {
        const composer = other.getByRole("textbox", {name:"Message the agent", exact:true});
        const shell = () => other.locator('meta[name="grok-shell-build"]').getAttribute("content");
        const baseline = await shell();
        assert.match(baseline!, /^[a-f0-9]{64}$/);
        await other.getByRole("button", {name:"Drafts off", exact:true}).click();
        await other.getByRole("button", {name:"Remember drafts on this device", exact:true}).click();
        await composer.fill("UNSENT_UPGRADE_DRAFT_SYNTHETIC_CANARY");
        await other.locator('[data-draft-status="saved"]').waitFor();
        check("upgrade_baseline_is_service_worker_controlled", await other.evaluate(() => Boolean(navigator.serviceWorker.controller)));
        servedDist = join(upgradeArtifact, ".vercel/output/static");
        await other.evaluate(async () => {await (await navigator.serviceWorker.getRegistration())!.update();});
        await other.getByRole("button", {name:"Update and reload", exact:true}).waitFor();
        check("upgrade_does_not_reload_or_clear_unsent_draft_without_consent", await shell() === baseline && await composer.inputValue() === "UNSENT_UPGRADE_DRAFT_SYNTHETIC_CANARY");
        await other.getByRole("button", {name:"Update and reload", exact:true}).click();
        await other.waitForFunction(previous => document.querySelector('meta[name="grok-shell-build"]')?.getAttribute("content") !== previous, baseline);
        const candidate = await shell();
        assert.match(candidate!, /^[a-f0-9]{64}$/);
        for (const phase of ["upgrade", "rollback"]) {
          if (phase === "rollback") {
            await other.getByRole("button", {name:"Restore previous app and reload", exact:true}).click();
            await other.waitForFunction(previous => document.querySelector('meta[name="grok-shell-build"]')?.getAttribute("content") === previous, baseline);
          }
          await other.getByRole("button", {name:"Connect", exact:true}).click();
          await other.getByText("accepted:MW_FIRST", {exact:true}).waitFor();
          await other.locator('[data-draft-status="saved"]').waitFor();
          if (phase === "upgrade" && upgradeReadOnly) {
            await waitFor(async () => JSON.stringify((await execution()).queue.map((entry: any) => entry.text)) === JSON.stringify(["MW_SECOND"]));
            check("older_shell_is_reported_read_only", await other.getByText("Another browser tab has control. You can follow the conversation here. Close that tab or wait for its connection to expire.", {exact:true}).isVisible());
            check("older_shell_disables_the_composer", await composer.isDisabled());
          } else await waitQueue(["MW_SECOND"]);
          check(`${phase}_preserves_pairing_and_unsent_draft`, await composer.inputValue() === "UNSENT_UPGRADE_DRAFT_SYNTHETIC_CANARY");
          check(`${phase}_preserves_active_turn_and_durable_receipts_without_replay`, (await execution()).activeTurn.turnId === beforeReload && Object.keys((await ledger()).receipts).length === beforeReceipts);
          check(`${phase}_leaves_peer_writable_on_its_original_shell`, await page.getByRole("button", {name:"Pause queue", exact:true}).isEnabled() && await page.locator('meta[name="grok-shell-build"]').getAttribute("content") === baseline);
        }
        report.upgrade = {...report.upgrade, baselineShellId: baseline, candidateShellId: candidate, restoredShellId: await shell()};
        await composer.fill("");
        await other.locator('[data-draft-status="saved"]').waitFor();
      }
      for (const target of both) check(target === page ? "original_device_transcript_not_reset_or_duplicated" : "reconnecting_device_transcript_not_duplicated", await target.getByRole("article",{name:"Your message",exact:true}).filter({hasText:"MW_FIRST"}).count() === 1 && await target.getByText("accepted:MW_FIRST",{exact:true}).count() === 1);
      await writeFile(join(state,"release-turn"),sessionId,{mode:0o600});
      await waitFor(async () => (await execution()).activeTurn?.entry.text === "MW_SECOND");
      await waitQueue([]);
      for (const target of both) await target.getByText("accepted:MW_SECOND",{exact:true}).waitFor();
      await writeFile(join(state,"release-turn"),sessionId,{mode:0o600});
      await waitFor(async () => (await execution()).activeTurn === null);
      for (const target of both) await waitFor(async () => await target.getByRole("button",{name:"Model",exact:true}).isEnabled());
      check("both_devices_allow_model_changes_after_fifo_drains",true);
      for (const target of both) await target.getByText("Working",{exact:true}).waitFor({state:"hidden"});
      check("both_devices_clear_working_status_after_fifo_drains",true);
      const receipts=Object.values((await ledger()).receipts) as any[];
      check("fifo_executes_each_accepted_turn_once_and_removal_never_executes",receipts.filter(row => row.state === "completed").length === 2 && receipts.filter(row => row.state === "removed").length === 1);
      for (const target of both) {
        const messages=await target.getByRole("article",{name:"Your message",exact:true}).allTextContents();
        const synthetic=messages.filter((text: string) => text.includes("MW_"));
        assert.equal(synthetic.length,2); assert.ok(synthetic[0].includes("MW_FIRST") && synthetic[1].includes("MW_SECOND"));
      }
      check("both_transcripts_agree_on_exactly_once_fifo_order",true);
      await page.screenshot({path:join(directory,"multiwriter-desktop.png")});
      await other.screenshot({path:join(directory,"multiwriter-mobile.png")});
      if (soak) await qualifyDirectSoak({page,other,directory,state,native,report,processes:[...processes,...(syl ? [{name:"syl",child:syl}] : [])],execution,ledger,waitFor,send,waitQueue,closeSockets(){for(const socket of upstreams) socket.close();}});
      await writeFile(join(state,"disable-models"),sessionId,{mode:0o600});
      for (const target of both) {
        await waitFor(async () => await target.getByRole("button",{name:"Reasoning effort",exact:true}).count() === 0);
        await target.getByRole("button",{name:"Model",exact:true}).click();
        const options=target.getByRole("listbox",{name:"Model",exact:true}).getByRole("option");
        check(target === page ? "first_empty_catalogue_has_no_selectable_model" : "second_empty_catalogue_has_no_selectable_model", await options.count() === 1 && await options.first().isDisabled());
        await target.keyboard.press("Escape");
      }
      report.multiwriter.queueReceipts={completed:2,removed:1};
      report.multiwriter.expectedConflicts={configuration:1,clearQueue:1};
    } catch(error) {
      report.multiwriter.browserFailure = await Promise.all(both.map(async (target,index) => ({device:index + 1,modelDisabled:await target.getByRole("button",{name:"Model",exact:true}).isDisabled().catch(() => null),workingBadges:await target.getByText("Working",{exact:true}).count().catch(()=>null)})));
      await other.screenshot({path:join(directory,"multiwriter-second-failure.png")}).catch(() => {});
      await writeFile(join(directory,"multiwriter-second-failure.txt"),await other.locator("body").innerText().catch(() => "unavailable"),{mode:0o600});
      throw error;
    } finally {releaseDownstream(firstConnection); await secondary.close();}
  }
  await page.getByRole("button", {name:"Drafts off",exact:true}).click();
  await page.getByRole("button", {name:"Remember drafts on this device",exact:true}).click();
  await page.getByRole("button", {name:"Offline history",exact:true}).click();
  await page.getByRole("button", {name:"Save history on this device",exact:true}).click();
  await page.getByRole("list", {name:"Saved conversations",exact:true}).getByRole("button").first().waitFor();
  await page.getByRole("button", {name:"Close offline history",exact:true}).click();
  await input().fill("DIRECT_DRAFT_SYNTHETIC_CANARY");
  await page.locator('[data-draft-status="saved"]').waitFor();
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active));
  const fullyVisible = (element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.left < 0 || bounds.bottom > (visualViewport?.height ?? innerHeight) + 1 || bounds.right > innerWidth + 1) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (bounds.top < clip.top - 1 || bounds.bottom > clip.bottom + 1)) return false;
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (bounds.left < clip.left - 1 || bounds.right > clip.right + 1)) return false;
    }
    return [[bounds.left + 4, bounds.top + 4], [bounds.right - 4, bounds.bottom - 4], [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
  };
  const touchSession = engine==="chromium" ? await context.newCDPSession(page) : undefined;
  await page.evaluate(() => {
    const offer = new Event("beforeinstallprompt");
    Object.assign(offer, {prompt: async () => {}, userChoice: Promise.resolve({outcome:"dismissed"})});
    window.dispatchEvent(offer);
  });
  report.layoutBannerFixture = "Synthetic installation offer using the real application banner; not Android installation evidence";
  await page.getByRole("button", {name:"Install app", exact:true}).waitFor();
  if (multiwriter) {
    await page.getByRole("button", {name:"Pause queue", exact:true}).click();
    await page.getByRole("button", {name:"Resume queue", exact:true}).waitFor();
    for (const text of ["LAYOUT_WAITING_ONE", "LAYOUT_WAITING_TWO"]) {
      await input().fill(text);
      await input().press("Enter");
      await page.getByRole("button", {name:`Remove the waiting message: ${text}`, exact:true}).waitFor();
    }
    await input().fill("DIRECT_DRAFT_SYNTHETIC_CANARY");
  }
  if (layoutImages) {
    assert(multiwriter, "Image layout qualification requires synthetic ACP");
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      const paint = canvas.getContext("2d")!;
      paint.fillStyle = "#4682b4"; paint.fillRect(0, 0, 64, 64);
      paint.fillStyle = "#fff"; paint.fillRect(16, 16, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    report.layoutImageSha256 = createHash("sha256").update(Buffer.from(png,"base64")).digest("hex");
    await page.locator('input[type="file"]').setInputFiles({name:"synthetic-layout.png",mimeType:"image/png",buffer:Buffer.from(png,"base64")});
    await page.getByRole("button", {name:"Remove synthetic-layout.png", exact:true}).waitFor();
  }
  for (const viewport of [{width:2560,height:1440},{width:390,height:844},{width:844,height:390},{width:750,height:354},{width:750,height:136},{width:667,height:136},{width:390,height:430}]) {
    if(engine==="firefox" && viewport.height<=300) continue;
    const touch = viewport.width < 900;
    await touchSession?.send("Emulation.setTouchEmulationEnabled", {enabled:touch});
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue("--app-viewport-height")) - (visualViewport?.height ?? innerHeight)) < 1);
    await input().focus();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    if(touchSession) check(`touch_input_${viewport.width}x${viewport.height}`, await page.evaluate(() => matchMedia("(pointer: coarse)").matches) === touch);
    check(`no_horizontal_overflow_${viewport.width}x${viewport.height}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`composer_reachable_${viewport.width}x${viewport.height}`, await input().isVisible());
    check(`editor_visible_without_clipping_${viewport.width}x${viewport.height}`, await input().evaluate(fullyVisible));
    check(`send_visible_without_clipping_${viewport.width}x${viewport.height}`, await page.getByRole("button", {name:"Send prompt", exact:true}).evaluate(fullyVisible));
    check(`document_not_scrolled_${viewport.width}x${viewport.height}`, await page.evaluate(() => scrollX === 0 && scrollY === 0));
    if (viewport.height <= 300) {
      check(`navigation_and_updates_deferred_while_typing_${viewport.width}`, !await page.getByRole("button", {name:"Computers", exact:true}).isVisible() && !await page.getByRole("button", {name:"Install app", exact:true}).isVisible());
      await input().evaluate((element: HTMLElement) => element.blur());
      check(`navigation_and_updates_return_on_blur_${viewport.width}`, await page.getByRole("button", {name:"Computers", exact:true}).isVisible() && await page.getByRole("button", {name:"Install app", exact:true}).isVisible());
      await input().focus();
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      check(`editor_revealed_after_refocus_${viewport.width}`, await input().evaluate(fullyVisible));
    }
    await page.screenshot({path:join(directory, `layout-${viewport.width}x${viewport.height}.png`)});
  }
  if (layoutImages) {
    check("selected_image_and_text_survive_layout_changes_without_sending", await page.getByRole("list", {name:"Selected images", exact:true}).locator("li").count() === 1 && await input().inputValue() === "DIRECT_DRAFT_SYNTHETIC_CANARY");
    await page.getByRole("button", {name:"Remove synthetic-layout.png", exact:true}).click();
  }
  await touchSession?.send("Emulation.setTouchEmulationEnabled", {enabled:false});
  await touchSession?.detach();
  await page.setViewportSize({width:2560,height:1440});
  if (multiwriter) {
    await page.getByRole("button", {name:"Clear pending messages", exact:true}).click();
    await page.getByRole("button", {name:"Confirm clear", exact:true}).click();
    await page.getByRole("list", {name:"Waiting to be sent", exact:true}).waitFor({state:"hidden"});
    await page.getByRole("button", {name:"Resume queue", exact:true}).click();
    check("layout_queue_remains_paused_until_explicit_cleanup", await page.getByText("accepted:LAYOUT_WAITING_ONE", {exact:true}).count() === 0 && await page.getByText("accepted:LAYOUT_WAITING_TWO", {exact:true}).count() === 0);
  }
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-short-viewport"));
  check(engine==="chromium" ? "computer_navigation_restored_after_keyboard_dismissal" : "computer_navigation_available_after_layout_checks", await page.getByRole("button", {name:"Computers", exact:true}).isVisible());
  await page.getByRole("button", {name:"Later", exact:true}).click();
  await page.reload();
  await page.getByRole("button", {name:"Connect",exact:true}).click();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("direct_pairing_and_draft_survive_reload", await input().inputValue() === "DIRECT_DRAFT_SYNTHETIC_CANARY");
  check("private_drafts_and_history_never_enter_static_shell_cache", await page.evaluate(async () => {
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
      const response = await (await caches.open(name)).match(request);
      const content = await response!.text();
      if (content.includes("DIRECT_DRAFT_SYNTHETIC_CANARY") || content.includes("Synthetic direct connection QA. No Grok process is running.")) return false;
    }
    return true;
  }));
  denyAppNetwork = true;
  const offlineStart = Date.now();
  await page.reload({waitUntil:"domcontentloaded",timeout:5000});
  await page.getByRole("heading", {name:"Your computers",exact:true}).waitFor();
  report.offlineShellMs = Date.now() - offlineStart;
  check("installed_shell_opens_with_app_origin_blackholed", report.offlineShellMs < 2000);
  denyHostNetwork = true;
  const nativeFramesBeforeHistory = report.transport.length;
  await page.getByRole("button", {name:"Offline history",exact:true}).click();
  await page.getByRole("list", {name:"Saved conversations",exact:true}).getByRole("button").first().click();
  await page.getByRole("dialog", {name:"Offline history",exact:true}).locator("article").getByText("Synthetic direct connection QA. No Grok process is running.", {exact:true}).waitFor();
  check("consented_history_readable_without_cloud_or_private_host", report.transport.length === nativeFramesBeforeHistory);
  await page.screenshot({path:join(directory,"offline-history.png")});
  await page.getByRole("button", {name:"Close offline history",exact:true}).click();
  denyHostNetwork = false;
  await page.getByRole("button", {name:"Connect",exact:true}).click();
  await input().waitFor();
  await page.locator('[data-draft-status="saved"]').waitFor();
  check("private_host_remains_usable_without_fabrials_or_app_origin", await input().inputValue() === "DIRECT_DRAFT_SYNTHETIC_CANARY" && cloudRequests.length === 0);
  await page.getByRole("button", {name:"Forget this browser",exact:true}).click();
  await page.getByRole("heading", {name:"Your computers",exact:true}).waitFor();
  await page.getByRole("heading", {name:"Add your first computer",exact:true}).waitFor();
  check("explicit_forget_revokes_and_removes_saved_profile", await page.getByRole("button", {name:"Connect",exact:true}).count() === 0);
  check("forget_removes_durable_draft_and_history_rows", await page.evaluate(() => new Promise<boolean>((resolveRows, reject) => {
    const request = indexedDB.open("grok-remote-drafts.v2", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction("drafts", "readonly"), rows = transaction.objectStore("drafts").count();
      transaction.oncomplete = () => {db.close(); resolveRows(rows.result === 0);};
      transaction.onerror = () => {db.close(); reject(transaction.error);};
    };
  })));
  if (multihost) {
    denyAppNetwork = false;
    await writeFile(join(state, "pair-next"), "", {mode:0o600});
    await waitFor(async () => {try {await readFile(join(state, "pair-next.json")); return true;} catch {return false;}});
    const nextPairing = JSON.parse(await readFile(join(state, "pair-next.json"), "utf8"));
    await qualifyDirectMultiHost({page, origin, pairingA:nextPairing, pairingB:secondNative.pairing, markerA:"Synthetic direct connection QA. No Grok process is running.", markerB:secondMarker, directory, check, waitFor, network(host, blocked) {
      if (blocked) {blockedHosts.add(host); for (const socket of hostUpstreams.get(host) ?? []) socket.close();}
      else blockedHosts.delete(host);
    }, active(host) {return hostUpstreams.get(host)?.size ?? 0;}, attempts(host) {return report.transport.filter((value: any) => value.at === "proxy" && value.host === host).length;}, geometry(value) {report.multihost.geometry = value;}});
  }
  if (cropDist) {
    report.cropArtifactSha256 = createHash("sha256").update(await readFile(join(cropDist, "crop.html"))).digest("hex");
    await page.goto(`https://127.0.0.1:${server.port}/crop-qa/crop.html`);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole("button", {name:"Add synthetic image",exact:true}).click();
    const cropState = page.getByTestId("crop-state");
    await page.waitForFunction(() => document.querySelector('[data-testid="crop-state"]')?.getAttribute("data-width") === "128");
    await page.getByRole("button", {name:"Preview synthetic-pixels.png",exact:true}).click();
    await page.getByRole("button", {name:"Crop image",exact:true}).click();
    const width = page.getByRole("slider", {name:"Width",exact:true});
    await width.focus(); await width.press("Home");
    for (let step = 0; step < 24; step++) await width.press("ArrowRight");
    check("crop_width_supports_keyboard", await width.inputValue() === "32");
    await page.getByRole("button", {name:"Cancel crop",exact:true}).click();
    check("cancel_crop_preserves_original_image", await cropState.getAttribute("data-width") === "128" && await cropState.getAttribute("data-height") === "64");
    await page.getByRole("button", {name:"Crop image",exact:true}).click();
    await width.focus(); await width.press("Home");
    for (let step = 0; step < 24; step++) await width.press("ArrowRight");
    const left = page.getByRole("slider", {name:"Left",exact:true});
    await left.focus(); await left.press("End");
    const move = page.getByRole("button", {name:"Move crop",exact:true});
    await move.focus(); await move.press("ArrowLeft");
    check("crop_move_has_visible_keyboard_focus", await move.evaluate((element: HTMLElement) => {const style = getComputedStyle(element); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;}));
    check("crop_preview_geometry_matches_selection_surface", await page.getByRole("dialog").locator("img").evaluate((element: HTMLImageElement) => {const image = element.getBoundingClientRect(), surface = element.parentElement!.getBoundingClientRect(); return image.width > 0 && Math.abs(image.width - surface.width) <= 1 && Math.abs(image.height - surface.height) <= 1;}));
    check("crop_editor_fits_mobile_viewport", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:join(directory,"crop-editor-mobile.png")});
    await page.getByRole("button", {name:"Apply crop",exact:true}).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="crop-state"]')?.getAttribute("data-width") === "32");
    await page.getByRole("button", {name:"Preview synthetic-pixels.png",exact:true}).click();
    check("crop_canvas_preserves_selected_pixels", await page.getByRole("dialog").locator("img").evaluate(async (element: HTMLImageElement) => {
      await element.decode();
      const canvas = document.createElement("canvas"); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(element, 0, 0);
      const pixel = context.getImageData(16, 32, 1, 1).data;
      return canvas.width === 32 && canvas.height === 64 && pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 255 && pixel[3] === 255;
    }));
    check("crop_never_sends_or_changes_text_draft", await cropState.getAttribute("data-sends") === "0" && await cropState.getAttribute("data-image-count") === "1" && await page.getByRole("textbox", {name:"Draft",exact:true}).inputValue() === "Synthetic draft stays unchanged");
    await page.screenshot({path:join(directory,"crop-result-mobile.png")});
  }
  check("no_external_application_requests", cloudRequests.length === 0);
  check("no_uncaught_browser_errors", report.errors.length === 0);
  report.result = "passed";
} catch (error) {if (page) {await page.screenshot({path:join(directory,"failure.png")}).catch(() => {}); await writeFile(join(directory,"failure-page.txt"), await page.locator("body").innerText().catch(() => "unavailable"), {mode:0o600});} report.result = "failed"; report.failure = (error instanceof Error ? error.message : String(error)).replace(/#directPair=[A-Za-z0-9_-]+/g,"#directPair=[redacted]"); process.exitCode = 1;}
finally {
  denyAppNetwork = false;
  const members = async (group: number) => {
    const values: {pid: number; startTicks: string}[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === group && fields[0] !== "Z") values.push({pid:Number(entry),startTicks:fields[19]});
      } catch {}
    }
    return values;
  };
  const cleanup: {name: string; child: ChildProcess; members: Awaited<ReturnType<typeof members>>}[] = [];
  for (const value of [...processes, ...(syl ? [{name:"syl",child:syl}] : [])]) cleanup.push({...value,members:value.child.pid ? await members(value.child.pid) : []});
  if (browser) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    report.browserClosedGracefully = await Promise.race([browser.close().then(() => true, () => false), new Promise<boolean>(resolveClosed => {timer = setTimeout(() => resolveClosed(false), 5000);})]);
    clearTimeout(timer);
  }
  if(firefoxRuntime) {try {await firefoxRuntime.close();} catch(error) {report.cleanupFailed=true;report.firefox.cleanupFailure=String(error);}}
  for (const socket of upstreams) socket.close();
  server?.stop(true);
  if (syl) {
    try {const closed = await rpc("tools/call", {name:"gui_close",arguments:{}}); assert.ok(!closed.isError); report.hiddenCompositorClosed = true;}
    catch {report.cleanupFailed = true;}
  }
  report.cleanup = {};
  for (const value of cleanup.reverse()) {
    try {
      const ended = () => value.child.exitCode !== null || value.child.signalCode !== null;
      if (!ended()) value.child.kill("SIGTERM");
      try {await waitFor(async () => ended(), 5000);}
      catch {value.child.kill("SIGKILL"); await waitFor(async () => ended(), 5000);}
      if (value.child.pid) {
        for (const member of value.members) {
          const remaining = await members(value.child.pid);
          if (remaining.some(current => current.pid === member.pid && current.startTicks === member.startTicks)) {
            try {process.kill(member.pid, "SIGKILL");} catch (error: any) {if (error.code !== "ESRCH") throw error;}
          }
        }
        await waitFor(async () => !(await members(value.child.pid!)).length, 5000);
      }
      report.cleanup[value.name] = {exited:true,processGroupEmpty:true};
    } catch {report.cleanupFailed = true; report.cleanup[value.name] = {exited:false,processGroupEmpty:false};}
  }
  for (const [name, state] of [["chrome", "chrome-profile"], ["native", "native"], ["native-b", "native-b"]]) {
    if (report.cleanup[name]?.processGroupEmpty) await rm(join(directory,state), {recursive:true,force:true}).catch(() => {report.cleanupFailed = true;});
  }
  await rm(join(directory,"key.pem"), {force:true}).catch(() => {report.cleanupFailed = true;});
  if (spawnFailures.length) {report.spawnFailures = spawnFailures; report.cleanupFailed = true;}
  report.notQualified.push(syl ? "Descendants that leave their recorded process group; Syl compositor is closed through its own API" : "Descendants that leave their recorded process group; no hostile-process containment claim");
  if (report.cleanupFailed) {report.result = "failed"; process.exitCode = 1;}
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,failure:report.failure,cleanupFailed:report.cleanupFailed ?? false,report:join(directory,"report.json")}));
}
