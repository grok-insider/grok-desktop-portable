//! The picker lifecycle, driven by a deterministic picker.
//!
//! The interactive portal dialog cannot be driven from a test, so these use a
//! scripted picker to check everything around it: the guard, the enrolment, the
//! event, and the cancel path. The real dialog is verified separately against a
//! desktop session.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use grok_bridge::dispatch::{DispatchError, DispatchOutcome, SessionState, dispatch};
use grok_bridge::journal::Journal;
use grok_bridge::origin::LocalOrigin;
use grok_bridge::picker::{DirectoryPicker, PickerError};
use grok_bridge::protocol::{CommandEnvelope, Event, Operation, PROTOCOL_VERSION};
use grok_bridge::server::HostState;

const INSTALL: &str = "0123456789abcdef0123456789abcdef";

/// A picker that answers from a script and counts how often it was opened.
#[derive(Debug)]
struct ScriptedPicker {
    answer: Result<PathBuf, PickerError>,
    opened: AtomicUsize,
}

impl ScriptedPicker {
    fn chooses(path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            answer: Ok(path),
            opened: AtomicUsize::new(0),
        })
    }

    fn cancels() -> Arc<Self> {
        Arc::new(Self {
            answer: Err(PickerError::Cancelled),
            opened: AtomicUsize::new(0),
        })
    }
}

#[async_trait::async_trait]
impl DirectoryPicker for ScriptedPicker {
    async fn pick_directory(&self) -> Result<PathBuf, PickerError> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        // A real dialog takes time; this makes the guard observable.
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        self.answer.clone()
    }
}

fn open_picker() -> CommandEnvelope {
    CommandEnvelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: "req-1".into(),
        idempotency_key: None,
        controller_epoch: Some(1),
        expected_revision: None,
        deadline_ms: None,
        operation: Operation::OpenWorkspacePicker,
    }
}

fn state_with(picker: Arc<dyn DirectoryPicker>, directory: &std::path::Path) -> Arc<HostState> {
    let origin = LocalOrigin::new(INSTALL, 20_001).expect("origin");
    Arc::new(
        HostState::new(origin)
            .with_persistence(directory, picker)
            .expect("journal"),
    )
}

/// Drain the journal for the first event of interest.
async fn wait_for_event(state: &Arc<HostState>) -> Option<Event> {
    for _ in 0..40 {
        {
            let journal = state.journal.lock().await;
            if let grok_bridge::journal::ReplayOutcome::Replay(events) = journal.replay_after(0)
                && let Some(first) = events.first()
            {
                return Some(first.event.clone());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    None
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_the_picker_returns_immediately() {
    // The dialog is unbounded; the command must not wait for it.
    let root = tempfile::tempdir().expect("tempdir");
    let project = root.path().join("project");
    std::fs::create_dir(&project).expect("mkdir");
    let picker = ScriptedPicker::chooses(project);
    let state = state_with(picker, root.path());

    let started = std::time::Instant::now();
    let mut journal = Journal::new();
    let mut session = SessionState::default();
    let outcome = dispatch(&open_picker(), &mut journal, &mut session, None)
        .await
        .expect("open");

    assert_eq!(outcome, DispatchOutcome::PickerOpened);
    assert!(
        started.elapsed() < std::time::Duration::from_millis(50),
        "the command must answer before the user chooses"
    );
    assert!(session.picker_open);
    drop(state);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_picker_is_refused_while_one_is_open() {
    let mut journal = Journal::new();
    let mut session = SessionState::default();

    dispatch(&open_picker(), &mut journal, &mut session, None)
        .await
        .expect("first");
    let second = dispatch(&open_picker(), &mut journal, &mut session, None).await;

    assert_eq!(second, Err(DispatchError::PickerAlreadyOpen));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn choosing_a_directory_enrols_it_and_announces_the_change() {
    let root = tempfile::tempdir().expect("tempdir");
    let project = root.path().join("project");
    std::fs::create_dir(&project).expect("mkdir");

    let picker = ScriptedPicker::chooses(project.clone());
    let state = state_with(Arc::clone(&picker) as Arc<dyn DirectoryPicker>, root.path());
    state.session.lock().await.picker_open = true;
    state.spawn_directory_picker();

    let event = wait_for_event(&state).await;
    assert_eq!(
        event,
        Some(Event::WorkspacesChanged),
        "the browser must be told to refresh"
    );

    // The enrolment is durable, and reachable by opaque id only.
    let index = grok_bridge::workspace::load(root.path()).expect("load");
    assert_eq!(index.len(), 1);
    let entry = index.entries()[0];
    assert_eq!(
        entry.canonical_path,
        project.canonicalize().expect("canonical")
    );
    assert!(entry.id.starts_with("ws-"));

    // And the guard is released so the user can pick again.
    assert!(!state.session.lock().await.picker_open);
    assert_eq!(picker.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_enrols_nothing_and_reports_nothing() {
    let root = tempfile::tempdir().expect("tempdir");
    let state = state_with(ScriptedPicker::cancels(), root.path());
    state.session.lock().await.picker_open = true;
    state.spawn_directory_picker();

    // Give the picker time to finish and the guard to clear.
    for _ in 0..40 {
        if !state.session.lock().await.picker_open {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    assert!(
        !state.session.lock().await.picker_open,
        "closing the dialog must release the guard"
    );
    assert_eq!(
        state.journal.lock().await.emitted_through(),
        0,
        "a cancelled pick is a normal outcome, not an event to report"
    );
    assert!(
        grok_bridge::workspace::load(root.path())
            .expect("load")
            .is_empty(),
        "nothing may be enrolled when the user chose nothing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_guard_is_released_even_when_the_picker_fails() {
    let root = tempfile::tempdir().expect("tempdir");
    let picker: Arc<dyn DirectoryPicker> =
        Arc::new(grok_bridge::picker::UnavailableDirectoryPicker);
    let state = state_with(picker, root.path());
    state.session.lock().await.picker_open = true;
    state.spawn_directory_picker();

    let event = wait_for_event(&state).await;
    assert_eq!(
        event,
        Some(Event::Error {
            code: "picker_unavailable".into()
        })
    );
    assert!(
        !state.session.lock().await.picker_open,
        "a failure must not leave the picker permanently blocked"
    );
}
