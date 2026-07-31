//! Unix domain socket control plane.

use std::path::Path;
use std::sync::Arc;

use tokio::net::{UnixListener, UnixStream};

use super::{
    CONTROL_SOCKET_NAME, ControlError, ControlRequest, ControlResponse, handle_connection,
};
use crate::server::HostState;

/// Bound control listener (Unix domain socket).
pub type ControlListener = UnixListener;

/// Bind the owner-only control socket inside the state directory.
///
/// A stale socket from a crashed host is replaced; the instance lock is what
/// guarantees no live host owns it.
///
/// # Errors
///
/// Returns [`ControlError::Io`] when the socket cannot be created.
pub fn bind(directory: &Path) -> Result<ControlListener, ControlError> {
    let path = directory.join(CONTROL_SOCKET_NAME);
    if path.exists() {
        std::fs::remove_file(&path).map_err(ControlError::Io)?;
    }
    let listener = UnixListener::bind(&path).map_err(ControlError::Io)?;
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
pub async fn serve(listener: ControlListener, state: Arc<HostState>) {
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
            let _ = handle_connection(stream, state).await;
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

/// Send one request to a running host and read its answer.
pub async fn call(
    directory: &Path,
    request: &ControlRequest,
) -> Result<ControlResponse, ControlError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let path = directory.join(CONTROL_SOCKET_NAME);
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
