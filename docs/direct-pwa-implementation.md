# Direct PWA implementation evidence

Local worktree candidate, 2026-10-13. No commit, staging, push or deployment.
[ADR 0020](adr/0020-direct-private-pwa.md) describes the current architecture;
[public-release-plan.md](public-release-plan.md) remains the release gate.

Implemented: local multi-computer profiles, direct WSS with pinned Noise,
protocol-mismatch preservation, scoped consented drafts, static offline shell,
complete previous-version rollback, direct notification registration, typed
image preparation/upload/readback, lazy transcript images, image drafts,
interactive crop and separately consented read-only offline history.
The managed account/relay entry remains separate from the public entry.

Image preparation strips metadata and applies orientation, then flattens
transparency onto white. Source limits are 25 MiB, 50 megapixels, eight pixels
per side and 512 pixels total. Cropping uses the normalized preview, offers
pointer and keyboard controls and never sends or adds another attachment.
The normalizer floors scaled dimensions to remain below its pixel budget.

The image composer isolates runtime state by computer scope and client. Tests
exercise conversation switching, explicit send, lost controller authority,
lost capability, uncertain outcomes, revocation during decoding, durable
consent, crop cancellation, failure, late results and recovery. A delayed old
image cannot appear under a new host or session, including an open preview.
Live terminal/provider images resolve by ID rather than the current transcript
tail. Transcript reads are bounded and SHA-256 checked.

History stores messages and tool summaries; reasoning, binary images and
pending actions are excluded. Missing images are labelled explicitly. Copies
show their save time and can be read without connecting to the host. Each copy
is limited to 1 MiB and 10,000 rows. History and image/text drafts share a 100 MiB
browser budget reserved atomically, including legacy localStorage migration.
A rejected migration keeps the old copy until space is freed. Reads and
rehydration of identical content do not renew the seven-day lifetime.

History writes use a single coalescing writer with a one-second pause between
batches during continuous updates. Deleting a conversation durably excludes
late writes from every tab until new consent. Disable, forget and authenticated
revocation invalidate previous consent epochs. Different tabs use last-completed
transaction semantics; the host projection has no durable revision to establish
which tab's observation is newest. A disconnected browser learns remote
revocation only when it next connects. Expiry is enforced on storage reads and
a minute timer while mounted; no JavaScript runs while the browser is closed.
Local copies remain readable to the browser profile and to a compromised app
origin, so consent is appropriate only on a trusted device.

## Automated checks

The final integrated frontend run passed **795 tests in 81 files**. TypeScript
passed. The encrypted production build passed `check-pwa-build --require-crypto`
with 46 cached shell entries plus the service worker (47 distribution files),
valid JS/WASM paths and a compiled WASM module. Public
assembly and installer resolution were also checked earlier in this worktree.
The main-script warning above 500 kB before compression remains.

Private logs: `/tmp/direct-source-web-tests.log`,
`/tmp/direct-source-types.log`, `/tmp/direct-source-build.log`. Artifact boundary tests pass 15 cases (`/tmp/direct-source-artifact-tests.log`); the updated workflow passes actionlint.
One earlier full run had a one-second wait timeout in the legacy managed
notification test. The unchanged test passed in the final complete rerun;
this does not establish the cause of that transient timeout.
These transient paths are local evidence, not release artifacts.

The integrated model-vision trial found a presentation defect missed by the
component tests: the default, nonexperimental transcript rendered message text
but omitted images. Both transcript branches now use the same `MessageRow`;
the experiment changes memoization only. The new SessionView regression fails
with experiments disabled before the fix and passes with either setting after
it, covering image-only messages, restored unavailable images and pending live
images. This supersedes the earlier encrypted artifact for image qualification.

## Browser laboratory

`scripts/qualify-direct-browser.ts` exercises the encrypted production bundle
against `fabrials-remote-host/examples/direct_browser_fixture.rs`, with synthetic
history and no Grok process. It creates a private Chrome profile in a real
hidden Syl Sway compositor at 2560 × 1440, checks narrow viewports, and closes
its owned processes. The runner requires `REMOTE_QA_CHROME` to name the actual
Nix Chrome package rather than the station's daily-profile wrapper. Application
responses apply the real deployment headers from `deploy/remote/build-output.json`,
including CSP; the alias performs its canonical HTTP 308 redirect.

The caller supplies a one-day laboratory certificate for `desktop.grok.me` and
`direct-fixture.test` as `cert.pem` and `key.pem` in a new private directory.
Only this isolated browser bypasses certificate trust and maps those names to
the loopback TLS fixture. This does not qualify production TLS or Tailscale.

An optional `REMOTE_QA_CROP_DIST` points to a separate synthetic crop harness:
from the repository root, run `node apps/web/qa/build-crop.mjs /absolute/new/path`.
It has a loopback-only guard, CSP with `connect-src 'none'`, synthetic image
capability and a client that rejects/counts every host operation. It uses the
real product attachment, normalization and crop code. Its stylesheet explicitly
includes the product's Tailwind sources, so utility generation matches the
components under test. This harness qualifies browser decoding, canvas pixels,
controls and draft preservation, not upstream model vision.

The final receipt is
[evaluation/direct-final-browser-2026-10-13.json](evaluation/direct-final-browser-2026-10-13.json).
It passed **35 checks** in Chrome 155 with no uncaught browser errors, using the
same 47 distribution files as the final deployment artifact and native embed.
It covers actual WASM Noise pairing with a synthetic native host, pairing-fragment
removal, consented draft reload, four viewport layouts, offline shell/history,
private reconnection without Fabrials, cache exclusion, revocation and durable
erasure. The crop checks cover keyboard width/movement, visible focus,
cancellation, preview geometry, mobile layout and decoded crop pixels, with no
host operations or text-draft changes. Screenshots were reviewed and the owned
temporary browser profiles and native state were removed afterward.

