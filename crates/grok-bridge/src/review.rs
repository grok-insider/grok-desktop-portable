//! Bounded, read-only session inspection for the Light review panel.
//!
//! The browser names an open session and one closed change mode. It never
//! supplies an ACP method, Git root, ref, branch, file path, or patch limit.
//! Those values are resolved here from host-owned session/workspace state,
//! standard ACP updates, and read-only Git inspection of the enrolled tree.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use cap_std::ambient_authority;
use git2::{
    Delta, Diff, DiffDelta, DiffFindOptions, DiffOptions, Oid, Patch, Repository, StatusOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use similar::TextDiff;
use tokio::time::timeout;

use crate::bounds::{
    MAX_LAST_TURN_DIFFS, MAX_REVIEW_FILES, MAX_REVIEW_PATCH_BYTES, MAX_REVIEW_PATCH_LINES,
    MAX_REVIEW_TOTAL_PATCH_BYTES, REVIEW_TOTAL_TIMEOUT,
};

/// The closed set of change comparisons a browser may request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeMode {
    /// Current `HEAD` through the staged and working states.
    Git,
    /// Merge-base of the default branch and `HEAD` through the working state.
    Branch,
    /// Agent-reported edits from the latest completed turn.
    LastTurn,
}

/// File-level change classification projected to the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    /// A file did not exist in the comparison base.
    Added,
    /// Existing file content changed.
    Modified,
    /// A file no longer exists in the comparison target.
    Deleted,
    /// A file moved from another relative path.
    Renamed,
    /// A file was copied from another relative path.
    Copied,
    /// File mode/type changed.
    TypeChanged,
    /// A file is not tracked by Git yet.
    Untracked,
}

/// Relationship of a working-tree change to the Git index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StageState {
    /// Only the index contains this change.
    Staged,
    /// Only the worktree contains this change.
    Unstaged,
    /// Both index and worktree contain changes for this file.
    Mixed,
}

/// Why a file has no textual patch body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PatchState {
    /// The complete bounded patch is present.
    Complete,
    /// Git reported a non-textual change.
    Binary,
    /// The complete patch exceeded a host limit.
    TooLarge,
    /// The upstream contract could not provide a trustworthy body.
    Unavailable,
}

/// One changed file, named relative to the enrolled workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileProjection {
    /// Workspace-relative display path. Never absolute or parent-traversing.
    pub path: String,
    /// Previous workspace-relative path for a rename/copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    /// Closed file-change classification.
    pub status: ChangeStatus,
    /// Index relationship for Git changes; absent for other comparisons.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<StageState>,
    /// Added lines in the projected patch.
    pub additions: u64,
    /// Deleted lines in the projected patch.
    pub deletions: u64,
    /// Complete unified patch when [`Self::patch_state`] is `complete`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    /// Whether the body is complete, binary, oversized, or unavailable.
    pub patch_state: PatchState,
}

/// A complete bounded response for one change comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChangesProjection {
    /// Open session this result belongs to.
    pub session_id: String,
    /// Comparison used to build the result.
    pub mode: ChangeMode,
    /// Human-readable bounded comparison label.
    pub comparison: String,
    /// Files in stable path order.
    pub files: Vec<ChangedFileProjection>,
    /// Aggregate additions over the returned files.
    pub additions: u64,
    /// Aggregate deletions over the returned files.
    pub deletions: u64,
    /// False when any file/body was omitted or could not be attributed.
    pub complete: bool,
    /// Number of files omitted by the file-count bound.
    pub omitted_files: u64,
}

/// One informational category in the session context budget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCategoryProjection {
    /// Agent-supplied label, bounded and rendered as text.
    pub label: String,
    /// Estimated tokens consumed by the category.
    pub tokens: u64,
    /// Optional bounded supporting detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Current context-window state for one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextProjection {
    /// Tokens currently in context.
    pub used: u64,
    /// Context-window size.
    pub total: u64,
    /// Saturating free-token count.
    pub free: u64,
    /// Integer usage percentage in the range 0..=100.
    pub usage_percent: u8,
    /// Resolved auto-compaction threshold.
    pub auto_compact_threshold_percent: u8,
    /// Number of compactions performed.
    pub compaction_count: u64,
    /// Main conversation turns.
    pub turn_count: u64,
    /// Tool calls in current context.
    pub tool_call_count: u64,
    /// Conversation items in current context.
    pub message_count: u64,
    /// Estimated tokens used by system instructions.
    pub system_prompt_tokens: u64,
    /// Estimated tokens used by tool definitions.
    pub tool_definition_tokens: u64,
    /// Bounded informational categories.
    pub categories: Vec<ContextCategoryProjection>,
}

/// Cumulative usage since the current agent process started or resumed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageProjection {
    /// Full input tokens, including cache reads.
    pub input_tokens: u64,
    /// Generated output tokens.
    pub output_tokens: u64,
    /// Input tokens served from cache.
    pub cached_read_tokens: u64,
    /// Reasoning tokens, when reported.
    pub reasoning_tokens: u64,
    /// Input plus output tokens.
    pub total_tokens: u64,
    /// Number of model calls.
    pub model_calls: u64,
    /// Main-agent loop rounds.
    pub num_turns: u64,
    /// Cumulative provider API duration.
    pub api_duration_ms: u64,
    /// Trustworthy USD cost. Absent never means free.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// Whether usage may under-count.
    pub incomplete: bool,
}

impl Eq for SessionUsageProjection {}

/// Session-scoped information shown in the Context tab.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInspectorProjection {
    /// Open session this result belongs to.
    pub session_id: String,
    /// Agent definition name, when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Requested model id, when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Human-readable model label, when reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_display_name: Option<String>,
    /// Completed turn count.
    pub turns: u64,
    /// Current zero-based turn index.
    pub turn_index: u64,
    /// Current context-window information.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<SessionContextProjection>,
    /// Usage since process start/resume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsageProjection>,
    /// Change modes that are trustworthy for this session right now.
    pub available_change_modes: Vec<ChangeMode>,
    /// Current Git branch, when Git validation succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    /// Default Git branch, when Git validation succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
}

impl Eq for SessionInspectorProjection {}

