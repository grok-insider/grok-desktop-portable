//! Host-owned workspace enrolment.
//!
//! The browser never supplies a filesystem path. It asks the host to open a
//! picker, and afterwards refers to the result by an opaque id. The host holds
//! the path, canonicalises it once, and records the directory's filesystem
//! identity so a later swap is detected rather than followed.
//!
//! Revalidation happens at the moment of use, not only at enrolment: a path
//! that was a directory when enrolled may be a symlink, a different directory,
//! or gone by the time a session starts.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bounds::MAX_WORKSPACES;

/// File holding enrolled workspaces inside the state directory.
pub const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Errors produced while enrolling or resolving a workspace.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WorkspaceError {
    /// The selected path does not exist or is not a directory.
    #[error("selection is not a directory")]
    NotADirectory,
    /// The path could not be canonicalised.
    #[error("selection could not be resolved")]
    Unresolvable,
    /// The workspace limit is reached.
    #[error("workspace limit reached")]
    LimitReached,
    /// No workspace is enrolled under that identifier.
    #[error("workspace is not enrolled")]
    Unknown,
    /// The directory is no longer the one that was enrolled.
    #[error("workspace identity changed since enrolment")]
    IdentityChanged,
    /// The enrolment file could not be read or written.
    #[error("workspace state is unusable")]
    Storage,
}

/// Stable identity of a directory, independent of its path.
///
/// On Unix this is the device and inode pair, which is what makes a swapped
/// directory detectable even when the path string is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemIdentity {
    /// Device identifier.
    pub device: u64,
    /// Inode number.
    pub inode: u64,
}

impl FilesystemIdentity {
    /// Read the identity of an existing directory.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspaceError::NotADirectory`] when the path is missing or
    /// is not a directory.
    pub fn of(path: &Path) -> Result<Self, WorkspaceError> {
        let metadata = std::fs::metadata(path).map_err(|_| WorkspaceError::NotADirectory)?;
        if !metadata.is_dir() {
            return Err(WorkspaceError::NotADirectory);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            // Windows identity lands with its own platform gate.
            Ok(Self {
                device: 0,
                inode: 0,
            })
        }
    }
}

/// An enrolled workspace. Only `id` and `display_name` ever reach the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRef {
    /// Opaque identifier handed to the browser.
    pub id: String,
    /// Label shown to the user.
    pub display_name: String,
    /// Canonical path, held by the host only.
    pub canonical_path: PathBuf,
    /// Identity recorded at enrolment.
    pub filesystem_identity: FilesystemIdentity,
    /// Incremented on every durable change.
    pub revision: u64,
    /// Milliseconds since the Unix epoch, or zero when never opened.
    pub last_opened_at: u64,
}

/// The set of workspaces this installation has enrolled.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndex {
    entries: BTreeMap<String, WorkspaceRef>,
    #[serde(default)]
    next_id: u64,
}

impl WorkspaceIndex {
    /// An empty index.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of enrolled workspaces.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is enrolled.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Enrolled workspaces, ordered by identifier.
    #[must_use]
    pub fn entries(&self) -> Vec<&WorkspaceRef> {
        self.entries.values().collect()
    }

