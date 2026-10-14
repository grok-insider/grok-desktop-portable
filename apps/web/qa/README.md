# Browser and mobile qualification

The fixture bundles the actual `App`, application layout, PWA actions, styles, dialogs and IndexedDB adapter with a synthetic host transport. It never starts an agent, executes a command, signs into an account or publishes data. This qualifies browser rendering and interaction only; it does not qualify managed Remote, Noise, the relay, terminal continuity or production deployment.

## Run the fixture

From the repository root:

```sh
node apps/web/qa/build-fixture.mjs /tmp/grok-remote-browser-fixture
python -m http.server 4187 --bind 127.0.0.1 --directory /tmp/grok-remote-browser-fixture
```

Open `http://127.0.0.1:4187/` in a test tab. For an already paired Android phone, use its explicit ADB serial and open the same URL on the phone:

```sh
adb -s PHONE_SERIAL reverse tcp:4187 tcp:4187
```

The builder copies the viewport meta from the application index, including `interactive-widget=resizes-content`. Mobile keyboard results are invalid if the fixture silently uses a different viewport policy. The production React build is selected explicitly because Vite library mode otherwise preserves `process.env.NODE_ENV` and fails in a browser without Node globals.

Use `window.remoteQa` in the test tab's JavaScript context:

| Call | Expected result |
| --- | --- |
| `permission()` | Long permission dialog with Allow once and Deny; choosing either records one operation and closes it. |
| `question()` | Question dialog; Preview then Send answer records `answerInteraction` with the selected answer. |
| `watching(true)` | Read-only banner and disabled composer. |
| `watching(false)` | Composer becomes usable again. |
| `offline()` | Reconnecting state with disabled composer; the conversation and unsent draft stay visible. |
| `online()` | Reconnects and restores the current controlling/watching state. |
| `offerInstall()` | Offers a synthetic installation event without installing anything. |
| `offerUpdate()` | Offers a synthetic waiting worker; activation is recorded without reloading. |
| `view("landing")`, `view("setup")`, `view("remote-error")` | Shows the real welcome, unsupported-browser setup, or remote pairing error inside the application layout. |
| `view("session")` | Returns to the synthetic managed session. |
| `commands` | Operations sent to the synthetic transport. |

Check dark and light themes at narrow widths, long permission content, reconnect with a dialog open and native keyboard opening/closing. Measure touch targets with a coarse pointer: visible buttons must be at least 44 by 44 CSS pixels and the document must not overflow horizontally. Conversation tabs may scroll inside their own strip.

Offer installation and update together at 360 and 390 pixels with an unsent draft focused. Hit-test Send and every PWA button; the actions must occupy their own row below the composer. Later must return the row's height without losing the draft. Repeat in a reduced-height viewport and check that welcome links, setup controls and Reconnect remain reachable by scrolling. Measure transcript paragraphs as well as document width: an ancestor can hide clipping without increasing the document width.

`remoteQa.grants` exposes the production IndexedDB adapter for synthetic records only. Verify persistence across a reload, the `Uint8Array` private-key type and deletion:

```js
await remoteQa.grants.writeGrant("qa-only", {
  hostPublicKey: "synthetic",
  privateKey: new Uint8Array([1, 2, 3]),
});
await remoteQa.grants.readGrant("qa-only");
```

Reload, read the same record, then clean it up:

```js
await remoteQa.grants.deleteGrant("qa-only");
(await remoteQa.grants.readGrant("qa-only")) === undefined;
```

## Qualify the actual shell

The fixture uses a synthetic worker registration and has no real service worker or manifest. Build a real Remote artifact as documented in `docs/remote-deployment.md`, then serve its `.vercel/output/static` directory from a different loopback port. Chrome treats loopback as a secure context. The page selects the local-host surface there; a missing host error is expected, and does not demonstrate an account or relay connection.

1. Wait for `navigator.serviceWorker.ready`, reload, and require a non-null `navigator.serviceWorker.controller`.
2. Inspect Cache Storage. It must contain only the generated shell allowlist, including the versioned crypto JS/WASM, and no conversations or API responses.
3. Set only this tab offline, then navigate to `/s/qa-offline`. The actual shell must load. Fetching `/session`, `/api/private` and `/index.html?sessionToken=qa` must fail instead of returning the cached shell.
4. Restore networking. The browser should offer installation when its own eligibility checks pass. Installation acceptance, standalone launch and storage continuity require the real browser UI and device.
5. For update lifecycle testing, serve a disposable copy on another origin. Change its worker cache identifier, call `registration.update()`, and wait for the new worker. It must remain waiting while the UI offers Update and reload. Click that button: require a reload, no waiting worker, the replacement cache present and the previous shell cache absent. This tests the worker lifecycle, not an actual deployment upgrade.

