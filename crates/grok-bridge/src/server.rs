//! Loopback HTTP surface for the Grok Light host.
//!
//! Implements the transport rules of `docs/light/protocol.md` and ADR light
//! 0006. Every response carries the strict header set; every request is
//! checked for an exact `Host`, an `Origin` appropriate to its method, a
//! paired cookie, and, for mutations, a CSRF token.
//!
//! Rejection is uniform: the host answers the same status for a failed origin,
//! cookie, or CSRF check so it cannot be used as an oracle.

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::acp::{AgentEvent, AgentHandle};
use crate::assets;
use crate::bounds::{MAX_COMMAND_BODY_BYTES, MAX_WS_FRAME_BYTES};
use crate::dispatch::{DispatchOutcome, PendingPermission, SessionState, Workspace};
use crate::journal::{InterruptCause, Journal, ReplayOutcome};
use crate::lease::ControlLease;
use crate::origin::{
    LocalOrigin, RequestKind, is_allowed_web_origin, sec_fetch_site_is_same_origin,
};
use crate::pairing::PairingBroker;
use crate::picker::{DirectoryPicker, PickerError, UnavailableDirectoryPicker};
use crate::protocol::{CommandEnvelope, Event, EventEnvelope, PROTOCOL_VERSION, WS_SUBPROTOCOL};
use crate::workspace::WorkspaceIndex;

/// Name of the pairing cookie (same-origin fallback SPA).
pub const SESSION_COOKIE: &str = "gl_session";

/// Session token header for hosted cross-origin HTTP (ADR 0016).
///
/// Cross-site `fetch` from `https://desktop.grok.me` to `http://127.0.0.1`
/// does not send `SameSite=Strict` cookies. The SPA keeps the token from the
/// pair response and sends it on every API call via this header.
pub const SESSION_HEADER: &str = "x-gl-session";

/// Prefix for the session token as a second WebSocket subprotocol (`gls.<hex>`).
///
/// Browsers cannot set custom headers on the WS handshake, and Strict cookies
/// are not sent cross-site to loopback. The client offers `light.local.v1` and
/// `gls.<session-token>`; the server authenticates with the latter and
/// negotiates only the family protocol.
pub const WS_SESSION_PROTOCOL_PREFIX: &str = "gls.";

/// Header carrying the per-page CSRF token on mutations.
pub const CSRF_HEADER: &str = "x-grok-light-csrf";

/// Content Security Policy served with the application document.
///
/// `connect-src 'self'` holds unchanged because the document and the socket
/// share one loopback origin (ADR light 0002).
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self'; \
     style-src 'self'; \
     img-src 'self' data:; \
     font-src 'self'; \
     connect-src 'self'; \
     object-src 'none'; \
     base-uri 'none'; \
     form-action 'self'; \
     frame-ancestors 'none'";

/// Mutable host state shared by every request.
#[derive(Debug)]
pub struct HostState {
    /// Canonical loopback origin for this installation.
    pub origin: LocalOrigin,
    /// Browser pairing broker.
    pub pairing: Mutex<PairingBroker>,
    /// The single controlling tab.
    pub lease: Mutex<ControlLease>,
    /// Intent, idempotency, and event journal.
    pub journal: Mutex<Journal>,
    /// Enrolled workspaces, the active session, and pending permissions.
    pub session: Mutex<SessionState>,
    /// The supervised agent, once a session has been opened.
    pub agent: Mutex<Option<Arc<AgentHandle>>>,
    /// Raised when the host has been asked to shut down.
    shutdown: tokio::sync::Notify,
    /// Raised when a journal event is recorded, so the controlling WebSocket
    /// can push it. Without this the browser only ever saw the hello frame.
    event_notify: tokio::sync::Notify,
    /// The host-owned directory picker.
    pub picker: Arc<dyn DirectoryPicker>,
    /// Where durable state lives, when the host owns a state directory.
    ///
    /// Absent in tests that exercise the HTTP surface without persistence.
    pub state_directory: Option<PathBuf>,
}

impl HostState {
    /// Attach the durable state directory and the picker the host will use.
    ///
    /// Opening the journal is part of this, and it is allowed to fail the
    /// whole call. A host that cannot write intent down must not serve: it
    /// would accept commands whose effects it could never account for, which
    /// is the one thing intent-before-effect exists to prevent.
    ///
    /// # Errors
    ///
    /// Returns [`JournalError`] when the journal cannot be read, reconciled,
    /// or written back.
    pub fn with_persistence(
        mut self,
        directory: impl Into<PathBuf>,
        picker: Arc<dyn DirectoryPicker>,
    ) -> Result<Self, crate::journal::JournalError> {
        let directory = directory.into();
        self.journal = Mutex::new(Journal::open(&directory)?);
        self.state_directory = Some(directory);
        self.picker = picker;
        Ok(self)
    }

    /// Ask the host to stop serving.
    ///
    /// Answering the control socket is not stopping. Without this the host
    /// reported that it was shutting down and then kept running, which left
    /// the port and the state directory held by a process the user believed
    /// they had ended.
    pub fn request_shutdown(&self) {
        self.shutdown.notify_waiters();
    }

    /// Resolves once a shutdown has been requested.
    pub async fn shutdown_requested(&self) {
        self.shutdown.notified().await;
    }

    /// Record a journal event and wake any controlling WebSocket so it is pushed.
    ///
    /// Every server-to-browser signal must go through here. Recording alone
    /// only fills the replay buffer; without the notify the socket never
    /// learns anything happened, which is why the UI looked frozen until a
    /// manual HTTP refresh.
    pub async fn emit_event(&self, event: Event, session_revision: Option<u64>) -> EventEnvelope {
        let envelope = self
            .journal
            .lock()
            .await
            .record_event(event, session_revision);
        self.event_notify.notify_waiters();
        envelope
    }

    /// Load the durable workspace enrolments into this state.
    ///
    /// The browser only ever sees the opaque ids; the paths stay here.
    pub async fn load_workspaces(&self, index: &WorkspaceIndex) {
        let workspaces = index.entries().into_iter().map(|entry| Workspace {
            id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            path: entry.canonical_path.clone(),
        });
        self.session.lock().await.replace_workspaces(workspaces);
    }

