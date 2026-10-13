import {expect, it} from "vitest";
import {bindShellIdentity} from "./shell-identity";

const files: Array<[string, string]> = [["index.html", "<html><head></head><body></body></html>"], ["assets/app.js", "app"], ["assets/app.css", "body{}"]];
const worker = "const CACHE = __CACHE__;";

it("binds rollback HTML to its own shell even if only CSS or worker changes", () => {
  const previous = bindShellIdentity(files, worker);
  const css = bindShellIdentity(files.map(([name, bytes]) => [name, name.endsWith(".css") ? "body{color:inherit}" : bytes]), worker);
  const serviceWorker = bindShellIdentity(files, worker + "const changed = true;");
  expect(new Set([previous.id, css.id, serviceWorker.id]).size).toBe(3);
  expect(previous.index).toContain(`content="${previous.id}"`);
  expect(css.index).not.toContain(previous.id);
  expect(serviceWorker.index).not.toContain(previous.id);
  expect(previous.worker).toContain(previous.id.slice(0, 16));
  expect(bindShellIdentity([...files].reverse(), worker)).toEqual(previous);
});

it("rejects a supplied marker and binds raw bytes without ambiguous concatenation", () => {
  const previous = bindShellIdentity(files, worker);
  expect(() => bindShellIdentity([["index.html", previous.index]], worker)).toThrow("unmarked");
  expect(() => bindShellIdentity(files, "no placeholder")).toThrow("placeholder");
  expect(bindShellIdentity([...files, ["assets/a", "xassets/b\0y"]], worker).id).not.toEqual(bindShellIdentity([...files, ["assets/a", "x"], ["assets/b", "y"]], worker).id);
});
