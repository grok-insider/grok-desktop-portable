//! The closed `light.local.v1` command and event surface.
//!
//! See `docs/light/protocol.md`. The operation union is closed: no variant
//! sends raw ACP, executes JSON-RPC, spawns a process, edits configuration,
//! supplies a filesystem path, changes the origin, or changes policy.

use serde::{Deserialize, Serialize};

use crate::bounds::{MAX_CONTEXT_QUERY_BYTES, MAX_DEADLINE_MS, MAX_OPAQUE_ID_BYTES};
use crate::review::ChangeMode;

/// Wire version of this protocol.
pub const PROTOCOL_VERSION: u32 = 2;

/// WebSocket subprotocol carrying the same version.
pub const WS_SUBPROTOCOL: &str = "light.local.v1";

/// Errors produced while validating an inbound envelope.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    /// The envelope declared a version this host does not implement.
    #[error("unsupported protocol version")]
    UnsupportedVersion,
    /// A required identifier was empty or oversized.
    #[error("malformed identifier: {0}")]
    MalformedId(&'static str),
    /// A side-effecting operation arrived without an idempotency key.
    #[error("operation requires an idempotency key")]
    MissingIdempotencyKey,
    /// The declared deadline exceeded the host maximum.
    #[error("deadline exceeds the host maximum")]
    DeadlineTooLarge,
    /// A mutating operation arrived without a controller epoch.
    #[error("operation requires a controller epoch")]
    MissingControllerEpoch,
    /// A free-text field exceeded its bound.
    ///
    /// Distinct from [`Self::MalformedId`]: a filter is not an identifier and
    /// is not held to the identifier charset, but it is still bounded.
    #[error("field is too long: {field}")]
    FieldTooLong {
        /// Which field, for the refusal message. Never the value itself.
        field: &'static str,
    },
}