    /// Attach a supervised agent and start pumping its events.
    ///
    /// The receiver must be kept alive: dropping it closes the channel, which
    /// ends the agent's read loop and makes every later request look like a
    /// dead agent. Pumping it here is also what turns ACP notifications into
    /// the journal entries and permission records the browser sees.
    pub fn attach_agent(
        self: &Arc<Self>,
        agent: Arc<AgentHandle>,
        mut events: tokio::sync::mpsc::Receiver<AgentEvent>,
    ) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            {
                *state.agent.lock().await = Some(agent);
            }
            while let Some(event) = events.recv().await {
                state.absorb(event).await;
            }
            // The agent ended. Anything still in flight is ambiguous.
            let mut journal = state.journal.lock().await;
            journal.interrupt_all_in_flight(InterruptCause::AgentExit);
            drop(journal);
            *state.agent.lock().await = None;
        });
    }

    /// Run the host-owned picker, then enrol whatever the user chose.
    ///
    /// Detached on purpose: the dialog is interactive and unbounded, and the
    /// command that asked for it has already been answered. Whatever happens,
    /// the picker guard is released so the user can try again.
    pub fn spawn_directory_picker(self: &Arc<Self>) {
        let state = Arc::clone(self);
        tokio::spawn(async move {
            let picked = state.picker.pick_directory().await;

            let event = match picked {
                Ok(path) => match state.enrol_directory(&path).await {
                    Ok(()) => Some(Event::WorkspacesChanged),
                    Err(()) => Some(Event::Error {
                        code: "workspace_enrolment_failed".into(),
                    }),
                },
                // A closed dialog is a normal outcome, not an error to report.
                Err(PickerError::Cancelled) => None,
                Err(_) => Some(Event::Error {
                    code: "picker_unavailable".into(),
                }),
            };

            state.session.lock().await.picker_open = false;
            if let Some(event) = event {
                state.emit_event(event, None).await;
            }
        });
    }

    /// Enrol a directory the host itself selected, and persist the index.
    async fn enrol_directory(&self, path: &std::path::Path) -> Result<(), ()> {
        let Some(directory) = self.state_directory.as_deref() else {
            return Err(());
        };
        let mut index = crate::workspace::load(directory).map_err(|_| ())?;
        let now = now_ms();
        index.enrol(path, now).map_err(|_| ())?;
        crate::workspace::persist(directory, &index).map_err(|_| ())?;
        self.load_workspaces(&index).await;
        Ok(())
    }

    /// Open a project discovered from the Grok session store by opaque id.
    ///
    /// Resolves the host-known path, enrols it when needed, and returns the
    /// same workspace projection as Bootstrap (never a filesystem path).
    pub async fn open_project(
        &self,
        project_id: &str,
    ) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
        use crate::dispatch::DispatchError;

        let group = crate::session_catalog::list_project_groups()
            .into_iter()
            .find(|group| group.project_id == project_id);
        // Also allow opening an already-enrolled workspace that has no sessions
        // yet (project_id was synthesised from its path).
        let path = if let Some(group) = group {
            if !group.path.is_dir() {
                return Err(DispatchError::UnknownWorkspace);
            }
            group.path
        } else {
            let session = self.session.lock().await;
            let workspace = session
                .workspaces
                .values()
                .find(|workspace| {
                    crate::session_catalog::project_id_for_path(&workspace.path) == project_id
                })
                .ok_or(DispatchError::UnknownWorkspace)?;
            if !workspace.path.is_dir() {
                return Err(DispatchError::UnknownWorkspace);
            }
            workspace.path.clone()
        };

        self.enrol_directory(&path)
            .await
            .map_err(|()| DispatchError::UnknownWorkspace)?;

        let journal = self.journal.lock().await;
        let session = self.session.lock().await;
        Ok(DispatchOutcome::Workspaces {
            workspaces: session.project_workspaces(),
            projects: session.project_projects(),
            open_sessions: session.project_sessions(),
            integrations: crate::integrations::list(),
            pending_reviews: journal
                .pending_reviews()
                .into_iter()
                .map(crate::dispatch::ReviewProjection::from)
                .collect(),
        })
    }

    /// Forget an enrolment, and persist the index.
    ///
    /// Revocation has to reach the durable index, not just the projection the
    /// browser sees. A removal that only cleared the in-memory copy would tell
    /// the user the agent had lost the directory while the next host start
    /// handed it back.
    async fn revoke_workspace(&self, workspace_id: &str) -> Result<(), ()> {
        let Some(directory) = self.state_directory.as_deref() else {
            return Err(());
        };
        let mut index = crate::workspace::load(directory).map_err(|_| ())?;
        index.remove(workspace_id).map_err(|_| ())?;
        crate::workspace::persist(directory, &index).map_err(|_| ())?;
        self.load_workspaces(&index).await;
        Ok(())
    }

    /// Send whatever the user queued behind the turn that just ended.
    ///
    /// One at a time, in a loop rather than by recursion: the next prompt only
    /// leaves when the previous finishes, which is what keeps Light's queue and
    /// the agent's own from both holding the same message.
    fn drain_queue(self: &Arc<Self>, session_id: &str) {
        let state = Arc::clone(self);
        let session_id = session_id.to_owned();
        tokio::spawn(async move {
            loop {
                let Some(next) = state.session.lock().await.take_queued(&session_id) else {
                    return;
                };
                let bash = queue_entry_is_bash(&next.text);
                // Host-local bash does not need the agent; chat does.
                let agent = if bash {
                    None
                } else {
                    let Some(agent) = state.agent.lock().await.clone() else {
                        // Put the entry back? We already took it. Without an
                        // agent the chat queue cannot drain; surface failure
                        // and stop so the user can retry after the CLI returns.
                        state
                            .emit_event(
                                Event::Error {
                                    code: "queued_prompt_failed".into(),
                                },
                                None,
                            )
                            .await;
                        return;
                    };
                    Some(agent)
                };

                {
                    let mut session = state.session.lock().await;
                    if !bash && session.begin_review_turn(&session_id).is_err() {
                        return;
                    }
                    session.set_running(&session_id, true);
                }
                state
                    .emit_event(
                        Event::SessionStatus {
                            session_id: session_id.clone(),
                            state: "running".into(),
                        },
                        None,
                    )
                    .await;
                // The queue changed, so the page stops showing what just left,
                // and the message appears in the transcript as the user's turn
                // — otherwise the reply arrives with no question above it.
                state
                    .emit_event(
                        Event::QueueChanged {
                            session_id: session_id.clone(),
                        },
                        None,
                    )
                    .await;
                state
                    .emit_event(
                        Event::PromptSent {
                            session_id: session_id.clone(),
                            text: next.text.clone(),
                        },
                        None,
                    )
                    .await;

                if bash {
                    let outcome = {
                        let mut session = state.session.lock().await;
                        run_bash_for_session(&session_id, &next.text, &mut session)
                    };
                    state.session.lock().await.set_running(&session_id, false);
                    match outcome {
                        Ok(DispatchOutcome::BashRan {
                            session_id: sid,
                            output,
                            ..
                        }) => {
                            // PromptSent already emitted above; only stream output.
                            emit_bash_output(&state, &sid, &output).await;
                        }
                        Ok(_) | Err(_) => {
                            state
                                .emit_event(
                                    Event::Error {
                                        code: "queued_prompt_failed".into(),
                                    },
                                    None,
                                )
                                .await;
                        }
                    }
                } else {
                    let agent = agent.expect("non-bash path holds an agent");
                    let sent = agent.prompt(&session_id, &next.text).await;
                    {
                        let mut session = state.session.lock().await;
                        match &sent {
                            Ok(result) => session.finish_review_turn(&session_id, Some(result)),
                            Err(_) => session.interrupt_review_turn(&session_id),
                        }
                        session.set_running(&session_id, false);
                    }
                    if sent.is_err() {
                        // A queued prompt that could not be sent is not dropped in
                        // silence: the page is told, and the rest of the queue
                        // stays where the user can see and remove it.
                        state
                            .emit_event(
                                Event::Error {
                                    code: "queued_prompt_failed".into(),
                                },
                                None,
                            )
                            .await;
                    }
                }
                state
                    .emit_event(
                        Event::SessionReviewUpdated {
                            session_id: session_id.clone(),
                            changes: true,
                            context: !bash,
                        },
                        None,
                    )
                    .await;
                state
                    .emit_event(
                        Event::SessionStatus {
                            session_id: session_id.clone(),
                            state: "idle".into(),
                        },
                        None,
                    )
                    .await;
            }
        });
    }

    /// Re-raise every decision the agent is still waiting on.
    ///
    /// A newly attached tab holds no dialogs. Without this a reload while a
    /// permission was pending left the request alive in the host and blocking
    /// in the agent, with nothing on screen to answer it.
    async fn replay_pending_permissions(&self) {
        let pending: Vec<(String, String, Vec<String>)> = {
            let session = self.session.lock().await;
            session
                .pending_permissions
                .iter()
                .map(|(key, request)| {
                    (
                        request.session_id.clone(),
                        key.clone(),
                        crate::permission::project(key, &request.offered)
                            .map(|projected| projected.options)
                            .unwrap_or_default(),
                    )
                })
                .collect()
        };

        for (session_id, request_id, options) in pending {
            self.emit_event(
                Event::PermissionRequest {
                    session_id,
                    request_id,
                    options,
                },
                None,
            )
            .await;
        }
    }

    /// Push a snapshot for every open session, for a browser that has none.
    ///
    /// Bounded by the concurrency limit and, per session, by the rehydration
    /// bound, so a reconnect cannot be turned into an unbounded read.
    async fn replay_open_sessions(&self) {
        let open = self.session.lock().await.sessions_to_replay();

        for (session_id, path) in open {
            let restored = crate::session_catalog::rehydrate_session(&path, &session_id);
            if !crate::session_catalog::rehydrate_has_content(&restored) {
                continue;
            }
            self.emit_event(
                crate::session_catalog::snapshot_from_rehydrate(session_id, restored),
                None,
            )
            .await;
        }
    }

    /// Fold one agent event into host state.
    async fn absorb(&self, event: AgentEvent) {
        match event {
            AgentEvent::Update(params) => {
                let capture = if let Some(session_id) =
                    params.get("sessionId").and_then(serde_json::Value::as_str)
                {
                    self.session
                        .lock()
                        .await
                        .capture_review_update(session_id, &params)
                } else {
                    crate::review::CaptureResult::default()
                };
                if (capture.changes_updated || capture.usage_updated)
                    && let Some(session_id) =
                        params.get("sessionId").and_then(serde_json::Value::as_str)
                {
                    self.emit_event(
                        Event::SessionReviewUpdated {
                            session_id: session_id.to_owned(),
                            changes: capture.changes_updated,
                            context: capture.usage_updated,
                        },
                        None,
                    )
                    .await;
                }
                // Classify by ACP `sessionUpdate`. Treating every text-bearing
                // update as a message was the bug that streamed internal
                // reasoning into the agent bubble next to the real reply.
                if let Some(event) = crate::projection::session_update_event(&params) {
                    self.emit_event(event, None).await;
                }
            }
            AgentEvent::PermissionRequest { request_id, params } => {
                let offered: Vec<String> = params
                    .get("options")
                    .and_then(serde_json::Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(|option| {
                                option
                                    .get("optionId")
                                    .and_then(serde_json::Value::as_str)
                                    .map(str::to_owned)
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                // The browser only ever learns the options Light may render.
                let renderable = crate::permission::project("perm", &offered)
                    .map(|projected| projected.options)
                    .unwrap_or_default();

                // A request the agent cannot attribute to a session is not
                // answerable: with several open, the user would be shown a
                // prompt without knowing which conversation asked.
                let Some(session_id) = params
                    .get("sessionId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                else {
                    return;
                };

                let key = format!("perm-{}", self.journal.lock().await.emitted_through() + 1);
                self.session.lock().await.open_permission(
                    &key,
                    PendingPermission {
                        request_id,
                        session_id: session_id.clone(),
                        offered,
                    },
                );
                self.emit_event(
                    Event::PermissionRequest {
                        session_id,
                        request_id: key,
                        options: renderable,
                    },
                    None,
                )
                .await;
            }
            AgentEvent::Exited => {
                // One agent process holds every session (light ADR 0011), so
                // its death is not one conversation's problem: each that had
                // work in flight is left ambiguous, and none can be prompted
                // again. Saying nothing left the browser offering Stop on a
                // turn that would never end and permissions that could never
                // be answered.
                {
                    let mut journal = self.journal.lock().await;
                    let _ = journal.interrupt_all_intended(InterruptCause::AgentExit);
                }
                let closed: Vec<String> = {
                    let mut session = self.session.lock().await;
                    let ids: Vec<String> = session.sessions.keys().cloned().collect();
                    session.sessions.clear();
                    session.reviews.clear();
                    // A pending request belongs to a process that is gone. It
                    // can never be answered, so it is dropped rather than left
                    // waiting for a decision that would go nowhere.
                    session.pending_permissions.clear();
                    ids
                };
                for session_id in closed {
                    self.emit_event(
                        Event::SessionStatus {
                            session_id,
                            state: "idle".into(),
                        },
                        None,
                    )
                    .await;
                }
                self.emit_event(
                    Event::Error {
                        code: "agent_exited".into(),
                    },
                    None,
                )
                .await;
                // The open list changed, so the browser is told to re-read it
                // rather than left showing conversations that no longer exist.
                self.emit_event(Event::WorkspacesChanged, None).await;
            }
        }
    }

    /// Build empty state for one canonical origin.
    #[must_use]
    pub fn new(origin: LocalOrigin) -> Self {
        Self {
            origin,
            pairing: Mutex::new(PairingBroker::new()),
            lease: Mutex::new(ControlLease::new()),
            journal: Mutex::new(Journal::new()),
            session: Mutex::new(SessionState::default()),
            agent: Mutex::new(None),
            shutdown: tokio::sync::Notify::new(),
            event_notify: tokio::sync::Notify::new(),
            picker: Arc::new(UnavailableDirectoryPicker),
            state_directory: None,
        }
    }
}

/// Just enough of a command to read its version.
///
/// Deserialised on its own because an operation whose shape changed will not
/// parse under an older version, and the version has to be answerable before
/// the rest of the body is understood.
#[derive(Deserialize)]
struct VersionProbe {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
}

/// Body of a pairing exchange.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    /// The single-use nonce delivered through the URL fragment.
    pub nonce: String,
}

/// Result of a successful pairing exchange.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    /// Opaque browser session identifier, safe to display.
    pub session_id: String,
    /// Secret session token for hosted clients (`x-gl-session` header).
    pub session_token: String,
    /// CSRF token the page keeps in memory for mutations.
    pub csrf_token: String,
    /// Protocol version the host implements.
    pub protocol_version: u32,
}

