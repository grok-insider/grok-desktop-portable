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
Errors always use no-store, including invalid ranges and rate limiting on otherwise immutable routes. nginx may emit identical security and no-store fields twice for a rejected range because its range filter processes headers twice; the HTTP verifier checks every security value and rejects any cache directive other than no-store on that error. Security headers and the noindex qualification policy come from the original
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

## Deployed qualification instance — 2026-10-13

`grok.fabrials.com` runs on **fabrials-1** as the Coolify Compose service
`grok-remote-qa`, UUID `em7w9gpwwbnznm6eyoaw4skp`, application `web`. Its upstream
is internal HTTP 8080, with no host port binding. Coolify stores this separately
as `domain_port_overrides["https://grok.fabrials.com"] = 8080`; a portless `fqdn`
and empty `ports` field in the API response are expected. The service deployment
action regenerates proxy labels before saving and launching Compose. Use the
Coolify API `start` action for the initial launch. After updating the Compose
configuration of a running service, use **`restart`**; `start` returns
`Service already running` and does not apply the new image. Check the running
image digest and health after the queued restart finishes.

The initial 2026-10-13 image was
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:6a08441ddb30d258514b373f246d84070f3be0f97e7f9f540b304d2a518a6c7f`.
Its adapter revision is `e911a52aec0208ea3e3de20ae44a2d8abc40ef30`; its manifest
SHA256 is `08d517b9afbfd9aa62c6246390c559e2aafebaad977119334b5bf79d1cdaf0b8`.
The original payload and corresponding source remain Portable
`2aaed2e11cc88aced4e7c216f698308eae718967`. The image, runtime and TLS receipts
are in the workspace's `.worktrees/remote-release-candidate-20261013/receipts/`
(`coolify-image-v3.json`, `coolify-runtime-v3.json`, `origin-tls.json`); the deployable
context is the adjacent `coolify-qualified-v3/`. The running container was inspected
with the documented privilege/resource constraints and a healthy image probe.
The v3 HTTPS checks passed 222 checks against the origin and 224 through
Cloudflare (`origin-http-v3.json`, `cdn-http-v3.json`), including byte ranges with
gzip accepted by the client.

The earlier wrapper image is retained as deployment history in `coolify-image.json`:
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:b7f7f0180e084feea6eb96871a7641c468b8ad43909e3b2c2df8286f98a3a04c`. Both images contain the same original PWA shell. An image-only rollback
between these wrappers exercises hosting recovery; it does not qualify a
distinct-version service-worker update or N/N−1 application rollback.

The hosting rollback was exercised on 2026-10-13 through Coolify: v3 to the
previous wrapper and back to v3. Both target images became healthy, the prior
wrapper served the exact original shell, and all 224 CDN checks passed after
restoration (`coolify-rollback-observed.json`, `coolify-restored-observed.json`,
`cdn-http-after-rollback.json`). Both image references are protected from registry
retention. Browser QA passed at 1440 and 390 pixels, including offline shell
reload, source links, the legal page and favicon; no pairing, physical mobile
installation, inference or notifications were exercised in that browser pass.

Cloudflare DNS record `12c33093cddf9851b562a0ec47746989` is the proxied A record
to `188.245.86.157`. The following rules apply only to `grok.fabrials.com`:

| Rule | ID | Behavior |
| --- | --- | --- |
| `grok_remote_qa_transport` | `aedd65d86c3842f999043a93b6953328` | Full (strict) TLS; Rocket Loader, email obfuscation and automatic HTTPS rewrites disabled to preserve application bytes |
| `grok_remote_qa_fresh_shell` | `b7d360bfe64d4b46a12e4528dac9c9f8` | Cache bypass outside `/assets/`, `/crypto/` and `/sources/`; browser policy respects origin |
| `grok_remote_qa_immutable_assets` | `b2400a042326439dbab08c2edcda6e4f` | Cache those immutable prefixes, respecting origin cache policy; exclude query strings from their cache key |
| `grok_remote_qa_ranges` | `94590951b6bd43c8ba8d7e54a34437ae` | Last cache rule: bypass requests with a nonempty `Range` header so the origin supplies 206/416 and no-store semantics |