/// The closed set of operations a paired browser may request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    /// Single call returning host status, capabilities, workspaces, and lease.
    Bootstrap,
    /// Host, CLI, auth, and protocol state.
    GetHostStatus,
    /// Enrolled workspaces.
    ListWorkspaces,
    /// Ask the host to open its own picker. Returns no path.
    OpenWorkspacePicker,
    /// Enrol a project discovered from the user's Grok session store.
    ///
    /// The browser sends only an opaque `projectId` (light ADR 0009). The host
    /// resolves it to a host-known path, enrols it, and returns workspaces.
    ///
    /// Retained but no longer reachable from the SPA: the rail lists enrolled
    /// projects only, so the browser never holds an unenrolled id (light ADR
    /// 0014). Enrolment is the host picker or `grok-light workspace add`.
    #[serde(rename_all = "camelCase")]
    OpenProject {
        /// Opaque project identifier from a prior list projection.
        project_id: String,
    },
    /// List Grok-only models and their effort levels from the user cache.
    ListModels,
    /// Switch the model (and optional reasoning effort) on an open session.
    #[serde(rename_all = "camelCase")]
    SetSessionModel {
        /// Open agent session.
        session_id: String,
        /// Grok model id from a prior listModels projection.
        model_id: String,
        /// Optional reasoning effort id for models that support it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
    },
    /// List global + project MCP/skill names for a workspace (or global only).
    #[serde(rename_all = "camelCase")]
    ListTools {
        /// Opaque workspace id; omit/empty for global tools only.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
    },
    /// List workspace-relative paths for an `@` mention (light ADR 0013).
    ///
    /// The browser sends an opaque workspace id and an optional filter, never
    /// a path. The host resolves the root at the moment of use and returns
    /// relative paths only, bounded in count, depth, and length.
    #[serde(rename_all = "camelCase")]
    ListContext {
        /// Opaque workspace identifier. Never a filesystem path.
        workspace_id: String,
        /// Substring the user has typed so far, matched case-insensitively.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    /// Read bounded model, usage, context-window, and review capabilities.
    #[serde(rename_all = "camelCase")]
    GetSessionInspector {
        /// Open agent session. Never a path or ACP method.
        session_id: String,
    },
    /// Read one host-owned, bounded change comparison for an open session.
    #[serde(rename_all = "camelCase")]
    GetSessionChanges {
        /// Open agent session. Never a path or Git ref.
        session_id: String,
        /// Closed comparison mode; refs and scope are resolved by the host.
        mode: ChangeMode,
    },
    /// Remove an enrolled workspace by opaque identifier.
    #[serde(rename_all = "camelCase")]
    RemoveWorkspace {
        /// Opaque workspace identifier.
        workspace_id: String,
    },
    /// List Grok Build sessions for one enrolled workspace.
    ///
    /// The host reads metadata from the user's session store for that
    /// workspace's directory. Never a path from the browser (light ADR 0010).
    #[serde(rename_all = "camelCase")]
    ListSessions {
        /// Opaque workspace identifier.
        workspace_id: String,
    },
    /// Resume one agent session inside the workspace it belongs to.
    ///
    /// The workspace is named because `session/load` needs a working
    /// directory and the browser may not supply one (light ADR 0009). It also
    /// binds resuming to a grant that still exists: a session whose workspace
    /// was revoked is not resumable.
    #[serde(rename_all = "camelCase")]
    LoadSession {
        /// Opaque workspace identifier. Never a filesystem path.
        workspace_id: String,
        /// Agent session identifier.
        session_id: String,
    },
    /// Create an agent session bound to an enrolled workspace.
    #[serde(rename_all = "camelCase")]
    CreateSession {
        /// Opaque workspace identifier. Never a filesystem path.
        workspace_id: String,
    },
    /// Send a prompt to the active session.
    #[serde(rename_all = "camelCase")]
    Prompt {
        /// Session the prompt is addressed to.
        session_id: String,
        /// Prompt text.
        text: String,
        /// When true, send as a CLI bash-mode turn (`_meta.bash_command`).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        bash: bool,
    },
    /// Take a queued prompt back out before it runs.
    #[serde(rename_all = "camelCase")]
    RemoveQueued {
        /// Session holding it.
        session_id: String,
        /// The queue entry to drop.
        entry_id: String,
    },
    /// Cancel the in-flight turn and run this message next.
    ///
    /// Matches what the qualified CLI binds to `Ctrl+Enter`: it does not jump
    /// the queue, it stops what is running so the message goes now.
    #[serde(rename_all = "camelCase")]
    SendNow {
        /// Session to interrupt.
        session_id: String,
        /// The message to run next.
        text: String,
        /// When true, the follow-up is a bash-mode command.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        bash: bool,
    },
    /// Cancel the in-flight turn of one session.
    #[serde(rename_all = "camelCase")]
    CancelTurn {
        /// Session whose turn should stop.
        session_id: String,
    },
    /// Close one open session.
    #[serde(rename_all = "camelCase")]
    CloseSession {
        /// Session to close.
        session_id: String,
    },
    /// Answer a permission request with an exact offered option identifier.
    #[serde(rename_all = "camelCase")]
    DecidePermission {
        /// Session that raised the request.
        session_id: String,
        /// The permission request being answered.
        request_id: String,
        /// The exact option identifier offered by the agent.
        option_id: String,
    },
    /// Cumulative acknowledgement of the event cursor.
    #[serde(rename_all = "camelCase")]
    AcknowledgeEvents {
        /// Highest contiguous event sequence the browser has processed.
        through_sequence: u64,
    },
    /// Mark an `interrupted_needs_review` record as reviewed.
    #[serde(rename_all = "camelCase")]
    AcknowledgeInterrupted {
        /// Record identifier.
        record_id: String,
    },
    /// Diagnose tool-pairing history for an open session (read-only dry-run).
    ///
    /// Never mutates history. Maps to ACP `x.ai/session/repair` with
    /// `dryRun: true` when the CLI supports it (light ADR 0015).
    #[serde(rename_all = "camelCase")]
    DiagnoseSession {
        /// Open agent session.
        session_id: String,
    },
    /// Repair tool-pairing history for an open session (user opt-in).
    ///
    /// `dry_run: true` is diagnosis-only; `false` applies. Always journals
    /// intent when applying. Never auto-runs on load (light ADR 0015).
    #[serde(rename_all = "camelCase")]
    RepairSession {
        /// Open agent session.
        session_id: String,
        /// When true, report only; when false, apply after journaled intent.
        dry_run: bool,
    },
    /// Revoke one browser pairing, or all of them.
    #[serde(rename_all = "camelCase")]
    RevokeBrowserPairing {
        /// Session to revoke. `None` revokes every pairing.
        session_id: Option<String>,
    },
}

impl Operation {
    /// Whether this operation can produce a side effect outside the host.
    ///
    /// Side-effecting operations require an idempotency key so a retry after an
    /// ambiguous outcome cannot execute twice.
    #[must_use]
    pub const fn has_side_effect(&self) -> bool {
        matches!(
            self,
            Self::Prompt { .. }
                | Self::SendNow { .. }
                | Self::SetSessionModel { .. }
                | Self::DecidePermission { .. }
                | Self::CreateSession { .. }
                | Self::LoadSession { .. }
                | Self::CancelTurn { .. }
                | Self::CloseSession { .. }
                // Apply-only: dry_run repair is classified in dispatch so a
                // dry diagnose never requires an idempotency key.
                | Self::RepairSession { dry_run: false, .. }
        )
    }

