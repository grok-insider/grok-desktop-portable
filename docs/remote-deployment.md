# Deploying the direct PWA at desktop.grok.me

The canonical application origin is `https://desktop.grok.me`. Private sessions connect directly to each user's Spanreed over HTTPS/WSS with a pinned Noise identity. Fabrials account availability is not a prerequisite. `remote.fabrials.com` is a redirect alias; it must not host a second application or receive a wider host CORS allowlist. An existing alias installation needs to pair again on the canonical origin.

`vercel.json` runs `pnpm build:remote`. This requires `FABRIALS_REMOTE_CRYPTO_DIST` containing the compiled Noise JS/WASM pair; it fails before building when crypto is absent. An ordinary `pnpm build` is for local compatibility work and does not qualify a hosted direct application. Do not put host credentials, publication grants or account secrets in frontend build variables.

## Verified prebuilt artifact

The separate artifact uses Vercel Build Output API v3. Its `.vercel/output/static` contains the verified PWA shell, compiled versioned Noise JS/WASM, service worker and, for deployment candidates, the exact corresponding-source archive with its license, dependency notices and build-specific metadata. It also includes the two reviewed public installers, verified byte for byte against `site/`. It excludes the demo, API stub, source maps and unrelated files. Installers are served with no-store and are not cached by the service worker.

The public installers resolve GitHub's latest published stable release. An unavailable API, prerelease, draft or malformed version stops installation; there is no old-version fallback. A checksum must identify exactly the selected archive before extraction. Operator-specific versions remain a separate local installer path. Resolution and failure behavior are exercised offline by `scripts/install-resolve.test.sh`.

`deploy/remote/build-output.json` supplies the response CSP, immutable hashed assets, fresh worker/manifest responses and security headers. HTTPS/WSS connections are allowed because users own their endpoint domains; application pairing, exact browser-origin validation and Noise host-key pinning provide endpoint identity. Blob image URLs are allowed for locally verified images. Script execution remains restricted to the application origin and compiled WASM. The app has no automatic relay fallback. Unknown API/static paths remain 404.

Run **Remote deployment artifact** (`.github/workflows/remote-artifact.yml`) on the reviewed Portable commit, with `origin` explicitly set to `https://desktop.grok.me`, `libs_commit` set to the full reviewed 40-character commit from `grok-insider/fabrials-libs`, `spanreed_commit` to the reviewed native release commit and `spanreed_version` to its published stable version. The workflow downloads that release’s source archive and named checksum, then verifies its complete Git trees and compares every embedded PWA byte and original source identity with this build. Both installer scripts and deployment configuration must also match the Portable tree in the source archive. Configure `FABRIALS_LIBS_READ_TOKEN` with read-only Contents access to that private repository. This workflow builds and uploads an artifact; it does not deploy. Its GitHub run and credential configuration remain unverified for this candidate.

CI pins Node and Rust versions, uses packageManager-pinned pnpm and the frozen pnpm and Cargo lockfiles. It runs web types/tests, artifact boundary tests and the native Noise tests, builds real WASM and its matching wasm-bindgen wrapper, and verifies native/WASM interoperability. `deployment.json` records the canonical origin, source commits, dirty flags, source hashes, toolchain versions and each output hash. Source changes during the build fail it. Deployment requires clean reviewed commits.

The uploaded `grok-remote-vercel-<portable-sha>-<libs-sha>-<environment>` contains `grok-remote-vercel.tar.gz`, preserving the hidden `.vercel` directory. The workflow refuses an archive from another shell or input revision. Its local adapter tests use synthetic archives; a real clean corresponding-source candidate and the Spanreed installer/update/rollback distribution still require release qualification.

## Local review build

Use the existing toolchain with WASM support; do not install a system-wide toolchain. Install dependencies with `corepack pnpm install --frozen-lockfile`, then:

```sh
node scripts/build-remote-artifact.mjs \
  --libs /absolute/path/to/fabrials-libs \
  --output /tmp/grok-remote-artifact
node scripts/remote-artifact.mjs verify /tmp/grok-remote-artifact
```

