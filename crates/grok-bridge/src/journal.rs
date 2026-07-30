//! Intent before effect, idempotency, the event cursor, and review records.
//!
//! This module carries the recovery invariants of `docs/light/protocol.md`:
//!
//! - intent is persisted before an effect is dispatched;
//! - a replayed idempotency key never executes twice;
//! - no ambiguous prompt or permission decision is retried automatically;
//! - an effect with no durable known outcome ends in `interrupted_needs_review`.
//!
//! The event cursor design follows `docs/decisions/0008-resumable-run-event-long-poll.md`;
//! the code is independent because that implementation carries Desktop policy.

use std::collections::VecDeque;

use crate::bounds::{
    MAX_EVENT_QUEUE_DEPTH, MAX_IDEMPOTENCY_RECORDS, MAX_INTERRUPTED_RECORDS, MAX_REPLAY_EVENTS,
};
use crate::protocol::{Event, EventEnvelope, PROTOCOL_VERSION};

/// Errors produced by the journal.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JournalError {
    /// The referenced effect record does not exist.
    #[error("unknown effect record")]
    UnknownEffect,
    /// The referenced review record does not exist.
    #[error("unknown review record")]
    UnknownReviewRecord,
    /// An acknowledgement referenced a sequence the host never emitted.
    #[error("acknowledged sequence is ahead of the emitted cursor")]
    AcknowledgementAhead,
    /// The durable journal could not be read or written.
    #[error("journal storage is unusable")]
    Storage,
}

/// Why an effect could not be confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptCause {
    /// The controlling tab was lost while a permission was pending.
    ControllerLost,
    /// The agent process died mid-turn.
    AgentExit,
    /// The host restarted after persisting intent.
    HostRestart,
    /// A decision timed out without a confirmable result.
    DecisionTimeout,
}

impl InterruptCause {
    /// Stable machine-readable name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ControllerLost => "controller_lost",
            Self::AgentExit => "agent_exit",
            Self::HostRestart => "host_restart",
            Self::DecisionTimeout => "decision_timeout",
        }
    }

    /// Read a cause back from its stable name.
    ///
    /// An unknown name yields `None` so a corrupted record is dropped rather
    /// than shown to the user with an invented reason.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "controller_lost" => Some(Self::ControllerLost),
            "agent_exit" => Some(Self::AgentExit),
            "host_restart" => Some(Self::HostRestart),
            "decision_timeout" => Some(Self::DecisionTimeout),
            _ => None,
        }
    }
}

/// Lifecycle of one side-effecting command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectState {
    /// Intent is durable; the effect may or may not have been applied.
    Intended,
    /// The effect completed with a known outcome.
    Completed,
    /// The outcome is unknown and requires human review.
    Interrupted,
}

/// What the caller should do after registering an intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    /// First time this key was seen. The caller may dispatch.
    Dispatch,
    /// The key was already completed. Return the original result.
    AlreadyCompleted,
    /// The key is in flight or ambiguous. The caller must not dispatch again.
    DoNotReplay(EffectState),
    /// Intent could not be written down, so the effect must not run.
    ///
    /// Refusing is the safe half of intent-before-effect. Dispatching anyway
    /// would create exactly the situation the invariant exists to prevent: a
    /// side effect in the user's workspace that the host has no record of and
    /// could never raise for review.
    NotDurable,
}

#[derive(Debug, Clone)]
struct EffectRecord {
    key: String,
    operation: &'static str,
    /// Conversation the effect belonged to, carried so an interruption can
    /// name it long after the command itself is gone.
    session_id: Option<String>,
    state: EffectState,
}

/// A durable record of an effect whose outcome could not be confirmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptedRecord {
    /// Opaque record identifier.
    pub record_id: String,
    /// Name of the operation. Never carries payload data.
    pub operation: &'static str,
    /// The conversation that was left unresolved, when the effect belonged to
    /// one. With sessions running concurrently (light ADR 0011) a record that
    /// cannot name its conversation tells the user something was interrupted
    /// without saying where to go and look.
    pub session_id: Option<String>,
    /// Why the outcome is unknown.
    pub cause: InterruptCause,
    /// Whether the user has reviewed the record.
    pub acknowledged: bool,
}

