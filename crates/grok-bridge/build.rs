//! Embeds the Grok Light SPA bundle into the host binary.
//!
//! Light ADR 0002 serves the application from the installed binary, so the
//! bundle belongs in the artifact rather than being fetched at runtime.
//!
//! When `apps/web/dist` is absent the generated table is empty and the host
//! serves an honest placeholder instead. That keeps `cargo build` working
//! without a Node toolchain, which matters because the Rust workspace is
//! tested on machines that never run `pnpm`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", bundle.display());

    let mut files = Vec::new();
    if bundle.is_dir() {
        collect(&bundle, &bundle, &mut files);
        files.sort();
    }

    let mut generated = String::from(
        "/// SPA files embedded at build time. Empty when no bundle was present.\n\
         pub static ASSETS: &[Asset] = &[\n",
    );
    for (request_path, absolute) in &files {
        // The content type is resolved here rather than in the table, because
        // a `static` may only call const functions and the lookup is not one.
        let content_type = content_type_for(request_path);
        let _ = writeln!(
            generated,
            "    Asset {{ path: {request_path:?}, bytes: include_bytes!({absolute:?}), \
             content_type: {content_type:?} }},",
        );
    }
    generated.push_str("];\n");

    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("light_assets.rs");
    std::fs::write(out, generated).expect("write generated asset table");
}

/// Content type for a file extension, defaulting to a non-executable type.
///
/// Mirrors `assets::content_type_for`; a test asserts the two agree.
fn content_type_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Walk the bundle, recording each file as `(request path, absolute path)`.
fn collect(root: &Path, directory: &Path, files: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, files);
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        // Request paths are always `/`-separated regardless of platform.
        let request_path = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        files.push((request_path, path.to_string_lossy().into_owned()));
    }
}
