# Public release implementation

Accepted product contract, 2026-10-13. This supersedes the relay-first deployment
in ADR 0019. Existing evaluation receipts remain historical evidence for their
recorded artifacts; they do not qualify later candidates automatically.

The implemented paths and their local evidence are recorded below. Public
launch remains blocked by the explicit operational, distribution,
hardware and elapsed-time gates. Six draft PRs carry the integration. The
2026-10-14 multi-device candidate is deployed only on the qualification domain;
its exact sources, deployed TLS/CDN checks, N/N−1 browser update and station
verification are recorded in [the current receipt](qualification-evidence-2026-10-14.md).
This is not a public-launch qualification.

The second 2026-10-14 qualification deployment uses Portable `00393e13`, libraries
`64874102` and Spanreed `7e2a7816`. Its 905 PWA tests, three 96-check image/layout
laboratory runs, deployed HTTP checks, 18-check browser update and 19-check
two-browser revocation trial are bound to exact artifact hashes in the current
receipt. The S24 push trial belongs to the earlier deployment; this candidate's
physical-device and elapsed-time gates remain open.

Follow-up preparation uses `https://grok.fabrials.com` as an explicitly selected
qualification origin, with a separate hosting configuration and native pairing
selection. The default remains `desktop.grok.me`. Its real build, sockets,
source archive and 37 browser checks are bound to the exact candidate and hashes
in [the dated qualification receipt](qualification-evidence-2026-10-13.md).
Earlier browser, vision and lifecycle receipts qualify their recorded artifacts
only. Integration order, source packaging and outstanding hosting checks are in
[qualification-merge-deploy.md](qualification-merge-deploy.md).

## Product boundary

`desktop.grok.me` supplies the installable PWA. Private traffic goes directly to
the user's Spanreed over HTTPS/WSS on Tailscale or a user-managed domain. Noise
binds the device and host independently of TLS termination. Account availability
must never gate an already paired private session. No automatic relay fallback.
A future paid relay is an explicit transport adapter, disabled for this release.

Linux and Windows hosts, Android and qualified desktop browsers are intended
release targets; unqualified candidates must not claim that support. Apple platforms remain experimental behind explicit opt-in until real
hardware qualifies them. This work changes no repository visibility. Review the
existing public/private settings before release; packaging must distribute
corresponding source and license notices without requiring access to private
repositories.

## Ordered work and evidence

| Work | Acceptance gate | Current state |
| --- | --- | --- |
| Preserve drafts across upgrades | Version mismatch and malformed remote messages never count as authenticated revocation | Implemented; exact N/N−1 shell transitions preserve a live synthetic turn, queue and draft in two browsers; physical-device release qualification pending |
| Direct multi-host transport | Pair/reload/revoke on Tailscale and custom TLS, isolated data per endpoint/installation/pairing, no Fabrials requests | Implemented; two independent browsers paired and reconnected against deployed trusted TLS/Tailscale; custom TLS and multi-host release qualification pending |
| Offline installed application | Block all three Fabrials domains; shell opens and paired host remains usable; explicit atomic updates | Implemented; isolated browser checks cover blackholed application origin and blocked Fabrials domains; physical S24 qualification pending |
| Native lifecycle | Socket preflight before writes, Windows ACL/reparse checks, installer/update/restart/rollback on each supported OS | Transactional Linux updater passes 31 tests including process interruption; Windows Job/ACL implementation remains gated until real guest qualification; installed-service qualification pending |
| Typed multimodal contract | Versioned content, bounded chunk transfer, validated MIME, real ACP images, queue/replay/history and drafts preserve content | Host/PWA implemented; real PWA/Noise/Spanreed/official ACP/provider/history vision passed 13 checks; device qualification pending |
| Private notifications | Host-owned VAPID, direct provider delivery, generic content, local revocation | Implemented and synthetic encryption checked; real provider/S24 delivery pending |
| Publication authorization | First-party Fabrials login, one-use code plus PKCE, scoped host grant, no third-party cookie dependency | Implemented across PWA, host and web; public routes remain closed |
| Publication retention and budgets | Atomic admission, real byte accounting, terminal expiry/revocation, snapshots cannot recover deleted content | Implemented with real PostgreSQL/S3/key-process tests; infrastructure/restore/perimeter gates remain closed |
| Release packaging | Canonical vendor sync, exact artifact hashes, source bundle, installers and rollback | Exact QA artifact and original native/Rust/WASM notices verified; public N/N−1 source/notice retention and browser rollback passed; platform release installers pending |
| Product qualification | Exact candidate on Linux/Windows/S24, browser engines, accessibility, network failures, 24-hour soak | Pending |

