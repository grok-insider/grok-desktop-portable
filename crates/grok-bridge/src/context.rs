//! Workspace-relative path projection for `@` mentions (light ADR 0013).
//!
//! The browser sends an opaque workspace id and, at most, a substring it has
//! typed. The host resolves the root itself and walks it, projecting **only**
//! paths relative to that root.
//!
//! Nothing absolute crosses the boundary and nothing outside the enrolled
//! directory is reachable: the walk starts at the resolved root, refuses to
//! follow a symlink that leaves it, and every projected value is checked to be
//! relative with no parent segment before it is returned.
//!
//! The bounds are the security control. Relevance filtering (skipping `.git`,
//! `node_modules`, and friends) is a convenience on top of it and is never
//! what keeps the walk finite.

use std::collections::VecDeque;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::bounds::{
    MAX_CONTEXT_DEPTH, MAX_CONTEXT_ENTRIES, MAX_CONTEXT_PATH_BYTES, MAX_CONTEXT_SCANNED,
};

/// Directories that are never worth completing into.
///
/// Relevance only. A workspace that genuinely wants one of these listed is
/// choosing noise over usefulness; the bounds below still hold either way.
const SKIPPED_DIRECTORIES: [&str; 12] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    "vendor",
];

/// One thing the user can mention, named relative to the workspace root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    /// Workspace-relative path, using `/` on every platform.
    ///
    /// Never absolute, never containing a `..` segment, and never naming
    /// anything outside the enrolled directory.
    pub path: String,
    /// `file` or `directory`.
    pub kind: &'static str,
}

/// Walk an enrolled workspace and project what the user may mention.
///
/// `query` is matched case-insensitively against the relative path. It is a
/// filter over names the host generated, never something the host resolves, so
/// it cannot be used to reach outside the root.
#[must_use]
pub fn list_context(root: &Path, query: Option<&str>) -> Vec<ContextEntry> {
    // The root must still be a directory at the moment of use, and the walk is
    // anchored to its canonical form so a symlinked entry can be compared
    // against it (light ADR 0009: resolve host-side, at use).
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    if !root.is_dir() {
        return Vec::new();
    }

    let needle = query.map(str::to_lowercase).filter(|text| !text.is_empty());
    let mut entries: Vec<ContextEntry> = Vec::new();
    let mut scanned = 0usize;

    // Breadth-first, so a shallow file is offered before a deeply nested one
    // when the cap is reached. A depth-first walk would spend the whole budget
    // inside the first subtree it happened to enter.
    let mut queue: VecDeque<(std::path::PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.clone(), 0));

    while let Some((directory, depth)) = queue.pop_front() {
        if entries.len() >= MAX_CONTEXT_ENTRIES || scanned >= MAX_CONTEXT_SCANNED {
            break;
        }
        let Ok(children) = fs::read_dir(&directory) else {
            // An unreadable directory is skipped, not reported: its existence
            // is not something the browser needs to learn about.
            continue;
        };

        // Sorted so the projection is stable between calls; an unstable list
        // would make the completion menu reorder under the user's cursor.
        let mut names: Vec<_> = children.flatten().map(|child| child.path()).collect();
        names.sort();

        for path in names {
            if entries.len() >= MAX_CONTEXT_ENTRIES || scanned >= MAX_CONTEXT_SCANNED {
                break;
            }
            scanned += 1;

            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name.starts_with('.') || SKIPPED_DIRECTORIES.contains(&name) {
                continue;
            }

            let is_directory = path.is_dir();

            // Revalidate containment per entry rather than trusting the walk:
            // a symlink can point anywhere, and the check must happen against
            // the resolved target at the moment it is considered.
            let Ok(resolved) = path.canonicalize() else {
                continue;
            };
            if !resolved.starts_with(&root) {
                continue;
            }

            let Some(relative) = relative_path(&root, &path) else {
                continue;
            };
            if relative.len() > MAX_CONTEXT_PATH_BYTES {
                continue;
            }

            if is_directory && depth + 1 < MAX_CONTEXT_DEPTH {
                queue.push_back((path.clone(), depth + 1));
            }

            let matches = needle
                .as_ref()
                .is_none_or(|needle| relative.to_lowercase().contains(needle.as_str()));
            if !matches {
                continue;
            }

            entries.push(ContextEntry {
                path: relative,
                kind: if is_directory { "directory" } else { "file" },
            });
        }
    }

    entries
}