/// In-memory review state for one open session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionReviewState {
    turn: TurnCapture,
    last_turn_available: bool,
    usage: Option<SessionUsageProjection>,
    live_context: Option<(u64, u64)>,
    agent_name: Option<String>,
    model: Option<String>,
    model_display_name: Option<String>,
    models: BTreeMap<String, ModelMetadata>,
    completed_turns: u64,
    turn_usage_captured: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ModelMetadata {
    display_name: Option<String>,
    agent_name: Option<String>,
    context_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct TurnCapture {
    files: BTreeMap<String, CapturedFile>,
    potential_mutations: HashSet<String>,
    running: bool,
    complete: bool,
    omitted: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct CapturedFile {
    status: ChangeStatus,
    patches: Vec<String>,
    additions: u64,
    deletions: u64,
    patch_state: PatchState,
}

/// Effects of consuming one ACP session update.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CaptureResult {
    /// The review response changed and an open panel should refresh.
    pub changes_updated: bool,
    /// Context usage changed and an open Context tab should refresh.
    pub usage_updated: bool,
}

impl SessionReviewState {
    /// Start collecting agent-reported diffs for a new turn.
    pub fn begin_turn(&mut self) {
        self.turn = TurnCapture {
            running: true,
            complete: true,
            ..TurnCapture::default()
        };
        self.last_turn_available = false;
        self.turn_usage_captured = false;
    }

    /// Mark the current turn complete and retain trustworthy usage.
    pub fn finish_turn(&mut self, result: Option<&Value>) {
        self.turn.running = false;
        if !self.turn.potential_mutations.is_empty() {
            self.turn.complete = false;
        }
        self.last_turn_available = true;
        if !self.turn_usage_captured
            && let Some(usage) = result.and_then(usage_from_prompt_result)
        {
            self.add_usage(usage);
            self.completed_turns = self.completed_turns.saturating_add(1);
        }
    }

    /// Mark the latest turn as incomplete after cancellation/failure/bash.
    pub fn interrupt_turn(&mut self) {
        self.turn.running = false;
        self.turn.complete = false;
        self.last_turn_available = true;
    }

    /// Whether a Last turn option has a completed/aborted turn to describe.
    #[must_use]
    pub fn has_last_turn(&self) -> bool {
        self.last_turn_available
    }

    /// Retain model metadata from a successful standard ACP session open.
    pub fn capture_open_result(&mut self, value: &Value) {
        let available = value
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        for entry in available.iter().take(64) {
            let Some(id) = entry.get("modelId").and_then(Value::as_str) else {
                continue;
            };
            let Some(id) = bounded_optional(Some(id), 128) else {
                continue;
            };
            if !crate::models::is_grok_model_id(&id) {
                continue;
            }
            self.models.insert(
                id,
                ModelMetadata {
                    display_name: bounded_optional(entry.get("name").and_then(Value::as_str), 128),
                    agent_name: bounded_optional(
                        entry.pointer("/_meta/agentType").and_then(Value::as_str),
                        128,
                    ),
                    context_tokens: entry
                        .pointer("/_meta/totalContextTokens")
                        .and_then(Value::as_u64),
                },
            );
        }
        let model = value
            .pointer("/_meta/x.ai~1sessionDetail/currentModelId")
            .or_else(|| value.pointer("/models/currentModelId"))
            .and_then(Value::as_str);
        if let Some(model) = model {
            self.set_model(model);
        }
    }

    /// Apply the model selected by a standard ACP update or host operation.
    pub fn set_model(&mut self, model: &str) {
        if !crate::models::is_grok_model_id(model) {
            return;
        }
        let Some(model) = bounded_optional(Some(model), 128) else {
            return;
        };
        let metadata = self.models.get(&model).cloned().unwrap_or_default();
        self.model = Some(model);
        self.model_display_name = metadata.display_name;
        self.agent_name = metadata.agent_name;
        if let (Some((used, _)), Some(total)) = (self.live_context, metadata.context_tokens) {
            self.live_context = Some((used, total));
        }
    }

    /// Consume a raw ACP session update before its display-only projection.
    pub fn capture_update(&mut self, workspace_root: &Path, params: &Value) -> CaptureResult {
        let kind = params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "usage_update" {
            let used = params.pointer("/update/used").and_then(Value::as_u64);
            let total = params.pointer("/update/size").and_then(Value::as_u64);
            if let (Some(used), Some(total)) = (used, total)
                && total > 0
                && used <= total
            {
                self.live_context = Some((used, total));
                return CaptureResult {
                    usage_updated: true,
                    ..CaptureResult::default()
                };
            }
            return CaptureResult::default();
        }
        if kind == "turn_completed" {
            let Some(usage) = params.pointer("/update/usage").and_then(usage_projection) else {
                return CaptureResult::default();
            };
            self.add_usage(usage);
            self.completed_turns = self.completed_turns.saturating_add(1);
            self.turn_usage_captured = self.turn.running;
            return CaptureResult {
                usage_updated: true,
                ..CaptureResult::default()
            };
        }
        if kind == "model_changed" {
            let Some(model) = params.pointer("/update/model_id").and_then(Value::as_str) else {
                return CaptureResult::default();
            };
            self.set_model(model);
            return CaptureResult {
                usage_updated: true,
                ..CaptureResult::default()
            };
        }
        if !self.turn.running {
            return CaptureResult::default();
        }
        if kind == "tool_call" {
            if potential_file_mutation(params)
                && let Some(tool_call_id) = bounded_tool_call_id(params)
            {
                if self.turn.potential_mutations.len() < MAX_LAST_TURN_DIFFS {
                    self.turn.potential_mutations.insert(tool_call_id);
                } else {
                    self.turn.complete = false;
                }
            }
            return CaptureResult::default();
        }
        let status = params.pointer("/update/status").and_then(Value::as_str);
        if kind != "tool_call_update" || !matches!(status, Some("completed" | "failed")) {
            return CaptureResult::default();
        }

        let tool_call_id = bounded_tool_call_id(params);
        let potential_mutation = tool_call_id
            .as_ref()
            .is_some_and(|id| self.turn.potential_mutations.remove(id))
            || potential_file_mutation(params);
        let content = params
            .pointer("/update/content")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut updated = false;
        let mut saw_diff = false;
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("diff") {
                continue;
            }
            saw_diff = true;
            updated = true;
            if self.total_blocks() >= MAX_LAST_TURN_DIFFS {
                self.turn.complete = false;
                self.turn.omitted = self.turn.omitted.saturating_add(1);
                continue;
            }
            self.capture_diff(workspace_root, block);
        }
        if potential_mutation && !saw_diff {
            self.turn.complete = false;
            updated = true;
        }
        CaptureResult {
            changes_updated: updated,
            ..CaptureResult::default()
        }
    }

    fn add_usage(&mut self, incoming: SessionUsageProjection) {
        let Some(current) = self.usage.as_mut() else {
            self.usage = Some(incoming);
            return;
        };
        current.input_tokens = current.input_tokens.saturating_add(incoming.input_tokens);
        current.output_tokens = current.output_tokens.saturating_add(incoming.output_tokens);
        current.cached_read_tokens = current
            .cached_read_tokens
            .saturating_add(incoming.cached_read_tokens);
        current.reasoning_tokens = current
            .reasoning_tokens
            .saturating_add(incoming.reasoning_tokens);
        current.total_tokens = current.total_tokens.saturating_add(incoming.total_tokens);
        current.model_calls = current.model_calls.saturating_add(incoming.model_calls);
        current.num_turns = current.num_turns.saturating_add(incoming.num_turns);
        current.api_duration_ms = current
            .api_duration_ms
            .saturating_add(incoming.api_duration_ms);
        current.cost_usd = match (current.cost_usd, incoming.cost_usd) {
            (Some(left), Some(right)) => Some(left + right).filter(|cost| cost.is_finite()),
            _ => None,
        };
        current.incomplete |= incoming.incomplete;
        if current.incomplete {
            current.cost_usd = None;
        }
    }

    fn total_blocks(&self) -> usize {
        self.turn
            .files
            .values()
            .map(|file| file.patches.len())
            .sum()
    }

    fn capture_diff(&mut self, workspace_root: &Path, block: &Value) -> bool {
        let Some(raw_path) = block.get("path").and_then(Value::as_str) else {
            self.turn.complete = false;
            return false;
        };
        let Some(path) = absolute_workspace_relative(workspace_root, Path::new(raw_path)) else {
            self.turn.complete = false;
            return false;
        };
        let old = block.get("oldText").and_then(Value::as_str);
        let Some(new) = block.get("newText").and_then(Value::as_str) else {
            self.turn.complete = false;
            return false;
        };
        if old.map_or(0, str::len).saturating_add(new.len()) > MAX_REVIEW_PATCH_BYTES * 2 {
            self.turn.complete = false;
            self.turn.files.insert(
                path,
                CapturedFile {
                    status: ChangeStatus::Modified,
                    patches: Vec::new(),
                    additions: 0,
                    deletions: 0,
                    patch_state: PatchState::TooLarge,
                },
            );
            return true;
        }

        let patch_text = structured_patch(&path, block)
            .unwrap_or_else(|| text_patch(&path, old.unwrap_or_default(), new));
        let (additions, deletions) = patch_counts(&patch_text);
        let status = if old.is_none() {
            ChangeStatus::Added
        } else if new.is_empty() {
            ChangeStatus::Deleted
        } else {
            ChangeStatus::Modified
        };
        let bounded = patch_text.len() <= MAX_REVIEW_PATCH_BYTES
            && patch_text.lines().count() <= MAX_REVIEW_PATCH_LINES;
        let entry = self.turn.files.entry(path).or_insert(CapturedFile {
            status,
            patches: Vec::new(),
            additions: 0,
            deletions: 0,
            patch_state: PatchState::Complete,
        });
        entry.status = status;
        entry.additions = entry.additions.saturating_add(additions);
        entry.deletions = entry.deletions.saturating_add(deletions);
        if bounded {
            entry.patches.push(patch_text);
        } else {
            entry.patch_state = PatchState::TooLarge;
            self.turn.complete = false;
        }
        true
    }

    fn last_turn_projection(&self, session_id: &str) -> Option<SessionChangesProjection> {
        if !self.last_turn_available {
            return None;
        }
        let mut total_bytes = 0usize;
        let mut complete = self.turn.complete && !self.turn.running;
        let mut files = Vec::new();
        for (path, captured) in &self.turn.files {
            let patch = if captured.patch_state == PatchState::Complete {
                let joined = captured.patches.join("\n");
                if total_bytes.saturating_add(joined.len()) <= MAX_REVIEW_TOTAL_PATCH_BYTES {
                    total_bytes += joined.len();
                    Some(joined)
                } else {
                    complete = false;
                    None
                }
            } else {
                complete = false;
                None
            };
            let patch_state = if captured.patch_state == PatchState::Complete && patch.is_none() {
                PatchState::TooLarge
            } else {
                captured.patch_state
            };
            files.push(ChangedFileProjection {
                path: path.clone(),
                previous_path: None,
                status: captured.status,
                stage: None,
                additions: captured.additions,
                deletions: captured.deletions,
                patch,
                patch_state,
            });
        }
        let additions = files.iter().map(|file| file.additions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();
        Some(SessionChangesProjection {
            session_id: session_id.to_owned(),
            mode: ChangeMode::LastTurn,
            comparison: "Agent-reported changes from the last turn".into(),
            files,
            additions,
            deletions,
            complete,
            omitted_files: self.turn.omitted,
        })
    }
}

fn bounded_tool_call_id(params: &Value) -> Option<String> {
    let id = params
        .pointer("/update/toolCallId")
        .and_then(Value::as_str)?;
    (!id.is_empty() && id.len() <= 512).then(|| id.to_owned())
}

fn potential_file_mutation(params: &Value) -> bool {
    if params
        .pointer("/update/_meta/x.ai~1tool/read_only")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return false;
    }
    let kind = params
        .pointer("/update/kind")
        .or_else(|| params.pointer("/update/_meta/x.ai~1tool/kind"))
        .and_then(Value::as_str);
    if matches!(kind, Some("edit" | "execute" | "delete" | "move")) {
        return true;
    }
    params
        .pointer("/update/_meta/x.ai~1tool/namespace")
        .and_then(Value::as_str)
        .is_some_and(|namespace| !namespace.is_empty() && namespace != "grok_build")
}

