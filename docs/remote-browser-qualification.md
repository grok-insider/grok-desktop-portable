# Isolated Remote browser qualification

The local browser laboratory uses a disposable Chrome profile inside Syl's
hidden Sway compositor, at 2560 × 1440 and DPR 1. CDP targets and isolated
browser contexts keep these tests away from the daily desktop. Software
composition in this laboratory does not establish GPU performance.

The following runners are prepared for the evaluation. A runner's existence
does not mean it has passed. Results belong to their private output directories,
including source or artifact hashes and explicit limitations.

```sh
bun scripts/qualify-voice-browser.ts /path/to/new-voice-evidence
bun scripts/qualify-draft-recovery.ts /path/to/frozen-combined-fixture \
  /path/to/new-draft-evidence
bun scripts/qualify-managed-browser.ts /path/to/managed-fixture \
  /path/to/new-browser-evidence
bun scripts/qualify-managed-extras.ts /path/to/managed-fixture \
  /path/to/new-worker-evidence
bun scripts/qualify-managed-recovery.ts /path/to/managed-fixture \
  /path/to/new-recovery-evidence
bun scripts/qualify-managed-layout.ts /path/to/managed-fixture \
  /path/to/new-layout-evidence
```

Set `REMOTE_QA_CDP` to the isolated browser's loopback CDP address and
`REMOTE_QA_PLAYWRIGHT` to an installed Playwright module when needed. The
runners close their own contexts, disconnect CDP and stop their local server.
They do not open or raise host windows.

The voice runner mounts the real Dictation and SpeechPlayback components with
simulated recognition and synthesis events. It checks denied permissions,
silence, network failure, explicit review and insertion, refused insertion,
late callbacks, access loss, session changes and ordered playback chunks.
Neither actual recognition nor audible speech quality is inferred from those
checks; both require the physical-device session.

The draft runner serves a frozen synthetic Remote fixture in a dedicated
persistent Chrome profile inside the hidden compositor. It registers the real
service worker, replaces its cache version, checks offline recovery and waits
for the product's durable IndexedDB completion indicator. It then kills only
its own browser process group with SIGKILL and restarts the same profile on the
same origin. The last edit is made immediately before this check; no artificial
flush delay is used. Expired records and an injected quota failure exercise
retention and recovery without submitting a prompt. This does not qualify
Android process eviction or physical power loss.

`REMOTE_QA_CHROME` selects the browser executable;
`REMOTE_QA_NESTED_ENV` names a private JSON file containing the owned compositor's
Wayland environment. Neither may target the daily browser profile. The report
records worker, fixture and runner hashes, confirmation-to-kill delay, and
owned-process cleanup.

## Managed integration laboratory

`apps/web/qa/build-managed.mjs` builds the actual PWA with optional capabilities
enabled for evaluation. It changes only generated fixture boundaries: account
origin, encrypted relay URL, Remote entry origin and worker account origin.
The production constants remain fixed. Its artifact manifest records these
substitutions; this is not an unmodified production-origin artifact.

```sh
bun scripts/serve-managed-qa.ts /path/to/account-fixture \
  /path/to/canonical-libs /path/to/spanreed /path/to/frozen-noise-assets \
  /path/to/new-managed-evidence
```

The account fixture is started by the web repository's
`tools/serve-remote-qa.ts`. It provides real account and push routes backed by
an isolated PostgreSQL schema. Set `REMOTE_QA_RELAY_BINARY` and
`REMOTE_QA_NATIVE_BINARY` to the already built relay and native test executables;
the runner copies and hashes them before starting, without rebuilding either.
The integration runner registers three synthetic hosts: two installations in
one account and one in another. Each has its own X25519 identity and native
Noise fixture behind one real relay. The PWA uses a localhost proxy to the
actual account routes. Every native session is explicitly synthetic and has no Grok process: prompts cannot be
presented as successful inference.

The private `launch.json` contains a fixture login URL. It seeds an HttpOnly
browser family and requests a fresh owner-created pairing nonce; pairing then
uses the real Noise transport. Keep this file and all state in the private
laboratory directory. Never copy it into reports or Git. The ready file exposes
only non-secret connection metadata.

For Android, a device-specific ADB reverse can carry this localhost origin to
the phone. This checks an installed PWA and actual Web Push only when the real
device grants permission and receives the provider delivery. It does not
qualify Tailscale, production OAuth or HTTPS ingress. The physical-device
session must record foreground, suspension, closure, expiry and revocation
separately.

Create `stop` in the integration output directory to close its owned processes.
The account fixture has its own stop file and owns removal of its synthetic
database schema. Preserve evidence and remove only device forwards and
temporary applications created for this test.

## Combined browser checks

