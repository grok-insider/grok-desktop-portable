# ADR light 0020: In-SPA digital presence via Aether WASM

- Status: accepted
- Date: 2026-08-06
- Qualifies: [ADR light 0001](0001-work-only-sibling-product.md) (voice pipeline remains out; visual presence is in)

## Context

Portable is a Work-only browser surface over `grok-bridge` and the user's Grok
Build CLI. ADR 0001 excludes Electron, desktop voice, and a second shell.
Users still benefit from a **visual character** that idles on the landing page
and reacts when an agent turn is streaming.

The sibling project **Aether** is a multi-host avatar body (VRM, lip-sync levels,
motion). It ships a browser host (`aether-wasm` + thin TS façade) that does
**not** capture microphone or system audio and does not run agents.

Embedding third-party Persona (Electron + OS audio listeners) would violate
ADR 0001 and the single-binary release model. Driving a **native** Aether
widget is a valid companion path (MCP / loopback events) but is a separate
product decision. This ADR chooses the **in-SPA** host only.

## Decision

1. Portable may ship the **Aether browser host** (version-pinned WASM glue +
   `.wasm` binary) and a **same-origin VRM** (or temporary fixture fallback)
   inside `apps/web`.
2. The avatar mounts on **all SPA surfaces**: landing (no bridge required),
   Work home, and session. One React host high in the tree avoids remount
   thrash across probe transitions.
3. Activity is derived from existing session projections only
   (`SessionPhase`: `idle` | `streaming` | `interrupted`). No new bridge RPC
   and no ACP shape change in v1. Streaming drives synthetic mouth levels;
   idle/landing is calm idle motion.
4. Packaging keeps repos independent: Portable vendors **built** Aether WASM
   artifacts under `apps/web/public/assets/aether/` (or equivalent) with a
   `VERSION` pin and a sync script. The full Aether source tree is **not**
   a submodule of Portable.
5. Users can hide/show the avatar (`localStorage`, non-secret). Default: **on**.
6. Fail closed: if WASM or model load fails, the rest of Portable works and
   the avatar slot stays hidden (same spirit as the anonymous presence badge).
7. CSP allows WASM instantiation with `script-src 'self' 'wasm-unsafe-eval'`
   (hosted meta + bridge-embedded document CSP). Assets remain same-origin.

## Non-decisions (explicit)

- No system-audio capture, TTS, or microphone in Portable.
- No `aether-widget` / Electron packaging in Portable releases.
- No MCP server inside the SPA; optional companion MCP remains the user's
  `GROK_HOME` config against a separate Aether process.
- No user-supplied filesystem paths for models (same-origin bytes only).
- WebGPU MToon fidelity is Aether roadmap stretch; v1 is soft/software raster.

## Consequences

- SPA and bridge-embedded bundle grow by WASM (~1 MB) plus VRM size; size
  gates and optional toggle mitigate cost.
- ADR 0001 still forbids a voice product; marketing must not claim “voice”.
- Aether version skew is managed by pin + sync script documentation
  (`docs/aether-presence.md`).
- Reviewers treat avatar code as presentation only: no credentials, no
  workspace paths, no permission policy changes.

## Rejected alternatives

- **Embed Persona:** foreign Electron stack and OS audio; out of scope.
- **Native widget only:** excellent fidelity but not “inside” the SPA;
  remaining as optional companion.
- **Submodule Aether into Portable:** couples release history without need;
  vendored artifacts suffice.
- **Bridge POST to aether-control for v1:** useful later; not required for
  in-SPA form B.
