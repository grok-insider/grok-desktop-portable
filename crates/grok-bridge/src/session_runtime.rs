//! Per-session runtime state mirrored from Grok Build (tasks, later watchers).
//!
//! The CLI pager keeps `bg_tasks: HashMap<task_id, BgTaskState>`. Portable keeps
//! a bounded, path-stripping projection of the same lifecycle so the SPA can
//! show a Tasks surface without owning processes.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::bounds;
use crate::projection::{MAX_TOOL_DETAIL_BYTES, MAX_TOOL_TITLE_BYTES};
use crate::protocol::{BackgroundTaskKind, BackgroundTaskStatus, SnapshotBackgroundTask};

/// Maximum background tasks retained per open session.
pub const MAX_BACKGROUND_TASKS: usize = 64;

/// Host-side record for one background bash/monitor task.
#[derive(Debug, Clone)]
pub struct TaskRecord {
    /// Opaque task id from the agent.
    pub task_id: String,
    /// Correlated ACP tool call, when known.
    pub tool_call_id: Option<String>,
    /// Bash vs monitor (CLI Tasks vs Watchers).
    pub kind: BackgroundTaskKind,
    /// Lifecycle status.
    pub status: BackgroundTaskStatus,
    /// Display title (description preferred).
    pub title: String,
    /// Truncated command line for display.
    pub command: String,
    /// Host clock when the task started (ms since epoch).
    pub started_at_ms: u64,
    /// Host clock when the task ended, if terminal.
    pub ended_at_ms: Option<u64>,
    /// Process exit code when known.
    pub exit_code: Option<i32>,
    /// Signal name when killed by signal.
    pub signal: Option<String>,
    /// Bounded stdout line count for a badge (0 when unknown).
    pub line_count: u32,
    /// Whether stdout is incomplete.
    pub truncated: bool,
    /// Host-only path to the output file (never projected).
    pub output_path: Option<PathBuf>,
    /// Restored from session/load replay, not live activity.
    pub restored_from_replay: bool,
}

impl TaskRecord {
    /// Browser-facing snapshot row (no paths).
    #[must_use]
    pub fn to_snapshot(&self, now_ms: u64) -> SnapshotBackgroundTask {
        let end = self.ended_at_ms.unwrap_or(now_ms);
        let elapsed_ms = end.saturating_sub(self.started_at_ms);
        SnapshotBackgroundTask {
            task_id: self.task_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            kind: self.kind,
            status: self.status,
            title: self.title.clone(),
            command: self.command.clone(),
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
            elapsed_ms,
            exit_code: self.exit_code,
            signal: self.signal.clone().unwrap_or_default(),
            line_count: self.line_count,
            truncated: self.truncated,
            restored_from_replay: self.restored_from_replay,
        }
    }
}

/// Runtime bag for one open agent session.
#[derive(Debug, Default, Clone)]
pub struct SessionRuntime {
    /// Background tasks keyed by task id.
    pub tasks: HashMap<String, TaskRecord>,
}

impl SessionRuntime {
    /// Upsert a running (or restored) task from a backgrounded notification.
    pub fn upsert_running(&mut self, record: TaskRecord) {
        self.tasks.insert(record.task_id.clone(), record);
        self.trim();
    }

    /// Mark a task terminal from a completed notification.
    pub fn complete(
        &mut self,
        task_id: &str,
        status: BackgroundTaskStatus,
        ended_at_ms: u64,
        exit_code: Option<i32>,
        signal: Option<String>,
    ) -> Option<&TaskRecord> {
        let task = self.tasks.get_mut(task_id)?;
        task.status = status;
        task.ended_at_ms = Some(ended_at_ms);
        task.exit_code = exit_code;
        task.signal = signal;
        Some(&*task)
    }

    /// Mark kill requested (awaiting task_completed).
    pub fn mark_killing(&mut self, task_id: &str) -> bool {
        let Some(task) = self.tasks.get_mut(task_id) else {
            return false;
        };
        if task.status != BackgroundTaskStatus::Running {
            return false;
        }
        task.status = BackgroundTaskStatus::Killing;
        true
    }

