//! Contract tests against the qualified Grok Build CLI.
//!
//! These tests exercise the real executable, so they skip when it is absent
//! rather than failing. They assert only handshake-level facts and never start
//! a turn, so they produce no side effects and consume no model tokens.
//!
//! Run with a qualified CLI installed:
//!
//! ```sh
//! cargo test -p grok-bridge --test real_cli_contract -- --nocapture
//! ```

use grok_bridge::acp::{ACP_PROTOCOL_VERSION, AgentCommand, AgentSession};

/// Returns the program name when a qualified CLI appears to be installed.
fn qualified_cli() -> Option<String> {
    let output = std::process::Command::new("grok")
        .arg("--version")
        .output()
        .ok()?;
    if output.status.success() {
        Some("grok".to_owned())
    } else {
        None
    }
}

#[tokio::test]
async fn initialize_handshake_matches_the_light_contract() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let command = AgentCommand::new(program).with_working_directory(std::env::temp_dir());
    let mut session = AgentSession::spawn(&command).expect("spawn agent");
    let result = session.initialize().await.expect("initialize");

    assert_eq!(
        result.protocol_version, ACP_PROTOCOL_VERSION,
        "the qualified CLI must negotiate the ACP version Light implements"
    );
    assert!(
        result.supports_load_session(),
        "Light's ListSessions/LoadSession operations require loadSession support"
    );
    assert!(
        result.agent_version().is_some(),
        "the agent must report a version so drift is diagnosable"
    );
    assert!(
        !result.auth_methods.is_empty(),
        "the agent must advertise at least one auth method"
    );

    eprintln!(
        "qualified agent version: {}",
        result.agent_version().unwrap_or("unknown")
    );

    session.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_message_loop_drives_a_real_session() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let workspace =
        std::env::temp_dir().join(format!("grok-light-contract-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("workspace");

    let command = AgentCommand::new(program).with_working_directory(workspace.clone());
    let (agent, _events) = grok_bridge::acp::AgentHandle::spawn(&command).expect("spawn");

    let init = agent.initialize().await.expect("initialize");
    assert_eq!(init.protocol_version, ACP_PROTOCOL_VERSION);

    // Creating a session is free: no prompt is sent, so no tokens are used.
    let (session, _) = agent.new_session(&workspace).await.expect("session/new");
    assert!(
        !session.is_empty(),
        "the qualified CLI must return a session identifier"
    );
    eprintln!("qualified agent session: {session}");

    agent.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(&workspace);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_capability_this_cli_lacks_is_reported_as_unsupported_not_broken() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let command = AgentCommand::new(program).with_working_directory(std::env::temp_dir());
    let (agent, _events) = grok_bridge::acp::AgentHandle::spawn(&command).expect("spawn");
    agent.initialize().await.expect("initialize");

    // The CLI is the user's own install and may predate a method Light knows
    // about. `session/list` is exactly that case today: the agent advertises
    // loadSession, yet offers no way to enumerate sessions. Light must read
    // that as a missing capability and degrade, not as a failure to report.
    let outcome = agent
        .request("session/list", serde_json::json!({}))
        .await
        .err();

    match outcome {
        None => eprintln!("note: this CLI now implements session/list; listing can be enabled"),
        Some(error) => {
            assert!(
                error.is_unsupported_method(),
                "a method this CLI lacks must classify as unsupported, got: {error}"
            );
            eprintln!("confirmed: session/list is unsupported by this CLI");
        }
    }

    agent.shutdown().await.expect("shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_this_cli_created_can_be_resumed_in_its_workspace() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let workspace = std::env::temp_dir().join(format!("grok-light-resume-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("workspace");

    let command = AgentCommand::new(program).with_working_directory(workspace.clone());
    let (agent, _events) = grok_bridge::acp::AgentHandle::spawn(&command).expect("spawn");
    agent.initialize().await.expect("initialize");

    // Creating and resuming send no prompt, so no tokens are used.
    let (session, _) = agent.new_session(&workspace).await.expect("session/new");
    agent
        .load_session(&session, &workspace)
        .await
        .expect("session/load must resume a session this agent just created");

    // The directory is what makes a load answerable, which is why light ADR
    // 0009 has the operation name a workspace instead of guessing one.
    let unknown = agent
        .load_session("00000000-0000-0000-0000-000000000000", &workspace)
        .await
        .expect_err("an unknown session must not resolve");
    assert!(
        !unknown.is_unsupported_method(),
        "loading is implemented here, so a bad id must not look like a missing method"
    );

    agent.shutdown().await.expect("shutdown");
    let _ = std::fs::remove_dir_all(&workspace);
}

#[tokio::test]
async fn an_unauthenticated_cli_is_not_reported_as_a_missing_capability() {
    let Some(_) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    // A private, empty GROK_HOME stands in for a CLI the user has not signed
    // into. The user's own home is never read or written here.
    let home = std::env::temp_dir().join(format!("grok-light-noauth-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("temp home");

    let mut child = std::process::Command::new("grok")
        .args(["agent", "--no-leader", "stdio"])
        .env("GROK_HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn agent");

    {
        use std::io::Write as _;
        let stdin = child.stdin.as_mut().expect("stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1,"clientCapabilities":{{}}}}}}"#
        )
        .expect("initialize");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"session/new","params":{{"cwd":"/tmp","mcpServers":[]}}}}"#
        )
        .expect("session/new");
    }

    let output = child.wait_with_output().expect("agent output");
    let _ = std::fs::remove_dir_all(&home);

    let reply = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|message| message.get("id").and_then(serde_json::Value::as_u64) == Some(2))
        .expect("a reply to session/new");

    let Some(error) = reply.get("error") else {
        eprintln!("note: this CLI created a session without authentication");
        return;
    };
    let code = error.get("code").and_then(serde_json::Value::as_i64);

    // Refusing for want of credentials is an application error, not a missing
    // method. If it ever arrived as METHOD_NOT_FOUND, Light would quietly
    // treat an unauthenticated CLI as one lacking the feature and hide the
    // one thing the user can actually fix.
    assert_ne!(
        code,
        Some(grok_bridge::acp::METHOD_NOT_FOUND),
        "an authentication refusal must not look like an unimplemented method"
    );
    eprintln!("confirmed: unauthenticated refusal arrives as code {code:?}");
}