/// Strip the root prefix, refusing anything that is not below it.
///
/// Returns `None` rather than a best guess: a path that cannot be expressed
/// relative to the workspace is one the browser must not be told about.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut out = String::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => {
                let part = part.to_str()?;
                if !out.is_empty() {
                    out.push('/');
                }
                out.push_str(part);
            }
            // Anything that is not a plain name — a parent hop, a root, a
            // drive prefix — means this is not a contained relative path.
            _ => return None,
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::{ContextEntry, list_context};
    use std::fs;

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("src/views")).expect("mkdir");
        fs::create_dir_all(root.join(".git/objects")).expect("mkdir");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        fs::write(root.join("README.md"), "hi").expect("write");
        fs::write(root.join("src/main.rs"), "fn main() {}").expect("write");
        fs::write(root.join("src/views/home.tsx"), "x").expect("write");
        fs::write(root.join(".git/objects/blob"), "x").expect("write");
        fs::write(root.join("node_modules/pkg/index.js"), "x").expect("write");
        dir
    }

    fn paths(entries: &[ContextEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.path.as_str()).collect()
    }

    #[test]
    fn projects_relative_paths_only() {
        let dir = workspace();
        let entries = list_context(dir.path(), None);
        for entry in &entries {
            assert!(
                !entry.path.starts_with('/'),
                "absolute path crossed the boundary: {}",
                entry.path
            );
            assert!(!entry.path.contains(".."), "parent hop: {}", entry.path);
            assert!(
                !entry.path.contains(&*dir.path().to_string_lossy()),
                "root leaked into a projected path: {}",
                entry.path
            );
        }
        assert!(paths(&entries).contains(&"README.md"));
        assert!(paths(&entries).contains(&"src/main.rs"));
        assert!(paths(&entries).contains(&"src/views/home.tsx"));
    }

    #[test]
    fn skips_noise_directories() {
        let dir = workspace();
        let entries = list_context(dir.path(), None);
        let listed = paths(&entries);
        assert!(!listed.iter().any(|path| path.starts_with(".git")));
        assert!(!listed.iter().any(|path| path.starts_with("node_modules")));
    }

    #[test]
    fn filters_case_insensitively() {
        let dir = workspace();
        let entries = list_context(dir.path(), Some("HOME.TS"));
        assert_eq!(paths(&entries), vec!["src/views/home.tsx"]);
    }

    #[test]
    fn an_empty_query_is_not_a_filter() {
        let dir = workspace();
        assert_eq!(
            list_context(dir.path(), Some("")).len(),
            list_context(dir.path(), None).len()
        );
    }

    #[test]
    fn caps_the_number_of_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..(crate::bounds::MAX_CONTEXT_ENTRIES + 50) {
            fs::write(dir.path().join(format!("file-{index}.txt")), "x").expect("write");
        }
        assert_eq!(
            list_context(dir.path(), None).len(),
            crate::bounds::MAX_CONTEXT_ENTRIES
        );
    }

    #[test]
    fn stops_descending_past_the_depth_bound() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut deep = dir.path().to_path_buf();
        for level in 0..(crate::bounds::MAX_CONTEXT_DEPTH + 4) {
            deep = deep.join(format!("level{level}"));
        }
        fs::create_dir_all(&deep).expect("mkdir");
        fs::write(deep.join("buried.txt"), "x").expect("write");

        let entries = list_context(dir.path(), Some("buried"));
        assert!(entries.is_empty(), "walk descended past the depth bound");
    }

    #[test]
    fn a_missing_workspace_projects_nothing() {
        // ADR 0009: a reference that no longer resolves is refused, never
        // coerced to a nearby path or a default.
        let dir = tempfile::tempdir().expect("tempdir");
        let gone = dir.path().join("not-here");
        assert!(list_context(&gone, None).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_leaves_the_workspace() {
        let outside = tempfile::tempdir().expect("tempdir");
        fs::write(outside.path().join("secret.txt"), "x").expect("write");

        let dir = tempfile::tempdir().expect("tempdir");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).expect("symlink");
        fs::write(dir.path().join("inside.txt"), "x").expect("write");

        let listed = list_context(dir.path(), None);
        let listed = paths(&listed);
        assert!(listed.contains(&"inside.txt"));
        assert!(
            !listed.iter().any(|path| path.starts_with("escape")),
            "a symlink out of the workspace was projected: {listed:?}"
        );
    }
}
