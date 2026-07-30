//! Single-instance lock and owner-only state directory.
//!
//! One host per user. The lock is acquired before the listener binds, so two
//! hosts can never share an origin, a journal, or a pairing set.
//!
//! Implements the state ownership rules of ADR light 0006: the directory is
//! `0700`, files are `0600`, and a foreign owner is refused rather than
//! silently adopted.

use std::fs::File;
use std::path::{Path, PathBuf};

use fs2::FileExt as _;

/// Name of the lock file inside the state directory.
pub const LOCK_FILE_NAME: &str = "host.lock";

/// Errors produced while claiming the single-instance lock.
#[derive(Debug, thiserror::Error)]
pub enum InstanceError {
    /// The state directory could not be created or inspected.
    #[error("state directory is unusable: {0}")]
    Directory(#[source] std::io::Error),
    /// Another host already holds the lock for this user.
    #[error("another grok-bridge instance is already running")]
    AlreadyRunning,
    /// The lock file could not be opened.
    #[error("lock file is unusable: {0}")]
    Lock(#[source] std::io::Error),
    /// The state directory or lock file is not owned by this user, or its
    /// permissions are wider than owner-only.
    #[error("state directory is not owner-only")]
    ForeignOwner,
}

/// An exclusive claim on the per-user host state directory.
///
/// The lock is released when this value is dropped.
#[derive(Debug)]
pub struct InstanceLock {
    directory: PathBuf,
    file: File,
}

impl InstanceLock {
    /// Claim the lock for `directory`, creating it owner-only when absent.
    ///
    /// # Errors
    ///
    /// Returns [`InstanceError::AlreadyRunning`] when another host holds the
    /// lock, [`InstanceError::ForeignOwner`] when the directory is not
    /// owner-only, and an IO error when the directory or file is unusable.
    pub fn acquire(directory: impl Into<PathBuf>) -> Result<Self, InstanceError> {
        let directory = directory.into();
        create_private_directory(&directory)?;
        verify_private_directory(&directory)?;

        let path = directory.join(LOCK_FILE_NAME);
        let file = private_file(&path)?;
        file.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                InstanceError::AlreadyRunning
            } else {
                InstanceError::Lock(error)
            }
        })?;
        Ok(Self { directory, file })
    }

    /// The owner-only state directory this lock protects.
    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Path of a state file inside the protected directory.
    #[must_use]
    pub fn state_path(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

/// Ensure the owner-only state directory exists, without claiming the lock.
///
/// Read-only commands such as `doctor` need the directory to exist before they
/// can inspect host state, but must not take the lock a running host holds.
///
/// # Errors
///
/// Returns [`InstanceError::ForeignOwner`] when the directory exists but is not
/// owner-only, and [`InstanceError::Directory`] when it cannot be created.
pub fn ensure_private_directory(directory: &Path) -> Result<(), InstanceError> {
    create_private_directory(directory)?;
    verify_private_directory(directory)
}

fn create_private_directory(directory: &Path) -> Result<(), InstanceError> {
    if directory.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(directory).map_err(InstanceError::Directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(InstanceError::Directory)?;
    }
    Ok(())
}

fn verify_private_directory(directory: &Path) -> Result<(), InstanceError> {
    let metadata = std::fs::metadata(directory).map_err(InstanceError::Directory)?;
    if !metadata.is_dir() {
        return Err(InstanceError::ForeignOwner);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(InstanceError::ForeignOwner);
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(InstanceError::ForeignOwner);
        }
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<File, InstanceError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path).map_err(InstanceError::Lock)
}

#[cfg(test)]
mod tests {
    use super::{InstanceError, InstanceLock, LOCK_FILE_NAME};

    #[test]
    fn acquiring_creates_an_owner_only_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("state");
        let lock = InstanceLock::acquire(&directory).expect("acquire");
        assert!(directory.is_dir());
        assert!(directory.join(LOCK_FILE_NAME).is_file());
        assert_eq!(lock.directory(), directory);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&directory)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700, "state directory must be owner-only");
        }
    }

    #[test]
    fn a_second_instance_is_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("state");
        let _first = InstanceLock::acquire(&directory).expect("first");
        let second = InstanceLock::acquire(&directory);
        assert!(
            matches!(second, Err(InstanceError::AlreadyRunning)),
            "a second host must be refused, got {second:?}"
        );
    }

    #[test]
    fn releasing_allows_a_later_instance() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("state");
        {
            let _first = InstanceLock::acquire(&directory).expect("first");
        }
        let second = InstanceLock::acquire(&directory);
        assert!(second.is_ok(), "lock must release on drop: {second:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_world_readable_directory_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("state");
        std::fs::create_dir_all(&directory).expect("create");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");

        let result = InstanceLock::acquire(&directory);
        assert!(
            matches!(result, Err(InstanceError::ForeignOwner)),
            "a group/world accessible state directory must be refused, got {result:?}"
        );
    }

    #[test]
    fn state_paths_live_inside_the_locked_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let directory = root.path().join("state");
        let lock = InstanceLock::acquire(&directory).expect("acquire");
        let path = lock.state_path("origin.json");
        assert!(path.starts_with(&directory));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("origin.json")
        );
    }
}
