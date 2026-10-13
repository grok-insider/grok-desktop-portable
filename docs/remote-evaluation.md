# Grok Remote evaluation

This program evaluates the Portable PWA, Spanreed host, shared libraries and
the optional Fabrials publication service. Paired private access must work
without a Fabrials account or relay. The current release contract is
[`public-release-plan.md`](public-release-plan.md); the original experiment
catalogue and dated receipts also contain superseded relay and control-transfer
experiments. Those remain historical evidence, not current release requirements.
An experimental implementation is not
an acceptance result. The machine-readable criteria are in
[`experiments/remote-evaluation.json`](experiments/remote-evaluation.json).

## Reproducibility

Freeze tracked files and non-ignored untracked files before each candidate.
Record the source manifest, executable and served JavaScript/WASM hashes.
Preserve the original Git index separately. The original evaluation started from
four uncommitted worktrees; it is not a release qualification. Do not edit a
consumer's vendored libraries to make the release gate pass. Integration copies
may combine canonical sources, but their manifests must say so.

Keep one evidence receipt per experiment and candidate. A passed check must
reference evidence for that exact source manifest. A mobile observation from a
previous version or a window without participation cannot qualify a new
candidate. Never store pairing URLs, cookies, account credentials or private
conversation content in reports.

```sh
corepack pnpm test:remote-evaluation
node scripts/remote-evaluation.mjs docs/experiments/remote-evaluation.json \
  /path/to/input.json /path/to/evidence /path/to/new-result.json
```

The evaluator verifies evidence hashes and confines paths, including symlinks,
to the evidence directory. Output creation is exclusive. Exit status is 0 for
`keep`, 1 for `revise`, `discard` or `inconclusive`, and 2 for an invalid receipt.
It validates evidence identity and declared checks; a reviewer must still
confirm that the referenced evidence demonstrates each assertion.

## Decision rules

Required correctness failures stay open until fixed, even if an implementation
is discarded. Missing checks and missing physical-device observations are
inconclusive. Optional features need demonstrated benefit and, where specified,
utility of at least 4 out of 5 in the final user session. Run at most two rounds
without a new recorded hypothesis.

Performance uses eight paired blocks, four AB and four BA, with 50 warmups and
200 measured samples per variant. Compare nearest-rank p95 per block; use the
median paired reduction and a 10,000-resample bootstrap with seed 18391.
Inference time is excluded from transport and rendering measurements.

| Experiment | Benefit needed | Guard |
|---|---|---|
| Event delivery | At least 20% and 20 ms reduction, positive 95% interval, in both channel conditions | Journal replay, revocation and slow consumers remain correct |
| Long conversations | At least 20% for 1,000 and 10,000 items | At 100 items, no regression above 10% beyond a 2 ms tolerance; selection, copy, search, order, scroll and accessibility retained |
| Publication cost | At least 30% less CPU or bytes read for ten unchanged shares | Same published document; propagation delay no more than baseline + 250 ms |

Non-target resources must not regress by more than 10%; idle CPU permits one
percentage point of absolute variation. CPU during work is not idle CPU, and
context switches are not wakeups. Missing resource measurements prevent a final
performance acceptance. Native microbenchmarks do not qualify relay, WASM,
browser or mobile latency.

## Experimental switches

All optional browser variants are off in ordinary builds. Build with
`VITE_REMOTE_EXPERIMENTS` containing comma-separated names to opt into an
evaluation. The available names are declared in
`apps/web/src/services/experiments.ts`. Browser selection never enables host
permissions or changes the agent's advertised capabilities.

