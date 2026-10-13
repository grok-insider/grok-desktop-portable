# Static qualification hosting on Coolify

The Cloudflare-proxied qualification origin `https://grok.fabrials.com` can be
served by Coolify using the verified prebuilt candidate. This adapter does not
rebuild the PWA or change any shell, worker, installer, archive or source metadata
bytes. Production `desktop.grok.me` and its Vercel configuration are unchanged.

`scripts/remote-coolify.mjs` runs the existing full corresponding-source verifier
before wrapping a candidate. The adapter manifest separately records the SHA256
of each original deployment manifest, its source identities, every adapter input,
the pinned nginx image and every packaged file. Verification regenerates the
configuration from reviewed inputs; editing checksums cannot authorize a changed
configuration. The original archive remains tied to the original Portable SHA,
not the later commit adding this hosting adapter.

## Prepare and verify

```sh
node scripts/remote-coolify.mjs pack /absolute/coolify-candidate \
  --artifact /absolute/verified-candidate \
  --spanreed /absolute/reviewed-spanreed \
  --wasm-notices /absolute/verified-wasm-notices
node scripts/remote-coolify.mjs verify /absolute/coolify-candidate \
  --artifact /absolute/verified-candidate \
  --spanreed /absolute/reviewed-spanreed \
  --wasm-notices /absolute/verified-wasm-notices
node --test scripts/remote-coolify.test.mjs scripts/remote-coolify-http.test.mjs
REMOTE_COOLIFY_ADAPTER=/absolute/coolify-candidate \
  node --test scripts/remote-coolify-http.test.mjs
```

Output must not already exist. The HTTP suite builds the generated image and
starts it bound to an ephemeral loopback port, with the same hardened runtime
constraints intended for Coolify. It checks every served payload hash and MIME,
CSP and cache headers, method and Host rejection, malformed paths, strict SPA
routing, worker scope, gzip, conditional requests, and logs. It removes its own
container and image afterwards. Tests without `REMOTE_COOLIFY_ADAPTER` use an
explicit synthetic shell and do not constitute candidate/source qualification.

The adapter is qualification-only. It refuses a production-origin artifact and
requires the clean matching Spanreed checkout for every source proof. No review
artifact or dirty source bypass is provided.

## Runtime and proxy contract

The image runs nginx as UID/GID 101 with one worker, listening on internal HTTP
port 8080. Coolify's Traefik terminates trusted HTTPS. The application must receive
exactly `Host: grok.fabrials.com`; unknown domains, a port suffix, upper-case names
and the Coolify-generated hostname receive 404. `/healthz` returns `ok` only with
that same Host. The image healthcheck sets it explicitly.

Use a managed Coolify Docker Compose service, retaining the generated
`compose.yaml` runtime constraints: read-only root filesystem, a 16 MiB `/tmp`
tmpfs with noexec/nosuid, no Linux capabilities, no-new-privileges, 64 process limit, 128 MiB memory
limit without additional swap and 0.5 CPU. Deploy a pushed image by immutable digest in place of `build`;
keep the exact image digest in the deployment receipt. A Dockerimage application's
custom Docker run options must not be assumed to preserve those settings. Verify
the running container's effective HostConfig after rollout.

Do not publish port 8080 to the host. Connect the service to Coolify's proxy
network and configure only the exact qualification hostname. Keep Cloudflare TLS
in Full (strict) mode. Do not apply a cache-everything override or rewrite the Host
header. The proxy must also avoid recording query strings; the container disables
access logging and emits only emergency runtime errors.

There is no API server, dynamic upstream, database, uploaded content or Worker
invocation. Static hosting cannot execute the user's Grok CLI. The global limits
are 128 active response connections, 200 requests/second with a 400-request burst,
256 worker connections, a 1 KiB request body, two 8 KiB large header buffers, and
10–15 second request/send/keepalive timeouts. Responses are capped at 2 MiB/s per
connection. Global limit zones have fixed 32 KiB allocations. The server does not
trust `X-Forwarded-For` or client-provided Cloudflare headers. Per-IP limits would
otherwise count the shared proxy as one user; genuine per-client abuse controls
belong at the authenticated Cloudflare edge. These bounds control origin resource
use, not a monetary guarantee on network traffic or the proxy itself.

The response advertises HSTS for one year without includeSubDomains; Coolify must redirect public HTTP to HTTPS. Only GET and HEAD are accepted. Raw path normalization bypasses, encoded paths,
backslashes and duplicate slashes are rejected. Each reviewed payload has an
exact route. Only `/`, `/setup` and `/s/[A-Za-z0-9_.-]+` return the shell; unknown
paths, directory indexes, API paths and source maps return 404. `/healthz` is the
additional operational route. `/licenses` is the legal landing page, also advertised through a `Link` header on every response.

Hashed assets, crypto and content-addressed sources are immutable for one year.
Installers use no-store. Unhashed shell files, the worker and manifest revalidate.
Errors always use no-store, including invalid ranges and rate limiting on otherwise immutable routes. Security headers and the noindex qualification policy come from the original
reviewed deployment configuration. WASM, JavaScript, manifests, fonts and
installers have explicit MIME types. Compression is bounded gzip level 3;
pre-compressed source archives are not recompressed.

## Source retention and rollback

Add each still-required prior candidate with its own reviewed Spanreed checkout:

```sh
node scripts/remote-coolify.mjs pack /absolute/next-coolify-candidate \
  --artifact /absolute/current-candidate --spanreed /absolute/current-spanreed \
  --wasm-notices /absolute/current-notices \
  --retain-source /absolute/prior-candidate --retain-spanreed /absolute/prior-spanreed \
  --retain-portable /absolute/prior-portable \
  --retain-wasm-notices /absolute/prior-notices
```

The grouped retention options may repeat. Retained source verification invokes the original clean Portable checkout at its exact recorded revision; later changes to current installers or deployment policy must not invalidate a previous source archive. `--portable` can likewise select an original verifier for the active candidate. Each candidate must pass its complete
source proof. Only its immutable `/sources/` files are retained; older JavaScript,
workers, installers and HTML cannot replace the current shell. Duplicate paths
must have identical hashes. The adapter manifest records every retained source
input. Pass the same retention inputs to `verify`.

For rollback, prepare a wrapper around the earlier shell while retaining the
newer shell's source files too. Serve sources for every version users may still
run, including installed offline shells; retaining just the previous image on
an operator's disk does not provide online source availability. The initial
qualification deployment has no previous public shell; the first update must
exercise the N/N−1 source, worker-update and rollback sequence on the real origin.

Keep the verified original candidates, source verifier revisions, adapter
manifest, built image digest, runtime inspection and public HTTP receipt together.
Retained local build directories are reproducibility inputs, not a backup service
for user data. No conversation content is stored by this adapter.

## WebAssembly dependency notices

A matching [WASM notices supplement](wasm-notices.md) is required for each
candidate, including retained source candidates. The adapter invokes its verifier
against the original corresponding-source archive and deployed WASM/JavaScript.
It adds the content-addressed notice file and a separate descriptor under
`provenance/`; descriptors are not public routes. The original source archive,
metadata and frontend dependency notices are unchanged.

[https://grok.fabrials.com/licenses](https://grok.fabrials.com/licenses) links the
current source archive, application license, frontend notices and compiled WASM
notices, plus the equivalent records for retained versions. Every response links
to this page through HTTP `Link: </licenses>; rel="license"`; WASM and its wrapper
also link directly to their immutable supplement. The page contains no scripts,
external requests or conversation data. Its own route revalidates on each use.
