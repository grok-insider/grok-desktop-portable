# Direct multi-host qualification — 2026-10-14

The exact **r3 artifact passed 107/107 checks** in Chrome 155.0.8059.39,
including its real corresponding-source download. It ran in its own Syl hidden
Sway compositor at 2560×1440; the daily browser and desktop were not used.
The earlier local-shell run passed 100 checks. Trusted TLS and deployed routing
are covered separately by the [r3 deployment receipt](evaluation/qualification-r3-deployment-2026-10-14.json).

## Exact r3 identity

The exact run is recorded in [direct-multihost-r3-browser-2026-10-14.json](evaluation/direct-multihost-r3-browser-2026-10-14.json),
with its full local receipt at
`/home/friend/.local/share/fabrials-remote-release/2026-10-14/multihost-r3-exact/report.json`.
It verifies Portable `abe4f35895aacda102a09c3b50475379febf3b6c`, native source
`e6d9cc8cb076d7896edec98ee7338d4d4d8f1f7a`, and the matching source archive.

| Identity | SHA-256 |
| --- | --- |
| Deployment manifest | `184a9e1bdabb95454e9be0842460dc7a3cafce35395500e271fccabac6803363` |
| Index plus service worker | `1f2dc241bdebeea17eb9f2373c86676f6c1e498c8976018307c01ae237a69423` |
| Corresponding-source archive | `d7482730885ea14e67d3df818a6680ea731173bf700c4c4f4bd2555b34a90bfc` |

There were zero uncaught browser errors; both native instances, Chrome and Syl
closed with empty recorded process groups. The runner and fixture hashes in
this receipt describe this historical run, before the later soak harness.

## Isolation exercised

Two instances of the native fixture used separate state directories, endpoints,
installation IDs, host keys and pairing sessions. Their synthetic histories
intentionally shared the same conversation ID, so a session-only storage key
would fail the isolation checks. Both fixtures came from the same actual native
binary; no Grok inference or deployed Spanreed CLI was used.

The browser rejected host B with host A's key, and separately with A's
installation ID, without saving a second pairing or exposing its transcript.
It retained distinct drafts and consented offline histories, read both histories
without even attempting a private connection, and switched to B after a real
failed retry to A. A's pending retry stayed cancelled during a further 4.5 seconds
(the next retry is due after 4 seconds); B's history and draft remained intact.
Revoking A removed only A's profile, draft and history; B remained usable across
a reload. Finally revoking B removed both scopes.

## Mobile defect and negative control

The older shell had passed a horizontal-overflow check, but its mobile name and
endpoint columns were only **31.73 px** wide and Connect was **36 px** high.
The strengthened runner fails that exact shell on useful identity width. This
negative result is preserved separately from its historical 95-check run.

The corrected cards put the actions below the identity on narrow viewports,
retain a horizontal layout on desktop, and make Connect at least 44 px high.
At 390 px the identity is **261–276 px** wide; at 2560 px it is **424.73 px**.
Both actions are at least 44×44 px. Screenshots were inspected before and after,
in light and dark themes, at both widths. The current Grok styling is preserved.

## Evidence and reproduction

Machine-readable evidence: [direct-multihost-browser-2026-10-14.json](evaluation/direct-multihost-browser-2026-10-14.json).
Local artifacts, including screenshots and full reports:

- `/home/friend/.local/share/fabrials-remote-release/2026-10-14/multihost-qualified`: historical 95 checks against the r2 deployment artifact.
- `/home/friend/.local/share/fabrials-remote-release/2026-10-14/multihost-layout-before`: stronger geometry checks reject r2 as expected.
- `/home/friend/.local/share/fabrials-remote-release/2026-10-14/multihost-layout-qualified`: corrected local shell, 100 checks and zero browser errors.
- `/home/friend/.local/share/fabrials-remote-release/2026-10-14/multihost-r3-exact`: exact r3, 107 checks, real source archive, zero browser errors.

The exact native fixture SHA-256 is `1066a1af1323109b143597d1791b6b616f89f04a80ee13ab8255821e52f90903`,
from canonical libs commit `ee3060d` (fixture source SHA-256
`a990b5c1038048ec5fda173d6ac5342a9c366a253e4f44439e42625afeb9c3e2`).
This fixture changes only its endpoint/label/synthetic history configuration;
it does not qualify a new native runtime.

Run `REMOTE_QA_MULTIHOST=1 bun scripts/qualify-direct-browser.ts <private-directory>`
with a fresh directory containing `cert.pem` and `key.pem` for the fixture and
shell hostnames. Set `REMOTE_QA_CHROME` to the real Nix Chrome executable,
`REMOTE_QA_PLAYWRIGHT` to the Playwright module, and `DIRECT_QA_NATIVE_BINARY`
to the fixture. The default serves `apps/web/dist`; the current build used
`FABRIALS_REMOTE_ORIGIN=https://grok.fabrials.com` and the existing compiled Noise
WASM. To verify a packaged artifact, also set `REMOTE_QA_ARTIFACT` and the
**matching** source verifier checkout in `REMOTE_QA_SPANREED`. The historical r2
archive requires Spanreed source `7e2a781`; a newer checkout correctly fails its
identity check. Multi-host and multiwriter modes run separately.

The runner sanitizes secret-like environment names before starting child
processes, bounds IndexedDB inspection, observes HTTP upgrade attempts per host,
and verifies child exits and recorded process-group retirement before removing
its synthetic browser/native state. It also closes its Syl compositor, removes
the fixture TLS private key, and records cleanup failures as failures. Descendants
that leave their recorded process group are outside this inventory. Historical
fixture directories were also cleaned with separate local cleanup records.

Targeted product verification passed: **37 tests** in RemoteRoot, directProfiles
and drafts; TypeScript; the Vite build with versioned Noise WASM; and emitted PWA
validation. The repository's root typecheck wrapper assumes `pnpm` is on PATH;
here it was run successfully through `corepack pnpm --filter
@grok-desktop-portable/web typecheck`.

## Limits

The older local-shell run uses synthetic successful source metadata. The
separate exact-r3 run verifies the real final corresponding-source archive; it
does not inherit that proof from r2. The fixture proxy uses a laboratory certificate and Chrome's test-only
certificate bypass: no trusted TLS, actual hosting/CDN routing, Tailscale,
physical Android/Apple behavior, push delivery or GPU performance claim follows.
The two hosts are separate local processes, not two physical machines. The r3
deployment has its own receipt above. This laboratory result does not open
publication gates.