| Variant | Current candidate | Remaining acceptance |
|---|---|---|
| `drafts` | Explicit opt-in; strict durable IndexedDB transactions; account/host/key/installation/session scope; seven-day validity | Physical Android process eviction and S24 utility |
| `transcript` | Memoized completed rows and indexed checkpoint lookup, with all transcript DOM retained | Non-target resource measurements and physical-device validation |
| `dictation` | Browser recognition, review field and explicit insertion into draft | Ten paired tasks including correction time, microphone/network failure and S24 utility |
| `speech-playback` | Browser-advertised local voices only, bounded chunks, pause/resume/stop, cancellation on session/access change | Actual audio, long-answer comprehension and S24 utility |
| `share-target` | Bounded multipart inbox, explicit destination/review, atomic claim, cancellation and duplicate detection | Installed-PWA handoff and task-step reduction on S24 |
| `remote-projects` | Locally authorized roots, opaque expiring directory handles and explicit enrollment; managed PWA browsing checked | S24 utility |
| `control-transfer` | Legacy connection-bound control experiment; superseded for direct protocol 4 by concurrent paired writers and a durable host FIFO | Historical experiment only; current acceptance covers concurrent enqueue, targeted stop, stale revisions and receipt recovery |
| `device-panel` | Authenticated browser list, connection state and explicit revocation | Physical-device usefulness and final combined recovery receipt |
| `push` | Explicit permission, encrypted subscriptions, bounded event delivery and revocable action resolution | Real foreground/background/closed-app delivery and S24 utility |

Draft validity is checked on access. A closed browser cannot guarantee physical
erasure exactly seven days later. Dictation may use the browser vendor's speech
service and starts only after the user chooses the microphone action. Neither
dictation nor share reception may submit an agent command automatically.

The host event experiment is selected with
`SPANREED_REMOTE_EXPERIMENT_EVENT_DELIVERY=notified`. Polling remains the default.
Journal contents and access checks remain authoritative in both variants.

## Capability probes

```sh
python3 scripts/probe-acp-capabilities.py /path/to/new-capability-result.json
```

