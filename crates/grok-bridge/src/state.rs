//! Durable host identity: install id and canonical port.
//!
//! The origin must survive a restart, otherwise the user's bookmark breaks on
//! every login. It is written owner-only inside the locked state directory and
//! is only rotated by an explicit `grok-light repair`, never by a transient
//! bind failure. See ADR light 0006.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::origin::{LocalOrigin, candidate_port, generate_install_id, is_allocatable_port};

/// File holding the persisted origin inside the state directory.
pub const ORIGIN_FILE_NAME: &str = "origin.json";

/// Errors produced while loading or persisting host identity.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    /// The state file could not be read or written.
    #[error("host state file is unusable: {0}")]
    Io(#[source] std::io::Error),
    /// The state file exists but does not describe a usable origin.
    #[error("host state file is malformed")]
    Malformed,
    /// The platform entropy source failed.
    #[error("secure random generation failed")]
    Entropy,
}

/// The persisted identity of one installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostIdentity {
    /// Random, stable per installation.
    pub install_id: String,
    /// Canonical port, allocated outside the platform ephemeral range.
    pub port: u16,
}

impl HostIdentity {
    /// The canonical origin for this identity.
    ///
    /// # Errors
    ///
    /// Returns [`StateError::Malformed`] when the stored values do not form a
    /// valid origin, which is treated as corruption rather than repaired
    /// silently.
    pub fn origin(&self) -> Result<LocalOrigin, StateError> {
        LocalOrigin::new(self.install_id.clone(), self.port).map_err(|_| StateError::Malformed)
    }
}

/// Load the persisted identity, creating one on first run.
///
/// A first run generates a random install id and a deterministic candidate
/// port derived from it, then persists both. Later runs reuse them, so the
/// bookmark keeps working.
///
/// # Errors
///
/// Returns [`StateError::Io`] when the file cannot be read or written,
/// [`StateError::Malformed`] when an existing file is unusable, and
/// [`StateError::Entropy`] when the platform CSPRNG fails.
pub fn load_or_create(directory: &Path) -> Result<HostIdentity, StateError> {
    let path = directory.join(ORIGIN_FILE_NAME);
    if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(StateError::Io)?;
        let identity: HostIdentity =
            serde_json::from_str(&raw).map_err(|_| StateError::Malformed)?;
        if !is_allocatable_port(identity.port) {
            return Err(StateError::Malformed);
        }
        identity.origin()?;
        return Ok(identity);
    }

    let install_id = generate_install_id().map_err(|_| StateError::Entropy)?;
    let identity = HostIdentity {
        port: candidate_port(&install_id, 0),
        install_id,
    };
    persist(directory, &identity)?;
    Ok(identity)
}

/// Rotate identity, invalidating the previous origin and every pairing.
///
/// This is the explicit `repair` path. A busy port alone must not reach here:
/// that is a transient failure the caller retries while keeping identity.
///
/// # Errors
///
/// Returns [`StateError::Entropy`] when the CSPRNG fails and
/// [`StateError::Io`] when the new identity cannot be written.
pub fn rotate(directory: &Path) -> Result<HostIdentity, StateError> {
    let install_id = generate_install_id().map_err(|_| StateError::Entropy)?;
    let identity = HostIdentity {
        port: candidate_port(&install_id, 0),
        install_id,
    };
    persist(directory, &identity)?;
    Ok(identity)
}

/// Persist an identity owner-only, replacing any previous file atomically.
///
/// # Errors
///
/// Returns [`StateError::Io`] when the file cannot be written or renamed.
pub fn persist(directory: &Path, identity: &HostIdentity) -> Result<(), StateError> {
    let path = directory.join(ORIGIN_FILE_NAME);
    let temporary = directory.join(format!("{ORIGIN_FILE_NAME}.tmp"));
    let encoded = serde_json::to_string_pretty(identity).map_err(|_| StateError::Malformed)?;

    write_private(&temporary, encoded.as_bytes())?;
    std::fs::rename(&temporary, &path).map_err(StateError::Io)?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), StateError> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(StateError::Io)?;
    file.write_all(bytes).map_err(StateError::Io)?;
    file.sync_all().map_err(StateError::Io)?;
    #[cfg(windows)]
    {
        crate::win_acl::set_owner_only(path).map_err(StateError::Io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{HostIdentity, ORIGIN_FILE_NAME, StateError, load_or_create, persist, rotate};
    use crate::origin::is_allocatable_port;

    #[test]
    fn a_first_run_creates_a_usable_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let identity = load_or_create(root.path()).expect("create");
        assert!(is_allocatable_port(identity.port));
        assert!(identity.origin().is_ok());
        assert!(root.path().join(ORIGIN_FILE_NAME).is_file());
    }

    #[test]
    fn a_later_run_reuses_the_same_origin() {
        // This is what keeps the user's bookmark working across restarts.
        let root = tempfile::tempdir().expect("tempdir");
        let first = load_or_create(root.path()).expect("first");
        let second = load_or_create(root.path()).expect("second");
        assert_eq!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn the_state_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("tempdir");
        load_or_create(root.path()).expect("create");
        let mode = std::fs::metadata(root.path().join(ORIGIN_FILE_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "host identity must not be readable by others"
        );
    }

    #[test]
    fn repair_rotates_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let first = load_or_create(root.path()).expect("first");
        let rotated = rotate(root.path()).expect("rotate");
        assert_ne!(first.install_id, rotated.install_id);
        // And the rotation is what persists, so the old bookmark is dead.
        let reloaded = load_or_create(root.path()).expect("reload");
        assert_eq!(reloaded, rotated);
    }

    #[test]
    fn a_corrupt_state_file_is_reported_not_silently_replaced() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join(ORIGIN_FILE_NAME), "not json").expect("write");
        let result = load_or_create(root.path());
        assert!(
            matches!(result, Err(StateError::Malformed)),
            "corruption must surface, got {result:?}"
        );
    }

    #[test]
    fn an_ephemeral_port_in_state_is_rejected() {
        let root = tempfile::tempdir().expect("tempdir");
        persist(
            root.path(),
            &HostIdentity {
                install_id: "0123456789abcdef0123456789abcdef".into(),
                port: 40_000,
            },
        )
        .expect("persist");
        let result = load_or_create(root.path());
        assert!(
            matches!(result, Err(StateError::Malformed)),
            "a port inside the ephemeral range must be refused"
        );
    }

    #[test]
    fn persisting_replaces_atomically_without_leaving_a_temp_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let identity = load_or_create(root.path()).expect("create");
        persist(root.path(), &identity).expect("persist again");
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic replace must not leave temp files"
        );
    }
}