The configuration ruleset is `0e7cafaa6f1442ea9cdc84be854c74dd`; the cache ruleset
is `a4531f33c6de439496fb7619bdec421c`. Keep unrelated rules in those shared
rulesets intact. The matching `cloudflare-*.json` receipts record the applied
settings; the initial DNS creation receipt precedes enabling proxying.

The Range exception is deliberate: Cloudflare served a cached compressed asset as
200 with its complete body when no cacheable Content-Length was available. That
response is permitted by HTTP but differs from the qualified origin behavior.
Requests with Range therefore reach nginx, which supports single byte ranges and
uses no-store for both valid ranges and errors. The adapter disables nginx gzip
for requests with Range, including when the CDN sends `Accept-Encoding: gzip`;
otherwise nginx can ignore the range and return a compressed full body. Ordinary
immutable requests keep compression and CDN caching. Keep the Range rule after the other two cache rules.

Run the HTTPS verifier against the exact packaged context:

```sh
python3 scripts/qualify-coolify-http.py \
  --adapter ../remote-release-candidate-20261013/coolify-qualified-v3 \
  --receipt ../remote-release-candidate-20261013/receipts/origin-http-v3.json \
  --origin-ip 188.245.86.157
python3 scripts/qualify-coolify-http.py \
  --adapter ../remote-release-candidate-20261013/coolify-qualified-v3 \
  --receipt ../remote-release-candidate-20261013/receipts/cdn-http-v3.json
```

`--origin-ip` bypasses Cloudflare while preserving the real hostname, SNI and
trusted certificate verification. Without an address override, the second command
uses public DNS and exercises Cloudflare. If the workstation still caches the
initial NXDOMAIN, set `GROK_QA_EDGE_IP` to an independently verified current
Cloudflare A-record address and add `--edge-ip "$GROK_QA_EDGE_IP"` to the second
command. This still exercises the CDN with trusted TLS; it does not prove that
the workstation's ordinary DNS cache has recovered. The two address options are
mutually exclusive, and their selection is recorded in the receipt.

Those initial wrappers contained the first public PWA shell at this origin;
redeploying them did not qualify a distinct-version N/N−1 application rollout.
The 2026-10-14 rollout below supplies that separate evidence. Recover a
configuration failure by restoring the reviewed Compose configuration and its
pinned image through the **Coolify API**, then **restart** the running service
and repeat runtime and HTTPS verification. An emergency withdrawal uses the Coolify service stop API; DNS and
host-specific Cloudflare rules are separate changes, and installed offline shells
are not removed by stopping the server. Preserve corresponding-source availability
for any already distributed build. Future updates must retain and test both source
versions before claiming rollback readiness. Do not run Compose or replace the
managed container manually.

## Earlier deployment, 2026-10-14

The current image is
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:70146ff9cadbb8fb30738008838c9932a8163d3aae377546e769c7f4051bdd44`.
Its adapter manifest is
`a3338dbe0d7071c8aafe6a2aba5680774ec7e7fc560b11194437d6d6c4641579`.
It contains Portable `5bdcf17`, canonical libraries `6ae91bd`, the native source
tree `8b12b86` and retained original sources/notices for the prior shell.
The reviewed context is `.worktrees/remote-release-candidate-20261014/coolify/`;
verification must use the matching frozen source checkouts, not a later HEAD.

The rollback image is
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:47dc752c0ca9495ab7dbda56415e0ec785075bc8fc67ab1ff798d34870e66f18`.
It serves the prior shell while retaining sources/notices for both versions.
Both tags are protected in the registry retention configuration. A real Coolify
rollback and restoration passed health/runtime verification and 231 public CDN
checks for each image. The current origin passed 229 checks. The resource and
privilege limits above were checked against the running container.

Coolify's service PATCH expects `docker_compose_raw` as base64, followed by
the service restart action. A rejected PATCH must not be treated as an applied
configuration. Validate its response and the actual running image independently.

Chrome 155 in hidden Syl Sway exercised an actual distinct-shell update with
explicit user action and offline rollback. Both source archives and notice sets
were downloaded and hash-verified. Eighteen checks passed; this did not include
active turns or drafts during update. A separate 13-check trial paired two
independent browsers to station through trusted Tailscale TLS and reconnected
one without blocking the other. See the [dated receipt](qualification-evidence-2026-10-14.md)
for identities, station installation, evidence paths and outstanding gates.

