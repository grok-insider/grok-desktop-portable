/**
 * Deployable demo host for Grok Desktop Portable.
 *
 * Real product: local Rust `grok-bridge` (loopback + pairing).
 * This Node entrypoint is for Vercel / live preview:
 *   - serves public/ (fallback: apps/web/dist)
 *   - implements enough of light.local.v1 for a playable demo
 *   - binds 0.0.0.0:$PORT (default 8080)
 *
 * Not a security boundary. See docs/hosted-demo.md.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = (() => {
  const pub = path.join(ROOT, "public");
  const legacy = path.join(ROOT, "apps", "web", "dist");
  if (fs.existsSync(path.join(pub, "index.html"))) return pub;
  return legacy;
})();
const PORT = Number(process.env.PORT || process.env.PREVIEW_PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PROTOCOL_VERSION = 2;
const WS_SUBPROTOCOL = "light.local.v1";
const CSRF_HEADER = "x-grok-light-csrf";
const SESSION_COOKIE = "gl_session";

function hex(n = 32) {
  return crypto.randomBytes(n).toString("hex");
}

const state = {
  pairs: new Map(),
  eventSeq: 0,
  sockets: new Set(),
  sessions: new Map(),
  nextSession: 1,
};

const DEMO_WORKSPACE = {
  id: "ws-demo",
  displayName: "demo-project",
  available: true,
};

const DEMO_MODELS = [
  {
    id: "grok-4",
    displayName: "Grok 4",
    default: true,
    reasoningEfforts: ["low", "high"],
  },
  {
    id: "grok-3",
    displayName: "Grok 3",
    default: false,
    reasoningEfforts: [],
  },
];

function workspacesPayload() {
  const openSessions = [...state.sessions.values()].map((s) => ({
    sessionId: s.id,
    workspaceId: s.workspaceId,
    workspaceName: DEMO_WORKSPACE.displayName,
    running: s.state === "running",
    openedAtMs: s.updatedAt,
    queued: [],
    awaitingDecision: false,
  }));
  return {
    outcome: "workspaces",
    workspaces: [DEMO_WORKSPACE],
    projects: [
      {
        projectId: "proj-demo",
        displayName: "demo-project",
        workspaceId: "ws-demo",
        sessionCount: openSessions.length,
        lastActiveAt: new Date().toISOString(),
        available: true,
      },
    ],
    openSessions,
    pendingReviews: [],
  };
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function setSessionCookie(res, token) {
  const secure =
    process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}`,
  );
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function broadcast(event) {
  state.eventSeq += 1;
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    eventSequence: state.eventSeq,
    event,
  };
  const raw = JSON.stringify(envelope);
  for (const ws of state.sockets) {
    try {
      ws.send(raw);
    } catch {
      state.sockets.delete(ws);
    }
  }
  return envelope;
}

function handleCommand(operation) {
  switch (operation?.kind) {
    case "bootstrap":
    case "listWorkspaces":
      return workspacesPayload();
    case "getHostStatus":
      return {
        outcome: "hostStatus",
        state: "ready",
        cliQualified: true,
        cliVersion: "0.2.120",
        minCliVersion: "0.2.115",
      };
    case "listModels":
      return { outcome: "models", models: DEMO_MODELS };
    case "listTools":
      return {
        outcome: "tools",
        tools: [
          { name: "read", kind: "builtin", scope: "global", enabled: true },
          { name: "bash", kind: "builtin", scope: "global", enabled: true },
        ],
      };
    case "listContext":
      return {
        outcome: "context",
        entries: [
          { path: "README.md", kind: "file" },
          { path: "apps/web/src/App.tsx", kind: "file" },
          { path: "crates/grok-bridge", kind: "directory" },
        ],
      };
    case "listSessions":
      return {
        outcome: "sessions",
        sessions: [...state.sessions.values()]
          .filter((s) => s.workspaceId === operation.workspaceId)
          .map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: new Date(s.updatedAt).toISOString(),
            messageCount: s.messages.length,
          })),
      };
    case "createSession":
    case "openProject": {
      const id = `sess-${state.nextSession++}`;
      const session = {
        id,
        title: "New session",
        workspaceId:
          operation.workspaceId || operation.projectId || DEMO_WORKSPACE.id,
        state: "idle",
        updatedAt: Date.now(),
        messages: [],
        modelId: "grok-4",
      };
      state.sessions.set(id, session);
      setTimeout(() => {
        broadcast({
          kind: "sessionSnapshot",
          sessionId: id,
          messages: [],
          tools: [],
        });
        broadcast({ kind: "sessionStatus", sessionId: id, state: "idle" });
        broadcast({
          kind: "commandsUpdated",
          sessionId: id,
          commands: [
            { name: "help", description: "Show available commands" },
            { name: "clear", description: "Clear the transcript" },
          ],
        });
      }, 30);
      return { outcome: "sessionCreated", sessionId: id };
    }
    case "loadSession": {
      const s = state.sessions.get(operation.sessionId);
      if (!s) return { outcome: "acknowledged" };
      setTimeout(() => {
        broadcast({
          kind: "sessionSnapshot",
          sessionId: s.id,
          messages: s.messages,
          tools: [],
        });
        broadcast({ kind: "sessionStatus", sessionId: s.id, state: s.state });
      }, 20);
      return { outcome: "acknowledged" };
    }
    case "prompt":
    case "sendNow": {
      const s = state.sessions.get(operation.sessionId);
      if (!s) return { outcome: "acknowledged" };
      const text = String(operation.text || "");
      s.messages.push({ role: "user", text, seq: s.messages.length + 1 });
      s.state = "running";
      s.updatedAt = Date.now();
      if (!s.title || s.title === "New session") {
        s.title = text.slice(0, 48) || "New session";
      }
      const reply = operation.bash
        ? "```\n$ " + text + "\n(demo host — no real shell)\n```"
        : `**Demo host**\n\nYou said:\n\n> ${text}\n\nThis is the hosted preview of **Grok Desktop Portable**. On your machine, \`grok-bridge\` drives your real Grok Build CLI over loopback — this deploy is a UI/demo surface only.`;

      setTimeout(() => {
        broadcast({ kind: "promptSent", sessionId: s.id, text });
        broadcast({ kind: "sessionStatus", sessionId: s.id, state: "running" });
        const chunks = reply.match(/.{1,48}/gs) || [reply];
        let i = 0;
        const tick = () => {
          if (i < chunks.length) {
            broadcast({
              kind: "messageDelta",
              sessionId: s.id,
              text: chunks[i++],
            });
            setTimeout(tick, 20);
          } else {
            s.messages.push({
              role: "assistant",
              text: reply,
              seq: s.messages.length + 1,
            });
            s.state = "idle";
            broadcast({ kind: "sessionStatus", sessionId: s.id, state: "idle" });
          }
        };
        setTimeout(tick, 60);
      }, 40);
      return { outcome: "promptAccepted" };
    }
    case "cancelTurn": {
      const s = state.sessions.get(operation.sessionId);
      if (s) s.state = "idle";
      broadcast({
        kind: "sessionStatus",
        sessionId: operation.sessionId,
        state: "idle",
      });
      return { outcome: "cancelled" };
    }
    case "closeSession": {
      state.sessions.delete(operation.sessionId);
      return { outcome: "closed" };
    }
    case "setSessionModel": {
      const s = state.sessions.get(operation.sessionId);
      if (s) s.modelId = operation.modelId;
      return {
        outcome: "modelSet",
        sessionId: operation.sessionId,
        modelId: operation.modelId,
      };
    }
    case "getSessionInspector":
      return {
        outcome: "sessionInspector",
        inspector: {
          sessionId: operation.sessionId,
          modelDisplayName: "Grok 4",
          turns: state.sessions.get(operation.sessionId)?.messages.length || 0,
          turnIndex: 0,
          availableChangeModes: ["git", "lastTurn"],
        },
      };
    case "getSessionChanges":
      return {
        outcome: "sessionChanges",
        sessionId: operation.sessionId,
        mode: operation.mode,
        changes: {
          sessionId: operation.sessionId,
          mode: operation.mode,
          comparison: "HEAD to working tree",
          files: [],
          additions: 0,
          deletions: 0,
          complete: true,
          omittedFiles: 0,
        },
      };
    case "openWorkspacePicker":
      return { outcome: "pickerOpened" };
    case "diagnoseSession":
      return {
        outcome: "sessionDiagnosis",
        diagnosis: {
          sessionId: operation.sessionId,
          status: "ok",
          report: {
            repaired: false,
            dryRun: true,
            resident: true,
            duplicatesRemoved: 0,
            syntheticResultsInserted: 0,
            strippedToolResultIds: [],
          },
        },
      };
    case "repairSession":
      return {
        outcome: "sessionRepair",
        report: {
          repaired: false,
          dryRun: !!operation.dryRun,
          resident: true,
          duplicatesRemoved: 0,
          syntheticResultsInserted: 0,
          strippedToolResultIds: [],
        },
      };
    default:
      return { outcome: "acknowledged" };
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

function securityHeaders(isHtml) {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors *",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": isHtml
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  };
}

function sendIndex(req, res) {
  const index = path.join(DIST, "index.html");
  if (!fs.existsSync(index)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("SPA not built. Run: pnpm build");
    return;
  }
  let html = fs.readFileSync(index, "utf8");
  html = html.replace(
    /http-equiv=(["'])Content-Security-Policy\1[^>]*content=(["'])([\s\S]*?)\2/gi,
    (_full, q1, q2) => {
      const c =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors *";
      return `http-equiv=${q1}Content-Security-Policy${q1} content=${q2}${c.replace(/'/g, "&#39;")}${q2}`;
    },
  );
  if (!html.includes("data-demo-banner")) {
    const banner = `<div data-demo-banner style="position:fixed;z-index:9999;left:0;right:0;top:0;padding:6px 12px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;background:#1a1a1f;color:#c8c8d0;border-bottom:1px solid #2a2a32;text-align:center">Hosted demo of Grok Desktop Portable Work UI — real CLI sessions need the local bridge on your machine.</div><style data-demo-banner>body{padding-top:32px !important}</style>`;
    html = html.replace("<body>", `<body>${banner}`);
  }
  const inject = `<script data-demo-pair>(function(){try{if(location.hash.indexOf("#pair=")===0)history.replaceState(null,"",location.pathname+location.search);}catch(e){}})();</script>`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${inject}</head>`);
  }

  // Auto-pair so resume works without a terminal ceremony.
  let token = getCookie(req, SESSION_COOKIE);
  if (!token || !state.pairs.has(token)) {
    token = hex(32);
    state.pairs.set(token, {
      csrf: hex(32),
      sessionId: `bs-${state.pairs.size + 1}`,
    });
    setSessionCookie(res, token);
  }

  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buf.length,
    ...securityHeaders(true),
  });
  res.end(buf);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") return sendIndex(req, res);
  const filePath = path.normalize(path.join(DIST, rel));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (!path.extname(rel)) return sendIndex(req, res);
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (filePath.endsWith("index.html")) return sendIndex(req, res);
  const ext = path.extname(filePath);
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    ...securityHeaders(false),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handler(req, res) {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`,
  );
  const p = url.pathname;

  if (req.method === "GET" && p === "/healthz") {
    return json(res, 200, { ok: true, mode: "demo-host" });
  }

  if (req.method === "POST" && p === "/pair") {
    await readBody(req);
    const token = hex(32);
    const csrf = hex(32);
    const sessionId = `bs-${state.pairs.size + 1}`;
    state.pairs.set(token, { csrf, sessionId });
    setSessionCookie(res, token);
    return json(res, 200, {
      sessionId,
      csrfToken: csrf,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  if (req.method === "GET" && p === "/session") {
    let token = getCookie(req, SESSION_COOKIE);
    let pair = token ? state.pairs.get(token) : null;
    if (!pair) {
      token = hex(32);
      pair = { csrf: hex(32), sessionId: `bs-${state.pairs.size + 1}` };
      state.pairs.set(token, pair);
      setSessionCookie(res, token);
    } else {
      pair.csrf = hex(32);
    }
    return json(res, 200, {
      sessionId: pair.sessionId,
      csrfToken: pair.csrf,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  if (req.method === "POST" && p === "/command") {
    const token = getCookie(req, SESSION_COOKIE);
    const pair = token ? state.pairs.get(token) : null;
    if (!pair) {
      res.writeHead(403);
      res.end();
      return;
    }
    const csrf = req.headers[CSRF_HEADER];
    if (!csrf || csrf !== pair.csrf) {
      res.writeHead(403);
      res.end();
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION) {
      return json(res, 409, { protocolVersion: PROTOCOL_VERSION });
    }
    const result = handleCommand(envelope.operation || {});
    return json(res, 200, { result });
  }

  if (req.method === "GET") {
    return serveStatic(req, res, p);
  }

  res.writeHead(404);
  res.end("not found");
}

export default handler;

function attachWebSocket(server) {
  server.on("upgrade", (req, socket, head) => {
    void head;
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    if (url.pathname !== "/events") {
      socket.destroy();
      return;
    }
    const protos = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim());
    if (!protos.includes(WS_SUBPROTOCOL)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        `Sec-WebSocket-Protocol: ${WS_SUBPROTOCOL}\r\n` +
        "\r\n",
    );

    const ws = {
      socket,
      send(text) {
        const payload = Buffer.from(text, "utf8");
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81;
          header[1] = len;
        } else if (len < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeUInt32BE(0, 2);
          header.writeUInt32BE(len, 6);
        }
        socket.write(Buffer.concat([header, payload]));
      },
      close() {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        state.sockets.delete(ws);
      },
    };
    state.sockets.add(ws);
    try {
      ws.send(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          eventSequence: ++state.eventSeq,
          event: { kind: "hostStatus", state: "ready" },
        }),
      );
    } catch {
      /* ignore */
    }
    socket.on("data", (buf) => {
      if (!buf.length) return;
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) ws.close();
    });
    socket.on("close", () => state.sockets.delete(ws));
    socket.on("error", () => state.sockets.delete(ws));
  });
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("internal error");
      }
    });
  });
  attachWebSocket(server);
  return server;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain || process.env.FORCE_LISTEN === "1") {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.warn("warning: public/index.html missing — run `pnpm build` first");
  }
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`grok-desktop-portable demo host on http://${HOST}:${PORT}`);
  });
}
