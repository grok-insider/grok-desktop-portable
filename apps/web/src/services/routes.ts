/**
 * Client-side URL model for Grok Light (opaque ids only).
 *
 * The SPA is still one origin served by the host; the path only names *which*
 * open surface to show so refresh and share work. Never a filesystem path.
 */

export type LightRoute =
  | { kind: "home" }
  | { kind: "session"; sessionId: string }
  | { kind: "setup" };

/** Parse `location.pathname` into a Light route. Unknown paths → home. */
export function parsePath(pathname: string): LightRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
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

/** Path for a route (no origin, no query). */
export function pathFor(route: LightRoute): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "setup":
      return "/setup";
    case "session":
      return `/s/${route.sessionId}`;
  }
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
