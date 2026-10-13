const SHELL = __SHELL__;
const PUSH_ONLY = new URL(self.registration.scope).pathname.startsWith("/push/");
const CACHE = __CACHE__;
const SHARE_TARGET = "__SHARE_TARGET__" === "enabled";
const shareInboxApi = null;
const pushWorkerApi = null;
if (pushWorkerApi) pushWorkerApi.installRemotePushWorker(self);
const STATE_CACHE = "grok-pwa-state-v1";
const STATE_URL = new URL("__shell_state__", self.registration.scope).href;
const MANIFEST_URL = new URL("__shell_manifest__", self.registration.scope).href;
const urls = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  if (!PUSH_ONLY) event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  if (!PUSH_ONLY) event.waitUntil(activateShell());
});

self.addEventListener("message", (event) => {
  if (event.data?.kind === "activateUpdate") self.skipWaiting();
  if (event.data?.kind === "shellStatus") event.waitUntil(shellState().then(state => event.ports?.[0]?.postMessage({canRollback: Boolean(state.previous)})));
  if (event.data?.kind === "rollbackShell") event.waitUntil((async () => {
    const state = await shellState();
    if (!state.previous) {event.ports?.[0]?.postMessage({ok: false}); return;}
    const cache = await caches.open(state.previous);
    if (!await cache.match(new URL("index.html", self.registration.scope).href)) {event.ports?.[0]?.postMessage({ok: false}); return;}
    await writeState({active: state.previous, previous: null});
    event.ports?.[0]?.postMessage({ok: true});
  })());
});

self.addEventListener("fetch", (event) => {
  if (PUSH_ONLY) return;
  const request = event.request;
  const url = new URL(request.url);
  if (SHARE_TARGET && request.method === "POST" && url.origin === self.location.origin && url.pathname === "/share-inbox" && !url.search) {
    event.respondWith(receiveSharedContent(request));
    return;
  }
  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin || url.search) return;
  if (request.mode === "navigate" && (/^\/(?:s\/[^/]+|setup)?$/.test(url.pathname))) {
    event.respondWith(shellState().then(async state => (await (await caches.open(state.active)).match(new URL("index.html", self.registration.scope).href)) || Response.error()));
    return;
  }
  if (!urls.has(url.href) && !/^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css|woff2?)$/.test(url.pathname) && !/^\/crypto\/[a-f0-9]+\/fabrials_remote_noise(?:_bg)?\.(?:js|wasm)$/.test(url.pathname)) return;
  event.respondWith(shellState().then(async state => {
    for (const name of [state.active, state.previous].filter(Boolean)) {
      const cache = await caches.open(name);
      const manifest = await cache.match(MANIFEST_URL);
      const allowed = manifest ? await manifest.json() : name === CACHE ? [...urls] : [];
      if (Array.isArray(allowed) && allowed.includes(url.href)) return (await cache.match(request)) || Response.error();
    }
    return fetch(request);
  }));
});


async function receiveSharedContent(request) {
  try {
    const content = await shareInboxApi.parseSharedRequest(request);
    const id = await shareInboxApi.enqueueSharedContent(content);
    return Response.redirect(new URL(`/#share=${encodeURIComponent(id)}`, self.registration.scope).href, 303);
  } catch (error) {
    const code = error instanceof Error ? error.message : "share_unavailable";
    const messages = {share_too_large: "The shared content is too large. Share up to three files of 200 KB each and less than 1 MiB in total.", share_inbox_full: "Three shared items are waiting. Open Grok Remote and remove or use one before sharing again.", empty_share: "Nothing was shared. Return to the source app and try again."};
    return new Response(messages[code] ?? "The shared content could not be saved. Open Grok Remote and check site storage before trying again.", {status: code === "share_too_large" ? 413 : code === "share_inbox_full" ? 409 : 400, headers: {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"}});
  }
}

async function installShell() {
  try {
    const cache = await caches.open(CACHE);
    await cache.addAll([...urls]);
    await cache.put(MANIFEST_URL, Response.json([...urls]));
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}

async function shellState() {
  const response = await (await caches.open(STATE_CACHE)).match(STATE_URL);
  try {
    const state = response ? await response.json() : null;
    if (state && typeof state.active === "string" && state.active.startsWith("grok-shell-") && (state.previous === null || typeof state.previous === "string" && state.previous.startsWith("grok-shell-"))) return state;
  } catch {}
  return {active: CACHE, previous: null};
}

async function writeState(state) {
  await (await caches.open(STATE_CACHE)).put(STATE_URL, Response.json(state));
}

async function activateShell() {
  const old = await shellState();
  const previous = old.active !== CACHE ? old.active : old.previous;
  await writeState({active: CACHE, previous});
  const keep = new Set([CACHE, previous]);
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("grok-shell-") && !keep.has(key)).map(key => caches.delete(key)));
}
