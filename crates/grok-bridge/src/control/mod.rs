//! Owner-only control plane (Unix domain socket or Windows named pipe).
//!
//! This is the boundary that makes ADR light 0006 hold on a shared machine.
//! Loopback is a machine boundary, not an account boundary: another local user
//! can reach the HTTP listener. They cannot pair, because the pairing nonce is
//! only ever minted here, and here is an owner-only IPC channel (UDS in a
//! `0700` directory with `0600` permissions and peer credentials on Linux;
//! a named pipe with a restrictive DACL on Windows).
//!
//! The surface is deliberately tiny: mint a nonce, report status, ask the host
//! to stop. It never executes anything and never accepts a path.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::now_ms;
use crate::server::HostState;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::{ControlListener, bind, serve};

#[cfg(windows)]
pub use windows::{ControlListener, bind, serve};

/// Marker / socket file name inside the owner-only state directory (Unix).
///
/// On Windows the control endpoint is a named pipe; this name is still used for
/// a small sidecar file that records the pipe path for diagnostics.
pub const CONTROL_SOCKET_NAME: &str = "control.sock";

/// Sidecar file written on Windows with the active named-pipe path.
pub const CONTROL_PIPE_NAME_FILE: &str = "control.pipe";

/// Maximum accepted control request, in bytes.
pub const MAX_CONTROL_REQUEST_BYTES: usize = 4096;

/// Errors produced by the control plane.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    /// The endpoint could not be created or connected.
    #[error("control socket is unusable: {0}")]
    Io(#[source] std::io::Error),
    /// No host is listening.
    #[error("no running host")]
    NotRunning,
    /// The peer is not the owning user.
    #[error("control socket peer is not the owner")]
    ForeignPeer,
    /// The response could not be understood.
    #[error("control response was malformed")]
    Malformed,
}

/// What a local launcher may ask the host to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "camelCase")]
pub enum ControlRequest {
    /// Mint a single-use pairing nonce and return the URL to open.
    MintNonce,
    /// Report host status without changing anything.
    Status,
    /// Ask the host to shut down.
    Stop,
}

/// The host's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum ControlResponse {
    /// A fresh pairing nonce and the URL that carries it in its fragment.
    #[serde(rename_all = "camelCase")]
    Paired {
        /// Canonical origin.
        origin: String,
        /// URL to open, with the nonce in the fragment so it never reaches
        /// the server as a query parameter or in a log.
        url: String,
    },
    /// Current host status.
    #[serde(rename_all = "camelCase")]
    Status {
        /// Canonical origin.
        origin: String,
        /// Whether a browser is currently paired.
        paired: bool,
        /// Whether a tab currently holds the control lease.
        controlled: bool,
    },
    /// The host accepted a stop request.
    Stopping,
    /// The request could not be carried out.
    #[serde(rename_all = "camelCase")]
    Error {
        /// Stable machine-readable code.
        code: String,
    },
}

/// Derive a stable, unguessable Windows named-pipe path from the state directory.
///
/// Callers still enforce owner-only access with a DACL; the hash stops other
/// users from attaching to a predictable name like `\\.\pipe\grok-bridge`.
#[must_use]
pub fn named_pipe_path_for(directory: &Path) -> String {
    let key = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.to_path_buf());
    let digest = Sha256::digest(key.to_string_lossy().as_bytes());
    let mut hex = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!(r"\\.\pipe\grok-bridge-{hex}")
}

/// Send one request to a running host and read its answer.
///
/// # Errors
///
/// Returns [`ControlError::NotRunning`] when no host owns the endpoint, and
/// [`ControlError::Malformed`] when the answer cannot be parsed.
pub async fn call(
    directory: &Path,
    request: &ControlRequest,
) -> Result<ControlResponse, ControlError> {
    #[cfg(unix)]
    {
        unix::call(directory, request).await
    }
    #[cfg(windows)]
    {
        windows::call(directory, request).await
    }
}

/// Shared request handling once a control connection is open.
pub(crate) async fn handle_connection<S>(
    stream: S,
    state: Arc<HostState>,
) -> Result<(), ControlError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .await
        .map_err(ControlError::Io)?;
    if read == 0 || read > MAX_CONTROL_REQUEST_BYTES {
        return Ok(());
    }

    let response = match serde_json::from_str::<ControlRequest>(line.trim()) {
        Ok(request) => execute(request, &state).await,
        Err(_) => ControlResponse::Error {
            code: "malformed_request".into(),
        },
    };

    let mut encoded = serde_json::to_string(&response).map_err(|_| ControlError::Malformed)?;
    encoded.push('\n');
    writer
        .write_all(encoded.as_bytes())
        .await
        .map_err(ControlError::Io)?;
    writer.flush().await.map_err(ControlError::Io)
}

pub(crate) async fn execute(request: ControlRequest, state: &Arc<HostState>) -> ControlResponse {
    let now = now_ms();
    match request {
        ControlRequest::MintNonce => {
            let mut broker = state.pairing.lock().await;
            match broker.mint_nonce(now) {
                Ok(nonce) => {
                    // Production UI is hosted (ADR 0016); nonce rides in the
                    // fragment so it never hits the public site's server logs.
                    // Include API port so the hosted SPA can reach loopback
                    // without guessing (port is stable per install id).
                    let url = format!(
                        "{}/#pair={}&p={}",
                        crate::origin::PRODUCTION_WEB_ORIGIN,
                        nonce.expose(),
                        state.origin.port()
                    );
                    ControlResponse::Paired {
                        origin: state.origin.origin_header(),
                        url,
                    }
                }
                Err(_) => ControlResponse::Error {
                    code: "entropy_unavailable".into(),
                },
            }
        }
        ControlRequest::Status => {
            let paired = state.pairing.lock().await.live_session_count(now) > 0;
            let controlled = state.lease.lock().await.holder_session().is_some();
            ControlResponse::Status {
                origin: state.origin.origin_header(),
                paired,
                controlled,
            }
        }
        ControlRequest::Stop => {
            // Answer first, then stand down: the caller needs the reply on a
            // channel this host still owns.
            state.request_shutdown();
            ControlResponse::Stopping
        }
    }
}

