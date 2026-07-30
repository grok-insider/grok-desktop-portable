//! Read-only catalog of Grok Build sessions on disk.
//!
//! Light does not own transcripts. Sessions live under the user's `GROK_HOME`
//! (default `~/.grok/sessions/<encoded-cwd>/<id>/`), the same store the TUI
//! `/resume` picker uses. This module only **lists metadata** and **reads**
//! `updates.jsonl` for rehydration — it never writes session content.
//!
//! See light ADR 0010, light ADR 0012 (project groups), and
//! `docs/light/protocol.md`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::bounds::{MAX_PROJECTS, MAX_REHYDRATE_CHARS, MAX_SESSION_LIST};

/// One session as the browser may see it: never a filesystem path.
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

/// List sessions stored for a workspace directory, newest first.
///
/// Missing groups or unreadable summaries are skipped, not fatal: a partial
/// list is better than blocking Work. Results are capped at
/// [`MAX_SESSION_LIST`].
#[must_use]
pub fn list_for_cwd(cwd: &Path) -> Vec<SessionSummary> {
    list_for_cwd_in(&grok_home(), cwd)
}

/// Same as [`list_for_cwd`] with an explicit Grok home (tests and injection).
#[must_use]
pub fn list_for_cwd_in(home: &Path, cwd: &Path) -> Vec<SessionSummary> {
    let encoded = encode_cwd_dirname(&cwd.to_string_lossy());
    let group = home.join("sessions").join(encoded);
    let Ok(entries) = fs::read_dir(&group) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
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
            .or_else(|| {
                path.file_name()
                    .and_then(|name| name.to_str().map(str::to_owned))
            });
        let Some(id) = id else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let title = first_nonempty_str(&[
            parsed.session_summary.as_deref(),
            parsed.generated_title.as_deref(),
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
        sessions.push(SessionSummary {
            id,
            title,
            updated_at,
            message_count,
        });
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(MAX_SESSION_LIST);
    sessions
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
#[must_use]
pub fn snapshot_from_rehydrate(
    session_id: String,
    restored: RehydratedSession,
) -> crate::protocol::Event {
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
    }
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
}

#[derive(Debug, Deserialize)]
struct StoredInfo {
    id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        decode_cwd_dirname, encode_cwd_dirname, list_for_cwd_in, list_project_groups_in,
        rehydrate_session_in, rehydrate_transcript_in,
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
        let group = root.join("sessions").join(encode_cwd_dirname(cwd));
        let dir = group.join(id);
        fs::create_dir_all(&dir).expect("mkdir");
        let summary = serde_json::json!({
            "info": { "id": id, "cwd": cwd },
            "session_summary": title,
            "updated_at": updated_at,
            "num_messages": 2,
        });
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
        assert_eq!(listed[1].id, "sess-old");
        let encoded = serde_json::to_string(&listed).expect("json");
        assert!(!encoded.contains(cwd));
        assert!(!encoded.contains("sessions"));
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