## Multi-device integration, 2026-10-14

Paired devices belonging to the same owner can enqueue into one durable shared
queue. Ordinary enqueue does not require a queue revision. Stop identifies one
specific host turn and pauses the remaining messages; interrupt-and-enqueue and
clear use explicit revision checks. A revoked origin's queued entries remain
held. An ambiguous turn requires review against the same turn ID and upstream
idle confirmation, and the queue stays paused after review.

The PWA presents host-authoritative messages without optimistic duplicates,
per-session queue/configuration state and explicit recovery of uncertain action
receipts. Receipt metadata is stored before an effect; it contains identifiers,
kind, state and time only. A lost response never causes an automatic retry.
Storage failures block new affected actions. Checking a receipt cannot clear or
resend a draft. Continuing after review and clearing a possible duplicate draft
are explicit separate choices. Image submission follows the same receipt path.

Models and efforts are session-scoped and sourced from live ACP confirmations,
including custom model IDs. Stale or unavailable choices are not selectable.
Configuration requires an idle stable conversation. Official Grok Build 1.0.52
was exercised with an isolated local synthetic provider: custom model selection,
effort confirmation, conditional cancellation and an obsolete cancellation that
did not stop a successor passed. See `evaluation/acp-runtime-2026-10-14.json`.
This is a protocol qualification without paid inference, not a promise for other
CLI versions. Unobserved external terminal turns cannot be remotely cancelled.
Direct `!` shell mode remains unavailable in shared conversations; the UI now
says so and preserves the draft. Grok's permission-mediated tools remain usable.

The subsequent [interactive-terminal qualification](terminal-continuity-qualification.md)
passed 22 checks with native `f3ebb334` and the unchanged deployed shell. An
official Grok 1.0.52 TUI and a real browser exchanged five synthetic turns over
one shared leader. A pending permission survived browser reload, terminal
approval executed one effect, and browser denial of the identical command's
next request cancelled the terminal turn without a second effect. The test
used an isolated profile and local provider; public TLS, personal sessions and
concurrent terminal submissions during an active turn remain separate checks.

The initial multi-device PWA verification passed 881 tests and TypeScript checking. Hidden Chrome
155 passes 53 checks with two independently paired browser contexts, real Noise
and a deterministic ACP fixture: FIFO, custom models/efforts, stale configuration
and queue revisions, reconnect, missing catalogues, offline storage and local
deletion. See `evaluation/direct-multiwriter-browser-2026-10-14.json` for artifact
hashes and the precise scope. A reconnect during a turn exposed stale activity
from the workspace list; tabs now derive it from the live execution state. A
regression test fails with the old behavior. Conflict notices expire instead of
leaving a stale error banner, and the queue status has its own row on mobile.
This evidence does not qualify inference, physical devices or deployed transport.

Private push has a bounded durable outbox, coalescing, six attempts within a
fixed fifteen-minute TTL, provider response handling, four workers and durable
per-registration/global rates. Generic notices carry no conversation content.
The service worker validates expiry and deduplicates durable notice IDs locally.
Real provider delivery and suspension on the final S24 artifact remain required.
Speech playback selects only a browser-advertised local voice and fails closed
without one; it remains experimental until device qualification.

## Private content

Bootstrap, replies and events retain envelope version 2. Shared host mutations
use negotiated protocol 4 with host-owned durable FIFO, principal-scoped
idempotency and one active turn per conversation. Up to eight conversations
can run in parallel. Older shared clients remain read-only. Image operations
retain content protocol 3, negotiated separately through
`contentProtocolVersion: 3` and upstream image support. An incompatible host preserves unsent data. Never replay an uncertain
command; reconcile its durable receipt. Enrolled projects use opaque IDs.