    /// Snapshot all tasks newest-first (by started_at).
    #[must_use]
    pub fn snapshot_tasks(&self, now_ms: u64) -> Vec<SnapshotBackgroundTask> {
        let mut rows: Vec<_> = self.tasks.values().map(|t| t.to_snapshot(now_ms)).collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.started_at_ms));
        rows
    }

    /// Host-only output path for a task.
    #[must_use]
    pub fn output_path(&self, task_id: &str) -> Option<&PathBuf> {
        self.tasks.get(task_id).and_then(|t| t.output_path.as_ref())
    }

    fn trim(&mut self) {
        if self.tasks.len() <= MAX_BACKGROUND_TASKS {
            return;
        }
        // Drop oldest terminal tasks first; if still over, drop oldest anything.
        let mut terminal: Vec<(u64, String)> = self
            .tasks
            .values()
            .filter(|t| {
                matches!(
                    t.status,
                    BackgroundTaskStatus::Completed | BackgroundTaskStatus::Failed
                )
            })
            .map(|t| (t.started_at_ms, t.task_id.clone()))
            .collect();
        terminal.sort_by_key(|(ms, _)| *ms);
        while self.tasks.len() > MAX_BACKGROUND_TASKS {
            if let Some((_, id)) = terminal.pop() {
                self.tasks.remove(&id);
            } else {
                break;
            }
        }
        if self.tasks.len() <= MAX_BACKGROUND_TASKS {
            return;
        }
        let mut all: Vec<(u64, String)> = self
            .tasks
            .values()
            .map(|t| (t.started_at_ms, t.task_id.clone()))
            .collect();
        all.sort_by_key(|(ms, _)| *ms);
        while self.tasks.len() > MAX_BACKGROUND_TASKS {
            if let Some((_, id)) = all.first().cloned() {
                all.remove(0);
                self.tasks.remove(&id);
            } else {
                break;
            }
        }
    }
}

/// Registry of runtimes keyed by open agent session id.
#[derive(Debug, Default)]
pub struct RuntimeRegistry {
    by_session: HashMap<String, SessionRuntime>,
}

impl RuntimeRegistry {
    /// Mutable runtime for a session (creates empty if missing).
    pub fn session_mut(&mut self, session_id: &str) -> &mut SessionRuntime {
        self.by_session.entry(session_id.to_owned()).or_default()
    }

    /// Immutable runtime when present.
    #[must_use]
    pub fn session(&self, session_id: &str) -> Option<&SessionRuntime> {
        self.by_session.get(session_id)
    }

    /// Drop runtime when a session closes.
    pub fn remove(&mut self, session_id: &str) {
        self.by_session.remove(session_id);
    }

    /// Clear all (agent process death).
    pub fn clear(&mut self) {
        self.by_session.clear();
    }
}

/// Bound a display string for titles / commands.
#[must_use]
pub fn bound_title(raw: &str) -> String {
    bounds::truncate_utf8(raw.trim(), MAX_TOOL_TITLE_BYTES).0
}

/// Bound a command line for the browser.
#[must_use]
pub fn bound_command(raw: &str) -> String {
    bounds::truncate_utf8(raw.trim(), MAX_TOOL_DETAIL_BYTES).0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(id: &str, started: u64) -> TaskRecord {
        TaskRecord {
            task_id: id.into(),
            tool_call_id: None,
            kind: BackgroundTaskKind::Bash,
            status: BackgroundTaskStatus::Running,
            title: id.into(),
            command: "echo".into(),
            started_at_ms: started,
            ended_at_ms: None,
            exit_code: None,
            signal: None,
            line_count: 0,
            truncated: false,
            output_path: None,
            restored_from_replay: false,
        }
    }

    #[test]
    fn complete_updates_status() {
        let mut rt = SessionRuntime::default();
        rt.upsert_running(running("t1", 100));
        let row = rt
            .complete("t1", BackgroundTaskStatus::Completed, 200, Some(0), None)
            .expect("task");
        assert_eq!(row.status, BackgroundTaskStatus::Completed);
        assert_eq!(row.ended_at_ms, Some(200));
        assert_eq!(row.exit_code, Some(0));
    }

    #[test]
    fn snapshot_has_no_paths() {
        let mut rt = SessionRuntime::default();
        let mut rec = running("t1", 1);
        rec.output_path = Some(PathBuf::from("/tmp/secret-out.log"));
        rt.upsert_running(rec);
        let snap = rt.snapshot_tasks(10);
        let json = serde_json::to_string(&snap).expect("json");
        assert!(!json.contains("/tmp"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn trim_drops_oldest_terminal_first() {
        let mut rt = SessionRuntime::default();
        for i in 0..MAX_BACKGROUND_TASKS {
            let mut r = running(&format!("done-{i}"), i as u64);
            r.status = BackgroundTaskStatus::Completed;
            r.ended_at_ms = Some(i as u64 + 1);
            rt.upsert_running(r);
        }
        rt.upsert_running(running("live", 10_000));
        assert!(rt.tasks.contains_key("live"));
        assert!(rt.tasks.len() <= MAX_BACKGROUND_TASKS);
    }
}
