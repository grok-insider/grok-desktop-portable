//! Intent has to survive the process that recorded it.
//!
//! The recovery invariants say a non-idempotent effect dispatched without a
//! durable known outcome ends in `interrupted_needs_review`, and section 7.5
//! names a host that died after persisting intent as one way in. Both are
//! claims about what is on disk, so these tests restart the journal rather
//! than inspecting the live one.

use grok_bridge::journal::{BeginOutcome, EffectState, InterruptCause, JOURNAL_FILE_NAME, Journal};

fn state_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

#[test]
fn an_intent_outlives_the_process_that_recorded_it() {
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        assert_eq!(
            journal.begin("k-1", "Prompt", Some("s-1")),
            BeginOutcome::Dispatch
        );
        journal.complete("k-1").expect("complete");
    }

    let reopened = Journal::open(root.path()).expect("reopen");
    assert_eq!(
        reopened.effect_state("k-1"),
        Some(EffectState::Completed),
        "a finished effect must still be known after a restart"
    );
}

#[test]
fn a_completed_effect_is_never_run_again_after_a_restart() {
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "Prompt", Some("s-1"));
        journal.complete("k-1").expect("complete");
    }

    let mut reopened = Journal::open(root.path()).expect("reopen");
    assert_eq!(
        reopened.begin("k-1", "Prompt", Some("s-1")),
        BeginOutcome::AlreadyCompleted,
        "a restart must not turn a replayed key back into a fresh dispatch"
    );
}

#[test]
fn an_intent_left_unresolved_by_a_crash_becomes_a_review_record() {
    let root = state_dir();

    {
        // Intent recorded, then the host disappears before classifying it.
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "Prompt", Some("s-1"));
    }

    let reopened = Journal::open(root.path()).expect("reopen");
    let pending = reopened.pending_reviews();
    assert_eq!(pending.len(), 1, "the orphaned intent must be raised");
    assert_eq!(pending[0].operation, "Prompt");
    assert_eq!(pending[0].cause, InterruptCause::HostRestart);
    assert!(!pending[0].acknowledged);
}

#[test]
fn an_interrupted_effect_is_never_replayed_after_a_restart() {
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "Prompt", Some("s-1"));
    }

    let mut reopened = Journal::open(root.path()).expect("reopen");
    // This is the whole point: the user's workspace may already carry the
    // effect, so the same key must not run a second time.
    assert_eq!(
        reopened.begin("k-1", "Prompt", Some("s-1")),
        BeginOutcome::DoNotReplay(EffectState::Interrupted)
    );
}

#[test]
fn a_second_restart_does_not_raise_the_same_intent_twice() {
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "Prompt", Some("s-1"));
    }
    Journal::open(root.path()).expect("first reopen");

    let third = Journal::open(root.path()).expect("second reopen");
    assert_eq!(
        third.pending_reviews().len(),
        1,
        "reconciliation must be idempotent, or restarts would pile up records"
    );
}

#[test]
fn acknowledging_a_review_record_survives_a_restart() {
    let root = state_dir();
    let record_id = {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "Prompt", Some("s-1"));
        drop(journal);

        let mut reopened = Journal::open(root.path()).expect("reopen");
        let id = reopened.pending_reviews()[0].record_id.clone();
        reopened.acknowledge_interrupted(&id).expect("acknowledge");
        id
    };

    let after = Journal::open(root.path()).expect("reopen again");
    assert!(
        after.pending_reviews().is_empty(),
        "an acknowledged record must not come back demanding review"
    );
    // Acknowledged, not resolved: the record is still there to be discarded.
    let mut after = after;
    after.discard_interrupted(&record_id).expect("discard");
}

