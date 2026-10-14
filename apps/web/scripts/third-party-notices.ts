import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const allowedLicenses = new Set(["MIT", "ISC", "OFL-1.1", "Apache-2.0", "0BSD", "BSD-3-Clause", "MIT AND ISC"]);
const noticeName = /^((licen[cs]e|copying|notice|copyright)([.-].+)?|copyrightnotice\.txt|[a-z0-9]+(-[a-z0-9]+)*-licen[cs]e(\.[a-z]+)?)$/i;
const licenseName = /^((licen[cs]e|copying)([.-].+)?)$/i;
const scriptFile = (name: string) => fileURLToPath(new URL(name, import.meta.url).href);

type SupplementText = { file: string; sha256: string; source: string; note?: string };
type Supplement = { package: string; version: string; manifestSha256: string; texts?: SupplementText[]; packageFiles?: { path: string; sha256: string }[] };
export type LicenseSupplements = { directory: string; entries: Supplement[] };

export function loadLicenseSupplements(): LicenseSupplements {
  const document = object(JSON.parse(readRegularFile(scriptFile("./license-supplements.json")).toString("utf8")));
  if (document.schema !== 1 || !Array.isArray(document.entries)) throw new Error("Invalid license supplements");
  return { directory: scriptFile("./license-supplements/"), entries: document.entries as Supplement[] };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativeFile(base: string, relative: string): string {
  if (!/^[A-Za-z0-9@._-]+(\/[A-Za-z0-9@._-]+)*$/.test(relative) || relative.split("/").includes("..")) throw new Error("Invalid supplement path");
  return join(base, relative);
}
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

export function renderThirdPartyNotices(inventory: unknown, bundledBuildManifests: string[] = [], supplements: LicenseSupplements = { directory: "", entries: [] }): string {
  const pendingSupplements = new Map(supplements.entries.map(entry => [`${entry.package}@${entry.version}`, entry]));
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
        const identity = `${record.name}@${manifest.version}`;
        const supplement = pendingSupplements.get(identity);
        if (supplement && supplement.manifestSha256 !== sha256(readRegularFile(join(directory, "package.json")))) {
          throw new Error(`License supplement needs review for ${identity}`);
        }
        const files = readdirSync(directory).filter(name => noticeName.test(name)).sort();
        const ownLicense = files.some(name => licenseName.test(name));
        if (ownLicense && supplement?.texts?.length) throw new Error(`Stale license supplement for ${identity}`);
        if (!ownLicense && !supplement?.texts?.length) {
          throw new Error(`Missing license text for ${identity}`);
        }
        const packaged = files.map(name => {
          const bytes = readRegularFile(join(directory, name));
          return `${name}\nSHA-256: ${sha256(bytes)}\n\n${bytes.toString("utf8")}\n`;
        });
        const nested = (supplement?.packageFiles ?? []).map(file => {
          const bytes = readRegularFile(relativeFile(directory, file.path));
          if (sha256(bytes) !== file.sha256) throw new Error(`Packaged notice changed for ${identity}: ${file.path}`);
          return `${file.path}\nSHA-256: ${file.sha256}\n\n${bytes.toString("utf8")}\n`;
        });
        const supplied = (supplement?.texts ?? []).map(text => {
          const bytes = readRegularFile(relativeFile(supplements.directory, text.file));
          if (sha256(bytes) !== text.sha256) throw new Error(`License supplement text changed for ${identity}`);
          return `${text.file.split("/").pop()} (supplied from ${text.source}${text.note ? `; ${text.note}` : ""})\nSHA-256: ${text.sha256}\n\n${bytes.toString("utf8")}\n`;
        });
        pendingSupplements.delete(identity);
        const content = [...packaged, ...nested, ...supplied].join("\n");
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
  if (pendingSupplements.size) throw new Error(`Unused license supplements: ${[...pendingSupplements.keys()].sort().join(", ")}`);
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
  return renderThirdPartyNotices(JSON.parse(inventory), ["tailwindcss", "vite"].map(name => require.resolve(`${name}/package.json`)), loadLicenseSupplements());
}
