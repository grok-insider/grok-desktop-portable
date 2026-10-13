import assert from "node:assert/strict";
import {generateKeyPairSync, randomBytes, randomUUID, createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {openSync, closeSync} from "node:fs";
import {access, chmod, copyFile, mkdir, readFile, writeFile, rename, stat} from "node:fs/promises";
import {resolve, join, extname} from "node:path";

const [backendArgument, libsArgument, spanreedArgument, cryptoArgument, outputArgument] = process.argv.slice(2);
assert.ok(backendArgument && libsArgument && spanreedArgument && cryptoArgument && outputArgument, "Usage: bun scripts/serve-managed-qa.ts <account-fixture> <canonical-libs> <spanreed> <crypto-dist> <new-evidence-directory>");
assert.ok(process.env.REMOTE_QA_RELAY_BINARY && process.env.REMOTE_QA_NATIVE_BINARY, "Frozen relay and native test executables required");
const [backend, libs, spanreed, cryptoDirectory, output] = [backendArgument, libsArgument, spanreedArgument, cryptoArgument, outputArgument].map(value => resolve(value));
await mkdir(output, {mode: 0o700});
const accountReady = JSON.parse(await readFile(join(backend, "ready.json"), "utf8"));
const accountSecret = JSON.parse(await readFile(join(backend, "secrets.json"), "utf8"));
assert.equal(new URL(accountReady.base).hostname, "127.0.0.1");
const portable = resolve(import.meta.dir, "..");
const nativeDirectory = join(output, "native");
const relayDirectory = join(output, "relay");
const distribution = join(output, "pwa");
const grok = join(output, "grok");
for (const path of [nativeDirectory, relayDirectory, grok]) await mkdir(path, {mode: 0o700});
const children: ReturnType<typeof spawn>[] = [];
const launchToken = randomBytes(32).toString("hex");
const report: any = {schema: 1, scope: "managed-product-pwa-noise-relay-native-and-real-account-routes", startedAt: new Date().toISOString(), scriptSha256: createHash("sha256").update(await readFile(import.meta.path)).digest("hex"), boundaries: ["Synthetic account and installation", "Synthetic native project and session; no Grok process", "HTTP localhost browser transport through controlled QA proxy", "Native generation and authenticated tickets from real account routes", "Real Web Push provider when explicitly enabled by a participant"], notQualified: ["Production OAuth and ingress", "Private Tailscale path", "Real inference from the synthetic session"]};
let relayUrl = "";
let hostId = "";
let publicKey = "";
const hosts: {role: string; hostId: string; publicKey: string; directory: string; installationBearer: string; browser: typeof accountSecret.browser; child?: ReturnType<typeof spawn>}[] = [];
let stopping = false;
let failure: unknown;
let pairingQueue: Promise<unknown> = Promise.resolve();
process.once("SIGTERM", () => {stopping = true;});
process.once("SIGINT", () => {stopping = true;});

async function exists(path: string) {try {await access(path);return true;} catch {return false;}}
async function until(test: () => Promise<boolean>, message: string, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (!await test()) {assert.ok(Date.now() < end, message);assert.ok(!stopping, "fixture stopping");await Bun.sleep(50);}
}
function child(name: string, command: string, arguments_: string[], cwd: string, extra: Record<string, string> = {}) {
  const log = openSync(join(output, `${name}.log`), "wx", 0o600);
  const environment: Record<string, string | undefined> = {...process.env, GROK_HOME: grok, ...extra};
  for (const key of ["XAI_API_KEY", "GROK_API_KEY", "FABRIALS_LOCAL_DEV_KEY", "AI_RELAY_VIRTUAL_KEY", "GROK_CODE_XAI_API_KEY", "FIRECRAWL_API_KEY", "EXA_API_KEY"]) delete environment[key];
  const process_ = spawn(command, arguments_, {cwd, env: environment, stdio: ["ignore", log, log], detached: true});
  closeSync(log);children.push(process_);
  return process_;
}
function alive(process_: ReturnType<typeof spawn>, message: string) {
  assert.equal(process_.exitCode, null, message);
  assert.equal(process_.signalCode, null, message);
}
async function call(path: string, data: unknown, bearer = accountSecret.installationBearer) {
  const response = await fetch(`${accountReady.base}/api/spanreed/remote${path}`, {method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"}, body: JSON.stringify(data), signal: AbortSignal.timeout(10_000)});
  assert.ok(response.ok, `Account route refused ${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
async function syntheticPair(host: typeof hosts[number]) {
  const task = pairingQueue.then(async () => {
    const id = randomUUID();
    const temporary = join(host.directory, `pair-${id}.tmp`);
    await writeFile(temporary, JSON.stringify({id, kind: "pair"}), {mode: 0o600});
    await rename(temporary, join(host.directory, "notification-command.json"));
    let receipt: any;
    await until(async () => {
      try {receipt = JSON.parse(await readFile(join(host.directory, "notification-command-receipt.json"), "utf8"));return receipt.id === id;} catch {return false;}
    }, "fresh pairing nonce", 5000);
    assert.equal(receipt.hostId, host.hostId);
    assert.equal(receipt.hostPublicKey, host.publicKey);
    assert.match(receipt.nonce, /^[a-f0-9]{64}$/);
    return {hostId: host.hostId, hostPublicKey: host.publicKey, secret: receipt.nonce};
  });
  pairingQueue = task.catch(() => {});
  return task;
}

type SocketData = {upstream?: WebSocket; queue: string[]};
const server = Bun.serve<SocketData>({hostname: "127.0.0.1", port: 0, maxRequestBodySize: 2_100_000,
  async fetch(request, current) {
    const url = new URL(request.url);
    const origin = `http://localhost:${current.port}`;
    if (url.pathname === "/qa-relay") {
      if (!relayUrl || request.headers.get("origin") !== origin) return new Response(null, {status: 403});
      if (current.upgrade(request, {data: {queue: []}})) return;
      return new Response(null, {status: 400});
    }
    if (url.pathname === "/qa-start") {
      if (url.searchParams.get("token") !== launchToken || !hostId) return new Response(null, {status: 403});
      try {
        const host = hosts.find(value => value.role === (url.searchParams.get("fixture") ?? "primary"));
        if (!host) return new Response(null, {status: 404});
        const pair = await syntheticPair(host);
        const headers = new Headers({"cache-control": "no-store", "referrer-policy": "no-referrer", location: `${origin}/#remotePair=${Buffer.from(JSON.stringify(pair)).toString("base64url")}`});
        for (const [name, value] of [["fb_access", host.browser.access_token], ["fb_refresh", host.browser.refresh_token], ["fb_refresh_proof", host.browser.browser_proof]]) {
          assert.equal(typeof value, "string");
          headers.append("set-cookie", `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=14400`);
        }
        return new Response(null, {status: 303, headers});
      } catch {return Response.json({error: "fixture_pair_unavailable"}, {status: 503});}
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.headers.get("origin") && request.headers.get("origin") !== origin) return new Response(null, {status: 403});
      const headers = new Headers(request.headers);
      headers.delete("host");headers.delete("content-length");headers.delete("connection");
      headers.set("origin", "https://remote.fabrials.com");
      headers.set("accept-encoding", "identity");
      try {
        const response = await fetch(`${accountReady.base}${url.pathname}${url.search}`, {method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "manual", signal: AbortSignal.timeout(15_000)});
        const returnedHeaders = new Headers(response.headers);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) returnedHeaders.delete(name);
        if (url.pathname === "/api/spanreed/remote/tickets" && response.ok) {
          const value = await response.json() as any;
          value.relayUrl = `${origin.replace("http:", "ws:")}/qa-relay`;
          return Response.json(value, {status: response.status, headers: returnedHeaders});
        }
        return new Response(response.body, {status: response.status, headers: returnedHeaders});
      } catch {return Response.json({error: "fixture_account_unavailable"}, {status: 503});}
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, {status: 405});
    let relative: string;
    try {relative = decodeURIComponent(url.pathname).slice(1);} catch {return new Response(null, {status: 400});}
    if (!relative || relative === "setup" || /^s\/[^/]+$/.test(relative)) relative = "index.html";
    if (relative.split("/").some(part => part === "..") || relative.includes("\\") || relative === "qualification-manifest.json") return new Response(null, {status: 403});
    const path = join(distribution, relative);
    try {
      if (!(await stat(path)).isFile()) return new Response(null, {status: 404});
      const types: Record<string, string> = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2"};
      return new Response(request.method === "HEAD" ? null : Bun.file(path), {headers: {"content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store"}});
    } catch {return new Response(null, {status: 404});}
  },
  websocket: {
    backpressureLimit: 400_000,
    closeOnBackpressureLimit: true,
    open(socket) {
      const upstream = new WebSocket(relayUrl, {headers: {Origin: "https://remote.fabrials.com"}});
      socket.data.upstream = upstream;
      upstream.onopen = () => {for (const value of socket.data.queue) upstream.send(value);socket.data.queue = [];};
      upstream.onmessage = event => {if (typeof event.data !== "string" || event.data.length > 100_000) {socket.close(1009);return;}socket.send(event.data);};
      upstream.onclose = () => socket.close();
      upstream.onerror = () => socket.close(1011);
    },
    message(socket, data) {
      if (typeof data !== "string" || data.length > 100_000) {socket.close(1009);return;}
      const upstream = socket.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 400_000) {socket.close(1013);return;}
        upstream.send(data);
      }
      else if (socket.data.queue.length < 4) socket.data.queue.push(data);
      else socket.close(1013);
    },
    close(socket) {socket.data.upstream?.close();socket.data.queue = [];},
  },
});
const origin = `http://localhost:${server.port}`;
try {
  const relayBinary = join(output, "relay-test");
  const nativeBinary = join(output, "native-test");
  await Promise.all([[process.env.REMOTE_QA_RELAY_BINARY!, relayBinary], [process.env.REMOTE_QA_NATIVE_BINARY!, nativeBinary]].map(async ([source, target]) => {await copyFile(source, target);await chmod(target, 0o700);}));
  report.binaries = await Promise.all([relayBinary, nativeBinary].map(async path => ({path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")})));
  for (const [role, credential] of [["primary", accountSecret], ["additional", {...accountSecret.additionalInstallation, browser: accountSecret.browser}], ["secondary", accountSecret.secondary]] as const) {
    assert.equal(typeof credential?.installationBearer, "string", "All synthetic identities required");
    const directory = role === "primary" ? nativeDirectory : join(output, `native-${role}`);
    if (directory !== nativeDirectory) await mkdir(directory, {mode: 0o700});
    const keys = generateKeyPairSync("x25519");
    const publicKey = keys.publicKey.export({format: "der", type: "spki"}).subarray(-32).toString("hex");
    const privateKey = Array.from(keys.privateKey.export({format: "der", type: "pkcs8"}).subarray(-32));
    const registered = await call("/hosts", {label: `Synthetic ${role} QA - no Grok process`, publicKey}, credential.installationBearer);
    const hostId = registered.host.id;
    hosts.push({role, hostId, publicKey, directory, installationBearer: credential.installationBearer, browser: credential.browser});
    await writeFile(join(directory, "remote.json"), JSON.stringify({enabled: true, hostId, publicKey, privateKey, label: `Synthetic ${role} QA`}), {mode: 0o600});
  }
  ({hostId, publicKey} = hosts[0]);
  const relay = child("relay", relayBinary, ["tests::managed_relay_qualification_fixture", "--exact", "--nocapture"], spanreed, {FABRIALS_REMOTE_RELAY_QA: relayDirectory, FABRIALS_REMOTE_RELAY_QA_CONTROL_URL: accountReady.base, FABRIALS_REMOTE_RELAY_QA_SECRET: accountSecret.relaySecret, FABRIALS_REMOTE_RELAY_QA_DURATION_SEC: "7200"});
  await until(async () => {alive(relay, "relay fixture alive");return exists(join(relayDirectory, "relay-ready.json"));}, "relay fixture starts", 180_000);
  relayUrl = JSON.parse(await readFile(join(relayDirectory, "relay-ready.json"), "utf8")).url;
  await until(async () => {
    try {return (await fetch(relayUrl.replace("ws:", "http:").replace("/connect", "/ready"), {signal: AbortSignal.timeout(2000)})).ok;}
    catch {return false;}
  }, "relay dependency ready");
  for (const host of hosts) {
    const ticket = await call("/tickets", {hostId: host.hostId, role: "host"}, host.installationBearer);
    await writeFile(join(host.directory, "host-input.json"), JSON.stringify({relayUrl, ticket: ticket.ticket, pushApi: `${accountReady.base}/api/spanreed/remote`, installationBearer: host.installationBearer, timeoutSeconds: 7200, seedSyntheticSession: true}), {mode: 0o600});
    const native = child(`native-${host.role}`, nativeBinary, ["network_fixture::managed_network_fixture", "--ignored", "--exact", "--nocapture"], libs, {FABRIALS_REMOTE_HOST_QA: host.directory, GROK_HOME: join(host.directory, "synthetic-grok")});
    host.child = native;
    await until(async () => {alive(native, "native fixture alive");try {return JSON.parse(await readFile(join(host.directory, "remote-status.json"), "utf8")).connection === "connected";} catch {return false;}}, "native Noise host starts", 180_000);
  }
  const builder = child("pwa-build", "node", ["qa/build-managed.mjs", origin, distribution], join(portable, "apps/web"), {FABRIALS_REMOTE_CRYPTO_DIST: cryptoDirectory});
  await until(async () => builder.exitCode !== null || builder.signalCode !== null, "PWA fixture build", 180_000);
  assert.equal(builder.exitCode, 0, "PWA fixture build succeeds");
  await writeFile(join(output, "launch.json"), JSON.stringify({url: `${origin}/qa-start?token=${launchToken}`, alternatives: Object.fromEntries(hosts.map(host => [host.role, `${origin}/qa-start?token=${launchToken}&fixture=${host.role}`]))}), {mode: 0o600});
  await writeFile(join(output, "ready.json"), JSON.stringify({origin, port: server.port, hostId, publicKey, nativeDirectory, hosts: hosts.map(({role, hostId, publicKey, directory}) => ({role, hostId, publicKey, directory})), relayDirectory, distribution, accountFixture: backend, startedAt: report.startedAt}), {mode: 0o600});
  console.log(JSON.stringify({ready: true, origin, output}));
  const untilTime = Date.now() + 7_000_000;
  while (!stopping && Date.now() < untilTime && !await exists(join(output, "stop"))) {
    for (const host of hosts) alive(host.child!, "native fixture alive");
    alive(relay, "relay fixture alive");
    await Bun.sleep(1000);
  }
} catch (error) {failure = error;report.failure = error instanceof Error ? error.message : String(error);}
finally {
  stopping = true;
  await Promise.all([nativeDirectory, relayDirectory, ...hosts.map(host => host.directory)].map(path => writeFile(join(path, "stop"), "stop")));
  server.stop(true);
  for (const owned of children) {
    if (owned.exitCode !== null || owned.signalCode !== null) continue;
    await Promise.race([new Promise(resolveExit => owned.once("exit", resolveExit)), Bun.sleep(5000)]);
    if (owned.exitCode === null && owned.signalCode === null) {try {process.kill(-owned.pid!, "SIGTERM");} catch {}}
  }
  for (const owned of children) if (owned.exitCode === null && owned.signalCode === null) {
    await Promise.race([new Promise(resolveExit => owned.once("exit", resolveExit)), Bun.sleep(2000)]);
    if (owned.exitCode === null && owned.signalCode === null) {try {process.kill(-owned.pid!, "SIGKILL");} catch {}}
  }
  await Promise.all(children.map(async owned => {if (owned.exitCode === null && owned.signalCode === null) await Promise.race([new Promise(resolveExit => owned.once("exit", resolveExit)), Bun.sleep(2000)]);}));
  report.syntheticHostRevocations = [];
  for (const host of hosts) {
    try {
      const response = await fetch(`${accountReady.base}/api/spanreed/remote/hosts`, {method: "DELETE", headers: {authorization: `Bearer ${host.installationBearer}`, "content-type": "application/json"}, body: JSON.stringify({hostId: host.hostId}), signal: AbortSignal.timeout(5000)});
      report.syntheticHostRevocations.push({role: host.role, revoked: response.ok});
    } catch {report.syntheticHostRevocations.push({role: host.role, revoked: false});}
  }
  report.result = failure ? "failed" : "stopped";
  report.stoppedAt = new Date().toISOString();
  report.ownedProcessesStopped = children.every(owned => owned.exitCode !== null || owned.signalCode !== null);
  await writeFile(join(output, "lifecycle.json"), JSON.stringify(report, null, 2), {mode: 0o600});
}
if (failure) process.exitCode = 1;