/// Fetch session context and capability information without exposing paths.
pub async fn inspect_session(
    session_id: &str,
    workspace_root: &Path,
    local: &SessionReviewState,
) -> SessionInspectorProjection {
    let root = workspace_root.to_owned();
    let git = timeout(
        REVIEW_TOTAL_TIMEOUT,
        tokio::task::spawn_blocking(move || git_context(&root)),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .flatten();

    let mut available_change_modes = Vec::new();
    if let Some(git) = &git {
        available_change_modes.push(ChangeMode::Git);
        if git.merge_base.is_some() {
            available_change_modes.push(ChangeMode::Branch);
        }
    }
    if local.has_last_turn() {
        available_change_modes.push(ChangeMode::LastTurn);
    }

    let context = local
        .live_context
        .map(|(used, total)| SessionContextProjection {
            used,
            total,
            free: total.saturating_sub(used),
            usage_percent: usage_percent(used, total),
            auto_compact_threshold_percent: 85,
            compaction_count: 0,
            turn_count: local.completed_turns,
            tool_call_count: 0,
            message_count: 0,
            system_prompt_tokens: 0,
            tool_definition_tokens: 0,
            categories: Vec::new(),
        });

    SessionInspectorProjection {
        session_id: session_id.to_owned(),
        agent_name: local.agent_name.clone(),
        model: local.model.clone(),
        model_display_name: local.model_display_name.clone(),
        turns: local.completed_turns,
        turn_index: local.completed_turns.saturating_sub(1),
        context,
        usage: local.usage.clone(),
        available_change_modes,
        current_branch: git
            .as_ref()
            .and_then(|value| bounded_optional(value.current_branch.as_deref(), 128)),
        default_branch: git
            .as_ref()
            .and_then(|value| bounded_optional(value.default_branch.as_deref(), 128)),
    }
}

/// Collect one complete bounded changes response, or hide an unsupported mode.
pub async fn collect_changes(
    session_id: &str,
    workspace_root: &Path,
    mode: ChangeMode,
    local: &SessionReviewState,
) -> Option<SessionChangesProjection> {
    if mode == ChangeMode::LastTurn {
        return local.last_turn_projection(session_id);
    }
    let root = workspace_root.to_owned();
    let session_id = session_id.to_owned();
    match timeout(
        REVIEW_TOTAL_TIMEOUT,
        tokio::task::spawn_blocking(move || collect_git_changes(&session_id, &root, mode)),
    )
    .await
    {
        Ok(Ok(changes)) => changes,
        Err(_) | Ok(Err(_)) => None,
    }
}

#[derive(Debug, Clone)]
struct GitContext {
    root: PathBuf,
    scope: Option<String>,
    head: Oid,
    current_branch: Option<String>,
    default_branch: Option<String>,
    merge_base: Option<Oid>,
}

#[derive(Debug, Clone)]
struct SourceFile {
    repo_path: String,
    previous_repo_path: Option<String>,
    path: String,
    previous_path: Option<String>,
    status: ChangeStatus,
    stage: Option<StageState>,
    additions: u64,
    deletions: u64,
    untracked: bool,
}

fn git_context(workspace_root: &Path) -> Option<GitContext> {
    let workspace = workspace_root.canonicalize().ok()?;
    let repository = Repository::discover(&workspace).ok()?;
    let root = repository.workdir()?.canonicalize().ok()?;
    if !workspace.starts_with(&root) {
        return None;
    }
    let scope_path = workspace.strip_prefix(&root).ok()?;
    let scope = relative_components(scope_path);
    let head_reference = repository.head().ok()?;
    let head = head_reference.peel_to_commit().ok()?.id();
    let current_branch = head_reference
        .is_branch()
        .then(|| bounded_optional(head_reference.shorthand(), 128))
        .flatten();
    let default = default_branch(&repository);
    let default_branch = default.as_ref().map(|(name, _)| name.clone());
    let merge_base = match (current_branch.as_deref(), default.as_ref()) {
        (Some(current), Some((default, base))) if current != default => {
            repository.merge_base(*base, head).ok()
        }
        _ => None,
    };
    Some(GitContext {
        root,
        scope,
        head,
        current_branch,
        default_branch,
        merge_base,
    })
}

fn default_branch(repository: &Repository) -> Option<(String, Oid)> {
    if let Ok(reference) = repository.find_reference("refs/remotes/origin/HEAD") {
        let target = reference.symbolic_target().or_else(|| reference.name())?;
        let name = target
            .strip_prefix("refs/remotes/origin/")
            .or_else(|| target.strip_prefix("refs/heads/"))?;
        let name = bounded_optional(Some(name), 128)?;
        let oid = reference.resolve().ok()?.peel_to_commit().ok()?.id();
        return Some((name, oid));
    }
    for (name, reference) in [
        ("main", "refs/remotes/origin/main"),
        ("master", "refs/remotes/origin/master"),
        ("main", "refs/heads/main"),
        ("master", "refs/heads/master"),
    ] {
        if let Ok(commit) = repository
            .find_reference(reference)
            .and_then(|reference| reference.peel_to_commit())
        {
            return Some((name.to_owned(), commit.id()));
        }
    }
    None
}

fn collect_git_changes(
    session_id: &str,
    workspace_root: &Path,
    mode: ChangeMode,
) -> Option<SessionChangesProjection> {
    let git = git_context(workspace_root)?;
    let repository = Repository::open(&git.root).ok()?;
    let base = match mode {
        ChangeMode::Git => git.head,
        ChangeMode::Branch => git.merge_base?,
        ChangeMode::LastTurn => return None,
    };
    let tree = repository.find_commit(base).ok()?.tree().ok()?;
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .max_size(i64::try_from(MAX_REVIEW_PATCH_BYTES).ok()?);
    if let Some(scope) = &git.scope {
        options.pathspec(scope);
    }
    let mut diff = repository
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut options))
        .ok()?;
    let mut complete = true;
    let mut find = DiffFindOptions::new();
    find.renames(true).rename_limit(MAX_REVIEW_FILES * 4);
    if diff.find_similar(Some(&mut find)).is_err() {
        complete = false;
    }
    let stages = if mode == ChangeMode::Git {
        if let Some(stages) = stage_states(&repository, git.scope.as_deref()) {
            Some(stages)
        } else {
            complete = false;
            None
        }
    } else {
        None
    };

    let delta_count = diff.deltas().len();
    let mut omitted_files =
        u64::try_from(delta_count.saturating_sub(MAX_REVIEW_FILES)).unwrap_or(u64::MAX);
    let mut total_patch_bytes = 0usize;
    let mut files = Vec::with_capacity(delta_count.min(MAX_REVIEW_FILES));
    for (index, delta) in diff.deltas().take(MAX_REVIEW_FILES).enumerate() {
        let Some(source) = source_from_delta(&git, &delta, stages.as_ref()) else {
            omitted_files = omitted_files.saturating_add(1);
            complete = false;
            continue;
        };
        if mode == ChangeMode::Git && source.stage.is_none() {
            complete = false;
        }
        let mut file = project_local_patch(&diff, index, workspace_root, source);
        if let Some(patch) = file.patch.as_ref() {
            if total_patch_bytes.saturating_add(patch.len()) > MAX_REVIEW_TOTAL_PATCH_BYTES {
                file.patch = None;
                file.patch_state = PatchState::TooLarge;
            } else {
                total_patch_bytes += patch.len();
            }
        }
        complete &= file.patch_state == PatchState::Complete;
        files.push(file);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if omitted_files > 0 {
        complete = false;
    }
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    let comparison = if mode == ChangeMode::Git {
        "HEAD to working tree".to_owned()
    } else {
        format!(
            "{} merge-base to working tree",
            git.default_branch.as_deref().unwrap_or("default branch")
        )
    };
    Some(SessionChangesProjection {
        session_id: session_id.to_owned(),
        mode,
        comparison,
        files,
        additions,
        deletions,
        complete,
        omitted_files,
    })
}

