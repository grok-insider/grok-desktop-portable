# ADR 0019: Grok Remote and the private HTTPS PWA

- Status: accepted for implementation; public rollout requires integration and device qualification.
- Date: 2026-10-08
- Supersedes the loopback-only, WebKit exclusion and disconnect rules in ADRs 0002, 0006, 0008 and 0016 for the new remote modes. Existing desktop.grok.me retains its loopback path.

## Decision

Reuse the Portable Work application for remote.fabrials.com. Each user signs in to Fabrials, chooses a registered Spanreed computer and separately pairs the browser to that computer using a QR link. The account permits relay access; the paired device key permits computer control. The computer runs the user's Grok CLI and shares its leader session with the terminal.

Live terminal continuity requires the official TUI to start with `grok --leader`, using the same user account, `GROK_HOME` and leader socket as Spanreed. `--leader-socket` alone only selects a path; it does not enable leader mode. A terminal already using the embedded engine must finish its current turn, exit and reopen with `grok --leader --resume <session-id>`. Reading that session's persisted history is not evidence that its active engine is shared. Grok can fall back to its embedded engine if leader connection fails, so live qualification must observe the same prompt and permission in the terminal and PWA before approving it.

The public application uses an injected `HostTransport` backed by the Noise channel. The transport exclusively handles session establishment, typed commands, event subscriptions and heartbeats. It never falls back to HTTP, loopback or unencrypted relay messages. An unavailable crypto module prevents connection. The connector owns device keys and pairing credentials in IndexedDB; LightClient does not write remote session grants to localStorage. The relay may observe endpoints, connection times and encrypted traffic sizes. Web application integrity and device integrity remain trusted.

The same bundle on an HTTPS private origin uses same-origin HTTP/WSS and its own pairing grant. It ignores remembered loopback ports and does not discover or fall back to a cloud relay. The host operator configures Tailscale Serve and the exact allowed origin. Tailscale Funnel is not this private mode.

HTTPS remote/private modes permit WebKit. The earlier WebKit block remains on desktop.grok.me's public-to-loopback path. Allowing the engine is not evidence of successful iPhone qualification.

## Recovery

Network loss retains pairing and the in-memory conversation/draft. It never cancels a running CLI turn. The client backs off, offers retry after its reconnect budget, and reconnects after returning from suspension or going online. A browser loses its grant only after an authorization failure or explicit revocation, not a health probe timeout.

The controlling epoch comes from the host's `controlling:<epoch>` hello. Shared/private HTTP also receives a random `controllerToken` in that connection's direct hello and sends it as `x-grok-light-controller`; authorization requires the authenticated session, epoch and token together. This token stays in memory, is never broadcast or persisted, and is cleared on disconnect or watching. Managed control is bound to the authenticated encrypted channel. The browser sends a heartbeat every five seconds, resumes events after its last cursor, removes duplicates and clears projections on `replayReset` before snapshots restore them. A prompt receipt leaves its turn running until a host event settles it. Pending prompt identifiers are queried after reconnect; prompt bodies are never queued in browser storage or automatically submitted again. Terminal answers remove pending permission and interaction cards.

A socket becomes usable only after an authorized `controlling:<epoch>` or `watching` hello, not merely the WebSocket open event. A silent connection times out after ten seconds; repeated opens without that hello consume the eight-retry budget. Same-authority storage refreshes update credentials without another resume request. Replacing or deleting the grant in another tab reloads the document to discard the old connection, forms and pending callbacks.

Shared prompts emit `promptSent` with the public idempotency key when dispatch begins. Both controller and observers render that confirmed event; the controller replaces its matching optimistic entry instead of appending a duplicate. Legacy hosts that omit the event retain the optimistic path. Model and reasoning effort labels come from the selected session's inspector metadata; the catalog's default never represents the settings of an already-running terminal session.

## PWA storage and updates

The service worker precaches a build-specific allowlist of static shell files. It never caches session APIs, account APIs, commands, conversations, attachments, unknown paths, requests with query parameters or foreign origins. Navigations can fall back to the static index when the network is unavailable. There is no background command synchronization. Updates remain waiting until the user selects Update and reload; the button names the reload so an in-memory draft is not silently lost.

On iOS the installed application can use separate browser storage. Installation precedes pairing. Private and public origins always pair independently.

