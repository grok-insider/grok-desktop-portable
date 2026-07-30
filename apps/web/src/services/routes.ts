/**
 * Client-side URL model for Grok Desktop Portable (opaque ids only).
 *
 * The SPA is one origin served by the host; the path only names *which*
 * open surface to show so refresh and share work. Never a filesystem path.
 *
 * Hosted demo mounts under `/demo` (meta `grok-path-base`); the product bridge
 * serves at the origin root with no base prefix.
 */

export type LightRoute =
  | { kind: "home" }
  | { kind: "session"; sessionId: string }
  | { kind: "setup" };

/**
 * Path prefix where the SPA is mounted, without trailing slash.
 * Empty string at product root; `/demo` on the hosted demo surface.
 */
export function pathBase(): string {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="grok-path-base"]');
    const content = meta?.getAttribute("content")?.trim();
    if (content) {
      return content.replace(/\/+$/, "") || "";
    }
  }
  // Vite BASE_URL is `./` for the bridge embed and absolute when configured.
  try {
    const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } })
      .env?.BASE_URL;
    if (viteBase && viteBase !== "./" && viteBase !== "/") {
      return viteBase.replace(/\/+$/, "");
    }
  } catch {
    /* non-Vite test host */
  }
  return "";
}

function stripBase(pathname: string): string {
  const base = pathBase();
  let path = pathname || "/";
  if (base && (path === base || path.startsWith(`${base}/`))) {
    path = path.slice(base.length) || "/";
  }
  return path.replace(/\/+$/, "") || "/";
}

/** Parse `location.pathname` into a Light route. Unknown paths → home. */
export function parsePath(pathname: string): LightRoute {
  const path = stripBase(pathname);
  if (path === "/" || path === "") {
    return { kind: "home" };
  }
  if (path === "/setup") {
    return { kind: "setup" };
  }
  const session = /^\/s\/([A-Za-z0-9._-]+)$/.exec(path);
  if (session?.[1]) {
    return { kind: "session", sessionId: session[1] };
  }
  return { kind: "home" };
}

/** Path for a route (no origin, no query), including demo base when set. */
export function pathFor(route: LightRoute): string {
  const base = pathBase();
  let rest: string;
  switch (route.kind) {
    case "home":
      rest = "/";
      break;
    case "setup":
      rest = "/setup";
      break;
    case "session":
      rest = `/s/${route.sessionId}`;
      break;
  }
  if (!base) {
    return rest;
  }
  if (rest === "/") {
    return `${base}/`;
  }
  return `${base}${rest}`;
}

/**
 * Sync the address bar when the active conversation changes.
 *
 * Uses `replaceState` when only refining the same surface (avoids flooding
 * history on every token); `pushState` when moving home ↔ session.
 */
export function syncUrl(
  route: LightRoute,
  mode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined") {
    return;
  }
  const next = pathFor(route);
  if (window.location.pathname === next) {
    return;
  }
  const url = next + window.location.search + window.location.hash;
  if (mode === "replace") {
    window.history.replaceState({ light: route }, "", url);
  } else {
    window.history.pushState({ light: route }, "", url);
  }
}
