import {createHash} from "node:crypto";

export function bindShellIdentity(files: Array<[string, string | Uint8Array]>, worker: string) {
  const index = files.find(([name]) => name === "index.html")?.[1];
  if (typeof index !== "string" || !index.includes("</head>") || index.includes('name="grok-shell-build"')) throw new Error("Shell identity requires an unmarked HTML entry");
  if (worker.split("__CACHE__").length !== 2) throw new Error("Shell identity requires one worker cache placeholder");
  const hash = createHash("sha256");
  for (const [name, value] of [...files, ["sw.js", worker] as [string, string]].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    hash.update(JSON.stringify([name, bytes.byteLength]) + "\0").update(bytes);
  }
  const id = hash.digest("hex");
  return {id, index: index.replace("</head>", `<meta name="grok-shell-build" content="${id}"></head>`), worker: worker.replace("__CACHE__", JSON.stringify(`grok-shell-${id.slice(0, 16)}`))};
}
