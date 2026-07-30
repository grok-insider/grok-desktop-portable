//! Pure projection of ACP `session/update` params onto `light.local.v1` events.
//!
//! This is the product boundary between the agent's wire shapes and what the
//! browser is allowed to see. It is pure: no I/O, no journal, no review capture.
//! Callers feed it already-bounded ACP notifications and either emit the
//! resulting event or drop it.
//!
//! Keeping the rules here (instead of in the HTTP server) means contract tests
//! and fixtures exercise presentation policy without standing up loopback.

use serde_json::Value;

use crate::bounds::{
    self, MAX_COMMAND_DESCRIPTION_BYTES, MAX_COMMAND_NAME_BYTES, MAX_COMMANDS,
    MAX_EVENT_PAYLOAD_BYTES, MAX_PLAN_ENTRIES, MAX_PLAN_ENTRY_BYTES,
};
use crate::protocol::{CommandProjection, Event, PlanEntryProjection};

/// Maximum tool title / provider name projected to the browser, in bytes.
pub const MAX_TOOL_TITLE_BYTES: usize = 256;

/// Maximum tool detail line projected to the browser, in bytes.
pub const MAX_TOOL_DETAIL_BYTES: usize = 512;

/// Map one ACP `session/update` params object onto a browser-facing event.
///
/// Only known user-visible (or explicitly reasoned) kinds are forwarded.
/// Anything else is dropped rather than defaulting to `messageDelta`, which
/// is what mixed thoughts into the transcript.
#[must_use]
pub fn session_update_event(params: &Value) -> Option<Event> {
    let kind = params
        .pointer("/update/sessionUpdate")
        .and_then(Value::as_str)?;

    // With several conversations open, an update that cannot say which one it
    // belongs to is unroutable. Dropping it loses a chunk; guessing would
    // print one session's output inside another (light ADR 0011).
    let session_id = params.get("sessionId").and_then(Value::as_str)?.to_owned();

    match kind {
        "agent_message_chunk" => {
            text_chunk(params).map(|text| Event::MessageDelta { session_id, text })
        }
        // Wire name from agent-client-protocol (`AgentThoughtChunk`).
        "agent_thought_chunk" | "agent_thought" => {
            text_chunk(params).map(|text| Event::ThoughtDelta { session_id, text })
        }
        "tool_call" => {
            let tool_call_id = tool_call_id(params)?;
            Some(Event::ToolStart {
                session_id,
                tool_call_id,
                name: tool_title(params),
                action: tool_kind(params),
                read_only: params
                    .pointer("/update/_meta/x.ai~1tool/read_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                provider: tool_provider(params),
                detail: tool_detail(params),
            })
        }
        "tool_call_update" => {
            let tool_call_id = tool_call_id(params)?;
            let status = params
                .pointer("/update/status")
                .and_then(Value::as_str)
                .unwrap_or("");
            match status {
                "completed" | "failed" => Some(Event::ToolEnd {
                    session_id,
                    tool_call_id,
                    failed: status == "failed",
                    // Light does not forward raw tool output bodies; the flag
                    // would be set if we ever truncated a projected payload.
                    truncated: false,
                }),
                // An update without a terminal status is the agent filling in
                // what the call actually turned out to be, so the better label
                // and description ride along rather than being dropped.
                _ => Some(Event::ToolProgress {
                    session_id,
                    tool_call_id,
                    title: params
                        .pointer("/update/title")
                        .and_then(Value::as_str)
                        .map(|raw| bounds::truncate_utf8(raw, MAX_TOOL_TITLE_BYTES).0),
                    detail: tool_detail(params),
                }),
            }
        }
        "plan" => Some(Event::PlanUpdated {
            session_id,
            entries: plan_entries(params),
        }),
        // The agent owns its command set and republishes it as it changes, so
        // the browser is told rather than left to guess.
        "available_commands_update" => Some(Event::CommandsUpdated {
            session_id,
            commands: available_commands(params),
        }),
        _ => None,
    }
}

/// Project the agent's advertised commands, bounded and text-only.
///
/// An entry without a usable name is skipped rather than rendered blank: the
/// list is agent-supplied, and a nameless command is not something the user
/// could invoke.
#[must_use]
pub fn available_commands(params: &Value) -> Vec<CommandProjection> {
    let Some(raw) = params
        .pointer("/update/availableCommands")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    let mut commands = Vec::new();
    for entry in raw {
        if commands.len() >= MAX_COMMANDS {
            break;
        }
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        let (name, _) = bounds::truncate_utf8(name.trim(), MAX_COMMAND_NAME_BYTES);
        if name.is_empty() {
            continue;
        }
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| bounds::truncate_utf8(text, MAX_COMMAND_DESCRIPTION_BYTES).0);
        commands.push(CommandProjection { name, description });
    }
    commands
}

