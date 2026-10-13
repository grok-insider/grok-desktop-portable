import assert from "node:assert/strict";
import {spawn, type ChildProcess} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, readdir} from "node:fs/promises";
import {closeSync, openSync} from "node:fs";
import {createInterface} from "node:readline";
import {resolve, join} from "node:path";
import {buildOrigin, deploymentOrigin, deploymentConfigPath, origins} from "./deployment-origin.mjs";
import {verifyArtifact} from "./remote-artifact.mjs";

const [directoryArgument] = process.argv.slice(2);
assert.ok(directoryArgument, "Usage: bun scripts/qualify-direct-browser.ts <private-directory-with-cert.pem-and-key.pem>");
assert.ok(process.env.REMOTE_QA_CHROME?.startsWith("/nix/store/") && process.env.REMOTE_QA_CHROME.includes("google-chrome-"), "REMOTE_QA_CHROME must name the actual Nix Chrome package, never the daily-profile wrapper");
const directory = resolve(directoryArgument);
const artifact = process.env.REMOTE_QA_ARTIFACT ? resolve(process.env.REMOTE_QA_ARTIFACT) : undefined;
const dist = artifact ? join(artifact, ".vercel/output/static") : resolve("apps/web/dist");
const origin = deploymentOrigin(process.env.REMOTE_QA_ORIGIN ?? buildOrigin(await readFile(join(dist, "index.html"), "utf8")));
assert.equal(buildOrigin(await readFile(join(dist, "index.html"), "utf8")), origin, "Browser qualification must use the built shell's exact origin");
const hostname = new URL(origin).hostname;
const cropDist = process.env.REMOTE_QA_CROP_DIST ? resolve(process.env.REMOTE_QA_CROP_DIST) : undefined;
const deployment = JSON.parse(await readFile(artifact ? join(artifact, ".vercel/output/config.json") : resolve(deploymentConfigPath(origin)), "utf8"));
const report: any = {schema: 1, startedAt: new Date().toISOString(), origin, checks: [], errors: [], transport: [], notQualified: ["Production TLS trust: laboratory self-signed certificate", "Actual hosting and CDN routing", "Tailscale", "Physical Android and Apple hardware", "Grok inference: synthetic history only", "Real push delivery", "GPU performance: hidden software compositor"]};
const processes: ChildProcess[] = [];
let browser: any, page: any, server: any, syl: ChildProcess | undefined;
const check = (name: string, value: unknown) => {assert.ok(value, name); report.checks.push(name);};
const waitFor = async (ready: () => Promise<boolean>, timeout = 15000) => {const end = Date.now() + timeout; while (!await ready()) {assert.ok(Date.now() < end, "fixture readiness deadline"); await Bun.sleep(50);}};
const start = (name: string, command: string, args: string[], env: Record<string,string | undefined> = process.env) => {
  const fd = openSync(join(directory, `${name}.log`), "wx", 0o600);
  const child = spawn(command, args, {env, detached: true, stdio: ["ignore", fd, fd]});
  closeSync(fd); processes.push(child); return child;
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
let sourceMetadataPath = "", syntheticSourceMetadata: any;
let sourceNoticesPath = "", sourceNotices = "";
let sourceUnavailable = true;
const expectedResourceErrors = new Set<string>();
const upstreams = new Set<WebSocket>();
try {
  if (artifact) {
    assert.ok(process.env.REMOTE_QA_SPANREED, "Artifact qualification requires REMOTE_QA_SPANREED for the real corresponding-source proof");
    const manifest = await verifyArtifact(artifact, {forDeploy: true, spanreed: resolve(process.env.REMOTE_QA_SPANREED!), origin});
    report.deploymentManifestSha256 = createHash("sha256").update(await readFile(join(artifact, "deployment.json"))).digest("hex");
    report.sources = manifest.sources;
    check("deployment_candidate_and_real_corresponding_source_verified", manifest.deployCandidate);
  }
  report.artifactSha256 = createHash("sha256").update(await readFile(join(dist, "index.html"))).update(await readFile(join(dist, "sw.js"))).digest("hex");
  const nativeBinary = process.env.DIRECT_QA_NATIVE_BINARY ?? "/tmp/fabrials-remote-integration/target/debug/examples/direct_browser_fixture";
  report.nativeFixtureSha256 = createHash("sha256").update(await readFile(nativeBinary)).digest("hex");
  const state = join(directory, "native");
  await mkdir(state, {mode: 0o700});
  start("native", nativeBinary, [], {...process.env, DIRECT_BROWSER_QA_DIRECTORY: state, DIRECT_BROWSER_QA_WEB_ORIGIN: origin, GROK_HOME: join(state, "synthetic-grok")});
  await waitFor(async () => {try {await readFile(join(state, "ready.json")); return true;} catch {return false;}});
  const native = JSON.parse(await readFile(join(state, "ready.json"), "utf8"));
  nativePort = native.port;
  server = Bun.serve<{upstream?: WebSocket; queued: string[]; origin: string}>({hostname: "127.0.0.1", port: 0, tls: {key: Bun.file(join(directory, "key.pem")), cert: Bun.file(join(directory, "cert.pem"))}, async fetch(request, serving) {
    const url = new URL(request.url);
    if (url.pathname === "/remote") report.transport.push({at:"proxy",host:url.hostname,origin:request.headers.get("origin")});
    if (url.hostname === "direct-fixture.test" && url.pathname === "/remote") {
      if (denyHostNetwork) return new Response(null, {status: 503});
      if (serving.upgrade(request, {data: {queued: [], origin: request.headers.get("origin") ?? ""}, headers: {"sec-websocket-protocol": "fabrials.remote.v1"}})) return;
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
    const file = Bun.file(cropPath ? join(cropDist!, path.slice("/crop-qa/".length)) : join(dist, path));
    if (!await file.exists()) return new Response(null, {status: 404});
    const headers = new Headers({"cache-control":"no-store", ...(path.endsWith(".js") ? {"content-type":"text/javascript"} : {})});
    for (const route of deployment.routes) if (route.src && !route.has && !route.missing && route.headers && new RegExp(`^${route.src}$`).test(url.pathname)) {
      for (const [name, value] of Object.entries(route.headers)) headers.set(name, String(value));
    }
    return new Response(file, {headers});
  }, websocket: {
    open(socket) {
      const upstream = new WebSocket(`ws://127.0.0.1:${nativePort}/remote`, {headers: {Host: "direct-fixture.test", Origin: socket.data.origin, "Sec-WebSocket-Protocol": "fabrials.remote.v1"}});
      socket.data.upstream = upstream; upstreams.add(upstream);
      upstream.onopen = () => {for (const value of socket.data.queued) upstream.send(value); socket.data.queued = [];};
      upstream.onmessage = event => {report.transport.push({at:"native-frame",type:typeof event.data,bytes:event.data.length,kind:typeof event.data === "string" ? JSON.parse(event.data).type : "binary"}); socket.send(event.data);};
      upstream.onclose = () => {upstreams.delete(upstream); socket.close();};
      upstream.onerror = event => {report.transport.push({at:"native-error",message:event.message}); socket.close();};
    },
    message(socket, message) {report.transport.push({at:"browser-frame",bytes:message.length}); const value = typeof message === "string" ? message : message.toString(); if (socket.data.upstream?.readyState === 1) socket.data.upstream.send(value); else if (socket.data.queued.length < 16) socket.data.queued.push(value); else socket.close();},
    close(socket) {socket.data.upstream?.close();},
  }});
  const sylLog = openSync(join(directory, "syl.log"), "wx", 0o600);
  syl = spawn("syl", ["mcp"], {env: {...process.env, SYL_MCP_PROFILE: "visual", SYL_NESTED_RES: "2560x1440"}, stdio: ["pipe", "pipe", sylLog]});
  closeSync(sylLog);
  createInterface({input: syl.stdout!}).on("line", line => {const value = JSON.parse(line); const entry = pending.get(value.id); if (entry) {pending.delete(value.id); if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result);}});
  await rpc("initialize", {protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"direct-browser-qualification",version:"1"}});
  const nested = await rpc("tools/call", {name:"gui_open",arguments:{target:"nested",app:"foot"}});
  const display = nested.content?.map((item: any) => item.text ?? "").join(" ").match(/display=(wayland-\d+)/)?.[1];
  assert.ok(display, "real hidden Syl compositor, never its stub backend");
  const profile = join(directory, "chrome-profile");
  await mkdir(profile, {mode: 0o700});
  start("chrome", process.env.REMOTE_QA_CHROME!, [`--user-data-dir=${profile}`,"--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--ozone-platform=wayland","--password-store=basic","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-component-update","--disable-sync","--no-proxy-server","--ignore-certificate-errors",`--host-resolver-rules=MAP ${new URL(origins.production).hostname} 127.0.0.1:${server.port}, MAP ${new URL(origins.qualification).hostname} 127.0.0.1:${server.port}, MAP direct-fixture.test 127.0.0.1:${server.port}, MAP remote.fabrials.com 127.0.0.1:${server.port}`,"--start-fullscreen","--window-size=2560,1440","about:blank"], {...process.env, WAYLAND_DISPLAY: display});
  let cdpPort = 0;
  await waitFor(async () => {try {cdpPort = Number((await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]); return Boolean(cdpPort);} catch {return false;}});
  const {chromium} = await import(process.env.REMOTE_QA_PLAYWRIGHT ?? "/tmp/xt-work/qa/node_modules/playwright-core/index.mjs");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  report.browser = browser.version();
  const context = browser.contexts()[0];
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const cloudRequests: string[] = [];
  await context.route("**/*", (route: any) => {
    const url = new URL(route.request().url());
    const app = url.origin === origin;
    const host = url.origin === "https://direct-fixture.test";
    const alias = origin === origins.production && url.origin === "https://remote.fabrials.com" && route.request().isNavigationRequest();
    const crop = cropDist && url.origin === `https://127.0.0.1:${server.port}` && url.pathname.startsWith("/crop-qa/");
    if (app || host || alias || crop || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    cloudRequests.push(url.hostname);
    return route.abort();
  });
  page.on("websocket", (socket: any) => {socket.on("socketerror", (message: string) => report.transport.push({at:"browser-error",message}));});
  page.on("pageerror", (error: Error) => report.errors.push(error.message));
  page.on("console", (message: any) => {
    if (message.type() !== "error") return;
    if (expectedResourceErrors.has(message.location().url) && message.text().includes("404")) {
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
  await page.getByRole("button", {name:"Drafts off",exact:true}).click();
  await page.getByRole("button", {name:"Remember drafts on this device",exact:true}).click();
  await page.getByRole("button", {name:"Offline history",exact:true}).click();
  await page.getByRole("button", {name:"Save history on this device",exact:true}).click();
  await page.getByRole("list", {name:"Saved conversations",exact:true}).getByRole("button").first().waitFor();
  await page.getByRole("button", {name:"Close offline history",exact:true}).click();
  await input().fill("DIRECT_DRAFT_SYNTHETIC_CANARY");
  await page.locator('[data-draft-status="saved"]').waitFor();
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active));
  for (const viewport of [{width:2560,height:1440},{width:390,height:844},{width:844,height:390},{width:390,height:430}]) {
    await page.setViewportSize(viewport);
    check(`no_horizontal_overflow_${viewport.width}x${viewport.height}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`composer_reachable_${viewport.width}x${viewport.height}`, await input().isVisible());
    await page.screenshot({path:join(directory, `layout-${viewport.width}x${viewport.height}.png`)});
  }
  await page.setViewportSize({width:2560,height:1440});
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
} catch (error) {if (page) {await page.screenshot({path:join(directory,"failure.png")}).catch(() => {}); await writeFile(join(directory,"failure-page.txt"), await page.locator("body").innerText().catch(() => "unavailable"), {mode:0o600});} report.result = "failed"; report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1;}
finally {
  denyAppNetwork = false;
  await browser?.close().catch(() => {});
  for (const child of [...processes].reverse()) if (child.exitCode === null && child.pid) {try {process.kill(-child.pid,"SIGTERM");} catch {}}
  for (const socket of upstreams) socket.close();
  server?.stop(true);
  if (syl) {await rpc("tools/call", {name:"gui_close",arguments:{}}).catch(() => {}); syl.kill("SIGTERM");}
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({result:report.result,checks:report.checks.length,failure:report.failure,report:join(directory,"report.json")}));
}