    /// Whether this operation mutates state and therefore needs the lease.
    #[must_use]
    pub const fn requires_control(&self) -> bool {
        matches!(
            self,
            Self::Prompt { .. }
                | Self::SendNow { .. }
                | Self::RemoveQueued { .. }
                | Self::DecidePermission { .. }
                | Self::CreateSession { .. }
                | Self::LoadSession { .. }
                | Self::CancelTurn { .. }
                | Self::CloseSession { .. }
                | Self::RemoveWorkspace { .. }
                | Self::OpenWorkspacePicker
                | Self::OpenProject { .. }
                | Self::SetSessionModel { .. }
                | Self::AcknowledgeInterrupted { .. }
                | Self::RevokeBrowserPairing { .. }
                | Self::DiagnoseSession { .. }
                | Self::RepairSession { .. }
        )
    }

    /// Stable name for logs and journal records. Never includes payload data.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Bootstrap => "Bootstrap",
            Self::GetHostStatus => "GetHostStatus",
            Self::ListWorkspaces => "ListWorkspaces",
            Self::OpenWorkspacePicker => "OpenWorkspacePicker",
            Self::OpenProject { .. } => "OpenProject",
            Self::ListModels => "ListModels",
            Self::SetSessionModel { .. } => "SetSessionModel",
            Self::ListTools { .. } => "ListTools",
            Self::ListContext { .. } => "ListContext",
            Self::GetSessionInspector { .. } => "GetSessionInspector",
            Self::GetSessionChanges { .. } => "GetSessionChanges",
            Self::RemoveWorkspace { .. } => "RemoveWorkspace",
            Self::ListSessions { .. } => "ListSessions",
            Self::LoadSession { .. } => "LoadSession",
            Self::CreateSession { .. } => "CreateSession",
            Self::Prompt { .. } => "Prompt",
            Self::SendNow { .. } => "SendNow",
            Self::RemoveQueued { .. } => "RemoveQueued",
            Self::CancelTurn { .. } => "CancelTurn",
            Self::CloseSession { .. } => "CloseSession",
            Self::DecidePermission { .. } => "DecidePermission",
            Self::AcknowledgeEvents { .. } => "AcknowledgeEvents",
            Self::AcknowledgeInterrupted { .. } => "AcknowledgeInterrupted",
            Self::DiagnoseSession { .. } => "DiagnoseSession",
            Self::RepairSession { .. } => "RepairSession",
            Self::RevokeBrowserPairing { .. } => "RevokeBrowserPairing",
        }
    }
}

/// Every operation name, in the order they are declared.
///
/// Used to turn a name read back from disk into the same `'static` string the
/// running host uses, so a stored record cannot introduce an operation this
/// build does not have.
pub const OPERATION_NAMES: [&str; 26] = [
    "Bootstrap",
    "GetHostStatus",
    "ListWorkspaces",
    "OpenWorkspacePicker",
    "OpenProject",
    "ListModels",
    "SetSessionModel",
    "ListTools",
    "ListContext",
    "GetSessionInspector",
    "GetSessionChanges",
    "RemoveWorkspace",
    "ListSessions",
    "LoadSession",
    "CreateSession",
    "Prompt",
    "SendNow",
    "RemoveQueued",
    "CancelTurn",
    "CloseSession",
    "DecidePermission",
    "AcknowledgeEvents",
    "AcknowledgeInterrupted",
    "DiagnoseSession",
    "RepairSession",
    "RevokeBrowserPairing",
];

/// Resolve a persisted operation name to the canonical `'static` one.
///
/// Returns `None` for anything this build does not know, so a truncated,
/// corrupted, or edited journal cannot smuggle in an unknown operation name
/// that would then be rendered to the user as if the host had run it.
#[must_use]
pub fn operation_name(candidate: &str) -> Option<&'static str> {
    OPERATION_NAMES
        .into_iter()
        .find(|known| *known == candidate)
}

/// A command envelope as received from the browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEnvelope {
    /// Wire version. Must equal [`PROTOCOL_VERSION`].
    pub protocol_version: u32,
    /// Opaque client-generated correlation identifier.
    pub request_id: String,
    /// Required for side-effecting operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Required for mutating operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_epoch: Option<u64>,
    /// Optimistic concurrency token for the addressed resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// Client-declared deadline in milliseconds. Bounded by the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    /// The requested operation.
    pub operation: Operation,
}

