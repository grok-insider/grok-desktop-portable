import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  base: "./",
  build: {rollupOptions: {input: resolve("experiments/transcript.html")}, outDir: process.env.TRANSCRIPT_DIST, emptyOutDir: false},
});
