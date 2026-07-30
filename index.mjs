export { default, handler, createServer } from "./server.mjs";
import { createServer } from "./server.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain || process.env.FORCE_LISTEN === "1") {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`grok-desktop-portable demo host on http://${host}:${port}`);
  });
}
