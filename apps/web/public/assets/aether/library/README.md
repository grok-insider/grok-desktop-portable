# Aether asset library (dogfood)

Drop **models** (`.vrm`) and **animations** (`.vrma`) here for Studio pickers
and agent debug APIs. Same-origin only — never user filesystem paths from the SPA.

```text
library/
  catalog.json          # index (edit when adding files)
  models/               # optional extra .vrm (product Ani stays at ../avatar.vrm)
  animations/           # VRMA clips (pixiv VRoid Motion Pack shipped for dogfood)
```

## Add a model

1. Copy `MyChar.vrm` → `models/MyChar.vrm`
2. Append to `catalog.json` → `models`:

```json
{ "id": "mychar", "label": "My Char", "path": "models/MyChar.vrm", "tags": [] }
```

## Add an animation

1. Copy `clip.vrma` → `animations/clip.vrma`
2. Append to `catalog.json` → `animations` with `suggestedSlot`: `idle` | `speaking` | `custom`

## Sync from Downloads (VRMA Motion Pack)

```sh
# from grok-desktop-portable/
./scripts/sync-aether-library.sh
```

## License (shipped VRMA)

pixiv Inc. VRoid Project Motion Pack. Credit:
**Animation credits to pixiv Inc.'s VRoid Project**.
See `animations/Readme_VRMA_MotionPack_EN.txt`. Not for unauthorized redistribution
as extractable motion assets.