Lease lifecycle messages (`agent_ready`, `agent_restarting`) do not alter control. Only `controlling:<epoch>` and `watching` change it. A watching browser keeps its draft and has an explicit Retry control action, which reconnects without taking control from a live holder. Pending permissions and interactions queue by request id; reconnect remains reachable inside an open dialog, and a disabled form cannot send through Enter.

Forget this browser uses the target-free `forgetBrowserPairing` operation: the authenticated host revokes only the caller, including a watching browser. Deleting the browser's host-specific IndexedDB record follows successful host acknowledgement. Leaving the computer view closes the channel without removing that record. Only encrypted authenticated host messages may report a revoked local pairing; an unauthenticated relay close is treated as a connection loss.

## Public conversations

Only a host-produced `previewShare` document may be published. The user reviews its messages, tool calls, textual results and diffs, then explicitly consents to future synchronization. The browser creates a separate publication grant and delivers it to the host through the encrypted channel. It does not derive publication data from the UI's reasoning or transcript projection and never stores upload grants.

An active publication has a persistent visible indicator, including in a watching browser. The home screen lists active public links directly from the account service and can withdraw them without opening a host connection. Withdrawal revokes server access first; a controlling browser also asks the host to stop synchronization, but successful withdrawal never depends on that message. Watching browsers cannot prepare or create publications. Losing control closes a preview and discards late preview replies; a publication grant received after control is lost is withdrawn before reaching the host. If publication startup is uncertain, the browser attempts server revocation and retains the withdrawal control until that succeeds. Published text can contain secrets previously read by the CLI; withdrawing a link cannot recall copies downloaded by readers.

## Qualification

Run the web unit suite, types, production build and public assembly checks. Integration must exercise the official Grok binary, relay reconnect, expired cursor, revoked browser and terminal approvals. Real Android and iOS installation, suspension, keyboard and mobile network handoff remain release gates. A passing browser unit suite does not satisfy them.

## Build and interoperability

`build:remote` requires `FABRIALS_REMOTE_CRYPTO_DIST`, pointing to the output of the shared `fabrials-remote-noise` WASM build and wasm-bindgen web-target generation. Required files are `fabrials_remote_noise.js` and `fabrials_remote_noise_bg.wasm`. Vite emits them together under `/crypto/<content-hash>/` and includes their actual content in the shell-cache version. A missing crypto input fails the remote build. The ordinary desktop build can omit it; remote connection then fails closed with an explicit unavailable state.

```sh
FABRIALS_REMOTE_CRYPTO_DIST=/path/to/generated/crypto node scripts/build-remote.mjs
node scripts/test-remote-crypto.mjs /path/to/generated/crypto /path/to/native/interop
```

The native peer is the `interop` example in the same Noise crate. The script uses synthetic keys and stdio; it tests the actual generated WASM against native Rust, including a fragmented 2 MiB roundtrip, replay rejection, altered ciphertext, host identity substitution and relay channel substitution. It does not contact a user's host or provider. Compilation artifacts are build inputs, never placeholders checked into the SPA source.


## Local quality harness

`remoteTransport.test.ts` exercises the real connector lifecycle with synthetic Noise and storage ports plus a simulated relay socket: handshakes, lease heartbeats through restart events, stale callbacks, explicit disposal, revocation classification and no command replay after disconnect. This does not replace the native/WASM interoperability check or a real IndexedDB/relay browser run.

`node scripts/check-pwa-build.mjs apps/web/dist --require-crypto` verifies the built shell graph, absolute deep-link asset URLs, CSP prerequisites, manifest, icon dimensions, a versioned JS/WASM pair and successful WASM compilation. `build:remote` runs it automatically. Ordinary CI runs the shell check without requiring Remote crypto; the native Remote distribution builder provides the real crypto inputs and verifies the Remote artifact separately.

The synthetic browser fixture in `apps/web/qa` bundles the actual React application, styles and IndexedDB adapter into one local HTML file. It exercises no real account, filesystem command or agent. Chrome on station has exercised the fixture at narrow widths in both themes, permissions, questions, control loss, reconnect and real IndexedDB persistence/deletion. The actual review artifact has separately passed local service-worker installation, offline deep-link fallback, cache boundaries and an explicitly accepted worker update. Reproduction, results and remaining release gates are in `apps/web/qa/README.md`; these checks do not qualify the managed account/relay path or standalone mobile installation.