Do not change an artifact that will be verified or deployed. Delete only this test origin's synthetic storage and close test tabs when finished. Remove the ADB reverse rules and stop local servers after device tests finish.

## Station results, 2026-10-11

Chrome 155 on the existing station browser verified the fixture at 360×740 light and 390×844 dark with a coarse pointer. The initial browser run caught and fixed the missing production define; the mobile run found the fixture's stale viewport meta. The product's icon controls initially measured 24–36 pixels wide; the coarse-pointer rule now gives all visible buttons at least 44×44 pixels. Both checked widths had no horizontal document overflow.

Verified: the long permission dialog and Deny; selecting Preview and submitting the question with the expected `answerInteraction` operation; disabling input while watching/offline; reconnect restoring the conversation and usable composer; production IndexedDB write/read across reload and deletion; no console errors in the completed fixture run.

The actual review artifact shell installed its worker, controlled the page after reload, loaded a session deep link offline and refused to intercept the three API/query requests above. A disposable worker update stayed waiting until the button was clicked, reloaded and replaced the cache. The browser exposed Install app, but this station run did not accept an installation. Type checking and all 427 web tests passed after the touch-target change.

These shell results do not cover a managed HTTPS account/relay connection, Tailscale, Android/iOS standalone installation, mobile network handoff, iOS storage separation or screen-reader use. Physical S24 results and their connection limits are recorded separately in [remote-mobile-qualification.md](../../../docs/remote-mobile-qualification.md).

## Real Shared-host integration, 2026-10-11

An isolated Grok leader and a second ACP client created a session in an empty synthetic workspace. The production PWA connected to a real native Shared/private host through a loopback-only HTTP/WebSocket proxy that rewrote Origin to the configured private HTTPS origin. This exercised the real UI, HTTP authorization, controller leases and ACP integration; the proxy does not qualify TLS, Tailscale or a managed relay.

The first run used native binary SHA-256 `a4ff8e6db08560a22d0f3695bf209f56ce513a944a71f41e39a0727b8f193a08`. Two tabs remained connected as controller and watcher without the previous resume-request loop. One prompt requested `sleep 8; printf 'REMOTE_ONCE\n' >> effect.txt`. The real permission dialog displayed the exact command and Allow once/Deny; the second ACP client received the same permission for the same session. Before approval the file did not exist. After Allow once, the browser went offline and both proxy WebSockets closed during the sleep. The command still completed. Reconnection recovered the final transcript; the file contained exactly one 12-byte marker. The journal contained one completed Prompt and one completed DecidePermission, with no interrupted operation. Closing the new controller left the watcher read-only until its explicit Retry control action succeeded.

Evidence for that run is `/tmp/remote-browser-live-0fl1l1q0/qualification.json`, `browser-final.png` and the synthetic `terminal-events.json`. The permission snapshot was captured before approval in the browser tool transcript. The evidence names the tested binary; it is not attributed to later rebuilt binaries.

The integrated run found defects that the synthetic UI had missed: Shared observers needed session-list change events and a confirmed prompt echo, agent text on either side of a tool was merged, disconnected Stop/queue controls remained enabled, and the composer displayed the catalog default instead of the resumed session's actual model. These are covered by focused regressions. A confirmed prompt now replaces the matching optimistic entry by idempotency key; hosts without that optional echo retain the optimistic behavior. Session model and effort labels use confirmed inspector metadata, with an unknown state when absent. Sonner is externally styled under the production CSP; the live page had no blocked inline stylesheet or CSP error.

## Combined experimental controls, drafts and sharing

Build two disposable fixtures from the same source, one with
`VITE_REMOTE_EXPERIMENTS=drafts,share-target,remote-projects,control-transfer,device-panel`
and one with an empty flag list. Serve their containing directory on one
loopback origin. The fixture uses an explicit synthetic account/host/key/
installation draft scope and synthetic opaque folder handles. `remoteQa.share`
uses the production IndexedDB inbox; it does not invoke the operating system
share sheet. `otherRequestsControl`, `invalidateDevices` and `folderRefused`
exercise host notifications and definite refusal without a real host.

