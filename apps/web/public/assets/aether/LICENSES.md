# Aether assets (Portable)

## Runtime (WASM)

Aether source is dual-licensed MIT OR Apache-2.0. Vendored glue and
`aether_bg.wasm` are built from the Aether repository; see the pinned
`VERSION` file in this directory.

## Avatar model (`avatar.vrm`)

Default local character for dogfood: **Ani** (`Ani.vrm` under the
`grok-insider` workspace root).

- Install: `cp ~/dev/opensource/grok-insider/Ani.vrm apps/web/public/assets/aether/avatar.vrm`
  or `./scripts/use-local-ani.sh`
- The file is **gitignored** (~27 MB). Do not commit it.
- Redistribution / public site deploys need an explicit license clearance for
  this model. Until then, use only on local machines.

If `avatar.vrm` is missing, the SPA falls back to Aether’s in-module minimal
fixture.

## Animations (`library/animations/`, `animations/`)

Dogfood ships **pixiv Inc. VRoid Project VRMA Motion Pack** (7 clips):

- Source: `VRMA_MotionPack` (local Downloads / VRoid distribution)
- Paths: `library/animations/VRMA_0N_*.vrma` (+ aliases `animations/idle.vrma`,
  `animations/speaking.vrma` for product path)
- **Credit required:** *Animation credits to pixiv Inc.'s VRoid Project*
  (JP: キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト)
- Terms: see `library/animations/Readme_VRMA_MotionPack_EN.txt`
- Re-sync: `./scripts/sync-aether-library.sh`

Do not redistribute the motions as extractable/riggable assets outside the
pack’s license scope.