/// Project ACP plan entries: content + closed status only.
///
/// Priority is not projected: the agent may use it internally, but Light's
/// transcript plan is a progress list, not a priority board. Content is
/// agent-supplied and rendered as text in the SPA.
#[must_use]
pub fn plan_entries(params: &Value) -> Vec<PlanEntryProjection> {
    let Some(raw) = params.pointer("/update/entries").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut entries = Vec::new();
    for entry in raw {
        if entries.len() >= MAX_PLAN_ENTRIES {
            break;
        }
        let Some(content) = entry.get("content").and_then(Value::as_str) else {
            continue;
        };
        let (content, _) = bounds::truncate_utf8(content.trim(), MAX_PLAN_ENTRY_BYTES);
        if content.is_empty() {
            continue;
        }
        let status = match entry.get("status").and_then(Value::as_str).unwrap_or("") {
            "in_progress" => "in_progress",
            "completed" => "completed",
            // pending, cancelled-as-completed with meta, unknown → pending.
            // Cancelled is not an ACP status; CLI may mark meta.cancelled.
            _ => {
                let cancelled = entry
                    .pointer("/_meta/cancelled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if cancelled { "completed" } else { "pending" }
            }
        };
        entries.push(PlanEntryProjection {
            content,
            status: status.to_owned(),
        });
    }
    entries
}

fn text_chunk(params: &Value) -> Option<String> {
    let text = params
        .pointer("/update/content/text")
        .and_then(Value::as_str)?;
    let (text, _) = bounds::truncate_utf8(text, MAX_EVENT_PAYLOAD_BYTES);
    if text.is_empty() { None } else { Some(text) }
}

/// ACP tool kind, restricted to the set Light knows how to present.
///
/// An unrecognised kind becomes `other` rather than being passed through:
/// the value reaches the interface, and only a closed set can be styled
/// without letting agent-supplied text choose a presentation.
fn tool_kind(params: &Value) -> String {
    let raw = params
        .pointer("/update/kind")
        .or_else(|| params.pointer("/update/_meta/x.ai~1tool/kind"))
        .and_then(Value::as_str)
        .unwrap_or("other");
    match raw {
        "read" | "edit" | "execute" | "search" | "think" | "fetch" | "delete" | "move"
        | "switch_mode" => raw.to_owned(),
        _ => "other".to_owned(),
    }
}

/// Which MCP server provided the tool, when it was not the agent's own.
///
/// The agent's built-in toolset reports its own namespace, which is not worth
/// showing; anything else is one of the user's integrations and is.
fn tool_provider(params: &Value) -> Option<String> {
    let namespace = params
        .pointer("/update/_meta/x.ai~1tool/namespace")
        .and_then(Value::as_str)?;
    if namespace.is_empty() || namespace == "grok_build" {
        return None;
    }
    Some(bounds::truncate_utf8(namespace, MAX_TOOL_TITLE_BYTES).0)
}

/// One bounded line saying what the call is actually doing.
///
/// The command or path is the part a user scanning a transcript needs; the
/// full input is not projected, and what is projected is bounded here because
/// it is agent-supplied.
fn tool_detail(params: &Value) -> Option<String> {
    let input = params
        .pointer("/update/rawInput")
        .or_else(|| params.pointer("/update/_meta/x.ai~1tool/input"))?;
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
    .find_map(|field| input.get(field).and_then(Value::as_str))
    .filter(|value| !value.is_empty())?;
    Some(bounds::truncate_utf8(raw, MAX_TOOL_DETAIL_BYTES).0)
}

fn tool_call_id(params: &Value) -> Option<String> {
    let id = params
        .pointer("/update/toolCallId")
        .and_then(Value::as_str)?;
    // Tool ids from the CLI can be long; allow a few hundred bytes but refuse
    // unbounded strings.
    if id.is_empty() || id.len() > 512 {
        return None;
    }
    Some(id.to_owned())
}

fn tool_title(params: &Value) -> String {
    let raw = params
        .pointer("/update/title")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .pointer("/update/_meta/x.ai~1tool/name")
                .and_then(Value::as_str)
        })
        .unwrap_or("tool");
    let (name, _) = bounds::truncate_utf8(raw, MAX_TOOL_TITLE_BYTES);
    if name.is_empty() { "tool".into() } else { name }
}

#[cfg(test)]
mod tests {
    use super::{MAX_TOOL_DETAIL_BYTES, available_commands, plan_entries, session_update_event};
    use crate::protocol::Event;