/// Build the loopback router for one host state.
pub fn router(state: Arc<HostState>) -> Router {
    Router::new()
        .route("/", get(serve_asset))
        .route("/{*path}", get(serve_asset))
        .route("/healthz", get(health))
        .route("/pair", post(pair))
        .route("/session", get(resume))
        .route("/command", post(command))
        .route("/events", get(events))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&state),
            enforce_origin,
        ))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

/// Bind the loopback listener for a canonical origin.
///
/// Binds `127.0.0.1` only. The caller owns the returned listener so the
/// instance lock can be held across the bind.
///
/// # Errors
///
/// Returns the IO error when the port is unavailable, which the caller
/// distinguishes from an origin conflict per ADR light 0006.
pub async fn bind(origin: &LocalOrigin) -> std::io::Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, origin.port())).await
}

/// Serve the router on an already-bound loopback listener.
///
/// # Errors
///
/// Returns the IO error that terminated the accept loop.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<HostState>,
) -> std::io::Result<()> {
    let signal = Arc::clone(&state);
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move { signal.shutdown_requested().await })
        .await
}

/// Uniform rejection. The host never reveals which check failed.
fn rejected() -> Response {
    StatusCode::FORBIDDEN.into_response()
}

/// Header name not present as a constant in `http::header`.
const CROSS_ORIGIN_OPENER_POLICY: HeaderName =
    HeaderName::from_static("cross-origin-opener-policy");

/// Header name not present as a constant in `http::header`.
const PERMISSIONS_POLICY: HeaderName = HeaderName::from_static("permissions-policy");

/// Restrictive default: the application needs none of these capabilities.
const PERMISSIONS_POLICY_VALUE: &str =
    "camera=(), microphone=(), geolocation=(), usb=(), payment=()";

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_SECURITY_POLICY, CONTENT_SECURITY_POLICY),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::CACHE_CONTROL, "no-store"),
        (CROSS_ORIGIN_OPENER_POLICY, "same-origin"),
        (PERMISSIONS_POLICY, PERMISSIONS_POLICY_VALUE),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn enforce_origin(
    State(state): State<Arc<HostState>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let host = header_str(request.headers(), header::HOST).map(str::to_owned);
    let origin = header_str(request.headers(), header::ORIGIN).map(str::to_owned);
    let host_ref = host.as_deref();
    let origin_ref = origin.as_deref();

    // CORS preflight from the hosted document — no side effects.
    if request.method() == Method::OPTIONS {
        if let Some(ref origin) = origin {
            if is_allowed_web_origin(origin)
                && state
                    .origin
                    .verify_request(RequestKind::Safe, host_ref, Some(origin.as_str()))
                    .is_ok()
            {
                return cors_preflight_response(origin);
            }
        }
        return rejected();
    }

    // A WebSocket upgrade arrives as a GET but is browser-initiated and always
    // carries Origin, so it is held to mutation strictness. Classifying it here
    // rather than in the handler means the check runs before any extractor.
    let kind = if is_websocket_upgrade(request.headers()) {
        RequestKind::WebSocket
    } else if request.method() == Method::GET || request.method() == Method::HEAD {
        RequestKind::Safe
    } else {
        RequestKind::Mutation
    };

    if state
        .origin
        .verify_request(kind, host_ref, origin_ref)
        .is_err()
    {
        return rejected();
    }
    // Hosted document → loopback is cross-site; allow when Origin is allowlisted.
    let sec_fetch = header_str(request.headers(), "sec-fetch-site");
    let hosted = origin.as_deref().is_some_and(is_allowed_web_origin);
    if !hosted && !sec_fetch_site_is_same_origin(sec_fetch) {
        return rejected();
    }
    let mut response = next.run(request).await;
    if let Some(ref origin) = origin {
        if is_allowed_web_origin(origin) {
            apply_cors_headers(response.headers_mut(), origin);
        }
    }
    response
}

fn cors_preflight_response(origin: &str) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors_headers(response.headers_mut(), origin);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

fn apply_cors_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type, x-grok-light-csrf, x-gl-session"),
    );
    headers.insert(
        header::VARY,
        HeaderValue::from_static("Origin"),
    );
}

fn header_str<K>(headers: &HeaderMap, key: K) -> Option<&str>
where
    K: axum::http::header::AsHeaderName,
{
    headers.get(key).and_then(|value| value.to_str().ok())
}

/// Whether the request is a WebSocket upgrade attempt.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    header_str(headers, header::UPGRADE)
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthBody {
    ok: bool,
    mode: &'static str,
    protocol_version: u32,
}

async fn health(State(state): State<Arc<HostState>>) -> Response {
    let body = HealthBody {
        ok: true,
        mode: "bridge",
        protocol_version: PROTOCOL_VERSION,
    };
    // Paired status is intentionally omitted from unauthenticated probe to
    // avoid leaking whether someone is controlling the host.
    let _ = state;
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// Serve the embedded SPA.
///
/// Unknown paths fall back to the entry document so the SPA owns its own
/// routing, which is standard for a single-page application and is safe here
/// because the asset table is a fixed set: an unknown path serves the same
/// document, never a file from disk.
async fn serve_asset(uri: axum::http::Uri) -> Response {
    if let Some(asset) = assets::lookup(uri.path()) {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, asset.content_type)],
            asset.bytes,
        )
            .into_response();
    }
    if let Some(index) = assets::lookup("/") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, index.content_type)],
            index.bytes,
        )
            .into_response();
    }
    // Built without a bundle. Say so plainly rather than pretending.
    let body = "<!doctype html><meta charset=\"utf-8\"><title>Grok Light</title>\
        <p>The Grok Light host is running, but this build has no interface \
        bundle. Build it with <code>pnpm --filter @grok-desktop-portable/web build</code> \
        and rebuild the host.</p>";
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn pair(
    State(state): State<Arc<HostState>>,
    axum::Json(request): axum::Json<PairRequest>,
) -> Response {
    let now = now_ms();
    let mut broker = state.pairing.lock().await;
    let Ok(paired) = broker.redeem_nonce(&request.nonce, now) else {
        return rejected();
    };

    let cookie = format!(
        "{SESSION_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
        paired.session_token.expose()
    );
    let Ok(cookie_value) = HeaderValue::from_str(&cookie) else {
        return rejected();
    };

    let body = PairResponse {
        session_id: paired.session_id,
        session_token: paired.session_token.expose().to_owned(),
        csrf_token: paired.csrf_token.expose().to_owned(),
        protocol_version: PROTOCOL_VERSION,
    };
    (
        StatusCode::OK,
        [(header::SET_COOKIE, cookie_value)],
        axum::Json(body),
    )
        .into_response()
}

/// Re-issue a CSRF token to an already-paired browser.
///
/// The CSRF token deliberately lives only in page memory, so a reload loses
/// it. Without this the user would be sent back to setup on every refresh even
/// though the pairing cookie is still valid.
///
/// Re-issue CSRF for a still-valid session (reload recovery).
///
/// Hosted clients send `x-gl-session` (cookies are SameSite-blocked cross-site).
/// Loopback fallback SPA may still present the cookie.
async fn resume(State(state): State<Arc<HostState>>, headers: HeaderMap) -> Response {
    let Some(token) = session_token(&headers) else {
        return rejected();
    };
    let now = now_ms();
    let mut broker = state.pairing.lock().await;
    let Ok(session_id) = broker.verify_session(token, now) else {
        return rejected();
    };
    let Ok(csrf) = broker.reissue_csrf(&session_id) else {
        return rejected();
    };
    (
        StatusCode::OK,
        axum::Json(PairResponse {
            session_id,
            // Echo the presented token so hosted clients can rehydrate memory.
            session_token: token.to_owned(),
            csrf_token: csrf.expose().to_owned(),
            protocol_version: PROTOCOL_VERSION,
        }),
    )
        .into_response()
}

