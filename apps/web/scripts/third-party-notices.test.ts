import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderThirdPartyNotices } from "./third-party-notices";

const directories: string[] = [];

function fixture(name = "example", license = "MIT", version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "portable-notices-"));
  directories.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version, license }));
  writeFileSync(join(directory, "LICENSE"), "Copyright Example\r\nPermission notice\r\n");
  return { name, license, versions: [version], paths: [directory] };
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