impl CommandEnvelope {
    /// Validate the envelope before any dispatch.
    ///
    /// Checks version, identifier shape, idempotency, controller epoch, and
    /// deadline bounds. Payload semantics are checked by the handler.
    ///
    /// # Errors
    ///
    /// Returns the first [`ProtocolError`] encountered.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion);
        }
        check_id(&self.request_id, "requestId")?;
        if let Some(key) = &self.idempotency_key {
            check_id(key, "idempotencyKey")?;
        }
        if self.operation.has_side_effect() && self.idempotency_key.is_none() {
            return Err(ProtocolError::MissingIdempotencyKey);
        }
        if self.operation.requires_control() && self.controller_epoch.is_none() {
            return Err(ProtocolError::MissingControllerEpoch);
        }
        if self.deadline_ms.is_some_and(|ms| ms > MAX_DEADLINE_MS) {
            return Err(ProtocolError::DeadlineTooLarge);
        }
        match &self.operation {
            Operation::OpenProject { project_id } => {
                check_id(project_id, "projectId")?;
            }
            Operation::ListTools {
                workspace_id: Some(workspace_id),
            } if !workspace_id.is_empty() => {
                check_id(workspace_id, "workspaceId")?;
            }
            Operation::ListContext {
                workspace_id,
                query,
            } => {
                check_id(workspace_id, "workspaceId")?;
                // The query is a filter the host applies to names it already
                // holds, never something it resolves. Bounding it keeps a
                // paired page from sending an unbounded body for a read.
                if query
                    .as_ref()
                    .is_some_and(|text| text.len() > MAX_CONTEXT_QUERY_BYTES)
                {
                    return Err(ProtocolError::FieldTooLong { field: "query" });
                }
            }
            Operation::SetSessionModel {
                session_id,
                model_id,
                ..
            } => {
                check_id(session_id, "sessionId")?;
                check_id(model_id, "modelId")?;
            }
            Operation::GetSessionInspector { session_id }
            | Operation::GetSessionChanges { session_id, .. } => {
                check_id(session_id, "sessionId")?;
            }
            Operation::RemoveWorkspace { workspace_id }
            | Operation::CreateSession { workspace_id }
            | Operation::ListSessions { workspace_id } => {
                check_id(workspace_id, "workspaceId")?;
            }
            Operation::LoadSession {
                workspace_id,
                session_id,
            } => {
                check_id(workspace_id, "workspaceId")?;
                check_id(session_id, "sessionId")?;
            }
            Operation::DecidePermission {
                session_id,
                request_id,
                option_id,
            } => {
                check_id(session_id, "sessionId")?;
                check_id(request_id, "permissionRequestId")?;
                check_id(option_id, "optionId")?;
            }
            Operation::Prompt { session_id, .. }
            | Operation::SendNow { session_id, .. }
            | Operation::CancelTurn { session_id }
            | Operation::CloseSession { session_id } => check_id(session_id, "sessionId")?,
            Operation::RemoveQueued {
                session_id,
                entry_id,
            } => {
                check_id(session_id, "sessionId")?;
                check_id(entry_id, "entryId")?;
            }
            Operation::AcknowledgeInterrupted { record_id } => check_id(record_id, "recordId")?,
            Operation::DiagnoseSession { session_id }
            | Operation::RepairSession { session_id, .. } => {
                check_id(session_id, "sessionId")?;
            }
            Operation::RevokeBrowserPairing {
                session_id: Some(id),
            } => check_id(id, "sessionId")?,
            _ => {}
        }
        Ok(())
    }
}

