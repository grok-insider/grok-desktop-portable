# Grok Desktop Portable design

Every surface in `apps/web` (the private Remote PWA, the local web mode served
by `spanreed agent`, and the blocked-origin page) follows **Fabrials UI
Highstorm**. The house guide is the `DESIGN.md` shipped inside
`@fabrials/ui` (`apps/web/node_modules/@fabrials/ui/DESIGN.md`, version pinned
in `apps/web/package.json`). This file records only how Portable consumes it
and where Portable deliberately differs. Behaviour, probe states and screen
contracts stay in [docs/ui.md](docs/ui.md).

## How Portable consumes Fabrials UI

- `@fabrials/ui` and `@fabrials/ai-ui` come from the public npm registry at an
  exact version. The lockfile is the corresponding-source reference; nothing is
  vendored or edited locally.
- `main.tsx` imports, in this order: `src/styles/layers.css` (declares
  `theme, base, components, utilities` so Tailwind's preflight cannot override
  component styles), `@fabrials/ui/tokens.css`, `src/styles/fonts.css`,
  `@fabrials/ui/styles.css`, `@fabrials/ai-ui/styles.css`, Sonner's stylesheet
  and `src/styles.css` (Tailwind and the Fabrials Tailwind bridge).
- `src/styles/fonts.css` copies the package's `@font-face` rules for IBM Plex
  Sans, Plex Mono 400/500/600 and Plex Sans Condensed 600 only. Serif and
  Condensed 500 are not shipped, because the service worker precaches every
  asset. Font files are emitted as hashed assets; inlining is disabled
  (`assetsInlineLimit: 0`) because the CSP has `font-src 'self'`.
- Theme: the preference stays in `grok-light.theme` (system → light → dark).
  `public/theme-init.js` applies `.dark` and the `theme-color` meta before
  first paint, and `applyResolvedTheme` keeps the meta in sync
  (`#eceeeb` light, `#161a21` dark, the Highstorm surfaces).
- `src/styles.css` defines no colour values. Its `:root` block maps the
  remaining Portable-only names (`*-soft`, `primary-hover`, shadows) onto
  Fabrials tokens; it is removed as views move to Fabrials components.

## Content Security Policy

Production serves `style-src 'self'`, `font-src 'self'` and
`script-src 'self' 'wasm-unsafe-eval'`. Three guards keep Fabrials UI within it:

1. The root renders inside Base UI's `CSPProvider disableStyleElements`, and
   `src/styles.css` supplies the one rule Base UI would otherwise inject
   (`.base-ui-disable-scrollbar`).
2. `scripts/csp-policy.ts`, run from the build, rejects bundled modules that
   inject style elements or set inline style text, and the Fabrials entries
   that depend on them: the command palette (cmdk, Radix), charts (Recharts),
   carousel (Embla), the number ticker (Motion) and ai-ui's provider icons.
   React DOM's hoisting code is the only allowance; it runs only when a
   component renders a `<style>`, which guard 3 forbids.
3. The test setup fails any test after which a `<style>` element exists, and
   Sonner's style injector is stripped in tests as in production.

Inline `style` props set through React (CSSOM) remain allowed.

## Licences

The production licence list accepts MIT, ISC, OFL-1.1, Apache-2.0, 0BSD,
BSD-3-Clause and the exact expression `MIT AND ISC`, compared as strings.
Packages that ship no licence file get a reviewed upstream text from
`apps/web/scripts/license-supplements/`, bound to the package version, the
hash of its `package.json` and the hash of the text; nested notices such as
`victory-vendor`'s `lib-vendor/*/LICENSE` and `@fabrials/ui`'s font OFL are
required by hash. A version bump fails the build until the supplement is
reviewed again.

## Exceptions to the house guide

| Exception | Why |
| --- | --- |
| Send and Stop are both visible while a turn runs, on every viewport | Several devices may write to one conversation; a queued message must be sendable with a visible control, so ai-ui's `ChatComposer` (which hides Send behind Stop on phones and renames it) is not used. The composer is Portable's own, restyled with Fabrials tokens. |
| Landscape compact composer and hidden host bar at a visible height of 300 px or less while typing | Measured on the S24: otherwise the editor and Send are clipped under the keyboard. |
| 44 × 44 px targets on coarse pointers and narrow screens | Same as the house rule; listed because qualification measures it. |
| Monospace textbox in shell mode | The shell composer edits commands. |
| Gem `stormlight` | Owner decision for Grok Remote; the house guide assigns Ruby to Spanreed. |
| English-only interface | Portable has no localisation yet; layouts use logical properties so RTL can follow. |
| Stable selectors | Accessible names, ids, `data-*` hooks and the classes listed in `docs/ui.md` are part of the qualification contract and survive restyling. |
