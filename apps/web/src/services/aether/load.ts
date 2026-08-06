/**
 * Load version-pinned Aether wasm from same-origin public assets.
 * Fail closed: callers treat null as “hide avatar”.
 */

import { pathBase } from "../routes";
import type { WasmModule } from "./persona";

export type AetherManifest = {
  id?: string;
  modelPath?: string;
  distributionAllowed?: boolean;
  notes?: string;
};

export type LoadedAether = {
  wasm: WasmModule;
  /** Absolute URL used for the wasm binary (debug). */
  wasmUrl: string;
};

/**
 * Absolute same-origin URL for a static file under Vite `public/`.
 * Uses origin + pathBase (not document-relative `./`) so session routes like
 * `/session/…` do not break asset paths when Vite `base` is `./`.
 */
export function assetUrl(rel: string, query?: string): string {
  const path = rel.replace(/^\//, "");
  const prefix = pathBase(); // "" or "/demo"
  const joined = `${prefix}/${path}`.replace(/\/{2,}/g, "/");
  const url = new URL(joined, window.location.origin);
  if (query) {
    url.search = query.startsWith("?") ? query.slice(1) : query;
  }
  return url.href;
}

/** Cache-bust runtime wasm when VERSION pin changes (sync-aether-wasm.sh). */
async function runtimeCacheKey(): Promise<string> {
  try {
    const res = await fetch(assetUrl("assets/aether/VERSION"), {
      cache: "no-cache",
    });
    if (!res.ok) return `t=${Date.now()}`;
    const text = (await res.text()).trim().replace(/[^\w.+\-]/g, "") || "v";
    return `v=${encodeURIComponent(text)}`;
  } catch {
    return `t=${Date.now()}`;
  }
}

type AetherGlue = {
  default: (opts?: { module_or_path?: string | URL }) => Promise<unknown>;
  WasmSession: new (maxFps: number) => unknown;
  protocolVersion: () => number;
};

/**
 * Dynamically import wasm-bindgen ESM from public/assets and initialise.
 */
export async function loadAetherWasm(): Promise<LoadedAether | null> {
  const bust = await runtimeCacheKey();
  const glueUrl = assetUrl("assets/aether/runtime/aether.js", bust);
  const wasmUrl = assetUrl("assets/aether/runtime/aether_bg.wasm", bust);
  try {
    const glue = (await import(
      /* @vite-ignore */ glueUrl
    )) as AetherGlue;
    await glue.default({ module_or_path: wasmUrl });
    if (typeof glue.WasmSession !== "function") {
      return null;
    }
    return {
      wasm: {
        WasmSession: glue.WasmSession as WasmModule["WasmSession"],
        protocolVersion: glue.protocolVersion,
      },
      wasmUrl,
    };
  } catch (err) {
    // jsdom / Node cannot dynamic-import SPA http(s) glue URLs; fail closed.
    // Log only under Vite dev so unit suites stay quiet.
    if (import.meta.env.DEV) {
      console.warn("[aether] wasm load failed", err);
    }
    return null;
  }
}

export async function loadAetherManifest(): Promise<AetherManifest | null> {
  try {
    const res = await fetch(assetUrl("assets/aether/manifest.json"), {
      cache: "no-cache",
    });
    if (!res.ok) return null;
    return (await res.json()) as AetherManifest;
  } catch {
    return null;
  }
}

/**
 * Prefer packaged VRM when manifest allows; otherwise null (caller uses fixture).
 */
export async function loadPackagedVrmBytes(): Promise<Uint8Array | null> {
  const manifest = await loadAetherManifest();
  const modelPath = manifest?.modelPath ?? "avatar.vrm";
  if (manifest && manifest.distributionAllowed === false) {
    // Explicitly not cleared for ship — use fixture.
    return null;
  }
  try {
    const res = await fetch(assetUrl(`assets/aether/${modelPath}`), {
      cache: "force-cache",
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 64) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}
