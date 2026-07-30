//! Operation dispatch: the closed browser surface driving one agent session.
//!
//! This is where the recovery invariants become behaviour rather than
//! structure. Every side-effecting operation persists intent before anything
//! reaches the agent, a replayed idempotency key never dispatches twice, and
//! an ambiguous outcome terminates in `interrupted_needs_review`.
//!
//! The browser never supplies a filesystem path: `CreateSession` names an
//! enrolled workspace by opaque id and the host resolves it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::acp::{AcpError, AgentHandle};
use crate::journal::{BeginOutcome, InterruptCause, InterruptedRecord, Journal};
use crate::now_ms;
use crate::permission::{self, PermissionError};
use crate::protocol::{CommandEnvelope, Operation};
use crate::session_catalog::{self, SessionSummary};

/// Why a command could not be carried out.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DispatchError {
    /// The addressed workspace is not enrolled.
    #[error("workspace is not enrolled")]
    UnknownWorkspace,
    /// No agent session is open.
    #[error("no active agent session")]
    NoSession,
    /// A session is already open and v1 allows only one.
    #[error("an agent session is already active")]
    SessionAlreadyActive,
    /// The referenced permission request is unknown or no longer active.
    #[error("permission request is not awaiting a decision")]
    UnknownPermission,
    /// The answer referenced an option Light does not offer.
    #[error("permission option is not answerable: {0}")]
    Permission(#[from] PermissionError),
    /// The agent transport failed.
    #[error("agent transport failed")]
    Agent,
    /// The qualified CLI does not implement what was asked.
    ///
    /// Separate from [`Self::Agent`] because it is not a failure: the user's
    /// CLI is simply older or narrower than this build, and the interface
    /// should say so instead of showing an error for something that will
    /// never work until they upgrade.
    #[error("the qualified CLI does not support this")]
    Unsupported,
    /// The command was already carried out under this idempotency key.
    #[error("already completed")]
    AlreadyCompleted,
    /// The command is in flight or ambiguous and must not be retried.
    #[error("not replayable")]
    NotReplayable,
    /// A host-owned picker is already open.
    #[error("a directory picker is already open")]
    PickerAlreadyOpen,
    /// The review record is unknown, so there was nothing to acknowledge.
    #[error("review record is unknown")]
    UnknownReviewRecord,
    /// The named session is not open.
    #[error("session is not open")]
    UnknownSession,
    /// The concurrency bound is reached.
    #[error("too many sessions are open")]
    TooManySessions,
    /// The conversation is holding as many queued prompts as it may.
    #[error("too many prompts are queued")]
    QueueFull,
    /// The queue holds no such entry.
    #[error("queued prompt is no longer in the queue")]
    UnknownQueueEntry,
    /// Intent could not be made durable, so nothing was dispatched.
    ///
    /// Reported plainly because the command definitively did not run: the
    /// user may retry once the state directory is writable, and no effect is
    /// left unaccounted for in the meantime.
    #[error("intent could not be recorded, so nothing was dispatched")]
    IntentNotDurable,
}

impl DispatchError {
    /// Stable machine-readable code for the browser.
    ///
    /// Deliberately coarse: the interface needs enough to explain the refusal,
    /// and nothing that would leak a path or transport detail.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnknownWorkspace => "unknown_workspace",
            Self::NoSession => "no_session",
            Self::SessionAlreadyActive => "session_already_active",
            Self::UnknownPermission => "unknown_permission",
            Self::Permission(_) => "permission_not_answerable",
            Self::Agent => "agent_failed",
            Self::Unsupported => "unsupported",
            Self::AlreadyCompleted => "already_completed",
            Self::NotReplayable => "not_replayable",
            Self::PickerAlreadyOpen => "picker_already_open",
            Self::UnknownSession => "unknown_session",
            Self::TooManySessions => "too_many_sessions",
            Self::QueueFull => "queue_full",
            Self::UnknownQueueEntry => "unknown_queue_entry",
            Self::IntentNotDurable => "intent_not_durable",
            Self::UnknownReviewRecord => "unknown_review_record",
        }
    }
}

/// An effect the host could not confirm, as the browser sees it.
///
/// Names the operation and why it is unresolved, and nothing else. Section 7.5
/// keeps prompt, file, and tool output bodies out of a review record, so there
/// is nothing here for the interface to leak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProjection {
    /// Opaque record identifier, used to acknowledge it.
    pub record_id: String,
    /// Which operation was left unresolved.
    pub operation: &'static str,
    /// The conversation it belonged to, when it belonged to one.
    pub session_id: Option<String>,
    /// Why the host cannot say whether it took effect.
    pub cause: &'static str,
}

impl From<&InterruptedRecord> for ReviewProjection {
    fn from(record: &InterruptedRecord) -> Self {
        Self {
            record_id: record.record_id.clone(),
            operation: record.operation,
            session_id: record.session_id.clone(),
            cause: record.cause.as_str(),
        }
    }
}

/// One open session as the browser sees it.
///
/// Carries no transcript and no path: the browser addresses a session by id
/// and reads its content from the event stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjection {
    /// Agent session identifier.
    pub session_id: String,
    /// The enrolment it runs in.
    pub workspace_id: String,
    /// Label for that enrolment.
    pub workspace_name: String,
    /// Whether a turn is in flight.
    pub running: bool,
    /// Prompts waiting for that turn to finish, in the order they were sent.
    pub queued: Vec<QueuedPrompt>,
    /// Host clock when it was opened, which fixes the list order.
    pub opened_at_ms: u64,
}

/// A workspace as the browser sees it: an opaque id and a label, never a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjection {
    /// Opaque identifier.
    pub id: String,
    /// Label shown to the user.
    pub display_name: String,
    /// Whether the directory is still the one that was enrolled.
    pub available: bool,
    /// How many Grok sessions exist for this directory (0 if none / unknown).
    #[serde(default)]
    pub session_count: u64,
    /// Newest session activity timestamp when known (RFC3339 or empty).
    #[serde(default)]
    pub last_active_at: String,
}

/// A project the user enrolled in Light, projected for the project rail.
///
/// Only enrolled directories are projected (light ADR 0014), so `workspace_id`
/// is always set and the browser selects with it. Paths stay host-side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProjection {
    /// Opaque project identifier.
    pub project_id: String,
    /// Basename-oriented label; never a filesystem path.
    pub display_name: String,
    /// Sessions stored under this directory.
    pub session_count: u64,
    /// Newest session activity when known.
    pub last_active_at: String,
    /// Whether the directory still exists on disk.
    pub available: bool,
    /// The enrolment this row *is*. Always present: an unenrolled directory is
    /// not a project here (light ADR 0014).
    pub workspace_id: String,
}