Source/license checks include the real unavailable state, keyboard focus return,
mobile layout, emitted font/icon/generated-style notices, and returning from the
source dialog to Computer settings without disconnecting. The positive source
metadata was explicitly **synthetic**; no real source archive download was
qualified. One resource error was expected: HTTP 404 for the review build’s
missing `/sources/<shell-id>.json`. The 38 ms blackholed-origin shell navigation
is one laboratory observation, not a production latency guarantee. The run made
no Grok inference calls and does not qualify production TLS, Tailscale, physical
Android/Apple devices, real push delivery or GPU performance.

The earlier
[evaluation/direct-private-browser-2026-10-13.json](evaluation/direct-private-browser-2026-10-13.json)
remains historical evidence for its own artifact: **27 checks**, no browser
errors and a 30 ms laboratory offline-shell observation. That receipt predates
the `MessageRow` fix and source/license UI. The final 35-check run repeats and
extends browser coverage on the final shell; the separate 13-check vision trial
below is the evidence for actual upstream image understanding.

Earlier failures are retained under their private `/tmp/direct-pwa-browser-*`
directories: wrapper argument rejection, Bun proxy headers, waiting for a
first-install service-worker controller, a non-unique history text selector,
expecting the crop preview to remain open after replacement, and missing
Tailwind source discovery in the synthetic crop harness. Those harness issues
were corrected before the historical 27-check trial; the real application was
not changed to make a harness assumption pass. The source-UI preliminary trial
subsequently found Computer settings hidden when experiments were disabled.
That product defect and nested cancellation were fixed before the final
35-check run; the final receipt records the earlier trial and correction.

## Integrated image vision

Spanreed's `docs/evaluation/direct-vision-2026-10-13.json` records a complete
13-check PWA/Noise/native host/official Grok 1.0.52/provider/history trial.
The provider read a random eight-digit fact present only in an image in 3.797
seconds. Both attachment and reply remained visible after a real host-history
reload. No tools, permission requests, dropped images, browser errors or private
browser requests to Fabrials occurred. The receipt includes the exact artifact
and native hashes, and records the preceding failed attempts honestly: two real
prompts exposed the default renderer defect, one confirmed its repair but failed
a harness selector, and the final prompt passed. The isolated laboratory used
synthetic data and the authorized local development provider credential; it did
not mount the user's private Grok profile. This is historical inference evidence
for the vision artifact identified in that receipt; inference was not repeated
against the later final source/license shell.

## Outstanding release evidence

Real S24 installation/keyboard/Doze,
network handoffs, real push delivery, production TLS/custom proxy/Tailscale,
Windows lifecycle and Apple devices remain separate qualification. So do the
long-duration and publication gates in the release plan. Unit quota/erasure
checks are not a hardware storage-pressure or forensic erasure guarantee.
The global budget currently reads stored rows inside its reservation transaction;
latency under a browser filled near 100 MiB still needs measurement. Old relay
qualification must not substitute for direct-path observations.

## Production build fail-closed

Vercel invokes `pnpm build:remote`. `FABRIALS_REMOTE_CRYPTO_DIST` must identify the
compiled Noise JS/WASM pair; absent or invalid assets fail the build. The remote
artifact workflow builds that pair from a pinned libraries revision and packages
the prebuilt deployment. No Vercel settings or deployments were changed here.

[evaluation/direct-final-artifact-2026-10-13.json](evaluation/direct-final-artifact-2026-10-13.json)
records the final local review artifact: **50 payload files**, comprising the
47 PWA distribution files, two installers and deployment configuration. Its
manifest SHA256 is
`b39a7c8d3594dd192ecd0601fe93ef89ef0e1c2970c054ff831a18dc5c2ec4fa`,
which also identifies the deployment manifest in the final browser receipt.
The PWA files match the native embed byte for byte. Ordinary verification passes;
`--for-deploy` exits 1. Both source checkouts are dirty, no corresponding-source
archive was supplied and `deployCandidate` is false. The source/release gate
remains closed; this is not a deployable distribution or CI/deployment evidence.

## Corresponding source and dependency notices

The computer list and Computer settings now provide Source and license without
requiring a session disconnect. The dialog offers source, license and dependency
notice links only from metadata matching the loaded shell identity. It never
substitutes the current deployment’s archive for an older cached shell. Review,
offline and missing-source states offer no guessed link. Tests exercise lazy
fetch, bounded streaming, wrong versions, unsafe links, clean identities,
keyboard open/cancel, focus return and cancellation of late responses. Direct
settings remain available with all experiment flags disabled. An integration
regression exposed nested dialog cancellation closing both dialogs; the inner
cancel now stops propagation and returns to settings without losing the draft.

The build emits the original license texts for 113 installed dependency versions,
including Tailwind’s emitted CSS and Vite runtime helpers. Notices participate in
the shell identity. The artifact gate binds the entire shell, installers and
hosting configuration to the corresponding-source archive verified by Spanreed.
A deployment check requires the clean reviewed native release checkout and
reconstructs archive Git trees; source-free builds remain review artifacts.
Independent review caught and closed a worker-verification code-execution flaw:
the artifact checker now reads literal metadata without running supplied code.

These gates are implemented and tested using synthetic source archives. No
clean real source archive, production deployment or N/N-1 source-retention
hosting arrangement was published or qualified. The final 35-check browser
receipt qualifies the source UI using real missing metadata and synthetic
positive metadata; it does not turn those fixtures into source-distribution
evidence. The earlier 27-check browser and 13-check vision receipts remain tied
to their respective earlier artifacts.
