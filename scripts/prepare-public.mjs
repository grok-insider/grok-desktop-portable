/**
 * Assemble `public/` for https://desktop.grok.me (ADR light 0016).
 *
 * Layout:
 *   public/index.html + assets/   production Work SPA (probe → landing or Work)
 *   public/install.sh             real install script (not SPA HTML)
 *   public/install.ps1
 *   public/demo/                  optional stub-demo SPA for server.mjs previews
 *
 * Bridge embed still uses apps/web/dist (crates/grok-bridge/build.rs).
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

function patchSpaIndex(indexPath, { demoMount } = { demoMount: false }) {
  let html = fs.readFileSync(indexPath, "utf8");
  // Ensure production CSP allows loopback bridge (vite already injects; re-assert).
  if (!html.includes("127.0.0.1")) {
    html = html.replace(
      /http-equiv=(["'])Content-Security-Policy\1[^>]*content=(["'])([\s\S]*?)\2/gi,
      (_full, q1, q2) => {
        const c =
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
        return `http-equiv=${q1}Content-Security-Policy${q1} content=${q2}${c.replace(/'/g, "&#39;")}${q2}`;
      },
    );
  }
  if (demoMount) {
    if (!html.includes('name="grok-path-base"')) {
      const meta = '<meta name="grok-path-base" content="/demo" data-demo-base />';
      html = html.includes("</head>")
        ? html.replace("</head>", `${meta}</head>`)
        : meta + html;
    }
    if (!html.includes("data-demo-banner")) {
      const banner = `<div data-demo-banner style="position:fixed;z-index:9999;left:0;right:0;top:0;padding:6px 12px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;background:#1a1a1f;color:#c8c8d0;border-bottom:1px solid #2a2a32;text-align:center">Stub demo — production is desktop.grok.me + local grok-bridge. <a href="/" style="color:#9fd4b0">Product UI</a></div><style data-demo-banner>body{padding-top:32px !important}</style>`;
      html = html.replace("<body>", `<body>${banner}`);
    }
  }
  fs.writeFileSync(indexPath, html);
}

if (!fs.existsSync(path.join(dist, "index.html"))) {
  die("apps/web/dist/index.html missing — run the web Vite build first");
}
for (const name of ["install.sh", "install.ps1"]) {
  if (!fs.existsSync(path.join(site, name))) {
    die(`site/${name} missing`);
  }
}

rmrf(pub);
fs.mkdirSync(pub, { recursive: true });

// Production SPA at site root (landing vs Work is client-side probe).
copyDir(dist, pub);
patchSpaIndex(path.join(pub, "index.html"), { demoMount: false });

// Install scripts next to SPA; must not be overwritten by SPA routes.
copyFile(path.join(site, "install.sh"), path.join(pub, "install.sh"));
copyFile(path.join(site, "install.ps1"), path.join(pub, "install.ps1"));
fs.chmodSync(path.join(pub, "install.sh"), 0o755);

// Optional stub-demo mount for server.mjs previews only.
copyDir(dist, demo);
patchSpaIndex(path.join(demo, "index.html"), { demoMount: true });

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

const index = fs.readFileSync(path.join(pub, "index.html"), "utf8");
if (!index.includes('id="root"') && !index.includes("type=\"module\"")) {
  die("public/index.html must be the Work SPA shell (id=root / module entry)");
}
if (!index.includes("127.0.0.1") && !index.includes("connect-src")) {
  die("public SPA CSP must allow connect-src to loopback bridge");
}
if (!fs.existsSync(path.join(pub, "assets"))) {
  die("public/assets missing — SPA build incomplete");
}

console.log("prepare-public: wrote", pub);
console.log("  production SPA: index.html + assets/");
console.log("  install: install.sh, install.ps1");
console.log("  stub demo: demo/");