fn check_id(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > MAX_OPAQUE_ID_BYTES {
        return Err(ProtocolError::MalformedId(field));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    {
        return Err(ProtocolError::MalformedId(field));
    }
    Ok(())
}

/// Server-to-client events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// Host, CLI, auth, or protocol state changed.
    #[serde(rename_all = "camelCase")]
    HostStatus {
        /// Coarse host state, safe to render.
        state: String,
    },
    /// Full session state, used when a cursor cannot be replayed or after load.
    #[serde(rename_all = "camelCase")]
    SessionSnapshot {
        /// Session identifier.
        session_id: String,
        /// Restored transcript turns (user/agent text only). Empty when the
        /// host has no on-disk history to rehydrate.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        messages: Vec<SnapshotMessage>,
        /// Restored tool rows from the same history (no bodies). Empty when
        /// none were recorded or the log had no tool activity.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tools: Vec<SnapshotTool>,
    },
    /// Session lifecycle transition.
    #[serde(rename_all = "camelCase")]
    SessionStatus {
        /// Session identifier.
        session_id: String,
        /// Coarse session state.
        state: String,
    },
    /// Assistant output chunk.
    #[serde(rename_all = "camelCase")]
    MessageDelta {
        /// Session the chunk belongs to.
        session_id: String,
        /// Text chunk, already bounded by the host.
        text: String,
    },
    /// Agent reasoning chunk, when the qualified CLI exposes it.
    #[serde(rename_all = "camelCase")]
    ThoughtDelta {
        /// Session the chunk belongs to.
        session_id: String,
        /// Text chunk, already bounded by the host.
        text: String,
    },
    /// A tool call started.
    #[serde(rename_all = "camelCase")]
    ToolStart {
        /// Session the tool call belongs to.
        session_id: String,
        /// Tool call identifier.
        tool_call_id: String,
        /// Human label for the tool, as the agent names it.
        name: String,
        /// What the call does: read, edit, execute, search, think, fetch,
        /// other. Named `action` because `kind` is the event discriminant.
        ///
        /// What a tool *does* matters more than what it is called: a user
        /// scanning a transcript wants to see that something was executed, not
        /// parse a function name.
        action: String,
        /// Whether the agent declares the call cannot change anything.
        read_only: bool,
        /// Where the tool came from, when it is not the agent's own toolset.
        ///
        /// Names an MCP server for a tool it provides, so the user can tell
        /// their own integrations apart from the agent's built-ins.
        provider: Option<String>,
        /// One bounded line describing the call — a command, a path, a query.
        ///
        /// Agent-supplied and therefore untrusted: it is rendered as text and
        /// never as markup, and it is truncated by the host.
        detail: Option<String>,
    },
    /// A tool call reported progress.
    #[serde(rename_all = "camelCase")]
    ToolProgress {
        /// Session the tool call belongs to.
        session_id: String,
        /// Tool call identifier.
        tool_call_id: String,
        /// A better label once the agent has resolved one.
        title: Option<String>,
        /// A better description once the agent has resolved one.
        detail: Option<String>,
    },
    /// A tool call ended.
    #[serde(rename_all = "camelCase")]
    ToolEnd {
        /// Session the tool call belongs to.
        session_id: String,
        /// Tool call identifier.
        tool_call_id: String,
        /// Whether the call finished cleanly or reported a failure.
        failed: bool,
        /// Whether the host truncated the forwarded output.
        truncated: bool,
    },
    /// The agent updated its plan.
    #[serde(rename_all = "camelCase")]
    PlanUpdated {
        /// Session whose plan changed.
        session_id: String,
        /// Bounded plan steps (content + closed status). Empty when the agent
        /// publishes a plan without entries, or when none survived projection.
        #[serde(default)]
        entries: Vec<PlanEntryProjection>,
    },
    /// The agent published the slash commands it accepts.
    ///
    /// The set belongs to the agent and changes with it, so the browser is
    /// told rather than asked to guess. Names and descriptions only: the
    /// agent's command implementations, arguments, and any path they touch
    /// stay on the host side of the boundary.
    #[serde(rename_all = "camelCase")]
    CommandsUpdated {
        /// Conversation the commands apply to.
        session_id: String,
        /// What the agent will accept, bounded by the host.
        commands: Vec<CommandProjection>,
    },
    /// A message the user queued has now been sent.
    ///
    /// The browser adds its own turns to the transcript as it sends them, but
    /// a queued one leaves later and from the host. Without this the reply
    /// arrived with no question above it.
    #[serde(rename_all = "camelCase")]
    PromptSent {
        /// Conversation it was sent to.
        session_id: String,
        /// The message, as the user wrote it.
        text: String,
    },
    /// The queued prompts of one conversation changed.
    ///
    /// Sent when the host takes one out to run it, so the page stops showing
    /// what has already left.
    #[serde(rename_all = "camelCase")]
    QueueChanged {
        /// Conversation whose queue changed.
        session_id: String,
    },
    /// Session context or captured change data changed.
    #[serde(rename_all = "camelCase")]
    SessionReviewUpdated {
        /// Open session whose panel data should be refreshed.
        session_id: String,
        /// Whether the selected change comparison may have changed.
        changes: bool,
        /// Whether context-window or usage information may have changed.
        context: bool,
    },
    /// The enrolled workspace set changed, so the browser should refresh it.
    ///
    /// Emitted when a host-owned picker completes, which is asynchronous:
    /// the command that opened it returned long before the user chose.
    WorkspacesChanged,
    /// The agent requested a permission decision.
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        /// Session that raised the request.
        session_id: String,
        /// Permission request identifier.
        request_id: String,
        /// Only the option identifiers Light is allowed to render.
        options: Vec<String>,
    },
    /// A turn was interrupted and left a review record.
    #[serde(rename_all = "camelCase")]
    TurnInterrupted {
        /// Session whose turn was interrupted.
        session_id: String,
        /// Review record identifier.
        record_id: String,
    },
    /// A non-secret structured error.
    #[serde(rename_all = "camelCase")]
    Error {
        /// Stable machine-readable code.
        code: String,
    },
}

