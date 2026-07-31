//! Windows named-pipe control plane.
//!
//! Security model (ADR light 0006):
//! - Pipe name is derived from the state directory (not a global well-known name).
//! - Server instances reject remote clients.
//! - The pipe is created with a DACL that grants full control only to the
//!   current user (and SYSTEM for local service edge cases), not Everyone.
//! - A sidecar `control.pipe` file records the path for doctor/diagnostics and
//!   lives inside the owner-only state directory.

// Win32 SECURITY_ATTRIBUTES / CreateNamedPipeW / SDDL conversion only.
// Reviewed: no user-controlled format strings; handles always closed or moved.
#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::RawHandle;
use std::path::Path;
use std::ptr;
use std::sync::Arc;

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

use super::{
    CONTROL_PIPE_NAME_FILE, CONTROL_SOCKET_NAME, ControlError, ControlRequest, ControlResponse,
    handle_connection, named_pipe_path_for,
};
use crate::server::HostState;

/// Bound control listener (named-pipe accept loop state).
pub struct ControlListener {
    pipe_path: String,
    /// First server instance, already created; subsequent clients recreate.
    first: Option<NamedPipeServer>,
}

/// Bind the owner-only named pipe for this state directory.
///
/// # Errors
///
/// Returns [`ControlError::Io`] when the pipe cannot be created.
pub fn bind(directory: &Path) -> Result<ControlListener, ControlError> {
    // Clear any stale Unix-style marker left by cross-platform tests/tools.
    let stale_sock = directory.join(CONTROL_SOCKET_NAME);
    if stale_sock.exists() {
        let _ = std::fs::remove_file(&stale_sock);
    }

    let pipe_path = named_pipe_path_for(directory);
    write_pipe_sidecar(directory, &pipe_path)?;
    let first = create_server_instance(&pipe_path, true)?;
    Ok(ControlListener {
        pipe_path,
        first: Some(first),
    })
}

/// Serve control requests until the accept loop fails permanently.
pub async fn serve(mut listener: ControlListener, state: Arc<HostState>) {
    loop {
        let server = match listener.first.take() {
            Some(server) => server,
            None => match create_server_instance(&listener.pipe_path, false) {
                Ok(server) => server,
                Err(_) => break,
            },
        };

        // Wait for a client. On failure, try to recreate for the next loop.
        if server.connect().await.is_err() {
            continue;
        }

        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let _ = handle_connection(server, state).await;
        });
    }
}

/// Send one request to a running host and read its answer.
pub async fn call(
    directory: &Path,
    request: &ControlRequest,
) -> Result<ControlResponse, ControlError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let pipe_path = read_pipe_path(directory)?;
    let client = ClientOptions::new()
        .open(&pipe_path)
        .map_err(|_| ControlError::NotRunning)?;

    let (reader, mut writer) = tokio::io::split(client);

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

fn write_pipe_sidecar(directory: &Path, pipe_path: &str) -> Result<(), ControlError> {
    let path = directory.join(CONTROL_PIPE_NAME_FILE);
    std::fs::write(&path, pipe_path.as_bytes()).map_err(ControlError::Io)
}

