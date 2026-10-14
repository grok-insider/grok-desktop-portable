# Firefox direct-mode qualification — 2026-10-14

The exact r3 shell passes **80 multiwriter checks** and **85 multi-host checks**
in Firefox **157.0**, using Playwright **1.64.0**'s Firefox build 1555 on station.
The same final runner passes **107 multi-host checks** in Chrome 155.0.8059.39.
These are separate runs with overlapping baseline checks, not 272 distinct
product requirements. No application or Rust runtime source changed.

The evidence is [direct-firefox-browser-2026-10-14.json](evaluation/direct-firefox-browser-2026-10-14.json).
All three final runs used runner SHA-256
`af0bfb482c806c8f4837caff87962f7c07a21a1c86ff27b0d4d4828cd2306350`.
The Firefox executable and `libxul.so` hashes, helper hash, native fixture hash,
source download identity and cleanup results are included in the receipt.

## What passed

The browser loads the emitted Noise WASM, pairs through the UI with the real
native fixture, preserves the browser origin during the private handshake,
removes the pairing fragment, and downloads the exact corresponding-source
archive and attribution files. Two independently paired contexts can write
without takeover; model/effort changes converge, stale configuration and queue
mutations are refused, FIFO executes accepted messages exactly once, removed
messages never execute, and reload during a turn preserves its ID and receipts.
The empty model catalogue leaves no selectable model.

A consented draft and history survive reload. With the application origin
blackholed, the cached shell opens in 89 ms and 114 ms in the two Firefox runs;
these single observations are not a performance benchmark. Saved history stays
readable with both application and host unavailable, and the paired native host
remains usable when the website is unavailable. Explicit revocation removes the
saved profile and durable draft/history scope.

The multi-host run uses two isolated native fixture processes whose histories
intentionally share a conversation ID. It rejects swapped host keys and
installation IDs, keeps drafts/history scoped to their host, makes no host
connection attempt when reading offline history, survives switching to B while
A has a failed pending retry, and revokes A without deleting B's pairing or
history. B survives reload; final cleanup removes both scopes. Computer cards
retain useful identity width and 44 px controls at 390 and 2560 px in both themes.
The multiwriter mobile screenshot and selected mobile/light and desktop/dark
computer-list screenshots were also inspected visually.

## Browser isolation and harness changes

`scripts/qualify-direct-browser.ts` keeps Chromium as its default. With
`REMOTE_QA_ENGINE=firefox`, the new `scripts/qa/direct-firefox.ts` launches a
separate headless Playwright Firefox server and contexts. It uses neither the
daily browser nor the desktop compositor; the Chromium branch retains its
separate hidden Syl compositor. The Firefox browser is a Playwright distribution
with automation patches, not a retail Firefox installation.

Firefox has no Chromium host-resolver mapping flag. A loopback CONNECT proxy
therefore accepts only the exact fixture/application authorities on port 443,
and always connects upstream to the one local TLS fixture port. It never
resolves a requested upstream hostname. Every run first sends a real CONNECT
for an unlisted hostname and requires 403. In the final runs the one rejected
connection is this negative control; accepted connections numbered 19 and 20.
Ordinary HTTP proxy requests return 405. Headers, sockets, launch/connect time
and shutdown are bounded. Child processes enter the existing PID/process-group
cleanup; the helper verifies removal of its owned temporary Firefox profile.
All final runs closed their browser, retired their recorded process groups and
left their supervising scope empty. This is trusted test-process cleanup, not
an adversarial containment guarantee.

The native fixture binary already existed. Its source differs from the r3
runtime only in the previously recorded fixture lifetime configuration; this
work did not rebuild Rust. The ongoing 24-hour Chrome soak uses its separate
frozen `480f1be` checkout, driver and browser and was not changed or restarted.

Two test defects were exposed and corrected without changing r3. First, the
computer-list heading becomes visible before its asynchronous refresh finishes;
the revocation check now waits for the explicit empty-list heading before
asserting that Connect is absent. Second, Firefox words the deliberately blocked
WebSocket error differently from Chrome. That exact Firefox signature is
classified as expected only while its specific fixture host is deliberately
blocked. The failed runs remain listed in the receipt. An absent-executable
negative control also exited promptly without starting a browser.

## Reproduction

Use a fresh private directory with the laboratory TLS key/certificate described
in [remote-browser-qualification.md](remote-browser-qualification.md), the exact
r3 artifact and its matching source-verifier checkout. For this recorded run:

- Driver: `/home/friend/.cache/fabrials-remote-firefox-driver/node_modules/playwright-core/index.mjs`, version 1.64.0.
- Browser: `/home/friend/.cache/fabrials-remote-firefox-qa/firefox-1555/firefox/firefox`, version 157.0.
- Native fixture: `/home/friend/dev/fabrials/.worktrees/remote-libs/target/debug/examples/direct_browser_fixture` and its existing sibling fake ACP executable.

Set `REMOTE_QA_ENGINE=firefox`, `REMOTE_QA_FIREFOX` to that executable,
`REMOTE_QA_PLAYWRIGHT` to the matching driver, `DIRECT_QA_NATIVE_BINARY` to the
fixture, `REMOTE_QA_ARTIFACT` to r3, and `REMOTE_QA_SPANREED` to r3's matching
source verifier. Then use **one** of `REMOTE_QA_MULTIWRITER=1` or
`REMOTE_QA_MULTIHOST=1` and run:

```sh
bun scripts/qualify-direct-browser.ts /absolute/fresh/private-directory
```

NixOS needs the browser's shared libraries exposed in this command's
`LD_LIBRARY_PATH`. They already existed in the Nix store; no system setting or
global package installation was changed. The path was generated with
`lib.makeLibraryPath` over `gtk3`, `pango`, `atk`, `cairo`, `gdk-pixbuf`, `glib`,
`stdenv.cc.cc.lib`, `libxcb`, `libX11`, `libXext`, `libXrandr`, `libXcomposite`,
`libXcursor`, `libXdamage`, `libXfixes`, `libXi`, `libXrender`, `alsa-lib`,
`freetype`, `fontconfig` and `dbus` from the host's current nixpkgs. The patched
browser and driver were installed only into the named user QA caches. The
older 1.58.2 Playwright cache used by the soak was left unchanged.

## Explicit limits

Firefox omits seven Chromium CDP touch-media assertions and sixteen assertions
for the two short touch viewports, 750×136 and 667×136. Those omissions are
recorded, never counted as passes. Other layout assertions run at 2560×1440,
390×844, 844×390, 750×354 and 390×430 with desktop pointer semantics. The install
banner is a synthetic event exercising application layout; it does not prove
native Firefox installation support. Firefox soak, upgrade/rollback, crop and
image-layout combinations are explicitly refused by this runner until qualified.

This closes laboratory direct-mode evidence for this Firefox 157.0 build. It
makes no claim for every Firefox version, historical Firefox 84, retail 157.0.1,
Android Firefox, other operating systems, real keyboard or assistive technology,
trusted TLS/Tailscale, production CDN routing, push delivery, real Grok inference,
provider outages or GPU performance. Public release and publication gates remain
subject to their separate acceptance evidence.
