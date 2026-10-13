import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { externalizeSonnerStyles } from "./scripts/sonner-csp";
import { bindShellIdentity } from "./scripts/shell-identity";
import { thirdPartyNotices } from "./scripts/third-party-notices";
import { deploymentOrigin } from "../../scripts/deployment-origin.mjs";

const applicationOrigin = deploymentOrigin(process.env.FABRIALS_REMOTE_ORIGIN);

const pushEnabled = true;
const shareTarget = (process.env.VITE_REMOTE_EXPERIMENTS ?? "").split(",").map((value) => value.trim()).includes("share-target");
const manifestSource = JSON.parse(readFileSync(new URL("./public/manifest.webmanifest", import.meta.url), "utf8"));
if (shareTarget) manifestSource.share_target = {action: "/share-inbox", method: "POST", enctype: "multipart/form-data", params: {title: "title", text: "text", url: "url", files: [{name: "files", accept: ["text/*", "image/*", "application/pdf", "application/json"]}]}};
const cryptoDirectory = process.env.FABRIALS_REMOTE_CRYPTO_DIST;
const cryptoFiles = cryptoDirectory ? ["fabrials_remote_noise.js", "fabrials_remote_noise_bg.wasm"].map((name) => ({name, source: readFileSync(resolve(cryptoDirectory, name))})) : [];
const cryptoHash = createHash("sha256");
for (const file of cryptoFiles) cryptoHash.update(file.source);
const cryptoPath = `crypto/${cryptoHash.digest("hex").slice(0, 20)}`;

/**
 * Content Security Policy for the Grok Desktop Portable SPA.
 *
 * Hosted UI (ADR 0016) calls the loopback bridge and an optional anonymous
 * presence API on api.grokinsider.net (never credentials / bridge secrets).
 * The loopback-served SPA still ships a tighter response header from
 * the host (`connect-src 'self'`), so presence is blocked there.
 */
export function contentSecurityPolicy(development: boolean): string {
  // Loopback bridge + optional public presence host (grok-insider-web).
  const connect = development
    ? "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://api.grokinsider.net https://grokinsider.net"
    : "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://api.grokinsider.net https://grokinsider.net";
  return [
    "default-src 'self'",
    development ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" : "script-src 'self' 'wasm-unsafe-eval'",
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `${connect} https: wss:`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "sonner-external-styles",
      apply: "build",
      enforce: "pre",
      transform(source, id) {
        if (id.replaceAll("\\", "/").endsWith("/sonner/dist/index.mjs")) return externalizeSonnerStyles(source);
      },
    },
    {
      name: "grok-shell-cache",
      apply: "build",
      enforce: "post",
      generateBundle(_, bundle) {
        this.emitFile({type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(manifestSource)});
        const cryptoNames: string[] = [];
        if (process.env.VITE_REMOTE === "1" && !cryptoDirectory) throw new Error("Remote builds require FABRIALS_REMOTE_CRYPTO_DIST.");
        if (cryptoDirectory) {
          for (const {name, source} of cryptoFiles) {
            const fileName = `${cryptoPath}/${name}`;
            this.emitFile({type: "asset", fileName, source});
            cryptoNames.push(fileName);
          }
        }
        const notices = thirdPartyNotices();
        this.emitFile({type: "asset", fileName: "third-party-notices.txt", source: notices});
        const shell = ["index.html", "manifest.webmanifest", "theme-init.js", "icon-192.png", "icon-512.png", "third-party-notices.txt", ...cryptoNames, ...Object.keys(bundle).filter((name) => name.startsWith("assets/") && !name.endsWith(".map"))];
        const shareSource = shareTarget ? readFileSync(new URL("./src/services/shareInboxStore.js", import.meta.url), "utf8").replace(/^export /gm, "") : "";
        const pushSource = pushEnabled ? readFileSync(new URL("./scripts/push-worker.js", import.meta.url), "utf8").replace(/^export /gm, "") : "";
        const source = readFileSync(new URL("./scripts/service-worker.js", import.meta.url), "utf8").replace("__SHELL__", JSON.stringify(shell)).replace("__SHARE_TARGET__", shareTarget ? "enabled" : "disabled").replace("const shareInboxApi = null;", shareTarget ? `const shareInboxApi = (() => {${shareSource}\nreturn {parseSharedRequest, enqueueSharedContent};})();` : "const shareInboxApi = null;").replace("const pushWorkerApi = null;", pushEnabled ? `const pushWorkerApi = (() => {${pushSource}\nreturn {installRemotePushWorker};})();` : "const pushWorkerApi = null;");
        const entries: Array<[string, string | Uint8Array]> = shell.map(name => {
          const output = bundle[name];
          if (output) return [name, output.type === "chunk" ? output.code : output.source];
          if (name === "third-party-notices.txt") return [name, notices];
          if (name.startsWith("crypto/")) return [name, cryptoFiles.find(file => name.endsWith("/" + file.name))!.source];
          return [name, name === "manifest.webmanifest" ? JSON.stringify(manifestSource) : readFileSync(new URL(`./public/${name}`, import.meta.url))];
        });
        const bound = bindShellIdentity(entries, source);
        const index = bundle["index.html"];
        if (!index || index.type !== "asset") throw new Error("Missing HTML shell entry");
        index.source = bound.index;
        this.emitFile({type: "asset", fileName: "sw.js", source: bound.worker});
      },
    },
    {
      name: "grok-light-csp",
      transformIndexHtml: {
        order: "pre" as const,
        handler: (html) => ({
          html: process.env.VITE_REMOTE === "1" ? html.replace("<title>Grok Desktop Portable</title>", "<title>Grok Remote</title>") : html,
          tags: [
          {
            tag: "meta",
            attrs: {name: "grok-app-origin", content: applicationOrigin},
            injectTo: "head-prepend" as const,
          },
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: contentSecurityPolicy(command === "serve"),
            },
            injectTo: "head-prepend" as const,
          },
          ],
        }),
      },
    },
  ],
  base: "/",
  define: {__REMOTE_CRYPTO_URL__: JSON.stringify(`/${cryptoPath}/fabrials_remote_noise.js`), "import.meta.env.VITE_REMOTE_ORIGIN": JSON.stringify(applicationOrigin)},
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Spanreed can embed apps/web/dist via FABRIALS_AGENT_HOST_WEB_DIST.
    // Hosted demo is assembled later by scripts/prepare-public.mjs → public/demo.
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    exclude: ["dist/**", "node_modules/**"],
  },
}));
