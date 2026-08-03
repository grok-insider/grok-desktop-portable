import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Content Security Policy for the Grok Desktop Portable SPA.
 *
 * Hosted UI (ADR 0016) calls the loopback bridge and an optional anonymous
 * presence API on api.grokinsider.net (never credentials / bridge secrets).
 * The loopback-served SPA still ships a tighter response header from
 * grok-bridge (`connect-src 'self'`), so presence is blocked there.
 */
export function contentSecurityPolicy(development: boolean): string {
  // Loopback bridge + optional public presence host (grok-insider-web).
  const connect = development
    ? "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://api.grokinsider.net https://grokinsider.net"
    : "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://api.grokinsider.net https://grokinsider.net";
  return [
    "default-src 'self'",
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    connect,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "grok-light-csp",
      transformIndexHtml: {
        order: "pre" as const,
        handler: () => [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: contentSecurityPolicy(command === "serve"),
            },
            injectTo: "head-prepend" as const,
          },
        ],
      },
    },
  ],
  // Relative, because the host serves the bundle from its own origin.
  base: "./",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Product bridge embeds apps/web/dist (see crates/grok-bridge/build.rs).
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
