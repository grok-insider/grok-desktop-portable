# Share target experiment

The `share-target` build flag enables a manifest share target, a bounded service
worker receiver and a local review inbox. Ordinary builds omit the manifest
entry and do not intercept POST requests. This candidate remains disabled by
default; implementation is not Android or usability acceptance.

## Data path and boundaries

The browser posts multipart content to `/share-inbox`. The worker reads at most
1 MiB before parsing, accepts up to three files of 200,000 bytes each and stores
at most three items in IndexedDB. Text is capped at 128 KiB of UTF-8, title at
1,024 bytes and URL at 16 KiB. The redirect contains only a random local item ID.
Content is never placed in a URL, shell cache or log. Shared URLs are displayed
as text; receiving an item does not fetch them.

The inbox belongs to the browser origin, independently of any signed-in
account. An item can be reviewed while signed out, but insertion requires an
explicitly selected account, host and conversation. It never submits a prompt.
An asynchronous file conversion or claim cannot append to a different target
after navigation. The destination checks the exact serialized command size
against the current draft before insertion; files may be removed and text
edited if the combination would exceed that limit. Images are encoded text,
not vision input.

Every mutation runs in an IndexedDB read/write transaction. Matching content
received within ten seconds shares one entry. Exactly one claimant can start
an insertion. A completed insertion removes that claim; a failure or crash that
leaves a claim requires explicit review and another Add action. Recovery warns
that the destination draft may already contain the text. There is no automatic
replay or claim timeout that could silently duplicate an insertion.

Inbox items expire one hour after reception and are removed on the next inbox
operation. Browser shutdown prevents a promise of physical erasure at exactly
one hour. Origin storage can be read by code executing in that origin; this is
not an encrypted account vault. Insertion transfers content to the ordinary
draft, whose durability depends on the separate drafts option. A browser crash
after completed transfer can lose a draft when draft persistence is disabled.

## Verification

Parser, worker and UI unit tests cover byte limits, duplicate fields, raw-body
cancellation, explicit insertion, changed targets, recovery, discard and
cleanup failure. The worker and page use the same inbox implementation.

The real-browser laboratory script requires a flagged build and a disposable
local Chrome context:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core \
BROWSER_CDP=http://127.0.0.1:PORT \
node scripts/test-share-target.mjs /path/to/flagged-build /path/to/new-result.json
```

It verifies source identity against the emitted worker, actual IndexedDB
transactions under concurrent enqueue and claim, the ten-second duplicate
window, lazy expiry, corrupt-record cleanup, denied storage, multipart file
boundaries, controlled worker POSTs, an actual form navigation and page-close
retention. It records browser and source hashes. This is a synthetic share
request; it does not qualify an installed Android PWA or Android's share sheet.

The 2026-10-12 station run passed 21 real-browser checks in the hidden Sway
Chrome 155 context. Evidence is `share-target-functional-02.json` beside
`share-target-artifact-02`; the receipt contains the exact store and worker
hashes. Both that flagged build and `ordinary-artifact-share-check-01` passed
the PWA shell check with 43 files. `share-target-build-gates.json` confirms the
ordinary manifest and worker omit reception. The combined frontend check
covering this feature, controls and affected views passed 109 tests; typecheck
passed. These results do not change the pending acceptance below.

## Remaining acceptance

Install the exact flagged artifact on the S24 and share text, a URL, multiple
files, an oversized image and empty content from real applications. Repeat
while signed out, with no selected conversation and after the PWA has closed.
Check correction, cancellation, duplicate submission, account and host changes,
worker update, process death and site-storage eviction. Verify that no prompt
is sent before the user explicitly presses Send. Compare at least ten paired
tasks with copy/paste, recording task steps, time including corrections and
the user's utility score. Keep the feature only if those checks support the
registered benefit and reliability requirements.
