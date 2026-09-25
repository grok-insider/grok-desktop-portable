//! Read-only catalog of Grok Build sessions on disk.
//!
//! Light does not own transcripts. Sessions live under the user's `GROK_HOME`
//! (default `~/.grok/sessions/<encoded-cwd>/<id>/`), the same store the TUI
//! `/resume` picker uses. This module only **lists metadata** and **reads**
//! `updates.jsonl` for rehydration — it never writes session content.
//!
//! The list is **membership-aware**: subagent (and other hidden) sessions stay
//! on disk for the CLI, but only **primary** sessions appear in
//! [`list_for_cwd`]. Visibility matches Grok Build's `Summary::is_hidden`
//! (explicit `hidden`, else `session_kind` starting with `subagent`).
//!
//! See light ADR 0010, light ADR 0012 (project groups), and
//! `docs/protocol.md`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::bounds::{
    MAX_PROJECTS, MAX_REHYDRATE_CHARS, MAX_SESSION_LIST, MAX_SESSION_MEMBERS,
    MAX_SESSION_WORKFLOWS, MAX_WORKFLOW_PHASES, MAX_WORKFLOW_TEXT_BYTES,
};

/// One session as the browser may see it: never a filesystem path.
///
/// Only **primary** sessions (resume-picker peers) are returned by
/// [`list_for_cwd`]. Nested agents are members of a parent and are projected
/// only when that parent is opened (see session membership ADR).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    /// Agent session identifier (opaque).
    pub id: String,
    /// Human title from the CLI summary, or empty when none was generated.
    pub title: String,
    /// Last activity, RFC3339 when available, else empty.
    pub updated_at: String,
    /// Coarse message count for ranking / empty detection.
    pub message_count: u64,
    /// Session kind from Grok Build (`conversation`, `fork`, `worktree`, …).
    ///
    /// Subagent kinds never appear here because those sessions are not primary.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// How many nested member sessions (e.g. workflow subagents) belong to this
    /// primary session. Zero when none; the home rail can badge without listing
    /// each child as a peer chat.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub member_count: u64,
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

/// Host-side visibility for a session row in the catalog graph.
///
/// Not sent on the wire as a free string for every disk entry; it decides
/// whether the session is a primary list peer, a parent-scoped member, or
/// omitted from SPA surfaces for now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisibilityClass {
    /// Appears in `ListSessions` / the project session rail.
    Primary,
    /// Nested under a parent (subagents). Not a home-rail peer.
    Member,
    /// Hidden and not attached to a known parent in this group.
    Hidden,
}

/// Whether a Grok Build summary is excluded from history listings.
///
/// Ports CLI `Summary::is_hidden`: explicit `hidden` wins; otherwise any
/// `session_kind` that starts with `subagent` is hidden (`subagent`,
/// `subagent_fork`, `subagent_resume`, …). Forks and worktrees stay visible.
#[must_use]
pub fn summary_is_hidden(hidden: Option<bool>, session_kind: Option<&str>) -> bool {
    hidden.unwrap_or_else(|| session_kind.is_some_and(|kind| kind.starts_with("subagent")))
}

/// Classify a session for catalog surfaces given summary fields and optional parent.
#[must_use]
pub fn visibility_class(
    hidden: Option<bool>,
    session_kind: Option<&str>,
    parent_session_id: Option<&str>,
) -> VisibilityClass {
    if !summary_is_hidden(hidden, session_kind) {
        return VisibilityClass::Primary;
    }
    if parent_session_id.is_some_and(|parent| !parent.is_empty()) {
        VisibilityClass::Member
    } else {
        VisibilityClass::Hidden
    }
}

/// Wire `kind` for a primary session: CLI kind when set, else `conversation`.
#[must_use]
pub fn wire_session_kind(session_kind: Option<&str>) -> String {
    session_kind
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .unwrap_or("conversation")
        .to_owned()
}

/// One turn restored into the browser after `session/load`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredMessage {
    /// `user` or `agent`.
    pub role: String,
    /// Plain text (agent side may still contain markdown).
    pub text: String,
    /// Order in the rehydrate stream (interleaves with [`RestoredTool::seq`]).
    #[serde(default)]
    pub seq: i64,
}

/// One tool call restored from on-disk ACP updates (no bodies).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredTool {
    /// Tool call id from the agent.
    pub tool_call_id: String,
    /// Display name / title.
    pub name: String,
    /// Closed action set (same as live projection).
    pub action: String,
    /// Agent-declared read-only flag.
    pub read_only: bool,
    /// MCP provider when not the agent built-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Bounded detail line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Whether the call finished.
    pub finished: bool,
    /// Whether it failed.
    pub failed: bool,
    /// Order in the rehydrate stream.
    pub seq: i64,
}

/// Messages + tools rebuilt from `updates.jsonl` for one session.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RehydratedSession {
    /// User/agent text turns.
    pub messages: Vec<RestoredMessage>,
    /// Tool rows (bounded projection only).
    pub tools: Vec<RestoredTool>,
}

/// Maximum tool rows restored for one session (matches a scannable transcript).
pub const MAX_REHYDRATE_TOOLS: usize = 200;

/// Resolve the Grok home directory the user's CLI uses.
///
/// `GROK_HOME` wins when set; otherwise `$HOME/.grok`. Light never uses
/// Desktop's managed home.
#[must_use]
pub fn grok_home() -> PathBuf {
    if let Ok(explicit) = std::env::var("GROK_HOME")
        && !explicit.is_empty()
    {
        return PathBuf::from(explicit);
    }
    std::env::var_os("HOME")
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
        .join(".grok")
}

/// Encode a working directory the way Grok Build names session groups.
///
/// Matches `urlencoding` of the absolute path with an empty safe set, so `/`
/// becomes `%2F` and the group directory is stable across Light and the TUI.
#[must_use]
pub fn encode_cwd_dirname(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for byte in cwd.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(*byte));
            }
            _ => {
                use std::fmt::Write as _;
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// One directory that already has Grok sessions, as host-side discovery.
///
/// The browser never sees `path`. It receives an opaque `project_id` and a
/// display label only (light ADR 0009 / 0012).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectGroup {
    /// Opaque id stable for a canonical path (`proj-` + hex).
    pub project_id: String,
    /// Basename-oriented label; never a full path.
    pub display_name: String,
    /// Absolute cwd decoded from the session group directory name.
    pub path: PathBuf,
    /// How many session folders exist under the group.
    pub session_count: u64,
    /// Newest summary timestamp seen in the group, or empty.
    pub last_active_at: String,
}

