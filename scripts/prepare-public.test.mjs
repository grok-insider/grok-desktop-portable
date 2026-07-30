/**
 * Structural tests for the shipped public/ tree (ADR 0016 production SPA).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const dist = path.join(root, "apps", "web", "dist");

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

// --- product install scripts ---
const installSh = read(path.join(pub, "install.sh"));
assert.ok(installSh.startsWith("#!/usr/bin/env sh"));
assert.ok(!installSh.includes("<!doctype"));
assert.ok(!installSh.includes("releases/latest/download"));
assert.ok(installSh.includes("api.github.com/repos/"));

const installPs1 = read(path.join(pub, "install.ps1"));
assert.ok(
  installPs1.includes("$ErrorActionPreference") || installPs1.includes("Invoke-WebRequest"),
);
assert.ok(!installPs1.includes("releases/latest/download"));

// --- production SPA at site root (probe → landing or Work) ---
const index = read(path.join(pub, "index.html"));
assert.ok(
  index.includes('id="root"') || index.includes('type="module"'),
  "public/index.html must be the Work SPA",
);
assert.ok(
  index.includes("127.0.0.1") || index.includes("connect-src"),
  "SPA CSP must allow loopback bridge connect-src",
);
assert.ok(fs.existsSync(path.join(pub, "assets")), "SPA assets present");

// --- stub demo optional ---
const demoIndex = read(path.join(pub, "demo", "index.html"));
assert.ok(demoIndex.includes("data-demo-banner"), "demo labeled as stub");

// --- vercel: SPA routes without swallowing install ---
const vercel = JSON.parse(read(path.join(root, "vercel.json")));
const rewriteSources = vercel.rewrites.map((r) => r.source);
for (const src of rewriteSources) {
  if (src.includes("install")) {
    assert.fail(`rewrite must not target install: ${src}`);
  }
  if (src.includes("(?!") || src === "/(.*)" || src === "/:path*") {
    assert.fail(`over-broad rewrite would swallow install scripts: ${src}`);
  }
}
assert.ok(rewriteSources.some((s) => s.includes("/s/")), "SPA session rewrite");
assert.ok(
  (vercel.headers || []).map((h) => h.source).includes("/install.sh"),
  "header for install.sh",
);

console.log("prepare-public.test.mjs: ok");