fn stage_states(
    repository: &Repository,
    scope: Option<&str>,
) -> Option<HashMap<String, StageState>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    if let Some(scope) = scope {
        options.pathspec(scope);
    }
    let statuses = repository.statuses(Some(&mut options)).ok()?;
    let mut out = HashMap::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let index = status.is_index_new()
            || status.is_index_modified()
            || status.is_index_deleted()
            || status.is_index_renamed()
            || status.is_index_typechange();
        let worktree = status.is_wt_new()
            || status.is_wt_modified()
            || status.is_wt_deleted()
            || status.is_wt_renamed()
            || status.is_wt_typechange();
        let stage = if status.is_conflicted() || index && worktree {
            Some(StageState::Mixed)
        } else if index {
            Some(StageState::Staged)
        } else if worktree {
            Some(StageState::Unstaged)
        } else {
            None
        };
        if let Some(stage) = stage {
            let mut paths = Vec::with_capacity(5);
            if let Some(path) = entry.path().and_then(clean_relative) {
                paths.push(path);
            }
            for delta in [entry.head_to_index(), entry.index_to_workdir()]
                .into_iter()
                .flatten()
            {
                for path in [delta.old_file().path(), delta.new_file().path()]
                    .into_iter()
                    .flatten()
                    .filter_map(Path::to_str)
                    .filter_map(clean_relative)
                {
                    paths.push(path);
                }
            }
            for path in paths {
                out.insert(path, stage);
            }
        }
    }
    Some(out)
}

