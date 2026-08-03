//! Host session-graph overlay for user side chats (light ADR 0019).
//!
//! Edges only: parent → child role, title, and context clips. Transcripts stay
//! in GROK_HOME. The browser never supplies a filesystem path.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::bounds::{
    MAX_CLIP_BYTES, MAX_CLIPS_PER_SIDE, MAX_CLIPS_TOTAL_BYTES, MAX_SIDE_CHAT_TITLE_BYTES,
    MAX_SIDE_CHATS_PER_PARENT, truncate_utf8,
};

/// File holding side-chat edges inside the host state directory.
pub const SESSION_GRAPH_FILE_NAME: &str = "session_graph.json";

/// Role of a live / catalog session relative to the home rail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRole {
    /// Home-rail / WorkShell tab peer.
    #[default]
    Primary,
    /// User-created side chat under a parent primary.
    SideChat,
}

impl SessionRole {
    /// Wire value for projections (`primary` | `side_chat`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::SideChat => "side_chat",
        }
    }

    /// Whether this role is a side chat.
    #[must_use]
    pub const fn is_side_chat(self) -> bool {
        matches!(self, Self::SideChat)
    }
}

/// One context clip anchored on a side chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextClip {
    /// Opaque clip id (host-generated).
    pub clip_id: String,
    /// Selection / anchor text (bounded).
    pub text: String,
    /// Short chip label for the SPA.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional sequence of the parent message the text came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_seq: Option<u64>,
    /// Optional role of that message (`user` | `agent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
}

/// Durable edge: child side chat under a parent primary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideChatEdge {
    /// ACP session id of the side chat.
    pub child_session_id: String,
    /// ACP session id of the primary parent.
    pub parent_session_id: String,
    /// Always `side_chat` today; kept explicit for future roles.
    pub role: SessionRole,
    /// Display title (bounded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Context clips attached to this side chat.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clips: Vec<ContextClip>,
    /// Host clock when the edge was created.
    pub created_at_ms: u64,
}

/// On-disk shape of the graph file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphFile {
    #[serde(default)]
    edges: Vec<SideChatEdge>,
}

/// In-memory session graph (side-chat edges only for now).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionGraph {
    /// Child session id → edge.
    by_child: HashMap<String, SideChatEdge>,
}

/// Why a clip or edge could not be accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphError {
    /// Parent already has the maximum number of side chats.
    TooManySideChats,
    /// Clip count or total bytes exceeded.
    ClipLimit,
    /// Clip text empty after trim.
    EmptyClip,
    /// Unknown clip or child id.
    Unknown,
}

impl SessionGraph {
    /// Load from the host state directory; empty graph if missing.
    ///
    /// Corrupt files yield an empty graph rather than failing the host start.
    #[must_use]
    pub fn load(directory: &Path) -> Self {
        let path = directory.join(SESSION_GRAPH_FILE_NAME);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let Ok(file) = serde_json::from_str::<GraphFile>(&raw) else {
            return Self::default();
        };
        let mut graph = Self::default();
        for edge in file.edges {
            if edge.role.is_side_chat()
                && !edge.child_session_id.is_empty()
                && !edge.parent_session_id.is_empty()
            {
                graph.by_child.insert(edge.child_session_id.clone(), edge);
            }
        }
        graph
    }

    /// Persist owner-only into the host state directory.
    ///
    /// # Errors
    ///
    /// Returns IO errors from write/rename.
    pub fn persist(&self, directory: &Path) -> std::io::Result<()> {
        let path = directory.join(SESSION_GRAPH_FILE_NAME);
        let temporary = directory.join(format!("{SESSION_GRAPH_FILE_NAME}.tmp"));
        let mut edges: Vec<SideChatEdge> = self.by_child.values().cloned().collect();
        edges.sort_by(|left, right| {
            left.created_at_ms
                .cmp(&right.created_at_ms)
                .then_with(|| left.child_session_id.cmp(&right.child_session_id))
        });
        let file = GraphFile { edges };
        let encoded = serde_json::to_string_pretty(&file)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        write_private(&temporary, encoded.as_bytes())?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    }

    /// How many side chats are recorded under `parent_session_id`.
    #[must_use]
    pub fn side_chat_count(&self, parent_session_id: &str) -> usize {
        self.by_child
            .values()
            .filter(|edge| edge.parent_session_id == parent_session_id)
            .count()
    }

    /// Whether `session_id` is a known side-chat child.
    #[must_use]
    pub fn is_side_chat(&self, session_id: &str) -> bool {
        self.by_child.contains_key(session_id)
    }