The probe runs only ACP initialization in an isolated Grok home and shuts down
its child. It does not create a conversation, call a model or inspect user
credentials. On the tested station binary, Grok 1.0.52 advertises
`embeddedContext: true`, `image: false` and `audio: false`. The image flag proved
inaccurate for that binary: subsequent real ACP image blocks and random
image-only facts passed with the official CLI and provider. The exact binary,
endpoint and full-chain scope are recorded in
[`public-release-plan.md`](public-release-plan.md#private-content). The host
uses its qualified compatibility rule, not a general override for unknown CLI
versions. Audio ACP remains unsupported. Sending base64 inside a text prompt
is not vision acceptance. New versions still need the known-image,
corrupt-file and MIME-mismatch experiments.

The retained official Grok 1.0.50 executable advertises the same three input
capabilities as 1.0.52. Neither result proves image understanding. The probe
records the executable path hash; on Nix that path may be a launcher rather
than the underlying executable.

## Browser and device environments

Desktop visual qualification uses a disposable Chrome profile inside Syl's
headless Sway compositor at 2560 × 1440 and DPR 1, matching station's principal
screen. It does not move or resize the daily Chrome window. Record renderer
details: the current nested compositor uses Pixman and Chrome reports software
composition, so these results do not qualify NVIDIA desktop composition.

Chromium, Firefox and WebKit cookie tests use isolated contexts and synthetic
accounts. WebKit tests do not qualify an iPhone. Android acceptance uses the
S24 in one final 45–60 minute session after automated checks. Record reload,
offline, suspension, process eviction and Wi-Fi/mobile handoff separately.
The 30-minute and eight-hour suspension checks require their actual durations.
iPhone, macOS and hardware DeX remain unqualified until hardware is available.

## Remaining program

The current release requires clean distribution/install/update/rollback,
terminal continuity on the qualified official binary, direct transport recovery
and a 60-minute load test, and publication after browser closure and host
revocation. The original catalogue's relay readiness/drain and control-transfer
requirements apply only to those historical candidates. Multi-device acceptance
instead exercises concurrent writers, a single active turn per session, FIFO,
targeted stop, configuration conflicts and uncertain receipts. Optional
candidates cover approved project roots, push, device management, onboarding
diagnostics and Syl actions. No row is
accepted merely because unit tests for a related component pass.

After individual results, build the selected combined candidate and repeat
cross-feature correctness and recovery checks. Promote only features whose
receipts support the decision. Keep required failures and inconclusive device
checks visible in the final report; no production deployment is implied by
this evaluation.

## Automated evidence, 2026-10-13

Central decisions and their source hashes are retained in
[`evaluation/2026-10-13/index.json`](evaluation/2026-10-13/index.json). That index
records whether all twenty results have been collected. It is separate from
release qualification and physical-device acceptance. Large evidence and test
profiles remain private; credentials are excluded from the checked-in report
files. Their existence does not mean these local changes have been committed.

- Authentication covers 600 browser rounds and 1,800 authenticated requests in
  Chromium, Firefox and WebKit, with and without Web Locks, plus native sessions.
  It uses synthetic accounts and isolated HTTPS origins, not production OAuth.
- Terminal continuity uses the official Grok 1.0.50 and 1.0.52 executables and the
  real shared ACP leader, in both directions, with explicit permission, observer,
  reconnect and adapter-loss checks. It does not add a visual TUI acceptance.
- Native control covers fifty actual transfers, stale epochs, old connections
  and revocation. The complete PWA also transfers control between independent
  browsers and checks account/host isolation and revocation through Noise.
- Publication uses the actual host publisher, PostgreSQL, authenticated private
  S3 and a controlled lost response. It covers consent, closed browser, changed
  tail, unchanged content, retry, host restart and offline-host revocation.
  PWA preview and cancellation are checked separately against native history.
- Durable drafts were introduced after abrupt Chrome death lost localStorage
  data despite a prior apparent save. The corrected implementation confirms
  strict IndexedDB completion, coalesces edits, bounds pending work and prevents
  an old write or revocation callback from reviving obsolete state. A real
  SIGKILL after the last confirmed edit, persistent-profile restart, worker
  update, offline reload, quota refusal and seven-day expiry all have evidence.
- The actual managed PWA exposed a missing WASM module URL that the simulated
  connector tests could not detect. Passing the explicit adjacent WASM URL
  restores real browser pairing. Browser-engine results identify exact bundles;
  an engine passing isolated auth is not sufficient to qualify its full PWA.
- Share reception uses actual worker POST/303 handling and IndexedDB. It checks
  text, URL, file, destination selection, signed-out state, duplicate pending
  intents, editable append, cancellation and page closure/reopening. Android's
  share sheet and installed-app cold launch require physical observations.
- The combined PWA discovered a WebKit block when querying a push subscription
  without notification permission. The candidate queries a subscription only
  with granted permission, with failing-before tests for default and denied
  states. Actual Web Push delivery remains separate from API readiness.
- The ordinary Spanreed candidate is compiled in a disposable integration copy
  with canonical libraries and exact ordinary PWA assets. Tests, clippy, format
  and embedded-asset integrity are recorded in its receipt. No real vendor tree,
  daily installation, service-manager configuration or release is changed.
- The clean release gate refuses uncommitted inputs as intended. That refusal
  is not bypassed and is not a completed release check. Local binary lifecycle
  tests do not qualify network installation or self-update.

The event, transcript and publication-cost benchmarks show improvements within
their measured scopes. Actual wakeups, idle CPU and resident-memory guards are
incomplete, so none receives final performance acceptance. The transcript
retains complete DOM order, selection/copy, native string search, keyboard and
an equivalent accessibility tree at 100, 1,000 and 10,000 items. This does not
establish a screen-reader experience, browser Find-toolbar behavior or mobile
performance. Nested Chrome uses software composition.

The final S24 session follows
[`remote-mobile-evaluation.md`](remote-mobile-evaluation.md). Earlier physical
checks keep their original artifact identity; they cannot replace current
participation, recognition, audible speech, OS sharing or notification delivery.
