//! Pure decode of Grok Build `x.ai/*` runtime notifications into domain actions.
//!
//! No I/O. Paths extracted from wire are kept only for host-side TaskRecord
//! storage and must not be forwarded to the browser.

use serde_json::Value;

use crate::protocol::{BackgroundTaskKind, BackgroundTaskStatus};
use crate::session_runtime::{self, TaskRecord};

/// Normalized ACP/ext method name without a leading underscore.
#[must_use]
pub fn normalize_method(method: &str) -> &str {
    method.strip_prefix('_').unwrap_or(method)
}

/// Domain action produced by decoding an extension notification.
#[derive(Debug, Clone)]
pub enum RuntimeAction {
    /// A bash/monitor task entered background.
    TaskBackgrounded {
        /// Session the task belongs to.
        session_id: String,
        /// Host-side record (may include output_path).
        record: TaskRecord,
    },
    /// A background task reached a terminal state.
    TaskCompleted {
        /// Session the task belongs to.
        session_id: String,
        /// Task id.
        task_id: String,
        /// Terminal status.
        status: BackgroundTaskStatus,
        /// Exit code when present.
        exit_code: Option<i32>,
        /// Signal name when present.
        signal: Option<String>,
    },
}

/// Decode one agent notification into a runtime action, if recognized.
#[must_use]
pub fn decode_notification(method: &str, params: &Value) -> Option<RuntimeAction> {
    match normalize_method(method) {
        "x.ai/task_backgrounded" => decode_task_backgrounded(params),
        "x.ai/task_completed" => decode_task_completed(params),
        _ => None,
    }
}

fn decode_task_backgrounded(params: &Value) -> Option<RuntimeAction> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_owned();
    let update = params.get("update")?;
    // sessionUpdate may be task_backgrounded or nested without tag match.
    let tag = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("task_backgrounded");
    if tag != "task_backgrounded" && tag != "TaskBackgrounded" {
        // Some envelopes put fields on update with sessionUpdate set.
        if update.get("task_id").is_none() && update.get("taskId").is_none() {
            return None;
        }
    }

    let task_id = string_field(update, &["task_id", "taskId"])?;
    let tool_call_id = string_field(update, &["tool_call_id", "toolCallId"]);
    let command_raw = string_field(update, &["command"]).unwrap_or_default();
    let description = string_field(update, &["description"]);
    let monitor_description = string_field(update, &["monitor_description", "monitorDescription"]);
    let output_file = string_field(update, &["output_file", "outputFile"]);
    let is_monitor = monitor_description.is_some()
        || command_raw.starts_with("[monitor] ");
    let title = monitor_description
        .clone()
        .or(description)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| command_raw.clone());

    let record = TaskRecord {
        task_id,
        tool_call_id,
        kind: if is_monitor {
            BackgroundTaskKind::Monitor
        } else {
            BackgroundTaskKind::Bash
        },
        status: BackgroundTaskStatus::Running,
        title: session_runtime::bound_title(&title),
        command: session_runtime::bound_command(&command_raw),
        started_at_ms: crate::now_ms(),
        ended_at_ms: None,
        exit_code: None,
        signal: None,
        line_count: 0,
        truncated: false,
        output_path: output_file.map(std::path::PathBuf::from),
        restored_from_replay: meta_is_replay(params),
    };

    Some(RuntimeAction::TaskBackgrounded { session_id, record })
}

fn decode_task_completed(params: &Value) -> Option<RuntimeAction> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?
        .to_owned();
    let update = params.get("update")?;
    let snapshot = update
        .get("task_snapshot")
        .or_else(|| update.get("taskSnapshot"))
        .unwrap_or(update);

    let task_id = string_field(snapshot, &["task_id", "taskId"])?;
    let exit_code = snapshot
        .get("exit_code")
        .or_else(|| snapshot.get("exitCode"))
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok());
    let signal = string_field(snapshot, &["signal"]);
    let success = snapshot
        .get("success")
        .and_then(Value::as_bool)
        .or_else(|| {
            // Infer from exit code when success flag absent.
            exit_code.map(|c| c == 0 && signal.is_none())
        })
        .unwrap_or(exit_code == Some(0) && signal.is_none());
    let status = if success {
        BackgroundTaskStatus::Completed
    } else {
        BackgroundTaskStatus::Failed
    };

    Some(RuntimeAction::TaskCompleted {
        session_id,
        task_id,
        status,
        exit_code,
        signal,
    })
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_owned());
            }
        }
        // task_id may be a number on some agent versions.
        if let Some(n) = value.get(*key).and_then(Value::as_i64) {
            return Some(n.to_string());
        }
        if let Some(n) = value.get(*key).and_then(Value::as_u64) {
            return Some(n.to_string());
        }
    }
    None
}

fn meta_is_replay(params: &Value) -> bool {
    params
        .pointer("/_meta/isReplay")
        .or_else(|| params.pointer("/meta/isReplay"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_task_backgrounded_shell_shape() {
        let params = json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "task_backgrounded",
                "tool_call_id": "call-1",
                "task_id": "bg-9",
                "command": "./target/debug/grok-bridge serve",
                "cwd": "/tmp/ws",
                "output_file": "/tmp/out.log",
                "description": "Start dual-stack grok-bridge"
            }
        });
        let action = decode_notification("x.ai/task_backgrounded", &params).expect("action");
        match action {
            RuntimeAction::TaskBackgrounded { session_id, record } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(record.task_id, "bg-9");
                assert_eq!(record.title, "Start dual-stack grok-bridge");
                assert_eq!(record.kind, BackgroundTaskKind::Bash);
                assert_eq!(record.status, BackgroundTaskStatus::Running);
                assert!(record.output_path.is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn underscore_method_prefix_is_accepted() {
        let params = json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "task_backgrounded",
                "task_id": "1",
                "command": "sleep 1"
            }
        });
        assert!(decode_notification("_x.ai/task_backgrounded", &params).is_some());
    }

    #[test]
    fn decodes_task_completed() {
        let params = json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "task_completed",
                "task_snapshot": {
                    "task_id": "bg-9",
                    "exit_code": 0,
                    "success": true
                }
            }
        });
        let action = decode_notification("x.ai/task_completed", &params).expect("action");
        match action {
            RuntimeAction::TaskCompleted {
                task_id,
                status,
                exit_code,
                ..
            } => {
                assert_eq!(task_id, "bg-9");
                assert_eq!(status, BackgroundTaskStatus::Completed);
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn monitor_description_sets_kind() {
        let params = json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "task_backgrounded",
                "task_id": "m-1",
                "command": "tail -f log",
                "monitor_description": "watch errors"
            }
        });
        let action = decode_notification("x.ai/task_backgrounded", &params).expect("action");
        match action {
            RuntimeAction::TaskBackgrounded { record, .. } => {
                assert_eq!(record.kind, BackgroundTaskKind::Monitor);
                assert_eq!(record.title, "watch errors");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