    /// Parent id for a side chat child, if known.
    #[must_use]
    pub fn parent_of(&self, child_session_id: &str) -> Option<&str> {
        self.by_child
            .get(child_session_id)
            .map(|edge| edge.parent_session_id.as_str())
    }

    /// Edge for a child, if any.
    #[must_use]
    pub fn edge(&self, child_session_id: &str) -> Option<&SideChatEdge> {
        self.by_child.get(child_session_id)
    }

    /// Mutable edge for a child.
    pub fn edge_mut(&mut self, child_session_id: &str) -> Option<&mut SideChatEdge> {
        self.by_child.get_mut(child_session_id)
    }

    /// All side-chat edges under a parent, oldest first.
    #[must_use]
    pub fn children_of(&self, parent_session_id: &str) -> Vec<&SideChatEdge> {
        let mut edges: Vec<&SideChatEdge> = self
            .by_child
            .values()
            .filter(|edge| edge.parent_session_id == parent_session_id)
            .collect();
        edges.sort_by(|left, right| {
            left.created_at_ms
                .cmp(&right.created_at_ms)
                .then_with(|| left.child_session_id.cmp(&right.child_session_id))
        });
        edges
    }

    /// Child session ids under a parent (for cascade close).
    #[must_use]
    pub fn child_ids_of(&self, parent_session_id: &str) -> Vec<String> {
        self.children_of(parent_session_id)
            .into_iter()
            .map(|edge| edge.child_session_id.clone())
            .collect()
    }

    /// Insert a new side-chat edge after capacity checks.
    ///
    /// # Errors
    ///
    /// [`GraphError::TooManySideChats`] when the per-parent cap is reached.
    pub fn insert_side_chat(&mut self, edge: SideChatEdge) -> Result<(), GraphError> {
        if self.side_chat_count(&edge.parent_session_id) >= MAX_SIDE_CHATS_PER_PARENT
            && !self.by_child.contains_key(&edge.child_session_id)
        {
            return Err(GraphError::TooManySideChats);
        }
        self.by_child.insert(edge.child_session_id.clone(), edge);
        Ok(())
    }

    /// Remove a child edge (idempotent).
    pub fn remove_child(&mut self, child_session_id: &str) {
        self.by_child.remove(child_session_id);
    }

    /// Remove every edge whose parent is `parent_session_id`.
    pub fn remove_children_of(&mut self, parent_session_id: &str) {
        self.by_child
            .retain(|_, edge| edge.parent_session_id != parent_session_id);
    }
}

/// Browser-supplied clip before host id assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInput {
    /// Selection text.
    pub text: String,
    /// Optional short label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional parent message sequence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_message_seq: Option<u64>,
    /// Optional `user` | `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
}

/// Normalize and bound one clip body; host assigns `clip_id`.
///
/// # Errors
///
/// [`GraphError::EmptyClip`] when text is empty after trim.
pub fn normalize_clip(input: ClipInput, clip_id: String) -> Result<ContextClip, GraphError> {
    let trimmed = input.text.trim();
    if trimmed.is_empty() {
        return Err(GraphError::EmptyClip);
    }
    let (text, _) = truncate_utf8(trimmed, MAX_CLIP_BYTES);
    let label = input.label.as_ref().map(|raw| {
        let trimmed_label = raw.trim();
        if trimmed_label.is_empty() {
            clip_label_from_text(&text)
        } else {
            truncate_utf8(trimmed_label, MAX_SIDE_CHAT_TITLE_BYTES).0
        }
    });
    let label = label.or_else(|| Some(clip_label_from_text(&text)));
    let source_role = input.source_role.and_then(|role| {
        let lower = role.to_ascii_lowercase();
        match lower.as_str() {
            "user" | "agent" => Some(lower),
            _ => None,
        }
    });
    Ok(ContextClip {
        clip_id,
        text,
        label,
        source_message_seq: input.source_message_seq,
        source_role,
    })
}

/// Bound a batch of clips against count and total-byte caps.
///
/// # Errors
///
/// [`GraphError::ClipLimit`] or [`GraphError::EmptyClip`].
pub fn normalize_clips(
    inputs: Vec<ClipInput>,
    next_id: &mut u64,
) -> Result<Vec<ContextClip>, GraphError> {
    if inputs.len() > MAX_CLIPS_PER_SIDE {
        return Err(GraphError::ClipLimit);
    }
    let mut clips = Vec::with_capacity(inputs.len());
    let mut total = 0usize;
    for input in inputs {
        *next_id = next_id.saturating_add(1);
        let clip = normalize_clip(input, format!("clip-{next_id}"))?;
        total = total.saturating_add(clip.text.len());
        if total > MAX_CLIPS_TOTAL_BYTES {
            return Err(GraphError::ClipLimit);
        }
        clips.push(clip);
    }
    Ok(clips)
}