#[test]
fn the_journal_file_is_owner_only() {
    let root = state_dir();
    let mut journal = Journal::open(root.path()).expect("open");
    journal.begin("k-1", "Prompt", Some("s-1"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(root.path().join(JOURNAL_FILE_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the journal names what the host did");
    }
}

#[test]
fn no_prompt_text_is_ever_written_to_disk() {
    // Section 7.5: a review record holds no prompt, file, or tool output body.
    let root = state_dir();
    let mut journal = Journal::open(root.path()).expect("open");
    journal.begin("k-1", "Prompt", Some("s-1"));
    journal.record_event(
        grok_bridge::protocol::Event::MessageDelta {
            session_id: "s-1".into(),
            text: "sensitive-transcript-content".into(),
        },
        None,
    );
    journal
        .interrupt("k-1", InterruptCause::AgentExit)
        .expect("interrupt");

    let raw = std::fs::read_to_string(root.path().join(JOURNAL_FILE_NAME)).expect("read");
    assert!(
        !raw.contains("sensitive-transcript-content"),
        "the journal must record that something happened, not what was said"
    );
}

#[test]
fn a_journal_from_an_unknown_version_is_not_guessed_at() {
    let root = state_dir();
    std::fs::write(
        root.path().join(JOURNAL_FILE_NAME),
        r#"{"version":99,"nextRecord":7,"effects":[],"interrupted":[]}"#,
    )
    .expect("write");

    let journal = Journal::open(root.path()).expect("open");
    assert!(journal.pending_reviews().is_empty());
    assert_eq!(journal.effect_state("k-1"), None);
}

#[test]
fn a_corrupted_journal_refuses_to_start_rather_than_losing_intent() {
    let root = state_dir();
    std::fs::write(root.path().join(JOURNAL_FILE_NAME), "{not json").expect("write");

    // Starting empty here would silently drop review records the user is owed.
    assert!(Journal::open(root.path()).is_err());
}

#[test]
fn an_operation_name_this_build_lacks_is_dropped() {
    let root = state_dir();
    std::fs::write(
        root.path().join(JOURNAL_FILE_NAME),
        r#"{"version":1,"nextRecord":1,"effects":[
             {"key":"k-1","operation":"NotAnOperation","state":"intended"}
           ],"interrupted":[]}"#,
    )
    .expect("write");

    let journal = Journal::open(root.path()).expect("open");
    assert_eq!(journal.effect_state("k-1"), None);
    assert!(
        journal.pending_reviews().is_empty(),
        "an unreadable record must not be shown to the user as a real one"
    );
}

#[test]
fn a_journal_with_nowhere_to_write_refuses_the_effect() {
    let root = state_dir();
    let mut journal = Journal::open(root.path()).expect("open");

    // The state directory disappears underneath a running host.
    std::fs::remove_dir_all(root.path()).expect("remove");

    assert_eq!(
        journal.begin("k-1", "Prompt", Some("s-1")),
        BeginOutcome::NotDurable,
        "an effect must not run when its intent cannot be written down"
    );
    assert_eq!(
        journal.effect_state("k-1"),
        None,
        "a refused intent must not linger as though it had been dispatched"
    );
}

#[test]
fn an_orphaned_intent_names_the_conversation_it_belonged_to() {
    // With sessions running concurrently, "something was interrupted" is not
    // actionable. The user needs to know which conversation to go and check.
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-a", "Prompt", Some("session-a"));
        journal.begin("k-b", "Prompt", Some("session-b"));
        journal.complete("k-b").expect("complete b");
    }

    let reopened = Journal::open(root.path()).expect("reopen");
    let pending = reopened.pending_reviews();
    assert_eq!(pending.len(), 1, "only the unresolved one is raised");
    assert_eq!(pending[0].session_id.as_deref(), Some("session-a"));
    assert_eq!(pending[0].cause, InterruptCause::HostRestart);
}

#[test]
fn each_interrupted_conversation_gets_its_own_record() {
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-a", "Prompt", Some("session-a"));
        journal.begin("k-b", "Prompt", Some("session-b"));
    }

    let reopened = Journal::open(root.path()).expect("reopen");
    let mut named: Vec<String> = reopened
        .pending_reviews()
        .into_iter()
        .filter_map(|record| record.session_id.clone())
        .collect();
    named.sort();
    assert_eq!(named, vec!["session-a", "session-b"]);
}

#[test]
fn an_effect_that_belongs_to_no_conversation_says_so() {
    // Not every side effect is a turn: enrolling or revoking a workspace has
    // no session, and inventing one would point the user at nothing.
    let root = state_dir();

    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-1", "RemoveWorkspace", None);
    }

    let reopened = Journal::open(root.path()).expect("reopen");
    assert_eq!(reopened.pending_reviews()[0].session_id, None);
}

#[test]
fn a_journal_written_before_sessions_were_named_still_loads() {
    // The stored form gained a field. An older file must still open, with the
    // conversation simply unknown, rather than being discarded.
    let root = state_dir();
    std::fs::write(
        root.path().join(JOURNAL_FILE_NAME),
        r#"{"version":1,"nextRecord":1,"effects":[
             {"key":"k-1","operation":"Prompt","state":"intended"}
           ],"interrupted":[]}"#,
    )
    .expect("write");

    let journal = Journal::open(root.path()).expect("open");
    let pending = journal.pending_reviews();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].session_id, None);
}

#[test]
fn an_agent_death_raises_one_record_per_unresolved_conversation() {
    // One agent process holds every session, so its death leaves each
    // conversation with work in flight ambiguous — not just the one on screen.
    let root = state_dir();
    let mut journal = Journal::open(root.path()).expect("open");
    journal.begin("k-a", "Prompt", Some("session-a"));
    journal.begin("k-b", "Prompt", Some("session-b"));
    journal.begin("k-done", "Prompt", Some("session-c"));
    journal.complete("k-done").expect("complete");

    let raised = journal
        .interrupt_all_intended(InterruptCause::AgentExit)
        .expect("raise");

    assert_eq!(raised, 2, "only the unresolved ones are raised");
    let mut named: Vec<String> = journal
        .pending_reviews()
        .into_iter()
        .filter_map(|record| record.session_id.clone())
        .collect();
    named.sort();
    assert_eq!(named, vec!["session-a", "session-b"]);
    assert!(
        journal
            .pending_reviews()
            .iter()
            .all(|record| record.cause == InterruptCause::AgentExit)
    );
}

#[test]
fn an_agent_death_is_recorded_durably_and_never_replayed() {
    let root = state_dir();
    {
        let mut journal = Journal::open(root.path()).expect("open");
        journal.begin("k-a", "Prompt", Some("session-a"));
        journal
            .interrupt_all_intended(InterruptCause::AgentExit)
            .expect("raise");
    }

    let mut reopened = Journal::open(root.path()).expect("reopen");
    // A restart must not re-raise it as a host restart, and must not let the
    // same key dispatch again.
    assert_eq!(reopened.pending_reviews().len(), 1);
    assert_eq!(
        reopened.pending_reviews()[0].cause,
        InterruptCause::AgentExit
    );
    assert_eq!(
        reopened.begin("k-a", "Prompt", Some("session-a")),
        BeginOutcome::DoNotReplay(EffectState::Interrupted)
    );
}