/// One message inside a [`Event::SessionSnapshot`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMessage {
    /// `user` or `agent`.
    pub role: String,
    /// Message body. Never a path or secret by construction of the catalog.
    pub text: String,
    /// Order among restored messages and tools (for timeline interleave).
    #[serde(default)]
    pub seq: i64,
}

/// One tool row inside a [`Event::SessionSnapshot`] (no output bodies).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTool {
    /// Tool call id.
    pub tool_call_id: String,
    /// Display name.
    pub name: String,
    /// Closed action set.
    pub action: String,
    /// Agent-declared read-only.
    pub read_only: bool,
    /// MCP provider when not built-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Bounded detail line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Whether the call finished.
    pub finished: bool,
    /// Whether it failed.
    pub failed: bool,
    /// Order among restored messages and tools.
    pub seq: i64,
}

/// One step of an agent plan, projected for the transcript.
///
/// Content is agent-supplied and therefore untrusted: the browser renders it
/// as text, never as markup. Status is closed (`pending` | `in_progress` |
/// `completed`) so the SPA can style it without letting agent text pick
/// presentation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntryProjection {
    /// Human-readable task description from the agent.
    pub content: String,
    /// Closed lifecycle status after host projection.
    pub status: String,
}

/// One slash command the agent accepts.
///
/// Name and description only. Both are agent-supplied and therefore
/// untrusted: the browser renders them as text and never as markup, and the
/// host truncates both before they cross.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandProjection {
    /// Command name, without the leading slash.
    pub name: String,
    /// One line saying what it does, when the agent supplies one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// An event as delivered to the browser, with its cursor position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    /// Wire version.
    pub protocol_version: u32,
    /// Monotonic sequence within a connection lineage.
    pub event_sequence: u64,
    /// Revision of the addressed session, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_revision: Option<u64>,
    /// The event body.
    pub event: Event,
}

#[cfg(test)]
mod tests {
    use super::{
        CommandEnvelope, Event, EventEnvelope, Operation, PROTOCOL_VERSION, ProtocolError,
    };
    use crate::bounds::MAX_DEADLINE_MS;