fn source_from_delta(
    git: &GitContext,
    delta: &DiffDelta<'_>,
    stages: Option<&HashMap<String, StageState>>,
) -> Option<SourceFile> {
    let raw_path = delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())?
        .to_str()?;
    let (repo_path, path) = scoped_path(git, raw_path)?;
    let previous = if matches!(delta.status(), Delta::Renamed | Delta::Copied) {
        Some(
            delta
                .old_file()
                .path()
                .and_then(Path::to_str)
                .and_then(|old| scoped_path(git, old))?,
        )
    } else {
        None
    };
    let (previous_repo_path, previous_path) =
        previous.map_or((None, None), |(repo, display)| (Some(repo), Some(display)));
    let untracked = delta.status() == Delta::Untracked;
    let stage = stages.and_then(|stages| {
        stages
            .get(&repo_path)
            .copied()
            .or(untracked.then_some(StageState::Unstaged))
    });
    Some(SourceFile {
        repo_path,
        previous_repo_path,
        path,
        previous_path,
        status: match delta.status() {
            Delta::Added => ChangeStatus::Added,
            Delta::Deleted => ChangeStatus::Deleted,
            Delta::Renamed => ChangeStatus::Renamed,
            Delta::Copied => ChangeStatus::Copied,
            Delta::Typechange => ChangeStatus::TypeChanged,
            Delta::Untracked => ChangeStatus::Untracked,
            _ => ChangeStatus::Modified,
        },
        stage,
        additions: 0,
        deletions: 0,
        untracked,
    })
}

