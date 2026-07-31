//! The host-owned directory picker.
//!
//! Light ADR 0009: the browser never supplies a filesystem path. It may ask
//! the host to open a picker, and the host decides everything about it — where
//! it starts, what it filters, and what comes back. The browser then refers to
//! the result by an opaque id.
//!
//! On Linux the picker is `xdg-desktop-portal`'s `FileChooser`. The portal
//! returns URIs as opaque strings with almost no validation, so this module
//! parses and constrains them itself rather than trusting the value.

use std::path::PathBuf;

use crate::workspace::WorkspaceRef;

/// Errors produced while picking a directory.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum PickerError {
    /// The user closed the picker without choosing.
    #[error("no directory was selected")]
    Cancelled,
    /// The portal returned something that is not a local directory URI.
    #[error("selection was not a local directory")]
    NotLocal,
    /// The desktop portal is unavailable on this platform or session.
    #[error("no directory picker is available")]
    Unavailable,
    /// A picker is already open.
    #[error("a directory picker is already open")]
    AlreadyOpen,
}

/// Convert a portal URI into a local directory path.
///
/// Only a `file` URI naming this machine is accepted. A remote host, another
/// scheme, or a relative reference is refused rather than coerced, because the
/// value crosses from an external process into a path the agent will work in.
///
/// # Errors
///
/// Returns [`PickerError::NotLocal`] for anything that is not a local `file`
/// URI.
pub fn uri_to_directory(uri: &str) -> Result<PathBuf, PickerError> {
    let parsed = url::Url::parse(uri).map_err(|_| PickerError::NotLocal)?;
    if parsed.scheme() != "file" {
        return Err(PickerError::NotLocal);
    }
    // `file://host/path` names another machine. An empty host, or the literal
    // `localhost`, is this one.
    match parsed.host_str() {
        None | Some("" | "localhost") => {}
        Some(_) => return Err(PickerError::NotLocal),
    }
    // `to_file_path` handles percent-decoding and rejects a non-absolute URI.
    parsed.to_file_path().map_err(|()| PickerError::NotLocal)
}

/// Opens a directory picker owned by the host.
///
/// A trait so the interactive portal can be swapped for a deterministic
/// implementation in tests: the portal itself cannot be driven without a
/// desktop session.
#[async_trait::async_trait]
pub trait DirectoryPicker: std::fmt::Debug + Send + Sync {
    /// Ask the user to choose a directory.
    ///
    /// # Errors
    ///
    /// Returns [`PickerError::Cancelled`] only when the user closes the dialog
    /// themselves, and [`PickerError::Unavailable`] when no portal is reachable
    /// or a reachable one fails to answer. The two are kept apart so a broken
    /// portal is never reported as the user's own decision.
    async fn pick_directory(&self) -> Result<PathBuf, PickerError>;
}

/// Decide whether a failed portal request was the user's decision or a fault.
///
/// Only the portal's explicit `Cancelled` response means the user closed the
/// dialog. A transport failure, a portal-side error, or a missing reply is a
/// fault: reporting it as a cancel would hide a broken desktop portal behind
/// a message that blames nobody and prompts no repair.
#[cfg(target_os = "linux")]
fn classify_portal_error(error: &ashpd::Error) -> PickerError {
    match error {
        ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => PickerError::Cancelled,
        _ => PickerError::Unavailable,
    }
}

/// The `xdg-desktop-portal` implementation.
#[cfg(target_os = "linux")]
#[derive(Debug, Default)]
pub struct PortalDirectoryPicker;

#[cfg(target_os = "linux")]
#[async_trait::async_trait]
impl DirectoryPicker for PortalDirectoryPicker {
    async fn pick_directory(&self) -> Result<PathBuf, PickerError> {
        use ashpd::desktop::file_chooser::OpenFileRequest;

        // Every option is chosen here, not by the browser.
        let request = OpenFileRequest::default()
            .title("Choose a workspace for Grok Light")
            .directory(true)
            .multiple(false)
            .modal(true)
            .send()
            .await
            .map_err(|_| PickerError::Unavailable)?;

        // A closed dialog and a broken portal both surface as an error here.
        // Only an explicit cancel is a cancel: reporting a fault as one would
        // turn a crashed portal, a dead session bus, or a refused request into
        // a silent no-op the user cannot tell from their own decision.
        let selected = match request.response() {
            Ok(selected) => selected,
            Err(error) => return Err(classify_portal_error(&error)),
        };
        // A success carrying no URI is not a cancel either; the portal did not
        // answer the question that was asked.
        let uri = selected.uris().first().ok_or(PickerError::Unavailable)?;
        uri_to_directory(uri.as_str())
    }
}

/// A picker that is never available, for platforms without a portal.
#[derive(Debug, Default)]
pub struct UnavailableDirectoryPicker;

#[async_trait::async_trait]
impl DirectoryPicker for UnavailableDirectoryPicker {
    async fn pick_directory(&self) -> Result<PathBuf, PickerError> {
        Err(PickerError::Unavailable)
    }
}