async fn command(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if body.len() > MAX_COMMAND_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Some(token) = session_token(&headers) else {
        return rejected();
    };
    let Some(csrf) = header_str(&headers, CSRF_HEADER) else {
        return rejected();
    };

    let now = now_ms();
    {
        let broker = state.pairing.lock().await;
        if broker.verify_mutation(token, csrf, now).is_err() {
            return rejected();
        }
    }

    // The version is read before the body is understood. An operation whose
    // shape changed will not deserialise at all under the older version, so
    // checking it afterwards would report a stale tab as a malformed request
    // and leave the user with nothing to act on but a reload they were never
    // told to do.
    if let Ok(probe) = serde_json::from_slice::<VersionProbe>(&body)
        && probe.protocol_version != PROTOCOL_VERSION
    {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "error": { "code": "unsupported_protocol_version" },
            })),
        )
            .into_response();
    }

    let Ok(envelope) = serde_json::from_slice::<CommandEnvelope>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if envelope.validate().is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let agent = state.agent.lock().await.clone();
    // Project open enrols a host-resolved path; it cannot go through pure
    // dispatch without HostState (durable workspace index).
    let outcome =
        if let crate::protocol::Operation::OpenProject { project_id } = &envelope.operation {
            state.open_project(project_id).await
        } else {
            // Agent I/O is released from the journal/session locks so streaming
            // updates can be absorbed and pushed while a prompt is still open.
            // Without that, `session/update` lines pile up until the turn ends and
            // the browser never sees a live reply.
            dispatch_unlocked(&envelope, &state.journal, &state.session, agent.as_ref()).await
        };

    if let Some(failure) = apply_command_effects(&state, &envelope, &outcome).await {
        return failure;
    }

    match outcome {
        Ok(outcome) => (
            StatusCode::ACCEPTED,
            axum::Json(serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": envelope.request_id,
                "result": outcome,
            })),
        )
            .into_response(),
        Err(error) => (
            // A refused command is a normal outcome the interface explains, so
            // it carries a stable code rather than a transport failure.
            StatusCode::UNPROCESSABLE_ENTITY,
            axum::Json(serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": envelope.request_id,
                "error": error.code(),
            })),
        )
            .into_response(),
    }
}

/// The session an operation addresses, when it addresses one.
///
/// Every session-scoped command names its session (light ADR 0011), so this is
/// a lookup rather than a guess. Operations that are not session-scoped return
/// `None` and the caller does nothing rather than falling back to whichever
/// session happens to be open.
const fn addressed_session(operation: &crate::protocol::Operation) -> Option<&String> {
    use crate::protocol::Operation;
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

/// Carry out what a completed command implies beyond its answer.
///
/// Split from `command` so the request handler stays a readable chain of
/// guards. Returns a response only when an effect failed in a way the browser
/// must be told about; otherwise the caller answers with the outcome.
async fn apply_command_effects(
    state: &Arc<HostState>,
    envelope: &CommandEnvelope,
    outcome: &Result<DispatchOutcome, crate::dispatch::DispatchError>,
) -> Option<Response> {
    // A picker has no time bound, so it runs after the response rather than
    // holding this request open while the user browses.
    if matches!(outcome, Ok(DispatchOutcome::PickerOpened)) {
        state.spawn_directory_picker();
    }

    // Host-local bash never went through session/prompt; stream shell output
    // only. The SPA already optimistically added the user `!` line (and
    // drain_queue already emits PromptSent), so do not re-emit PromptSent.
    if let Ok(DispatchOutcome::BashRan {
        session_id, output, ..
    }) = outcome
    {
        emit_bash_output(state, session_id, output).await;
    }

    // Revocation is only real once the index on disk no longer holds it, so
    // the durable write happens before the browser is told it succeeded.
    if let Ok(DispatchOutcome::WorkspaceRemoved { workspace_id }) = &outcome {
        if state.revoke_workspace(workspace_id.as_str()).await.is_err() {
            return Some(
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": envelope.request_id,
                        "error": { "code": "revocation_failed" },
                    })),
                )
                    .into_response(),
            );
        }
        state.emit_event(Event::WorkspacesChanged, None).await;
    }

    // A prompt (or cancel) holds the UI in `streaming` for the whole turn.
    // `session/prompt` only returns once the agent is done, so this is the
    // moment to clear that phase. Without it the page kept showing Stop and
    // the streaming caret after the reply had already finished.
    // The phase belongs to the session the command addressed, not to "the"
    // session: another conversation may still be streaming.
    if turn_phase_should_clear(&envelope.operation, outcome)
        && let Some(session_id) = addressed_session(&envelope.operation)
    {
        state.session.lock().await.set_running(session_id, false);
        state
            .emit_event(
                Event::SessionStatus {
                    session_id: session_id.to_owned(),
                    state: "idle".into(),
                },
                None,
            )
            .await;
        state
            .emit_event(
                Event::SessionReviewUpdated {
                    session_id: session_id.to_owned(),
                    changes: true,
                    context: true,
                },
                None,
            )
            .await;
        // The turn is over, so anything the user queued behind it goes now.
        state.drain_queue(session_id);
    }

    // After a successful load, push the restored transcript so the browser is
    // not left looking at an empty session that only exists on disk.
    if matches!(
        (&envelope.operation, &outcome),
        (
            crate::protocol::Operation::LoadSession { .. },
            Ok(DispatchOutcome::SessionCreated { .. })
        )
    ) {
        let session_id = addressed_session(&envelope.operation).cloned()?;
        let restored = state
            .session
            .lock()
            .await
            .pending_rehydrate
            .take()
            .unwrap_or_default();
        state
            .emit_event(
                crate::session_catalog::snapshot_from_rehydrate(session_id.clone(), restored),
                None,
            )
            .await;
        state
            .emit_event(
                Event::SessionStatus {
                    session_id,
                    state: "idle".into(),
                },
                None,
            )
            .await;
    }
    None
}

/// WebSocket upgrade carrying server-to-client events.
///
/// The upgrade is a browser-initiated request that always carries `Origin`, so
/// it is validated as strictly as a mutation. It requires the versioned
/// subprotocol, a session token (cookie, `x-gl-session`, or `gls.<token>` in
/// `Sec-WebSocket-Protocol`), and is where the controlling tab takes its lease.
async fn events(
    State(state): State<Arc<HostState>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    // `Host` and `Origin` were already enforced with WebSocket strictness by
    // the shared middleware, before any extractor ran.
    if !requests_subprotocol(&headers) {
        return rejected();
    }

    let Some(token) = session_token(&headers) else {
        return rejected();
    };
    let now = now_ms();
    let session_id = {
        let broker = state.pairing.lock().await;
        match broker.verify_session(token, now) {
            Ok(id) => id,
            Err(_) => return rejected(),
        }
    };

    let connection_id = format!("conn-{}", now_ms());
    // Negotiate only the family protocol — never echo the session token.
    upgrade
        .protocols([WS_SUBPROTOCOL])
        .on_upgrade(move |socket| drive_events(socket, state, session_id, connection_id))
}

/// Whether the client offered the exact versioned subprotocol.
fn requests_subprotocol(headers: &HeaderMap) -> bool {
    header_str(headers, "sec-websocket-protocol").is_some_and(|value| {
        value
            .split(',')
            .any(|candidate| candidate.trim() == WS_SUBPROTOCOL)
    })
}

/// Session token from `Sec-WebSocket-Protocol` entries of the form `gls.<hex>`.
fn session_token_from_ws_protocols(headers: &HeaderMap) -> Option<&str> {
    header_str(headers, "sec-websocket-protocol").and_then(|value| {
        value.split(',').map(str::trim).find_map(|candidate| {
            candidate
                .strip_prefix(WS_SESSION_PROTOCOL_PREFIX)
                .filter(|token| !token.is_empty())
        })
    })
}

/// Serve one controlling connection.
///
/// Outbound frames carry journal events as they are recorded. Inbound frames
/// are only heartbeats: command dispatch stays on the HTTP surface where CSRF
/// applies. The previous loop only received heartbeats and never pushed, so
/// message deltas, permissions, and `workspacesChanged` never reached the page.
async fn drive_events(
    mut socket: WebSocket,
    state: Arc<HostState>,
    session_id: String,
    connection_id: String,
) {
    let acquired = {
        let mut lease = state.lease.lock().await;
        lease.acquire(&session_id, &connection_id, now_ms())
    };
    let Ok(epoch) = acquired else {
        // A second tab is blocked. It may observe status only, so the
        // connection closes rather than silently sharing control.
        let _ = socket
            .send(Message::Text(
                serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "eventSequence": 0,
                    "event": { "kind": "error", "code": "controller_held" }
                })
                .to_string()
                .into(),
            ))
            .await;
        return;
    };

    let hello = state
        .emit_event(
            Event::HostStatus {
                state: format!("controlling:{epoch}"),
            },
            None,
        )
        .await;
    let mut last_sent = hello.event_sequence;
    if send_event_frame(&mut socket, &hello).await.is_err() {
        release_controller(&state, &connection_id).await;
        return;
    }

    // A tab that has just attached holds no transcripts: the host keeps
    // sessions, the browser keeps their content, and a reload throws the
    // browser's copy away. Without this, every open conversation came back
    // reading "no messages yet" while its history sat on disk. The same
    // rehydration as resume (light ADR 0010), once per open session.
    state.replay_open_sessions().await;
    state.replay_pending_permissions().await;

    loop {
        // Drain first so a notify that raced with the wait is still delivered.
        if push_pending_events(&mut socket, &state, &mut last_sent)
            .await
            .is_err()
        {
            break;
        }

        tokio::select! {
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_WS_FRAME_BYTES => {
                        let mut lease = state.lease.lock().await;
                        if lease.heartbeat(&connection_id, now_ms()).is_err() {
                            break;
                        }
                    }
                    // An oversized frame, a binary frame, or a close all end the
                    // connection: this channel carries heartbeats only.
                    Some(
                        Ok(Message::Close(_) | Message::Text(_) | Message::Binary(_)) | Err(_),
                    )
                    | None => break,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                }
            }
            () = state.event_notify.notified() => {
                // Loop continues into push_pending_events.
            }
        }
    }

    release_controller(&state, &connection_id).await;
}

