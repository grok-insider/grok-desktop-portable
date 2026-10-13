# Public release implementation

Accepted product contract, 2026-10-13. This supersedes the relay-first deployment
in ADR 0019. Existing evaluation receipts remain historical evidence for their
recorded artifacts; they do not qualify later candidates automatically.

The implemented paths and their local evidence are recorded below. Public
launch remains blocked by the explicit operational, distribution,
hardware and elapsed-time gates. No commit, push, deployment or daily service
installation was performed in this implementation round.

Follow-up preparation uses `https://grok.fabrials.com` as an explicitly selected
qualification origin, with a separate hosting configuration and native pairing
selection. The default remains `desktop.grok.me`. The new origin change passed
799 frontend tests and 18 artifact tests, but its real builds and socket checks
were blocked by the current sandbox. Earlier browser, vision and lifecycle
receipts qualify their recorded artifacts only. Integration order, source
packaging, hosting checks and outstanding environment restrictions are in
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
| Preserve drafts across upgrades | Version mismatch and malformed remote messages never count as authenticated revocation | Implemented and covered by PWA tests; real N/N-1 release upgrade qualification pending |
| Direct multi-host transport | Pair/reload/revoke on Tailscale and custom TLS, isolated data per endpoint/installation/pairing, no Fabrials requests | Implemented; real Noise/native socket exercised in an isolated TLS browser laboratory; production TLS/Tailscale pending |
| Offline installed application | Block all three Fabrials domains; shell opens and paired host remains usable; explicit atomic updates | Implemented; isolated browser checks cover blackholed application origin and blocked Fabrials domains; physical S24 qualification pending |
| Native lifecycle | Socket preflight before writes, Windows ACL/reparse checks, installer/update/restart/rollback on each supported OS | 16 Linux CLI lifecycle checks passed; transactional Linux updater implemented; Windows self-update blocked pending safe process supervision and executable ACL validation; installed-service qualification pending |
| Typed multimodal contract | Versioned content, bounded chunk transfer, validated MIME, real ACP images, queue/replay/history and drafts preserve content | Host/PWA implemented; real PWA/Noise/Spanreed/official ACP/provider/history vision passed 13 checks; device qualification pending |
| Private notifications | Host-owned VAPID, direct provider delivery, generic content, local revocation | Implemented and synthetic encryption checked; real provider/S24 delivery pending |
| Publication authorization | First-party Fabrials login, one-use code plus PKCE, scoped host grant, no third-party cookie dependency | Implemented across PWA, host and web; public routes remain closed |
| Publication retention and budgets | Atomic admission, real byte accounting, terminal expiry/revocation, snapshots cannot recover deleted content | Implemented with real PostgreSQL/S3/key-process tests; infrastructure/restore/perimeter gates remain closed |
| Release packaging | Canonical vendor sync, exact artifact hashes, source bundle, installers and rollback | Canonical libraries compiled in a temporary Spanreed copy; frontend artifact tooling includes WASM, hashes and reviewed installers; clean vendor/source distribution and platform release qualification pending |
| Product qualification | Exact candidate on Linux/Windows/S24, browser engines, accessibility, network failures, 24-hour soak | Pending |

## Private content

Bootstrap, replies, events and ordinary commands retain envelope version 2.
Image operations use envelope version 3, negotiated separately through
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
tabs the last completed transaction wins; there is no host observation watermark
that establishes which tab saw the newest content. An offline device cannot learn
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

## Candidate evidence and unresolved boundaries

These checks qualify local code paths, not the complete public product:

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

Browser authentication introduces revocable `bsid` families. External SSO
consumers that only check token signatures, including the separate admin
product, must adopt the family check before a cutover can promise immediate
revocation. An older backend is not a safe rollback for this guarantee. No
external consumer or production authentication deployment was changed here.

The S24 candidate trial still needs a current available device window. Windows
is not qualified: the VM's guest agent responded, but the Syl device execution
channel remained stale and the cross-toolchain was unavailable. Prior device
and relay receipts cannot substitute for this candidate. Source distribution,
installed services, production TLS/Tailscale and real push delivery remain
release work alongside the infrastructure and elapsed-time gates below.

## Final qualification

Run the complete suites against canonical libraries and the final artifact,
including PostgreSQL, S3, native HTTP, WASM and browser tests. Use synthetic data.
Verify Linux and Windows host lifecycle, real S24 installation/keyboard/rotation,
Android share target, network changes, process death and 30-minute/8-hour sleep.
Exercise multi-host and multi-browser isolation, control transfer, permissions,
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
