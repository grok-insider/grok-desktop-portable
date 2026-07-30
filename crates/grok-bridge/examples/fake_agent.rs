//! Deterministic ACP agent used as a test fixture.
//!
//! Speaks the subset of ACP that Grok Light drives, so the message loop,
//! permission round trip, and recovery paths can be exercised without a real
//! model, without tokens, and without network access.
//!
//! Scripted behaviour, selected by the prompt text:
//!
//! - `permission` — emits a `session/request_permission` request offering the
//!   full native option set, then reports which option the client selected.
//! - `crash` — exits mid-turn without answering, to drive the interrupted path.
//! - anything else — streams two message deltas and completes.

use std::io::{BufRead as _, Write as _};

// One scripted dispatch table; splitting it would obscure the script the
// fixture implements.
#[allow(clippy::too_many_lines)]
fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut pending_permission: Option<serde_json::Value> = None;

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };

        // A response to our own permission request.
        if message.get("method").is_none() {
            if let Some(expected) = &pending_permission
                && message.get("id") == Some(expected)
            {
                let selected = message
                    .pointer("/result/outcome/optionId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("none")
                    .to_owned();
                pending_permission = None;
                emit(
                    &mut stdout,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": "s-1",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": format!("selected:{selected}") }
                            }
                        }
                    }),
                );
            }
            continue;
        }

        let method = message
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let id = message.get("id").cloned();

        match method {
            "initialize" => respond(
                &mut stdout,
                id,
                &serde_json::json!({
                    "protocolVersion": 1,
                    "agentCapabilities": { "loadSession": true },
                    "authMethods": [{ "id": "cached_token", "name": "cached_token" }],
                    "_meta": { "agentVersion": "fake-1.0.0" }
                }),
            ),
            "session/new" => respond(&mut stdout, id, &serde_json::json!({ "sessionId": "s-1" })),
            "session/prompt" => {
                let text = message
                    .pointer("/params/prompt/0/text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if text.contains("crash") {
                    // Die mid-turn without answering the request.
                    std::process::exit(3);
                }
                if text.contains("permission") {
                    let request_id = serde_json::json!(9001);
                    pending_permission = Some(request_id.clone());
                    emit(
                        &mut stdout,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "method": "session/request_permission",
                            "params": {
                                "sessionId": "s-1",
                                "toolCall": { "toolCallId": "t-1", "title": "write a file" },
                                "options": [
                                    { "optionId": "always-allow", "name": "Always allow", "kind": "allow_always" },
                                    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                                    { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" },
                                    { "optionId": "reject-always", "name": "Reject always", "kind": "reject_always" }
                                ]
                            }
                        }),
                    );
                    // The turn stays open until the client answers.
                    respond(
                        &mut stdout,
                        id,
                        &serde_json::json!({ "stopReason": "end_turn" }),
                    );
                    continue;
                }
                for chunk in ["hello ", "world"] {
                    emit(
                        &mut stdout,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {
                                "sessionId": "s-1",
                                "update": {
                                    "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": chunk }
                                }
                            }
                        }),
                    );
                }
                respond(
                    &mut stdout,
                    id,
                    &serde_json::json!({ "stopReason": "end_turn" }),
                );
            }
            "session/cancel" => { /* notification: nothing to answer */ }
            _ => {
                if let Some(id) = id {
                    emit(
                        &mut stdout,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32601, "message": "Method not found" }
                        }),
                    );
                }
            }
        }
    }
}

fn respond(out: &mut std::io::Stdout, id: Option<serde_json::Value>, result: &serde_json::Value) {
    let Some(id) = id else { return };
    emit(
        out,
        &serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    );
}

fn emit(out: &mut std::io::Stdout, value: &serde_json::Value) {
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
