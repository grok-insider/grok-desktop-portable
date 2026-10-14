# Physical Android qualification

## Device and scope

The 2026-10-11 run uses the owner's Samsung Galaxy S24 Ultra (SM-S928B), Android 16 / SDK 36, arm64, with Chrome 154.0.8037.126. Its reported display is 720×1560 at density 300. Syl drives the device over an explicitly selected, paired wireless ADB transport. The real Grok CLI and a terminal client use an isolated host state, Grok home and temporary workspace; the owner's existing conversations are not used.

The qualified route is private HTTPS through the owner's Tailscale network to station. The actual Spanreed-embedded bundle was installed from the same private origin used for pairing and launched as an Android WebAPK in standalone mode. The earlier ADB loopback connection was only diagnostic; the private HTTPS observations below used no ADB reverse.

## Artifact attribution

| Native Spanreed SHA-256 | Physical observations |
|---|---|
| `2353aad8a97452581257f9b8f8d61c5a4d94fc788a0f5e00707ca2dcfc031f96` | Installation, shared terminal/PWA session, permission canaries, keyboard, controlled suspension, transport interruption and the original viewport defect. |
| `bdb8b4e1c1a66098eefa48a18598b9486c3ffe93443b78f61fafe4eefe221003` | Explicit waiting-worker update to `/assets/index-DoxvsIHX.js`, cold viewport correction, revocation, same-document pairing and external Android HTTPS navigation. |
| `8308e7a136d67c6871f6df0ee5feab5623212e81c5261a624a76b4daac039642` (v12) | Real host-process restart on the fixed standalone target: draft and navigation preserved, one automatic same-session load, zero prompt or permission replay. |
| `ac843a86b48d6202f75e632f91048f70affc25cf57eb32223287e972a75aaa93` (v13) | Final local candidate: real host restart with 51 samples, matching embedded assets, viewport, offline static shell, grant revocation and fixture cleanup. |

## Observed results

- Syl attachment, Android telemetry, app launch, keyboard input and Back were checked against the real phone.
- The actual Portable interface was reached through ADB loopback forwarding. This is a diagnostic connection, not proof of Tailscale access.
- Opening several paired tabs reproduced a high-rate `/session` and `/healthz` loop. Subsequent desktop reproduction identified timestamp-only storage events, CSRF recovery and controller ownership as separate causes; fixes and regression results are recorded in the canonical libraries' `docs/remote.md` and Portable's QA README.
- Private-origin setup instructions now distinguish commands run on the computer from the pairing step performed on the phone.
- The installed Tailscale app initially had another account's expired login. After the Proton Pass provider repair below, GitHub authentication and Tailscale login succeeded for the matching owner. Credentials remain in Pass and are not recorded in test evidence.

## Proton Pass passkey diagnosis and repair

After the owner unlocked Pass, GitHub accepted the stored password but the available Authenticator code did not complete the second factor. The owner specified passkeys. GitHub's real WebAuthn request initially reported no passkeys available on the device.

Android's password autofill service was correctly registered, but `credential_service` and `credential_service_primary` still named `proton.android.pass/proton.android.pass.featurepasskeys.service.PasskeyProviderService`. That component is absent from installed Proton Pass 1.41.3. Package Manager instead advertises `proton.android.pass/.features.credentials.shared.services.PassCredentialProviderService`. This explained why password autofill worked while the passkey provider was unavailable. The event that left the stale registration has not been established; no particular app or Android update is blamed.

Proton Pass was reselected through Android's native preferred-service picker (`android.settings.REQUEST_SET_AUTOFILL_SERVICE`, `package:proton.android.pass`). Android now records the installed service in both credential settings. Password autofill and the additional Google/Samsung providers were preserved; no vault entry was changed. On retry, GitHub offered the actual `github.com` / `grok-insider` passkey from Proton Pass. Selecting Sign in opened the device fingerprint prompt. The subsequent GitHub OAuth consent and Tailscale “Login successful” establish successful authentication. The evidence deliberately keeps `biometricCompleted: null`: the physical fingerprint interaction was not independently observed or attested. No PIN or passkey material was extracted.

Sanitized before/after settings and observations are retained in `/tmp/remote-mobile-private-_n84ddb1/proton-pass-provider-{before,after,verification}.json`. Proton's [Android guidance](https://proton.me/support/pass-use-passkeys) requires selecting its password/passkey provider on Android 14 or later; its [provider migration](https://github.com/protonpass/android-pass/commit/2dd94573aa0562c5acab06233e19e1724f1d3973) and current manifest corroborate the component change, without proving when this phone's stale setting arose.

## Private HTTPS, policy and DNS