    /// Enrol a directory the host selected.
    ///
    /// The path is canonicalised, so a symlink is resolved once here rather
    /// than followed repeatedly later. Enrolling the same directory twice
    /// returns the existing entry instead of creating a duplicate.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspaceError::NotADirectory`] when the selection is not a
    /// directory, [`WorkspaceError::Unresolvable`] when it cannot be
    /// canonicalised, and [`WorkspaceError::LimitReached`] at the bound.
    pub fn enrol(&mut self, selected: &Path, now_ms: u64) -> Result<WorkspaceRef, WorkspaceError> {
        let canonical = selected
            .canonicalize()
            .map_err(|_| WorkspaceError::Unresolvable)?;
        let identity = FilesystemIdentity::of(&canonical)?;

        if let Some(existing) = self
            .entries
            .values()
            .find(|entry| entry.filesystem_identity == identity)
        {
            return Ok(existing.clone());
        }
        if self.entries.len() >= MAX_WORKSPACES {
            return Err(WorkspaceError::LimitReached);
        }

        self.next_id = self.next_id.saturating_add(1);
        let display_name = canonical.file_name().map_or_else(
            || canonical.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        let entry = WorkspaceRef {
            id: format!("ws-{}", self.next_id),
            display_name,
            canonical_path: canonical,
            filesystem_identity: identity,
            revision: 1,
            last_opened_at: now_ms,
        };
        self.entries.insert(entry.id.clone(), entry.clone());
        Ok(entry)
    }

    /// Resolve an opaque identifier to a usable path.
    ///
    /// Identity is re-read now and compared with what was enrolled, so a
    /// directory that has been replaced, moved out from under its path, or
    /// turned into a symlink is refused instead of silently used.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspaceError::Unknown`] when nothing is enrolled under the
    /// identifier, [`WorkspaceError::NotADirectory`] when the path no longer
    /// resolves, and [`WorkspaceError::IdentityChanged`] when it is a
    /// different directory than the one enrolled.
    pub fn resolve(&self, id: &str) -> Result<&WorkspaceRef, WorkspaceError> {
        let entry = self.entries.get(id).ok_or(WorkspaceError::Unknown)?;

        // A symlink appearing at the canonical path is a swap, not a shortcut.
        let link = std::fs::symlink_metadata(&entry.canonical_path)
            .map_err(|_| WorkspaceError::NotADirectory)?;
        if link.file_type().is_symlink() {
            return Err(WorkspaceError::IdentityChanged);
        }

        let current = FilesystemIdentity::of(&entry.canonical_path)?;
        if current != entry.filesystem_identity {
            return Err(WorkspaceError::IdentityChanged);
        }
        Ok(entry)
    }

    /// Remove an enrolment.
    ///
    /// # Errors
    ///
    /// Returns [`WorkspaceError::Unknown`] when the identifier is not enrolled.
    pub fn remove(&mut self, id: &str) -> Result<(), WorkspaceError> {
        self.entries
            .remove(id)
            .map(|_| ())
            .ok_or(WorkspaceError::Unknown)
    }

    /// Record that a workspace was opened.
    pub fn touch(&mut self, id: &str, now_ms: u64) {
        if let Some(entry) = self.entries.get_mut(id) {
            entry.last_opened_at = now_ms;
            entry.revision = entry.revision.saturating_add(1);
        }
    }
}

/// Load the enrolment index, returning an empty one when absent.
///
/// # Errors
///
/// Returns [`WorkspaceError::Storage`] when the file exists but cannot be read
/// or parsed, which surfaces corruption rather than discarding enrolments.
pub fn load(directory: &Path) -> Result<WorkspaceIndex, WorkspaceError> {
    let path = directory.join(WORKSPACES_FILE_NAME);
    if !path.exists() {
        return Ok(WorkspaceIndex::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|_| WorkspaceError::Storage)?;
    serde_json::from_str(&raw).map_err(|_| WorkspaceError::Storage)
}

/// Persist the enrolment index owner-only and atomically.
///
/// # Errors
///
/// Returns [`WorkspaceError::Storage`] when the file cannot be written.
pub fn persist(directory: &Path, index: &WorkspaceIndex) -> Result<(), WorkspaceError> {
    use std::io::Write as _;

    let path = directory.join(WORKSPACES_FILE_NAME);
    let temporary = directory.join(format!("{WORKSPACES_FILE_NAME}.tmp"));
    let encoded = serde_json::to_string_pretty(index).map_err(|_| WorkspaceError::Storage)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| WorkspaceError::Storage)?;
    file.write_all(encoded.as_bytes())
        .map_err(|_| WorkspaceError::Storage)?;
    file.sync_all().map_err(|_| WorkspaceError::Storage)?;
    #[cfg(windows)]
    {
        crate::win_acl::set_owner_only(&temporary).map_err(|_| WorkspaceError::Storage)?;
    }
    std::fs::rename(&temporary, &path).map_err(|_| WorkspaceError::Storage)?;
    #[cfg(windows)]
    {
        let _ = crate::win_acl::set_owner_only(&path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceError, WorkspaceIndex, load, persist};

    const T0: u64 = 1_000_000;

    #[test]
    fn enrolling_records_a_canonical_path_and_identity() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        assert_eq!(entry.display_name, "project");
        assert!(entry.canonical_path.is_absolute());
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn the_browser_identifier_is_opaque_and_carries_no_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        assert!(entry.id.starts_with("ws-"));
        assert!(
            !entry.id.contains('/'),
            "an identifier must never be able to carry a path"
        );
        assert!(!entry.id.contains(&*project.to_string_lossy()));
    }

    #[test]
    fn a_symlink_is_resolved_once_at_enrolment() {
        #[cfg(unix)]
        {
            let root = tempfile::tempdir().expect("tempdir");
            let real = root.path().join("real");
            let link = root.path().join("link");
            std::fs::create_dir(&real).expect("mkdir");
            std::os::unix::fs::symlink(&real, &link).expect("symlink");

            let mut index = WorkspaceIndex::new();
            let entry = index.enrol(&link, T0).expect("enrol");
            assert_eq!(
                entry.canonical_path,
                real.canonicalize().expect("canonical"),
                "the stored path must be the resolved target, not the link"
            );
        }
    }

    #[test]
    fn enrolling_the_same_directory_twice_does_not_duplicate() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let first = index.enrol(&project, T0).expect("first");
        let second = index.enrol(&project, T0 + 1).expect("second");
        assert_eq!(first.id, second.id);
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn a_file_is_not_a_workspace() {
        let root = tempfile::tempdir().expect("tempdir");
        let file = root.path().join("notes.txt");
        std::fs::write(&file, b"hi").expect("write");

        let mut index = WorkspaceIndex::new();
        assert_eq!(
            index.enrol(&file, T0).unwrap_err(),
            WorkspaceError::NotADirectory
        );
    }

    #[test]
    fn a_missing_path_is_refused() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut index = WorkspaceIndex::new();
        assert_eq!(
            index.enrol(&root.path().join("nope"), T0).unwrap_err(),
            WorkspaceError::Unresolvable
        );
    }

