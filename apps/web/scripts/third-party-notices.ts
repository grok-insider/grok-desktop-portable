import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowedLicenses = new Set(["MIT", "ISC", "OFL-1.1"]);
const noticeName = /^(licen[cs]e|copying|notice|copyright)([.-].+)?$/i;
const maximumFileBytes = 1024 * 1024;
const maximumOutputBytes = 4 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid production license inventory");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" || !item)) {
    throw new Error("Incomplete production license inventory");
  }
  return value;
}

function readRegularFile(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumFileBytes) {
    throw new Error("A package notice must be a bounded regular file");
  }
  const bytes = readFileSync(path);
  if (bytes.length > maximumFileBytes || !bytes.length || bytes.includes(0)) {
    throw new Error("A package notice must contain bounded UTF-8 text");
  }
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new Error("A package notice must contain valid UTF-8 text");
  }
  return bytes;
}

export function renderThirdPartyNotices(inventory: unknown, bundledBuildManifests: string[] = []): string {
  const catalog = { ...object(inventory) };
  if (!Object.keys(catalog).length) throw new Error("Production license inventory is empty");
  for (const path of bundledBuildManifests) {
    const manifest = object(JSON.parse(readRegularFile(path).toString("utf8")));
    if (typeof manifest.license !== "string") throw new Error("Bundled build dependency has no license");
    const existing = catalog[manifest.license] ?? [];
    if (!Array.isArray(existing)) throw new Error("Invalid production license group");
    catalog[manifest.license] = [...existing, { name: manifest.name, license: manifest.license, versions: [manifest.version], paths: [dirname(path)] }];
  }
  const sections = new Map<string, string>();
  for (const [license, entries] of Object.entries(catalog)) {
    if (!allowedLicenses.has(license)) throw new Error(`Production license requires review: ${license}`);
    if (!Array.isArray(entries) || !entries.length) throw new Error("Empty production license group");
    for (const entry of entries) {
      const record = object(entry);
      if (typeof record.name !== "string" || !/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(record.name) || record.license !== license) {
        throw new Error("Invalid package identity in production license inventory");
      }
      const versions = new Set(strings(record.versions));
      const foundVersions = new Set<string>();
      for (const path of strings(record.paths)) {
        const directory = realpathSync(path);
        const manifest = object(JSON.parse(readRegularFile(join(directory, "package.json")).toString("utf8")));
        if (manifest.name !== record.name || typeof manifest.version !== "string" || !versions.has(manifest.version) || manifest.license !== license) {
          throw new Error(`Installed license identity differs for ${record.name}`);
        }
        foundVersions.add(manifest.version);
        const files = readdirSync(directory).filter(name => noticeName.test(name)).sort();
        if (!files.some(name => /^(licen[cs]e|copying)([.-].+)?$/i.test(name))) {
          throw new Error(`Missing license text for ${record.name}@${manifest.version}`);
        }
        const content = files.map(name => {
          const bytes = readRegularFile(join(directory, name));
          const hash = createHash("sha256").update(bytes).digest("hex");
          return `${name}\nSHA-256: ${hash}\n\n${bytes.toString("utf8")}\n`;
        }).join("\n");
        const identity = `${record.name}@${manifest.version}`;
        const section = `${identity}\nLicense: ${license}\n\n${content}`;
        const previous = sections.get(identity);
        if (previous !== undefined && previous !== section) throw new Error(`Conflicting notice copies for ${identity}`);
        sections.set(identity, section);
      }
      if ([...versions].some(version => !foundVersions.has(version))) {
        throw new Error(`Missing installed version for ${record.name}`);
      }
    }
  }
  if (!sections.size) throw new Error("Production license inventory is empty");
  const output = "Third-party notices\n\nLicense and notice texts from installed production dependencies and build dependencies that supply runtime code or styles.\nThe inventory may include dependencies removed from the emitted output by bundling.\n\n"
    + [...sections.keys()].sort().map(key => sections.get(key)).join("\n------------------------------------------------------------\n\n");
  if (Buffer.byteLength(output) > maximumOutputBytes) throw new Error("Production notices exceed the size limit");
  return output;
}

export function thirdPartyNotices(): string {
  const inventory = execFileSync("corepack", ["pnpm", "licenses", "list", "--prod", "--json"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: maximumOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const require = createRequire(import.meta.url);
  return renderThirdPartyNotices(JSON.parse(inventory), ["tailwindcss", "vite"].map(name => require.resolve(`${name}/package.json`)));
}