Image limits: eight per message, 25 MiB per original, 50 megapixels, 100 MiB per
selection and 5 MiB aggregate normalized content. Chunks are 32 KiB with two
transfers per connection; permissions and control retain priority. Detect real
formats, decode with bounds, apply orientation and remove location metadata.
An upstream `image_dropped` is visible failure, even if text generation succeeds.
Audio ACP remains unsupported; browser dictation requires review before sending.

Grok Build 1.0.50 and 1.0.52 accepted image ACP blocks in isolated HTTP contract
tests despite advertising `image:false`. On 2026-10-13, official 1.0.52 with
`grok-4.7-build` also read two independent random eight-digit facts that appeared
only in generated images (6.273 and 4.069 seconds). Neither trial used tools,
requested permissions or emitted `image_dropped`; the private profile was not
mounted. See `evaluation/2026-10-13/real-acp-vision.json` and
`scripts/qualify-acp-vision.py`. This qualifies ACP/provider vision for that
binary and endpoint, not arbitrary CLI versions.

The full PWA/Noise/Spanreed/official ACP/provider path subsequently passed 13
checks with another random image-only fact, recognized in 3.797 seconds. The
image and answer survived a real host-history reload, with no tools, permission
requests, dropped images or private browser calls to Fabrials. Spanreed's
`docs/evaluation/direct-vision-2026-10-13.json` binds this evidence to both native
binary hashes and the exact frontend files. This vision trial predates the final
updater and source/license UI artifacts; no additional inference was performed
against those final artifacts. Four real prompts were used across
the investigation: the first two exposed a default transcript renderer that
omitted images, the third confirmed the fix but failed an overly broad harness
selector, and the fourth passed completely. The renderer now shares `MessageRow`
between both transcript modes. This laboratory does not qualify real TLS,
Tailscale, mobile devices, suspension, push or publication.

Offline history has consent separate from drafts, a 1 MiB limit per conversation
and a seven-day TTL from changed content. It contains messages and tool summaries,
without reasoning, executable actions or image binaries. History and drafts share
a 100 MiB browser budget. Drafts expire after seven days. Saved means the durable IndexedDB transaction committed. The service
worker caches static application files only. Session IDs and pairing material
stay in local state or a URL fragment, never hosting paths or query strings.
Deletion is fenced against queued writes and invalidated between tabs. Across
tabs, each write compares the host observation `(observationEpoch, eventSequence)`
inside the same IndexedDB transaction. Older, equal or unversioned observations
cannot replace a newer versioned copy. The host increments and durably writes its
epoch before serving after restart; snapshot copies wait for their final atomic
watermark. Identical content never renews retention, including across a restart. An offline device cannot learn
about host revocation until it reconnects. These local private copies are distinct
from the public hosting deletion contract.

## Publications and irreversible removal

The user explicitly opts selected content into Fabrials hosting. New published
content extends expiry to seven days after successful activation. Visits,
retries, identical revisions, title changes, corrections and removal do not.
Expiration and withdrawal are terminal; republishing requires new consent and
a new URL. Never delete the user's private original.

Publication content, titles and renewal fingerprints are encrypted in the
candidate. Operational account/host relationships, grants and admissions remain
in PostgreSQL and require the exclusion from recoverable backups described below.
Two redundant RAM key processes are implemented. Keeping their keys outside
backups, swap, crash dumps and checkpoints is an infrastructure requirement still
awaiting qualification. Complete cryptographic erasure requires acknowledgment from both or verified
fencing of an unresponsive node. Partitions fail closed; old nodes erase their
maps before rejoining. Losing all keys invalidates links permanently. Restoring
Postgres or S3 snapshots must never restore readable withdrawn publications.
Physical cleanup reconciles late and uncertain PUTs. Report access withdrawal,
pending deletion and verified cleanup distinctly. Downloaded third-party copies
cannot be recalled.