/// What the host did with a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum DispatchOutcome {
    /// A read-only projection was produced.
    #[serde(rename_all = "camelCase")]
    Projection {
        /// Name of the operation that produced it.
        operation: &'static str,
    },
    /// Grok-only models and their effort levels.
    #[serde(rename_all = "camelCase")]
    Models {
        /// Grok-only models the host may offer.
        models: Vec<crate::models::ModelProjection>,
        /// Configured default when it is still in the projected list.
        #[serde(skip_serializing_if = "Option::is_none")]
        default_model_id: Option<String>,
    },
    /// Global/project MCP and skill names.
    #[serde(rename_all = "camelCase")]
    Tools {
        /// Bounded global/project MCP and skill names.
        tools: Vec<crate::tools::ToolProjection>,
    },
    /// What the user may mention, named relative to the workspace root.
    ///
    /// Relative paths only, bounded and rooted host-side (light ADR 0013).
    #[serde(rename_all = "camelCase")]
    Context {
        /// Opaque workspace the listing belongs to.
        workspace_id: String,
        /// Workspace-relative paths. Never absolute, never escaping the root.
        entries: Vec<crate::context::ContextEntry>,
    },
    /// Session-scoped model, usage, context-window, and review capabilities.
    #[serde(rename_all = "camelCase")]
    SessionInspector {
        /// Bounded information for the addressed open session.
        inspector: Box<crate::review::SessionInspectorProjection>,
    },
    /// One bounded, host-resolved change comparison.
    #[serde(rename_all = "camelCase")]
    SessionChanges {
        /// Open session the request addressed.
        session_id: String,
        /// Closed comparison the browser selected.
        mode: crate::review::ChangeMode,
        /// Absent when the CLI or repository cannot support the comparison.
        #[serde(skip_serializing_if = "Option::is_none")]
        changes: Option<crate::review::SessionChangesProjection>,
    },
    /// Model switch applied on a session.
    #[serde(rename_all = "camelCase")]
    ModelSet {
        /// Open session whose model changed.
        session_id: String,
        /// Grok model id that was applied.
        model_id: String,
        /// Optional reasoning effort applied with the model.
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
    },
    /// The enrolled workspaces, with their current availability.
    #[serde(rename_all = "camelCase")]
    Workspaces {
        /// Enrolled workspaces. Never carries a filesystem path.
        workspaces: Vec<WorkspaceProjection>,
        /// Folders that already have Grok sessions (session store), plus
        /// enrolled workspaces with no sessions yet. Never a path.
        #[serde(default)]
        projects: Vec<ProjectProjection>,
        /// Every open session, oldest first, so the list never reshuffles.
        open_sessions: Vec<SessionProjection>,
        /// MCP servers the user's Grok Build is configured with.
        ///
        /// Name and state only — never an address, a command, or a header
        /// (see `integrations`). Prefer not showing these on the project
        /// picker (see `docs/light/ui.md`).
        integrations: Vec<crate::integrations::Integration>,
        /// Effects whose outcome could not be confirmed and are still unseen.
        pending_reviews: Vec<ReviewProjection>,
    },
    /// An agent session was created.
    #[serde(rename_all = "camelCase")]
    SessionCreated {
        /// Agent session identifier.
        session_id: String,
    },
    /// Sessions available for an enrolled workspace (metadata only).
    #[serde(rename_all = "camelCase")]
    Sessions {
        /// Opaque workspace the list was scoped to.
        workspace_id: String,
        /// Newest first. Never carries a filesystem path.
        sessions: Vec<SessionSummary>,
    },
    /// A prompt was accepted and dispatched.
    #[serde(rename_all = "camelCase")]
    PromptAccepted,
    /// A host-local bash turn finished (never went through session/prompt).
    #[serde(rename_all = "camelCase")]
    BashRan {
        /// Session that owns the turn.
        session_id: String,
        /// User-visible command line (with `! ` prefix).
        display: String,
        /// Captured stdout/stderr (bounded).
        output: String,
        /// Process exit code.
        exit_code: i32,
        /// Whether the host truncated output.
        truncated: bool,
    },
    /// A prompt is waiting for the turn in flight to finish.
    #[serde(rename_all = "camelCase")]
    PromptQueued {
        /// Conversation holding it.
        session_id: String,
        /// The entry, so the browser can take it back out.
        entry_id: String,
    },
    /// The queue of one conversation changed.
    #[serde(rename_all = "camelCase")]
    QueueChanged {
        /// Conversation whose queue changed.
        session_id: String,
    },
    /// A permission answer was forwarded to the agent.
    #[serde(rename_all = "camelCase")]
    PermissionAnswered {
        /// The exact native option identifier that was sent.
        option_id: String,
    },
    /// The turn was asked to stop.
    Cancelled,
    /// The session was closed.
    Closed,
    /// A review record was acknowledged. Nothing was retried.
    Acknowledged,
    /// A host-owned directory picker was opened.
    ///
    /// The command returns here, not when the user chooses: a picker has no
    /// time bound and would otherwise hold a request open for minutes. The
    /// host emits `workspacesChanged` once a directory is enrolled.
    PickerOpened,
    /// An enrolment was given up.
    ///
    /// The durable index is updated by the caller, which then emits
    /// `workspacesChanged`, so the answer never claims a revocation that has
    /// not reached disk.
    #[serde(rename_all = "camelCase")]
    WorkspaceRemoved {
        /// The opaque identifier that no longer resolves.
        workspace_id: String,
    },
    /// Diagnosis of one session's tool-pairing history (light ADR 0015).
    #[serde(rename_all = "camelCase")]
    SessionDiagnosis {
        /// Bounded diagnosis for the browser.
        diagnosis: crate::repair::SessionDiagnosis,
    },
    /// Result of a user-opt-in history repair (dry-run or apply).
    #[serde(rename_all = "camelCase")]
    SessionRepair {
        /// Bounded report; never history bodies.
        report: crate::repair::RepairReportProjection,
    },
    /// Host/CLI product-integrity status (not a security boundary).
    #[serde(rename_all = "camelCase")]
    HostStatus {
        /// Installed CLI version when parseable.
        #[serde(skip_serializing_if = "Option::is_none")]
        cli_version: Option<String>,
        /// Whether the install meets the qualified minimum.
        cli_qualified: bool,
        /// Documented floor (e.g. `0.2.115`).
        min_cli_version: String,
        /// When the CLI could not be run or version-parsed.
        #[serde(skip_serializing_if = "Option::is_none")]
        cli_reason: Option<String>,
    },
}

/// One open agent session, as the host tracks it.
///
/// The workspace is remembered because every session belongs to exactly one
/// enrolment, and the browser only ever names the session: resolving back to a
/// directory stays here (light ADR 0009).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSession {
    /// Agent session identifier.
    pub id: String,
    /// The enrolment this session runs in.
    pub workspace_id: String,
    /// Label for the workspace, so a list needs no second lookup.
    pub workspace_name: String,
    /// Whether a turn is in flight right now.
    pub running: bool,
    /// Prompts waiting for the turn in flight to finish.
    ///
    /// The agent queues a mid-turn prompt itself, so Light holds its own and
    /// only ever sends when the session is idle. Sending anyway would queue
    /// the same message twice, and an agent-side queue is one Light cannot
    /// show the user or let them take a message out of.
    pub queued: Vec<QueuedPrompt>,
    /// Host clock when the session was opened, for a stable list order.
    pub opened_at_ms: u64,
}

/// A prompt waiting for its turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedPrompt {
    /// Identifier the browser uses to take it back out.
    pub entry_id: String,
    /// The text as the user wrote it.
    pub text: String,
}

/// A permission request the agent is waiting on.
#[derive(Debug, Clone)]
pub struct PendingPermission {
    /// JSON-RPC id the answer must carry.
    pub request_id: serde_json::Value,
    /// Session that raised the request, so an answer cannot be applied to a
    /// request the user was shown in a different conversation.
    pub session_id: String,
    /// Exactly the option identifiers the agent offered.
    pub offered: Vec<String>,
}

/// An enrolled workspace. The browser only ever sees `id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// Opaque identifier handed to the browser.
    pub id: String,
    /// Label shown to the user.
    pub display_name: String,
    /// Canonical host-resolved path. Never crosses the protocol.
    pub path: PathBuf,
}

/// Everything dispatch needs that is not the journal.
#[derive(Debug, Default)]
pub struct SessionState {
    /// Enrolled workspaces, keyed by opaque id.
    pub workspaces: HashMap<String, Workspace>,
    /// Live agent sessions, keyed by agent session id (light ADR 0011).
    ///
    /// Sessions run concurrently on one agent process, so the host tracks a
    /// set rather than a slot. Nothing here is ambient: an operation names the
    /// session it addresses.
    pub sessions: HashMap<String, LiveSession>,
    /// Ephemeral review/context state, keyed by open agent session id.
    ///
    /// Patch bodies are never persisted and are dropped with the session.
    pub reviews: HashMap<String, crate::review::SessionReviewState>,
    /// Transcript + tools to push after a successful `LoadSession`, once the
    /// command response is on the wire. Taken by the HTTP layer.
    pub pending_rehydrate: Option<session_catalog::RehydratedSession>,
    /// Permission requests awaiting a decision, keyed by request id.
    pub pending_permissions: HashMap<String, PendingPermission>,
    /// Counter behind queue entry ids, so two entries never collide.
    pub next_queue_entry: u64,
    /// Whether a host-owned picker is currently open.
    ///
    /// One at a time: a second request must not stack dialogs on the user's
    /// desktop.
    pub picker_open: bool,
}

impl SessionState {
    /// Enrol a workspace the host resolved itself.
    pub fn enrol(&mut self, workspace: Workspace) {
        self.workspaces.insert(workspace.id.clone(), workspace);
    }

    /// Replace the enrolment set from the host's durable index.
    pub fn replace_workspaces(&mut self, workspaces: impl IntoIterator<Item = Workspace>) {
        self.workspaces = workspaces
            .into_iter()
            .map(|workspace| (workspace.id.clone(), workspace))
            .collect();
    }

    /// Project the enrolment set for the browser.
    ///
    /// Availability is re-read now, so a directory that was swapped or removed
    /// since enrolment is shown as unavailable instead of failing only when a
    /// session is started.
    #[must_use]
    pub fn project_workspaces(&self) -> Vec<WorkspaceProjection> {
        let mut projected: Vec<WorkspaceProjection> = self
            .workspaces
            .values()
            .map(|workspace| {
                let sessions = session_catalog::list_for_cwd(&workspace.path);
                let last_active_at = sessions
                    .first()
                    .map(|session| session.updated_at.clone())
                    .unwrap_or_default();
                WorkspaceProjection {
                    id: workspace.id.clone(),
                    display_name: workspace.display_name.clone(),
                    available: workspace.path.is_dir(),
                    session_count: sessions.len() as u64,
                    last_active_at,
                }
            })
            .collect();
        projected.sort_by(|left, right| left.id.cmp(&right.id));
        projected
    }

    /// Enrolled projects, enriched with their session-store activity.
    ///
    /// Only directories the user opened in Light are projected (light ADR
    /// 0014). The session store is still read, but as an *attribute lookup*
    /// for rows the enrolment set already authorises — never as the source of
    /// the list. A directory the user only ever used in the Grok Build CLI or
    /// TUI is therefore absent, and its display name never reaches the
    /// browser.
    #[must_use]
    pub fn project_projects(&self) -> Vec<ProjectProjection> {
        self.project_projects_in(&session_catalog::grok_home())
    }

