# Remote notification experiment

This document records the candidate implementation and qualification contract.
The browser implementation passed the laboratory checks below. Provider
delivery, physical-device lifecycle and human utility remain unqualified.

The `push` candidate is disabled in ordinary builds. Browser notification
permission is requested only after the user selects Enable notifications for
this computer. A connected managed host must advertise the capability and the
active service worker must confirm support before registration. Granting a
browser permission is not proof of provider delivery.

## Contract and privacy

The account service registers a Web Push endpoint for the current account
session family and host. The same family, host and endpoint use one record.
The browser receives an authoritative identifier, generation and short-lived
binding token. Only that token and the opaque registration identity cross the
encrypted host channel. The endpoint and its encryption keys belong to the
account service, not the host operation log. A lost binding response is an
uncertain result that requires explicit recovery; it must not trigger an
automatic unsubscribe, deletion or new binding attempt.

A browser PushSubscription can serve multiple computers. Disabling one
computer must not unsubscribe it globally. The account registration and the
current pairing's native binding are revoked independently; the interface
distinguishes confirmed account removal from an unreachable host. Account
removal is available when the computer is already offline, without obtaining
a new native capability. Enabling still requires an affirmative capability.
After removal, fresh account and host reads detect a concurrent reactivation;
the interface does not claim that notifications are disabled while a new
registration remains. A failed refresh invalidates the old confirmation.

The only accepted push payload is a closed object containing
`kind: "remote_attention"`, a 32-character hexadecimal event identifier and an
expiry no more than sixty seconds in the future. It contains no title,
conversation text, project path, command, permission question or approval.
Before displaying a fixed generic notice, the worker resolves the event with
the authenticated account service. It repeats that check when the notice is
clicked. Offline, expired, malformed, signed-out or revoked events fail closed.
A click can open only the app's own root route; it cannot execute an operation
or approve a request. The worker uses the account Web Lock where available so
its authenticated requests share cookie-rotation serialization with the app.

A bounded IndexedDB record deduplicates event identifiers across worker
restarts until their expiry. The worker does not put push payloads or resolved
account data in the shell cache. Both database opening and a stalled storage
transaction fail closed after two seconds. Notification content stays generic
even when the app is open. Browser or OS suppression remains outside this
delivery contract and must be measured separately. A browser enforcing
`userVisibleOnly` may display its own generic fallback when the worker
suppresses a notice; suppression does not promise that the operating system
will show nothing.

## Qualification protocol

Contract tests must cover feature and host-capability gates, an old active
worker, permission denial, missing browser APIs, malformed keys and replies,
account/host switching during registration, lost binding acknowledgement,
shared endpoint removal, reconnect, expiry and explicit recovery. Worker tests
must cover malformed and oversized payloads, duplicate and concurrent events,
expiry, denied storage, network failure, cookie credentials, generic content,
revocation between display and click, strict target URL and absence of
operation/approval dispatch.

Physical-device acceptance requires the exact flagged artifact on the S24:
foreground, suspended and closed app; duplicate delivery; expired action;
revoked browser and signed-out account. Record notification delivery latency,
provider failures, device clock skew and suppression separately from host
emission and account acceptance. An ADB-opened webpage or a synthetic worker event cannot qualify
background Web Push delivery. Any fixture aliases for account/relay endpoints
must be limited to the qualification build and recorded with its source hash.
Production endpoints remain fixed.

The required human utility trial compares at least ten paired notification
and manual-check tasks. Until the artifact, privacy, lifecycle and utility
receipts pass, the candidate remains experimental and off by default.

## Browser laboratory, 2026-10-13

The full frontend suite passed 634 tests in 59 files, including 36 notification
contract, lifecycle and worker tests. Type checking passed. The flagged Remote
production build and ordinary Remote build each passed the 43-file shell gate
with the previously qualified Noise WASM pair. The ordinary worker contains
no push handlers, and its manifest does not register a share target.

Chrome 155 in hidden Sway passed seven synthetic interface checks at
390 × 844: no automatic permission, denial, explicit binding, scoped removal
without global unsubscribe, uncertain binding without replay, fitting layout
and no page errors. Browser APIs, account responses and host responses were
synthetic in that interface fixture.

Eleven separate worker checks exercised actual IndexedDB concurrent claims,
the 256-event bound, expiry cleanup, denied storage, duplicate suppression,
revocation at click, root-only navigation, malformed actions and persistence
across reload. Handler delivery used a synthetic scope; installation and the
capability handshake used the exact production worker. No provider-delivered
push or operating-system notification is attributed to these checks.

Evidence is under `/tmp/grok-remote-evaluation-ter17my1`: `push-ui.json`,
`push-worker-browser-01.json`, `frontend-complete-tests-04.log`,
`frontend-typecheck-08.log` and `frontend-artifacts-final-01.json`. The latter
records exact artifact, source and result hashes. Physical qualification
must identify its own artifact and must not inherit these checks as proof of
background delivery.

## Managed browser integration and WebKit correction

The sealed `frontend-webkit-source-02` candidate passed 652 tests in 59 files
and type checking. Its ordinary and experimental artifacts each passed the
45-file shell gate. `frontend-artifacts-webkit-01.json` records these sources,
artifacts and results separately from the earlier synthetic UI evidence.
The managed fixture has 154 source files in common with that snapshot, all
byte-identical. It substitutes localhost account and relay endpoints and
synthetic account/session data; it preserves the real PWA, Noise WASM,
account service, relay and native host implementations.

Playwright WebKit 26.6 initially stopped responding immediately after pairing.
Independent probes showed that `Notification.permission`, its asynchronous
permission query and every Noise operation returned. Calling
`PushManager.getSubscription()` with the default notification permission
blocked the browser. Replacing only that call in a diagnostic restored the
composer. The product now reads an existing subscription only when permission
is already granted. Two regression cases, default and denied permission,
failed before this change and pass afterward; all 38 notification tests pass.
Diagnostic API substitutions are not acceptance evidence.

Against the rebuilt `managed-pwa-04` fixture, Chromium and Firefox each passed
19 checks without browser errors. WebKit passed the 18 functional checks,
including account and host isolation, durable drafts, control transfer and
revocation. Its final no-pageerror gate failed because WebKit emitted fetch
access-control diagnostics during navigation. Instrumentation found neither
`window.error` nor `unhandledrejection`; active account reads returned 200,
and other in-flight reads were cancelled. This result remains a failed strict
qualification while that diagnostic is investigated; it is not a Safari pass.

These runs use pinned Playwright 1.63.0 browsers in a Linux container. They do
not qualify Safari on Apple hardware, iOS standalone lifecycle, physical
Android, production OAuth/TLS/Tailscale, provider-delivered Web Push or human
utility. The notification experiment remains disabled in ordinary builds.
