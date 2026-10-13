import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyArtifact } from "./remote-artifact.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
export const origin = "https://grok.fabrials.com";
export const image = "nginxinc/nginx-unprivileged@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86";
const prefix = ".vercel/output/static/";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const adapterInputs = ["scripts/remote-coolify.mjs", "scripts/wasm-notices.py", "scripts/remote-artifact.mjs", "scripts/worker-manifest.mjs", "scripts/deployment-origin.mjs", "scripts/check-pwa-build.mjs", "apps/web/src/services/deploymentOrigins.json", "deploy/remote/qualification-build-output.json"];
const safePath = name => /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/.test(name) && !name.endsWith(".map");

async function files(directory, relative = "") {
  const names = [];
  for (const name of (await readdir(join(directory, relative))).sort()) {
    const entry = relative ? `${relative}/${name}` : name;
    const stat = await lstat(join(directory, entry));
    assert(!stat.isSymbolicLink(), `Symlink is forbidden: ${entry}`);
    if (stat.isDirectory()) names.push(...await files(directory, entry));
    else {assert(stat.isFile(), `Not a regular file: ${entry}`); names.push(entry);}
  }
  return names;
}

export function mimeType(name) {
  const types = {html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", webmanifest: "application/manifest+json", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", txt: "text/plain; charset=utf-8", sh: "text/x-shellscript; charset=utf-8", ps1: "text/plain; charset=utf-8", gz: "application/gzip"};
  const value = types[name.split(".").at(-1)];
  assert(value, `Unreviewed content type: ${name}`);
  return value;
}

