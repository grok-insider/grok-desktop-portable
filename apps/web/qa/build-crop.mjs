import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {isAbsolute, join} from "node:path";
import {build} from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const output = process.argv[2];
if (!output || !isAbsolute(output)) throw new Error("Provide a new absolute output directory for synthetic crop qualification.");
await mkdir(output);
const root = fileURLToPath(new URL(".", import.meta.url));
await build({configFile: false, root, base: "/crop-qa/", publicDir: false, plugins: [react(), tailwind()], build: {outDir: output, emptyOutDir: false, assetsInlineLimit: 0, rollupOptions: {input: join(root, "crop.html")}}});
process.stdout.write(JSON.stringify({output, entry: "/crop-qa/crop.html", syntheticCapabilities: ["image attachment"], hostOperationsAllowed: false}) + "\n");