The station browser had a valid GitHub session for the matching owner and authorized Tailscale. Tailnet HTTPS was enabled. A temporary foreground Serve route forwards `https://station.taila8c477.ts.net` to the isolated host on loopback port 26993. Station health returned 200 with system TLS validation. The phone subsequently reached this origin over TLS 1.3: phone `100.84.231.88`, station remote address `100.107.147.67`, secure standalone context, no ADB reverse.

The sole added network grant is `dev-s24-ultra` → `dev-station`, `tcp:443`. The saved policy matched the reviewed proposal, preserved the existing network and SSH policy, and passed five network tests and one SSH test. The station packet filter showed exactly the phone `/32` source to station `/32` TCP 443 destination. MagicDNS is enabled; Funnel is disabled. Raw host ports and SSH were not added for the phone.

Chrome's custom secure DNS provider was Cloudflare (`1.1.1.1`), which prevented this private name from resolving through the tailnet. Chrome was changed to use its current service provider; Android's system Private DNS setting was not changed. An external Android navigation to the private origin with a nonsecret query returned HTTPS 200 in a secure context with `serviceWorkerStart: 0`; this also checked a network response outside the worker's cached shell.

Policy and transport evidence are `tailscale-s24-acl-verification.json` and `s24-runtime-evidence.json` in `/tmp/remote-mobile-private-_n84ddb1/`. The policy snapshot's earlier `realPhoneHTTPS` pending marker is superseded by the later runtime observations, not by the station probe alone.

## Shared session, permissions and reconnect on `2353aad8`

The installed WebAPK opened the same synthetic session as the live Grok terminal. `S24_TUI_CONNECTED` reached the PWA without reload. Fresh terminal captures confirmed the reverse direction: the PWA's prompt, denied permission, later allowed operation and result were visible in that terminal.

The denied synthetic file operation left no file. **Allow once** produced exactly the expected 16-byte file; the denied effect remained absent and reconnect did not duplicate the allowed effect. Permission buttons remained visible in landscape at a 750×354 CSS-pixel viewport. Rotation was restored to its previous free setting. These canaries establish the two recorded operations, not every tool or permission type.

Keyboard opening and closing preserved the draft. A controlled return to the same Android task after 38.33 seconds preserved its 16-character unsent draft. A separate real interruption and restart of foreground Tailscale Serve preserved all 22 draft characters in both React and the textarea before, offline and after reconnect; the canary response count remained one. Another tab recovered the transcript on foregrounding while Send remained disabled as an observer, and the controlling tab retained its draft.

Two earlier diagnoses were corrected. A launcher re-entry replaced one WebAPK target with another, and prefix-based CDP selection mixed those pages; this did not establish draft loss. A stale terminal capture also failed to show a delivered PWA prompt while the live terminal was still running; fresh captures confirmed delivery. Target selection now requires an explicit observed target id, and ambiguous prefixes fail closed. No upstream Grok defect was established by those stale observations.

Evidence includes `s24-suspension.json`, `s24-runtime-evidence.json`, `terminal/s24-pwa-to-tui-{denied,allowed}.{json,txt}` and `s24-landscape-permission.png`. The final `mobile-report-facts.json` consolidates these observations and later checks, with hashes for 15 evidence sources and status `qualified_local_candidate_cleaned`; each canary retains its actual artifact attribution above.

## Corrected behavior physically checked on `bdb8`

On the older bundle, a cold standalone launch measured a 805.87-pixel shell against a 749.87-pixel visible viewport and placed Send below the visible edge. Opening and closing the keyboard temporarily corrected it. After the explicit **Update and reload** action, the phone loaded `/assets/index-DoxvsIHX.js`. A cold session now measured a 749.87-pixel shell with Send's bottom at 737.33 pixels, without first opening the keyboard.

The worker was observed waiting and activated only after the explicit update action. Revoking the test grant made `/session` return 403. Opening a new pairing fragment in the already open document consumed and cleared it, and `/session` returned 200 without reloading. The original approved effect remained exactly 16 bytes. `s24-bdb8-cold-session.png` and the `candidateBdb8` section of `s24-runtime-evidence.json` record these results.

## Host restart recovery checked on v12

A separate, real failure occurred while replacing the host/ACP process, keeping the shared leader, host state, grant and fixed WebAPK target. The old page moved from its session and unsent draft to Home without a document reload. A new host restores durable grants and the journal but initially has no resident sessions; the old frontend interpreted that empty list as closure and pruned the tabs and drafts.

The correction preserves existing tabs and drafts across an event-history reset. With a valid control lease, it attempts to reopen the active session once using the same session id and enrolled workspace id. Inactive tabs wait until selected. Sending stays disabled until residence is confirmed. It never replays a prompt; an error or ambiguous result retains the draft and requires an explicit retry. A monotonic read guard prevents an older empty list from deleting a session after successful recovery.