/// Push every journal event after `last_sent` over the controlling socket.
///
/// Returns `Err` when the socket is gone so the caller can tear down the lease.
async fn push_pending_events(
    socket: &mut WebSocket,
    state: &HostState,
    last_sent: &mut u64,
) -> Result<(), ()> {
    let envelopes = {
        let journal = state.journal.lock().await;
        match journal.replay_after(*last_sent) {
            ReplayOutcome::Replay(events) => events,
            // The controller fell behind the retained window. There is no
            // snapshot path on this socket yet, so stop rather than inventing
            // events the browser already missed.
            ReplayOutcome::SnapshotRequired => return Err(()),
        }
    };
    for envelope in envelopes {
        send_event_frame(socket, &envelope).await?;
        *last_sent = envelope.event_sequence;
    }
    Ok(())
}

async fn send_event_frame(socket: &mut WebSocket, envelope: &EventEnvelope) -> Result<(), ()> {
    let payload = serde_json::to_string(envelope).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

/// Drop the control lease and mark anything still in flight for review.
async fn release_controller(state: &HostState, connection_id: &str) {
    // Losing the controlling tab denies anything pending rather than leaving
    // it to be replayed later.
    let mut lease = state.lease.lock().await;
    lease.release(connection_id);
    drop(lease);
    let mut journal = state.journal.lock().await;
    journal.interrupt_all_in_flight(InterruptCause::ControllerLost);
}

/// Dispatch without holding the journal across agent I/O.
///
/// Intent is begun and completed under short locks; the agent call itself runs
/// with neither mutex held so `absorb` can record streaming updates and the
/// WebSocket can push them while the turn is open.
async fn dispatch_unlocked(
    envelope: &CommandEnvelope,
    journal: &Mutex<Journal>,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;
    use crate::journal::BeginOutcome;

    // Intent before effect. A key that is already known never dispatches.
    if let Some(key) = &envelope.idempotency_key
        && envelope.operation.has_side_effect()
    {
        let mut journal = journal.lock().await;
        match journal.begin(
            key,
            envelope.operation.name(),
            addressed_session(&envelope.operation).map(String::as_str),
        ) {
            BeginOutcome::Dispatch => {}
            BeginOutcome::AlreadyCompleted => return Err(DispatchError::AlreadyCompleted),
            BeginOutcome::DoNotReplay(_) => return Err(DispatchError::NotReplayable),
            BeginOutcome::NotDurable => return Err(DispatchError::IntentNotDurable),
        }
    }

    let key = envelope.idempotency_key.clone();
    let result = run_unlocked(envelope, journal, session, agent).await;

    // Classify the outcome exactly once, while the turn is still fresh.
    if let Some(key) = key
        && envelope.operation.has_side_effect()
    {
        let mut journal = journal.lock().await;
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

/// Body of a command with locks held only for state reads and writes.
/// Start a new agent session, or resume one the agent already holds.
///
/// The two share everything that matters — the workspace is resolved to a
/// canonical path here rather than taken from the browser (light ADR 0009),
/// and both refuse while a session is already open — so they are one function
/// with resume as the optional half.
async fn open_session(
    workspace_id: &str,
    resume: Option<&str>,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;

    let workspace = {
        let session = session.lock().await;
        // Resuming a conversation that is already open would show the same
        // transcript twice, so it is refused rather than duplicated.
        if let Some(id) = resume
            && session.sessions.contains_key(id)
        {
            return Err(DispatchError::SessionAlreadyActive);
        }
        if session.sessions.len() >= crate::bounds::MAX_LIVE_SESSIONS {
            return Err(DispatchError::TooManySessions);
        }
        session
            .workspaces
            .get(workspace_id)
            .ok_or(DispatchError::UnknownWorkspace)?
            .clone()
    };
    let path = workspace.path.clone();
    let agent = agent.ok_or(DispatchError::NoSession)?;

    let (session_id, restored, open_result) = match resume {
        None => {
            let (id, result) = agent
                .new_session(&path)
                .await
                .map_err(|error| map_dispatch_agent_error(&error))?;
            (id, None, result)
        }
        Some(id) => {
            let result = agent
                .load_session(id, &path)
                .await
                .map_err(|error| map_dispatch_agent_error(&error))?;
            // Rehydration is best effort by ADR 0010: a load that succeeded
            // with no transcript on disk still opens the session.
            let restored = crate::session_catalog::rehydrate_session(&path, id);
            (id.to_owned(), Some(restored), result)
        }
    };

    {
        let mut session = session.lock().await;
        session.open_session(crate::dispatch::LiveSession {
            id: session_id.clone(),
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.display_name.clone(),
            running: false,
            queued: Vec::new(),
            opened_at_ms: crate::now_ms(),
        })?;
        session.capture_review_open_result(&session_id, &open_result);
        session.pending_rehydrate = restored;
    }
    Ok(DispatchOutcome::SessionCreated { session_id })
}

/// Send a prompt, or hold it if the conversation is mid-turn.
///
/// The agent would queue a mid-turn prompt itself, but a queue Light cannot
/// show is a queue the user cannot take a message out of, so Light holds its
/// own and only sends when the session is idle.
async fn prompt_or_queue(
    session_id: &str,
    text: &str,
    bash: bool,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;

    let is_bash = bash || text.trim_start().starts_with('!');
    let wire = if is_bash {
        format!("! {}", crate::bash::strip_bang(text))
    } else {
        text.to_owned()
    };
    let chat_agent = if is_bash {
        None
    } else {
        Some(agent.ok_or(DispatchError::NoSession)?)
    };
    {
        let mut session = session.lock().await;
        if session.session(session_id)?.running {
            let entry_id = session.queue_prompt(session_id, &wire)?;
            return Ok(DispatchOutcome::PromptQueued {
                session_id: session_id.to_owned(),
                entry_id,
            });
        }
        if is_bash {
            return run_bash_for_session(session_id, &wire, &mut session);
        }
        session.begin_review_turn(session_id)?;
        session.set_running(session_id, true);
    }
    let agent = chat_agent.expect("non-bash path holds an agent");
    let sent = agent.prompt(session_id, &wire).await;
    {
        let mut session = session.lock().await;
        if let Ok(result) = &sent {
            session.finish_review_turn(session_id, Some(result));
        } else {
            session.interrupt_review_turn(session_id);
            session.set_running(session_id, false);
        }
    }
    sent.map_err(|error| map_dispatch_agent_error(&error))?;
    Ok(DispatchOutcome::PromptAccepted)
}

/// Stop what is running so this message goes next.
///
/// The meaning the qualified CLI gives `Ctrl+Enter`: it does not jump the
/// queue, it clears the way.
async fn send_now_unlocked(
    session_id: &str,
    text: &str,
    bash: bool,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;

    let is_bash = bash || text.trim_start().starts_with('!');
    let wire = if is_bash {
        format!("! {}", crate::bash::strip_bang(text))
    } else {
        text.to_owned()
    };
    let chat_agent = if is_bash {
        None
    } else {
        Some(agent.ok_or(DispatchError::NoSession)?)
    };
    session.lock().await.session(session_id)?;
    if let Some(agent) = agent {
        agent
            .cancel(session_id)
            .await
            .map_err(|error| map_dispatch_agent_error(&error))?;
    }
    {
        let mut session = session.lock().await;
        session.interrupt_review_turn(session_id);
        session.set_running(session_id, false);
        if is_bash {
            return run_bash_for_session(session_id, &wire, &mut session);
        }
        session.begin_review_turn(session_id)?;
        session.set_running(session_id, true);
    }
    let agent = chat_agent.expect("non-bash path holds an agent");
    let sent = agent.prompt(session_id, &wire).await;
    {
        let mut session = session.lock().await;
        if let Ok(result) = &sent {
            session.finish_review_turn(session_id, Some(result));
        } else {
            session.interrupt_review_turn(session_id);
            session.set_running(session_id, false);
        }
    }
    sent.map_err(|error| map_dispatch_agent_error(&error))?;
    Ok(DispatchOutcome::PromptAccepted)
}

fn run_bash_for_session(
    session_id: &str,
    wire: &str,
    session: &mut SessionState,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;
    let path = {
        let live = session.session(session_id)?;
        session
            .workspaces
            .get(&live.workspace_id)
            .ok_or(DispatchError::UnknownWorkspace)?
            .path
            .clone()
    };
    session.begin_review_turn(session_id)?;
    let result = crate::bash::run_in_cwd(&path, wire);
    session.interrupt_review_turn(session_id);
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

async fn run_unlocked(
    envelope: &CommandEnvelope,
    journal: &Mutex<Journal>,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;
    use crate::protocol::Operation;

    match &envelope.operation {
        Operation::Bootstrap | Operation::ListWorkspaces => {
            let journal = journal.lock().await;
            let session = session.lock().await;
            Ok(DispatchOutcome::Workspaces {
                workspaces: session.project_workspaces(),
                projects: session.project_projects(),
                open_sessions: session.project_sessions(),
                integrations: crate::integrations::list(),
                pending_reviews: journal
                    .pending_reviews()
                    .into_iter()
                    .map(crate::dispatch::ReviewProjection::from)
                    .collect(),
            })
        }
        Operation::ListSessions { workspace_id } => {
            let session = session.lock().await;
            let workspace = session
                .workspaces
                .get(workspace_id)
                .ok_or(DispatchError::UnknownWorkspace)?;
            let sessions = crate::session_catalog::list_for_cwd(&workspace.path);
            Ok(DispatchOutcome::Sessions {
                workspace_id: workspace_id.clone(),
                sessions,
            })
        }
        // Agent-bound ops release the locks before awaiting the child.
        Operation::RemoveQueued {
            session_id,
            entry_id,
        } => {
            session.lock().await.remove_queued(session_id, entry_id)?;
            Ok(DispatchOutcome::QueueChanged {
                session_id: session_id.clone(),
            })
        }

        Operation::SendNow {
            session_id,
            text,
            bash,
        } => send_now_unlocked(session_id, text, *bash, session, agent).await,

        Operation::Prompt {
            session_id,
            text,
            bash,
        } => prompt_or_queue(session_id, text, *bash, session, agent).await,

        Operation::ListModels => Ok(DispatchOutcome::Models {
            models: crate::models::list_models(),
            default_model_id: crate::models::default_model_id(),
        }),

        Operation::GetHostStatus => Ok(project_host_status_unlocked()),

        Operation::DiagnoseSession { session_id } => {
            diagnose_or_repair_unlocked(session_id, true, session, agent).await
        }
        Operation::RepairSession {
            session_id,
            dry_run,
        } => diagnose_or_repair_unlocked(session_id, *dry_run, session, agent).await,

        Operation::ListTools { workspace_id } => {
            let cwd = {
                let session = session.lock().await;
                workspace_id.as_ref().and_then(|id| {
                    session
                        .workspaces
                        .get(id)
                        .map(|workspace| workspace.path.clone())
                })
            };
            Ok(DispatchOutcome::Tools {
                tools: crate::tools::list_tools_for_cwd(cwd.as_deref()),
            })
        }

        Operation::ListContext {
            workspace_id,
            query,
        } => list_context_unlocked(workspace_id, query.as_deref(), session).await,

        Operation::GetSessionInspector { session_id } => {
            let (root, local) = session.lock().await.review_snapshot(session_id)?;
            Ok(DispatchOutcome::SessionInspector {
                inspector: Box::new(
                    crate::review::inspect_session(session_id, &root, &local).await,
                ),
            })
        }

        Operation::GetSessionChanges { session_id, mode } => {
            let (root, local) = session.lock().await.review_snapshot(session_id)?;
            Ok(DispatchOutcome::SessionChanges {
                session_id: session_id.clone(),
                mode: *mode,
                changes: crate::review::collect_changes(session_id, &root, *mode, &local).await,
            })
        }

        Operation::SetSessionModel {
            session_id,
            model_id,
            reasoning_effort,
        } => {
            session.lock().await.session(session_id)?;
            if !crate::models::is_grok_model_id(model_id) {
                return Err(DispatchError::Unsupported);
            }
            let agent = agent.ok_or(DispatchError::NoSession)?;
            agent
                .set_session_model(session_id, model_id, reasoning_effort.as_deref())
                .await
                .map_err(|error| map_dispatch_agent_error(&error))?;
            session.lock().await.set_review_model(session_id, model_id);
            Ok(DispatchOutcome::ModelSet {
                session_id: session_id.clone(),
                model_id: model_id.clone(),
                reasoning_effort: reasoning_effort.clone(),
            })
        }
        Operation::CreateSession { workspace_id } => {
            open_session(workspace_id, None, session, agent).await
        }
        Operation::LoadSession {
            workspace_id,
            session_id,
        } => open_session(workspace_id, Some(session_id), session, agent).await,
        Operation::CancelTurn { session_id } => {
            session.lock().await.session(session_id)?;
            let agent = agent.ok_or(DispatchError::NoSession)?;
            agent
                .cancel(session_id)
                .await
                .map_err(|error| map_dispatch_agent_error(&error))?;
            session.lock().await.interrupt_review_turn(session_id);
            Ok(DispatchOutcome::Cancelled)
        }
        Operation::DecidePermission {
            session_id,
            request_id,
            option_id,
        } => {
            let pending = {
                let session = session.lock().await;
                session
                    .pending_permissions
                    .get(request_id)
                    .cloned()
                    .ok_or(DispatchError::UnknownPermission)?
            };
            // The request has to belong to the session the browser named, or
            // a decision made in one conversation could answer another.
            if pending.session_id != *session_id {
                return Err(DispatchError::UnknownPermission);
            }
            crate::permission::authorize_answer(&pending.offered, option_id)
                .map_err(DispatchError::from)?;
            let agent = agent.ok_or(DispatchError::NoSession)?;
            agent
                .answer_permission(&pending.request_id, option_id)
                .await
                .map_err(|error| map_dispatch_agent_error(&error))?;
            session.lock().await.pending_permissions.remove(request_id);
            Ok(DispatchOutcome::PermissionAnswered {
                option_id: option_id.clone(),
            })
        }
        // Non-agent operations keep the original path: short and pure.
        _ => {
            let mut journal = journal.lock().await;
            let mut session = session.lock().await;
            // Intent was already begun above; call `run` through a thin
            // wrapper that skips a second begin by going via dispatch only
            // for ops without side effects, or re-enter carefully.
            //
            // Side-effecting ops that land here (CloseSession, RemoveWorkspace,
            // OpenWorkspacePicker, AcknowledgeInterrupted) have already begun
            // intent. The original `dispatch` would begin again and refuse.
            // So for those we call the inner path that does not re-begin:
            // complete is still handled by the outer `dispatch_unlocked`.
            run_without_begin(envelope, &mut journal, &mut session, agent)
        }
    }
}

/// Map an ACP failure the same way pure dispatch does.
fn map_dispatch_agent_error(error: &crate::acp::AcpError) -> crate::dispatch::DispatchError {
    if error.is_unsupported_method() {
        crate::dispatch::DispatchError::Unsupported
    } else {
        crate::dispatch::DispatchError::Agent
    }
}

/// Project what the user may mention with `@` (light ADR 0013).
///
/// The root is resolved from the opaque id here, under the lock, and the walk
/// runs on that resolved path — never on anything the browser supplied
/// (light ADR 0009). A workspace that no longer resolves is refused.
async fn list_context_unlocked(
    workspace_id: &str,
    query: Option<&str>,
    session: &Mutex<SessionState>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    let root = {
        let session = session.lock().await;
        session
            .workspaces
            .get(workspace_id)
            .map(|workspace| workspace.path.clone())
            .ok_or(crate::dispatch::DispatchError::UnknownWorkspace)?
    };
    Ok(DispatchOutcome::Context {
        workspace_id: workspace_id.to_owned(),
        entries: crate::context::list_context(&root, query),
    })
}

/// Run the non-agent half of dispatch without a second intent begin.
///
/// Side-effecting ops that do not call the agent still need their state
/// mutation, but intent was already written by [`dispatch_unlocked`].
fn run_without_begin(
    envelope: &CommandEnvelope,
    journal: &mut Journal,
    session: &mut SessionState,
    _agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;
    use crate::protocol::Operation;

    match &envelope.operation {
        Operation::Bootstrap | Operation::ListWorkspaces => {
            // Handled above; kept for exhaustiveness.
            Ok(DispatchOutcome::Workspaces {
                workspaces: session.project_workspaces(),
                projects: session.project_projects(),
                open_sessions: session.project_sessions(),
                integrations: crate::integrations::list(),
                pending_reviews: journal
                    .pending_reviews()
                    .into_iter()
                    .map(crate::dispatch::ReviewProjection::from)
                    .collect(),
            })
        }
        // Enrolment needs HostState; the HTTP handler short-circuits this op.
        Operation::OpenProject { .. } => Err(DispatchError::UnknownWorkspace),
        // Handled in run_unlocked.
        Operation::ListModels
        | Operation::SetSessionModel { .. }
        | Operation::ListTools { .. }
        | Operation::ListContext { .. }
        | Operation::GetSessionInspector { .. }
        | Operation::GetSessionChanges { .. }
        | Operation::GetHostStatus
        | Operation::DiagnoseSession { .. }
        | Operation::RepairSession { .. } => Ok(DispatchOutcome::Projection {
            operation: envelope.operation.name(),
        }),
        Operation::ListSessions { workspace_id } => {
            // Prefer the dedicated branch in `run_unlocked`; this is fallthrough.
            let workspace = session
                .workspaces
                .get(workspace_id)
                .ok_or(DispatchError::UnknownWorkspace)?;
            let sessions = crate::session_catalog::list_for_cwd(&workspace.path);
            Ok(DispatchOutcome::Sessions {
                workspace_id: workspace_id.clone(),
                sessions,
            })
        }
        Operation::CloseSession { session_id } => {
            session.close_session(session_id)?;
            Ok(DispatchOutcome::Closed)
        }
        Operation::RemoveQueued {
            session_id,
            entry_id,
        } => {
            session.remove_queued(session_id, entry_id)?;
            Ok(DispatchOutcome::QueueChanged {
                session_id: session_id.clone(),
            })
        }
        // Both reach the agent, so they are served by the unlocked path.
        Operation::SendNow { .. } => Err(DispatchError::NoSession),
        Operation::OpenWorkspacePicker => {
            if session.picker_open {
                return Err(DispatchError::PickerAlreadyOpen);
            }
            session.picker_open = true;
            Ok(DispatchOutcome::PickerOpened)
        }
        Operation::RemoveWorkspace { workspace_id } => {
            if !session.workspaces.contains_key(workspace_id) {
                return Err(DispatchError::UnknownWorkspace);
            }
            session.workspaces.remove(workspace_id);
            Ok(DispatchOutcome::WorkspaceRemoved {
                workspace_id: workspace_id.clone(),
            })
        }
        Operation::AcknowledgeInterrupted { record_id } => {
            journal
                .acknowledge_interrupted(record_id)
                .map_err(|_| DispatchError::UnknownReviewRecord)?;
            Ok(DispatchOutcome::Acknowledged)
        }
        Operation::AcknowledgeEvents { .. } | Operation::RevokeBrowserPairing { .. } => {
            Ok(DispatchOutcome::Acknowledged)
        }
        // Agent-bound ops are handled in `run_unlocked` before this is called.
        Operation::Prompt { .. }
        | Operation::CreateSession { .. }
        | Operation::LoadSession { .. }
        | Operation::CancelTurn { .. }
        | Operation::DecidePermission { .. } => Err(DispatchError::Agent),
    }
}

fn project_host_status_unlocked() -> DispatchOutcome {
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

async fn diagnose_or_repair_unlocked(
    session_id: &str,
    dry_run: bool,
    session: &Mutex<SessionState>,
    agent: Option<&Arc<crate::acp::AgentHandle>>,
) -> Result<DispatchOutcome, crate::dispatch::DispatchError> {
    use crate::dispatch::DispatchError;
    session.lock().await.session(session_id)?;
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
        Err(error) => Err(map_dispatch_agent_error(&error)),
    }
}

/// Whether a queued entry is host-local bash (leading `!`), not agent chat.
///
/// Queued bash must drain without an agent process; chat still needs one.
#[must_use]
pub(crate) fn queue_entry_is_bash(text: &str) -> bool {
    text.trim_start().starts_with('!')
}

/// Stream host-local shell output into the transcript.
///
/// Only `messageDelta` — never `promptSent` or `sessionStatus`. Callers own
/// the user line (SPA optimistic insert or drain_queue `PromptSent`) and the
/// idle transition (`turn_phase_should_clear` / drain loop).
async fn emit_bash_output(state: &Arc<HostState>, session_id: &str, output: &str) {
    state
        .emit_event(
            Event::MessageDelta {
                session_id: session_id.to_owned(),
                text: output.to_owned(),
            },
            None,
        )
        .await;
}

#[cfg(test)]
mod bash_wire_tests {
    use super::queue_entry_is_bash;

    #[test]
    fn queue_entry_is_bash_detects_bang_prefix() {
        assert!(queue_entry_is_bash("! ls"));
        assert!(queue_entry_is_bash("  !echo hi"));
        assert!(!queue_entry_is_bash("ls"));
        assert!(!queue_entry_is_bash("hello agent"));
    }

    #[test]
    fn emit_bash_output_is_output_only_not_prompt_sent() {
        // Structural contract: only MessageDelta inside the helper body.
        let source = include_str!("server.rs");
        let start = source
            .find("async fn emit_bash_output")
            .expect("emit_bash_output present");
        let after = &source[start..];
        // Body ends at the first closing brace that sits alone on a line
        // after MessageDelta (function is intentionally tiny).
        let brace = after.find("\n}\n").expect("function closing brace");
        let fn_body = &after[..brace];
        assert!(
            fn_body.contains("MessageDelta"),
            "emit_bash_output must emit MessageDelta"
        );
        assert!(
            !fn_body.contains("PromptSent"),
            "emit_bash_output must not emit PromptSent (SPA/drain already own the user line)"
        );
        assert!(
            !fn_body.contains("SessionStatus"),
            "emit_bash_output must not emit SessionStatus (caller owns idle)"
        );
        // Exactly one event emission path.
        assert_eq!(
            fn_body.matches("emit_event").count(),
            1,
            "emit_bash_output must emit exactly one event"
        );
    }
}

/// Resolve the browser session token for HTTP or WebSocket (ADR 0016).
///
/// Order: `x-gl-session` header → `gls.*` WebSocket subprotocol → cookie.
fn session_token(headers: &HeaderMap) -> Option<&str> {
    if let Some(token) = header_str(headers, SESSION_HEADER) {
        if !token.is_empty() {
            return Some(token);
        }
    }
    if let Some(token) = session_token_from_ws_protocols(headers) {
        return Some(token);
    }
    header_str(headers, header::COOKIE)?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value)
}

use crate::now_ms;

/// Whether a finished command should clear the browser's streaming phase.
fn turn_phase_should_clear(
    operation: &crate::protocol::Operation,
    outcome: &Result<DispatchOutcome, crate::dispatch::DispatchError>,
) -> bool {
    use crate::dispatch::DispatchError;
    use crate::protocol::Operation;

    match operation {
        Operation::Prompt { .. } | Operation::CancelTurn { .. } | Operation::SendNow { .. } => {
            match outcome {
                // A finished turn and a mid-turn agent failure both hand control
                // back to the page: either way it must be able to type again.
                // Review records, if any, ride separately on the next refresh.
                // BashRan is host-local shell; still clears streaming phase.
                Ok(
                    DispatchOutcome::PromptAccepted
                    | DispatchOutcome::Cancelled
                    | DispatchOutcome::BashRan { .. },
                )
                | Err(DispatchError::Agent) => true,
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CONTENT_SECURITY_POLICY, CSRF_HEADER, HostState, PairResponse, SESSION_COOKIE, router,
    };
    use crate::origin::LocalOrigin;
    use crate::protocol::PROTOCOL_VERSION;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const INSTALL: &str = "0123456789abcdef0123456789abcdef";

    fn state() -> Arc<HostState> {
        let origin = LocalOrigin::new(INSTALL, 20_001).expect("origin");
        Arc::new(HostState::new(origin))
    }

    fn host_header() -> String {
        format!("{INSTALL}.grok-light.localhost:20001")
    }

    fn origin_header() -> String {
        format!("http://{}", host_header())
    }

    async fn body_string(response: axum::response::Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        String::from_utf8(bytes.to_vec()).expect("utf8")
    }

    #[tokio::test]
    async fn document_is_served_without_an_origin_header() {
        // Browsers omit Origin on a document navigation; requiring it would
        // reject the application's own entry point.
        let response = router(state())
            .oneshot(
                Request::get("/")
                    .header(header::HOST, host_header())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn every_response_carries_the_strict_header_set() {
        let response = router(state())
            .oneshot(
                Request::get("/")
                    .header(header::HOST, host_header())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        let headers = response.headers();
        assert_eq!(
            headers
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|v| v.to_str().ok()),
            Some(CONTENT_SECURITY_POLICY)
        );
        assert_eq!(headers.get(header::REFERRER_POLICY).unwrap(), "no-referrer");
        assert_eq!(
            headers.get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
        assert_eq!(
            headers.get("cross-origin-opener-policy").unwrap(),
            "same-origin"
        );
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert!(headers.get("permissions-policy").is_some());
        assert!(
            CONTENT_SECURITY_POLICY.contains("connect-src 'self'"),
            "the loopback origin must not need a widened connect-src"
        );
        assert!(CONTENT_SECURITY_POLICY.contains("frame-ancestors 'none'"));
    }

    #[tokio::test]
    async fn a_foreign_host_header_is_refused() {
        // Loopback API hosts (127.0.0.1 / localhost) are accepted under ADR 0016;
        // refuse everything else and wrong ports.
        for host in [
            "evil.example",
            "192.168.1.1:20001",
            "0123456789abcdef0123456789abcdef.grok-light.localhost:20002",
        ] {
            let response = router(state())
                .oneshot(
                    Request::get("/")
                        .header(header::HOST, host)
                        .body(Body::empty())
                        .expect("request"),
                )
                .await
                .expect("response");
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "host {host} must be refused"
            );
        }
    }

    #[tokio::test]
    async fn hosted_origin_preflight_and_healthz_are_accepted() {
        use crate::origin::PRODUCTION_WEB_ORIGIN;
        let state = state();
        let port = state.origin.port();
        let api_host = format!("127.0.0.1:{port}");

        let preflight = router(Arc::clone(&state))
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/command")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some(PRODUCTION_WEB_ORIGIN)
        );

        let health = router(state)
            .oneshot(
                Request::get("/healthz")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(health.status(), StatusCode::OK);
        let body = axum::body::to_bytes(health.into_body(), 1024)
            .await
            .expect("body");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(json["ok"], true);
        assert_eq!(json["mode"], "bridge");
    }

    #[tokio::test]
    async fn foreign_web_origin_cannot_preflight() {
        let state = state();
        let port = state.origin.port();
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/command")
                    .header(header::HOST, format!("127.0.0.1:{port}"))
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn hosted_origin_can_pair_once_and_foreign_cannot() {
        use crate::origin::PRODUCTION_WEB_ORIGIN;
        use super::SESSION_HEADER;
        let state = state();
        let port = state.origin.port();
        let api_host = format!("127.0.0.1:{port}");
        let now = super::now_ms();
        let nonce = state
            .pairing
            .lock()
            .await
            .mint_nonce(now)
            .expect("mint")
            .expose()
            .to_owned();

        let pair = router(Arc::clone(&state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(pair.status(), StatusCode::OK);
        assert!(
            pair.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_some()
        );
        let body = axum::body::to_bytes(pair.into_body(), 1 << 16)
            .await
            .expect("body");
        let parsed: PairResponse = serde_json::from_slice(&body).expect("json");
        assert!(!parsed.session_token.is_empty());
        assert!(!parsed.csrf_token.is_empty());

        // Second redeem fails.
        let again = router(Arc::clone(&state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(again.status(), StatusCode::FORBIDDEN);

        // Foreign origin cannot pair with a fresh nonce.
        let nonce2 = state
            .pairing
            .lock()
            .await
            .mint_nonce(now + 1)
            .expect("mint")
            .expose()
            .to_owned();
        let evil = router(Arc::clone(&state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, "https://evil.example")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce2}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(evil.status(), StatusCode::FORBIDDEN);

        // Session header authenticates resume.
        let resume = router(state)
            .oneshot(
                Request::get("/session")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .header(SESSION_HEADER, &parsed.session_token)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(resume.status(), StatusCode::OK);
    }

    #[test]
    fn session_token_reads_gls_ws_protocol_without_cookie() {
        use super::{WS_SESSION_PROTOCOL_PREFIX, session_token};
        use axum::http::HeaderValue;

        let token = "a".repeat(64);
        let protocols = format!(
            "{}, {}{token}",
            crate::protocol::WS_SUBPROTOCOL,
            WS_SESSION_PROTOCOL_PREFIX
        );
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::HeaderName::from_static("sec-websocket-protocol"),
            HeaderValue::from_str(&protocols).expect("value"),
        );
        assert_eq!(session_token(&headers), Some(token.as_str()));

        let mut family_only = header::HeaderMap::new();
        family_only.insert(
            header::HeaderName::from_static("sec-websocket-protocol"),
            HeaderValue::from_static(crate::protocol::WS_SUBPROTOCOL),
        );
        assert_eq!(
            session_token(&family_only),
            None,
            "family protocol alone must not authenticate"
        );
    }

    #[tokio::test]
    async fn hosted_ws_gls_token_authenticates_session_without_cookie() {
        // Hosted SPA cannot send Cookie (SameSite) or custom headers on WS.
        // Auth rides in Sec-WebSocket-Protocol as gls.<token> (ADR 0016).
        // oneshot cannot complete a real 101 upgrade; we drive the shipped
        // session_token() + verify_session path the events handler uses.
        use crate::origin::PRODUCTION_WEB_ORIGIN;
        use super::{WS_SESSION_PROTOCOL_PREFIX, session_token};
        use axum::http::HeaderValue;

        let state = state();
        let port = state.origin.port();
        let api_host = format!("127.0.0.1:{port}");
        let now = super::now_ms();
        let nonce = state
            .pairing
            .lock()
            .await
            .mint_nonce(now)
            .expect("mint")
            .expose()
            .to_owned();
        let pair = router(Arc::clone(&state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, &api_host)
                    .header(header::ORIGIN, PRODUCTION_WEB_ORIGIN)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(pair.status(), StatusCode::OK);
        let body = axum::body::to_bytes(pair.into_body(), 1 << 16)
            .await
            .expect("body");
        let parsed: PairResponse = serde_json::from_slice(&body).expect("json");

        let protocols = format!(
            "{}, {}{}",
            crate::protocol::WS_SUBPROTOCOL,
            WS_SESSION_PROTOCOL_PREFIX,
            parsed.session_token
        );
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::HeaderName::from_static("sec-websocket-protocol"),
            HeaderValue::from_str(&protocols).expect("protocols"),
        );
        // No Cookie, no x-gl-session — only what a browser WS handshake can send.
        let token = session_token(&headers).expect("gls token");
        assert_eq!(token, parsed.session_token);
        let session_id = state
            .pairing
            .lock()
            .await
            .verify_session(token, now + 1)
            .expect("session must verify");
        assert!(!session_id.is_empty());

        let mut naked = header::HeaderMap::new();
        naked.insert(
            header::HeaderName::from_static("sec-websocket-protocol"),
            HeaderValue::from_static(crate::protocol::WS_SUBPROTOCOL),
        );
        assert!(
            session_token(&naked).is_none(),
            "family protocol alone must not authenticate"
        );
    }

    #[tokio::test]
    async fn a_cross_origin_get_is_refused_even_though_origin_is_optional() {
        let response = router(state())
            .oneshot(
                Request::get("/")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, "http://evil.example")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_cross_site_fetch_metadata_signal_is_refused() {
        let response = router(state())
            .oneshot(
                Request::get("/")
                    .header(header::HOST, host_header())
                    .header("sec-fetch-site", "cross-site")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_mutation_without_an_origin_header_is_refused() {
        let response = router(state())
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, host_header())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"nonce":"x"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn pairing_round_trip_sets_a_hardened_cookie() {
        let state = state();
        let nonce = {
            let mut broker = state.pairing.lock().await;
            broker
                .mint_nonce(super::now_ms())
                .expect("mint")
                .expose()
                .to_owned()
        };

        let response = router(Arc::clone(&state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .expect("set-cookie")
            .to_owned();
        assert!(cookie.starts_with(SESSION_COOKIE));
        assert!(cookie.contains("HttpOnly"), "cookie must be HttpOnly");
        assert!(
            cookie.contains("SameSite=Strict"),
            "cookie must be SameSite=Strict"
        );
        assert!(
            !cookie.contains("Domain="),
            "cookie must stay host-only, got {cookie}"
        );

        let parsed: PairResponse =
            serde_json::from_str(&body_string(response).await).expect("json");
        assert_eq!(parsed.protocol_version, PROTOCOL_VERSION);
        assert!(!parsed.csrf_token.is_empty());
    }

    #[tokio::test]
    async fn a_wrong_nonce_is_refused_uniformly() {
        let state = state();
        {
            let mut broker = state.pairing.lock().await;
            broker.mint_nonce(super::now_ms()).expect("mint");
        }
        let response = router(state)
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"nonce":"0000"}"#))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    async fn paired(state: &Arc<HostState>) -> (String, String) {
        let nonce = {
            let mut broker = state.pairing.lock().await;
            broker
                .mint_nonce(super::now_ms())
                .expect("mint")
                .expose()
                .to_owned()
        };
        let response = router(Arc::clone(state))
            .oneshot(
                Request::post("/pair")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"nonce":"{nonce}"}}"#)))
                    .expect("request"),
            )
            .await
            .expect("response");
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .expect("cookie")
            .split(';')
            .next()
            .expect("value")
            .to_owned();
        let parsed: PairResponse =
            serde_json::from_str(&body_string(response).await).expect("json");
        (cookie, parsed.csrf_token)
    }

    fn bootstrap_body() -> String {
        format!(
            r#"{{"protocolVersion":{PROTOCOL_VERSION},"requestId":"req-1","operation":{{"kind":"bootstrap"}}}}"#
        )
    }

    #[tokio::test]
    async fn a_paired_command_with_csrf_is_accepted() {
        let state = state();
        let (cookie, csrf) = paired(&state).await;
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bootstrap_body()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn resuming_reissues_a_csrf_token_to_a_paired_browser() {
        // A reload keeps the cookie but loses the in-memory CSRF token.
        let state = state();
        let (cookie, first_csrf) = paired(&state).await;

        let response = router(Arc::clone(&state))
            .oneshot(
                Request::get("/session")
                    .header(header::HOST, host_header())
                    .header(header::COOKIE, cookie.clone())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);

        let resumed: PairResponse =
            serde_json::from_str(&body_string(response).await).expect("json");
        assert_ne!(
            resumed.csrf_token, first_csrf,
            "a fresh token must be issued"
        );

        // And the new token works for a mutation.
        let accepted = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, resumed.csrf_token)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bootstrap_body()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn resuming_without_a_pairing_cookie_is_refused() {
        let response = router(state())
            .oneshot(
                Request::get("/session")
                    .header(header::HOST, host_header())
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_command_without_a_cookie_is_refused() {
        let state = state();
        let (_cookie, csrf) = paired(&state).await;
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(CSRF_HEADER, csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bootstrap_body()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_command_without_csrf_is_refused() {
        let state = state();
        let (cookie, _csrf) = paired(&state).await;
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bootstrap_body()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_command_with_a_foreign_csrf_is_refused() {
        let state = state();
        let (cookie, _csrf) = paired(&state).await;
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, "b".repeat(64))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bootstrap_body()))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_oversized_command_body_is_refused_before_parsing() {
        let state = state();
        let (cookie, csrf) = paired(&state).await;
        let huge = "a".repeat(crate::bounds::MAX_COMMAND_BODY_BYTES + 1);
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(huge))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn an_unknown_operation_kind_is_refused() {
        let state = state();
        let (cookie, csrf) = paired(&state).await;
        let body = format!(
            r#"{{"protocolVersion":{PROTOCOL_VERSION},"requestId":"req-1","operation":{{"kind":"execArbitrary"}}}}"#
        );
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_events_upgrade_requires_an_exact_origin() {
        // The upgrade is a GET, so the shared middleware treats it as safe.
        // The handler must still demand Origin with mutation strictness.
        let state = state();
        let (cookie, _csrf) = paired(&state).await;
        let response = router(state)
            .oneshot(
                Request::get("/events")
                    .header(header::HOST, host_header())
                    .header(header::COOKIE, cookie)
                    .header("sec-websocket-protocol", crate::protocol::WS_SUBPROTOCOL)
                    .header(header::CONNECTION, "upgrade")
                    .header(header::UPGRADE, "websocket")
                    .header("sec-websocket-version", "13")
                    .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "an upgrade without Origin must be refused even though it is a GET"
        );
    }

    #[tokio::test]
    async fn a_command_missing_its_controller_epoch_is_refused() {
        let state = state();
        let (cookie, csrf) = paired(&state).await;
        let body = format!(
            r#"{{"protocolVersion":{PROTOCOL_VERSION},"requestId":"req-1","idempotencyKey":"k1","operation":{{"kind":"prompt","text":"hi"}}}}"#
        );
        let response = router(state)
            .oneshot(
                Request::post("/command")
                    .header(header::HOST, host_header())
                    .header(header::ORIGIN, origin_header())
                    .header(header::COOKIE, cookie)
                    .header(CSRF_HEADER, csrf)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_finished_prompt_or_cancel_clears_the_streaming_phase() {
        use super::turn_phase_should_clear;
        use crate::dispatch::{DispatchError, DispatchOutcome};
        use crate::protocol::Operation;

        assert!(turn_phase_should_clear(
            &Operation::Prompt {
                session_id: "s-1".into(),
                text: "hi".into(),
                bash: false
            },
            &Ok(DispatchOutcome::PromptAccepted),
        ));
        assert!(turn_phase_should_clear(
            &Operation::CancelTurn {
                session_id: "s-1".into()
            },
            &Ok(DispatchOutcome::Cancelled),
        ));
        assert!(turn_phase_should_clear(
            &Operation::Prompt {
                session_id: "s-1".into(),
                text: "hi".into(),
                bash: false
            },
            &Err(DispatchError::Agent),
        ));
        assert!(!turn_phase_should_clear(
            &Operation::ListWorkspaces,
            &Ok(DispatchOutcome::PromptAccepted),
        ));
        assert!(!turn_phase_should_clear(
            &Operation::Prompt {
                session_id: "s-1".into(),
                text: "hi".into(),
                bash: false
            },
            &Err(DispatchError::NoSession),
        ));
    }
}
