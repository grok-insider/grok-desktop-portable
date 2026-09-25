# Site sources (`desktop.grok.me`)

`install.sh` and `install.ps1` are the public installers for Spanreed, the
local agent host. `scripts/prepare-public.mjs` copies them next to the Work SPA
in `public/`, which Vercel serves at `https://desktop.grok.me`.

`release-footer.md` is appended to GitHub Release notes. `index.html` is a
static landing page kept for reference; the deployed root is the SPA.
