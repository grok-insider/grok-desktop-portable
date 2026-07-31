//! Message-loop and permission round-trip checks against a scripted agent.
//!
//! These use `examples/fake_agent.rs` so the loop, the permission contract,
//! and the interrupted path are deterministic, offline, and free of model
//! tokens. The real CLI is covered separately by `real_cli_contract.rs`.

use grok_bridge::acp::{AgentCommand, AgentEvent, AgentHandle};
use grok_bridge::journal::{BeginOutcome, EffectState, InterruptCause, Journal};
use grok_bridge::permission::{self, ALLOW_ONCE, REJECT_ONCE};

/// Path of the compiled fake agent next to the test binary.
fn fake_agent() -> std::path::PathBuf {
    let mut path = std::env::current_exe().expect("test exe");
    path.pop(); // deps/
    path.pop(); // debug/
    path.push("examples");
    path.push(format!("fake_agent{}", std::env::consts::EXE_SUFFIX));
    if !path.exists() {
        // Cargo may not have built examples yet for this profile; compile once.
        let status = std::process::Command::new(env!("CARGO"))
            .args(["build", "-p", "grok-bridge", "--example", "fake_agent"])
            .status()
            .expect("spawn cargo");
        assert!(status.success(), "cargo build --example fake_agent failed");
    }
    assert!(
        path.exists(),
        "missing {}; run: cargo build -p grok-bridge --example fake_agent",
        path.display()
    );
    path
}

fn command() -> AgentCommand {
    AgentCommand::new(fake_agent().to_string_lossy().into_owned())
        .with_working_directory(std::env::temp_dir())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_loop_separates_responses_from_notifications() {
    let (agent, mut events) = AgentHandle::spawn(&command()).expect("spawn");
    let init = agent.initialize().await.expect("initialize");
    assert_eq!(init.protocol_version, 1);
    assert_eq!(init.agent_version(), Some("fake-1.0.0"));

    let (session, _) = agent
        .new_session(&std::env::temp_dir())
        .await
        .expect("session");
    assert_eq!(session, "s-1");

    // The prompt response resolves the request, while the deltas arrive as
    // events rather than being mistaken for it.
    let stop = agent.prompt(&session, "say hello").await.expect("prompt");
    assert_eq!(
        stop.get("stopReason").and_then(serde_json::Value::as_str),
        Some("end_turn")
    );

    let mut text = String::new();
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), events.recv()).await
    {
        match event {
            AgentEvent::Update(params) => {
                if let Some(chunk) = params
                    .pointer("/update/content/text")
                    .and_then(|v| v.as_str())
                {
                    text.push_str(chunk);
                }
                if text.contains("world") {
                    break;
                }
            }
            AgentEvent::Exited => break,
            AgentEvent::PermissionRequest { .. } => panic!("unexpected permission request"),
        }
    }
    assert_eq!(text, "hello world");
    agent.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_permission_request_is_projected_and_answered_natively() {
    let (agent, mut events) = AgentHandle::spawn(&command()).expect("spawn");
    agent.initialize().await.expect("initialize");
    let (session, _) = agent
        .new_session(&std::env::temp_dir())
        .await
        .expect("session");

    let agent_for_prompt = std::sync::Arc::clone(&agent);
    let session_for_prompt = session.clone();
    tokio::spawn(async move {
        let _ = agent_for_prompt
            .prompt(&session_for_prompt, "needs permission")
            .await;
    });

    let mut answered = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        match event {
            AgentEvent::PermissionRequest { request_id, params } => {
                let offered: Vec<String> = params
                    .get("options")
                    .and_then(|v| v.as_array())
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|option| {
                                option
                                    .get("optionId")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                // The agent offered persistent options; Light must hide them.
                assert!(offered.iter().any(|id| id == "always-allow"));
                assert!(offered.iter().any(|id| id == "reject-always"));

                let projected = permission::project("perm-1", &offered).expect("project");
                assert_eq!(projected.options, vec![ALLOW_ONCE, REJECT_ONCE]);
                assert!(
                    !projected.options.iter().any(|id| id == "always-allow"),
                    "a persistent grant must never reach the browser"
                );

                // Answering a hidden option is refused before it can be sent.
                assert!(permission::authorize_answer(&offered, "always-allow").is_err());
                permission::authorize_answer(&offered, ALLOW_ONCE).expect("allow-once is offered");

                agent
                    .answer_permission(&request_id, ALLOW_ONCE)
                    .await
                    .expect("answer");
                answered = true;
            }
            AgentEvent::Update(params) => {
                if let Some(text) = params
                    .pointer("/update/content/text")
                    .and_then(|v| v.as_str())
                    && text.starts_with("selected:")
                {
                    assert_eq!(
                        text, "selected:allow-once",
                        "the agent must observe exactly the option Light answered"
                    );
                    assert!(answered);
                    agent.shutdown().await.expect("shutdown");
                    return;
                }
            }
            AgentEvent::Exited => break,
        }
    }
    panic!("the agent never confirmed the selected option");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_crash_mid_turn_leaves_a_review_record_and_never_replays() {
    let (agent, mut events) = AgentHandle::spawn(&command()).expect("spawn");
    agent.initialize().await.expect("initialize");
    let (session, _) = agent
        .new_session(&std::env::temp_dir())
        .await
        .expect("session");

    // Intent is durable before the prompt is dispatched.
    let mut journal = Journal::new();
    assert_eq!(
        journal.begin("prompt-1", "Prompt", Some("s-1")),
        BeginOutcome::Dispatch
    );

    let prompt = agent.prompt(&session, "please crash").await;
    assert!(prompt.is_err(), "the agent died before answering");

    // The loop reports the exit rather than hanging.
    let mut saw_exit = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(event, AgentEvent::Exited) {
            saw_exit = true;
            break;
        }
    }
    assert!(saw_exit, "the message loop must report the agent exit");

    // The host classifies the ambiguous effect for review.
    let record = journal
        .interrupt("prompt-1", InterruptCause::AgentExit)
        .expect("interrupt");
    let pending = journal.pending_reviews();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].record_id, record);
    assert_eq!(pending[0].operation, "Prompt");

    // And a retry with the same key never dispatches again.
    assert_eq!(
        journal.begin("prompt-1", "Prompt", Some("s-1")),
        BeginOutcome::DoNotReplay(EffectState::Interrupted)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_agent_never_receives_a_forbidden_flag() {
    // The argv is fixed by the adapter; the browser cannot influence it.
    let command = command();
    let argv = command.argv();
    assert_eq!(argv, vec!["agent", "--no-leader", "stdio"]);
    assert!(!argv.contains(&"--always-approve"));
    assert!(!argv.contains(&"--plugin-dir"));
    assert!(!argv.contains(&"serve"));
}
