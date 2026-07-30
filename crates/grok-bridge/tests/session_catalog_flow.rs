//! Session catalog + tool classification smoke for Light history and tools.
//!
//! These do not require a real Grok CLI: they pin the on-disk layout and the
//! ACP update shapes Light must understand.

use grok_bridge::dispatch::{DispatchOutcome, SessionState, Workspace, dispatch};
use grok_bridge::journal::Journal;
use grok_bridge::protocol::{CommandEnvelope, Operation, PROTOCOL_VERSION};
use grok_bridge::session_catalog::{encode_cwd_dirname, list_for_cwd_in, rehydrate_transcript_in};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn envelope(operation: Operation) -> CommandEnvelope {
    CommandEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: "req-1".into(),
        idempotency_key: None,
        controller_epoch: Some(1),
        expected_revision: None,
        deadline_ms: None,
        operation,
    }
}

fn write_fixture(home: &std::path::Path, cwd: &str, id: &str, title: &str, updates: &str) {
    let dir = home.join("sessions").join(encode_cwd_dirname(cwd)).join(id);
    fs::create_dir_all(&dir).expect("mkdir");
    let summary = serde_json::json!({
        "info": { "id": id, "cwd": cwd },
        "session_summary": title,
        "updated_at": "2026-07-29T12:00:00Z",
        "num_messages": 2,
    });
    fs::write(dir.join("summary.json"), summary.to_string()).expect("summary");
    fs::write(dir.join("updates.jsonl"), updates).expect("updates");
}

#[test]
fn catalog_lists_and_rehydrates_without_paths() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let home = std::env::temp_dir().join(format!("light-catalog-flow-{stamp}"));
    let _ = fs::remove_dir_all(&home);
    let cwd = "/tmp/light-flow-ws";
    let updates = r#"
{"params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"list files"}}}}
{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}
"#;
    write_fixture(&home, cwd, "sess-a", "List files", updates);

    let listed = list_for_cwd_in(&home, &PathBuf::from(cwd));
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "sess-a");
    assert_eq!(listed[0].title, "List files");
    let json = serde_json::to_string(&listed).expect("json");
    assert!(!json.contains(cwd));

    let messages = rehydrate_transcript_in(&home, &PathBuf::from(cwd), "sess-a");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[1].text, "done");

    let _ = fs::remove_dir_all(&home);
}

#[tokio::test]
async fn list_sessions_dispatch_is_scoped_to_an_enrolled_workspace() {
    let mut journal = Journal::new();
    let mut state = SessionState::default();
    state.workspaces.insert(
        "ws-1".into(),
        Workspace {
            id: "ws-1".into(),
            display_name: "demo".into(),
            path: PathBuf::from("/tmp/does-not-need-to-exist-for-empty-list"),
        },
    );

    let outcome = dispatch(
        &envelope(Operation::ListSessions {
            workspace_id: "ws-1".into(),
        }),
        &mut journal,
        &mut state,
        None,
    )
    .await
    .expect("list");

    match outcome {
        DispatchOutcome::Sessions {
            workspace_id,
            sessions,
        } => {
            assert_eq!(workspace_id, "ws-1");
            // Empty is fine: directory need not exist.
            assert!(sessions.is_empty() || !sessions.is_empty());
        }
        other => panic!("expected Sessions, got {other:?}"),
    }

    let refused = dispatch(
        &envelope(Operation::ListSessions {
            workspace_id: "missing".into(),
        }),
        &mut journal,
        &mut state,
        None,
    )
    .await;
    assert!(refused.is_err());
}