fn project_local_patch(
    diff: &Diff<'_>,
    index: usize,
    workspace_root: &Path,
    source: SourceFile,
) -> ChangedFileProjection {
    if source.untracked {
        return untracked_projection(workspace_root, source);
    }
    let Some(delta) = diff.get_delta(index) else {
        return unavailable_projection(source);
    };
    if matches!(delta.status(), Delta::Unreadable | Delta::Conflicted) {
        return unavailable_projection(source);
    }
    if delta.old_file().size() > MAX_REVIEW_PATCH_BYTES as u64
        || delta.new_file().size() > MAX_REVIEW_PATCH_BYTES as u64
    {
        return ChangedFileProjection {
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    let Ok(Some(mut patch)) = Patch::from_diff(diff, index) else {
        let patch_state = if delta.old_file().is_binary() || delta.new_file().is_binary() {
            PatchState::Binary
        } else {
            PatchState::Unavailable
        };
        return ChangedFileProjection {
            patch_state,
            ..unavailable_projection(source)
        };
    };
    let Ok((_, additions, deletions)) = patch.line_stats() else {
        return unavailable_projection(source);
    };
    if patch.size(true, true, true) > MAX_REVIEW_PATCH_BYTES {
        return ChangedFileProjection {
            additions: u64::try_from(additions).unwrap_or(u64::MAX),
            deletions: u64::try_from(deletions).unwrap_or(u64::MAX),
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    let Some(text) = patch
        .to_buf()
        .ok()
        .and_then(|buffer| buffer.as_str().map(str::to_owned))
    else {
        return unavailable_projection(source);
    };
    let text = workspace_relative_patch(&text, &source);
    if text.lines().count() > MAX_REVIEW_PATCH_LINES {
        return ChangedFileProjection {
            additions: u64::try_from(additions).unwrap_or(u64::MAX),
            deletions: u64::try_from(deletions).unwrap_or(u64::MAX),
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    ChangedFileProjection {
        path: source.path,
        previous_path: source.previous_path,
        status: source.status,
        stage: source.stage,
        additions: u64::try_from(additions).unwrap_or(u64::MAX),
        deletions: u64::try_from(deletions).unwrap_or(u64::MAX),
        patch: Some(text),
        patch_state: PatchState::Complete,
    }
}

fn workspace_relative_patch(text: &str, source: &SourceFile) -> String {
    let old_repo = source
        .previous_repo_path
        .as_deref()
        .unwrap_or(&source.repo_path);
    let old_display = source.previous_path.as_deref().unwrap_or(&source.path);
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let line = if line.starts_with("diff --git ") || line.starts_with("Binary files ") {
            line.replace(&format!("a/{old_repo}"), &format!("a/{old_display}"))
                .replace(
                    &format!("b/{}", source.repo_path),
                    &format!("b/{}", source.path),
                )
        } else if line.starts_with("--- ") {
            line.replacen(&format!("a/{old_repo}"), &format!("a/{old_display}"), 1)
        } else if line.starts_with("+++ ") {
            line.replacen(
                &format!("b/{}", source.repo_path),
                &format!("b/{}", source.path),
                1,
            )
        } else if line.starts_with("rename from ") || line.starts_with("copy from ") {
            line.replacen(old_repo, old_display, 1)
        } else if line.starts_with("rename to ") || line.starts_with("copy to ") {
            line.replacen(&source.repo_path, &source.path, 1)
        } else {
            line.to_owned()
        };
        out.push_str(&line);
    }
    out
}

fn unavailable_projection(source: SourceFile) -> ChangedFileProjection {
    ChangedFileProjection {
        path: source.path,
        previous_path: source.previous_path,
        status: source.status,
        stage: source.stage,
        additions: source.additions,
        deletions: source.deletions,
        patch: None,
        patch_state: PatchState::Unavailable,
    }
}

fn untracked_projection(workspace_root: &Path, source: SourceFile) -> ChangedFileProjection {
    let Ok(directory) = cap_std::fs::Dir::open_ambient_dir(workspace_root, ambient_authority())
    else {
        return unavailable_projection(source);
    };
    let Ok(metadata) = directory.symlink_metadata(&source.path) else {
        return unavailable_projection(source);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return unavailable_projection(source);
    }
    if metadata.len() > MAX_REVIEW_PATCH_BYTES as u64 {
        return ChangedFileProjection {
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    let Ok(file) = directory.open(&source.path) else {
        return unavailable_projection(source);
    };
    let mut bytes = Vec::new();
    if file
        .take((MAX_REVIEW_PATCH_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return unavailable_projection(source);
    }
    if bytes.len() > MAX_REVIEW_PATCH_BYTES {
        return ChangedFileProjection {
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return ChangedFileProjection {
            patch_state: PatchState::Binary,
            ..unavailable_projection(source)
        };
    };
    let patch = added_file_patch(&source.path, &text);
    if patch.lines().count() > MAX_REVIEW_PATCH_LINES || patch.len() > MAX_REVIEW_PATCH_BYTES {
        return ChangedFileProjection {
            patch_state: PatchState::TooLarge,
            ..unavailable_projection(source)
        };
    }
    let additions = text.lines().count() as u64;
    ChangedFileProjection {
        path: source.path,
        previous_path: None,
        status: ChangeStatus::Untracked,
        stage: source.stage,
        additions,
        deletions: 0,
        patch: Some(patch),
        patch_state: PatchState::Complete,
    }
}

fn scoped_path(git: &GitContext, raw: &str) -> Option<(String, String)> {
    let repo_path = clean_relative(raw)?;
    let display = match git.scope.as_deref() {
        None => repo_path.clone(),
        Some(scope) => repo_path.strip_prefix(scope)?.strip_prefix('/')?.to_owned(),
    };
    if display.is_empty() || display.len() > crate::bounds::MAX_CONTEXT_PATH_BYTES {
        return None;
    }
    Some((repo_path, display))
}

fn clean_relative(raw: &str) -> Option<String> {
    let path = Path::new(raw);
    if path.is_absolute() {
        return None;
    }
    relative_components(path)
}

fn relative_components(path: &Path) -> Option<String> {
    let mut out = String::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(part);
    }
    (!out.is_empty()).then_some(out)
}

fn absolute_workspace_relative(root: &Path, path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let relative = path.strip_prefix(root).ok()?;
    let path = relative_components(relative)?;
    (path.len() <= crate::bounds::MAX_CONTEXT_PATH_BYTES).then_some(path)
}

fn structured_patch(path: &str, block: &Value) -> Option<String> {
    let details = block.pointer("/_meta/details")?.as_array()?;
    if details.is_empty() {
        return None;
    }
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    for detail in details {
        let old = detail.get("old_string")?.as_str()?;
        let new = detail.get("new_string")?.as_str()?;
        let before = detail
            .get("context_before")
            .and_then(Value::as_str)
            .unwrap_or("");
        let after = detail
            .get("context_after")
            .and_then(Value::as_str)
            .unwrap_or("");
        let old_line = detail.get("old_line")?.as_u64()?;
        let new_line = detail.get("new_line")?.as_u64()?;
        let prefix = detail
            .get("line_prefix")
            .and_then(Value::as_str)
            .unwrap_or("");
        let before_lines = lines(before);
        let after_lines = lines(after);
        let mut old_lines = lines(old);
        let mut new_lines = lines(new);
        prepend_first(&mut old_lines, prefix);
        prepend_first(&mut new_lines, prefix);
        let old_start = old_line.saturating_sub(before_lines.len() as u64).max(1);
        let new_start = new_line.saturating_sub(before_lines.len() as u64).max(1);
        let old_count = before_lines.len() + old_lines.len() + after_lines.len();
        let new_count = before_lines.len() + new_lines.len() + after_lines.len();
        writeln!(
            out,
            "@@ -{old_start},{old_count} +{new_start},{new_count} @@"
        )
        .expect("writing to a String cannot fail");
        for line in &before_lines {
            out.push(' ');
            out.push_str(line);
            out.push('\n');
        }
        for line in &old_lines {
            out.push('-');
            out.push_str(line);
            out.push('\n');
        }
        for line in &new_lines {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
        for line in &after_lines {
            out.push(' ');
            out.push_str(line);
            out.push('\n');
        }
    }
    Some(out)
}

fn lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.lines().map(str::to_owned).collect()
    }
}

fn prepend_first(lines: &mut [String], prefix: &str) {
    if prefix.is_empty() {
        return;
    }
    if let Some(first) = lines.first_mut() {
        first.insert_str(0, prefix);
    }
}

fn text_patch(path: &str, old: &str, new: &str) -> String {
    TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

fn added_file_patch(path: &str, text: &str) -> String {
    let count = text.lines().count();
    let mut out = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{count} @@\n");
    for line in text.lines() {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn patch_counts(patch: &str) -> (u64, u64) {
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in patch.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions = additions.saturating_add(1);
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions = deletions.saturating_add(1);
        }
    }
    (additions, deletions)
}

fn usage_percent(used: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    u8::try_from(used.saturating_mul(100).saturating_div(total).min(100)).unwrap_or(100)
}

fn usage_from_prompt_result(value: &Value) -> Option<SessionUsageProjection> {
    value.pointer("/_meta/usage").and_then(usage_projection)
}

fn usage_projection(value: &Value) -> Option<SessionUsageProjection> {
    let wire: UsageWire = serde_json::from_value(value.clone()).ok()?;
    let cost_usd = if wire.usage_is_incomplete || wire.cost_is_partial {
        None
    } else {
        wire.cost_usd_ticks
            .filter(|ticks| *ticks >= 0)
            .and_then(|ticks| ticks.to_string().parse::<f64>().ok())
            .map(|ticks| ticks / 10_000_000_000.0)
            .filter(|cost| cost.is_finite())
    };
    Some(SessionUsageProjection {
        input_tokens: wire.input_tokens,
        output_tokens: wire.output_tokens,
        cached_read_tokens: wire.cached_read_tokens,
        reasoning_tokens: wire.reasoning_tokens,
        total_tokens: wire.total_tokens,
        model_calls: wire.model_calls,
        num_turns: wire.num_turns,
        api_duration_ms: wire.api_duration_ms,
        cost_usd,
        incomplete: wire.usage_is_incomplete || wire.cost_is_partial,
    })
}

fn bounded_optional(value: Option<&str>, max: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    Some(crate::bounds::truncate_utf8(value, max).0)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UsageWire {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    cached_read_tokens: u64,
    reasoning_tokens: u64,
    model_calls: u64,
    api_duration_ms: u64,
    cost_usd_ticks: Option<i64>,
    cost_is_partial: bool,
    num_turns: u64,
    usage_is_incomplete: bool,
}

#[cfg(test)]
mod tests {
    use super::{
        ChangeMode, PatchState, SessionReviewState, StageState, collect_git_changes,
        usage_projection,
    };
    use git2::{IndexAddOption, Oid, Repository, Signature};
    use serde_json::json;
    use std::fs;

    fn commit_all(repository: &Repository, message: &str) -> Oid {
        let mut index = repository.index().expect("index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("add all");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repository.find_tree(tree_id).expect("tree");
        let signature = Signature::now("Grok Light test", "light@example.invalid").expect("sig");
        let parent = repository
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok());
        match parent {
            Some(parent) => repository
                .commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    message,
                    &tree,
                    &[&parent],
                )
                .expect("commit"),
            None => repository
                .commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
                .expect("initial commit"),
        }
    }

    fn repository() -> (tempfile::TempDir, Repository) {
        let root = tempfile::tempdir().expect("root");
        let repository = Repository::init(root.path()).expect("repository");
        repository
            .set_head("refs/heads/main")
            .expect("set main head");
        (root, repository)
    }

    #[test]
    fn cost_is_absent_when_usage_is_incomplete_or_partial() {
        for value in [
            json!({"inputTokens": 1, "costUsdTicks": 100, "usageIsIncomplete": true}),
            json!({"inputTokens": 1, "costUsdTicks": 100, "costIsPartial": true}),
        ] {
            let usage = usage_projection(&value).expect("usage");
            assert!(usage.cost_usd.is_none());
            assert!(usage.incomplete);
        }
        let usage = usage_projection(&json!({"costUsdTicks": 250_000_000})).expect("usage");
        assert_eq!(usage.cost_usd, Some(0.025));
    }

    #[test]
    fn standard_acp_metadata_and_turn_usage_feed_the_inspector_state() {
        let root = tempfile::tempdir().expect("root");
        let mut state = SessionReviewState::default();
        state.capture_open_result(&json!({
            "models": {
                "currentModelId": "grok-4.5",
                "availableModels": [{
                    "modelId": "grok-4.5",
                    "name": "Grok 4.5",
                    "_meta": {
                        "agentType": "grok-build-plan",
                        "totalContextTokens": 500_000
                    }
                }]
            },
            "_meta": {
                "x.ai/sessionDetail": { "currentModelId": "grok-4.5" }
            }
        }));
        state.begin_turn();
        let captured = state.capture_update(
            root.path(),
            &json!({
                "update": {
                    "sessionUpdate": "turn_completed",
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 20,
                        "totalTokens": 120,
                        "cachedReadTokens": 40,
                        "reasoningTokens": 5,
                        "modelCalls": 2,
                        "apiDurationMs": 300,
                        "costUsdTicks": 100_000_000,
                        "numTurns": 2
                    }
                }
            }),
        );
        state.finish_turn(None);

        assert!(captured.usage_updated);
        assert_eq!(state.model.as_deref(), Some("grok-4.5"));
        assert_eq!(state.model_display_name.as_deref(), Some("Grok 4.5"));
        assert_eq!(state.agent_name.as_deref(), Some("grok-build-plan"));
        assert_eq!(state.completed_turns, 1);
        let usage = state.usage.expect("usage");
        assert_eq!(usage.total_tokens, 120);
        assert_eq!(usage.cost_usd, Some(0.01));
    }

    #[test]
    fn git_changes_include_mixed_and_untracked_files_with_complete_patches() {
        let (root, repository) = repository();
        fs::write(root.path().join("tracked.txt"), "base\n").expect("base");
        commit_all(&repository, "initial");

        fs::write(root.path().join("tracked.txt"), "staged\n").expect("staged");
        let mut index = repository.index().expect("index");
        index
            .add_path(std::path::Path::new("tracked.txt"))
            .expect("stage");
        index.write().expect("write index");
        fs::write(root.path().join("tracked.txt"), "working\n").expect("working");
        fs::write(root.path().join("new.txt"), "new\n").expect("new");

        let changes = collect_git_changes("s-1", root.path(), ChangeMode::Git).expect("changes");
        assert_eq!(changes.files.len(), 2);
        let tracked = changes
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .expect("tracked");
        assert_eq!(tracked.stage, Some(StageState::Mixed));
        assert_eq!(tracked.patch_state, PatchState::Complete);
        assert!(tracked.patch.as_deref().unwrap().contains("+working"));
        let untracked = changes
            .files
            .iter()
            .find(|file| file.path == "new.txt")
            .expect("untracked");
        assert_eq!(untracked.stage, Some(StageState::Unstaged));
        assert_eq!(untracked.patch_state, PatchState::Complete);
        assert!(untracked.patch.as_deref().unwrap().contains("+new"));
    }

    #[test]
    fn nested_workspace_review_never_projects_sibling_paths() {
        let (root, repository) = repository();
        fs::create_dir(root.path().join("workspace")).expect("workspace");
        fs::write(root.path().join("workspace/inside.txt"), "base\n").expect("inside");
        fs::write(root.path().join("outside.txt"), "base\n").expect("outside");
        commit_all(&repository, "initial");
        fs::write(root.path().join("workspace/inside.txt"), "changed\n").expect("inside");
        fs::write(root.path().join("outside.txt"), "changed\n").expect("outside");

        let changes = collect_git_changes("s-1", &root.path().join("workspace"), ChangeMode::Git)
            .expect("changes");
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path, "inside.txt");
        let patch = changes.files[0].patch.as_deref().unwrap();
        assert!(!patch.contains("outside"));
        assert!(!patch.contains("workspace/inside.txt"));
        assert!(patch.contains("a/inside.txt"));
    }

    #[test]
    fn branch_review_uses_the_default_branch_merge_base() {
        let (root, repository) = repository();
        fs::write(root.path().join("base.txt"), "base\n").expect("base");
        let base = commit_all(&repository, "initial");
        let base_commit = repository.find_commit(base).expect("base commit");
        repository
            .branch("feature", &base_commit, false)
            .expect("feature branch");
        repository
            .set_head("refs/heads/feature")
            .expect("feature head");
        fs::write(root.path().join("feature.txt"), "feature\n").expect("feature");
        commit_all(&repository, "feature");

        let changes = collect_git_changes("s-1", root.path(), ChangeMode::Branch).expect("changes");
        assert_eq!(changes.comparison, "main merge-base to working tree");
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path, "feature.txt");
        assert!(
            changes.files[0]
                .patch
                .as_deref()
                .unwrap()
                .contains("+feature")
        );
    }

    #[test]
    fn completed_tool_diffs_become_workspace_relative_patches() {
        let root = tempfile::tempdir().expect("root");
        fs::write(root.path().join("main.rs"), "new\n").expect("file");
        let absolute = root.path().join("main.rs");
        let update = json!({
            "sessionId": "s-1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": absolute,
                    "oldText": "old\n",
                    "newText": "new\n"
                }]
            }
        });
        let mut state = SessionReviewState::default();
        state.begin_turn();
        assert!(state.capture_update(root.path(), &update).changes_updated);
        state.finish_turn(None);
        let changes = state.last_turn_projection("s-1").expect("last turn");
        assert_eq!(changes.mode, ChangeMode::LastTurn);
        assert_eq!(changes.files[0].path, "main.rs");
        assert_eq!(changes.files[0].patch_state, PatchState::Complete);
        assert!(changes.files[0].patch.as_deref().unwrap().contains("-old"));
        assert!(changes.files[0].patch.as_deref().unwrap().contains("+new"));
    }

    #[test]
    fn a_diff_outside_the_workspace_is_never_projected() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let update = json!({
            "update": {
                "sessionUpdate": "tool_call_update",
                "status": "completed",
                "content": [{
                    "type": "diff",
                    "path": outside.path().join("secret"),
                    "oldText": "x",
                    "newText": "y"
                }]
            }
        });
        let mut state = SessionReviewState::default();
        state.begin_turn();
        assert!(state.capture_update(root.path(), &update).changes_updated);
        state.finish_turn(None);
        let changes = state.last_turn_projection("s-1").expect("last turn");
        assert!(changes.files.is_empty());
        assert!(!changes.complete);
    }

    #[test]
    fn a_mutating_tool_without_a_diff_marks_the_turn_partial() {
        let root = tempfile::tempdir().expect("root");
        let mut state = SessionReviewState::default();
        state.begin_turn();
        state.capture_update(
            root.path(),
            &json!({
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "kind": "execute",
                    "_meta": { "x.ai/tool": { "read_only": false } }
                }
            }),
        );
        let captured = state.capture_update(
            root.path(),
            &json!({
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tool-1",
                    "status": "completed",
                    "content": [{ "type": "content", "text": "done" }]
                }
            }),
        );
        assert!(captured.changes_updated);
        state.finish_turn(None);
        let changes = state.last_turn_projection("s-1").expect("last turn");
        assert!(!changes.complete);
        assert!(changes.files.is_empty());
    }
}