/// Opaque project id for a host path (never sent as a path string).
#[must_use]
pub fn project_id_for_path(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("proj-{hex}")
}

/// Decode a Grok session group directory name back into a path string.
///
/// Inverse of [`encode_cwd_dirname`] for the percent-encoding Grok uses.
#[must_use]
pub fn decode_cwd_dirname(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hi = from_hex(bytes[index + 1])?;
                let lo = from_hex(bytes[index + 2])?;
                out.push((hi << 4) | lo);
                index += 3;
            }
            b'%' => return None,
            other => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// List directories that already have Grok sessions under the user's home.
///
/// Host-only. Sorted by last activity (newest first), capped at
/// [`MAX_PROJECTS`]. Missing or unreadable groups are skipped.
#[must_use]
pub fn list_project_groups() -> Vec<ProjectGroup> {
    list_project_groups_in(&grok_home())
}

/// Same as [`list_project_groups`] with an explicit Grok home.
#[must_use]
pub fn list_project_groups_in(home: &Path) -> Vec<ProjectGroup> {
    let sessions_root = home.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions_root) else {
        return Vec::new();
    };

    let mut groups = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(encoded) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(decoded) = decode_cwd_dirname(encoded) else {
            continue;
        };
        if decoded.is_empty() {
            continue;
        }
        let cwd = PathBuf::from(&decoded);
        // Only surfaces that still exist as directories can be opened.
        if !cwd.is_dir() {
            continue;
        }
        let sessions = list_for_cwd_in(home, &cwd);
        if sessions.is_empty() {
            continue;
        }
        let session_count = sessions.len() as u64;
        let last_active_at = sessions
            .first()
            .map(|session| session.updated_at.clone())
            .unwrap_or_default();
        let display_name = display_name_for_cwd(&cwd);
        groups.push(ProjectGroup {
            project_id: project_id_for_path(&cwd),
            display_name,
            path: cwd,
            session_count,
            last_active_at,
        });
    }

    // Prefer the most recently used project first (OpenCode-style).
    groups.sort_by(|left, right| {
        right
            .last_active_at
            .cmp(&left.last_active_at)
            .then_with(|| left.display_name.cmp(&right.display_name))
    });
    // Disambiguate identical basenames with a parent segment (still not a full path).
    disambiguate_display_names(&mut groups);
    groups.truncate(MAX_PROJECTS);
    groups
}

fn display_name_for_cwd(cwd: &Path) -> String {
    cwd.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "project".to_owned())
}