    /// Same as [`Self::project_projects`] with an explicit Grok home.
    #[must_use]
    pub fn project_projects_in(&self, home: &Path) -> Vec<ProjectProjection> {
        let mut activity: HashMap<PathBuf, session_catalog::ProjectGroup> =
            session_catalog::list_project_groups_in(home)
                .into_iter()
                .map(|group| (group.path.clone(), group))
                .collect();

        let mut projected: Vec<ProjectProjection> = self
            .workspaces
            .values()
            .map(|workspace| {
                // An enrolled directory with no session history still appears,
                // so Add → Open works before the first conversation exists.
                let group = activity.remove(&workspace.path);
                ProjectProjection {
                    project_id: session_catalog::project_id_for_path(&workspace.path),
                    // The enrolment's own label wins: it is what the user saw
                    // when they chose the directory.
                    display_name: workspace.display_name.clone(),
                    session_count: group.as_ref().map_or(0, |group| group.session_count),
                    last_active_at: group.map(|group| group.last_active_at).unwrap_or_default(),
                    available: workspace.path.is_dir(),
                    workspace_id: workspace.id.clone(),
                }
            })
            .collect();

        projected.sort_by(|left, right| {
            right
                .last_active_at
                .cmp(&left.last_active_at)
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        projected
    }

    /// Open a session, refusing once the concurrency bound is reached.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::TooManySessions`] when the bound is reached.
    pub fn open_session(&mut self, session: LiveSession) -> Result<(), DispatchError> {
        if !self.sessions.contains_key(&session.id)
            && self.sessions.len() >= crate::bounds::MAX_LIVE_SESSIONS
        {
            return Err(DispatchError::TooManySessions);
        }
        self.reviews.entry(session.id.clone()).or_default();
        self.sessions.insert(session.id.clone(), session);
        Ok(())
    }

    /// Resolve a session the browser named, or refuse.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] when the id is not open.
    pub fn session(&self, session_id: &str) -> Result<&LiveSession, DispatchError> {
        self.sessions
            .get(session_id)
            .ok_or(DispatchError::UnknownSession)
    }

    /// Forget a session and every permission request it raised.
    ///
    /// Closing must not leave the agent waiting on a decision that can no
    /// longer be answered, and must not leave a stale request answerable
    /// against a session that is gone.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] when the id is not open.
    pub fn close_session(&mut self, session_id: &str) -> Result<(), DispatchError> {
        if self.sessions.remove(session_id).is_none() {
            return Err(DispatchError::UnknownSession);
        }
        self.reviews.remove(session_id);
        self.pending_permissions
            .retain(|_, pending| pending.session_id != session_id);
        Ok(())
    }

    /// Mark whether a session has a turn in flight.
    pub fn set_running(&mut self, session_id: &str, running: bool) {
        if let Some(session) = self.sessions.get_mut(session_id) {
            session.running = running;
        }
    }

    /// Resolve the host-owned inputs needed by a read-only review request.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] or
    /// [`DispatchError::UnknownWorkspace`] when the in-memory binding no
    /// longer resolves.
    pub fn review_snapshot(
        &self,
        session_id: &str,
    ) -> Result<(PathBuf, crate::review::SessionReviewState), DispatchError> {
        let live = self.session(session_id)?;
        let workspace = self
            .workspaces
            .get(&live.workspace_id)
            .ok_or(DispatchError::UnknownWorkspace)?;
        let review = self.reviews.get(session_id).cloned().unwrap_or_default();
        Ok((workspace.path.clone(), review))
    }

    /// Begin collecting agent-reported changes for one new turn.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] when the session is not open.
    pub fn begin_review_turn(&mut self, session_id: &str) -> Result<(), DispatchError> {
        self.session(session_id)?;
        self.reviews
            .entry(session_id.to_owned())
            .or_default()
            .begin_turn();
        Ok(())
    }

    /// Finish a turn and retain bounded usage from its prompt result.
    pub fn finish_review_turn(&mut self, session_id: &str, result: Option<&serde_json::Value>) {
        if let Some(review) = self.reviews.get_mut(session_id) {
            review.finish_turn(result);
        }
    }

    /// Mark a turn's exact file attribution as incomplete.
    pub fn interrupt_review_turn(&mut self, session_id: &str) {
        if let Some(review) = self.reviews.get_mut(session_id) {
            review.interrupt_turn();
        }
    }

    /// Fold one raw ACP update into the addressed session's ephemeral state.
    pub fn capture_review_update(
        &mut self,
        session_id: &str,
        params: &serde_json::Value,
    ) -> crate::review::CaptureResult {
        let Some(live) = self.sessions.get(session_id) else {
            return crate::review::CaptureResult::default();
        };
        let Some(root) = self
            .workspaces
            .get(&live.workspace_id)
            .map(|workspace| workspace.path.clone())
        else {
            return crate::review::CaptureResult::default();
        };
        self.reviews
            .entry(session_id.to_owned())
            .or_default()
            .capture_update(&root, params)
    }

    /// Retain standard ACP metadata returned while opening a session.
    pub fn capture_review_open_result(&mut self, session_id: &str, result: &serde_json::Value) {
        if let Some(review) = self.reviews.get_mut(session_id) {
            review.capture_open_result(result);
        }
    }

    /// Keep the inspector model in sync with a successful host-initiated switch.
    pub fn set_review_model(&mut self, session_id: &str, model_id: &str) {
        if let Some(review) = self.reviews.get_mut(session_id) {
            review.set_model(model_id);
        }
    }

    /// Hold a prompt until the turn in flight finishes.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] when the id is not open, and
    /// [`DispatchError::QueueFull`] once the bound is reached.
    pub fn queue_prompt(&mut self, session_id: &str, text: &str) -> Result<String, DispatchError> {
        let next = self.next_queue_entry.saturating_add(1);
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DispatchError::UnknownSession)?;
        if session.queued.len() >= crate::bounds::MAX_QUEUED_PROMPTS {
            return Err(DispatchError::QueueFull);
        }
        let entry_id = format!("q-{next}");
        session.queued.push(QueuedPrompt {
            entry_id: entry_id.clone(),
            text: text.to_owned(),
        });
        self.next_queue_entry = next;
        Ok(entry_id)
    }

    /// Take the next queued prompt, if the session is idle and has one.
    ///
    /// Only an idle session drains: the agent queues a mid-turn prompt itself,
    /// so sending one now would put the same message in two queues.
    pub fn take_queued(&mut self, session_id: &str) -> Option<QueuedPrompt> {
        let session = self.sessions.get_mut(session_id)?;
        if session.running {
            return None;
        }
        if session.queued.is_empty() {
            return None;
        }
        Some(session.queued.remove(0))
    }

    /// Drop a queued prompt before it runs.
    ///
    /// # Errors
    ///
    /// Returns [`DispatchError::UnknownSession`] when the session is not open,
    /// and [`DispatchError::UnknownQueueEntry`] when it holds no such entry.
    pub fn remove_queued(&mut self, session_id: &str, entry_id: &str) -> Result<(), DispatchError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(DispatchError::UnknownSession)?;
        let before = session.queued.len();
        session.queued.retain(|entry| entry.entry_id != entry_id);
        if session.queued.len() == before {
            return Err(DispatchError::UnknownQueueEntry);
        }
        Ok(())
    }

    /// Open sessions paired with the directory each runs in.
    ///
    /// A session whose workspace is no longer enrolled is left out: the
    /// enrolment is the grant, so a revoked directory must not be read even to
    /// restore a transcript.
    #[must_use]
    pub fn sessions_to_replay(&self) -> Vec<(String, PathBuf)> {
        let mut pairs: Vec<(String, PathBuf)> = self
            .sessions
            .values()
            .filter_map(|live| {
                let workspace = self.workspaces.get(&live.workspace_id)?;
                Some((live.id.clone(), workspace.path.clone()))
            })
            .collect();
        pairs.sort_by(|left, right| left.0.cmp(&right.0));
        pairs
    }

