import { handler as baseHandler } from "../server.mjs";

/** Run the demo host handler with a fixed pathname (Vercel route). */
export function withPath(pathname) {
  return async function vercelRoute(req, res) {
    const url = req.url || "/";
    const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    // Preserve body stream; only rewrite path Vercel saw as /api/xxx
    Object.defineProperty(req, "url", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: pathname + q,
    });
    return baseHandler(req, res);
  };
}