The output directory must not exist. Builds without corresponding source are review artifacts even when both input checkouts are clean. `--allow-dirty` additionally permits local uncommitted inputs. `verify --for-deploy` rejects either case; editing the manifest does not establish correspondence.

For a deployment candidate, add `--source-archive /absolute/spanreed-X.Y.Z-source.tar.gz --spanreed /absolute/reviewed-spanreed-release` to the build command, then verify with:

```sh
node scripts/remote-artifact.mjs verify /tmp/grok-remote-artifact \
  --for-deploy --spanreed /absolute/reviewed-spanreed-release
```

The Spanreed verifier checkout must be clean, at the archive’s exact release version and commit. Ordinary review verification checks metadata, paths and hashes; deployment verification reruns the complete source archive proof. No verifier evaluates service-worker JavaScript from an artifact: it parses the generated JSON literals for shell entries and cache identity.

## Source and license UI

The computer list and Computer settings expose **Source and license**. Opening it lazily reads `/sources/<shell-id>.json`, where the full SHA256 shell identity comes from the loaded HTML. Every emitted shell file, dependency notice and the complete worker template contributes to that identity before its marker/cache name are inserted. A CSS-only or worker-only update therefore receives new source metadata.

The source archive, own license and dependency notices are content-addressed local files verified when packaging. They are excluded from the offline shell cache; the original third-party notices also ship as a shell asset. Metadata is limited to 8 KiB and fetched without credentials or redirects. Missing metadata, offline access and version mismatches show an unavailable state rather than linking a different build’s source. Review builds deliberately have that state.

The source UI is not a substitute for retaining matching source distribution. Before release, hosting must demonstrate source availability for versions users can still run, including N-1 rollback. The current artifact contains only its own source distribution; switching the origin to a newer artifact does not itself retain the previous `/sources/` files. This remains an explicit release operation/hosting gate.

## Release and rollback

After deployment is authorized, verify the matching CI artifact and the Vercel project identity for **desktop.grok.me**, then publish the reviewed prebuilt output. Configure the old alias as a permanent redirect preserving the fragment, without adding an empty fragment. Both `vercel.json` and the prebuilt routing configuration contain that redirect; qualify its actual hosting behavior before switching domains. Keep the previous verified artifact for rollback and exercise the service worker's explicit update and rollback flow.

Qualify the actual HTTPS deployment: headers/MIME, direct pairing with trusted TLS and Tailscale, connection while Fabrials services are unavailable, revocation/reconnect, N/N-1 updates, multi-host isolation, real Android installation/keyboard/Doze, push delivery and Windows lifecycle. Apple remains experimental until real-device qualification. Publication routes remain closed until their deletion, restore, cost and isolation gates pass. No deployment was performed in this implementation task.

## Qualification environment: grok.fabrials.com

`https://grok.fabrials.com` is an explicit qualification origin. It does not
replace the production default `https://desktop.grok.me`, and
`remote.fabrials.com` continues to redirect only to production. The closed list
in `apps/web/src/services/deploymentOrigins.json` accepts those two application
origins exactly; HTTP, ports, trailing slashes and sibling domains are rejected.
No wildcard is added to native Origin checks.

Build and verify a qualification candidate with:

```sh
node scripts/build-remote-artifact.mjs \
  --origin https://grok.fabrials.com \
  --libs /absolute/path/to/fabrials-libs \
  --output /tmp/grok-qualification-artifact \
  --spanreed /absolute/reviewed-spanreed-candidate \
  --source-archive /absolute/spanreed-X.Y.Z-source.tar.gz
node scripts/remote-artifact.mjs verify /tmp/grok-qualification-artifact \
  --origin https://grok.fabrials.com --for-deploy \
  --spanreed /absolute/reviewed-spanreed-candidate
```