    fn envelope(operation: Operation) -> CommandEnvelope {
        CommandEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "req-1".into(),
            idempotency_key: None,
            controller_epoch: None,
            expected_revision: None,
            deadline_ms: None,
            operation,
        }
    }

    #[test]
    fn read_only_operations_validate_without_keys() {
        assert!(envelope(Operation::Bootstrap).validate().is_ok());
        assert!(envelope(Operation::GetHostStatus).validate().is_ok());
        assert!(envelope(Operation::ListWorkspaces).validate().is_ok());
        assert!(
            envelope(Operation::GetSessionInspector {
                session_id: "s-1".into()
            })
            .validate()
            .is_ok()
        );
        assert!(
            envelope(Operation::GetSessionChanges {
                session_id: "s-1".into(),
                mode: crate::review::ChangeMode::Branch,
            })
            .validate()
            .is_ok()
        );
        assert!(
            envelope(Operation::ListSessions {
                workspace_id: "w-1".into()
            })
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn wrong_version_is_rejected() {
        let mut env = envelope(Operation::Bootstrap);
        env.protocol_version = PROTOCOL_VERSION + 1;
        assert_eq!(env.validate(), Err(ProtocolError::UnsupportedVersion));
    }

    #[test]
    fn side_effecting_operations_require_an_idempotency_key() {
        let mut env = envelope(Operation::Prompt {
            session_id: "s-1".into(),
            text: "hi".into(),
            bash: false,
        });
        env.controller_epoch = Some(1);
        assert_eq!(env.validate(), Err(ProtocolError::MissingIdempotencyKey));
        env.idempotency_key = Some("key-1".into());
        assert!(env.validate().is_ok());
    }

    #[test]
    fn mutating_operations_require_a_controller_epoch() {
        let mut env = envelope(Operation::OpenWorkspacePicker);
        assert_eq!(env.validate(), Err(ProtocolError::MissingControllerEpoch));
        env.controller_epoch = Some(3);
        assert!(env.validate().is_ok());
    }

    #[test]
    fn acknowledge_events_is_neither_mutating_nor_side_effecting() {
        let env = envelope(Operation::AcknowledgeEvents {
            through_sequence: 42,
        });
        assert!(env.validate().is_ok());
    }

    #[test]
    fn deadline_is_bounded() {
        let mut env = envelope(Operation::Bootstrap);
        env.deadline_ms = Some(MAX_DEADLINE_MS);
        assert!(env.validate().is_ok());
        env.deadline_ms = Some(MAX_DEADLINE_MS + 1);
        assert_eq!(env.validate(), Err(ProtocolError::DeadlineTooLarge));
    }

    #[test]
    fn identifiers_are_shape_checked() {
        let mut env = envelope(Operation::Bootstrap);
        env.request_id = String::new();
        assert_eq!(env.validate(), Err(ProtocolError::MalformedId("requestId")));

        env.request_id = "a".repeat(4096);
        assert_eq!(env.validate(), Err(ProtocolError::MalformedId("requestId")));

        env.request_id = "bad id with spaces".into();
        assert_eq!(env.validate(), Err(ProtocolError::MalformedId("requestId")));

        env.request_id = "ok-1.2_3".into();
        assert!(env.validate().is_ok());
    }

    #[test]
    fn path_like_workspace_identifiers_are_rejected() {
        // The browser must never be able to smuggle a path through an id.
        for candidate in ["/etc/passwd", "../../secret", "C:\\Windows", "a/b"] {
            let mut env = envelope(Operation::CreateSession {
                workspace_id: candidate.into(),
            });
            env.controller_epoch = Some(1);
            env.idempotency_key = Some("key-1".into());
            assert_eq!(
                env.validate(),
                Err(ProtocolError::MalformedId("workspaceId")),
                "{candidate} must not validate"
            );
        }
    }

    #[test]
    fn decide_permission_checks_both_identifiers() {
        let mut env = envelope(Operation::DecidePermission {
            session_id: "s-1".into(),
            request_id: "perm-1".into(),
            option_id: String::new(),
        });
        env.controller_epoch = Some(1);
        env.idempotency_key = Some("key-1".into());
        assert_eq!(env.validate(), Err(ProtocolError::MalformedId("optionId")));
    }

    #[test]
    fn side_effect_and_control_classification_is_explicit() {
        assert!(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "x".into(),
                bash: false
            }
            .has_side_effect()
        );
        assert!(
            Operation::CancelTurn {
                session_id: "s-1".into()
            }
            .has_side_effect()
        );
        assert!(!Operation::Bootstrap.has_side_effect());
        assert!(!Operation::ListWorkspaces.requires_control());
        assert!(
            Operation::RemoveWorkspace {
                workspace_id: "w-1".into()
            }
            .requires_control()
        );
        // Dry-run diagnose is control-gated but not a side effect; apply is.
        assert!(
            !Operation::DiagnoseSession {
                session_id: "s-1".into()
            }
            .has_side_effect()
        );
        assert!(
            !Operation::RepairSession {
                session_id: "s-1".into(),
                dry_run: true,
            }
            .has_side_effect()
        );
        assert!(
            Operation::RepairSession {
                session_id: "s-1".into(),
                dry_run: false,
            }
            .has_side_effect()
        );
        assert!(
            Operation::RepairSession {
                session_id: "s-1".into(),
                dry_run: false,
            }
            .requires_control()
        );
    }

    #[test]
    fn operation_names_are_payload_free() {
        let name = Operation::Prompt {
            session_id: "s-1".into(),
            text: "secret text".into(),
            bash: false,
        }
        .name();
        assert_eq!(name, "Prompt");
        assert!(!name.contains("secret"));
    }

    #[test]
    fn envelope_round_trips_through_json() {
        let mut env = envelope(Operation::Prompt {
            session_id: "s-1".into(),
            text: "hello".into(),
            bash: false,
        });
        env.controller_epoch = Some(7);
        env.idempotency_key = Some("key-1".into());
        let json = serde_json::to_string(&env).expect("serialize");
        let back: CommandEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(env, back);
        assert!(json.contains("\"kind\":\"prompt\""));
    }

    #[test]
    fn unknown_operation_kinds_are_rejected_by_serde() {
        let json = r#"{"protocolVersion":1,"requestId":"r","operation":{"kind":"execArbitrary"}}"#;
        let parsed: Result<CommandEnvelope, _> = serde_json::from_str(json);
        assert!(parsed.is_err(), "the operation union must stay closed");
    }

    #[test]
    fn unknown_change_modes_are_rejected_by_serde() {
        let json = r#"{
            "protocolVersion":2,
            "requestId":"r-1",
            "operation":{
                "kind":"getSessionChanges",
                "sessionId":"s-1",
                "mode":"arbitraryRefs"
            }
        }"#;
        assert!(serde_json::from_str::<CommandEnvelope>(json).is_err());
    }

    #[test]
    fn event_envelope_round_trips() {
        let env = EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_sequence: 9,
            session_revision: Some(2),
            event: Event::PermissionRequest {
                session_id: "s-1".into(),
                request_id: "perm-1".into(),
                options: vec!["allow-once".into(), "reject-once".into()],
            },
        };
        let json = serde_json::to_string(&env).expect("serialize");
        let back: EventEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(env, back);
    }

    mod version_compatibility {
        use super::super::{CommandEnvelope, Operation, PROTOCOL_VERSION, ProtocolError};

        /// The shape a browser paired before light ADR 0009 would send.
        const OLDER_LOAD_SESSION: &str = r#"{
            "protocolVersion": 2,
            "requestId": "req-1",
            "controllerEpoch": 1,
            "operation": { "kind": "loadSession", "sessionId": "s-1" }
        }"#;

        #[test]
        fn a_load_without_a_workspace_no_longer_deserialises() {
            // Light has not shipped, so nothing in the world sends this. The
            // test exists so the shape cannot drift back: a load that carries
            // no workspace must not become a usable command again.
            assert!(serde_json::from_str::<CommandEnvelope>(OLDER_LOAD_SESSION).is_err());
        }

        #[test]
        fn a_version_this_build_does_not_speak_is_refused_on_version_alone() {
            let body = r#"{
                "protocolVersion": 99,
                "requestId": "req-1",
                "controllerEpoch": 1,
                "operation": { "kind": "bootstrap" }
            }"#;
            let envelope: CommandEnvelope = serde_json::from_str(body).expect("parses");
            assert_eq!(envelope.validate(), Err(ProtocolError::UnsupportedVersion));
        }

        #[test]
        fn the_workspace_id_is_validated_like_every_other_identifier() {
            let envelope = CommandEnvelope {
                protocol_version: PROTOCOL_VERSION,
                request_id: "req-1".into(),
                idempotency_key: Some("load-1".into()),
                controller_epoch: Some(1),
                expected_revision: None,
                deadline_ms: None,
                operation: Operation::LoadSession {
                    workspace_id: "../etc".into(),
                    session_id: "s-1".into(),
                },
            };
            assert_eq!(
                envelope.validate(),
                Err(ProtocolError::MalformedId("workspaceId"))
            );
        }

        /// What a v1 browser sent to prompt: no session named.
        const V1_PROMPT: &str = r#"{
            "protocolVersion": 1,
            "requestId": "req-1",
            "idempotencyKey": "k-1",
            "controllerEpoch": 1,
            "operation": { "kind": "prompt", "text": "hi" }
        }"#;

        #[test]
        fn a_v1_prompt_no_longer_deserialises() {
            // Light ADR 0011 removed ambient addressing. A prompt that names
            // no session must not parse, or it would reach whichever
            // conversation happened to be open.
            assert!(serde_json::from_str::<CommandEnvelope>(V1_PROMPT).is_err());
        }

        #[test]
        fn every_session_scoped_operation_names_its_session() {
            // The guarantee is structural: if one of these ever became
            // parseable without a session id, ambient routing would be back.
            for body in [
                r#"{"kind":"prompt","text":"hi"}"#,
                r#"{"kind":"cancelTurn"}"#,
                r#"{"kind":"closeSession"}"#,
                r#"{"kind":"decidePermission","requestId":"p-1","optionId":"allow-once"}"#,
                r#"{"kind":"loadSession","sessionId":"s-1"}"#,
            ] {
                assert!(
                    serde_json::from_str::<Operation>(body).is_err(),
                    "must not parse without a session: {body}"
                );
            }
        }

        #[test]
        fn a_session_id_that_is_not_an_identifier_is_refused() {
            let envelope = CommandEnvelope {
                protocol_version: PROTOCOL_VERSION,
                request_id: "req-1".into(),
                idempotency_key: Some("k-1".into()),
                controller_epoch: Some(1),
                expected_revision: None,
                deadline_ms: None,
                operation: Operation::Prompt {
                    session_id: "../../etc".into(),
                    text: "hi".into(),
                    bash: false,
                },
            };
            assert_eq!(
                envelope.validate(),
                Err(ProtocolError::MalformedId("sessionId"))
            );
        }
    }
}