/// The outcome of a completed pick, for the caller to enrol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickOutcome {
    /// A directory was chosen and enrolled.
    Enrolled(WorkspaceRef),
    /// The user closed the picker. Nothing changed.
    Cancelled,
    /// The pick failed for a reason worth reporting.
    Failed(PickerError),
}

#[cfg(test)]
mod tests {
    use super::{PickerError, uri_to_directory};

    // Unix absolute `file:///` shapes; Windows `url::to_file_path` rejects them.
    #[cfg(unix)]
    #[test]
    fn a_plain_local_file_uri_becomes_a_path() {
        assert_eq!(
            uri_to_directory("file:///home/friend/project").expect("path"),
            std::path::PathBuf::from("/home/friend/project")
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_explicit_localhost_is_this_machine() {
        assert_eq!(
            uri_to_directory("file://localhost/srv/data").expect("path"),
            std::path::PathBuf::from("/srv/data")
        );
    }

    #[cfg(unix)]
    #[test]
    fn percent_encoding_is_decoded() {
        assert_eq!(
            uri_to_directory("file:///home/friend/my%20project").expect("path"),
            std::path::PathBuf::from("/home/friend/my project")
        );
        assert_eq!(
            uri_to_directory("file:///tmp/caf%C3%A9").expect("path"),
            std::path::PathBuf::from("/tmp/café")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_file_uri_becomes_a_path() {
        let path = uri_to_directory("file:///C:/Users/friend/project").expect("path");
        assert!(path.is_absolute());
        assert!(path.to_string_lossy().contains("project"));
    }

    #[test]
    fn a_remote_host_is_refused() {
        // `file://host/path` names another machine; the agent must not be
        // pointed at it because a portal handed back that string.
        for uri in [
            "file://fileserver/share/project",
            "file://192.168.1.10/export",
            "file://evil.example/tmp",
        ] {
            assert_eq!(
                uri_to_directory(uri).unwrap_err(),
                PickerError::NotLocal,
                "{uri} must be refused"
            );
        }
    }

    #[test]
    fn another_scheme_is_refused() {
        for uri in [
            "http://example.com/x",
            "https://example.com/x",
            "smb://server/share",
            "sftp://host/path",
            "data:text/plain,hello",
        ] {
            assert_eq!(
                uri_to_directory(uri).unwrap_err(),
                PickerError::NotLocal,
                "{uri} must be refused"
            );
        }
    }

    #[test]
    fn a_malformed_reference_is_refused() {
        for uri in ["", "not a uri", "/plain/path", "://nope"] {
            assert_eq!(
                uri_to_directory(uri).unwrap_err(),
                PickerError::NotLocal,
                "{uri} must be refused"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_scheme_relative_file_uri_normalises_to_an_absolute_path() {
        // `url` resolves `file:relative` to `/relative` rather than rejecting
        // it. That is not an escape — it is an absolute path at the root — and
        // enrolment is the backstop: it canonicalises and requires an existing
        // directory, so a path invented this way does not become a workspace.
        let path = uri_to_directory("file:relative").expect("normalised");
        assert_eq!(path, std::path::PathBuf::from("/relative"));
        assert!(path.is_absolute());
    }

    #[cfg(unix)]
    #[test]
    fn traversal_inside_the_uri_is_resolved_before_it_is_used() {
        // Enrolment canonicalises afterwards, but the path handed on must
        // already be absolute and free of a scheme.
        let path = uri_to_directory("file:///home/friend/../friend/project").expect("path");
        assert!(path.is_absolute());
        assert!(!path.to_string_lossy().contains("file:"));
    }

    #[cfg(target_os = "linux")]
    mod portal_errors {
        use super::super::{PickerError, classify_portal_error};
        use ashpd::desktop::ResponseError;

        #[test]
        fn an_explicit_cancel_is_the_users_decision() {
            assert_eq!(
                classify_portal_error(&ashpd::Error::Response(ResponseError::Cancelled)),
                PickerError::Cancelled
            );
        }

        #[test]
        fn a_portal_side_failure_is_not_a_cancel() {
            // `Other` is the portal saying the request failed. Calling that a
            // cancel would tell the user they closed a dialog they never saw.
            assert_eq!(
                classify_portal_error(&ashpd::Error::Response(ResponseError::Other)),
                PickerError::Unavailable
            );
        }

        #[test]
        fn a_silent_portal_is_not_a_cancel() {
            assert_eq!(
                classify_portal_error(&ashpd::Error::NoResponse),
                PickerError::Unavailable
            );
        }

        #[test]
        fn a_broken_transport_is_not_a_cancel() {
            // A dead session bus is the case that matters most: the picker
            // never appeared, so there was no decision to attribute.
            assert_eq!(
                classify_portal_error(&ashpd::Error::ParseError("bus")),
                PickerError::Unavailable
            );
        }
    }
}