    fn acp_update(session_update: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": session_update,
                "content": { "type": "text", "text": text }
            }
        })
    }

    #[test]
    fn agent_message_chunks_become_message_deltas() {
        assert_eq!(
            session_update_event(&acp_update("agent_message_chunk", "hello")),
            Some(Event::MessageDelta {
                session_id: "s-1".into(),
                text: "hello".into()
            })
        );
    }

    #[test]
    fn agent_thought_chunks_become_thought_deltas_not_messages() {
        // This is the screenshot bug: reasoning used to ride the same path as
        // the reply and land in the agent bubble.
        assert_eq!(
            session_update_event(&acp_update(
                "agent_thought_chunk",
                "The user is just saying hi"
            )),
            Some(Event::ThoughtDelta {
                session_id: "s-1".into(),
                text: "The user is just saying hi".into()
            })
        );
        assert_eq!(
            session_update_event(&acp_update("agent_thought", "reasoning")),
            Some(Event::ThoughtDelta {
                session_id: "s-1".into(),
                text: "reasoning".into()
            })
        );
    }

    #[test]
    fn unknown_or_textless_updates_are_not_forced_into_messages() {
        assert_eq!(
            session_update_event(&serde_json::json!({
                "update": { "sessionUpdate": "agent_message_chunk" }
            })),
            None
        );
        assert_eq!(
            session_update_event(&serde_json::json!({
                "update": { "content": { "type": "text", "text": "orphan" } }
            })),
            None
        );
        // Still unroutable without a session: with several conversations open
        // there is no way to say whose commands these are (light ADR 0011).
        assert_eq!(
            session_update_event(&serde_json::json!({
                "update": { "sessionUpdate": "available_commands_update" }
            })),
            None
        );
    }

    #[test]
    fn available_commands_become_a_commands_event() {
        assert_eq!(
            session_update_event(&serde_json::json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [
                        { "name": "help", "description": "Help" },
                        { "name": "init" }
                    ]
                }
            })),
            Some(Event::CommandsUpdated {
                session_id: "s-1".into(),
                commands: vec![
                    crate::protocol::CommandProjection {
                        name: "help".into(),
                        description: Some("Help".into()),
                    },
                    crate::protocol::CommandProjection {
                        name: "init".into(),
                        description: None,
                    },
                ],
            })
        );
    }

    #[test]
    fn agent_supplied_commands_are_bounded_and_sanitised() {
        let flood: Vec<serde_json::Value> = (0..(crate::bounds::MAX_COMMANDS + 40))
            .map(|index| serde_json::json!({ "name": format!("cmd-{index}") }))
            .collect();
        let projected = available_commands(&serde_json::json!({
            "update": { "availableCommands": flood }
        }));
        assert_eq!(projected.len(), crate::bounds::MAX_COMMANDS);

        let mixed = available_commands(&serde_json::json!({
            "update": {
                "availableCommands": [
                    { "description": "no name" },
                    { "name": "   " },
                    { "name": " spaced ", "description": "  " },
                    { "name": "x".repeat(400), "description": "y".repeat(900) }
                ]
            }
        }));
        assert_eq!(mixed.len(), 2);
        assert_eq!(mixed[0].name, "spaced");
        assert_eq!(mixed[0].description, None);
        let marker = crate::bounds::TRUNCATION_MARKER.len();
        assert!(mixed[1].name.len() <= crate::bounds::MAX_COMMAND_NAME_BYTES + marker);
        assert!(mixed[1].description.as_ref().is_some_and(
            |text| text.len() <= crate::bounds::MAX_COMMAND_DESCRIPTION_BYTES + marker
        ));
    }

    #[test]
    fn missing_commands_array_projects_nothing() {
        assert!(available_commands(&serde_json::json!({ "update": {} })).is_empty());
    }

    #[test]
    fn tool_calls_become_tool_start_and_end() {
        let start = serde_json::json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "run_terminal_command",
                "status": "in_progress"
            }
        });
        assert_eq!(
            session_update_event(&start),
            Some(Event::ToolStart {
                session_id: "s-1".into(),
                tool_call_id: "call-1".into(),
                name: "run_terminal_command".into(),
                action: "other".into(),
                read_only: false,
                provider: None,
                detail: None,
            })
        );

        let progress = serde_json::json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "in_progress"
            }
        });
        assert_eq!(
            session_update_event(&progress),
            Some(Event::ToolProgress {
                session_id: "s-1".into(),
                tool_call_id: "call-1".into(),
                title: None,
                detail: None,
            })
        );

        let done = serde_json::json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "title": "done"
            }
        });
        assert_eq!(
            session_update_event(&done),
            Some(Event::ToolEnd {
                session_id: "s-1".into(),
                tool_call_id: "call-1".into(),
                failed: false,
                truncated: false,
            })
        );
    }

    #[test]
    fn plan_updates_carry_bounded_entries() {
        assert_eq!(
            session_update_event(&serde_json::json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [
                        { "content": "Read the module", "status": "completed", "priority": "high" },
                        { "content": "Fix the bug", "status": "in_progress", "priority": "medium" },
                        { "content": "  ", "status": "pending" },
                        { "status": "pending" }
                    ]
                }
            })),
            Some(Event::PlanUpdated {
                session_id: "s-1".into(),
                entries: vec![
                    crate::protocol::PlanEntryProjection {
                        content: "Read the module".into(),
                        status: "completed".into(),
                    },
                    crate::protocol::PlanEntryProjection {
                        content: "Fix the bug".into(),
                        status: "in_progress".into(),
                    },
                ],
            })
        );
    }

    #[test]
    fn plan_entries_are_capped() {
        let flood: Vec<serde_json::Value> = (0..(crate::bounds::MAX_PLAN_ENTRIES + 20))
            .map(|index| {
                serde_json::json!({
                    "content": format!("step {index}"),
                    "status": "pending",
                    "priority": "low"
                })
            })
            .collect();
        let projected = plan_entries(&serde_json::json!({
            "update": { "entries": flood }
        }));
        assert_eq!(projected.len(), crate::bounds::MAX_PLAN_ENTRIES);
    }

    mod tool_presentation {
        //! Fixtures are the shapes a qualified Grok Build CLI (0.2.112+)
        //! actually sends, captured from a live session rather than written
        //! from the spec.

        use super::{MAX_TOOL_DETAIL_BYTES, session_update_event};
        use crate::protocol::Event;

        fn start() -> serde_json::Value {
            serde_json::json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-1",
                    "title": "run_terminal_command",
                    "rawInput": { "command": "echo hello", "description": "Echo hello" },
                    "_meta": { "x.ai/tool": {
                        "name": "run_terminal_command",
                        "kind": "execute",
                        "namespace": "grok_build",
                        "label": "Run Command",
                        "read_only": false
                    }}
                }
            })
        }

        #[test]
        fn a_call_says_what_it_does_and_to_what() {
            let Some(Event::ToolStart {
                action,
                detail,
                read_only,
                ..
            }) = session_update_event(&start())
            else {
                panic!("a tool call must project");
            };
            assert_eq!(action, "execute");
            assert_eq!(detail.as_deref(), Some("echo hello"));
            assert!(!read_only);
        }

        #[test]
        fn the_agents_own_toolset_is_not_advertised_as_an_integration() {
            let Some(Event::ToolStart { provider, .. }) = session_update_event(&start()) else {
                panic!("projects");
            };
            assert_eq!(provider, None, "grok_build is the agent, not an MCP server");
        }

        #[test]
        fn a_tool_from_an_mcp_server_names_it() {
            let mut params = start();
            params["update"]["_meta"]["x.ai/tool"]["namespace"] =
                serde_json::json!("chrome-devtools");
            let Some(Event::ToolStart { provider, .. }) = session_update_event(&params) else {
                panic!("projects");
            };
            assert_eq!(provider.as_deref(), Some("chrome-devtools"));
        }

        #[test]
        fn an_unknown_action_is_not_passed_through() {
            let mut params = start();
            params["update"]["_meta"]["x.ai/tool"]["kind"] =
                serde_json::json!("<script>alert(1)</script>");
            let Some(Event::ToolStart { action, .. }) = session_update_event(&params) else {
                panic!("projects");
            };
            assert_eq!(action, "other");
        }

        #[test]
        fn a_long_command_is_bounded_before_it_is_forwarded() {
            let mut params = start();
            params["update"]["rawInput"]["command"] = serde_json::json!("x".repeat(10_000));
            let Some(Event::ToolStart { detail, .. }) = session_update_event(&params) else {
                panic!("projects");
            };
            let detail = detail.expect("a detail");
            assert!(detail.len() <= MAX_TOOL_DETAIL_BYTES + 64);
            assert!(detail.contains(crate::bounds::TRUNCATION_MARKER));
        }

        #[test]
        fn a_failed_call_is_not_reported_as_done() {
            let params = serde_json::json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1",
                    "status": "failed"
                }
            });
            let Some(Event::ToolEnd { failed, .. }) = session_update_event(&params) else {
                panic!("projects");
            };
            assert!(failed);
        }

        #[test]
        fn a_later_update_carries_the_title_the_agent_resolved() {
            let params = serde_json::json!({
                "sessionId": "s-1",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1",
                    "kind": "execute",
                    "title": "Execute `echo hello`",
                    "rawInput": { "command": "echo hello" }
                }
            });
            let Some(Event::ToolProgress { title, detail, .. }) = session_update_event(&params)
            else {
                panic!("projects");
            };
            assert_eq!(title.as_deref(), Some("Execute `echo hello`"));
            assert_eq!(detail.as_deref(), Some("echo hello"));
        }
    }
}