export function cacheControl(name) {
  if (/^(assets|crypto|sources)\//.test(name)) return "public, max-age=31536000, immutable";
  if (/^install\.(sh|ps1)$/.test(name)) return "no-store";
  return "no-cache";
}

export function nginxConfiguration(names, policy, licenseLinks = {}) {
  assert.deepEqual(policy.routes[0].missing, [{type: "host", value: {eq: "grok.fabrials.com"}}]);
  const security = Object.assign({}, ...policy.routes.filter(route => route.continue && route.src === "/.*").map(route => route.headers));
  assert(security["Content-Security-Policy"] && security["X-Robots-Tag"]);
  security["Strict-Transport-Security"] = "max-age=31536000";
  const quote = value => {assert(!/[\\\r\n$]/.test(value)); return `"${value.replaceAll('"', '\\"')}"`;};
  const headers = (cache, extra = {}) => Object.entries({...security, Link: "</licenses>; rel=\"license\"", "Cache-Control": cache, ...extra}).map(([name, value]) => `      add_header ${name} ${name === "Cache-Control" && value !== "no-store" ? (value === "no-cache" ? "$revalidate_cache" : "$immutable_cache") : quote(value)} always;`).join("\n") + '\n      add_header Allow $allowed_methods always;';
  const route = (location, name) => `    location ${location} {\n      default_type ${quote(mimeType(name).split(";")[0])};\n${mimeType(name).includes("charset=") ? "      charset utf-8;\n      charset_types *;\n" : ""}${headers(cacheControl(name), {...(name === "sw.js" ? {"Service-Worker-Allowed": "/"} : {}), ...(licenseLinks[name] ? {Link: `</licenses>; rel="license", <${licenseLinks[name]}>; rel="license"`} : {})})}\n      try_files /${name} =404;\n    }`;
  for (const name of names) assert(safePath(name), `Unsafe static path: ${name}`);
  assert(names.includes("index.html"));
  return `worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr emerg;
events { worker_connections 256; }
http {
  access_log off;
  server_tokens off;
  types { }
  default_type application/octet-stream;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  client_max_body_size 1k;
  client_body_buffer_size 1k;
  client_header_buffer_size 1k;
  large_client_header_buffers 2 8k;
  client_header_timeout 10s;
  client_body_timeout 10s;
  send_timeout 15s;
  keepalive_timeout 15s;
  keepalive_requests 100;
  reset_timedout_connection on;
  sendfile on;
  tcp_nopush on;
  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_comp_level 3;
  gzip_types text/css text/javascript application/javascript application/json application/wasm image/svg+xml application/manifest+json;
  max_ranges 1;
  limit_conn_zone $server_name zone=all_connections:32k;
  limit_req_zone $server_name zone=all_requests:32k rate=200r/s;
  map "$status:$http_range" $immutable_cache {
    volatile;
    default no-store;
    ~^(200|206|304):$ "public, max-age=31536000, immutable";
  }
  map "$status:$http_range" $revalidate_cache {
    volatile;
    default no-store;
    ~^(200|206|304):$ no-cache;
  }
  map $status $allowed_methods {
    default "";
    405 "GET, HEAD";
  }
  map $request_uri $unsafe_path {
    default 1;
    ~^[^?]*// 1;
    ~^[^?]*/[.][.]?(?:/|[?]|$) 1;
    ~^/[A-Za-z0-9_./-]*(?:[?].*)?$ 0;
  }
  server {
    listen 8080 default_server;
    server_name grok.fabrials.com;
    root /srv/grok;
    limit_conn all_connections 128;
    limit_conn_status 429;
    limit_req zone=all_requests burst=400 nodelay;
    limit_req_status 429;
    limit_rate 2m;
    error_page 416 = @invalid_range;
    location @invalid_range {
${headers("no-store")}
      return 416;
    }
${headers("no-store")}
    if ($http_host != grok.fabrials.com) { return 404; }
    if ($request_method !~ ^(GET|HEAD)$) { return 405; }
    if ($unsafe_path) { return 404; }
    location = /healthz {
      default_type text/plain;
${headers("no-store")}
      return 200 "ok\\n";
    }
${route("= /", "index.html")}
${route("= /setup", "index.html")}
${names.includes("licenses.html") ? route("= /licenses", "licenses.html") : ""}
${route("~ ^/s/[A-Za-z0-9_.-]+$", "index.html")}
${names.map(name => route(`= /${name}`, name)).join("\n")}
    location / { return 404; }
  }
}
`;
}

export function dockerfile() {
  return `FROM ${image}\nUSER 101:101\nCOPY --chown=101:101 nginx.conf /etc/nginx/nginx.conf\nCOPY --chown=101:101 static/ /srv/grok/\nEXPOSE 8080\nHEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD wget -q -O /dev/null --header='Host: grok.fabrials.com' http://127.0.0.1:8080/healthz || exit 1\nENTRYPOINT ["nginx"]\nCMD ["-g", "daemon off;"]\n`;
}

export function compose() {
  return `services:\n  web:\n    build: .\n    expose:\n      - "8080"\n    restart: unless-stopped\n    read_only: true\n    tmpfs:\n      - /tmp:size=16m,mode=1777,noexec,nosuid\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    pids_limit: 64\n    mem_limit: 128m\n    memswap_limit: 128m\n    cpus: 0.50\n    stop_grace_period: 15s\n`;
}

async function reviewedArtifact(artifact, spanreed, portable) {
  if (!portable) return verifyArtifact(artifact, {forDeploy: true, spanreed, origin});
  const manifest = JSON.parse(await readFile(join(artifact, "deployment.json"), "utf8"));
  const revision = await execute("git", ["-C", portable, "rev-parse", "HEAD"], {encoding: "utf8"});
  assert.equal(revision.stdout.trim(), manifest.sources?.portable?.commit, "Portable verifier must match the candidate source revision");
  const status = await execute("git", ["-C", portable, "status", "--porcelain", "--untracked-files=normal"], {encoding: "utf8"});
  assert.equal(status.stdout, "", "Portable verifier checkout must be clean");
  await execute(process.execPath, [join(portable, "scripts/remote-artifact.mjs"), "verify", artifact, "--for-deploy", "--spanreed", spanreed, "--origin", origin], {encoding: "utf8", maxBuffer: 1024 * 1024});
  return manifest;
}

async function expected(artifact, spanreed, retain = [], wasmNotices, portable) {
  const current = await reviewedArtifact(artifact, spanreed, portable);
  const all = [{artifact, manifest: current, wasmNotices}];
  for (const item of retain) {
    assert(item.portable, "Retained sources require their original clean Portable verifier checkout (--retain-portable)");
    const manifest = await reviewedArtifact(item.artifact, item.spanreed, item.portable);
    all.push({artifact: item.artifact, manifest, wasmNotices: item.wasmNotices});
  }
  const staticFiles = new Map();
  const inputs = [];
  const supplements = [];
  const legalSources = [];
  const generatedNotices = {};
  const licenseLinks = {};
  for (let i = 0; i < all.length; i++) {
    const entry = all[i];
    const metadata = await readFile(join(entry.artifact, "deployment.json"));
    assert(entry.wasmNotices, "Every candidate requires its verified WASM notice supplement (--wasm-notices / --retain-wasm-notices)");
    await execute("python3", [join(repository, "scripts/wasm-notices.py"), "verify", "--artifact", entry.artifact, "--notices", entry.wasmNotices], {encoding: "utf8", maxBuffer: 1024 * 1024});
    const descriptorBytes = await readFile(join(entry.wasmNotices, "wasm-notices.json"));
    const descriptor = JSON.parse(descriptorBytes);
    assert.equal(descriptor.schema, 1);
    assert.equal(descriptor.artifactDeploymentSha256, digest(metadata));
    const supplement = descriptor.supplement;
    assert(/^[a-f0-9]{64}$/.test(supplement.sha256));
    assert.equal(supplement.path, `/sources/${supplement.sha256}.wasm-notices.txt`);
    const supplementPath = join(entry.wasmNotices, supplement.path.slice(1));
    const supplementStat = await lstat(supplementPath);
    assert(supplementStat.isFile() && !supplementStat.isSymbolicLink());
    const supplementBytes = await readFile(supplementPath);
    assert.equal(supplement.bytes, supplementBytes.length);
    assert.equal(supplement.sha256, digest(supplementBytes));
    staticFiles.set(supplement.path.slice(1), {sha256: supplement.sha256, path: supplementPath});
    const descriptorPath = `provenance/${digest(descriptorBytes)}.wasm-notices.json`;
    generatedNotices[descriptorPath] = descriptorBytes;
    supplements.push({deploymentSha256: digest(metadata), descriptorPath, descriptorSha256: digest(descriptorBytes), supplement});
    for (const item of [descriptor.wasm, descriptor.javascript]) {
      assert(typeof item.path === "string" && item.path.startsWith("/crypto/") && safePath(item.path.slice(1)));
      assert.equal(entry.manifest.files[`${prefix}${item.path.slice(1)}`], item.sha256);
      if (i === 0) licenseLinks[item.path.slice(1)] = supplement.path;
    }
    const sourceMetadata = JSON.parse(await readFile(join(entry.artifact, prefix, entry.manifest.correspondingSource.slice(1)), "utf8"));
    legalSources.push({shellId: sourceMetadata.shellId, archive: sourceMetadata.archive.path, license: sourceMetadata.license.path, notices: sourceMetadata.notices.path, supplement: supplement.path});
    inputs.push({role: i === 0 ? "current" : "retained-source", deploymentSha256: digest(metadata), sources: entry.manifest.sources, correspondingSource: entry.manifest.correspondingSource});
    for (const [name, sha256] of Object.entries(entry.manifest.files)) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      if (i > 0 && !relative.startsWith("sources/")) continue;
      assert(safePath(relative), `Unsafe static path: ${relative}`);
      const previous = staticFiles.get(relative);
      assert(!previous || previous.sha256 === sha256, `Retained source conflict: ${relative}`);
      staticFiles.set(relative, {sha256, path: join(entry.artifact, name)});
    }
  }
  const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const legalHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Source and licenses · Grok Remote</title></head><body><main><h1>Source and licenses</h1><p>This site serves the Grok Remote qualification application. Its source archive and dependency notices are available below, including the Rust dependencies compiled into WebAssembly.</p>${legalSources.map((item, i) => `<section><h2>${i === 0 ? "Current application" : "Retained application source"}</h2><p>Shell: <code>${escape(item.shellId)}</code></p><ul>${[["Corresponding source archive", item.archive], ["Application license", item.license], ["Frontend dependency notices", item.notices], ["WebAssembly dependency notices", item.supplement]].map(([label, path]) => `<li><a href="${escape(path)}">${label}</a></li>`).join("")}</ul></section>`).join("")}<p><a href="/">Return to Grok Remote</a></p></main></body></html>\n`;
  const names = [...staticFiles.keys(), "licenses.html"].sort();
  const policy = JSON.parse(await readFile(join(artifact, ".vercel/output/config.json"), "utf8"));
  const generated = {...generatedNotices, "static/licenses.html": legalHtml, "nginx.conf": nginxConfiguration(names, policy, licenseLinks), Dockerfile: dockerfile(), "compose.yaml": compose(), ".dockerignore": "*\n!Dockerfile\n!nginx.conf\n!static\n!static/**\n"};
  const adapter = {};
  for (const name of adapterInputs) adapter[name] = digest(await readFile(join(repository, name)));
  const checksums = Object.fromEntries([...staticFiles].map(([name, item]) => [`static/${name}`, item.sha256]));
  for (const [name, bytes] of Object.entries(generated)) checksums[name] = digest(bytes);
  const manifest = {schema: 1, format: "coolify-nginx-static-v1", origin, image, adapter, inputs, supplements, files: Object.fromEntries(Object.entries(checksums).sort(([a], [b]) => a.localeCompare(b)))};
  return {staticFiles, generated, manifest};
}

export async function packageCoolify(artifact, output, {spanreed, retain = [], wasmNotices, portable} = {}) {
  try {await lstat(output); throw new Error("Adapter output already exists");} catch (error) {if (error.code !== "ENOENT") throw error;}
  const value = await expected(artifact, spanreed, retain, wasmNotices, portable);
  await mkdir(dirname(output), {recursive: true});
  const temporary = await mkdtemp(join(dirname(output), ".remote-coolify-"));
  try {
    for (const [name, item] of value.staticFiles) {
      const target = join(temporary, "static", name);
      await mkdir(dirname(target), {recursive: true});
      await cp(item.path, target);
    }
    for (const [name, bytes] of Object.entries(value.generated)) {await mkdir(dirname(join(temporary, name)), {recursive: true}); await writeFile(join(temporary, name), bytes);}
    await writeFile(join(temporary, "adapter.json"), json(value.manifest));
    await verifyCoolify(temporary, {artifact, spanreed, retain, wasmNotices, portable});
    await rename(temporary, output);
  } finally {await rm(temporary, {recursive: true, force: true});}
  return value.manifest;
}

export async function verifyCoolify(directory, {artifact, spanreed, retain = [], wasmNotices, portable} = {}) {
  assert(artifact, "Verification requires the original candidate (--artifact)");
  const expectedValue = await expected(artifact, spanreed, retain, wasmNotices, portable);
  return verifyAdapterContents(directory, expectedValue.manifest);
}

export async function verifyAdapterContents(directory, expectedManifest) {
  const names = await files(directory);
  assert.deepEqual(names.sort(), ["adapter.json", ...Object.keys(expectedManifest.files)].sort(), "Adapter has missing or unexpected files");
  const manifest = JSON.parse(await readFile(join(directory, "adapter.json"), "utf8"));
  assert.deepEqual(manifest, expectedManifest, "Adapter differs from reviewed inputs or generated configuration");
  for (const [name, sha256] of Object.entries(manifest.files)) assert.equal(digest(await readFile(join(directory, name))), sha256, `Changed adapter file: ${name}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, ...args] = process.argv.slice(2);
  assert(["pack", "verify"].includes(command) && directory, "Usage: remote-coolify.mjs <pack|verify> <directory> --artifact <candidate> --spanreed <checkout> --wasm-notices <notices-directory> [--retain-source <candidate> --retain-spanreed <checkout> --retain-portable <original-portable-checkout> --retain-wasm-notices <notices-directory>]");
  const options = {retain: []};
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i + 1] && !args[i + 1].startsWith("--"), `Missing value: ${args[i]}`);
    const value = resolve(args[i + 1]);
    if (args[i] === "--artifact" || args[i] === "--spanreed" || args[i] === "--portable") {const key = args[i].slice(2); assert(!options[key], `Duplicate option: ${args[i]}`); options[key] = value;}
    else if (args[i] === "--wasm-notices") {assert(!options.wasmNotices, "Duplicate WASM notices"); options.wasmNotices = value;}
    else if (args[i] === "--retain-wasm-notices") {assert(options.retain.length && !options.retain.at(-1).wasmNotices, "Each retained source requires paired WASM notices"); options.retain.at(-1).wasmNotices = value;}
    else if (args[i] === "--retain-portable") {assert(options.retain.length && !options.retain.at(-1).portable, "Each retained source requires its original Portable verifier"); options.retain.at(-1).portable = value;}
    else if (args[i] === "--retain-source") options.retain.push({artifact: value});
    else if (args[i] === "--retain-spanreed") {assert(options.retain.length && !options.retain.at(-1).spanreed, "Each retained source requires one paired Spanreed checkout"); options.retain.at(-1).spanreed = value;}
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  assert(options.artifact && options.spanreed && options.wasmNotices && options.retain.every(item => item.spanreed && item.wasmNotices && item.portable), "Every candidate requires its reviewed Spanreed verifier checkout");
  if (command === "pack") await packageCoolify(options.artifact, resolve(directory), options);
  else await verifyCoolify(resolve(directory), options);
  console.log(`Coolify adapter ${command === "pack" ? "prepared" : "verified"}; nothing deployed.`);
}
