import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = process.argv[2];
const entry = process.argv[3] ?? "fixture.tsx";
if (!["fixture.tsx", "push.tsx"].includes(entry)) throw new Error("Select the ordinary or push synthetic fixture.");
if (!directory?.startsWith("/")) throw new Error("Pass an absolute output directory for the synthetic browser fixture.");
await build({configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), define: {"process.env.NODE_ENV": JSON.stringify("production")}, plugins: [react(), tailwind()], build: {outDir: directory, emptyOutDir: true, lib: {entry: fileURLToPath(new URL(entry, import.meta.url)), name: "RemoteFixture", formats: ["iife"], fileName: "fixture", cssFileName: "fixture"}}});
const script = await readFile(`${directory}/fixture.iife.js`, "utf8");
const style = await readFile(`${directory}/fixture.css`, "utf8");
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const viewport = source.match(/<meta name="viewport"[^>]+>/)?.[0];
if (!viewport) throw new Error("The application viewport must be present in the fixture.");
await writeFile(`${directory}/index.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8">${viewport}<title>Grok Remote synthetic QA</title><style>${style}</style></head><body><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`);
