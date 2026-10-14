import {expect, it} from "vitest";
import {applicationEntry, deploymentOrigin} from "./deploymentOrigin";
import {isHostedDocumentOrigin, isPrivateDocumentOrigin} from "./client";
import origins from "./deploymentOrigins.json";

it("preserves the production default and enables only the exact explicit qualification origin", () => {
  expect(deploymentOrigin()).toBe(origins.production);
  expect(deploymentOrigin(origins.qualification)).toBe(origins.qualification);
  for (const value of ["http://grok.fabrials.com", "https://grok.fabrials.com/", "https://grok.fabrials.com:443", "https://grok.fabrials.com.evil.invalid", "https://other.fabrials.com", origins.legacyAlias, ""]) expect(() => deploymentOrigin(value)).toThrow();
});

it("selects direct entry before pairing and after reload on the configured website", () => {
  for (const origin of [origins.production, origins.qualification]) {
    expect(applicationEntry(origin, "", origin)).toBe("remote");
    expect(applicationEntry(origin, "#directPair=synthetic", origin)).toBe("remote");
    expect(applicationEntry(origin, "#pair=synthetic", origin)).toBe("local");
    expect(isHostedDocumentOrigin(origin)).toBe(true);
    expect(isPrivateDocumentOrigin(origin)).toBe(false);
  }
});

it("keeps the legacy alias in production and blocks cross-environment shells without forwarding pairing fragments", () => {
  expect(applicationEntry(origins.legacyAlias, "#directPair=secret", origins.production)).toBe("redirect");
  expect(applicationEntry(origins.legacyAlias, "#directPair=secret", origins.qualification)).toBe("blocked");
  expect(applicationEntry(origins.production, "#directPair=secret", origins.qualification)).toBe("blocked");
  expect(applicationEntry(origins.qualification, "#directPair=secret", origins.production)).toBe("blocked");
  expect(applicationEntry("https://station.private.test", "", origins.qualification)).toBe("local");
  expect(applicationEntry("http://127.0.0.1:18736", "#directPair=synthetic", origins.qualification)).toBe("remote");
});
