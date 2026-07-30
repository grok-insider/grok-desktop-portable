import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Content Security Policy for the Grok Light SPA.
 *
 * `connect-src 'self'` holds unchanged because the document and the local API
 * share one loopback origin (light ADR 0002). A hosted deployment would need
 * this widened, which is one more reason the application is never served from
 * a CDN. The host sends the same policy as a response header; this meta tag
 * keeps `vite dev` honest.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    development ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    development ? "connect-src 'self' ws://127.0.0.1:*" : "connect-src 'self'",
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
    outDir: "dist",
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
