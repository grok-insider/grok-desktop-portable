/**
 * Build product + demo static tree under `public/` for Vercel / local preview.
 *
 * Layout (product vs demo — desktop.grok.me must not confuse them):
 *   public/index.html          product landing (from site/)
 *   public/install.sh          real install script (not SPA HTML)
 *   public/install.ps1         Windows install script
 *   public/demo/               Work SPA demo shell (patched CSP + banner)
 *
 * Bridge embed still uses apps/web/dist (see crates/grok-bridge/build.rs).
 * This script never replaces that tree; it only assembles public/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps", "web", "dist");
const pub = path.join(root, "public");
const site = path.join(root, "site");
const demo = path.join(pub, "demo");

function die(msg) {
  console.error(`prepare-public: ${msg}`);
  process.exit(1);
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (!fs.existsSync(path.join(dist, "index.html"))) {
  die("apps/web/dist/index.html missing — run the web Vite build first");
}
for (const name of ["index.html", "install.sh", "install.ps1"]) {
  if (!fs.existsSync(path.join(site, name))) {
    die(`site/${name} missing`);
  }
}

rmrf(pub);
fs.mkdirSync(pub, { recursive: true });

// Product surface at origin root.
copyFile(path.join(site, "index.html"), path.join(pub, "index.html"));
copyFile(path.join(site, "install.sh"), path.join(pub, "install.sh"));
copyFile(path.join(site, "install.ps1"), path.join(pub, "install.ps1"));
fs.chmodSync(path.join(pub, "install.sh"), 0o755);

// Demo Work UI under /demo only.
copyDir(dist, demo);

const demoIndex = path.join(demo, "index.html");
let html = fs.readFileSync(demoIndex, "utf8");

// Soften CSP for hosted demo (connect-src must allow wss to same origin).
html = html.replace(
  /http-equiv=(["'])Content-Security-Policy\1[^>]*content=(["'])([\s\S]*?)\2/gi,
  (_full, q1, q2) => {
    const c =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors *";
    return `http-equiv=${q1}Content-Security-Policy${q1} content=${q2}${c.replace(/'/g, "&#39;")}${q2}`;
  },
);

// Client routes are absolute; tell the SPA it is mounted under /demo.
if (!html.includes('name="grok-path-base"')) {
  const meta =
    '<meta name="grok-path-base" content="/demo" data-demo-base />';
  html = html.includes("</head>")
    ? html.replace("</head>", `${meta}</head>`)
    : meta + html;
}

if (!html.includes("data-demo-banner")) {
  const banner = `<div data-demo-banner style="position:fixed;z-index:9999;left:0;right:0;top:0;padding:6px 12px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;background:#1a1a1f;color:#c8c8d0;border-bottom:1px solid #2a2a32;text-align:center">Hosted demo of Grok Desktop Portable Work UI — real CLI sessions need the local bridge on your machine. <a href="/" style="color:#9fd4b0">Install bridge</a></div><style data-demo-banner>body{padding-top:32px !important}</style>`;
  html = html.replace("<body>", `<body>${banner}`);
}

const inject = `<script data-demo-pair>(function(){try{if(location.hash.indexOf("#pair=")===0)history.replaceState(null,"",location.pathname+location.search);}catch(e){}})();</script>`;
if (!html.includes("data-demo-pair") && html.includes("</head>")) {
  html = html.replace("</head>", `${inject}</head>`);
}

fs.writeFileSync(demoIndex, html);

// Sanity: install scripts must remain scripts, not HTML.
for (const script of ["install.sh", "install.ps1"]) {
  const body = fs.readFileSync(path.join(pub, script), "utf8");
  if (/^\s*</.test(body) || body.includes("<!doctype") || body.includes("<!DOCTYPE")) {
    die(`${script} looks like HTML after copy — refusing to ship`);
  }
}
const sh = fs.readFileSync(path.join(pub, "install.sh"), "utf8");
if (!sh.startsWith("#!/usr/bin/env sh")) {
  die("install.sh must start with #!/usr/bin/env sh");
}
const landing = fs.readFileSync(path.join(pub, "index.html"), "utf8");
if (landing.includes('id="root"') && landing.includes("type=\"module\"")) {
  // Product landing is static marketing HTML, not the Vite SPA shell.
  die("public/index.html looks like the Work SPA — product landing must be site/index.html");
}
if (!landing.includes("Grok Desktop Portable") && !landing.includes("install.sh")) {
  die("product landing missing expected install copy");
}

console.log("prepare-public: wrote", pub);
console.log("  product: index.html, install.sh, install.ps1");
console.log("  demo:    demo/ (Work SPA)");