/// Result of asking for events after a reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayOutcome {
    /// Bounded replay is possible; these events follow the cursor.
    Replay(Vec<EventEnvelope>),
    /// The cursor is too old. The caller must send a snapshot.
    SnapshotRequired,
}

/// File holding the part of the journal that must outlive the process.
pub const JOURNAL_FILE_NAME: &str = "journal.json";

/// On-disk form of the journal.
///
/// Only intents and review records are written. Events are deliberately left
/// out: they carry message text, and a review record is defined by section 7.5
/// to hold no prompt, file, or tool output body. A browser reconnecting after
/// a restart is given a snapshot anyway, so nothing is lost by forgetting the
/// replay buffer.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJournal {
    version: u32,
    next_record: u64,
    effects: Vec<StoredEffect>,
    interrupted: Vec<StoredInterrupted>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEffect {
    key: String,
    operation: String,
    #[serde(default)]
    session_id: Option<String>,
    state: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredInterrupted {
    record_id: String,
    operation: String,
    #[serde(default)]
    session_id: Option<String>,
    cause: String,
    acknowledged: bool,
}

const STORED_VERSION: u32 = 1;

impl EffectState {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Intended => "intended",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "intended" => Some(Self::Intended),
            "completed" => Some(Self::Completed),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }
}

/// Per-installation journal of intents, events, and review records.
#[derive(Debug, Default)]
pub struct Journal {
    effects: VecDeque<EffectRecord>,
    events: VecDeque<EventEnvelope>,
    interrupted: VecDeque<InterruptedRecord>,
    next_sequence: u64,
    acked_through: u64,
    next_record: u64,
    /// Where intents are written. `None` keeps the journal in memory, which is
    /// what tests and read-only callers want.
    store: Option<std::path::PathBuf>,
}