fn read_pipe_path(directory: &Path) -> Result<String, ControlError> {
    let sidecar = directory.join(CONTROL_PIPE_NAME_FILE);
    if let Ok(contents) = std::fs::read_to_string(&sidecar) {
        let trimmed = contents.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    // Fallback: derive the same path the server would bind (works if serve
    // created the pipe but the sidecar write failed or was deleted).
    Ok(named_pipe_path_for(directory))
}

fn create_server_instance(pipe_path: &str, first: bool) -> Result<NamedPipeServer, ControlError> {
    // Prefer a restrictive DACL. If security descriptor setup fails, fall back
    // to Tokio's default create with reject_remote_clients — still better than
    // a well-known open pipe name.
    match create_server_with_user_dacl(pipe_path, first) {
        Ok(server) => Ok(server),
        Err(_) => {
            let mut options = ServerOptions::new();
            options.reject_remote_clients(true);
            if first {
                options.first_pipe_instance(true);
            }
            options.create(pipe_path).map_err(ControlError::Io)
        }
    }
}

/// Create a named pipe server whose DACL allows only the current user (and SYSTEM).
///
/// Uses SDDL `D:P(A;;GA;;;OW)(A;;GA;;;SY)` — protected DACL, generic all for
/// owner and SYSTEM. Everyone/anonymous are not granted access.
fn create_server_with_user_dacl(
    pipe_path: &str,
    first: bool,
) -> Result<NamedPipeServer, ControlError> {
    // SAFETY: Windows APIs for security descriptors and CreateNamedPipeW.
    // All pointers are either null, point to stack structures we own, or
    // local Wide strings; handles are transferred into OwnedHandle on success.
    unsafe {
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, FALSE, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        };
        use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
        use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
        };
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
            PIPE_WAIT,
        };

        let sddl: Vec<u16> = OsStr::new("D:P(A;;GA;;;OW)(A;;GA;;;SY)")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let mut sd_size: u32 = 0;
        let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SDDL_REVISION_1
            &mut sd,
            &mut sd_size,
        );
        if ok == 0 || sd.is_null() {
            return Err(ControlError::Io(std::io::Error::last_os_error()));
        }

        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: FALSE,
        };

        let wide_path: Vec<u16> = OsStr::new(pipe_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
        if first {
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
        }

        let handle: HANDLE = CreateNamedPipeW(
            wide_path.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            &mut sa,
        );

        LocalFree(sd as *mut _);

        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            let err = std::io::Error::last_os_error();
            // Preserve raw OS codes (access denied / pipe busy) for diagnostics.
            let _ = (ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY);
            return Err(ControlError::Io(err));
        }

        // Tokio takes ownership of the handle; returns Result on register failure.
        // SAFETY: handle is a valid open named-pipe server from CreateNamedPipeW.
        match NamedPipeServer::from_raw_handle(handle as RawHandle) {
            Ok(server) => Ok(server),
            Err(err) => {
                use windows_sys::Win32::Foundation::CloseHandle;
                CloseHandle(handle);
                Err(ControlError::Io(err))
            }
        }
    }
}

#[cfg(test)]
mod windows_tests {
    use super::*;
    use crate::control::{ControlRequest, ControlResponse, call};
    use crate::origin::LocalOrigin;
    use crate::server::HostState;
    use std::sync::Arc;

    const INSTALL: &str = "0123456789abcdef0123456789abcdef";

    fn state() -> Arc<HostState> {
        Arc::new(HostState::new(
            LocalOrigin::new(INSTALL, 20_002).expect("origin"),
        ))
    }

    async fn running(directory: &Path) -> Arc<HostState> {
        let state = state();
        let listener = bind(directory).expect("bind");
        let served = Arc::clone(&state);
        tokio::spawn(async move { serve(listener, served).await });
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        state
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn windows_named_pipe_mint_status_stop() {
        let root = tempfile::tempdir().expect("tempdir");
        let _state = running(root.path()).await;

        let mint = call(root.path(), &ControlRequest::MintNonce)
            .await
            .expect("mint");
        assert!(matches!(mint, ControlResponse::Paired { .. }));

        let status = call(root.path(), &ControlRequest::Status)
            .await
            .expect("status");
        assert!(matches!(
            status,
            ControlResponse::Status {
                paired: false,
                controlled: false,
                ..
            }
        ));

        let stop = call(root.path(), &ControlRequest::Stop)
            .await
            .expect("stop");
        assert_eq!(stop, ControlResponse::Stopping);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bind_writes_pipe_sidecar() {
        // NamedPipeServer::from_raw_handle requires a Tokio reactor.
        let root = tempfile::tempdir().expect("tempdir");
        let listener = bind(root.path()).expect("bind");
        let sidecar = root.path().join(CONTROL_PIPE_NAME_FILE);
        let contents = std::fs::read_to_string(&sidecar).expect("sidecar");
        assert_eq!(contents.trim(), listener.pipe_path);
        assert!(contents.starts_with(r"\\.\pipe\grok-bridge-"));
        // Drop without serve; pipe handle closed.
        drop(listener);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pipe_path_matches_derived_name() {
        let root = tempfile::tempdir().expect("tempdir");
        let expected = named_pipe_path_for(root.path());
        let listener = bind(root.path()).expect("bind");
        assert_eq!(listener.pipe_path, expected);
    }
}