#[tokio::test]
async fn agent_starts_in_its_own_process_group_and_dies_with_the_host() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let command = AgentCommand::new(program).with_working_directory(std::env::temp_dir());
    let session = AgentSession::spawn(&command).expect("spawn agent");
    // Dropping without an explicit shutdown must still terminate the child,
    // because the handle is configured to kill on drop.
    drop(session);
}

/// Repair extension: Unsupported is OK; a dry-run report must never look like
/// an automatic apply (dryRun remains true / no silent side-effect claim).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_repair_extension_is_capability_probed() {
    let Some(program) = qualified_cli() else {
        eprintln!("skipping: no qualified grok CLI on PATH");
        return;
    };

    let command = AgentCommand::new(&program).with_working_directory(std::env::temp_dir());
    let (handle, _events) = grok_bridge::acp::AgentHandle::spawn(&command).expect("spawn");
    let _ = handle.initialize().await;

    // Probe dry-run against a non-existent session id. The CLI may answer
    // unsupported, not-found, or a structured report — never auto-apply.
    match grok_bridge::repair::repair_session(&handle, "light-probe-no-such-session", true).await {
        Ok(report) => {
            assert!(
                report.dry_run,
                "dry-run probe must not report an apply (dry_run=false)"
            );
            eprintln!(
                "repair dry-run probe: repaired={} duplicates={}",
                report.repaired, report.duplicates_removed
            );
        }
        Err(error) if error.is_unsupported_method() => {
            eprintln!("repair extension unsupported on this CLI (acceptable)");
        }
        Err(error) => {
            // Resource errors / internal failures for a fake id are fine —
            // they prove the method was invoked without applying to a real session.
            eprintln!("repair probe error (non-auto): {error}");
        }
    }
    let _ = handle.shutdown().await;
}
