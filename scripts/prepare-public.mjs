/**
 * Post-process apps/web → public for static hosting (Vercel outputDirectory).
 * Softens CSP meta, adds demo banner, clears pair hash (session auto-pairs via API).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = path.join(root, "public", "index.html");
if (!fs.existsSync(index)) {
  console.error("prepare-public: public/index.html missing — run web build first");
  process.exit(1);
}
let html = fs.readFileSync(index, "utf8");
html = html.replace(
  /http-equiv=(["'])Content-Security-Policy\1[^>]*content=(["'])([\s\S]*?)\2/gi,
  (_full, q1, q2) => {
    const c =
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors *";
    return `http-equiv=${q1}Content-Security-Policy${q1} content=${q2}${c.replace(/'/g, "&#39;")}${q2}`;
  },
);
if (!html.includes("data-demo-banner")) {
  const banner = `<div data-demo-banner style="position:fixed;z-index:9999;left:0;right:0;top:0;padding:6px 12px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;background:#1a1a1f;color:#c8c8d0;border-bottom:1px solid #2a2a32;text-align:center">Hosted demo of Grok Desktop Portable Work UI — real CLI sessions need the local bridge on your machine.</div><style data-demo-banner>body{padding-top:32px !important}</style>`;
  html = html.replace("<body>", `<body>${banner}`);
}
const inject = `<script data-demo-pair>(function(){try{if(location.hash.indexOf("#pair=")===0)history.replaceState(null,"",location.pathname+location.search);}catch(e){}})();</script>`;
if (!html.includes("data-demo-pair") && html.includes("</head>")) {
  html = html.replace("</head>", `${inject}</head>`);
}
fs.writeFileSync(index, html);
console.log("prepare-public: patched", index);
