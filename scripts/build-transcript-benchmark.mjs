import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || existsSync(output)) throw new Error("provide a new, non-existing output directory");
const source = join(output, "source");
mkdirSync(source, {recursive: true});
for (const name of ["src", "experiments", "package.json", "tsconfig.json"]) cpSync(join(repository, "apps/web", name), join(source, name), {recursive: true});
symlinkSync(join(repository, "apps/web/node_modules"), join(source, "node_modules"));
cpSync(join(repository, "pnpm-lock.yaml"), join(output, "pnpm-lock.yaml"));
function files(directory, prefix = "") {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), `${name}/`) : [{name, sha256: createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex")}];
  });
}
const manifest = {createdAt: new Date().toISOString(), source: files(source), lock: createHash("sha256").update(readFileSync(join(output, "pnpm-lock.yaml"))).digest("hex"), builds: []};
writeFileSync(join(output, "source-manifest.json"), JSON.stringify(manifest, null, 2));
for (const variant of ["reference", "candidate"]) {
  const dist = join(output, variant);
  const result = spawnSync(join(source, "node_modules/.bin/vite"), ["build", "--config", "experiments/vite.config.ts"], {cwd: source, env: {...process.env, VITE_REMOTE_EXPERIMENTS: variant === "candidate" ? "transcript" : "", TRANSCRIPT_DIST: dist}, encoding: "utf8"});
  writeFileSync(join(output, `${variant}-build.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.status !== 0) throw new Error(`${variant} build failed: ${result.status}`);
  manifest.builds.push({variant, files: files(dist)});
}
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify({output, builds: manifest.builds.map(({variant, files}) => ({variant, files: files.length}))}) + "\n");