The operational metadata plane must be excluded from recoverable backups while
durable aggregate metering survives restore. Fencing must block admission after
restore until reservations, writers and physical objects are reconciled. Every
process handling plaintext (including web, image codecs and TLS termination)
must exclude swap, core/heap dumps, checkpoints and payload logging. Clearing
buffers does not establish immediate forensic erasure of JavaScript strings or
browser copies. These are launch requirements, not claims established by unit
tests or a key-node-only deployment.

## Fixed resource budgets

| Resource | Limit |
| --- | --- |
| Active publications / account | 5 |
| Creates / account / UTC day | 10 |
| Text / publication | 2 MiB, 10,000 entries |
| Entire publication | 10 MiB |
| Accounted storage | 100 MiB / account; 10 GiB global |
| Concurrent uploads | 1 / publication; 2 / account; 4 global |
| Revisions | 1 / minute / publication; 300 / UTC day / account |
| Account ingress | 100 MiB / UTC day; 500 MiB / rolling 30 days |
| Global ingress | 2 GiB / UTC day; 20 GiB / rolling 30 days |
| Publication egress | 250 MiB / UTC day |
| Account egress | 1 GiB / UTC day; 10 GiB / rolling 30 days |
| Global egress | 10 GiB / UTC day; 100 GiB / rolling 30 days |
| Processing encrypted objects / publication | 250 MiB / UTC day |
| Processing encrypted objects / account | 1 GiB / UTC day; 10 GiB / rolling 30 days |
| Processing encrypted objects / global | 10 GiB / UTC day; 100 GiB / rolling 30 days |
| GET/HEAD requests / minute: publication, account, global | 60; 120; 600 |
| GET/HEAD requests / UTC day: publication, account, global | 10,000; 50,000; 500,000 |
| Concurrent GETs | 32 global, additional IP request limits |
| Initial reservation | 5 minutes |

Reserve atomically before consuming a body; measure actual streamed bytes.
Pending, active, withdrawn and uncertain writes consume storage until cleanup
is verified. Deleting/recreating never resets budgets. Retries and errors count;
HEAD/Range/empty requests also have request limits. Reject compressed requests.
Warn at 80%, pause at 100%. Never auto-increase resources, charge, or delete early
to free budget. Read exhaustion pauses delivery; write exhaustion pauses sync.
Revocation, expiration and garbage collection have independent capacity. Public
HEAD status and account listings share bounded data capacity and may pause under
load; they must never be required to invoke withdrawal.
Keep only aggregate consumption counters after erasure.

Read request charges are not refunded on cancellation or failure. The minute
window conservatively includes the previous full minute. HEAD uses metadata and
key-presence checks only, without fetching or decrypting S3 content, and consumes
a 1 KiB protocol provision. Public reads use key-node data slots; withdrawal's
absence checks retain their independent control slots.

Internal reads have a separate, non-refundable processing budget. Reserve the
entire encrypted object size from the durable inventory before each S3 read and
decrypt, including a revision's previous-object read. Cancellation, S3/decryption
errors and a small public response with a large fingerprint history retain that
charge. Egress continues to measure delivery separately. HEAD performs no object
read and consumes no processing budget. These application bounds still require
the physical perimeter controls below.

Isolate publication CPU/RAM/connections. No autoscaling. Include encrypted bytes
retained in snapshots and physical headroom in operational admission. Do not
delete other products' snapshots. Existing object storage has no multipart API.

## Historical candidate evidence, 2026-10-13

These checks qualify the recorded local code paths, not the complete public
product. They are preserved for the original candidate; the multi-device section
above and the current integration status below describe subsequent work.

- Agent host: 498 all-targets tests passed and strict Clippy passed. The image
  path includes actual ACP bytes, durable receipts, observers and queued sends.
- Canonical libraries compiled into the normal Spanreed binary in a temporary
  copy. The consumer's real vendor directory and the pre-existing staged work
  remain unchanged. See Spanreed's
  `docs/evaluation/direct-lifecycle-2026-10-13.json` for the 16 Linux checks and
  binary hash; no service was installed.