/// Append clips to an existing set under the same caps.
///
/// # Errors
///
/// Cap or empty-clip errors.
pub fn append_clips(
    existing: &mut Vec<ContextClip>,
    inputs: Vec<ContextClip>,
) -> Result<(), GraphError> {
    if existing.len().saturating_add(inputs.len()) > MAX_CLIPS_PER_SIDE {
        return Err(GraphError::ClipLimit);
    }
    let mut total: usize = existing.iter().map(|clip| clip.text.len()).sum();
    for clip in &inputs {
        total = total.saturating_add(clip.text.len());
        if total > MAX_CLIPS_TOTAL_BYTES {
            return Err(GraphError::ClipLimit);
        }
    }
    existing.extend(inputs);
    Ok(())
}

/// Short chip label from clip text.
#[must_use]
pub fn clip_label_from_text(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text).trim();
    let (label, _) = truncate_utf8(first_line, MAX_SIDE_CHAT_TITLE_BYTES);
    label
}

/// Bound an optional side-chat title.
#[must_use]
pub fn normalize_title(title: Option<String>) -> Option<String> {
    title.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(truncate_utf8(trimmed, MAX_SIDE_CHAT_TITLE_BYTES).0)
        }
    })
}

/// Compose the agent-visible prompt for a side chat with active clips.
///
/// The host owns this wrapper so the SPA cannot invent inconsistent injection.
#[must_use]
pub fn compose_side_prompt(clips: &[ContextClip], user_text: &str) -> String {
    if clips.is_empty() {
        return user_text.to_owned();
    }
    let mut body = String::from("<portable_side_context>\n");
    for clip in clips {
        body.push_str("\"\"\"\n");
        body.push_str(&clip.text);
        body.push_str("\n\"\"\"\n");
    }
    body.push_str("</portable_side_context>\n\n");
    body.push_str(user_text);
    body
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = std::fs::File::create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_wraps_clips_before_user_text() {
        let clips = vec![ContextClip {
            clip_id: "c1".into(),
            text: "cohorts and job roles".into(),
            label: Some("cohorts".into()),
            source_message_seq: Some(3),
            source_role: Some("agent".into()),
        }];
        let out = compose_side_prompt(&clips, "what data do we have?");
        assert!(out.contains("<portable_side_context>"));
        assert!(out.contains("cohorts and job roles"));
        assert!(out.ends_with("what data do we have?"));
    }

    #[test]
    fn compose_without_clips_is_passthrough() {
        assert_eq!(compose_side_prompt(&[], "hello"), "hello");
    }

    #[test]
    fn empty_clip_is_refused() {
        let err = normalize_clip(
            ClipInput {
                text: "   ".into(),
                label: None,
                source_message_seq: None,
                source_role: None,
            },
            "clip-1".into(),
        );
        assert_eq!(err, Err(GraphError::EmptyClip));
    }

    #[test]
    fn per_parent_cap_is_enforced() {
        let mut graph = SessionGraph::default();
        for index in 0..MAX_SIDE_CHATS_PER_PARENT {
            graph
                .insert_side_chat(SideChatEdge {
                    child_session_id: format!("c-{index}"),
                    parent_session_id: "p".into(),
                    role: SessionRole::SideChat,
                    title: None,
                    clips: Vec::new(),
                    created_at_ms: index as u64,
                })
                .expect("under cap");
        }
        let over = graph.insert_side_chat(SideChatEdge {
            child_session_id: "c-over".into(),
            parent_session_id: "p".into(),
            role: SessionRole::SideChat,
            title: None,
            clips: Vec::new(),
            created_at_ms: 99,
        });
        assert_eq!(over, Err(GraphError::TooManySideChats));
    }

    #[test]
    fn persist_round_trip() {
        let dir = tempfile::tempdir().expect("temp");
        let mut graph = SessionGraph::default();
        graph
            .insert_side_chat(SideChatEdge {
                child_session_id: "child".into(),
                parent_session_id: "parent".into(),
                role: SessionRole::SideChat,
                title: Some("Data on personas".into()),
                clips: vec![ContextClip {
                    clip_id: "clip-1".into(),
                    text: "cohorts".into(),
                    label: Some("cohorts".into()),
                    source_message_seq: None,
                    source_role: None,
                }],
                created_at_ms: 1,
            })
            .expect("insert");
        graph.persist(dir.path()).expect("persist");
        let loaded = SessionGraph::load(dir.path());
        assert!(loaded.is_side_chat("child"));
        assert_eq!(loaded.parent_of("child"), Some("parent"));
        assert_eq!(
            loaded.edge("child").and_then(|e| e.title.as_deref()),
            Some("Data on personas")
        );
    }
}
