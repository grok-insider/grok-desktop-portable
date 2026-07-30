//! Owner-only control socket.
//!
//! This is the boundary that makes ADR light 0006 hold on a shared machine.
//! Loopback is a machine boundary, not an account boundary: another local user
//! can reach the HTTP listener. They cannot pair, because the pairing nonce is
//! only ever minted here, and here is a Unix socket inside a `0700` directory
//! with `0600` permissions, guarded by a peer credential check.
//!
//! The surface is deliberately tiny: mint a nonce, report status, ask the host
//! to stop. It never executes anything and never accepts a path.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::server::HostState;

/// Socket file inside the owner-only state directory.
pub const CONTROL_SOCKET_NAME: &str = "control.sock";

/// Maximum accepted control request, in bytes.
pub const MAX_CONTROL_REQUEST_BYTES: usize = 4096;

/// Errors produced by the control socket.
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    /// The socket could not be created or connected.
    #[error("control socket is unusable: {0}")]
    Io(#[source] std::io::Error),
    /// No host is listening on the socket.
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

/// Bind the owner-only control socket inside the state directory.
///
/// A stale socket from a crashed host is replaced; the instance lock is what
/// guarantees no live host owns it.
///
/// # Errors
///
/// Returns [`ControlError::Io`] when the socket cannot be created.
pub fn bind(directory: &Path) -> Result<UnixListener, ControlError> {
    let path = directory.join(CONTROL_SOCKET_NAME);
    if path.exists() {
        std::fs::remove_file(&path).map_err(ControlError::Io)?;
    }
    let listener = UnixListener::bind(&path).map_err(ControlError::Io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(ControlError::Io)?;
    }
    Ok(listener)
}

/// Serve control requests until the listener fails.
///
/// Every connection is checked against the owning uid before it is read.
pub async fn serve(listener: UnixListener, state: Arc<HostState>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        if !peer_is_owner(&stream) {
            // Another local user reached the socket. Drop without answering.
            continue;
        }
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _ = handle(stream, state).await;
        });
    }
}

/// Whether the connected peer runs as the owning user.
///
/// Defence in depth: the socket already lives in a `0700` directory, so a
/// foreign peer should not be able to reach it at all.
fn peer_is_owner(stream: &UnixStream) -> bool {
    #[cfg(target_os = "linux")]
    {
        match stream.peer_cred() {
            Ok(credentials) => credentials.uid() == rustix::process::geteuid().as_raw(),
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = stream;
        true
    }
}

async fn handle(stream: UnixStream, state: Arc<HostState>) -> Result<(), ControlError> {
    let (reader, mut writer) = stream.into_split();
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

async fn execute(request: ControlRequest, state: &Arc<HostState>) -> ControlResponse {
    let now = now_ms();
    match request {
        ControlRequest::MintNonce => {
            let mut broker = state.pairing.lock().await;
            match broker.mint_nonce(now) {
                Ok(nonce) => {
                    // Production UI is hosted (ADR 0016); nonce rides in the
                    // fragment so it never hits the public site's server logs.
                    let url = format!(
                        "{}/#pair={}",
                        crate::origin::PRODUCTION_WEB_ORIGIN,
                        nonce.expose()
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
            // socket this host still owns.
            state.request_shutdown();
            ControlResponse::Stopping
        }
    }
}

/// Send one request to a running host and read its answer.
///
/// # Errors
///
/// Returns [`ControlError::NotRunning`] when no host owns the socket, and
/// [`ControlError::Malformed`] when the answer cannot be parsed.
pub async fn call(
    directory: &Path,
    request: &ControlRequest,
) -> Result<ControlResponse, ControlError> {
    let path: PathBuf = directory.join(CONTROL_SOCKET_NAME);
    let stream = UnixStream::connect(&path)
        .await
        .map_err(|_| ControlError::NotRunning)?;
    let (reader, mut writer) = stream.into_split();

    let mut encoded = serde_json::to_string(request).map_err(|_| ControlError::Malformed)?;
    encoded.push('\n');
    writer
        .write_all(encoded.as_bytes())
        .await
        .map_err(ControlError::Io)?;
    writer.flush().await.map_err(ControlError::Io)?;

    let mut line = String::new();
    BufReader::new(reader)
        .read_line(&mut line)
        .await
        .map_err(ControlError::Io)?;
    serde_json::from_str(line.trim()).map_err(|_| ControlError::Malformed)
}

use crate::now_ms;

#[cfg(test)]
mod tests {
    use super::{
        CONTROL_SOCKET_NAME, ControlError, ControlRequest, ControlResponse, bind, call, serve,
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
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        state
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
        let nonce = url.rsplit("#pair=").next().expect("nonce").to_owned();

        let now = super::now_ms();
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
        use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        let stream = tokio::net::UnixStream::connect(root.path().join(CONTROL_SOCKET_NAME))
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

        // The socket still serves the next caller.
        let next = call(root.path(), &ControlRequest::Status).await;
        assert!(next.is_ok(), "one bad request must not kill the socket");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_socket_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;
        let mode = std::fs::metadata(root.path().join(CONTROL_SOCKET_NAME))
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
        std::fs::write(root.path().join(CONTROL_SOCKET_NAME), b"stale").expect("stale file");
        let _state = running(root.path()).await;
        let response = call(root.path(), &ControlRequest::Status).await;
        assert!(
            response.is_ok(),
            "a crashed host must not block the next one"
        );
    }
}
