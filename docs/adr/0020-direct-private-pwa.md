# ADR 0020 — direct private PWA

Status: accepted product direction, implemented locally on 2026-10-13; release qualification remains open. Supersedes the relay-first entry in ADR 0019. The detailed release gates and publication policy are in [public-release-plan.md](../public-release-plan.md).

The production entry at `desktop.grok.me` lists locally paired computers. `remote.fabrials.com` redirects there with HTTP 308 and a Location without a fragment; browsers inherit the original fragment. A client-side fallback redirects an old cached shell before pairing or storage access. There is only one application storage origin. The application connects directly to each user's Spanreed through their private HTTPS/WSS endpoint. Tailscale is one supported network arrangement; a correctly secured user-managed domain is another. Loading the application requires neither a Fabrials account nor a managed host registry. There is no automatic cloud relay fallback. The former managed application remains a separate adapter for future work.

## Pairing and authority

`#directPair=` contains base64url UTF-8 JSON with `endpoint`, `installationId`, `hostPublicKey`, `nonce` and an optional `label`. The SPA consumes and clears this fragment before asynchronous operations. It rejects non-HTTPS endpoints, credentials, query strings, fragments, non-root paths and Fabrials product domains as private hosts. A replacement pairing is explicit; the installation and pinned host key belong to the saved profile.

The browser uses `wss://<endpoint>/remote`, subprotocol `fabrials.remote.v1`. The server's ready frame supplies a fresh `channelId`. Noise binds that channel and the installation to the pinned host public key. Existing paired browser identity is independent of Fabrials account cookies. The host checks exact document Origin, pairing and controller authority. TLS and Noise are separate protections; this does not make a compromised PWA origin safe.

Up to 32 profiles are stored using durable IndexedDB transactions. Draft identity includes endpoint, installation, host key and pairing. Protocol mismatch or malformed transport data is not authenticated revocation and cannot erase local drafts. A browser that is explicitly forgotten loses its scoped identity, drafts and notification registration. Apple clients must accept an experimental-platform notice; this is not an assertion of hardware qualification.

## Offline, updates and persistence

The service worker caches static application assets only. Navigation uses the installed shell without waiting for network. A version becomes usable only after its complete asset graph is stored; failed installation removes its incomplete cache. The active version and its predecessor remain available. The update and rollback actions are explicit, and rollback restores the previous graph rather than mixing previous HTML with current scripts. This selection survives worker restart.

An offline shell does not imply offline inference. The host and the CLI's configured services still need connectivity for their respective functions. Offline transcript history has its own explicit consent and is readable from the computer list without connecting. It stores messages and tool summaries only, never reasoning, image binaries or pending executable actions. Copies show their saved time and are read-only. Each conversation is bounded to 1 MiB and 10,000 rows; history and drafts share the same atomic 100 MiB browser budget. Reads and rehydration with unchanged content do not renew the seven-day expiry. Expired content is purged on reads and by a minute timer while its view is mounted; a closed browser cannot run an erasure timer. Deleting a conversation durably excludes it from further saving until the user turns history off and on. A single coalescing writer per mounted view takes the latest projection for each session; across tabs the last completed transaction wins because the current host projection does not carry a durable revision. Revocation erases drafts and history and rejects their prior consent epochs. A disconnected browser only learns remote revocation on its next authenticated connection.

Text and prepared image drafts require explicit recovery consent. They share one IndexedDB transaction boundary for erasure but separate records for text and Blob content. The global browser budget is 100 MiB; writes, initial consent and image writes all reserve against it atomically. Reads do not extend the seven-day expiry. Scope changes discard in-memory selections from the preceding computer, and revocation prevents in-progress preparation from restoring erased images. Storage errors preserve unsent in-memory work and never claim it was saved.

## Images

Typed content operations use protocol version 3; bootstrap, resume, events and text compatibility remain version 2. A host must advertise `contentProtocolVersion: 3` and `upstreamPrompt.image: true` before the image composer is enabled. This negotiated capability must be backed by qualified upstream behavior; the browser cannot establish model vision from a flag.

The browser accepts PNG, JPEG and WebP input, checks dimensions from the bytes, applies decoded orientation and strips metadata by redrawing. It requires at least eight pixels per side and 512 pixels in total, and limits originals to 25 MiB and 50 megapixels, selections to 100 MiB, and each message to eight images and 5 MiB of prepared content. Prepared files have a maximum side of 2000 pixels, at most 2,408,448 pixels, and at most 1,500,000 bytes each. Transparency is flattened onto white. The user can preview, remove or crop images. The crop editor supports pointer movement, resizing, keyboard arrows and named range controls. Apply replaces only the selected attachment after normalization; cancel, decode failure, session changes and revocation preserve the appropriate original selection and reject late results. No crop action sends a prompt.

Transfer is sequential in 32 KiB chunks, with SHA-256 and offset validation. Typed prompts carry host image IDs, never filesystem paths or base64 disguised as text. Losing control, connectivity or capability aborts before dispatch. An ambiguous dispatched command is never automatically resent. Transcript images are fetched lazily, with two active reads and a bounded waiting queue, checked against their content hash and displayed through revocable Blob URLs. Live ACP images reserve a placeholder by image ID so that delayed processing cannot attach an image to a later conversation turn.

## Notifications and external hosting

Direct notifications use the host's VAPID identity and an isolated, randomly named service-worker scope per computer. A push-only worker does not install or control the application shell. Push contents are generic and contain no transcript, endpoint or account identifiers. The push provider still sees subscription and delivery metadata. Forgetting a computer removes the local registration; host-side revocation removes its subscription.

Publications are a separate, explicit opt-in into Fabrials hosting. Their PKCE authorization, seven-day inactivity expiry, permanent withdrawal, cryptographic erasure and resource budgets are specified in the release plan. None of those account operations may gate private pairing or private use.

## Corresponding source

A full shell identity is computed from emitted files and the worker template;
the loaded HTML and worker cache name bind to it. The source/license dialog in
the computer list and Computer settings resolves only metadata for that identity.
Static deployment candidates include a content-addressed source archive, license
and dependency notices. Spanreed’s verifier reconstructs source Git trees and
checks the compiled shell, original inputs, installers and deployment configuration.
Missing, offline or older-shell metadata cannot silently select newer sources.
Source retention for every still-runnable release, including rollback, must be
qualified in hosting before public release.

The integrated PWA/Noise/Spanreed/Grok 1.0.52 vision trial passed 13 checks on
2026-10-13, including visible attachment and image-only fact extraction after
host-history reload. See `spanreed/docs/evaluation/direct-vision-2026-10-13.json`
and [implementation evidence](../direct-pwa-implementation.md). That isolated
laboratory result does not establish real-device or production-network readiness.

## Evidence boundary

Unit tests and a successful encrypted build are development evidence. They do not qualify Tailscale, a custom TLS reverse proxy, Windows ACL/lifecycle, Android background execution, push delivery or Apple devices. Reports must identify the artifact, real versus synthetic upstream, browser and network arrangement. The previous relay evaluation is historical evidence for that earlier implementation.
