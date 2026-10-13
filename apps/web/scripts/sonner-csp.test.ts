import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { externalizeSonnerStyles } from "./sonner-csp";

it("uses Sonner's external stylesheet without inserting a CSP-blocked style element", () => {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve("sonner"));
  const source = readFileSync(join(directory, "index.mjs"), "utf8");
  const transformed = externalizeSonnerStyles(source);
  const createElement = vi.fn();
  runInNewContext(`${transformed.slice(0, transformed.indexOf("import React"))}\n__insertCSS("body {}");`, {document: {createElement}});
  expect(createElement).not.toHaveBeenCalled();
  expect(readFileSync(require.resolve("sonner/dist/styles.css"), "utf8")).toContain("[data-sonner-toaster]");
});

it("requires review when an upstream update changes the injection contract", () => {
  expect(() => externalizeSonnerStyles("document.head.appendChild(document.createElement('style'));" )).toThrow("style injector changed");
});
