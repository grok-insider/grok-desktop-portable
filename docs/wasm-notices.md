# Rust/WASM notices for the static Remote deployment

The hosted PWA distributes `fabrials_remote_noise_bg.wasm` and its generated
JavaScript glue. The existing PWA notice file covers JavaScript, CSS and fonts;
it does not cover Rust dependencies or the linked Rust standard library. Serving
the static PWA therefore requires this additional notice supplement even when
no native Spanreed executable is downloadable.

`scripts/wasm-notices.py` produces a supplemental artifact without changing any
PWA, service-worker, source-archive or native-executable bytes. The hosting adapter
serves the additional immutable `/sources/<sha256>.wasm-notices.txt` resource,
links it from `/licenses`, and includes its URL as an HTTP `Link` with
`rel="license"` on the WASM and generated JavaScript responses. The adapter must
also retain the existing PWA notices, own license and corresponding-source links.
The descriptor and supplemental file are included in the hosting artifact's
integrity manifest. They are not replacements for the original source proof.

## Generation

```sh
python3 scripts/wasm-notices.py generate \
  --artifact /path/to/reviewed-vercel-artifact \
  --notices /path/to/new-notice-directory \
  --libs /path/to/exact-reviewed-libs-checkout \
  --rust-source-archive /path/to/rustc-VERSION-src.tar.gz \
  --rust-copyright /path/to/matching-rustc-doc/COPYRIGHT-library.html
```

Generation requires Python 3.11 or newer, Cargo, the exact Rust compiler version,
a clean libraries checkout at the revision recorded by the artifact, and the
original `.crate` archives in Cargo's cache. It performs no package downloads.
The Rust source archive and copyright document must come from the same reviewed
toolchain distribution used for the WASM build. The installed Nix derivation's
`src` and `doc` output provide those inputs on station; the script does not
assume paths from another machine.

The generator reads `Cargo.lock` from the actual corresponding-source archive
and requires the checkout's lockfile to match byte for byte. Cargo metadata is
resolved offline for `wasm32-unknown-unknown`; the normal/build dependency closure
starts at `fabrials-remote-noise`. This conservatively includes build macros and
features unified by the workspace. It is not a statement that each selected
crate survives linker elimination.

For each registry crate, the original compressed archive must match the checksum
in that exact lockfile. The package's license declaration is checked against
Cargo metadata and a reviewed allowlist. All original LICENSE, NOTICE, COPYING,
COPYRIGHT and UNLICENSE files are copied without trimming, newline conversion or
rewriting. A new license declaration fails generation until reviewed. Rust's
own copyright/license texts, selected standard license texts, all notices from
its `library/` subtree (including vendored crates, compiler-builtins and libm),
and its `COPYRIGHT-library.html` are included. This intentionally covers a
superset of the platform-specific standard library. Rust's copyright document
is preserved as original HTML text inside the plain-text supplement.

`wasm-notices.json` records the original deployment-manifest digest, WASM and glue
paths/digests, libraries revision, source lock digest, compiler identity,
registry archive checksums, Rust source archive digest and every original
notice's byte range and hash. The supplemental resource is named by its own
SHA256. No local filesystem paths or credentials are recorded.

## Verification

```sh
python3 scripts/wasm-notices.py verify \
  --artifact /path/to/reviewed-vercel-artifact \
  --notices /path/to/notice-directory
python3 scripts/wasm-notices.test.py
```

Verification requires neither a libraries checkout nor registry/network access.
It checks the bound artifact and actual crypto bytes, the source archive checksum,
its libraries identity and lockfile, every listed package checksum, all original
notice ranges, canonical output, mandatory crypto/Unicode/compiler-builtins
attributions and the exact payload file set. The containing deployment must
first pass its original corresponding-source verifier. The supplement is a
reviewed build input; verification does not independently redownload registry
archives or reconstruct Cargo feature resolution from the descriptor. Generation
is the step that establishes those upstream inputs; retain its receipt and
review this inventory when upgrading dependencies or the Rust toolchain.

## Qualification on 2026-10-13

The candidate at Portable `2aaed2e11cc88aced4e7c216f698308eae718967`, libraries
`f4318f623b74cf443d36c219a0de08b763112c48` and Spanreed
`ba2b06568f058d6a68ca6d7707a0c3bcb1f5ad79` uses Rust 1.98.1
(`48a229cea`, 2026-09-01). Its supplement includes 49 registry crates and
standard-library notices, with 182 original files in 981,195 bytes. Its SHA256
is `02e412879dea7d776154789c85c4d311b03859ee6b89380dabca3296f0fb0ad9`.
The originals include BSD-3-Clause notices for `curve25519-dalek` and `subtle`,
Unicode-3.0 for `unicode-ident` and Rust's Unicode tables, and the compiler
builtins/libm license texts. The generated descriptor records exact versions.

The earlier native inventory's `option-ext` MPL-2.0 and `webpki-roots`
CDLA-Permissive-2.0 are outside the Noise WASM dependency closure. Those crates'
source is not included merely by serving a lockfile that names them. Their
redistribution requirements remain a gate before serving native Spanreed
executables or installers that bundle them. This supplement does not qualify
those binaries, native platform/feature graphs, or a general public native
release. A static QA deployment serving only the reviewed PWA, source archive
and these notices does not distribute that native binary.
