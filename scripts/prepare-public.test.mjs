/**
 * Structural tests for the shipped public/ tree and vercel rewrite policy.
 * Runs the real prepare-public.mjs against a real Vite dist (or fixture).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const dist = path.join(root, "apps", "web", "dist");
const require = createRequire(import.meta.url);

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function ensureDist() {
  if (fs.existsSync(path.join(dist, "index.html"))) return;
  const r = spawnSync("pnpm", ["--filter", "@grok-desktop-portable/web", "build"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("vite build failed for prepare-public test");
  }
}

function runPrepare() {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "prepare-public.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`prepare-public failed: ${r.status}`);
  }
  return r;
}

ensureDist();
runPrepare();

// --- product install scripts are scripts, not HTML ---
const installSh = read(path.join(pub, "install.sh"));
assert.ok(
  installSh.startsWith("#!/usr/bin/env sh"),
  "public/install.sh must start with #!/usr/bin/env sh",
);
assert.ok(!installSh.includes("<!doctype"), "install.sh must not be HTML");
assert.ok(!installSh.includes("<html"), "install.sh must not be HTML");
assert.ok(
  installSh.includes("grok-bridge") || installSh.includes("GROK_BRIDGE"),
  "install.sh must mention grok-bridge",
);

const installPs1 = read(path.join(pub, "install.ps1"));
assert.ok(
  installPs1.includes("$ErrorActionPreference") || installPs1.includes("Invoke-WebRequest"),
  "install.ps1 must look like PowerShell",
);
assert.ok(!/^\s*</.test(installPs1), "install.ps1 must not start like HTML");
assert.ok(!installPs1.includes("<!DOCTYPE"), "install.ps1 must not be HTML");

// --- product landing is marketing HTML, not the Work SPA alone ---
const landing = read(path.join(pub, "index.html"));
assert.ok(landing.includes("Grok Desktop Portable"), "landing title/copy");
assert.ok(
  landing.includes("install.sh") || landing.includes("curl"),
  "landing must mention install",
);
assert.ok(
  !landing.includes('id="root"') || !landing.includes('type="module" crossorigin'),
  "landing must not be the Vite SPA shell",
);

// --- demo SPA is under /demo and labeled ---
const demoIndex = read(path.join(pub, "demo", "index.html"));
assert.ok(demoIndex.includes("data-demo-banner"), "demo must show demo banner");
assert.ok(
  demoIndex.includes('name="grok-path-base"') && demoIndex.includes("/demo"),
  "demo must declare path base /demo",
);
assert.ok(
  demoIndex.includes('id="root"') || demoIndex.includes("type=\"module\""),
  "demo must be the Work SPA",
);
assert.ok(fs.existsSync(path.join(pub, "demo", "assets")), "demo assets present");

// --- vercel never rewrites install routes to SPA ---
const vercel = JSON.parse(read(path.join(root, "vercel.json")));
assert.ok(Array.isArray(vercel.rewrites), "vercel rewrites array");
const rewriteSources = vercel.rewrites.map((r) => r.source);
for (const forbidden of ["/install.sh", "/install.ps1"]) {
  for (const src of rewriteSources) {
    // Catch-all that would swallow install.sh (historical bug).
    if (src.includes("install")) {
      assert.fail(`rewrite must not target install routes: ${src}`);
    }
    // Broad SPA catch-alls like /((?!api/).*) swallow install.sh — ban them.
    if (src.includes("(?!") || src === "/(.*)" || src === "/:path*") {
      assert.fail(`over-broad rewrite would swallow static install scripts: ${src}`);
    }
  }
}
assert.ok(
  !rewriteSources.some((s) => s === "/" || s === "/index.html"),
  "must not rewrite product landing away",
);
// Headers pin content-types for install scripts
const headerSources = (vercel.headers || []).map((h) => h.source);
assert.ok(headerSources.includes("/install.sh"), "header for install.sh");
assert.ok(headerSources.includes("/install.ps1"), "header for install.ps1");

console.log("prepare-public.test.mjs: ok");