    /// Project open sessions for the browser, in a stable order.
    ///
    /// Ordered by when each was opened so activity never reshuffles the list:
    /// a row keeps its place from the moment it appears until it is closed.
    #[must_use]
    pub fn project_sessions(&self) -> Vec<SessionProjection> {
        let mut projected: Vec<SessionProjection> = self
            .sessions
            .values()
            .map(|session| SessionProjection {
                session_id: session.id.clone(),
                workspace_id: session.workspace_id.clone(),
                workspace_name: session.workspace_name.clone(),
                running: session.running,
                queued: session.queued.clone(),
                opened_at_ms: session.opened_at_ms,
            })
            .collect();
        projected.sort_by(|left, right| {
            left.opened_at_ms
                .cmp(&right.opened_at_ms)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        projected
    }

    /// Record a permission request the agent opened.
    pub fn open_permission(&mut self, request_id: &str, pending: PendingPermission) {
        self.pending_permissions
            .insert(request_id.to_owned(), pending);
    }
}

/// Carry out one validated command.
///
/// The envelope has already passed schema, bounds, pairing, CSRF, and lease
/// checks. This applies the recovery invariants and drives the agent.
///
/// # Errors
///
/// Returns the reason the command could not be carried out. A journal state
/// that forbids replay is reported as such rather than silently retried.
pub async fn dispatch(
    envelope: &CommandEnvelope,
    journal: &mut Journal,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    // Intent before effect. A key that is already known never dispatches.
    if let Some(key) = &envelope.idempotency_key
        && envelope.operation.has_side_effect()
    {
        match journal.begin(
            key,
            envelope.operation.name(),
            addressed_session_of(&envelope.operation).map(String::as_str),
        ) {
            BeginOutcome::Dispatch => {}
            BeginOutcome::AlreadyCompleted => return Err(DispatchError::AlreadyCompleted),
            BeginOutcome::DoNotReplay(_) => return Err(DispatchError::NotReplayable),
            BeginOutcome::NotDurable => return Err(DispatchError::IntentNotDurable),
        }
    }

    let key = envelope.idempotency_key.clone();
    let result = run(envelope, journal, state, agent).await;

    // Classify the outcome exactly once, while the turn is still fresh.
    if let Some(key) = key
        && envelope.operation.has_side_effect()
    {
        match &result {
            Ok(_) => {
                let _ = journal.complete(&key);
            }
            Err(DispatchError::Agent) => {
                // The agent failed after intent was durable: the effect may or
                // may not have landed, so it is left for review, never retried.
                let _ = journal.interrupt(&key, InterruptCause::AgentExit);
            }
            Err(_) => {
                // Refused before anything reached the agent: no effect, so the
                // record is closed rather than left open for review.
                let _ = journal.complete(&key);
            }
        }
    }
    result
}

/// Project what the user may mention with `@` (light ADR 0013).
///
/// Resolved host-side at the moment of use, from the opaque id the browser
/// sent (light ADR 0009). A workspace that no longer resolves is refused
/// rather than coerced to a nearby path.
fn list_context(
    state: &SessionState,
    workspace_id: &str,
    query: Option<&str>,
) -> Result<DispatchOutcome, DispatchError> {
    let workspace = state
        .workspaces
        .get(workspace_id)
        .ok_or(DispatchError::UnknownWorkspace)?;
    Ok(DispatchOutcome::Context {
        workspace_id: workspace_id.to_owned(),
        entries: crate::context::list_context(&workspace.path, query),
    })
}

async fn run(
    envelope: &CommandEnvelope,
    journal: &mut Journal,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    match &envelope.operation {
        // The browser's first call, and the one it repeats to refresh: both
        // answer with the enrolment set and whether a session is open.
        Operation::Bootstrap | Operation::ListWorkspaces => Ok(project_state(journal, state)),

        // Enrolment of a session-store project is handled by the HTTP layer
        // (needs durable WorkspaceIndex). Pure dispatch refuses if reached.
        Operation::OpenProject { .. } => Err(DispatchError::UnknownWorkspace),

        Operation::GetHostStatus => Ok(project_host_status()),

        // Sessions live in the user's Grok store. ACP session/list is not
        // implemented on the qualified CLI, so the host reads summary metadata
        // for this workspace's cwd (light ADR 0010).
        Operation::ListSessions { workspace_id } => {
            let workspace = state
                .workspaces
                .get(workspace_id)
                .ok_or(DispatchError::UnknownWorkspace)?;
            let sessions = session_catalog::list_for_cwd(&workspace.path);
            Ok(DispatchOutcome::Sessions {
                workspace_id: workspace_id.clone(),
                sessions,
            })
        }

        Operation::CreateSession { workspace_id } => {
            create_session(workspace_id, state, agent).await
        }

        Operation::SendNow {
            session_id,
            text,
            bash,
        } => send_now(session_id, text, *bash, state, agent).await,

        Operation::Prompt {
            session_id,
            text,
            bash,
        } => {
            // The session is resolved before the agent is touched, so a prompt
            // for a session that is not open never reaches the child.
            let live = state.session(session_id)?;
            let is_bash = *bash || text.trim_start().starts_with('!');
            let wire = bash_wire_text(text, is_bash);
            if is_bash {
                // Bang mode is host-local shell in the workspace cwd — never
                // session/prompt (CLI pager semantics).
                if live.running {
                    let entry_id = state.queue_prompt(session_id, &wire)?;
                    return Ok(DispatchOutcome::PromptQueued {
                        session_id: session_id.clone(),
                        entry_id,
                    });
                }
                return run_bash_turn(session_id, &wire, state);
            }
            if live.running {
                let entry_id = state.queue_prompt(session_id, &wire)?;
                return Ok(DispatchOutcome::PromptQueued {
                    session_id: session_id.clone(),
                    entry_id,
                });
            }
            let agent = agent.ok_or(DispatchError::NoSession)?;
            state.begin_review_turn(session_id)?;
            let sent = agent.prompt(session_id, &wire).await;
            match &sent {
                Ok(result) => state.finish_review_turn(session_id, Some(result)),
                Err(_) => state.interrupt_review_turn(session_id),
            }
            sent.map_err(|error| map_agent_error(&error))?;
            Ok(DispatchOutcome::PromptAccepted)
        }

        Operation::ListModels => Ok(DispatchOutcome::Models {
            models: crate::models::list_models(),
            default_model_id: crate::models::default_model_id(),
        }),

        Operation::ListContext {
            workspace_id,
            query,
        } => list_context(state, workspace_id, query.as_deref()),
        Operation::GetSessionInspector { session_id } => {
            let (root, local) = state.review_snapshot(session_id)?;
            Ok(DispatchOutcome::SessionInspector {
                inspector: Box::new(
                    crate::review::inspect_session(session_id, &root, &local).await,
                ),
            })
        }
        Operation::GetSessionChanges { session_id, mode } => {
            let (root, local) = state.review_snapshot(session_id)?;
            Ok(DispatchOutcome::SessionChanges {
                session_id: session_id.clone(),
                mode: *mode,
                changes: crate::review::collect_changes(session_id, &root, *mode, &local).await,
            })
        }
        Operation::ListTools { workspace_id } => {
            let cwd = workspace_id.as_ref().and_then(|id| {
                state
                    .workspaces
                    .get(id)
                    .map(|workspace| workspace.path.as_path())
            });
            Ok(DispatchOutcome::Tools {
                tools: crate::tools::list_tools_for_cwd(cwd),
            })
        }

        Operation::SetSessionModel {
            session_id,
            model_id,
            reasoning_effort,
        } => {
            state.session(session_id)?;
            if !crate::models::is_grok_model_id(model_id) {
                return Err(DispatchError::Unsupported);
            }
            let agent = agent.ok_or(DispatchError::NoSession)?;
            agent
                .set_session_model(session_id, model_id, reasoning_effort.as_deref())
                .await
                .map_err(|error| map_agent_error(&error))?;
            state.set_review_model(session_id, model_id);
            Ok(DispatchOutcome::ModelSet {
                session_id: session_id.clone(),
                model_id: model_id.clone(),
                reasoning_effort: reasoning_effort.clone(),
            })
        }

        Operation::DecidePermission {
            session_id,
            request_id,
            option_id,
        } => decide_permission(session_id, request_id, option_id, state, agent).await,

        Operation::CancelTurn { session_id } => {
            state.session(session_id)?;
            let agent = agent.ok_or(DispatchError::NoSession)?;
            agent
                .cancel(session_id)
                .await
                .map_err(|error| map_agent_error(&error))?;
            state.interrupt_review_turn(session_id);
            Ok(DispatchOutcome::Cancelled)
        }

        Operation::CloseSession { session_id } => {
            // Closing denies anything the agent is still waiting on in this
            // session rather than leaving a grant alive in its memory, and
            // leaves every other session untouched.
            state.close_session(session_id)?;
            Ok(DispatchOutcome::Closed)
        }

        Operation::OpenWorkspacePicker => {
            if state.picker_open {
                return Err(DispatchError::PickerAlreadyOpen);
            }
            // The caller opens the portal; dispatch only records that one is
            // open so a second request cannot stack dialogs.
            state.picker_open = true;
            Ok(DispatchOutcome::PickerOpened)
        }

        // Revocation must be refused when it would not revoke anything, so an
        // unknown id is an error rather than a success the user would read as
        // the directory having been given up.
        Operation::RemoveWorkspace { workspace_id } => {
            if !state.workspaces.contains_key(workspace_id) {
                return Err(DispatchError::UnknownWorkspace);
            }
            state.workspaces.remove(workspace_id);
            Ok(DispatchOutcome::WorkspaceRemoved {
                workspace_id: workspace_id.clone(),
            })
        }

        // Acknowledging says the user has seen it. It never retries the
        // effect and never claims the effect did or did not happen.
        Operation::AcknowledgeInterrupted { record_id } => {
            journal
                .acknowledge_interrupted(record_id)
                .map_err(|_| DispatchError::UnknownReviewRecord)?;
            Ok(DispatchOutcome::Acknowledged)
        }

        // Resuming needs a directory, and it comes from the enrolment the id
        // names — revalidated here, not remembered from when the session was
        // created. A workspace the user has since given up cannot be reached
        // by resuming a session that once ran in it.
        Operation::LoadSession {
            workspace_id,
            session_id,
        } => load_session(workspace_id, session_id, state, agent).await,

        Operation::RemoveQueued {
            session_id,
            entry_id,
        } => {
            state.remove_queued(session_id, entry_id)?;
            Ok(DispatchOutcome::QueueChanged {
                session_id: session_id.clone(),
            })
        }

        Operation::DiagnoseSession { session_id } => {
            diagnose_or_repair(session_id, true, state, agent).await
        }
        Operation::RepairSession {
            session_id,
            dry_run,
        } => diagnose_or_repair(session_id, *dry_run, state, agent).await,

        Operation::AcknowledgeEvents { .. } | Operation::RevokeBrowserPairing { .. } => {
            Ok(DispatchOutcome::Acknowledged)
        }
    }
}

/// Product-integrity view of the installed Grok Build CLI.
fn project_host_status() -> DispatchOutcome {
    use crate::cli_matrix::{self, CliQualification, MIN_QUALIFIED_CLI_LABEL};
    match cli_matrix::qualify_default() {
        CliQualification::Known {
            version,
            meets_minimum,
        } => DispatchOutcome::HostStatus {
            cli_version: Some(version),
            cli_qualified: meets_minimum,
            min_cli_version: MIN_QUALIFIED_CLI_LABEL.to_owned(),
            cli_reason: None,
        },
        CliQualification::Unavailable { reason } => DispatchOutcome::HostStatus {
            cli_version: None,
            cli_qualified: false,
            min_cli_version: MIN_QUALIFIED_CLI_LABEL.to_owned(),
            cli_reason: Some(reason),
        },
    }
}

/// Diagnose (dry-run) or apply history repair for an open session.
///
/// Never invents a healthy report on Unsupported. Apply path is journaled by
/// the outer dispatch when `dry_run` is false (`has_side_effect`).
async fn diagnose_or_repair(
    session_id: &str,
    dry_run: bool,
    state: &SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    state.session(session_id)?;
    let agent = agent.ok_or(DispatchError::NoSession)?;
    match crate::repair::repair_session(agent, session_id, dry_run).await {
        Ok(report) => {
            if dry_run {
                Ok(DispatchOutcome::SessionDiagnosis {
                    diagnosis: crate::repair::SessionDiagnosis {
                        session_id: session_id.to_owned(),
                        status: crate::repair::diagnosis_from_report(&report),
                        report: Some(report),
                    },
                })
            } else {
                Ok(DispatchOutcome::SessionRepair { report })
            }
        }
        Err(error) if error.is_unsupported_method() => {
            if dry_run {
                Ok(DispatchOutcome::SessionDiagnosis {
                    diagnosis: crate::repair::SessionDiagnosis {
                        session_id: session_id.to_owned(),
                        status: crate::repair::DiagnosisStatus::Unsupported,
                        report: None,
                    },
                })
            } else {
                Err(DispatchError::Unsupported)
            }
        }
        Err(error) => Err(map_agent_error(&error)),
    }
}

/// The session an operation addresses, when it addresses one.
///
/// Recorded with the intent so an interruption can name the conversation it
/// belonged to, long after the command itself is gone.
const fn addressed_session_of(operation: &Operation) -> Option<&String> {
    match operation {
        Operation::Prompt { session_id, .. }
        | Operation::CancelTurn { session_id }
        | Operation::CloseSession { session_id }
        | Operation::DecidePermission { session_id, .. }
        | Operation::LoadSession { session_id, .. }
        | Operation::DiagnoseSession { session_id }
        | Operation::RepairSession { session_id, .. } => Some(session_id),
        _ => None,
    }
}

/// The picture the browser refreshes against: enrolments, session, reviews.
///
/// The review records ride along on every refresh rather than being fetched
/// once, because an effect nobody confirmed has to stay in front of the user
/// until they say they have seen it.
fn project_state(journal: &Journal, state: &SessionState) -> DispatchOutcome {
    DispatchOutcome::Workspaces {
        workspaces: state.project_workspaces(),
        projects: state.project_projects(),
        open_sessions: state.project_sessions(),
        integrations: crate::integrations::list(),
        pending_reviews: journal
            .pending_reviews()
            .into_iter()
            .map(ReviewProjection::from)
            .collect(),
    }
}

/// Resume a session inside the workspace the caller named.
///
/// Split out of `run` to keep the resolution visible: the directory comes from
/// the enrolment that exists now, so a workspace the user has given up cannot
/// be reached by resuming a session that once ran in it (light ADR 0009).
async fn load_session(
    workspace_id: &str,
    session_id: &str,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    // Resuming a session that is already open is a no-op the browser can
    // reach by double-clicking a row, so it is refused rather than opening a
    // second copy of the same conversation.
    if state.sessions.contains_key(session_id) {
        return Err(DispatchError::SessionAlreadyActive);
    }
    let workspace = state
        .workspaces
        .get(workspace_id)
        .ok_or(DispatchError::UnknownWorkspace)?
        .clone();
    let path = workspace.path.clone();
    let agent = agent.ok_or(DispatchError::NoSession)?;
    let open_result = agent
        .load_session(session_id, &path)
        .await
        .map_err(|error| map_agent_error(&error))?;
    state.open_session(LiveSession {
        id: session_id.to_owned(),
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.display_name.clone(),
        running: false,
        queued: Vec::new(),
        opened_at_ms: now_ms(),
    })?;
    state.capture_review_open_result(session_id, &open_result);
    // The browser needs the prior transcript; ACP load does not stream it
    // back as light events, so the host rehydrates from updates.jsonl.
    state.pending_rehydrate = Some(session_catalog::rehydrate_session(&path, session_id));
    Ok(DispatchOutcome::SessionCreated {
        session_id: session_id.to_owned(),
    })
}

/// Open a new conversation in an enrolled workspace.
async fn create_session(
    workspace_id: &str,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    let workspace = state
        .workspaces
        .get(workspace_id)
        .ok_or(DispatchError::UnknownWorkspace)?
        .clone();
    let agent = agent.ok_or(DispatchError::NoSession)?;
    let (session_id, open_result) = agent
        .new_session(&workspace.path)
        .await
        .map_err(|error| map_agent_error(&error))?;
    state.open_session(LiveSession {
        id: session_id.clone(),
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.display_name.clone(),
        running: false,
        queued: Vec::new(),
        opened_at_ms: now_ms(),
    })?;
    state.capture_review_open_result(&session_id, &open_result);
    Ok(DispatchOutcome::SessionCreated { session_id })
}

/// Stop what is running so this message goes next.
///
/// The meaning the qualified CLI gives `Ctrl+Enter`: it does not jump the
/// queue, it clears the way. Split out of `run` so the two agent calls and the
/// state they sit between stay legible.
async fn send_now(
    session_id: &str,
    text: &str,
    bash: bool,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    state.session(session_id)?;
    let is_bash = bash || text.trim_start().starts_with('!');
    let wire = bash_wire_text(text, is_bash);
    if let Some(agent) = agent {
        agent
            .cancel(session_id)
            .await
            .map_err(|error| map_agent_error(&error))?;
        state.interrupt_review_turn(session_id);
    }
    state.set_running(session_id, false);
    if is_bash {
        return run_bash_turn(session_id, &wire, state);
    }
    let agent = agent.ok_or(DispatchError::NoSession)?;
    state.begin_review_turn(session_id)?;
    let sent = agent.prompt(session_id, &wire).await;
    match &sent {
        Ok(result) => state.finish_review_turn(session_id, Some(result)),
        Err(_) => state.interrupt_review_turn(session_id),
    }
    sent.map_err(|error| map_agent_error(&error))?;
    Ok(DispatchOutcome::PromptAccepted)
}

/// Run a host-local shell turn in the session workspace. Never touches ACP.
fn run_bash_turn(
    session_id: &str,
    wire: &str,
    state: &mut SessionState,
) -> Result<DispatchOutcome, DispatchError> {
    let path = {
        let live = state.session(session_id)?;
        state
            .workspaces
            .get(&live.workspace_id)
            .ok_or(DispatchError::UnknownWorkspace)?
            .path
            .clone()
    };
    state.begin_review_turn(session_id)?;
    let result = crate::bash::run_in_cwd(&path, wire);
    state.interrupt_review_turn(session_id);
    let result = result.map_err(|error| match error {
        crate::bash::BashError::EmptyCommand => DispatchError::Unsupported,
        crate::bash::BashError::BadCwd => DispatchError::UnknownWorkspace,
    })?;
    Ok(DispatchOutcome::BashRan {
        session_id: session_id.to_owned(),
        display: format!("! {}", result.command),
        output: result.output,
        exit_code: result.exit_code,
        truncated: result.truncated,
    })
}

/// Normalise bash-mode text so queue and host shell share one shape (`! cmd`).
fn bash_wire_text(text: &str, bash: bool) -> String {
    if !bash {
        return text.to_owned();
    }
    let command = crate::bash::strip_bang(text);
    format!("! {command}")
}

/// Answer a permission request the agent is waiting on.
///
/// Split out of `run` so the re-check stays legible: the option is validated
/// against what the agent actually offered before anything reaches it.
async fn decide_permission(
    session_id: &str,
    request_id: &str,
    option_id: &str,
    state: &mut SessionState,
    agent: Option<&Arc<AgentHandle>>,
) -> Result<DispatchOutcome, DispatchError> {
    let pending = state
        .pending_permissions
        .get(request_id)
        .ok_or(DispatchError::UnknownPermission)?
        .clone();
    // The request must belong to the session the browser named. With several
    // conversations open, answering by request id alone would let a decision
    // the user made in one land on a prompt raised by another.
    if pending.session_id != session_id {
        return Err(DispatchError::UnknownPermission);
    }
    // The host re-checks that the option was actually offered and is one
    // Light may answer, so a crafted body cannot reach the agent.
    permission::authorize_answer(&pending.offered, option_id)?;
    let agent = agent.ok_or(DispatchError::NoSession)?;
    agent
        .answer_permission(&pending.request_id, option_id)
        .await
        .map_err(|error| map_agent_error(&error))?;
    state.pending_permissions.remove(request_id);
    Ok(DispatchOutcome::PermissionAnswered {
        option_id: option_id.to_owned(),
    })
}

/// Reduce an agent failure to what the browser may be told.
///
/// Transport detail still collapses to one opaque outcome, so no path, pipe,
/// or timing information reaches the browser. The single exception is a method
/// the qualified CLI does not implement: that says nothing about the machine,
/// and withholding it would leave the user retrying a feature their CLI will
/// never have.
fn map_agent_error(error: &AcpError) -> DispatchError {
    if error.is_unsupported_method() {
        return DispatchError::Unsupported;
    }
    DispatchError::Agent
}

#[cfg(test)]
mod tests {
    use super::{
        DispatchError, DispatchOutcome, LiveSession, PendingPermission, SessionState, Workspace,
        dispatch,
    };
    use crate::journal::{EffectState, Journal};
    use crate::protocol::{CommandEnvelope, Operation, PROTOCOL_VERSION};

    fn envelope(operation: Operation, key: Option<&str>) -> CommandEnvelope {
        CommandEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: "req-1".into(),
            idempotency_key: key.map(str::to_owned),
            controller_epoch: Some(1),
            expected_revision: None,
            deadline_ms: None,
            operation,
        }
    }

    fn live_session(id: &str) -> LiveSession {
        LiveSession {
            id: id.to_owned(),
            workspace_id: "w-1".into(),
            workspace_name: "Demo".into(),
            running: false,
            queued: Vec::new(),
            opened_at_ms: 1,
        }
    }

    fn state_with_workspace() -> SessionState {
        let mut state = SessionState::default();
        state.enrol(Workspace {
            id: "w-1".into(),
            display_name: "Demo".into(),
            path: std::env::temp_dir(),
        });
        state
    }

    #[tokio::test]
    async fn bash_prompt_never_requires_agent_and_returns_local_output() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-bash-dispatch-{stamp}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(root.join("hello.txt"), "from-cwd").expect("write");

        let mut journal = Journal::new();
        let mut state = SessionState::default();
        state.enrol(Workspace {
            id: "ws-1".into(),
            display_name: "proj".into(),
            path: root.clone(),
        });
        state
            .open_session(LiveSession {
                id: "s-1".into(),
                workspace_id: "ws-1".into(),
                workspace_name: "proj".into(),
                running: false,
                queued: Vec::new(),
                opened_at_ms: 1,
            })
            .expect("open");

        // No agent: if bash called session/prompt it would return NoSession.
        let outcome = dispatch(
            &envelope(
                Operation::Prompt {
                    session_id: "s-1".into(),
                    text: "! cat hello.txt".into(),
                    bash: true,
                },
                Some("bash-k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await
        .expect("bash should not need agent");

        match outcome {
            DispatchOutcome::BashRan {
                session_id,
                display,
                output,
                exit_code,
                ..
            } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(display, "! cat hello.txt");
                assert!(output.contains("from-cwd"), "output={output}");
                assert_eq!(exit_code, 0);
                assert!(!output.contains("bash_command"));
            }
            other => panic!("expected BashRan, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn ordinary_prompt_still_requires_agent() {
        let mut journal = Journal::new();
        let mut state = state_with_workspace();
        state.open_session(live_session("s-1")).expect("open");
        let err = dispatch(
            &envelope(
                Operation::Prompt {
                    session_id: "s-1".into(),
                    text: "hello agent".into(),
                    bash: false,
                },
                Some("chat-k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await
        .expect_err("chat needs agent");
        assert_eq!(err, DispatchError::NoSession);
    }

    /// Lay down a Grok session group the way the CLI does, under `root`.
    fn write_session(root: &std::path::Path, cwd: &std::path::Path, id: &str, updated_at: &str) {
        let group = root
            .join("sessions")
            .join(crate::session_catalog::encode_cwd_dirname(
                cwd.to_string_lossy().as_ref(),
            ));
        let dir = group.join(id);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let summary = serde_json::json!({
            "info": { "id": id, "cwd": cwd.to_string_lossy() },
            "session_summary": id,
            "updated_at": updated_at,
            "num_messages": 2,
        });
        std::fs::write(dir.join("summary.json"), summary.to_string()).expect("summary");
        std::fs::write(dir.join("updates.jsonl"), "").expect("updates");
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-{label}-{stamp}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        root
    }

    #[test]
    fn project_projections_omit_a_directory_only_the_cli_ever_opened() {
        // The rail is the set of projects opened in Light, not an inventory of
        // GROK_HOME (light ADR 0014). A folder the user only ever worked in
        // from the Grok Build CLI must not even have its name disclosed.
        let root = scratch("proj-enrolled-only");
        let enrolled = root.join("mine");
        let cli_only = root.join("theirs");
        std::fs::create_dir_all(&enrolled).expect("cwd");
        std::fs::create_dir_all(&cli_only).expect("cwd");
        write_session(&root, &enrolled, "s-1", "2026-07-29T12:00:00Z");
        write_session(&root, &cli_only, "s-2", "2026-07-30T12:00:00Z");

        let mut state = SessionState::default();
        state.enrol(Workspace {
            id: "ws-1".into(),
            display_name: "mine".into(),
            path: enrolled.clone(),
        });

        let projected = state.project_projects_in(&root);
        assert_eq!(projected.len(), 1, "only the enrolled project is projected");
        assert_eq!(projected[0].display_name, "mine");
        assert_eq!(projected[0].workspace_id, "ws-1");
        // Its session-store activity still rides along.
        assert_eq!(projected[0].session_count, 1);
        assert_eq!(projected[0].last_active_at, "2026-07-29T12:00:00Z");
        // The newer CLI-only project would have sorted first had it leaked.
        assert!(
            !projected.iter().any(|p| p.display_name == "theirs"),
            "an unenrolled project leaked into the projection"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_enrolled_project_appears_before_its_first_session_exists() {
        // Add → Open has to work on a fresh directory, so no session history
        // is not the same as no project.
        let root = scratch("proj-no-history");
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&fresh).expect("cwd");

        let mut state = SessionState::default();
        state.enrol(Workspace {
            id: "ws-1".into(),
            display_name: "fresh".into(),
            path: fresh,
        });

        let projected = state.project_projects_in(&root);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].session_count, 0);
        assert_eq!(projected[0].last_active_at, "");
        assert!(projected[0].available);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_enrolled_directory_that_went_away_is_projected_unavailable() {
        // Removing the row would silently drop a project the user enrolled;
        // the rail marks it instead so the disabled state is explainable.
        let root = scratch("proj-gone");
        let mut state = SessionState::default();
        state.enrol(Workspace {
            id: "ws-1".into(),
            display_name: "gone".into(),
            path: root.join("gone"),
        });

        let projected = state.project_projects_in(&root);
        assert_eq!(projected.len(), 1);
        assert!(!projected[0].available);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn read_only_operations_need_no_agent() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        let outcome = dispatch(
            &envelope(Operation::GetHostStatus, None),
            &mut journal,
            &mut state,
            None,
        )
        .await
        .expect("status");
        let DispatchOutcome::HostStatus {
            min_cli_version,
            cli_qualified,
            ..
        } = outcome
        else {
            panic!("GetHostStatus must project CLI product-integrity status");
        };
        assert_eq!(min_cli_version, crate::cli_matrix::MIN_QUALIFIED_CLI_LABEL);
        // Either the install is present and qualified, or missing/unqualified —
        // both are honest answers that do not need an agent process.
        let _ = cli_qualified;
    }

    #[tokio::test]
    async fn bootstrap_answers_with_the_enrolment_set() {
        // The browser's first call must be enough to decide what to render.
        let mut journal = Journal::new();
        let mut state = state_with_workspace();
        let outcome = dispatch(
            &envelope(Operation::Bootstrap, None),
            &mut journal,
            &mut state,
            None,
        )
        .await
        .expect("bootstrap");

        let DispatchOutcome::Workspaces {
            workspaces,
            open_sessions,
            ..
        } = outcome
        else {
            panic!("bootstrap must project the enrolment set");
        };
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, "w-1");
        assert!(open_sessions.is_empty());
    }

    #[tokio::test]
    async fn a_workspace_projection_never_carries_a_path() {
        let mut state = state_with_workspace();
        state.enrol(Workspace {
            id: "w-2".into(),
            display_name: "other".into(),
            path: std::path::PathBuf::from("/tmp/does-not-exist-here"),
        });

        let projected = state.project_workspaces();
        let rendered = serde_json::to_string(&projected).expect("serialise");
        assert!(
            !rendered.contains("/tmp"),
            "a projection must never leak a filesystem path: {rendered}"
        );
        // A directory that is gone is reported unavailable rather than omitted,
        // so the interface can explain it instead of silently losing an entry.
        let missing = projected
            .iter()
            .find(|entry| entry.id == "w-2")
            .expect("entry");
        assert!(!missing.available);
    }

    #[tokio::test]
    async fn an_unknown_workspace_never_reaches_the_agent() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        let result = dispatch(
            &envelope(
                Operation::CreateSession {
                    workspace_id: "nope".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert_eq!(result, Err(DispatchError::UnknownWorkspace));
    }

    #[tokio::test]
    async fn a_refusal_before_the_agent_does_not_open_a_review_record() {
        let mut journal = Journal::new();
        let mut state = state_with_workspace();
        // No agent handle: the command is refused before any effect.
        let _ = dispatch(
            &envelope(
                Operation::CreateSession {
                    workspace_id: "w-1".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert!(
            journal.pending_reviews().is_empty(),
            "nothing reached the agent, so nothing needs review"
        );
        assert_eq!(journal.effect_state("k1"), Some(EffectState::Completed));
    }

    #[tokio::test]
    async fn a_replayed_idempotency_key_never_dispatches_twice() {
        let mut journal = Journal::new();
        let mut state = state_with_workspace();
        let command = envelope(
            Operation::Prompt {
                session_id: "s-1".into(),
                text: "hi".into(),
                bash: false,
            },
            Some("k1"),
        );

        // The session is resolved before the agent, so an unopened session is
        // named as such rather than reported as "no agent".
        let first = dispatch(&command, &mut journal, &mut state, None).await;
        assert_eq!(first, Err(DispatchError::UnknownSession));

        // The same key again is refused as already handled, not re-run.
        let second = dispatch(&command, &mut journal, &mut state, None).await;
        assert_eq!(second, Err(DispatchError::AlreadyCompleted));
    }

    #[tokio::test]
    async fn sessions_are_concurrent_but_bounded() {
        // Light ADR 0011: concurrency is the point, but a page must not be
        // able to open sessions until the agent process is exhausted.
        let mut state = state_with_workspace();
        for index in 0..crate::bounds::MAX_LIVE_SESSIONS {
            state
                .open_session(live_session(&format!("s-{index}")))
                .expect("within the bound");
        }
        assert_eq!(
            state.open_session(live_session("s-over")),
            Err(DispatchError::TooManySessions)
        );
    }

    #[tokio::test]
    async fn reopening_a_session_already_open_does_not_consume_the_bound() {
        let mut state = state_with_workspace();
        for index in 0..crate::bounds::MAX_LIVE_SESSIONS {
            state
                .open_session(live_session(&format!("s-{index}")))
                .expect("within the bound");
        }
        // Re-registering an id that is already open replaces it rather than
        // being refused, so a reconnect cannot lock the user out.
        assert_eq!(state.open_session(live_session("s-0")), Ok(()));
    }

    #[tokio::test]
    async fn an_unknown_permission_request_is_refused() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        let result = dispatch(
            &envelope(
                Operation::DecidePermission {
                    session_id: "s-1".into(),
                    request_id: "perm-x".into(),
                    option_id: "allow-once".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert_eq!(result, Err(DispatchError::UnknownPermission));
    }

    #[tokio::test]
    async fn a_withheld_permission_option_is_refused_before_the_agent() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        state.open_permission(
            "perm-1",
            PendingPermission {
                request_id: serde_json::json!(1),
                session_id: "s-1".into(),
                offered: vec![
                    "always-allow".into(),
                    "allow-once".into(),
                    "reject-once".into(),
                ],
            },
        );

        let result = dispatch(
            &envelope(
                Operation::DecidePermission {
                    session_id: "s-1".into(),
                    request_id: "perm-1".into(),
                    option_id: "always-allow".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(DispatchError::Permission(_))),
            "a persistent grant must be refused by the host, got {result:?}"
        );
        assert!(
            state.pending_permissions.contains_key("perm-1"),
            "the request stays open so the user can still answer it properly"
        );
    }

    #[tokio::test]
    async fn an_option_the_agent_did_not_offer_is_refused() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        state.open_permission(
            "perm-1",
            PendingPermission {
                request_id: serde_json::json!(1),
                session_id: "s-1".into(),
                offered: vec!["allow-once".into(), "reject-once".into()],
            },
        );
        let result = dispatch(
            &envelope(
                Operation::DecidePermission {
                    session_id: "s-1".into(),
                    request_id: "perm-1".into(),
                    option_id: "allow-edits-session".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert!(matches!(result, Err(DispatchError::Permission(_))));
    }

    #[tokio::test]
    async fn closing_a_session_drops_only_its_own_pending_permissions() {
        // With several conversations open, closing one must not silently
        // discard a decision the user still owes another.
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        state.open_session(live_session("s-1")).expect("open s-1");
        state.open_session(live_session("s-2")).expect("open s-2");
        for (key, session) in [("perm-1", "s-1"), ("perm-2", "s-2")] {
            state.open_permission(
                key,
                PendingPermission {
                    request_id: serde_json::json!(1),
                    session_id: session.into(),
                    offered: vec!["allow-once".into(), "reject-once".into()],
                },
            );
        }

        let outcome = dispatch(
            &envelope(
                Operation::CloseSession {
                    session_id: "s-1".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await
        .expect("close");

        assert_eq!(outcome, DispatchOutcome::Closed);
        assert!(!state.sessions.contains_key("s-1"));
        assert!(state.sessions.contains_key("s-2"), "the other stays open");
        assert!(
            !state.pending_permissions.contains_key("perm-1"),
            "closing must not leave the agent waiting on a decision"
        );
        assert!(
            state.pending_permissions.contains_key("perm-2"),
            "the other conversation still owes its answer"
        );
    }

    #[test]
    fn closing_a_session_purges_its_ephemeral_review_state() {
        let mut state = state_with_workspace();
        state.open_session(live_session("s-1")).expect("open");
        state.begin_review_turn("s-1").expect("begin turn");
        assert!(state.reviews.contains_key("s-1"));

        state.close_session("s-1").expect("close");
        assert!(!state.reviews.contains_key("s-1"));
    }

    #[tokio::test]
    async fn a_decision_cannot_answer_another_sessions_request() {
        // The request id alone is not enough: a user answering in one
        // conversation must not resolve a prompt raised by a different one.
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        state.open_session(live_session("s-1")).expect("open s-1");
        state.open_session(live_session("s-2")).expect("open s-2");
        state.open_permission(
            "perm-1",
            PendingPermission {
                request_id: serde_json::json!(1),
                session_id: "s-1".into(),
                offered: vec!["allow-once".into(), "reject-once".into()],
            },
        );

        let result = dispatch(
            &envelope(
                Operation::DecidePermission {
                    session_id: "s-2".into(),
                    request_id: "perm-1".into(),
                    option_id: "allow-once".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;

        assert_eq!(result, Err(DispatchError::UnknownPermission));
        assert!(
            state.pending_permissions.contains_key("perm-1"),
            "the real request stays open for the session that raised it"
        );
    }

    #[tokio::test]
    async fn closing_a_session_that_is_not_open_is_refused() {
        let mut journal = Journal::new();
        let mut state = SessionState::default();
        let result = dispatch(
            &envelope(
                Operation::CloseSession {
                    session_id: "s-nope".into(),
                },
                Some("k1"),
            ),
            &mut journal,
            &mut state,
            None,
        )
        .await;
        assert_eq!(result, Err(DispatchError::UnknownSession));
    }

    #[tokio::test]
    async fn open_sessions_keep_their_order_as_activity_changes() {
        // The list is ordered by when each session opened, so a row never
        // moves under the user because a different conversation spoke.
        let mut state = SessionState::default();
        for (index, id) in ["s-a", "s-b", "s-c"].iter().enumerate() {
            state
                .open_session(LiveSession {
                    id: (*id).to_owned(),
                    workspace_id: "w-1".into(),
                    workspace_name: "Demo".into(),
                    running: false,
                    queued: Vec::new(),
                    opened_at_ms: 100 + index as u64,
                })
                .expect("open");
        }
        state.set_running("s-a", true);

        let ids: Vec<String> = state
            .project_sessions()
            .into_iter()
            .map(|session| session.session_id)
            .collect();
        assert_eq!(ids, vec!["s-a", "s-b", "s-c"]);
    }

    mod agent_failures {
        use super::super::{DispatchError, map_agent_error};
        use crate::acp::{AcpError, METHOD_NOT_FOUND};

        #[test]
        fn a_method_the_cli_lacks_is_told_apart_from_a_failure() {
            let mapped = map_agent_error(&AcpError::Agent {
                code: METHOD_NOT_FOUND,
                message: "Method not found".into(),
            });
            assert_eq!(mapped, DispatchError::Unsupported);
            assert_eq!(mapped.code(), "unsupported");
        }

        #[test]
        fn an_application_failure_stays_opaque() {
            // An unauthenticated CLI answers here. It is a real failure, and
            // the browser learns only that, never the agent's own words.
            let mapped = map_agent_error(&AcpError::Agent {
                code: -32000,
                message: "Authentication required".into(),
            });
            assert_eq!(mapped, DispatchError::Agent);
        }

        #[test]
        fn transport_detail_never_reaches_the_browser() {
            for error in [
                AcpError::Timeout,
                AcpError::Closed,
                AcpError::Malformed,
                AcpError::OversizedMessage,
                AcpError::Pipe,
                AcpError::Spawn(std::io::Error::other("boom")),
            ] {
                let mapped = map_agent_error(&error);
                assert_eq!(mapped, DispatchError::Agent);
                assert_eq!(mapped.code(), "agent_failed");
            }
        }

        #[test]
        fn the_browser_visible_code_carries_no_agent_text() {
            let mapped = map_agent_error(&AcpError::Agent {
                code: -32000,
                message: "/home/someone/secret/path exploded".into(),
            });
            assert!(!mapped.code().contains("secret"));
            assert!(!mapped.to_string().contains("secret"));
        }
    }

    mod revocation {
        use super::{envelope, state_with_workspace};
        use crate::dispatch::{DispatchError, DispatchOutcome, dispatch};
        use crate::journal::Journal;
        use crate::protocol::Operation;

        #[tokio::test]
        async fn giving_up_a_workspace_actually_forgets_it() {
            let mut journal = Journal::new();
            let mut state = state_with_workspace();

            let outcome = dispatch(
                &envelope(
                    Operation::RemoveWorkspace {
                        workspace_id: "w-1".into(),
                    },
                    Some("k1"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await
            .expect("remove");

            assert_eq!(
                outcome,
                DispatchOutcome::WorkspaceRemoved {
                    workspace_id: "w-1".into()
                }
            );
            assert!(
                state.workspaces.is_empty(),
                "an acknowledged revocation must leave nothing behind"
            );
        }

        #[tokio::test]
        async fn a_revoked_workspace_can_no_longer_host_a_session() {
            // The point of revoking is that the agent loses the directory.
            let mut journal = Journal::new();
            let mut state = state_with_workspace();

            dispatch(
                &envelope(
                    Operation::RemoveWorkspace {
                        workspace_id: "w-1".into(),
                    },
                    Some("k1"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await
            .expect("remove");

            let refused = dispatch(
                &envelope(
                    Operation::CreateSession {
                        workspace_id: "w-1".into(),
                    },
                    Some("k2"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await;
            assert_eq!(refused, Err(DispatchError::UnknownWorkspace));
        }

        #[tokio::test]
        async fn revoking_something_unknown_is_refused_not_acknowledged() {
            // Answering yes here would tell the user they had given up access
            // they never had, and hide a browser working from a stale list.
            let mut journal = Journal::new();
            let mut state = state_with_workspace();

            let refused = dispatch(
                &envelope(
                    Operation::RemoveWorkspace {
                        workspace_id: "w-does-not-exist".into(),
                    },
                    Some("k1"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await;

            assert_eq!(refused, Err(DispatchError::UnknownWorkspace));
            assert_eq!(
                state.workspaces.len(),
                1,
                "a refused revocation must not disturb the enrolments"
            );
        }
    }

    mod review_records {
        use super::{envelope, state_with_workspace};
        use crate::dispatch::{DispatchError, DispatchOutcome, dispatch};
        use crate::journal::{InterruptCause, Journal};
        use crate::protocol::Operation;

        fn reviews(outcome: &DispatchOutcome) -> &[crate::dispatch::ReviewProjection] {
            match outcome {
                DispatchOutcome::Workspaces {
                    pending_reviews, ..
                } => pending_reviews,
                _ => panic!("bootstrap must project state"),
            }
        }

        async fn bootstrap(journal: &mut Journal) -> DispatchOutcome {
            let mut state = state_with_workspace();
            dispatch(
                &envelope(Operation::Bootstrap, None),
                journal,
                &mut state,
                None,
            )
            .await
            .expect("bootstrap")
        }

        #[tokio::test]
        async fn an_unconfirmed_effect_reaches_the_browser() {
            let mut journal = Journal::new();
            journal.begin("k-1", "Prompt", Some("s-1"));
            journal
                .interrupt("k-1", InterruptCause::AgentExit)
                .expect("interrupt");

            let outcome = bootstrap(&mut journal).await;
            let pending = reviews(&outcome);
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].operation, "Prompt");
            assert_eq!(pending[0].cause, "agent_exit");
        }

        #[tokio::test]
        async fn it_keeps_being_shown_until_acknowledged() {
            let mut journal = Journal::new();
            journal.begin("k-1", "Prompt", Some("s-1"));
            journal
                .interrupt("k-1", InterruptCause::HostRestart)
                .expect("interrupt");

            // Refreshing is not reviewing: the record must not fade on its own.
            assert_eq!(reviews(&bootstrap(&mut journal).await).len(), 1);
            assert_eq!(reviews(&bootstrap(&mut journal).await).len(), 1);

            let record_id = reviews(&bootstrap(&mut journal).await)[0].record_id.clone();
            let mut state = state_with_workspace();
            dispatch(
                &envelope(
                    Operation::AcknowledgeInterrupted {
                        record_id: record_id.clone(),
                    },
                    Some("k-ack"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await
            .expect("acknowledge");

            assert!(reviews(&bootstrap(&mut journal).await).is_empty());
        }

        #[tokio::test]
        async fn acknowledging_never_reruns_the_effect() {
            let mut journal = Journal::new();
            journal.begin("k-1", "Prompt", Some("s-1"));
            journal
                .interrupt("k-1", InterruptCause::AgentExit)
                .expect("interrupt");
            let record_id = reviews(&bootstrap(&mut journal).await)[0].record_id.clone();

            let mut state = state_with_workspace();
            dispatch(
                &envelope(
                    Operation::AcknowledgeInterrupted { record_id },
                    Some("k-ack"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await
            .expect("acknowledge");

            // Saying "I have seen it" must not make the key dispatchable.
            let replayed = dispatch(
                &envelope(
                    Operation::Prompt {
                        session_id: "s-1".into(),
                        text: "again".into(),
                        bash: false,
                    },
                    Some("k-1"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await;
            assert_eq!(replayed, Err(DispatchError::NotReplayable));
        }

        #[tokio::test]
        async fn acknowledging_something_unknown_is_refused() {
            let mut journal = Journal::new();
            let mut state = state_with_workspace();
            let refused = dispatch(
                &envelope(
                    Operation::AcknowledgeInterrupted {
                        record_id: "ir-nope".into(),
                    },
                    Some("k-ack"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await;
            assert_eq!(refused, Err(DispatchError::UnknownReviewRecord));
        }

        #[tokio::test]
        async fn a_review_record_carries_no_prompt_text() {
            let mut journal = Journal::new();
            journal.begin("k-1", "Prompt", Some("s-1"));
            journal
                .interrupt("k-1", InterruptCause::AgentExit)
                .expect("interrupt");

            let outcome = bootstrap(&mut journal).await;
            let encoded = serde_json::to_string(&outcome).expect("encode");
            assert!(!encoded.contains("text"));
        }
    }

    mod replay_on_attach {
        use super::{live_session, state_with_workspace};
        use crate::dispatch::{LiveSession, SessionState};

        #[test]
        fn every_open_conversation_is_offered_for_replay() {
            // A browser that has just attached holds no transcripts, so each
            // open conversation must be restorable or it comes back reading
            // "no messages yet" while its history sits on disk.
            let mut state = state_with_workspace();
            state.open_session(live_session("s-1")).expect("open");
            state.open_session(live_session("s-2")).expect("open");

            let replay = state.sessions_to_replay();
            assert_eq!(replay.len(), 2);
            assert!(replay.iter().all(|(_, path)| path == &std::env::temp_dir()));
        }

        #[test]
        fn a_session_whose_workspace_was_revoked_is_not_read() {
            // The enrolment is the grant. Restoring a transcript from a
            // directory the user has given up would read it after revocation.
            let mut state = SessionState::default();
            state
                .open_session(LiveSession {
                    id: "s-orphan".into(),
                    workspace_id: "w-gone".into(),
                    workspace_name: "gone".into(),
                    running: false,
                    queued: Vec::new(),
                    opened_at_ms: 1,
                })
                .expect("open");

            assert!(state.sessions_to_replay().is_empty());
        }

        #[test]
        fn nothing_open_replays_nothing() {
            assert!(SessionState::default().sessions_to_replay().is_empty());
        }
    }

    mod queueing {
        use super::{envelope, live_session};
        use crate::dispatch::{DispatchError, DispatchOutcome, SessionState, dispatch};
        use crate::journal::Journal;
        use crate::protocol::Operation;

        fn running_session() -> SessionState {
            let mut state = SessionState::default();
            state.open_session(live_session("s-1")).expect("open");
            state.set_running("s-1", true);
            state
        }

        #[tokio::test]
        async fn a_prompt_sent_mid_turn_waits_instead_of_being_refused() {
            // Measured against grok 0.2.112: the agent queues a mid-turn
            // prompt itself. Light holds its own so the user can see it and
            // take it back out, and only sends when the session is idle — one
            // message must not sit in two queues.
            let mut journal = Journal::new();
            let mut state = running_session();

            let outcome = dispatch(
                &envelope(
                    Operation::Prompt {
                        session_id: "s-1".into(),
                        text: "next thing".into(),
                        bash: false,
                    },
                    Some("k1"),
                ),
                &mut journal,
                &mut state,
                None,
            )
            .await
            .expect("queued");

            assert!(matches!(outcome, DispatchOutcome::PromptQueued { .. }));
            assert_eq!(state.sessions["s-1"].queued.len(), 1);
            assert_eq!(state.sessions["s-1"].queued[0].text, "next thing");
        }

        #[tokio::test]
        async fn a_queued_prompt_only_leaves_once_the_turn_is_over() {
            let mut state = running_session();
            state.queue_prompt("s-1", "later").expect("queue");

            assert!(
                state.take_queued("s-1").is_none(),
                "a running session must not be sent its own queue"
            );

            state.set_running("s-1", false);
            assert_eq!(
                state.take_queued("s-1").map(|entry| entry.text).as_deref(),
                Some("later")
            );
        }

        #[tokio::test]
        async fn the_queue_keeps_the_order_the_user_wrote_in() {
            let mut state = running_session();
            for text in ["first", "second", "third"] {
                state.queue_prompt("s-1", text).expect("queue");
            }
            state.set_running("s-1", false);

            let mut drained = Vec::new();
            while let Some(entry) = state.take_queued("s-1") {
                drained.push(entry.text);
            }
            assert_eq!(drained, vec!["first", "second", "third"]);
        }

        #[tokio::test]
        async fn a_message_can_be_taken_back_out_before_it_runs() {
            let mut state = running_session();
            let entry = state
                .queue_prompt("s-1", "on reflection, no")
                .expect("queue");

            state.remove_queued("s-1", &entry).expect("remove");
            assert!(state.sessions["s-1"].queued.is_empty());
            assert_eq!(
                state.remove_queued("s-1", &entry),
                Err(DispatchError::UnknownQueueEntry),
                "removing it twice must not silently succeed"
            );
        }

        #[tokio::test]
        async fn the_queue_is_bounded() {
            let mut state = running_session();
            for index in 0..crate::bounds::MAX_QUEUED_PROMPTS {
                state
                    .queue_prompt("s-1", &format!("m{index}"))
                    .expect("queue");
            }
            assert_eq!(
                state.queue_prompt("s-1", "one too many"),
                Err(DispatchError::QueueFull)
            );
        }

        #[tokio::test]
        async fn each_conversation_queues_for_itself() {
            let mut state = running_session();
            state.open_session(live_session("s-2")).expect("open");
            state.set_running("s-2", true);

            state.queue_prompt("s-1", "for one").expect("queue");
            state.queue_prompt("s-2", "for two").expect("queue");

            assert_eq!(state.sessions["s-1"].queued[0].text, "for one");
            assert_eq!(state.sessions["s-2"].queued[0].text, "for two");
        }

        #[tokio::test]
        async fn queue_entry_ids_never_collide_across_conversations() {
            // The browser removes by id, so two entries sharing one would let
            // a removal take the wrong message out.
            let mut state = running_session();
            state.open_session(live_session("s-2")).expect("open");
            state.set_running("s-2", true);

            let first = state.queue_prompt("s-1", "a").expect("queue");
            let second = state.queue_prompt("s-2", "b").expect("queue");
            assert_ne!(first, second);
        }

        #[tokio::test]
        async fn queueing_into_a_conversation_that_is_not_open_is_refused() {
            let mut state = SessionState::default();
            assert_eq!(
                state.queue_prompt("s-gone", "hello"),
                Err(DispatchError::UnknownSession)
            );
        }
    }
}
