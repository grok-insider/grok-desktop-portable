//! The SPA the host serves.
//!
//! Light ADR 0002: the application is served from the installed binary over
//! loopback, never from a CDN. The bundle is therefore part of the host's
//! own artifact rather than something fetched at runtime.
//!
//! `apps/web/dist` is embedded at compile time when it exists. A build
//! without it still runs and serves an honest placeholder, so the Rust
//! workspace never depends on a Node toolchain being present.

/// Directory the SPA build is read from, relative to this crate.
pub const BUNDLE_DIR: &str = "../../apps/web/dist";

/// A file the host can serve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asset {
    /// Request path, always starting with `/`.
    pub path: &'static str,
    /// File bytes.
    pub bytes: &'static [u8],
    /// Content type derived from the extension.
    pub content_type: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/light_assets.rs"));

/// Whether a real SPA bundle was embedded at build time.
#[must_use]
pub fn bundle_present() -> bool {
    !ASSETS.is_empty()
}

/// Look up an asset by request path.
///
/// The lookup is a table match, so a traversal attempt cannot escape: a path
/// that is not literally present simply does not resolve. [`is_safe_path`]
/// rejects the obvious shapes earlier so they never reach here.
#[must_use]
pub fn lookup(request_path: &str) -> Option<&'static Asset> {
    let normalised = if request_path == "/" {
        "/index.html"
    } else {
        request_path
    };
    if !is_safe_path(normalised) {
        return None;
    }
    if let Some(asset) = ASSETS.iter().find(|asset| asset.path == normalised) {
        return Some(asset);
    }
    // SPA client routes (`/s/:id`, `/setup`) must return the shell so a
    // refresh or shared link does not 404. Only extension-less paths fall
    // through — real asset misses still 404.
    if is_spa_navigation_path(normalised) {
        return ASSETS.iter().find(|asset| asset.path == "/index.html");
    }
    None
}

/// Whether this path is a client-side navigation target rather than a file.
///
/// `/s/abc` and `/setup` qualify; `/assets/app.js` does not.
#[must_use]
pub fn is_spa_navigation_path(request_path: &str) -> bool {
    if request_path == "/setup" {
        return true;
    }
    // /s/<opaque-id> — same charset as protocol opaque ids.
    let Some(rest) = request_path.strip_prefix("/s/") else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains('/')
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Whether a request path is a plain, non-traversing absolute path.
///
/// The check runs on raw `/`-separated segments rather than
/// [`std::path::Path::components`], because that normalises `.` away instead
/// of reporting it — which would make this function claim to reject a shape it
/// silently accepted.
#[must_use]
pub fn is_safe_path(request_path: &str) -> bool {
    if !request_path.starts_with('/') || request_path.contains('\0') {
        return false;
    }
    if request_path.contains('\\') {
        return false;
    }
    request_path
        .split('/')
        .skip(1) // the empty segment before the leading `/`
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Content type for a file extension, defaulting to a non-executable type.
#[must_use]
pub fn content_type_for(path: &str) -> &'static str {
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

#[cfg(test)]
mod tests {
    use super::{ASSETS, content_type_for, is_safe_path, is_spa_navigation_path, lookup};

    #[test]
    fn traversal_shapes_are_refused() {
        for candidate in [
            "/../secret",
            "/assets/../../etc/passwd",
            "/./index.html",
            "//evil",
            "relative",
            "/a//b",
            "/a/./b",
            "/a/../b",
            "/a\\b",
            "/trailing/",
        ] {
            assert!(!is_safe_path(candidate), "{candidate} must not be served");
            assert!(lookup(candidate).is_none(), "{candidate} must not resolve");
        }
    }

    #[test]
    fn plain_paths_are_accepted_as_shapes() {
        for candidate in ["/", "/index.html", "/assets/index-abc.js"] {
            assert!(is_safe_path(if candidate == "/" {
                "/index.html"
            } else {
                candidate
            }));
        }
    }

    #[test]
    fn an_unknown_path_does_not_resolve() {
        assert!(lookup("/definitely-not-here.js").is_none());
    }

    #[test]
    fn spa_navigation_paths_are_recognized() {
        assert!(is_spa_navigation_path("/setup"));
        assert!(is_spa_navigation_path("/s/abc-123"));
        assert!(is_spa_navigation_path("/s/019fb2.session_id"));
        assert!(!is_spa_navigation_path("/s/../etc"));
        assert!(!is_spa_navigation_path("/s/a/b"));
        assert!(!is_spa_navigation_path("/assets/app.js"));
        assert!(!is_spa_navigation_path("/definitely-not-here.js"));
    }

    #[test]
    fn spa_client_routes_fall_back_to_the_shell_when_a_bundle_exists() {
        // Without a bundle, lookup cannot return index; with one, deep links
        // must resolve to the same shell as `/` so hard refresh does not 404.
        if ASSETS.is_empty() {
            return;
        }
        let index = lookup("/").expect("index");
        let session = lookup("/s/sess-opaque-1").expect("session route → shell");
        let setup = lookup("/setup").expect("setup route → shell");
        assert_eq!(session.path, index.path);
        assert_eq!(setup.path, index.path);
        // A missing static asset with an extension still fails closed.
        assert!(lookup("/missing-bundle-chunk.js").is_none());
    }

    #[test]
    fn content_types_are_explicit_and_default_to_non_executable() {
        assert_eq!(content_type_for("/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("/a.js"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("/a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("/a.woff2"), "font/woff2");
        assert_eq!(content_type_for("/a.weird"), "application/octet-stream");
        assert_eq!(content_type_for("/noextension"), "application/octet-stream");
    }

    #[test]
    fn every_embedded_asset_has_an_absolute_safe_path() {
        for asset in ASSETS {
            assert!(is_safe_path(asset.path), "{} is not servable", asset.path);
        }
    }

    #[test]
    fn an_embedded_bundle_serves_its_entry_document() {
        // Skipped when the crate was built without the SPA bundle.
        if ASSETS.is_empty() {
            return;
        }
        let index = lookup("/").expect("index.html must be embedded when a bundle exists");
        assert_eq!(index.content_type, "text/html; charset=utf-8");
        assert!(!index.bytes.is_empty());
    }
}