## Current deployment: r4c, 2026-10-14

The current QA image is
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:23ed39dabcb6a549031c3193f158aeb135a5ecb0895d37b9ab14edac77c8f1b6`,
deployed at 21:14 UTC by changing only the image digest in the service Compose
and using `restart`. Portable `6870159256e77ddcd62ebbf216339d956d7a4379`,
libraries `bd01164cf98dc416c52482d5c9f5a2f5d9acfae2` and Spanreed
`4219cba26344ea3cbd87c56fed9a4d3cc01bccec` identify its corresponding source;
its shell is `5bf49c9f5c116b8f8c715850ba38a9579d7db44f787ca521909961a4bd38693a`.
The wrapper retains the sources and notices of r3 (`e2ed580c…`) and the three
earlier shells. Its rollback image
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:ad0bfddd5e857b2512cac5c006a0dbf2ee2876a25cb7d061e7a344192a7c4551`
serves r3 and retains the r4c sources as well. Both digests and tags are in
puck-2's `/data/registry/protect.txt`.

Coolify actually rolled back to r3 and restored r4c; each image became healthy
within about ten seconds. The origin passed 224 HTTP checks and the CDN 226 for
r4c (before the rollback and again after restoring), and 253 and 255 for the
rollback image. The running container keeps UID 101, a read-only root, 128 MiB,
0.5 CPU, 64 PIDs, no capabilities, `no-new-privileges` and no host ports. The
real update from r3 to r4c in Chrome 155 passed 18 checks. Live pairing against
station passed 24 checks twice: with the r3 shell before the image change and
with the r4c shell after it. Station now runs Spanreed `4219cba` from its NixOS
configuration rather than the QA unit.

Evidence: [r4c deployment receipt](evaluation/qualification-r4c-deployment-2026-10-14.json).
Local build, wrappers and operational receipts live under
`~/.local/share/fabrials-remote-release/2026-10-14/r4c-candidate/`. The frozen
source checkouts are `.worktrees/remote-portable-final-6870159` and
`.worktrees/remote-spanreed-final-4219cba`.

## Earlier deployment: r3, 2026-10-14

The r3 QA image was
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:659463d155c2fc1c1c29d2ec25851ad9cc9db77bed27513dae75f27a1cfac5c8`.
Portable `abe4f35895aacda102a09c3b50475379febf3b6c`, libraries
`ee3060d023c5f5f34196e1ef7f439b65be9d0bb8` and Spanreed source
`e6d9cc8cb076d7896edec98ee7338d4d4d8f1f7a` identify its corresponding source.
Its shell is `e2ed580c58b2b07255d85205ec8a1ad0988a7a3c2f6ee1cef44f968e3f976a9e`.
The artifact was packaged from the exact committed native embedded files; the
full source verifier passed. The SHA-256 of its source archive is
`d7482730885ea14e67d3df818a6680ea731173bf700c4c4f4bd2555b34a90bfc`.

The wrapper retains source and license resources for all four shells served
at this origin. Its rollback image
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:0ba1de4556e8071daf77101ac66e91ef66b11c6f5f088e1da93cde0651e8f249`
serves the previous `ff22898f…` shell and retains the same four source versions.
Both image tags are protected from registry retention. Coolify actually rolled
back and restored r3; each image became healthy. The origin passed 243 HTTP
checks; the CDN passed 245 after deployment, rollback and restoration. The
running candidate's UID, read-only root, memory/CPU/process caps, no-new-privileges,
capability removal and lack of host port bindings were checked independently.

The exact artifact passed 107 multi-host checks, including the corrected mobile
computer cards, crossed identity rejection and isolation of drafts/history.
The actual HTTPS update and offline browser rollback passed 18 checks. A second
18-check run used the reusable [deployment update runner](deployed-update-qualification.md)
during server restoration; its Chrome group exited and its profile was removed.
Neither run used private conversations or physical devices.

Evidence: [r3 deployment receipt](evaluation/qualification-r3-deployment-2026-10-14.json).
Local build, source verifiers and operational receipts live under
`.worktrees/remote-release-candidate-20261014-r3/`. This static deployment does
not assert that station has installed its native source revision, qualify a
Windows installer or open publications. Those need their separate receipts.