`qualify-managed-browser.ts` uses the generated PWA and real account, relay,
WASM and native transport. It pairs through the UI, reloads a paired browser,
checks draft consent and isolation across hosts and accounts with deliberately
identical session ids, browses approved native folders, transfers control
between two independent browser contexts, revokes the other browser and its
own access, and verifies that revoked access cannot silently reconnect.
Revoking one host's access must preserve a different host's saved draft.

By default the runner attaches to the hidden Chrome CDP endpoint. Set
`REMOTE_QA_ENGINE=chromium`, `firefox` or `webkit` to use an installed Playwright
engine in an isolated headless environment. Record the executable version and
viewport. Browser-engine tests do not establish support on physical iOS or
Android devices. The runner closes all contexts it creates.

The first actual PWA trial exposed missing explicit WASM initialization input:
the generated bindgen loader had no default module path. The product now passes
the adjacent `_bg.wasm` URL explicitly. This combined check imports the real
loader and requests the real WASM asset; the simulated connector test alone
could not detect the failure.

The extras runner checks the actual service worker's multipart POST and 303
navigation, review and explicit insertion, pending-intent deduplication,
signed-out handling, page closure/reopening and discard. It also checks native
publication preview and consent cancellation without creating a public share.
Its notification check establishes account/host/worker readiness only.

The recovery runner closes both sides of a routed WebSocket with the valid
application code 4001. It checks the reconnect indicator, removal of obsolete
browser projections, retained draft, restored control and a single live
connection without navigating. A previous runner used code 1013: browser
`WebSocket.close()` rejects that reserved code, while Playwright concealed the
exception and left the upstream connection alive. Those failed runs are
preserved as harness defects. The corrected run does not establish a physical
radio handoff or host-process restart.

The layout runner exercises the expanded browser panel and composer at
2560 × 1440, 390 × 844, 844 × 390 and 390 × 430. It verifies horizontal page
confinement, a reachable enabled composer and retained unsent text. The shortest
viewport approximates reduced space; it does not emulate Android's actual
keyboard or establish screen-reader support. Its report records the dimensions
of the experimental controls for visual review.

## Direct multiwriter browser checks

`scripts/qualify-direct-browser.ts` can run the direct Noise transport with two
independent pairings and a deterministic ACP process. Set
`REMOTE_QA_MULTIWRITER=1` and point `DIRECT_QA_NATIVE_BINARY` to the built
`fabrials-agent-host` example `direct_browser_fixture`. Its sibling example
`fake_multiwriter_agent` must be built in the same directory. The runner owns
the fixture, disposable Chrome profile and hidden Syl compositor; it does not
use the daily browser or call an inference provider.

```sh
REMOTE_QA_MULTIWRITER=1 \
  DIRECT_QA_NATIVE_BINARY=/path/to/target/debug/examples/direct_browser_fixture \
  REMOTE_QA_CHROME=/nix/store/package-google-chrome-version/bin/google-chrome-stable \
  REMOTE_QA_PLAYWRIGHT=/path/to/playwright-core/index.mjs \
  bun scripts/qualify-direct-browser.ts /path/to/new-private-evidence
```

The private evidence directory must already contain `cert.pem` and `key.pem`
for the laboratory TLS endpoint. Each run needs a fresh directory. Native
pairing material, browser profiles, private state and TLS keys stay there;
only a sanitized report and synthetic screenshots may be shared.

The first context is 2560 × 1440 and the second is 390 × 844. The checks cover
simultaneous write access without takeover, custom model and effort convergence,
stale configuration rejection, pause and FIFO ordering across devices, a stale
clear operation racing an enqueue, removal, reconnection during a turn, exact
transcript and receipt counts, return to idle, and empty model catalogues.
Conflicts must show a specific transient notice and leave no persistent error.
One downstream is deliberately held behind a bounded buffer to exercise an
actual stale revision; the host's durable refusal receipt confirms rejection.

The runner also retains its baseline source-dialog, responsive-layout, draft,
offline-history, private-host independence, and revocation checks. It records
runner, shell/worker and native-executable hashes, browser version and explicit
limits. Without `REMOTE_QA_ARTIFACT`, source metadata success is synthetic and
does not qualify archive distribution. With an artifact, the existing
`REMOTE_QA_SPANREED` source-verification gate still applies.

These checks establish browser and host convergence with synthetic ACP. They
do not qualify Grok inference, production TLS/CDN, Tailscale, actual push,
physical Android/Apple devices, cancellation against the real CLI, or GPU
performance. Scheduler bounds and restart recovery remain separate native
tests; this runner exercises one session and two browsers.

The [2026-10-14 sanitized report](evaluation/direct-multiwriter-browser-2026-10-14.json)
records 53 passing checks in Chrome 155 with no browser errors. The stronger
idle check first caught a stale Working tab after reconnection; it passed
after the tab switched to the authoritative execution state. Visual review
also verified that paused-queue text and actions remain legible on the mobile
viewport. This is local synthetic-ACP evidence, not a production deployment
or real-device qualification.
