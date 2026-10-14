import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

export const origins = JSON.parse(readFileSync(new URL("../apps/web/src/services/deploymentOrigins.json", import.meta.url), "utf8"));

export function deploymentOrigin(value = origins.production) {
  assert(value === origins.production || value === origins.qualification, "Application origin must be https://desktop.grok.me or https://grok.fabrials.com exactly");
  return value;
}

export function buildOrigin(html) {
  const matches = [...html.matchAll(/<meta name="grok-app-origin" content="([^"]+)">/g)];
  assert.equal(matches.length, 1, "Build requires one application origin");
  return deploymentOrigin(matches[0][1]);
}

export function deploymentConfigPath(origin) {
  return deploymentOrigin(origin) === origins.production ? "deploy/remote/build-output.json" : "deploy/remote/qualification-build-output.json";
}