/// Path of the Unix control socket (or Windows diagnostic marker).
#[must_use]
pub fn control_path(directory: &Path) -> PathBuf {
    directory.join(CONTROL_SOCKET_NAME)
}

#[cfg(test)]
mod tests {
    use super::{
        ControlError, ControlRequest, ControlResponse, bind, call, named_pipe_path_for, serve,
    };
    use crate::origin::LocalOrigin;
    use crate::server::HostState;
    use std::sync::Arc;

    const INSTALL: &str = "0123456789abcdef0123456789abcdef";

    fn state() -> Arc<HostState> {
        Arc::new(HostState::new(
            LocalOrigin::new(INSTALL, 20_001).expect("origin"),
        ))
    }

    async fn running(directory: &std::path::Path) -> Arc<HostState> {
        let state = state();
        let listener = bind(directory).expect("bind");
        let served = Arc::clone(&state);
        tokio::spawn(async move { serve(listener, served).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        state
    }

    #[test]
    fn named_pipe_path_is_stable_and_namespaced() {
        let dir = std::path::Path::new("/tmp/grok-bridge-state-example");
        let a = named_pipe_path_for(dir);
        let b = named_pipe_path_for(dir);
        assert_eq!(a, b);
        assert!(a.starts_with(r"\\.\pipe\grok-bridge-"));
        assert_eq!(a.len(), r"\\.\pipe\grok-bridge-".len() + 32);
    }

    #[test]
    fn different_state_dirs_get_different_pipe_names() {
        let a = named_pipe_path_for(std::path::Path::new("/tmp/state-a"));
        let b = named_pipe_path_for(std::path::Path::new("/tmp/state-b"));
        assert_ne!(a, b);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn minting_returns_a_url_with_the_nonce_in_the_fragment() {
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        let response = call(root.path(), &ControlRequest::MintNonce)
            .await
            .expect("mint");
        let ControlResponse::Paired { origin: _, url } = response else {
            panic!("expected a pairing response, got {response:?}");
        };
        assert!(
            url.starts_with(crate::origin::PRODUCTION_WEB_ORIGIN),
            "hosted UI pair URL must target desktop.grok.me, got {url}"
        );
        assert!(
            url.contains("/#pair="),
            "the nonce must ride in the fragment so it never reaches the server"
        );
        assert!(
            !url.contains("?pair="),
            "the nonce must never appear as a query parameter"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_minted_nonce_is_redeemable_exactly_once() {
        let root = tempfile::tempdir().expect("tempdir");
        let state = running(root.path()).await;

        let response = call(root.path(), &ControlRequest::MintNonce)
            .await
            .expect("mint");
        let ControlResponse::Paired { url, .. } = response else {
            panic!("expected pairing");
        };
        let nonce = url
            .rsplit("#pair=")
            .next()
            .and_then(|rest| rest.split('&').next())
            .expect("nonce")
            .to_owned();

        let now = crate::now_ms();
        let mut broker = state.pairing.lock().await;
        assert!(broker.redeem_nonce(&nonce, now).is_ok());
        assert!(
            broker.redeem_nonce(&nonce, now).is_err(),
            "a nonce must not be reusable"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_reports_pairing_and_control_without_changing_them() {
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        let response = call(root.path(), &ControlRequest::Status)
            .await
            .expect("status");
        let ControlResponse::Status {
            paired, controlled, ..
        } = response
        else {
            panic!("expected status, got {response:?}");
        };
        assert!(!paired);
        assert!(!controlled);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_is_accepted_by_a_running_host() {
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        let response = call(root.path(), &ControlRequest::Stop)
            .await
            .expect("stop");
        assert_eq!(response, ControlResponse::Stopping);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn calling_without_a_running_host_reports_not_running() {
        let root = tempfile::tempdir().expect("tempdir");
        let result = call(root.path(), &ControlRequest::Status).await;
        assert!(
            matches!(result, Err(ControlError::NotRunning)),
            "a stopped host must be reported, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_malformed_request_is_answered_without_crashing_the_socket() {
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        #[cfg(unix)]
        {
            use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
            let stream =
                tokio::net::UnixStream::connect(root.path().join(super::CONTROL_SOCKET_NAME))
                    .await
                    .expect("connect");
            let (reader, mut writer) = stream.into_split();
            writer
                .write_all(b"{\"command\":\"rmRf\"}\n")
                .await
                .expect("write");
            writer.flush().await.expect("flush");

            let mut line = String::new();
            BufReader::new(reader)
                .read_line(&mut line)
                .await
                .expect("read");
            let response: ControlResponse = serde_json::from_str(line.trim()).expect("json");
            assert_eq!(
                response,
                ControlResponse::Error {
                    code: "malformed_request".into()
                }
            );
        }

        // The endpoint still serves the next caller.
        let next = call(root.path(), &ControlRequest::Status).await;
        assert!(next.is_ok(), "one bad request must not kill the socket");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;
        let mode = std::fs::metadata(root.path().join(super::CONTROL_SOCKET_NAME))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o077,
            0,
            "another local user must not be able to open the control socket"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_socket_is_replaced() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join(super::CONTROL_SOCKET_NAME), b"stale").expect("stale file");
        let _state = running(root.path()).await;
        let response = call(root.path(), &ControlRequest::Status).await;
        assert!(
            response.is_ok(),
            "a crashed host must not block the next one"
        );
    }
}