fn disambiguate_display_names(groups: &mut [ProjectGroup]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for group in groups.iter() {
        *counts.entry(group.display_name.clone()).or_insert(0) += 1;
    }
    for group in groups.iter_mut() {
        if counts.get(&group.display_name).copied().unwrap_or(0) < 2 {
            continue;
        }
        if let Some(parent) = group
            .path
            .parent()
            .and_then(|parent| parent.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
        {
            group.display_name = format!("{parent}/{name}", name = group.display_name);
        }
    }
}

/// List **primary** sessions stored for a workspace directory, newest first.
///
/// Nested / hidden sessions (subagents, explicit `hidden: true`) are omitted
/// from this list so the home rail matches the CLI resume picker. Missing
/// groups or unreadable summaries are skipped, not fatal. Results are capped
/// at [`MAX_SESSION_LIST`].
#[must_use]
pub fn list_for_cwd(cwd: &Path) -> Vec<SessionSummary> {
    list_for_cwd_in(&grok_home(), cwd)
}

/// Same as [`list_for_cwd`] with an explicit Grok home (tests and injection).
#[must_use]
pub fn list_for_cwd_in(home: &Path, cwd: &Path) -> Vec<SessionSummary> {
    let graph = load_session_graph(home, cwd);
    let mut member_counts: HashMap<String, u64> = HashMap::new();
    for node in &graph {
        if node.visibility != VisibilityClass::Member {
            continue;
        }
        // Count each member session once, by its resolved parent edge.
        if let Some(parent) = node.parent_session_id.as_deref() {
            *member_counts.entry(parent.to_owned()).or_insert(0) += 1;
        }
    }

    let mut sessions = Vec::new();
    for node in graph {
        if node.visibility != VisibilityClass::Primary {
            continue;
        }
        let member_count = member_counts.get(&node.id).copied().unwrap_or(0);
        sessions.push(SessionSummary {
            id: node.id,
            title: node.title,
            updated_at: node.updated_at,
            message_count: node.message_count,
            kind: wire_session_kind(node.session_kind.as_deref()),
            member_count,
        });
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(MAX_SESSION_LIST);
    sessions
}

/// One node in the host-only session graph for a cwd group.
#[derive(Debug, Clone)]
struct SessionNode {
    id: String,
    title: String,
    updated_at: String,
    message_count: u64,
    session_kind: Option<String>,
    /// Explicit CLI `hidden` flag when present.
    hidden: Option<bool>,
    parent_session_id: Option<String>,
    visibility: VisibilityClass,
}

/// Scan `summary.json` (+ `subagents/` links) for one workspace cwd.
///
/// Host-only. Builds membership edges so primary listing and later parent
/// snapshots share the same visibility rules.
fn load_session_graph(home: &Path, cwd: &Path) -> Vec<SessionNode> {
    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let group = home.join("sessions").join(encoded);
    let Ok(entries) = fs::read_dir(&group) else {
        return Vec::new();
    };

    let mut by_id: HashMap<String, SessionNode> = HashMap::new();
    // parent session id → child session ids (from summary and `subagents/`).
    let mut children_of: HashMap<String, Vec<String>> = HashMap::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned();
        if dir_name.is_empty() {
            continue;
        }

        let summary_path = path.join("summary.json");
        let Ok(raw) = fs::read_to_string(&summary_path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<StoredSummary>(&raw) else {
            continue;
        };
        let id = parsed
            .info
            .as_ref()
            .and_then(|info| info.id.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| dir_name.clone());
        if id.is_empty() {
            continue;
        }

        // Prefer generated_title like CLI `display_title`, then session_summary.
        let title = first_nonempty_str(&[
            parsed.generated_title.as_deref(),
            parsed.session_summary.as_deref(),
        ])
        .unwrap_or("")
        .to_owned();
        let updated_at = first_nonempty_str(&[
            parsed.last_active_at.as_deref(),
            parsed.updated_at.as_deref(),
            parsed.created_at.as_deref(),
        ])
        .unwrap_or("")
        .to_owned();
        let message_count = parsed.num_messages.unwrap_or(0);
        let session_kind = parsed
            .session_kind
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let parent_session_id = parsed
            .parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let hidden = parsed.hidden;

        if let Some(parent) = parent_session_id.as_ref() {
            children_of
                .entry(parent.clone())
                .or_default()
                .push(id.clone());
        }

        // Parent folder's `subagents/<childId>/` is a durable membership edge.
        let subagents_dir = path.join("subagents");
        if let Ok(subs) = fs::read_dir(subagents_dir) {
            for sub in subs.flatten() {
                let sub_path = sub.path();
                if !sub_path.is_dir() {
                    continue;
                }
                let Some(child_id) = sub_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                else {
                    continue;
                };
                children_of
                    .entry(id.clone())
                    .or_default()
                    .push(child_id.to_owned());
            }
        }

        by_id.insert(
            id.clone(),
            SessionNode {
                id,
                title,
                updated_at,
                message_count,
                session_kind,
                hidden,
                parent_session_id,
                // Filled after parent edges are complete.
                visibility: VisibilityClass::Primary,
            },
        );
    }

    // Apply parent edges from `subagents/` when summary omitted parent_session_id.
    for (parent_id, children) in &children_of {
        for child_id in children {
            let Some(node) = by_id.get_mut(child_id) else {
                continue;
            };
            if node.parent_session_id.is_none() {
                node.parent_session_id = Some(parent_id.clone());
            }
        }
    }

    for node in by_id.values_mut() {
        node.visibility = visibility_class(
            node.hidden,
            node.session_kind.as_deref(),
            node.parent_session_id.as_deref(),
        );
    }

    by_id.into_values().collect()
}

/// Rebuild user/agent turns from `updates.jsonl` for browser rehydration.
///
/// Only message chunks contribute. Prefer [`rehydrate_session`] when tools
/// should reappear after refresh.
#[must_use]
pub fn rehydrate_transcript(cwd: &Path, session_id: &str) -> Vec<RestoredMessage> {
    rehydrate_session(cwd, session_id).messages
}

/// Same as [`rehydrate_transcript`] with an explicit Grok home.
#[must_use]
pub fn rehydrate_transcript_in(home: &Path, cwd: &Path, session_id: &str) -> Vec<RestoredMessage> {
    rehydrate_session_in(home, cwd, session_id).messages
}

/// Rebuild messages **and** bounded tool rows from `updates.jsonl`.
///
/// Thoughts are dropped. Tool bodies are never restored — only the same
/// closed projection the live path uses. Order is preserved via `seq` so the
/// SPA can interleave tools with turns after a refresh.
#[must_use]
pub fn rehydrate_session(cwd: &Path, session_id: &str) -> RehydratedSession {
    rehydrate_session_in(&grok_home(), cwd, session_id)
}

/// Whether the rehydrate produced anything the browser should paint.
#[must_use]
pub fn rehydrate_has_content(session: &RehydratedSession) -> bool {
    !session.messages.is_empty() || !session.tools.is_empty()
}

/// Map a rehydrate result onto the browser-facing snapshot event body.
///
/// When `cwd` is provided, attaches bounded parent-scoped **members** and
/// **workflows** from the session graph and `workflows/*/state.json`.
#[must_use]
pub fn snapshot_from_rehydrate(
    session_id: String,
    restored: RehydratedSession,
) -> crate::protocol::Event {
    snapshot_from_rehydrate_in(&grok_home(), None, session_id, restored)
}

/// Same as [`snapshot_from_rehydrate`] with an explicit home and optional cwd
/// for hierarchy projection.
#[must_use]
pub fn snapshot_from_rehydrate_in(
    home: &Path,
    cwd: Option<&Path>,
    session_id: String,
    restored: RehydratedSession,
) -> crate::protocol::Event {
    snapshot_from_rehydrate_with_runtime(home, cwd, session_id, restored, Vec::new())
}

/// Snapshot with live runtime tasks merged after disk hierarchy.
///
/// Live tasks (from the open agent) override rehydrated ones with the same id.
#[must_use]
pub fn snapshot_from_rehydrate_with_runtime(
    home: &Path,
    cwd: Option<&Path>,
    session_id: String,
    restored: RehydratedSession,
    live_tasks: Vec<crate::protocol::SnapshotBackgroundTask>,
) -> crate::protocol::Event {
    let (members, workflows) = cwd
        .map(|cwd| project_session_hierarchy(home, cwd, &session_id))
        .unwrap_or_default();
    let mut background_tasks = cwd
        .map(|cwd| rehydrate_background_tasks(home, cwd, &session_id))
        .unwrap_or_default();
    // Live state wins over disk replay for the same task id.
    for task in live_tasks {
        if let Some(existing) = background_tasks
            .iter_mut()
            .find(|t| t.task_id == task.task_id)
        {
            *existing = task;
        } else {
            background_tasks.push(task);
        }
    }
    background_tasks.sort_by_key(|task| std::cmp::Reverse(task.started_at_ms));
    crate::protocol::Event::SessionSnapshot {
        session_id,
        messages: restored
            .messages
            .into_iter()
            .map(|message| crate::protocol::SnapshotMessage {
                role: message.role,
                text: message.text,
                seq: message.seq,
            })
            .collect(),
        tools: restored
            .tools
            .into_iter()
            .map(|tool| crate::protocol::SnapshotTool {
                tool_call_id: tool.tool_call_id,
                name: tool.name,
                action: tool.action,
                read_only: tool.read_only,
                provider: tool.provider,
                detail: tool.detail,
                finished: tool.finished,
                failed: tool.failed,
                seq: tool.seq,
            })
            .collect(),
        members,
        workflows,
        background_tasks,
    }
}

/// Rebuild background task rows from on-disk `updates.jsonl` Xai envelopes.
#[must_use]
pub fn rehydrate_background_tasks(
    home: &Path,
    cwd: &Path,
    session_id: &str,
) -> Vec<crate::protocol::SnapshotBackgroundTask> {
    use crate::session_runtime::SessionRuntime;
    use crate::xai_runtime::{RuntimeAction, decode_notification};

    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let updates = home
        .join("sessions")
        .join(encoded)
        .join(session_id)
        .join("updates.jsonl");
    let Ok(raw) = fs::read_to_string(updates) else {
        return Vec::new();
    };

    let mut runtime = SessionRuntime::default();
    let now = crate::now_ms();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let method = value
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let params = value
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        // Some journals store the notification body at the top level.
        let params = if params.is_null() {
            value.clone()
        } else {
            params
        };
        let Some(action) = decode_notification(method, &params) else {
            continue;
        };
        match action {
            RuntimeAction::TaskBackgrounded { record, .. } => {
                let mut record = record;
                record.restored_from_replay = true;
                runtime.upsert_running(record);
            }
            RuntimeAction::TaskCompleted {
                task_id,
                status,
                exit_code,
                signal,
                ..
            } => {
                let ended = crate::xai_runtime::ended_at_hint(&params).unwrap_or(now);
                if !runtime.tasks.contains_key(&task_id) {
                    runtime.upsert_running(crate::session_runtime::TaskRecord {
                        task_id: task_id.clone(),
                        tool_call_id: None,
                        kind: crate::protocol::BackgroundTaskKind::Bash,
                        status: crate::protocol::BackgroundTaskStatus::Running,
                        title: task_id.clone(),
                        command: String::new(),
                        started_at_ms: ended.saturating_sub(1),
                        ended_at_ms: None,
                        exit_code: None,
                        signal: None,
                        line_count: 0,
                        truncated: false,
                        output_path: None,
                        restored_from_replay: true,
                    });
                }
                runtime.complete(&task_id, status, ended, exit_code, signal);
                if let Some(task) = runtime.tasks.get_mut(&task_id) {
                    task.restored_from_replay = true;
                }
            }
        }
    }
    runtime.snapshot_tasks(now)
}

/// Parent-scoped members + workflows for one session (host-only read).
#[must_use]
pub fn project_session_hierarchy(
    home: &Path,
    cwd: &Path,
    session_id: &str,
) -> (
    Vec<crate::protocol::SnapshotMember>,
    Vec<crate::protocol::SnapshotWorkflow>,
) {
    (
        project_session_members(home, cwd, session_id),
        project_session_workflows(home, cwd, session_id),
    )
}

struct SubagentMeta {
    label: String,
    status: String,
}

fn project_session_members(
    home: &Path,
    cwd: &Path,
    session_id: &str,
) -> Vec<crate::protocol::SnapshotMember> {
    let graph = load_session_graph(home, cwd);
    let meta_by_id = load_subagent_meta(home, cwd, session_id);
    let mut members: Vec<crate::protocol::SnapshotMember> = graph
        .into_iter()
        .filter(|node| {
            node.visibility == VisibilityClass::Member
                && node.parent_session_id.as_deref() == Some(session_id)
        })
        .map(|node| {
            let meta = meta_by_id.get(&node.id);
            crate::protocol::SnapshotMember {
                id: node.id,
                title: crate::bounds::truncate_utf8(&node.title, MAX_WORKFLOW_TEXT_BYTES).0,
                kind: wire_session_kind(node.session_kind.as_deref()),
                label: crate::bounds::truncate_utf8(
                    meta.map(|m| m.label.as_str()).unwrap_or(""),
                    64,
                )
                .0,
                status: meta.map(|m| m.status.clone()).unwrap_or_default(),
                message_count: node.message_count,
            }
        })
        .collect();
    members.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
    members.truncate(MAX_SESSION_MEMBERS);
    members
}

/// Read `subagents/<id>/meta.json` labels/status for one parent.
fn load_subagent_meta(home: &Path, cwd: &Path, parent_id: &str) -> HashMap<String, SubagentMeta> {
    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let sub_root = home
        .join("sessions")
        .join(encoded)
        .join(parent_id)
        .join("subagents");
    let Ok(entries) = fs::read_dir(sub_root) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(child_id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let meta_path = path.join("meta.json");
        let Ok(raw) = fs::read_to_string(meta_path) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let label = meta
            .get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_owned();
        let status = meta
            .get("status")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_owned();
        out.insert(child_id.to_owned(), SubagentMeta { label, status });
    }
    out
}

fn project_session_workflows(
    home: &Path,
    cwd: &Path,
    session_id: &str,
) -> Vec<crate::protocol::SnapshotWorkflow> {
    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let wf_root = home
        .join("sessions")
        .join(encoded)
        .join(session_id)
        .join("workflows");
    let Ok(entries) = fs::read_dir(wf_root) else {
        return Vec::new();
    };
    let mut workflows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let state_path = path.join("state.json");
        let Ok(raw) = fs::read_to_string(state_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let state = value.get("state").unwrap_or(&value);
        let Some(run_id) = state
            .get("run_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let status = state
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let name = state
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let objective = state
            .get("objective")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let current_phase = state
            .get("current_phase")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_owned();
        let result_summary = state
            .get("result_summary")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let phases = project_workflow_phases(state, &current_phase, &status);
        workflows.push(crate::protocol::SnapshotWorkflow {
            run_id: run_id.to_owned(),
            name: crate::bounds::truncate_utf8(&name, 64).0,
            status,
            objective: crate::bounds::truncate_utf8(objective, MAX_WORKFLOW_TEXT_BYTES).0,
            phases,
            current_phase: crate::bounds::truncate_utf8(&current_phase, 64).0,
            agents_used: state.get("agents_used").and_then(|value| value.as_u64()),
            agent_budget: state.get("agent_budget").and_then(|value| value.as_u64()),
            elapsed_ms: state
                .get("elapsed_ms_floor")
                .or_else(|| state.get("elapsed_ms"))
                .and_then(|value| value.as_u64()),
            result_summary: crate::bounds::truncate_utf8(result_summary, MAX_WORKFLOW_TEXT_BYTES).0,
        });
    }
    workflows.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    workflows.truncate(MAX_SESSION_WORKFLOWS);
    workflows
}

fn project_workflow_phases(
    state: &serde_json::Value,
    current_phase: &str,
    status: &str,
) -> Vec<crate::protocol::SnapshotWorkflowPhase> {
    let Some(raw_phases) = state.get("phases").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let terminal = matches!(status, "complete" | "failed" | "cancelled" | "interrupted");
    let mut phases = Vec::new();
    let mut before_current = true;
    for entry in raw_phases {
        let title = entry
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim();
        if title.is_empty() {
            continue;
        }
        // Prefer explicit state from live/workflow_updated shape when present.
        let explicit = entry
            .get("state")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let phase_state = if let Some(state) = explicit {
            state.to_owned()
        } else if terminal {
            "done".to_owned()
        } else if !current_phase.is_empty() && title == current_phase {
            before_current = false;
            "active".to_owned()
        } else if before_current {
            "done".to_owned()
        } else {
            "pending".to_owned()
        };
        phases.push(crate::protocol::SnapshotWorkflowPhase {
            title: crate::bounds::truncate_utf8(title, 64).0,
            state: phase_state,
        });
        if phases.len() >= MAX_WORKFLOW_PHASES {
            break;
        }
    }
    phases
}

/// Same as [`rehydrate_session`] with an explicit Grok home.
#[must_use]
pub fn rehydrate_session_in(home: &Path, cwd: &Path, session_id: &str) -> RehydratedSession {
    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let updates = home
        .join("sessions")
        .join(encoded)
        .join(session_id)
        .join("updates.jsonl");
    let Ok(raw) = fs::read_to_string(updates) else {
        return RehydratedSession::default();
    };

    let mut messages: Vec<RestoredMessage> = Vec::new();
    let mut tools: Vec<RestoredTool> = Vec::new();
    // Open tool rows keyed by id while we walk updates.
    let mut open_tools: HashMap<String, usize> = HashMap::new();
    let mut current_role: Option<&'static str> = None;
    let mut current_text = String::new();
    let mut current_msg_seq: i64 = 0;
    let mut total = 0usize;
    let mut next_seq: i64 = 0;

    let flush_message = |messages: &mut Vec<RestoredMessage>,
                         role: Option<&'static str>,
                         text: &mut String,
                         seq: i64| {
        if let Some(prev) = role
            && !text.is_empty()
        {
            messages.push(RestoredMessage {
                role: prev.to_owned(),
                text: std::mem::take(text),
                seq,
            });
        }
    };

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // ACP updates on disk appear either under /params/update or /update.
        let update = value
            .pointer("/params/update")
            .or_else(|| value.get("update"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str);

        match kind {
            Some("user_message_chunk") | Some("agent_message_chunk") => {
                let text = update
                    .pointer("/content/text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let role = if kind == Some("user_message_chunk") {
                    "user"
                } else {
                    "agent"
                };
                if current_role != Some(role) {
                    flush_message(
                        &mut messages,
                        current_role,
                        &mut current_text,
                        current_msg_seq,
                    );
                    current_role = Some(role);
                    current_msg_seq = next_seq;
                    next_seq += 1;
                }
                if total.saturating_add(text.len()) > MAX_REHYDRATE_CHARS {
                    let remaining = MAX_REHYDRATE_CHARS.saturating_sub(total);
                    let (clipped, _) = crate::bounds::truncate_utf8(text, remaining);
                    current_text.push_str(&clipped);
                    break;
                }
                total = total.saturating_add(text.len());
                current_text.push_str(text);
            }
            Some("tool_call") => {
                if tools.len() >= MAX_REHYDRATE_TOOLS {
                    continue;
                }
                let Some(id) = update
                    .get("toolCallId")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 512)
                else {
                    continue;
                };
                // Flush any open text bubble before the tool so order is honest.
                flush_message(
                    &mut messages,
                    current_role,
                    &mut current_text,
                    current_msg_seq,
                );
                current_role = None;

                let seq = next_seq;
                next_seq += 1;
                let name = tool_title_from_update(&update);
                let action = tool_kind_from_update(&update);
                let read_only = update
                    .pointer("/_meta/x.ai~1tool/read_only")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let provider = tool_provider_from_update(&update);
                let detail = tool_detail_from_update(&update);
                if let Some(&index) = open_tools.get(id) {
                    // Restart: keep original seq, refresh labels.
                    if let Some(row) = tools.get_mut(index) {
                        row.name = name;
                        row.action = action;
                        row.read_only = read_only;
                        row.provider = provider;
                        row.detail = detail.or_else(|| row.detail.clone());
                        row.finished = false;
                        row.failed = false;
                    }
                } else {
                    open_tools.insert(id.to_owned(), tools.len());
                    tools.push(RestoredTool {
                        tool_call_id: id.to_owned(),
                        name,
                        action,
                        read_only,
                        provider,
                        detail,
                        finished: false,
                        failed: false,
                        seq,
                    });
                }
            }
            Some("tool_call_update") => {
                let Some(id) = update.get("toolCallId").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let Some(&index) = open_tools.get(id) else {
                    continue;
                };
                let Some(row) = tools.get_mut(index) else {
                    continue;
                };
                if let Some(title) = update.get("title").and_then(serde_json::Value::as_str) {
                    let (name, _) = crate::bounds::truncate_utf8(
                        title,
                        crate::projection::MAX_TOOL_TITLE_BYTES,
                    );
                    if !name.is_empty() {
                        row.name = name;
                    }
                }
                if let Some(detail) = tool_detail_from_update(&update) {
                    row.detail = Some(detail);
                }
                match update.get("status").and_then(serde_json::Value::as_str) {
                    Some("completed") => {
                        row.finished = true;
                        row.failed = false;
                    }
                    Some("failed") => {
                        row.finished = true;
                        row.failed = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    flush_message(
        &mut messages,
        current_role,
        &mut current_text,
        current_msg_seq,
    );

    // Unfinished tools from a torn log still show as not finished.
    RehydratedSession { messages, tools }
}

fn tool_kind_from_update(update: &serde_json::Value) -> String {
    let raw = update
        .get("kind")
        .or_else(|| update.pointer("/_meta/x.ai~1tool/kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("other");
    match raw {
        "read" | "edit" | "execute" | "search" | "think" | "fetch" | "delete" | "move"
        | "switch_mode" => raw.to_owned(),
        _ => "other".to_owned(),
    }
}

fn tool_title_from_update(update: &serde_json::Value) -> String {
    let raw = update
        .get("title")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            update
                .pointer("/_meta/x.ai~1tool/name")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("tool");
    let (name, _) = crate::bounds::truncate_utf8(raw, crate::projection::MAX_TOOL_TITLE_BYTES);
    if name.is_empty() { "tool".into() } else { name }
}

fn tool_provider_from_update(update: &serde_json::Value) -> Option<String> {
    let namespace = update
        .pointer("/_meta/x.ai~1tool/namespace")
        .and_then(serde_json::Value::as_str)?;
    if namespace.is_empty() || namespace == "grok_build" {
        return None;
    }
    Some(crate::bounds::truncate_utf8(namespace, crate::projection::MAX_TOOL_TITLE_BYTES).0)
}

fn tool_detail_from_update(update: &serde_json::Value) -> Option<String> {
    let input = update
        .get("rawInput")
        .or_else(|| update.pointer("/_meta/x.ai~1tool/input"))?;
    let raw = [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "description",
    ]
    .into_iter()
    .find_map(|field| input.get(field).and_then(serde_json::Value::as_str))
    .filter(|value| !value.is_empty())?;
    Some(crate::bounds::truncate_utf8(raw, crate::projection::MAX_TOOL_DETAIL_BYTES).0)
}

fn first_nonempty_str<'a>(candidates: &[Option<&'a str>]) -> Option<&'a str> {
    candidates
        .iter()
        .flatten()
        .copied()
        .find(|value| !value.is_empty())
}

#[derive(Debug, Deserialize)]
struct StoredSummary {
    info: Option<StoredInfo>,
    session_summary: Option<String>,
    generated_title: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    last_active_at: Option<String>,
    num_messages: Option<u64>,
    /// Grok Build session kind (`subagent`, `fork`, `worktree`, …).
    #[serde(default)]
    session_kind: Option<String>,
    /// Explicit list visibility override from the CLI summary.
    #[serde(default)]
    hidden: Option<bool>,
    /// Parent conversation when this session is a nested agent / fork child.
    #[serde(default)]
    parent_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StoredInfo {
    id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        VisibilityClass, decode_cwd_dirname, encode_cwd_dirname, list_for_cwd_in,
        list_project_groups_in, rehydrate_background_tasks, rehydrate_session_in,
        rehydrate_transcript_in, summary_is_hidden, visibility_class, wire_session_kind,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_session(
        root: &std::path::Path,
        cwd: &str,
        id: &str,
        title: &str,
        updated_at: &str,
        updates_jsonl: &str,
    ) {
        write_session_with(
            root,
            cwd,
            id,
            title,
            updated_at,
            updates_jsonl,
            None,
            None,
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn write_session_with(
        root: &std::path::Path,
        cwd: &str,
        id: &str,
        title: &str,
        updated_at: &str,
        updates_jsonl: &str,
        session_kind: Option<&str>,
        hidden: Option<bool>,
        parent_session_id: Option<&str>,
    ) {
        let group = root.join("sessions").join(encode_cwd_dirname(cwd));
        let dir = group.join(id);
        fs::create_dir_all(&dir).expect("mkdir");
        let mut summary = serde_json::json!({
            "info": { "id": id, "cwd": cwd },
            "session_summary": title,
            "updated_at": updated_at,
            "num_messages": 2,
        });
        if let Some(kind) = session_kind {
            summary["session_kind"] = serde_json::json!(kind);
        }
        if let Some(flag) = hidden {
            summary["hidden"] = serde_json::json!(flag);
        }
        if let Some(parent) = parent_session_id {
            summary["parent_session_id"] = serde_json::json!(parent);
        }
        fs::write(dir.join("summary.json"), summary.to_string()).expect("summary");
        fs::write(dir.join("updates.jsonl"), updates_jsonl).expect("updates");
    }

    #[test]
    fn cwd_encoding_matches_grok_session_groups() {
        assert_eq!(
            encode_cwd_dirname("/home/friend/dev/test"),
            "%2Fhome%2Ffriend%2Fdev%2Ftest"
        );
    }

    #[test]
    fn cwd_decoding_round_trips() {
        let path = "/home/friend/dev/opensource/grok-desktop";
        assert_eq!(
            decode_cwd_dirname(&encode_cwd_dirname(path)).as_deref(),
            Some(path)
        );
    }

    #[test]
    fn project_groups_list_display_names_not_paths() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-proj-list-{stamp}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        let cwd = root.join("my-app");
        fs::create_dir_all(&cwd).expect("cwd");
        write_session(
            &root,
            &cwd.to_string_lossy(),
            "s-1",
            "hello",
            "2026-07-29T12:00:00Z",
            "",
        );
        let projects = list_project_groups_in(&root);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "my-app");
        assert_eq!(projects[0].session_count, 1);
        assert!(!projects[0].project_id.contains('/'));
        assert!(
            !projects[0]
                .display_name
                .contains(root.to_string_lossy().as_ref())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_returns_newest_first_without_paths() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-sess-list-{stamp}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("root");
        let cwd = "/tmp/light-catalog-ws";
        write_session(
            &root,
            cwd,
            "sess-old",
            "Old chat",
            "2026-01-01T00:00:00Z",
            "",
        );
        write_session(
            &root,
            cwd,
            "sess-new",
            "New chat",
            "2026-07-01T00:00:00Z",
            "",
        );

        let listed = list_for_cwd_in(&root, std::path::Path::new(cwd));
        let _ = fs::remove_dir_all(&root);

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "sess-new");
        assert_eq!(listed[0].title, "New chat");
        assert_eq!(listed[0].kind, "conversation");
        assert_eq!(listed[0].member_count, 0);
        assert_eq!(listed[1].id, "sess-old");
        let encoded = serde_json::to_string(&listed).expect("json");
        assert!(!encoded.contains(cwd));
        assert!(!encoded.contains("sessions"));
    }

    #[test]
    fn is_hidden_matches_cli_subagent_kinds() {
        assert!(summary_is_hidden(None, Some("subagent")));
        assert!(summary_is_hidden(None, Some("subagent_fork")));
        assert!(summary_is_hidden(None, Some("subagent_resume")));
        assert!(!summary_is_hidden(None, None));
        assert!(!summary_is_hidden(None, Some("fork")));
        assert!(!summary_is_hidden(None, Some("worktree")));
        assert!(!summary_is_hidden(Some(false), Some("subagent")));
        assert!(summary_is_hidden(Some(true), None));
    }

    #[test]
    fn visibility_classifies_members_vs_primary() {
        assert_eq!(
            visibility_class(None, Some("subagent"), Some("parent")),
            VisibilityClass::Member
        );
        assert_eq!(
            visibility_class(None, Some("subagent"), None),
            VisibilityClass::Hidden
        );
        assert_eq!(visibility_class(None, None, None), VisibilityClass::Primary);
        assert_eq!(
            visibility_class(None, Some("worktree"), None),
            VisibilityClass::Primary
        );
        assert_eq!(wire_session_kind(None), "conversation");
        assert_eq!(wire_session_kind(Some("worktree")), "worktree");
    }

    #[test]
    fn list_omits_subagents_and_counts_members_on_parent() {
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/tmp/light-catalog-members";
        write_session_with(
            root.path(),
            cwd,
            "parent-1",
            "Deep research parent",
            "2026-08-02T23:47:00Z",
            "",
            None,
            None,
            None,
        );
        write_session_with(
            root.path(),
            cwd,
            "child-planner",
            "Planner title",
            "2026-08-02T23:43:00Z",
            "",
            Some("subagent"),
            None,
            Some("parent-1"),
        );
        write_session_with(
            root.path(),
            cwd,
            "child-researcher",
            "Researcher title",
            "2026-08-02T23:44:00Z",
            "",
            Some("subagent"),
            None,
            Some("parent-1"),
        );
        // Sibling primary conversation must still list.
        write_session_with(
            root.path(),
            cwd,
            "other-primary",
            "Other chat",
            "2026-08-02T23:40:00Z",
            "",
            None,
            None,
            None,
        );
        // Fork stays primary (CLI does not hide forks).
        write_session_with(
            root.path(),
            cwd,
            "fork-1",
            "Fork chat",
            "2026-08-02T23:39:00Z",
            "",
            Some("fork"),
            None,
            Some("parent-1"),
        );

        // Parent subagents/ edge without parent_session_id on summary.
        write_session_with(
            root.path(),
            cwd,
            "child-via-dir",
            "Dir linked",
            "2026-08-02T23:45:00Z",
            "",
            Some("subagent"),
            None,
            None,
        );
        let parent_dir = root
            .path()
            .join("sessions")
            .join(encode_cwd_dirname(cwd))
            .join("parent-1");
        fs::create_dir_all(parent_dir.join("subagents").join("child-via-dir")).expect("sub link");

        let listed = list_for_cwd_in(root.path(), std::path::Path::new(cwd));
        let ids: Vec<&str> = listed.iter().map(|s| s.id.as_str()).collect();
        assert!(
            !ids.contains(&"child-planner")
                && !ids.contains(&"child-researcher")
                && !ids.contains(&"child-via-dir"),
            "subagents must not appear as primary peers: {ids:?}"
        );
        assert!(ids.contains(&"parent-1"));
        assert!(ids.contains(&"other-primary"));
        assert!(ids.contains(&"fork-1"), "forks remain primary: {ids:?}");

        let parent = listed
            .iter()
            .find(|s| s.id == "parent-1")
            .expect("parent row");
        assert_eq!(
            parent.member_count, 3,
            "planner + researcher + dir-linked child"
        );
        assert_eq!(parent.kind, "conversation");
    }

    #[test]
    fn explicit_hidden_true_is_omitted_even_without_subagent_kind() {
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/tmp/light-catalog-hidden";
        write_session_with(
            root.path(),
            cwd,
            "visible",
            "Visible",
            "2026-08-01T00:00:00Z",
            "",
            None,
            None,
            None,
        );
        write_session_with(
            root.path(),
            cwd,
            "ghost",
            "Ghost",
            "2026-08-01T01:00:00Z",
            "",
            None,
            Some(true),
            None,
        );
        let listed = list_for_cwd_in(root.path(), std::path::Path::new(cwd));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "visible");
    }

    #[test]
    fn hierarchy_projects_members_and_workflows_without_paths() {
        use super::{project_session_hierarchy, snapshot_from_rehydrate_in};

        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/tmp/light-hierarchy-ws";
        write_session_with(
            root.path(),
            cwd,
            "parent-h",
            "Parent",
            "2026-08-02T00:00:00Z",
            "",
            None,
            None,
            None,
        );
        write_session_with(
            root.path(),
            cwd,
            "child-h",
            "Child title",
            "2026-08-02T00:01:00Z",
            "",
            Some("subagent"),
            None,
            Some("parent-h"),
        );
        let parent_dir = root
            .path()
            .join("sessions")
            .join(encode_cwd_dirname(cwd))
            .join("parent-h");
        let sub_meta = parent_dir.join("subagents").join("child-h");
        fs::create_dir_all(&sub_meta).expect("sub");
        fs::write(
            sub_meta.join("meta.json"),
            r#"{"description":"researcher-0","status":"completed"}"#,
        )
        .expect("meta");
        let wf_dir = parent_dir.join("workflows").join("wf_test");
        fs::create_dir_all(&wf_dir).expect("wf");
        fs::write(
            wf_dir.join("state.json"),
            serde_json::json!({
                "state": {
                    "run_id": "wf_test",
                    "name": "deep-research",
                    "status": "complete",
                    "objective": "learn layouts",
                    "current_phase": "Report",
                    "phases": [
                        { "title": "Plan" },
                        { "title": "Research" },
                        { "title": "Verify" },
                        { "title": "Report" }
                    ],
                    "agents_used": 8,
                    "agent_budget": 128,
                    "elapsed_ms_floor": 1000,
                    "result_summary": "Partial findings",
                    "journal_path": "workflows/wf_test/journal.jsonl"
                }
            })
            .to_string(),
        )
        .expect("state");

        let (members, workflows) =
            project_session_hierarchy(root.path(), std::path::Path::new(cwd), "parent-h");
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].id, "child-h");
        assert_eq!(members[0].label, "researcher-0");
        assert_eq!(members[0].status, "completed");
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].run_id, "wf_test");
        assert_eq!(workflows[0].name, "deep-research");
        assert_eq!(workflows[0].phases.len(), 4);
        assert!(workflows[0].phases.iter().all(|p| p.state == "done"));
        let encoded = serde_json::to_string(&workflows).expect("json");
        assert!(
            !encoded.contains("journal_path") && !encoded.contains(cwd),
            "hierarchy must not leak paths: {encoded}"
        );

        let event = snapshot_from_rehydrate_in(
            root.path(),
            Some(std::path::Path::new(cwd)),
            "parent-h".into(),
            super::RehydratedSession::default(),
        );
        match event {
            crate::protocol::Event::SessionSnapshot {
                members: m,
                workflows: w,
                ..
            } => {
                assert_eq!(m.len(), 1);
                assert_eq!(w.len(), 1);
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
    }

    #[test]
    fn rehydrate_background_tasks_from_journal_shape() {
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/tmp/light-bg-tasks-ws";
        let id = "sess-bg";
        let group = root
            .path()
            .join("sessions")
            .join(encode_cwd_dirname(cwd))
            .join(id);
        fs::create_dir_all(&group).expect("mkdir");
        let updates = r#"
{"method":"_x.ai/session/update","params":{"sessionId":"sess-bg","update":{"sessionUpdate":"task_backgrounded","tool_call_id":"call-1","task_id":"call-1","command":"./target/debug/grok-bridge serve","cwd":"/tmp/ws","output_file":"/tmp/secret.log","description":"Start dual-stack grok-bridge"}}}
{"method":"_x.ai/session/update","params":{"sessionId":"sess-bg","update":{"sessionUpdate":"task_completed","task_snapshot":{"task_id":"call-1","exit_code":0,"success":true}}}}
{"method":"_x.ai/session/update","params":{"sessionId":"sess-bg","update":{"sessionUpdate":"task_backgrounded","task_id":"call-2","command":"sleep 999","description":"long sleep"}}}
"#;
        fs::write(group.join("updates.jsonl"), updates).expect("updates");
        fs::write(
            group.join("summary.json"),
            serde_json::json!({
                "info": { "id": id, "cwd": cwd },
                "session_summary": "bg",
                "updated_at": "2026-08-03T00:00:00Z",
                "num_messages": 1
            })
            .to_string(),
        )
        .expect("summary");

        let tasks = rehydrate_background_tasks(root.path(), std::path::Path::new(cwd), id);
        assert_eq!(tasks.len(), 2, "one completed + one still running");
        let done = tasks.iter().find(|t| t.task_id == "call-1").expect("done");
        assert_eq!(
            done.status,
            crate::protocol::BackgroundTaskStatus::Completed
        );
        assert_eq!(done.title, "Start dual-stack grok-bridge");
        let running = tasks.iter().find(|t| t.task_id == "call-2").expect("run");
        assert_eq!(
            running.status,
            crate::protocol::BackgroundTaskStatus::Running
        );
        let json = serde_json::to_string(&tasks).expect("json");
        assert!(
            !json.contains("secret") && !json.contains("/tmp/"),
            "must not leak output paths: {json}"
        );

        let snap = super::snapshot_from_rehydrate_in(
            root.path(),
            Some(std::path::Path::new(cwd)),
            id.into(),
            super::RehydratedSession::default(),
        );
        match snap {
            crate::protocol::Event::SessionSnapshot {
                background_tasks, ..
            } => {
                assert_eq!(background_tasks.len(), 2);
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
    }

    #[test]
    fn rehydrate_merges_chunks_and_drops_thoughts() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-sess-rehydrate-{stamp}"));
        let _ = fs::remove_dir_all(&root);
        let cwd = "/tmp/light-rehydrate-ws";
        let updates = r#"
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi "}}}}
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"there"}}}}
{"params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}
"#;
        write_session(&root, cwd, "sess-1", "t", "2026-07-01T00:00:00Z", updates);
        let messages = rehydrate_transcript_in(&root, std::path::Path::new(cwd), "sess-1");
        let _ = fs::remove_dir_all(&root);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "hi there");
        assert_eq!(messages[1].role, "agent");
        assert_eq!(messages[1].text, "Hello");
        assert!(messages[0].seq < messages[1].seq);
    }

    #[test]
    fn rehydrate_restores_tool_rows_without_bodies() {
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/tmp/light-rehydrate-tools";
        let updates = r#"
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"run it"}}}}
{"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"run_terminal_command","rawInput":{"command":"echo hi"},"_meta":{"x.ai/tool":{"name":"run_terminal_command","kind":"execute","namespace":"grok_build","read_only":false}}}}}
{"params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","title":"Execute `echo hi`"}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}
"#;
        write_session(
            root.path(),
            cwd,
            "sess-tools",
            "t",
            "2026-07-01T00:00:00Z",
            updates,
        );
        let restored = rehydrate_session_in(root.path(), std::path::Path::new(cwd), "sess-tools");
        assert_eq!(restored.messages.len(), 2);
        assert_eq!(restored.tools.len(), 1);
        let tool = &restored.tools[0];
        assert_eq!(tool.tool_call_id, "call-1");
        assert_eq!(tool.action, "execute");
        assert_eq!(tool.detail.as_deref(), Some("echo hi"));
        assert!(tool.finished);
        assert!(!tool.failed);
        assert!(tool.provider.is_none());
        // Order: user message, tool, agent message.
        assert!(restored.messages[0].seq < tool.seq);
        assert!(tool.seq < restored.messages[1].seq);
    }

    #[test]
    fn a_transcript_clipped_mid_character_does_not_panic() {
        // Model output is full of emoji and accented text, so the byte at the
        // limit routinely lands inside a character. Slicing there used to
        // panic and take the whole restore with it.
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/home/friend/dev/test";

        // The character width must not divide the byte limit, or the cut
        // lands on a boundary by luck and proves nothing. This one is three
        // bytes wide against a limit that leaves a remainder, so the cut is
        // guaranteed to fall inside a character.
        const { assert!(!super::MAX_REHYDRATE_CHARS.is_multiple_of(3)) };
        let huge = "漢".repeat(super::MAX_REHYDRATE_CHARS);
        let line = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": huge },
                }
            }
        })
        .to_string();
        write_session(
            root.path(),
            cwd,
            "s-clip",
            "clipped",
            "2026-07-29T00:00:00Z",
            &line,
        );

        let restored = rehydrate_transcript_in(root.path(), std::path::Path::new(cwd), "s-clip");

        assert_eq!(restored.len(), 1);
        let text = &restored[0].text;
        assert!(
            text.len() <= super::MAX_REHYDRATE_CHARS + crate::bounds::TRUNCATION_MARKER.len(),
            "the restore must stay within the bound plus its own marker, got {}",
            text.len()
        );
        assert!(
            text.chars().count() > 0,
            "a clipped restore must still carry what fitted"
        );
    }

    #[test]
    fn a_clipped_restore_says_it_was_clipped() {
        // Silent truncation would read as a short conversation rather than a
        // cut one, so the user could not tell the difference.
        let root = tempfile::tempdir().expect("tempdir");
        let cwd = "/home/friend/dev/test";
        let huge = "é".repeat(super::MAX_REHYDRATE_CHARS);
        let line = serde_json::json!({
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": huge },
                }
            }
        })
        .to_string();
        write_session(
            root.path(),
            cwd,
            "s-mark",
            "marked",
            "2026-07-29T00:00:00Z",
            &line,
        );

        let restored = rehydrate_transcript_in(root.path(), std::path::Path::new(cwd), "s-mark");
        assert!(
            restored[0].text.contains(crate::bounds::TRUNCATION_MARKER),
            "a clipped restore must be marked"
        );
    }
}
