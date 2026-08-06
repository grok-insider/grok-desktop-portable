# Product VRMA aliases

Optional product-path loads (Stage `idleVrmaUrl` / `speakingVrmaUrl`):

- `idle.vrma` — default: VRMA Motion Pack **Greeting** (VRMA_02)
- `speaking.vrma` — default: **Show full body** (VRMA_01)

Full library + Studio picker: `../library/` (`catalog.json` + all 7 VRMA clips).

Portable falls back to procedural multi-bone clips if these files are absent
or fail to load. Re-sync from Downloads:

```sh
./scripts/sync-aether-library.sh
```

Credit: Animation credits to pixiv Inc.'s VRoid Project.
