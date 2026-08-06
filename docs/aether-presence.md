# Aether presence (in-SPA)

Portable embeds an optional visual character on landing and Work surfaces.
Architecture: [ADR light 0020](adr/0020-in-spa-aether-presence.md).

**Present path (product):** `@pixiv/three-vrm` + three.js **WebGL (GPU)** (same
class of stack as the VRoid Hub viewer). Soft-raster Aether WASM remains
available as a fallback path for headless/CI tooling, not for product fidelity.

**CPU vs GPU:** draws go through the GPU via WebGL. High main-thread CPU was
mostly from unbounded `requestAnimationFrame` + large drawing buffers + VRM
spring/bone JS updates. The product path caps idle at ~24 FPS, speaking at ~30,
and caps the WebGL buffer long edge (~720) with a modest DPR budget.

**Animation:** multi-bone humanoid idle/speaking clips via `AnimationMixer`
(`@aether/studio`). Optional authored VRMA:

```text
apps/web/public/assets/aether/animations/idle.vrma
apps/web/public/assets/aether/animations/speaking.vrma
```

If a VRMA is missing or fails to load, the procedural clip is used.

## Aether Studio (devtools addon)

Reusable package: `@aether/studio` (sibling `aether/packages/studio`).

Floating **Studio panel** on the page (devtools chrome — not a native tooltip):
tools for model/anim/camera/lights plus a live **metrics strip** (consumption).

| Open | How |
|------|-----|
| Query | `?aetherStudio=1` (also works on production builds) |
| Dev | Vite `import.meta.env.DEV` allows Studio by default |
| Pin | Debug tab → “Pin Studio allowed” (`localStorage` `aether.studio.pinned`) |
| UI | **Studio** button next to Hide character |
| Keyboard | `` ` `` or `Alt+A` toggle · **Esc** closes panel |

Panel tabs: Stage, Model, Anim, Camera (orbit/zoom/pan), Lights, Debug
(metrics: FPS, tick/render ms, draw calls, tris, buffer, heap, clip, GPU).
Frame ms &gt; 20 is highlighted. While the panel is open, FPS cap rises (~45)
for dogfood, then restores product 24/30.

**Library folder** (pick models / animations in Studio):

```text
apps/web/public/assets/aether/library/
  catalog.json
  models/          # drop extra .vrm + register in catalog
  animations/      # VRMA Motion Pack (pixiv) — 7 clips for dogfood
```

Sync pack from Downloads: `./scripts/sync-aether-library.sh`.

**Bundle:** product keeps `createStage` (avatar needs three-vrm). `StudioPanel`
and its CSS load only when the panel opens (`@aether/studio/panel` +
`styles.css` dynamic import).

### Agent debug API (`window.__AETHER_STUDIO__`)

When the stage is ready **and** Studio gate is allowed, Portable attaches an
agent bridge (no panel required):

```js
// agent-browser / CDP
await __AETHER_STUDIO__.help()
JSON.stringify(__AETHER_STUDIO__.getMetrics())
await __AETHER_STUDIO__.listLibrary()
await __AETHER_STUDIO__.loadAnimation('vrma-05', 'custom')  // Spin
__AETHER_STUDIO__.setActivity('streaming', 0.8)
__AETHER_STUDIO__.openPanel()
```

Gate off → global absent. Metrics never leave the machine.

```sh
# dogfood
./target/debug/grok-bridge serve
# open with studio:
# http://127.0.0.1:PORT/?aetherStudio=1#pair=…
```

Add the same addon to another frontend: see `aether/packages/studio/README.md`.

**Model:** local `avatar.vrm` is [Grok / Ani](https://hub.vroid.com/en/characters/5711086475542678984/models/6650274796677868428)
(VRoid Hub; redistrib restricted — gitignored).

## Layout

```text
apps/web/public/assets/aether/
  VERSION                 # pinned Aether wasm package version / git describe
  runtime/
    aether.js             # wasm-bindgen ESM glue
    aether_bg.wasm
  avatar.vrm              # optional packaged model (same-origin)
  LICENSES.md             # model + runtime attribution
  manifest.json           # distribution metadata
```

SPA code lives under `apps/web/src/services/aether/` and
`apps/web/src/components/aether/`. The thin TS façade is vendored (same API as
`@aether/runtime`); it does not pull Aether source into this repo.

## Sync WASM from Aether

From a checkout of the sibling Aether repo (default `../aether`):

```sh
./scripts/sync-aether-wasm.sh
# or: AETHER_ROOT=/path/to/aether ./scripts/sync-aether-wasm.sh
```

Rebuilds or copies `crates/aether-wasm/pkg/` into `apps/web/public/assets/aether/runtime/`
and writes `VERSION`. Portable CI does **not** require a Rust wasm toolchain
when these files are committed.

## Model load policy

1. Fetch same-origin `assets/aether/avatar.vrm` when `manifest.json` marks it
   distributable and the file exists.
2. Else `loadFixture()` (minimal VRM built into the wasm module).
3. Else hide the avatar (fail closed).

Never pass a user filesystem path into the loader.

### Local Ani (dogfood)

```sh
./scripts/use-local-ani.sh          # copies ../Ani.vrm → public/…/avatar.vrm
./scripts/sync-aether-wasm.sh       # full wasm (~2.6 MB; stub 0.8 MB cannot load Ani)
pnpm build:web:dist && cargo build -p grok-bridge
./target/debug/grok-bridge serve
```

`avatar.vrm` is **gitignored** (~27 MB). Runtime wasm is version-pinned and
cache-busted via `assets/aether/VERSION`.

## Activity mapping

| Condition | Avatar |
|-----------|--------|
| Landing / home / session idle | Idle motion, level 0 |
| Session `phase === "streaming"` | Speaking + synthetic level LFO |
| Session `interrupted` | Low activity / not speaking |

No bridge RPC in v1. See `apps/web/src/services/aether/activity.ts`.

### Local QA without a bridge

```sh
pnpm --filter @grok-desktop-portable/web dev
# idle (default landing):
open http://127.0.0.1:5173/
# force speaking LFO on landing:
open 'http://127.0.0.1:5173/?aetherPhase=streaming'
```

`?aetherPhase=streaming|idle|interrupted` overrides the React phase for
smoke tests only.

### End-to-end with embedded SPA + real agent

```sh
pnpm build:web:dist
cargo build -p grok-bridge
./target/debug/grok-bridge serve   # terminal A
./target/debug/grok-bridge open    # terminal B — open the 127.0.0.1 URL
```

Checklist:

1. Landing or Work shows avatar; `data-ready="true"` after lazy load.
2. Pair → project → **New session**.
3. Send a short prompt; during the turn canvas mean luminance should vary
   (speaking LFO); agent reply appears; avatar returns to idle.
4. `GET /assets/aether/runtime/aether_bg.wasm` is `200` with
   `Content-Type: application/wasm`.
5. Document CSP includes `script-src … 'wasm-unsafe-eval'`.

Validated on this machine (2026-08-06): pair + session + “Reply with exactly:
pong” → Working observed, canvas mean range ≈10 over the turn, no console
errors, avatar stayed ready.

## User preference

`localStorage` key `grok-portable-aether.visible` (`"0"` hides). Not a secret.
Default visible.

## CSP

`script-src` must include `'wasm-unsafe-eval'` for WASM instantiate (Chromium).
Hosted: Vite meta CSP. Bridge embed: `CONTENT_SECURITY_POLICY` in
`crates/grok-bridge/src/server.rs`.

## Non-claims

- Not a voice product; no mic or system audio capture.
- Cosmetic only; does not change permissions or tool policy.
- Credentials never touch the avatar path.