impl Journal {
    /// Create an empty journal that keeps nothing across a restart.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Open the durable journal in a state directory, reconciling what it finds.
    ///
    /// Any intent still recorded as `Intended` belonged to an effect that was
    /// dispatched by a host that did not survive to classify it. Its outcome is
    /// unknowable from here, so it becomes a review record with
    /// [`InterruptCause::HostRestart`] instead of being resumed or discarded.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::Storage`] when the directory cannot be read or
    /// the reconciled state cannot be written back. Starting without a durable
    /// journal is refused rather than silently downgraded to memory.
    pub fn open(directory: &std::path::Path) -> Result<Self, JournalError> {
        let path = directory.join(JOURNAL_FILE_NAME);
        let mut journal = match std::fs::read_to_string(&path) {
            Ok(raw) => Self::from_stored(
                serde_json::from_str::<StoredJournal>(&raw).map_err(|_| JournalError::Storage)?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(_) => return Err(JournalError::Storage),
        };
        journal.store = Some(path);
        journal.reconcile_after_restart();
        journal.flush()?;
        Ok(journal)
    }

    fn from_stored(stored: StoredJournal) -> Self {
        if stored.version != STORED_VERSION {
            // A journal this build cannot read is not guessed at. Starting
            // empty loses review records, so the file is left in place for
            // inspection and the host begins with nothing rather than with
            // records it may be misreading.
            return Self::default();
        }
        let effects = stored
            .effects
            .into_iter()
            .filter_map(|record| {
                Some(EffectRecord {
                    key: record.key,
                    operation: crate::protocol::operation_name(&record.operation)?,
                    session_id: record.session_id,
                    state: EffectState::from_name(&record.state)?,
                })
            })
            .collect();
        let interrupted = stored
            .interrupted
            .into_iter()
            .filter_map(|record| {
                Some(InterruptedRecord {
                    record_id: record.record_id,
                    operation: crate::protocol::operation_name(&record.operation)?,
                    session_id: record.session_id,
                    cause: InterruptCause::from_name(&record.cause)?,
                    acknowledged: record.acknowledged,
                })
            })
            .collect();
        Self {
            effects,
            interrupted,
            next_record: stored.next_record,
            ..Self::default()
        }
    }

    /// Turn every unresolved intent into a review record.
    ///
    /// The agent process is shared by every session (light ADR 0011), so when
    /// it dies each conversation that had work in flight is left ambiguous,
    /// not just the one on screen. Each gets its own record.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::Storage`] when the records cannot be written.
    pub fn interrupt_all_intended(&mut self, cause: InterruptCause) -> Result<usize, JournalError> {
        let raised = self.raise_unresolved(cause);
        self.flush()?;
        Ok(raised)
    }

    /// Turn every unresolved intent into a review record.
    fn reconcile_after_restart(&mut self) {
        self.raise_unresolved(InterruptCause::HostRestart);
    }

    /// Mark every `Intended` effect interrupted, and open a record for each.
    fn raise_unresolved(&mut self, cause: InterruptCause) -> usize {
        let orphaned: Vec<(&'static str, Option<String>)> = self
            .effects
            .iter_mut()
            .filter(|record| record.state == EffectState::Intended)
            .map(|record| {
                record.state = EffectState::Interrupted;
                (record.operation, record.session_id.clone())
            })
            .collect();
        let raised = orphaned.len();

        for (operation, session_id) in orphaned {
            self.next_record = self.next_record.saturating_add(1);
            if self.interrupted.len() >= MAX_INTERRUPTED_RECORDS {
                self.interrupted.pop_front();
            }
            self.interrupted.push_back(InterruptedRecord {
                record_id: format!("ir-{}", self.next_record),
                operation,
                session_id,
                cause,
                acknowledged: false,
            });
        }
        raised
    }

    /// Write the durable half out, atomically. A memory-only journal is a no-op.
    fn flush(&self) -> Result<(), JournalError> {
        use std::io::Write as _;

        let Some(path) = self.store.as_deref() else {
            return Ok(());
        };
        let directory = path.parent().ok_or(JournalError::Storage)?;
        let temporary = path.with_extension("json.tmp");

        let stored = StoredJournal {
            version: STORED_VERSION,
            next_record: self.next_record,
            effects: self
                .effects
                .iter()
                .map(|record| StoredEffect {
                    key: record.key.clone(),
                    operation: record.operation.to_owned(),
                    session_id: record.session_id.clone(),
                    state: record.state.as_str().to_owned(),
                })
                .collect(),
            interrupted: self
                .interrupted
                .iter()
                .map(|record| StoredInterrupted {
                    record_id: record.record_id.clone(),
                    operation: record.operation.to_owned(),
                    session_id: record.session_id.clone(),
                    cause: record.cause.as_str().to_owned(),
                    acknowledged: record.acknowledged,
                })
                .collect(),
        };
        let encoded = serde_json::to_string(&stored).map_err(|_| JournalError::Storage)?;

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| JournalError::Storage)?;
        file.write_all(encoded.as_bytes())
            .map_err(|_| JournalError::Storage)?;
        file.sync_all().map_err(|_| JournalError::Storage)?;
        #[cfg(windows)]
        {
            crate::win_acl::set_owner_only(&temporary).map_err(|_| JournalError::Storage)?;
        }
        std::fs::rename(&temporary, path).map_err(|_| JournalError::Storage)?;
        #[cfg(windows)]
        {
            let _ = crate::win_acl::set_owner_only(path);
        }

        // The rename itself has to reach the disk, otherwise a power loss can
        // leave the directory entry behind and lose an intent the host has
        // already told the agent to act on.
        if let Ok(handle) = std::fs::File::open(directory) {
            let _ = handle.sync_all();
        }
        Ok(())
    }

    /// Register intent for a side-effecting command before dispatching it.
    ///
    /// This is the only entry point that may precede an effect. A key that is
    /// already known is never dispatched again.
    pub fn begin(
        &mut self,
        idempotency_key: &str,
        operation: &'static str,
        session_id: Option<&str>,
    ) -> BeginOutcome {
        if let Some(existing) = self
            .effects
            .iter()
            .find(|record| record.key == idempotency_key)
        {
            return match existing.state {
                EffectState::Completed => BeginOutcome::AlreadyCompleted,
                EffectState::Intended => BeginOutcome::DoNotReplay(EffectState::Intended),
                EffectState::Interrupted => BeginOutcome::DoNotReplay(EffectState::Interrupted),
            };
        }
        if self.effects.len() >= MAX_IDEMPOTENCY_RECORDS {
            self.effects.pop_front();
        }
        self.effects.push_back(EffectRecord {
            key: idempotency_key.to_owned(),
            operation,
            session_id: session_id.map(str::to_owned),
            state: EffectState::Intended,
        });

        // The write happens here, before the caller is told to dispatch, so
        // there is no window in which an effect can run without a durable
        // intent behind it. A failed write withdraws the record and refuses.
        if self.flush().is_err() {
            self.effects.pop_back();
            return BeginOutcome::NotDurable;
        }
        BeginOutcome::Dispatch
    }

    /// Mark an effect as completed with a known outcome.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::UnknownEffect`] when the key was never begun.
    pub fn complete(&mut self, idempotency_key: &str) -> Result<(), JournalError> {
        let record = self
            .effects
            .iter_mut()
            .find(|record| record.key == idempotency_key)
            .ok_or(JournalError::UnknownEffect)?;
        record.state = EffectState::Completed;
        // A resolved effect must stop looking unresolved, otherwise the next
        // start would raise it for review as though it had been interrupted.
        self.flush()
    }

    /// Mark an effect as ambiguous and open a review record.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::UnknownEffect`] when the key was never begun.
    pub fn interrupt(
        &mut self,
        idempotency_key: &str,
        cause: InterruptCause,
    ) -> Result<String, JournalError> {
        let record = self
            .effects
            .iter_mut()
            .find(|record| record.key == idempotency_key)
            .ok_or(JournalError::UnknownEffect)?;
        record.state = EffectState::Interrupted;
        let operation = record.operation;
        let session_id = record.session_id.clone();

        self.next_record = self.next_record.saturating_add(1);
        let record_id = format!("ir-{}", self.next_record);
        if self.interrupted.len() >= MAX_INTERRUPTED_RECORDS {
            self.interrupted.pop_front();
        }
        self.interrupted.push_back(InterruptedRecord {
            record_id: record_id.clone(),
            operation,
            session_id,
            cause,
            acknowledged: false,
        });
        self.flush()?;
        Ok(record_id)
    }

    /// Current state of an effect, if known.
    #[must_use]
    pub fn effect_state(&self, idempotency_key: &str) -> Option<EffectState> {
        self.effects
            .iter()
            .find(|record| record.key == idempotency_key)
            .map(|record| record.state.clone())
    }

    /// Review records that the user has not yet acknowledged.
    #[must_use]
    pub fn pending_reviews(&self) -> Vec<&InterruptedRecord> {
        self.interrupted
            .iter()
            .filter(|record| !record.acknowledged)
            .collect()
    }

    /// Mark a review record as reviewed. Never retries the effect.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::UnknownReviewRecord`] when the id is unknown.
    pub fn acknowledge_interrupted(&mut self, record_id: &str) -> Result<(), JournalError> {
        let record = self
            .interrupted
            .iter_mut()
            .find(|record| record.record_id == record_id)
            .ok_or(JournalError::UnknownReviewRecord)?;
        record.acknowledged = true;
        self.flush()
    }

    /// Discard an acknowledged review record.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::UnknownReviewRecord`] when the id is unknown or
    /// has not been acknowledged.
    pub fn discard_interrupted(&mut self, record_id: &str) -> Result<(), JournalError> {
        let position = self
            .interrupted
            .iter()
            .position(|record| record.record_id == record_id && record.acknowledged)
            .ok_or(JournalError::UnknownReviewRecord)?;
        self.interrupted.remove(position);
        self.flush()
    }

    /// Append an event and assign it the next monotonic sequence.
    pub fn record_event(&mut self, event: Event, session_revision: Option<u64>) -> EventEnvelope {
        self.next_sequence = self.next_sequence.saturating_add(1);
        let envelope = EventEnvelope {
            protocol_version: PROTOCOL_VERSION,
            event_sequence: self.next_sequence,
            session_revision,
            event,
        };
        if self.events.len() >= MAX_EVENT_QUEUE_DEPTH {
            self.events.pop_front();
        }
        self.events.push_back(envelope.clone());
        envelope
    }

    /// Highest sequence emitted so far.
    #[must_use]
    pub const fn emitted_through(&self) -> u64 {
        self.next_sequence
    }

    /// Highest sequence the browser has acknowledged.
    #[must_use]
    pub const fn acknowledged_through(&self) -> u64 {
        self.acked_through
    }

    /// Record a cumulative acknowledgement from the browser.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError::AcknowledgementAhead`] when the browser claims a
    /// sequence the host never emitted.
    pub fn acknowledge(&mut self, through_sequence: u64) -> Result<(), JournalError> {
        if through_sequence > self.next_sequence {
            return Err(JournalError::AcknowledgementAhead);
        }
        self.acked_through = self.acked_through.max(through_sequence);
        self.events.retain(|event| {
            event.event_sequence
                > self
                    .acked_through
                    .saturating_sub(u64::try_from(MAX_REPLAY_EVENTS).unwrap_or(u64::MAX))
        });
        Ok(())
    }

    /// Events after `last_acked`, or a snapshot requirement when too old.
    #[must_use]
    pub fn replay_after(&self, last_acked: u64) -> ReplayOutcome {
        if last_acked > self.next_sequence {
            return ReplayOutcome::SnapshotRequired;
        }
        let oldest_retained = self.events.front().map(|event| event.event_sequence);
        match oldest_retained {
            None => {
                if last_acked == self.next_sequence {
                    ReplayOutcome::Replay(Vec::new())
                } else {
                    ReplayOutcome::SnapshotRequired
                }
            }
            Some(oldest) => {
                if last_acked.saturating_add(1) < oldest {
                    return ReplayOutcome::SnapshotRequired;
                }
                ReplayOutcome::Replay(
                    self.events
                        .iter()
                        .filter(|event| event.event_sequence > last_acked)
                        .cloned()
                        .collect(),
                )
            }
        }
    }

    /// Mark every in-flight intent as ambiguous, opening review records.
    ///
    /// Called when the controlling tab or the agent process is lost, so that
    /// nothing in flight is silently retried later.
    pub fn interrupt_all_in_flight(&mut self, cause: InterruptCause) -> Vec<String> {
        let keys: Vec<String> = self
            .effects
            .iter()
            .filter(|record| record.state == EffectState::Intended)
            .map(|record| record.key.clone())
            .collect();
        keys.iter()
            .filter_map(|key| self.interrupt(key, cause).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{BeginOutcome, EffectState, InterruptCause, Journal, JournalError, ReplayOutcome};
    use crate::bounds::MAX_REPLAY_EVENTS;
    use crate::protocol::Event;

    fn delta(text: &str) -> Event {
        Event::MessageDelta {
            session_id: "s-1".into(),
            text: text.into(),
        }
    }

    #[test]
    fn first_intent_dispatches() {
        let mut journal = Journal::new();
        assert_eq!(
            journal.begin("key-1", "Prompt", Some("s-1")),
            BeginOutcome::Dispatch
        );
        assert_eq!(journal.effect_state("key-1"), Some(EffectState::Intended));
    }

    #[test]
    fn a_replayed_key_never_dispatches_twice() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        assert_eq!(
            journal.begin("key-1", "Prompt", Some("s-1")),
            BeginOutcome::DoNotReplay(EffectState::Intended)
        );
    }

    #[test]
    fn a_completed_key_returns_the_original_result() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        journal.complete("key-1").expect("complete");
        assert_eq!(
            journal.begin("key-1", "Prompt", Some("s-1")),
            BeginOutcome::AlreadyCompleted
        );
    }

    #[test]
    fn reconnect_does_not_duplicate_a_prompt() {
        // The browser reconnects and retries the same prompt with the same key.
        let mut journal = Journal::new();
        assert_eq!(
            journal.begin("prompt-1", "Prompt", Some("s-1")),
            BeginOutcome::Dispatch
        );
        // Connection drops before completion; the browser retries.
        assert_eq!(
            journal.begin("prompt-1", "Prompt", Some("s-1")),
            BeginOutcome::DoNotReplay(EffectState::Intended)
        );
        // And after the outcome becomes ambiguous it still never dispatches.
        journal
            .interrupt("prompt-1", InterruptCause::AgentExit)
            .expect("interrupt");
        assert_eq!(
            journal.begin("prompt-1", "Prompt", Some("s-1")),
            BeginOutcome::DoNotReplay(EffectState::Interrupted)
        );
    }

    #[test]
    fn a_permission_decision_is_not_repeated_after_timeout() {
        let mut journal = Journal::new();
        journal.begin("decide-1", "DecidePermission", Some("s-1"));
        journal
            .interrupt("decide-1", InterruptCause::DecisionTimeout)
            .expect("interrupt");
        assert_eq!(
            journal.begin("decide-1", "DecidePermission", Some("s-1")),
            BeginOutcome::DoNotReplay(EffectState::Interrupted)
        );
    }

    #[test]
    fn an_ambiguous_effect_opens_a_review_record() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        let record_id = journal
            .interrupt("key-1", InterruptCause::ControllerLost)
            .expect("interrupt");
        let pending = journal.pending_reviews();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].record_id, record_id);
        assert_eq!(pending[0].operation, "Prompt");
        assert_eq!(pending[0].cause, InterruptCause::ControllerLost);
        assert!(!pending[0].acknowledged);
    }

    #[test]
    fn review_records_carry_no_payload() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        journal
            .interrupt("key-1", InterruptCause::AgentExit)
            .expect("interrupt");
        let rendered = format!("{:?}", journal.pending_reviews());
        assert!(rendered.contains("Prompt"));
        assert!(
            !rendered.contains("key-1"),
            "records must not echo payload keys"
        );
    }

    #[test]
    fn acknowledge_does_not_retry_and_clears_from_pending() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        let record_id = journal
            .interrupt("key-1", InterruptCause::HostRestart)
            .expect("interrupt");
        journal.acknowledge_interrupted(&record_id).expect("ack");
        assert!(journal.pending_reviews().is_empty());
        // The effect stays interrupted: acknowledging is not resolving.
        assert_eq!(
            journal.effect_state("key-1"),
            Some(EffectState::Interrupted)
        );
        assert_eq!(
            journal.begin("key-1", "Prompt", Some("s-1")),
            BeginOutcome::DoNotReplay(EffectState::Interrupted)
        );
    }

    #[test]
    fn discard_requires_prior_acknowledgement() {
        let mut journal = Journal::new();
        journal.begin("key-1", "Prompt", Some("s-1"));
        let record_id = journal
            .interrupt("key-1", InterruptCause::AgentExit)
            .expect("interrupt");
        assert_eq!(
            journal.discard_interrupted(&record_id),
            Err(JournalError::UnknownReviewRecord)
        );
        journal.acknowledge_interrupted(&record_id).expect("ack");
        assert!(journal.discard_interrupted(&record_id).is_ok());
    }

    #[test]
    fn losing_the_controller_interrupts_everything_in_flight() {
        let mut journal = Journal::new();
        journal.begin("a", "Prompt", Some("s-1"));
        journal.begin("b", "DecidePermission", Some("s-1"));
        journal.begin("c", "Prompt", Some("s-1"));
        journal.complete("c").expect("complete");

        let opened = journal.interrupt_all_in_flight(InterruptCause::ControllerLost);
        assert_eq!(opened.len(), 2);
        assert_eq!(journal.effect_state("a"), Some(EffectState::Interrupted));
        assert_eq!(journal.effect_state("b"), Some(EffectState::Interrupted));
        // A completed effect is untouched.
        assert_eq!(journal.effect_state("c"), Some(EffectState::Completed));
    }

    #[test]
    fn unknown_effect_cannot_be_completed_or_interrupted() {
        let mut journal = Journal::new();
        assert_eq!(journal.complete("nope"), Err(JournalError::UnknownEffect));
        assert_eq!(
            journal.interrupt("nope", InterruptCause::AgentExit),
            Err(JournalError::UnknownEffect)
        );
    }

    #[test]
    fn events_get_monotonic_sequences() {
        let mut journal = Journal::new();
        let first = journal.record_event(delta("a"), None);
        let second = journal.record_event(delta("b"), Some(3));
        assert_eq!(first.event_sequence, 1);
        assert_eq!(second.event_sequence, 2);
        assert_eq!(second.session_revision, Some(3));
        assert_eq!(journal.emitted_through(), 2);
    }

    #[test]
    fn replay_returns_events_after_the_cursor() {
        let mut journal = Journal::new();
        journal.record_event(delta("a"), None);
        journal.record_event(delta("b"), None);
        journal.record_event(delta("c"), None);

        match journal.replay_after(1) {
            ReplayOutcome::Replay(events) => {
                assert_eq!(events.len(), 2);
                assert_eq!(events[0].event_sequence, 2);
                assert_eq!(events[1].event_sequence, 3);
            }
            ReplayOutcome::SnapshotRequired => panic!("replay should be possible"),
        }
    }

    #[test]
    fn replay_from_the_head_is_empty_not_a_snapshot() {
        let mut journal = Journal::new();
        journal.record_event(delta("a"), None);
        assert_eq!(journal.replay_after(1), ReplayOutcome::Replay(Vec::new()));
    }

    #[test]
    fn an_acknowledgement_ahead_of_the_cursor_is_rejected() {
        let mut journal = Journal::new();
        journal.record_event(delta("a"), None);
        assert_eq!(
            journal.acknowledge(5),
            Err(JournalError::AcknowledgementAhead)
        );
    }

    #[test]
    fn acknowledgement_is_monotonic() {
        let mut journal = Journal::new();
        journal.record_event(delta("a"), None);
        journal.record_event(delta("b"), None);
        journal.acknowledge(2).expect("ack");
        journal.acknowledge(1).expect("older ack is ignored");
        assert_eq!(journal.acknowledged_through(), 2);
    }

    #[test]
    fn an_expired_cursor_requires_a_snapshot() {
        let mut journal = Journal::new();
        for index in 0..(MAX_REPLAY_EVENTS + 200) {
            journal.record_event(delta(&format!("e{index}")), None);
        }
        // Acknowledge near the head so the retention window drops old events.
        let head = journal.emitted_through();
        journal.acknowledge(head).expect("ack");
        assert_eq!(journal.replay_after(1), ReplayOutcome::SnapshotRequired);
    }

    #[test]
    fn a_cursor_beyond_the_head_requires_a_snapshot() {
        let mut journal = Journal::new();
        journal.record_event(delta("a"), None);
        assert_eq!(journal.replay_after(99), ReplayOutcome::SnapshotRequired);
    }

    #[test]
    fn an_empty_journal_replays_nothing() {
        let journal = Journal::new();
        assert_eq!(journal.replay_after(0), ReplayOutcome::Replay(Vec::new()));
    }
}
