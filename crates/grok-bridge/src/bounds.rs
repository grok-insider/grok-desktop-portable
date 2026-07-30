//! Central limits for every Grok Light boundary.
//!
//! Bounds are defined once, here, and enforced on the host. The browser is
//! never the first place a limit is applied. See `docs/light/protocol.md`.

/// Maximum accepted size of a single command body, in bytes.
pub const MAX_COMMAND_BODY_BYTES: usize = 256 * 1024;

/// Maximum accepted size of a single inbound WebSocket frame, in bytes.
pub const MAX_WS_FRAME_BYTES: usize = 256 * 1024;

/// Maximum size of one event payload forwarded to the browser, in bytes.
///
/// Larger payloads are truncated on the host with an explicit marker.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 128 * 1024;

/// Maximum tool output forwarded to the browser for a single tool call.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

/// Maximum number of undelivered events retained per connection lineage.
pub const MAX_EVENT_QUEUE_DEPTH: usize = 1024;

/// Maximum number of events retained for bounded replay after reconnect.
pub const MAX_REPLAY_EVENTS: usize = 512;

/// Maximum number of in-flight commands accepted concurrently.
pub const MAX_INFLIGHT_COMMANDS: usize = 16;

/// Maximum number of retained idempotency records.
pub const MAX_IDEMPOTENCY_RECORDS: usize = 512;

/// Maximum number of retained `interrupted_needs_review` records.
pub const MAX_INTERRUPTED_RECORDS: usize = 256;

/// Maximum number of enrolled workspaces.
pub const MAX_WORKSPACES: usize = 256;

/// Maximum project rows projected from the user's session store.
///
/// One row per Grok session group under `$GROK_HOME/sessions`. Listing is
/// capped so a very large home cannot flood the browser.
pub const MAX_PROJECTS: usize = 200;

/// Maximum sessions returned for one workspace listing.
pub const MAX_SESSION_LIST: usize = 50;

/// Maximum total characters of transcript rehydrated after `session/load`.
pub const MAX_REHYDRATE_CHARS: usize = 256 * 1024;

/// Prompts one conversation may hold waiting for its turn.
///
/// A queue is a convenience, not a workload: without a ceiling a page could
/// hold unbounded user text in host memory.
pub const MAX_QUEUED_PROMPTS: usize = 16;

/// Configured MCP integrations the host will project.
///
/// The list is read from the user's own configuration, so it is bounded like
/// every other value that crosses into the browser.
pub const MAX_INTEGRATIONS: usize = 64;

/// Skill names the host will project (global + project combined per list).
pub const MAX_SKILLS: usize = 64;

/// Slash commands the host will project for one conversation.
///
/// The list is agent-supplied over ACP, so it is bounded like every other
/// value that crosses into the browser.
pub const MAX_COMMANDS: usize = 64;

/// Maximum length of one projected command name, in bytes.
pub const MAX_COMMAND_NAME_BYTES: usize = 64;

/// Maximum length of one projected command description, in bytes.
pub const MAX_COMMAND_DESCRIPTION_BYTES: usize = 256;

/// Plan entries projected for one ACP plan update.
///
/// The agent may publish a long todo list; the browser only needs a scannable
/// slice, so the host caps it the same way it caps commands and tools.
pub const MAX_PLAN_ENTRIES: usize = 32;

/// Maximum length of one plan entry's content, in bytes.
pub const MAX_PLAN_ENTRY_BYTES: usize = 256;

/// Context entries the host will project for one listing.
///
/// A workspace may hold hundreds of thousands of files. The browser only ever
/// needs enough to complete a mention, so the walk stops well short of the
/// tree (light ADR 0013).
pub const MAX_CONTEXT_ENTRIES: usize = 100;

/// Directory entries the context walk will examine before giving up.
///
/// Distinct from [`MAX_CONTEXT_ENTRIES`]: a filter can reject almost
/// everything, and the walk must still terminate promptly.
pub const MAX_CONTEXT_SCANNED: usize = 20_000;

/// Deepest directory level the context walk descends to.
pub const MAX_CONTEXT_DEPTH: usize = 8;

/// Maximum length of one projected workspace-relative path, in bytes.
pub const MAX_CONTEXT_PATH_BYTES: usize = 256;

/// Maximum length of a context query the browser may send, in bytes.
pub const MAX_CONTEXT_QUERY_BYTES: usize = 128;

/// Changed files projected in one review response.
pub const MAX_REVIEW_FILES: usize = 200;

/// Maximum size of one complete unified patch projected to the browser.
pub const MAX_REVIEW_PATCH_BYTES: usize = 256 * 1024;

/// Maximum line count of one complete unified patch.
pub const MAX_REVIEW_PATCH_LINES: usize = 5_000;

/// Maximum aggregate patch text in one review response.
pub const MAX_REVIEW_TOTAL_PATCH_BYTES: usize = 2 * 1024 * 1024;

/// Agent-reported diff blocks retained for the most recent turn.
pub const MAX_LAST_TURN_DIFFS: usize = 128;

/// Maximum response wait for a complete host-side Git review collection.
pub const REVIEW_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Grok models projected from the user's models cache.
pub const MAX_MODELS: usize = 32;

/// Sessions that may be open at once (light ADR 0011).
///
/// Concurrency is the point, but it is still bounded: without a ceiling one
/// page could open sessions until the agent process is exhausted, and every
/// other boundary in this host is bounded.
pub const MAX_LIVE_SESSIONS: usize = 8;

/// Maximum length of a client-supplied opaque identifier, in bytes.
pub const MAX_OPAQUE_ID_BYTES: usize = 128;

/// Maximum accepted client deadline, in milliseconds.
pub const MAX_DEADLINE_MS: u64 = 10 * 60 * 1000;

/// Marker appended to a payload truncated by the host.
pub const TRUNCATION_MARKER: &str = "\u{2026}[truncated by grok-bridge]";

/// Truncate `value` to at most `limit` bytes on a character boundary.
///
/// Returns the possibly truncated string and whether truncation occurred. The
/// truncation marker is appended when the value was shortened.
#[must_use]
pub fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_owned(), false);
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = value[..end].to_owned();
    out.push_str(TRUNCATION_MARKER);
    (out, true)
}

#[cfg(test)]
mod tests {
    use super::{TRUNCATION_MARKER, truncate_utf8};

    #[test]
    fn short_values_are_untouched() {
        let (out, truncated) = truncate_utf8("hello", 32);
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn exact_length_is_untouched() {
        let (out, truncated) = truncate_utf8("abcd", 4);
        assert_eq!(out, "abcd");
        assert!(!truncated);
    }

    #[test]
    fn long_values_are_truncated_and_marked() {
        let (out, truncated) = truncate_utf8("abcdefghij", 4);
        assert!(truncated);
        assert!(out.starts_with("abcd"));
        assert!(out.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        // Each 'é' is two bytes; cutting at 3 must not split it.
        let value = "ééé";
        let (out, truncated) = truncate_utf8(value, 3);
        assert!(truncated);
        assert!(out.starts_with("é"));
        // Valid UTF-8 by construction: the prefix is a whole number of chars.
        assert!(out.strip_suffix(TRUNCATION_MARKER).is_some());
    }

    #[test]
    fn zero_limit_yields_only_marker() {
        let (out, truncated) = truncate_utf8("abc", 0);
        assert!(truncated);
        assert_eq!(out, TRUNCATION_MARKER);
    }
}