    #[test]
    fn resolving_an_unknown_identifier_is_refused() {
        let index = WorkspaceIndex::new();
        assert_eq!(index.resolve("ws-99").unwrap_err(), WorkspaceError::Unknown);
    }

    #[test]
    fn resolving_succeeds_while_the_directory_is_unchanged() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        let resolved = index.resolve(&entry.id).expect("resolve");
        assert_eq!(resolved.canonical_path, entry.canonical_path);
    }

    #[cfg(unix)]
    #[test]
    fn a_swapped_directory_is_detected_at_use() {
        // The realistic swap: prepare a directory you control, then rename it
        // over the enrolled path. The path string is identical and only the
        // inode changed, which is exactly what a path-only check would miss.
        //
        // Note this deliberately does not remove-and-recreate: filesystems
        // routinely reuse the just-freed inode, so that would not produce a
        // distinct directory and would test nothing.
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        let attacker = root.path().join("attacker");
        std::fs::create_dir(&project).expect("mkdir");
        std::fs::create_dir(&attacker).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        let enrolled = entry.filesystem_identity;

        std::fs::rename(&attacker, &project).expect("swap");
        let swapped = super::FilesystemIdentity::of(&project).expect("identity");
        assert_ne!(
            swapped, enrolled,
            "the swap must actually produce a different directory"
        );

        assert_eq!(
            index.resolve(&entry.id).unwrap_err(),
            WorkspaceError::IdentityChanged,
            "a replaced directory must not be used as if it were the enrolled one"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_path_replaced_by_a_symlink_is_refused_at_use() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir(&project).expect("mkdir");
        std::fs::create_dir(&elsewhere).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");

        std::fs::remove_dir(&project).expect("remove");
        std::os::unix::fs::symlink(&elsewhere, &project).expect("symlink");

        assert_eq!(
            index.resolve(&entry.id).unwrap_err(),
            WorkspaceError::IdentityChanged,
            "a symlink appearing at the enrolled path is a swap, not a shortcut"
        );
    }

    #[test]
    fn a_deleted_directory_is_refused_at_use() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        std::fs::remove_dir(&project).expect("remove");

        assert_eq!(
            index.resolve(&entry.id).unwrap_err(),
            WorkspaceError::NotADirectory
        );
    }

    #[test]
    fn removal_forgets_the_enrolment() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        index.remove(&entry.id).expect("remove");
        assert!(index.is_empty());
        assert_eq!(
            index.remove(&entry.id).unwrap_err(),
            WorkspaceError::Unknown
        );
    }

    #[test]
    fn a_revoked_enrolment_does_not_come_back_after_a_restart() {
        // Revocation that lived only in memory would hand the directory back
        // the next time the host started, so the user would believe they had
        // withdrawn access they still granted.
        let root = tempfile::tempdir().expect("tempdir");
        let state = root.path().join("state");
        std::fs::create_dir(&state).expect("mkdir state");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir project");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        persist(&state, &index).expect("persist enrolment");

        let mut reloaded = load(&state).expect("load");
        reloaded.remove(&entry.id).expect("remove");
        persist(&state, &reloaded).expect("persist revocation");

        let after_restart = load(&state).expect("reload");
        assert!(
            after_restart.is_empty(),
            "a revoked workspace must not survive a restart"
        );
        assert!(
            project.is_dir(),
            "revoking access must not touch the user's directory"
        );
    }

    #[test]
    fn the_enrolment_bound_is_enforced() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut index = WorkspaceIndex::new();
        for n in 0..crate::bounds::MAX_WORKSPACES {
            let path = root.path().join(format!("p{n}"));
            std::fs::create_dir(&path).expect("mkdir");
            index.enrol(&path, T0).expect("enrol");
        }
        let extra = root.path().join("one-too-many");
        std::fs::create_dir(&extra).expect("mkdir");
        assert_eq!(
            index.enrol(&extra, T0).unwrap_err(),
            WorkspaceError::LimitReached
        );
    }

    #[test]
    fn the_index_round_trips_through_storage() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        persist(root.path(), &index).expect("persist");

        let reloaded = load(root.path()).expect("load");
        assert_eq!(reloaded, index);
        assert!(reloaded.resolve(&entry.id).is_ok());
    }

    #[test]
    fn an_absent_index_loads_empty() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(load(root.path()).expect("load").is_empty());
    }

    #[test]
    fn a_corrupt_index_is_reported_not_discarded() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join(super::WORKSPACES_FILE_NAME), "{").expect("write");
        assert_eq!(load(root.path()).unwrap_err(), WorkspaceError::Storage);
    }

    #[cfg(unix)]
    #[test]
    fn the_index_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("tempdir");
        persist(root.path(), &WorkspaceIndex::new()).expect("persist");
        let mode = std::fs::metadata(root.path().join(super::WORKSPACES_FILE_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn touching_advances_the_revision() {
        let root = tempfile::tempdir().expect("tempdir");
        let project = root.path().join("project");
        std::fs::create_dir(&project).expect("mkdir");

        let mut index = WorkspaceIndex::new();
        let entry = index.enrol(&project, T0).expect("enrol");
        index.touch(&entry.id, T0 + 500);
        let reloaded = index.resolve(&entry.id).expect("resolve");
        assert_eq!(reloaded.revision, entry.revision + 1);
        assert_eq!(reloaded.last_opened_at, T0 + 500);
    }
}
