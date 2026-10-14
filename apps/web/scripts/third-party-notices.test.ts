import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLicenseSupplements, renderThirdPartyNotices, type LicenseSupplements } from "./third-party-notices";

const directories: string[] = [];

function fixture(name = "example", license = "MIT", version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "portable-notices-"));
  directories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, license }));
  writeFileSync(join(directory, "LICENSE"), "Copyright Example\r\nPermission notice\r\n");
  return { name, license, versions: [version], paths: [directory] };
}

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function supplementFor(entry: ReturnType<typeof fixture>, extra: Partial<LicenseSupplements["entries"][number]> = {}): LicenseSupplements {
  const directory = mkdtempSync(join(tmpdir(), "portable-supplements-"));
  directories.push(directory);
  writeFileSync(join(directory, "UPSTREAM-LICENSE"), "Upstream permission notice\n");
  return {directory, entries: [{package: entry.name, version: entry.versions[0], manifestSha256: hash(join(entry.paths[0], "package.json")), texts: [{file: "UPSTREAM-LICENSE", sha256: hash(join(directory, "UPSTREAM-LICENSE")), source: "https://example.invalid/LICENSE"}], ...extra}]};
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("third-party notices", () => {
  it("preserves license and notice text, sorts package identities, and emits no filesystem paths", () => {
    const first = fixture("z-last");
    const second = fixture("a-first");
    writeFileSync(join(second.paths[0], "NOTICE.txt"), "Extra attribution\n");
    const output = renderThirdPartyNotices({ MIT: [first, second] });
    expect(output).toBe(renderThirdPartyNotices({ MIT: [second, first] }));
    expect(output.indexOf("a-first@1.2.3")).toBeLessThan(output.indexOf("z-last@1.2.3"));
    expect(output).toContain("Copyright Example\r\nPermission notice\r\n");
    expect(output).toContain("Extra attribution\n");
    expect(output).not.toContain(first.paths[0]);
  });

  it("deduplicates identical copies and refuses conflicting text for one package version", () => {
    const first = fixture();
    const second = fixture();
    const inventory = { MIT: [{ ...first, paths: [...first.paths, ...second.paths] }] };
    expect(renderThirdPartyNotices(inventory).match(/example@1\.2\.3/g)).toHaveLength(1);
    writeFileSync(join(second.paths[0], "LICENSE"), "Different attribution");
    expect(() => renderThirdPartyNotices(inventory)).toThrow("Conflicting notice copies");
  });

  it("keeps each installed version and rejects missing versions", () => {
    const first = fixture();
    const second = fixture("example", "MIT", "2.0.0");
    const entry = { ...first, versions: [...first.versions, ...second.versions], paths: [...first.paths, ...second.paths] };
    expect(renderThirdPartyNotices({ MIT: [entry] })).toContain("example@2.0.0");
    expect(() => renderThirdPartyNotices({ MIT: [{ ...entry, paths: first.paths }] })).toThrow("Missing installed version");
  });

  it("requires a review when a new license enters production", () => {
    expect(() => renderThirdPartyNotices({ "MPL-2.0": [fixture("example", "MPL-2.0")] })).toThrow("requires review");
    expect(() => renderThirdPartyNotices({})).toThrow("empty");
  });

  it("accepts the reviewed permissive licenses exactly and still rejects other expressions", () => {
    for (const license of ["Apache-2.0", "0BSD", "BSD-3-Clause", "MIT AND ISC"]) expect(renderThirdPartyNotices({ [license]: [fixture("example", license)] })).toContain(`License: ${license}`);
    for (const license of ["MIT OR GPL-3.0", "BSD-2-Clause", "Apache-2.0 WITH LLVM-exception"]) expect(() => renderThirdPartyNotices({ [license]: [fixture("example", license)] })).toThrow("requires review");
  });

  it("keeps copyright notices and prefixed license files that the old pattern dropped", () => {
    const entry = fixture();
    writeFileSync(join(entry.paths[0], "CopyrightNotice.txt"), "Copyright notice text\n");
    writeFileSync(join(entry.paths[0], "LOBE-ICONS-LICENSE"), "Icon license text\n");
    const output = renderThirdPartyNotices({ MIT: [entry] });
    expect(output).toContain("Copyright notice text");
    expect(output).toContain("Icon license text");
  });

  it("supplies a reviewed upstream license only for the exact package that lacks one", () => {
    const entry = fixture();
    rmSync(join(entry.paths[0], "LICENSE"));
    const supplements = supplementFor(entry);
    const output = renderThirdPartyNotices({ MIT: [entry] }, [], supplements);
    expect(output).toContain("supplied from https://example.invalid/LICENSE");
    expect(output).toContain("Upstream permission notice");
    writeFileSync(join(entry.paths[0], "package.json"), JSON.stringify({ name: entry.name, version: "1.2.3", license: "MIT", description: "changed" }));
    expect(() => renderThirdPartyNotices({ MIT: [entry] }, [], supplements)).toThrow("needs review");
  });

  it("refuses stale, altered or unused supplements", () => {
    const entry = fixture();
    expect(() => renderThirdPartyNotices({ MIT: [entry] }, [], supplementFor(entry))).toThrow("Stale license supplement");
    rmSync(join(entry.paths[0], "LICENSE"));
    const altered = supplementFor(entry);
    writeFileSync(join(altered.directory, "UPSTREAM-LICENSE"), "Edited\n");
    expect(() => renderThirdPartyNotices({ MIT: [entry] }, [], altered)).toThrow("text changed");
    const other = fixture("other");
    expect(() => renderThirdPartyNotices({ MIT: [other] }, [], supplementFor(entry))).toThrow("Unused license supplements");
  });

  it("includes nested packaged notices by hash and fails when one changes", () => {
    const entry = fixture();
    mkdirSync(join(entry.paths[0], "lib-vendor", "d3-ease"), { recursive: true });
    writeFileSync(join(entry.paths[0], "lib-vendor", "d3-ease", "LICENSE"), "Nested license\n");
    const supplements: LicenseSupplements = { directory: tmpdir(), entries: [{ package: entry.name, version: "1.2.3", manifestSha256: hash(join(entry.paths[0], "package.json")), packageFiles: [{ path: "lib-vendor/d3-ease/LICENSE", sha256: hash(join(entry.paths[0], "lib-vendor", "d3-ease", "LICENSE")) }] }] };
    expect(renderThirdPartyNotices({ MIT: [entry] }, [], supplements)).toContain("lib-vendor/d3-ease/LICENSE");
    writeFileSync(join(entry.paths[0], "lib-vendor", "d3-ease", "LICENSE"), "Changed\n");
    expect(() => renderThirdPartyNotices({ MIT: [entry] }, [], supplements)).toThrow("Packaged notice changed");
    expect(() => renderThirdPartyNotices({ MIT: [entry] }, [], { ...supplements, entries: [{ ...supplements.entries[0], packageFiles: [{ path: "../escape", sha256: "0" }] }] })).toThrow("Invalid supplement path");
  });

  it("ships a committed supplement manifest whose texts match their recorded hashes", () => {
    const supplements = loadLicenseSupplements();
    for (const entry of supplements.entries) for (const text of entry.texts ?? []) expect(hash(join(supplements.directory, text.file))).toBe(text.sha256);
    expect(supplements.entries.map(entry => `${entry.package}@${entry.version}`)).toContain("@fabrials/ui@0.9.0");
  });

  it("rejects identity or license mismatches in installed metadata", () => {
    const entry = fixture();
    writeFileSync(join(entry.paths[0], "package.json"), JSON.stringify({ name: entry.name, version: "1.2.3", license: "ISC" }));
    expect(() => renderThirdPartyNotices({ MIT: [entry] })).toThrow("identity differs");
  });

  it("includes runtime code and CSS from selected build dependencies and requires their notices", () => {
    const runtime = fixture();
    const builder = fixture("tailwindcss");
    writeFileSync(join(builder.paths[0], "LICENSE"), "Copyright Tailwind Labs\n");
    const manifest = join(builder.paths[0], "package.json");
    const output = renderThirdPartyNotices({ MIT: [runtime] }, [manifest]);
    expect(output).toContain("tailwindcss@1.2.3");
    expect(output).toContain("Copyright Tailwind Labs\n");
    rmSync(join(builder.paths[0], "LICENSE"));
    expect(() => renderThirdPartyNotices({ MIT: [runtime] }, [manifest])).toThrow("Missing license text");
  });

  it("fails when the full license text is absent", () => {
    const entry = fixture();
    rmSync(join(entry.paths[0], "LICENSE"));
    writeFileSync(join(entry.paths[0], "NOTICE"), "Attribution alone");
    expect(() => renderThirdPartyNotices({ MIT: [entry] })).toThrow("Missing license text");
  });

  it("does not follow license symlinks or include directories", () => {
    const entry = fixture();
    rmSync(join(entry.paths[0], "LICENSE"));
    symlinkSync("package.json", join(entry.paths[0], "LICENSE"));
    expect(() => renderThirdPartyNotices({ MIT: [entry] })).toThrow("regular file");
    rmSync(join(entry.paths[0], "LICENSE"));
    mkdirSync(join(entry.paths[0], "LICENSE"));
    expect(() => renderThirdPartyNotices({ MIT: [entry] })).toThrow("regular file");
  });

  it("rejects oversized, empty, NUL-containing and invalid UTF-8 notices", () => {
    const entry = fixture();
    for (const bytes of [Buffer.alloc(1024 * 1024 + 1, 65), Buffer.alloc(0), Buffer.from([0]), Buffer.from([0xff])]) {
      writeFileSync(join(entry.paths[0], "LICENSE"), bytes);
      expect(() => renderThirdPartyNotices({ MIT: [entry] })).toThrow();
    }
  });
});