Both defects have failing-before regression tests. The v12 frontend suite passed 507 tests in 46 files, with type checking and diff checks clean. Independent backend review confirmed that `loadSession` returns `SessionCreated` for the same id without a prompt or a new session.

The real restart passed on native `8308e7a1`, WebAPK target `6422`. The host process changed from 3186271 to 3190591 while the leader and terminal stayed alive. The acceptance result records 83 observations with the exact draft, session path and `performance.timeOrigin` unchanged; the closed observer file contains 84 samples. Exactly one automatic `loadSession` was observed and no prompt or permission decision was sent. The allowed file remained 16 bytes and the denied file remained absent. Send remained 44×44 pixels with its bottom at 737.33 against a 749.87-pixel visual viewport, with no overflow. Evidence: `s24-v12-restart-result.json` and `s24-v12-restart-observation.json` in the mobile fixture directory.

The subsequent v13 source change discards a recovery response from an earlier pairing generation. Readiness, attempts and loading indicators belong to their generation; an old completion cannot refresh an old inspector, show an old failure or block a newer recovery. The success, failure and still-pending-old-operation cases have failing-before tests. Independent review approved this scoped change, and the final source suite passes **510 tests in 46 files**, with types and diff checks clean. Its separate physical acceptance follows.

## Final v13 physical acceptance

The final local candidate is native SHA-256 `ac843a86b48d6202f75e632f91048f70affc25cf57eb32223287e972a75aaa93`, with embedded bundle SHA-256 `d2228cb515197b384eb470c7cf93d62900d331b556b4a66af1bb4de578c4144e`. Its final JavaScript is `/assets/index-DM-9g4GA.js`, SHA-256 `bb9c54b558de2e4c35039f6c1dbd3e274952bc493c939cc21b76fabcf3eba76d`. `qualification-identity.json` is retained beside the executable in `remote-spanreed/target/remote-review/ac843a86/`; it records a build from local uncommitted sources, not a release. HTTPS responses for the shell, worker and JavaScript matched the built files, and the physical page's loaded JavaScript matched the same identity.

The real host restart on the same standalone target `6422` passed across **51 observations**. The exact draft, session path and document navigation time remained unchanged. The browser issued exactly one automatic `loadSession` and zero prompt or permission commands. The allowed effect stayed 16 bytes and the denied effect remained absent. The secure standalone page had no document overflow; Send measured 44×44 pixels with its bottom at 737.33 against a 749.87-pixel visual viewport. These observations are recorded in `s24-v13-restart-result.json`, `s24-v13-restart-observation.json`, `s24-v13-assets-layout.json` and `candidate-v13-first-https-verification.json`.

Cache inspection found **45 entries**, all declared static files; the bundle manifest has 46 assets because `sw.js` is not itself cached. No API response or transcript was cached. With CDP network-offline mode applied to the physical Android page, the installed standalone shell and final JavaScript loaded while an actual network fetch failed; the transcript was absent. Restoring the connection returned the same session to Ready and restored its transcript. This exercises the physical browser's offline shell, not a radio or Wi-Fi/mobile handoff. Evidence: `s24-v13-offline-shell.json`.

Finally, revoking the test grant left zero grants and the physical page's `/session` request returned 403. This final-artifact result is recorded in `final-grant-revoked.json`; the earlier successful re-pair remains attributed to `bdb8`.

## Cleanup and remaining limits

Cleanup completed successfully. The origin's browser storage was cleared and its cookie count was zero. Test targets `6422` and `6417` were closed, while the owner's unrelated Google tab was preserved. The dedicated station Chrome QA/Tailscale tabs were closed. The temporary 4187 reverse had already been removed; the 9237 CDP forward was removed after the final checks. The installed WebAPK remains on the phone, without the test grant or cached test origin data.

The native cleanup found zero remaining fixture processes, closed loopback port 26993 and the private tmux session, and removed the temporary foreground Serve route. Synthetic host/Grok state, temporary configuration, pairing locators and secret-bearing fixture files were removed; no listed secret file remains. Evidence and the original 16-byte allowed marker were retained, and the denied marker is absent. ADB pairing, Proton Pass, Tailscale configuration and unrelated apps/services were preserved. `browser-cleanup-result.json` and `cleanup-result.json` record these checks. The temporary remote fixture is no longer serving the installed PWA.

The short same-task suspension does not establish Android process-death recovery, OS eviction or long background retention. Network handoff, multi-host isolation, adapter loss during a pending mobile approval and exhaustive mobile accessibility remain outside these recorded physical checks. This private Android fixture does not qualify iOS, the production managed account/relay deployment or production user sessions.