For the lower-level encrypted web build, set
`FABRIALS_REMOTE_ORIGIN=https://grok.fabrials.com`. This must also be set when
Spanreed rebuilds its embedded PWA. The source archive must contain that exact
qualification shell; a production shell archive cannot satisfy its proof.
The HTML contains `grok-app-origin`, and the same selected origin is compiled
into routing and recorded in `deployment.json`. Retargeting only a manifest is
rejected. A shell served on the other known hosted origin blocks before reading
pairing or publication state, without forwarding the fragment. Browser storage
is separate by origin, so qualification needs its own explicit pairing.

The native host and pairing command use `--web-origin https://grok.fabrials.com`;
that selection must match the installed service configuration. The browser’s
WebSocket Origin remains the actual document origin. The `directPair` fragment
schema, private endpoint and Noise identity checks do not change.

The qualification artifact uses
`deploy/remote/qualification-build-output.json`, with the same restrictive CSP
and static routing, a `MatchableValue.eq` host guard returning 404 on other domains, no alias
redirect and `X-Robots-Tag: noindex, nofollow, noarchive`. Vercel’s [Build Output API schema](https://vercel.com/docs/build-output-api/configuration)
uses `MatchableValue.eq` for exact equality; a string matcher may be a regular
expression. The robots header is an indexing preference, not access control. It must be deployed as a separate prebuilt
Vercel project at grok.fabrials.com; root `vercel.json` retains production
behavior. Both hosting configuration files and installers are bound to the
corresponding-source archive. Validate the real host guard and response headers
before using pairing links on that deployment.

The artifact workflow’s `origin` input selects the source preparation path.
Production still requires the published stable Spanreed archive. Qualification
builds an archive locally from the exact clean Spanreed candidate and Portable
checkouts, then runs the same full correspondence and deployment checks. It
does not need to publish a stable native release to test a candidate, and it
cannot bypass clean commits, native embed identity or corresponding source.

Private qualification requires no Fabrials login or Web rollout. Managed Remote
SSO/CORS has a separate exact-origin opt-in in Web; publication authorization
remains bound to the production origin and all publication readiness gates stay
closed. This domain change supplies no new publication evidence.

Local validation of the origin change passed 799 frontend tests, TypeScript and
18 artifact boundary tests. The encrypted qualification build was attempted but
blocked in this sandbox: the existing dependency-notice subprocess returned
empty output, and the mandatory JSON/notice gate stopped the build. A diagnostic
`spawnSync` returned EPERM. Notices and their generation mechanism were not
changed or bypassed. The historical receipts describe their previous artifacts;
no qualification-domain artifact, hosting, pairing or source download has yet
been validated in this environment.

### Browser qualification of the exact candidate

`scripts/qualify-direct-browser.ts` accepts `REMOTE_QA_ARTIFACT` pointing to a
packaged candidate and `REMOTE_QA_SPANREED` pointing to its clean verifier
checkout. In this mode it repeats the full deployment and corresponding-source
proof before launching Chrome, serves the artifact's own files and config, and
checks all three displayed source links by downloading their real bytes through
the browser and comparing SHA256 (and archive size). It first injects a missing
metadata response to exercise the unavailable state. It does not substitute
synthetic success metadata in candidate mode.

`REMOTE_QA_ORIGIN` may select either exact reviewed origin; by default the
harness reads it from the built shell, and a mismatch fails. Its isolated native
fixture receives the same selection through `DIRECT_BROWSER_QA_WEB_ORIGIN`.
The production run exercises the alias redirect; the qualification run opens
`grok.fabrials.com` directly. Both use local hostname resolution, a laboratory
certificate, a fresh browser profile and a hidden Syl compositor at 2560×1440.
Set `REMOTE_QA_CHROME` to the actual Nix Chrome binary,
`REMOTE_QA_PLAYWRIGHT` to the installed Playwright core module and
`DIRECT_QA_NATIVE_BINARY` to the freshly built `direct_browser_fixture` example.
The argument is a new private directory containing `cert.pem` and `key.pem`.

The report records the origin, deployment manifest hash, source identities,
native fixture hash and real source-download checks. It separately identifies
unqualified production TLS, CDN routing, Tailscale, hardware and inference.
Without `REMOTE_QA_ARTIFACT`, the harness retains its synthetic source-UI mode
for local review, explicitly marked as having no qualified source download.