Run the reusable checks with an existing background test browser:

```sh
BROWSER_CDP=http://127.0.0.1:PORT \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
REMOTE_FIXTURE_URL=http://127.0.0.1:4197/flagged/ \
REMOTE_QA_OUTPUT=/absolute/path/to/evidence \
node apps/web/qa/check-experiments.mjs

BROWSER_CDP=http://127.0.0.1:PORT \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
REMOTE_FIXTURE_URL=http://127.0.0.1:4197/flagged/ \
REMOTE_DEFAULT_FIXTURE_URL=http://127.0.0.1:4197/ordinary/ \
REMOTE_QA_OUTPUT=/absolute/path/to/evidence \
node apps/web/qa/check-experiment-layout.mjs
```

The scripts clear storage on the supplied loopback origin; reserve it for
these synthetic fixtures. They close only their own tab and disconnect from
CDP. The layout run verifies both artifacts on the same origin, so a pending
share survives entering a flags-off build without becoming visible there.

On 2026-10-13, the hidden Sway Chrome 155 run passed 20 combined functional
checks and five layout/flags-off checks at 390 × 844 and 2560 × 1440. Drafts
survived reload after opt-in; sharing appended only after explicit action;
observers could request/cancel but not enroll or revoke another browser;
transferring demoted the current connection; revocation required confirmation;
one invalidation produced one list refresh; no prompt was submitted. The
first expanded-layout check found that opening folders, devices, confirmation
and a share together could push actions outside the fixed mobile viewport.
The session connection panel now scrolls within 40% of the available viewport,
keeping the composer visible. The final check reached the confirmation via
that panel's scroll and preserved the composer.

Evidence: `combined-functional-02.json`, `combined-extra-02.json` and
`combined-fixture-evidence-manifest.json` under
`/tmp/grok-remote-evaluation-ter17my1`. The full frontend suite passed 598 tests
and type checking passed after the fix. Native integration, HTTPS, account
isolation, physical keyboard behavior and installed mobile PWA acceptance
remain separate qualifications.

The final source was rechecked with `combined-fixture-03` and
`combined-fixture-default-02`: the reusable scripts passed the same 20
functional and five layout/flags-off checks. The fixture can retain the real
service worker for a dedicated recovery run when the harness sets
`window.remoteQaRealServiceWorker = true` before loading it; ordinary synthetic
runs keep the mock worker. The final frontend suite passed 634 tests in 59
files and type checking. Exact hashes and result paths are recorded in
`/tmp/grok-remote-evaluation-ter17my1/frontend-artifacts-final-01.json`.

## Notification fixture and real storage checks

Build the synthetic notification interface with
`VITE_REMOTE_EXPERIMENTS=push node apps/web/qa/build-fixture.mjs /absolute/output push.tsx`.
Run `apps/web/qa/check-push.mjs` with the same CDP, Playwright, loopback fixture
and evidence-directory environment variables used above. This fixture mocks
Notification, PushManager, the account service and host; it does not deliver a
provider push.

Run `scripts/test-push-worker.mjs /absolute/flagged-production-artifact /absolute/new-result.json`
with `PLAYWRIGHT_MODULE` and `BROWSER_CDP` to exercise actual browser IndexedDB
and install the exact flagged worker. It owns a temporary loopback server and
browser context and closes both. Handler dispatch remains synthetic; the
script explicitly excludes provider and operating-system delivery from its
claims. See `docs/remote-push-evaluation.md` for the remaining device and
utility requirements.

## Durable draft acknowledgement

Build with the `drafts` experiment and opt in explicitly. `data-draft-status="saved"` means the latest edit has committed through a strict IndexedDB transaction; wait for that status instead of checking a localStorage key or waiting an arbitrary time. `saving` and `failed` never imply persistence. The database is `grok-remote-drafts.v2`, with `scopes` and `drafts` stores; draft keys are `[scope, sessionId]`. Opt-out retains in-memory text, while confirmed revocation clears it. The browser workflow checks the actual v2 stores after deletion.

The independent `scripts/qualify-draft-recovery.ts` harness owns its persistent browser profile and can kill that browser immediately after a confirmed final edit. It must never target the daily browser or a shared QA browser. Its `draft-recovery-04` evidence passes nine desktop Chromium checks against sealed `combined-fixture-05`; it does not qualify Android eviction or participant utility. See `docs/remote-drafts-evaluation.md` for the failed localStorage evidence and current scope.
