//! The full path a browser command travels: envelope, journal, dispatch,
//! agent, and back.
//!
//! Uses the scripted fake agent so the permission round trip is deterministic
//! and consumes no model tokens.

use std::sync::Arc;

use grok_bridge::acp::{AgentCommand, AgentEvent, AgentHandle};
use grok_bridge::dispatch::{
    DispatchError, DispatchOutcome, PendingPermission, SessionState, Workspace, dispatch,
};
use grok_bridge::journal::Journal;
use grok_bridge::protocol::{CommandEnvelope, Operation, PROTOCOL_VERSION};

fn fake_agent() -> std::path::PathBuf {
    let mut path = std::env::current_exe().expect("test exe");
    path.pop();
    path.pop();
    path.push("examples");
    path.push(format!("fake_agent{}", std::env::consts::EXE_SUFFIX));
    if !path.exists() {
        let status = std::process::Command::new(env!("CARGO"))
            .args(["build", "-p", "grok-bridge", "--example", "fake_agent"])
            .status()
            .expect("spawn cargo");
        assert!(status.success(), "cargo build --example fake_agent failed");
    }
    assert!(
        path.exists(),
        "missing {}; build the fake_agent example first",
        path.display()
    );
    path
}

fn envelope(operation: Operation, key: &str) -> CommandEnvelope {
    CommandEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: "req-1".into(),
        idempotency_key: Some(key.to_owned()),
        controller_epoch: Some(1),
        expected_revision: None,
        deadline_ms: None,
        operation,
    }
}

async fn agent() -> (Arc<AgentHandle>, tokio::sync::mpsc::Receiver<AgentEvent>) {
    let command = AgentCommand::new(fake_agent().to_string_lossy().into_owned())
        .with_working_directory(std::env::temp_dir());
    let (handle, events) = AgentHandle::spawn(&command).expect("spawn");
    handle.initialize().await.expect("initialize");
    (handle, events)
}

fn workspace_state() -> SessionState {
    let mut state = SessionState::default();
    state.enrol(Workspace {
        id: "w-1".into(),
        display_name: "Demo".into(),
        path: std::env::temp_dir(),
    });
    state
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_command_creates_a_session_and_prompts() {
    let (handle, _events) = agent().await;
    let mut journal = Journal::new();
    let mut state = workspace_state();

    let created = dispatch(
        &envelope(
            Operation::CreateSession {
                workspace_id: "w-1".into(),
            },
            "k-create",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("create session");
    assert_eq!(
        created,
        DispatchOutcome::SessionCreated {
            session_id: "s-1".into()
        }
    );

    let prompted = dispatch(
        &envelope(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "hello".into(),
                bash: false,
            },
            "k-prompt",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("prompt");
    assert_eq!(prompted, DispatchOutcome::PromptAccepted);

    // Both effects are recorded as completed, so a retry cannot re-run them.
    assert!(journal.pending_reviews().is_empty());
    handle.shutdown().await.expect("shutdown");
}

// One linear journey by design: the value of this test is that it reads as
// the sequence a browser actually performs.
#[allow(clippy::too_many_lines)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_permission_decision_travels_from_browser_to_agent() {
    let (handle, mut events) = agent().await;
    let mut journal = Journal::new();
    let mut state = workspace_state();

    dispatch(
        &envelope(
            Operation::CreateSession {
                workspace_id: "w-1".into(),
            },
            "k-create",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("create");

    dispatch(
        &envelope(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "needs permission".into(),
                bash: false,
            },
            "k-prompt",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("prompt");

    // The host records the request exactly as the agent offered it.
    let mut recorded = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if let AgentEvent::PermissionRequest { request_id, params } = event {
            let offered: Vec<String> = params["options"]
                .as_array()
                .expect("options")
                .iter()
                .filter_map(|o| o["optionId"].as_str().map(str::to_owned))
                .collect();
            state.open_permission(
                "perm-1",
                PendingPermission {
                    request_id,
                    session_id: "s-1".into(),
                    offered,
                },
            );
            recorded = true;
            break;
        }
    }
    assert!(recorded, "the agent must have asked for a decision");

    // A browser answer for a withheld option is refused by the host.
    let refused = dispatch(
        &envelope(
            Operation::DecidePermission {
                session_id: "s-1".into(),
                request_id: "perm-1".into(),
                option_id: "always-allow".into(),
            },
            "k-bad",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await;
    assert!(matches!(refused, Err(DispatchError::Permission(_))));

    // The native single-use option goes through.
    let answered = dispatch(
        &envelope(
            Operation::DecidePermission {
                session_id: "s-1".into(),
                request_id: "perm-1".into(),
                option_id: "allow-once".into(),
            },
            "k-good",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("answer");
    assert_eq!(
        answered,
        DispatchOutcome::PermissionAnswered {
            option_id: "allow-once".into()
        }
    );

    // And the agent confirms it observed exactly that option.
    let mut confirmed = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if let AgentEvent::Update(params) = event
            && let Some(text) = params
                .pointer("/update/content/text")
                .and_then(|v| v.as_str())
            && text.starts_with("selected:")
        {
            assert_eq!(text, "selected:allow-once");
            confirmed = true;
            break;
        }
    }
    assert!(confirmed, "the agent must have received allow-once");
    handle.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_death_leaves_the_prompt_for_review_and_blocks_replay() {
    let (handle, _events) = agent().await;
    let mut journal = Journal::new();
    let mut state = workspace_state();

    dispatch(
        &envelope(
            Operation::CreateSession {
                workspace_id: "w-1".into(),
            },
            "k-create",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await
    .expect("create");

    let crashed = dispatch(
        &envelope(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "please crash".into(),
                bash: false,
            },
            "k-prompt",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await;
    assert_eq!(crashed, Err(DispatchError::Agent));

    // Intent was durable and the outcome is unknown, so it awaits review.
    let pending = journal.pending_reviews();
    assert_eq!(pending.len(), 1, "an ambiguous prompt must await review");
    assert_eq!(pending[0].operation, "Prompt");

    // The same key can never be dispatched again.
    let retried = dispatch(
        &envelope(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "please crash".into(),
                bash: false,
            },
            "k-prompt",
        ),
        &mut journal,
        &mut state,
        Some(&handle),
    )
    .await;
    assert_eq!(retried, Err(DispatchError::NotReplayable));
}