- The PWA's integrated test suite passed 795 tests in 81 files, with TypeScript
  and the encrypted build passing. The final shell passed 35 browser checks in
  hidden Syl Sway, including direct Noise pairing, offline use, durable erasure,
  four viewport sizes, pixel-checked cropping and source/license UI without
  losing the connection, draft or keyboard focus. There were no unexpected
  browser errors; the missing-source case intentionally returned one 404.
  Positive source metadata was synthetic, while the emitted license notices
  were real. No real source archive download was qualified. The 38 ms offline
  navigation is one laboratory measurement, not a p95 or a production promise.
  See [the final browser receipt](evaluation/direct-final-browser-2026-10-13.json)
  and [direct-pwa-implementation.md](direct-pwa-implementation.md) for scope.
- The publication backend passed 214 tests against laboratory PostgreSQL and
  S3 (3,608 assertions), including 50 concurrent processing reservations,
  cancellation, retries, large hidden fingerprint history and quota exhaustion
  with withdrawal still available. Its earlier 34-check qualification command deliberately exits
  with status 1 while production readiness is false. Web TypeScript and a
  Node 22 production build passed. The built server passed nine HTTP checks,
  including publicly accessible consent and closed publication endpoints.
- Real publication components passed 41 checks in hidden Chrome at mobile and
  desktop widths. Web's `docs/evaluation/publications-browser-2026-10-13.json`
  records the precise checks; HTTP responses and the hidden-tab event were
  synthetic. This does not qualify production login, physical tab visibility,
  an Android device or the complete host-to-publication path.
- The final frontend review artifact compiled Noise WASM, verified native/WASM
  interoperability and passed verification of 50 payload files. All 47 shell
  files match the final Spanreed embedded PWA byte for byte. Deployment
  verification rejected its uncommitted source identities as intended; no real
  corresponding-source archive was supplied. See
  [the final artifact receipt](evaluation/direct-final-artifact-2026-10-13.json).
  Fifteen artifact tests, 45 Python source/release tests and workflow actionlint
  passed. The public installer
  now selects a stable release or fails, with no automatic old-version fallback.
  Canonical Spanreed bootstrap installers verify SHA-256 before unpacking or
  replacing anything; the copies served by the web checkout match. Fourteen
  isolated Linux bootstrap tests and 19 Portable installer executions cover
  checksum failures, stable-version selection, invalid destinations and partial
  copies. Five targeted mutations were detected by the regression tests.
  Replacement stages into the destination filesystem before switching the
  executable. The receipt is Spanreed's
  `docs/evaluation/installers-2026-10-13.json`; PowerShell execution, concurrent
  installers and power-loss recovery remain unqualified.
- Corresponding-source packaging exports the exact committed Spanreed and
  Portable trees, with the existing vendored libraries, lockfiles, build recipes
  and notices. Verification reconstructs their Git trees and checks recorded
  build inputs, including the complete shell, installers and hosting configuration;
  release and recovery require the source archive and checksum before
  publication. Source and license links are bound to the loaded shell identity,
  never a newer deployment. Independent review closed stale distribution-file
  proofs and unsafe execution of supplied worker JavaScript during verification;
  the verifier now parses literal JSON metadata. This gate does not qualify a
  dirty development checkout, provide a dependency-license audit or prove
  reproducible native binaries. Hosting must retain sources for versions still
  in use, including N/N-1; that arrangement remains unqualified.
- Linux self-update passed 23 directed tests, two CLI integration checks and
  strict all-targets Clippy. It takes the host's instance lock, validates the
  staged executable and installed version under deadlines, and restores the
  previous executable after ordinary installation failures. Recovery files are
  retained if rollback fails. Windows apply is explicitly disabled before
  lookup/download until process assignment to a Job is atomic and executable
  ACL validation rejects other writers; version checking remains available.
  See Spanreed's `docs/evaluation/direct-update-2026-10-13.json`. This does not
  implement a downgrade after a completed update or power-loss recovery.
