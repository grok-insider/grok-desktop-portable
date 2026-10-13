import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {configurable: true, writable: true, value: new IDBFactory()});
  Object.defineProperty(globalThis, "IDBKeyRange", {configurable: true, writable: true, value: IDBKeyRange});
});

/* jsdom does not implement scrollIntoView; the transcript pins to the end. */
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/* jsdom lacks matchMedia; reduced-motion checks read it. */
if (typeof globalThis.matchMedia === "undefined") {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

afterEach(cleanup);