- A license-declaration inventory covers 376 packages in the Linux normal
  dependency graph and 110 PWA production packages (111 installed versions).
  It was regenerated against the final temporary integration lockfile and found
  no missing native license declaration. A tested notice generator includes
  complete license texts for 113 installed PWA dependency versions, including
  fonts, Tailwind CSS and Vite runtime helpers; identical notices appear in the
  shell, external artifact and embedded PWA. This is not completed redistribution
  qualification: native/Rust-WASM attribution, MPL, Unicode and CDLA notices,
  the other platform/feature sets and their source requirements still need
  review. See Spanreed's
  `docs/evaluation/release-license-inventory-2026-10-13.json` for scope and hashes.

## Current integration status, 2026-10-14

Browser authentication introduces revocable `bsid` families. Admin and ai-relay
now have draft integration PRs that verify signatures and then introspect the
live browser family, reject malformed or mixed native/browser claims, and fail
closed when introspection is unavailable. Admin additionally matches the signed
identity fields used by its allowlist against the canonical user. Their local
suites and builds passed; production rollout and cross-product logout are not
qualified. Deploy Web's compatible endpoint before these consumers. An older
backend is not a safe rollback for immediate-revocation guarantees.

The canonical host passed 608 tests before the current Windows hardening; the
synced Spanreed consumer passed 2,303 tests with 11 explicit exclusions. These
counts do not qualify later edits automatically. The PWA's initial 881 tests
and 53-check multi-browser receipt are described above. Linux updater recovery
now includes durable phases and process interruption at seven checkpoints;
the earlier lack of power-loss recovery describes the historical implementation.

The S24 candidate trial still needs a current available device window. Windows
strict ACL and suspended Job assignment passed 16 targeted security checks in
the existing guest; updater checks passed 26 normal tests and one opt-in test
under a limited user. Complete installer/upgrade qualification and green
cross-platform CI remain required. Linux station now runs the exact QA native
candidate in its own service, retaining identity and pairings. Real TLS/Tailscale,
two independent browser connections, N/N−1 source retention, browser update and
rollback passed for the deployed candidate. The subsequent 71-check laboratory
trial exercised exact N→N−1→N shells with an active synthetic turn, queued
successor and saved draft, without replay or loss of pairing; its receipt is
`evaluation/active-shell-upgrade-2026-10-14.json`. It is not a second CDN rollout
or a hardware trial. Prior device and relay receipts cannot
substitute for this candidate. Real push, device/platform distribution and the
infrastructure and elapsed-time gates below remain release work.

## Final qualification

Run the complete suites against canonical libraries and the final artifact,
including PostgreSQL, S3, native HTTP, WASM and browser tests. Use synthetic data.
Verify Linux and Windows host lifecycle, real S24 installation/keyboard/rotation,
Android share target, network changes, process death and 30-minute/8-hour sleep.
Exercise multi-host and multi-browser isolation, simultaneous writers, targeted
stop, configuration conflicts, permissions,
receipt reconciliation and N/N-1 updates. Attach the final candidate to an
existing official Grok terminal session and hand control back in both directions.
Validate real model vision with random
image-only facts. Qualify microphone, audio and push on real devices.

Publication tests include controlled-clock expiry and a real seven-day cohort,
concurrent activation/withdrawal, late PUT, S3 outage, restore from backups and
snapshots, key-node partition/loss/rejoin, 50 simultaneous reservations and
saturation while revoking. No critical/high findings may remain.

Reference network: 100 ms RTT. Targets: editor p95 <100 ms, event-to-paint p95
<100 ms, host acknowledgment p95 <500 ms excluding inference, reconnect <5 s
after stable network, installed S24 shell <2 s. Record CPU, RSS, wakeups and
battery alongside AB/BA comparisons, a 60-minute load run and 24-hour soak.

Release cohorts: internal, then 10 invitees for at least seven days, then 50 and
200. Advancing a cohort does not increase budgets. Three new users must complete
installation from the published instructions. Prepare source, hashes, rollback,
support and operational evidence before opening access; do not label skipped
hardware or elapsed-time tests as passed.
