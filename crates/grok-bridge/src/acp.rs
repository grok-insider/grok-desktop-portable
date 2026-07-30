//! Supervised ACP client over the Grok Build CLI's stdio transport.
//!
//! Implements ADR light 0003. Production spawns
//! `grok agent --no-leader stdio` and speaks newline-delimited JSON-RPC over
//! the child's pipes. `grok agent serve` is never used as a browser-facing
//! listener and never as a production transport.
//!
//! The browser never sees any of this. The host translates ACP into the closed
//! `light.local.v1` surface.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::timeout;

/// ACP wire version this host implements.
pub const ACP_PROTOCOL_VERSION: u32 = 1;

/// Client identifier Light presents to the agent.
///
/// The agent resolves any unrecognised identifier to its `Generic` client
/// type, which is the conservative option presentation. See ADR light 0007.
pub const CLIENT_IDENTIFIER: &str = "grok-light";

/// Environment variable the CLI reads to determine the client identifier.
pub const CLIENT_NAME_ENV: &str = "GROK_CLIENT_NAME";

/// Maximum accepted length of one JSON-RPC line from the agent, in bytes.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Default timeout for a single ACP request.
pub const REQUEST_TIMEOUT: Duration = Duration::from_mins(1);

/// Flags Light must never pass to the agent.
///
/// `--always-approve` disables prompting entirely and `--plugin-dir` is
/// documented by the CLI as an always-trusted scope whose hooks and MCP servers
/// activate without a prompt. Neither is reachable from the browser, and the
/// host does not use them either.
pub const FORBIDDEN_FLAGS: [&str; 2] = ["--always-approve", "--plugin-dir"];

/// Errors produced by the ACP adapter.
#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    /// The agent executable could not be spawned.
    #[error("failed to spawn the agent process: {0}")]
    Spawn(#[source] std::io::Error),
    /// A pipe to the child was unavailable.
    #[error("agent stdio pipe was unavailable")]
    Pipe,
    /// Writing to or reading from the child failed.
    #[error("agent transport failure: {0}")]
    Transport(#[source] std::io::Error),
    /// A line exceeded [`MAX_LINE_BYTES`].
    #[error("agent sent an oversized message")]
    OversizedMessage,
    /// The agent closed its output before answering.
    #[error("agent closed the transport")]
    Closed,
    /// A response could not be parsed as JSON-RPC.
    #[error("agent sent malformed json-rpc")]
    Malformed,
    /// The agent returned a JSON-RPC error.
    ///
    /// The code is kept because it is the only field that says *why* in terms
    /// the host may act on. The message is agent-supplied text: it is carried
    /// for diagnosis and never used to decide control flow.
    #[error("agent returned error {code}")]
    Agent {
        /// JSON-RPC error code.
        code: i64,
        /// Agent-supplied description. Untrusted.
        message: String,
    },
    /// The request exceeded its deadline.
    #[error("agent request timed out")]
    Timeout,
    /// A caller attempted to pass a forbidden flag.
    #[error("refused to pass a forbidden flag to the agent")]
    ForbiddenFlag,
}

/// JSON-RPC's code for a method the peer does not implement.
///
/// The qualified CLI is the user's own install, so it may be older or newer
/// than the one Light was built against. This code is how it says "I do not
/// have that", and is what separates a capability this build lacks from a
/// request that genuinely failed.
pub const METHOD_NOT_FOUND: i64 = -32601;

/// Build an [`AcpError::Agent`] from a JSON-RPC `error` member.
///
/// A missing or non-integer code becomes `0`, which matches no known code and
/// so is never mistaken for a meaningful one.
fn agent_error(error: &Value) -> AcpError {
    AcpError::Agent {
        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
    }
}

impl AcpError {
    /// Whether the qualified CLI simply does not implement the method.
    ///
    /// This is a capability answer, not a failure: the caller is expected to
    /// degrade rather than report the feature as broken.
    #[must_use]
    pub fn is_unsupported_method(&self) -> bool {
        matches!(
            self,
            Self::Agent {
                code: METHOD_NOT_FOUND,
                ..
            }
        )
    }
}

/// Where the agent executable lives and how it is invoked.
#[derive(Debug, Clone)]
pub struct AgentCommand {
    /// Path or program name of the qualified executable.
    pub program: String,
    /// Working directory for the child.
    pub working_directory: Option<std::path::PathBuf>,
}

impl AgentCommand {
    /// Build a command for the qualified executable.
    #[must_use]
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            working_directory: None,
        }
    }

    /// Set the working directory for the spawned agent.
    #[must_use]
    pub fn with_working_directory(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.working_directory = Some(path.into());
        self
    }

    /// The exact production argument vector.
    ///
    /// Options precede the subcommand, matching `grok agent [OPTIONS] [COMMAND]`.
    #[must_use]
    pub fn argv(&self) -> Vec<&'static str> {
        vec!["agent", "--no-leader", "stdio"]
    }
}

/// The agent's answer to `initialize`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeResult {
    /// Negotiated ACP version.
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    /// Capabilities the agent advertises.
    #[serde(rename = "agentCapabilities", default)]
    pub agent_capabilities: Value,
    /// Authentication methods the agent offers.
    #[serde(rename = "authMethods", default)]
    pub auth_methods: Vec<Value>,
    /// Vendor metadata.
    #[serde(rename = "_meta", default)]
    pub meta: Value,
}

impl InitializeResult {
    /// Whether the agent supports loading previous sessions.
    #[must_use]
    pub fn supports_load_session(&self) -> bool {
        self.agent_capabilities
            .get("loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    /// The agent version string, when the agent reports one.
    #[must_use]
    pub fn agent_version(&self) -> Option<&str> {
        self.meta.get("agentVersion").and_then(Value::as_str)
    }
}

/// Method the agent calls on the client to ask for a permission decision.
pub const REQUEST_PERMISSION: &str = "session/request_permission";

/// Notification the agent emits for streaming session state.
pub const SESSION_UPDATE: &str = "session/update";

/// Something the agent sent that the host must act on.
#[derive(Debug)]
pub enum AgentEvent {
    /// A streaming session update notification.
    Update(Value),
    /// The agent asked for a permission decision and awaits an answer.
    PermissionRequest {
        /// JSON-RPC id the answer must carry.
        request_id: Value,
        /// Raw request parameters, including the offered options.
        params: Value,
    },
    /// The agent process ended.
    Exited,
}

/// A running agent child with a message loop.
///
/// The loop separates three inbound shapes that ACP mixes on one pipe:
/// responses to host requests, notifications, and requests the agent makes of
/// the host. Only the last two reach the caller, as [`AgentEvent`].
#[derive(Debug)]
pub struct AgentHandle {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    child: Mutex<Child>,
}

impl AgentHandle {
    /// Spawn the agent and start its message loop.
    ///
    /// Returns the handle and the stream of agent-initiated events.
    ///
    /// # Errors
    ///
    /// Returns [`AcpError::Spawn`] when the executable cannot start and
    /// [`AcpError::Pipe`] when a standard stream is unavailable.
    pub fn spawn(
        command: &AgentCommand,
    ) -> Result<(Arc<Self>, mpsc::Receiver<AgentEvent>), AcpError> {
        let argv = command.argv();
        if argv.iter().any(|arg| FORBIDDEN_FLAGS.contains(arg)) {
            return Err(AcpError::ForbiddenFlag);
        }

        let mut builder = Command::new(&command.program);
        builder
            .args(&argv)
            .env(CLIENT_NAME_ENV, CLIENT_IDENTIFIER)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(directory) = &command.working_directory {
            builder.current_dir(directory);
        }
        #[cfg(unix)]
        builder.process_group(0);

        let mut child = builder.spawn().map_err(AcpError::Spawn)?;
        let stdin = child.stdin.take().ok_or(AcpError::Pipe)?;
        let stdout = child.stdout.take().ok_or(AcpError::Pipe)?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (events_tx, events_rx) = mpsc::channel(256);

        let handle = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(0),
            child: Mutex::new(child),
        });

        tokio::spawn(read_loop(stdout, pending, events_tx));
        Ok((handle, events_rx))
    }

    /// Send a JSON-RPC request and await its response.
    ///
    /// # Errors
    ///
    /// Propagates transport, timeout, and agent errors.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write_line(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        let message = match timeout(deadline, rx).await {
            Ok(Ok(message)) => message,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                return Err(AcpError::Closed);
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(AcpError::Timeout);
            }
        };

        if let Some(error) = message.get("error") {
            return Err(agent_error(error));
        }
        message.get("result").cloned().ok_or(AcpError::Malformed)
    }

    /// Answer a permission request the agent is waiting on.
    ///
    /// # Errors
    ///
    /// Returns a transport error when the answer cannot be written.
    pub async fn answer_permission(
        &self,
        request_id: &Value,
        option_id: &str,
    ) -> Result<(), AcpError> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "outcome": { "outcome": "selected", "optionId": option_id }
            }
        });
        self.write_line(&payload).await
    }

    /// Perform the ACP `initialize` handshake.
    ///
    /// # Errors
    ///
    /// Propagates any transport, timeout, or agent error.
    pub async fn initialize(&self) -> Result<InitializeResult, AcpError> {
        let params = serde_json::json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false }
            },
            "_meta": { "clientIdentifier": CLIENT_IDENTIFIER }
        });
        let result = self.request("initialize", params).await?;
        serde_json::from_value(result).map_err(|_| AcpError::Malformed)
    }

    /// Create an agent session bound to a working directory.
    ///
    /// The directory is chosen by the host from an enrolled workspace; the
    /// browser never supplies a path.
    ///
    /// # Errors
    ///
    /// Propagates transport and agent errors, and returns
    /// [`AcpError::Malformed`] when the agent omits a session identifier.
    pub async fn new_session(&self, cwd: &std::path::Path) -> Result<(String, Value), AcpError> {
        let params = serde_json::json!({
            "cwd": cwd.to_string_lossy(),
            "mcpServers": [],
        });
        let result = self.request("session/new", params).await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(AcpError::Malformed)?;
        Ok((session_id, result))
    }

    /// Resume a session the agent already persisted.
    ///
    /// The working directory comes from the enrolled workspace, never from the
    /// browser. Sessions live in the agent's own store, so Light replays what
    /// the CLI kept rather than keeping a second copy of the transcript.
    ///
    /// # Errors
    ///
    /// Propagates transport and agent errors, including the agent's refusal
    /// when the identifier names no session it holds.
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &std::path::Path,
    ) -> Result<Value, AcpError> {
        let params = serde_json::json!({
            "sessionId": session_id,
            "cwd": cwd.to_string_lossy(),
            "mcpServers": [],
        });
        self.request("session/load", params).await
    }

    /// Ask the agent to enumerate the sessions it holds.
    ///
    /// Not every qualified CLI implements this. A build that does not answers
    /// with [`METHOD_NOT_FOUND`], which the caller is expected to read through
    /// [`AcpError::is_unsupported_method`] and degrade on, rather than report
    /// as a fault.
    ///
    /// # Errors
    ///
    /// Propagates transport and agent errors.
    pub async fn list_sessions(&self) -> Result<Value, AcpError> {
        self.request("session/list", serde_json::json!({})).await
    }

    /// Send a prompt to an existing session (ordinary agent chat only).
    ///
    /// Bash / bang-mode shell is **not** sent here: Grok Build treats it as a
    /// client-local drain. Light runs those turns via [`crate::bash`].
    ///
    /// # Errors
    ///
    /// Propagates transport, timeout, and agent errors.
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<Value, AcpError> {
        let params = serde_json::json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }],
        });
        self.request("session/prompt", params).await
    }

    /// Switch model (and optional reasoning effort) via ACP `session/set_model`.
    ///
    /// # Errors
    ///
    /// Propagates transport and agent errors; callers refuse non-Grok ids first.
    pub async fn set_session_model(
        &self,
        session_id: &str,
        model_id: &str,
        reasoning_effort: Option<&str>,
    ) -> Result<Value, AcpError> {
        let mut params = serde_json::json!({
            "sessionId": session_id,
            "modelId": model_id,
        });
        if let Some(effort) = reasoning_effort {
            params["_meta"] = serde_json::json!({ "reasoningEffort": effort });
        }
        self.request("session/set_model", params).await
    }

    /// Ask the agent to cancel the in-flight turn.
    ///
    /// # Errors
    ///
    /// Returns a transport error when the notification cannot be written.
    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpError> {
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        });
        self.write_line(&payload).await
    }

    async fn write_line(&self, payload: &Value) -> Result<(), AcpError> {
        let mut line = serde_json::to_string(payload).map_err(|_| AcpError::Malformed)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(AcpError::Transport)?;
        stdin.flush().await.map_err(AcpError::Transport)
    }

    /// Terminate the agent and reap it.
    ///
    /// # Errors
    ///
    /// Returns [`AcpError::Transport`] when the child cannot be signalled.
    pub async fn shutdown(&self) -> Result<(), AcpError> {
        let mut child = self.child.lock().await;
        child.start_kill().map_err(AcpError::Transport)?;
        let _ = child.wait().await;
        Ok(())
    }
}

/// Route every inbound line to a pending response, or to the event stream.
async fn read_loop(
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events: mpsc::Sender<AgentEvent>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(read) if read > MAX_LINE_BYTES => break,
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            // The agent may emit non-JSON diagnostics; skip rather than fail.
            continue;
        };

        let is_response = message.get("result").is_some() || message.get("error").is_some();
        if is_response {
            if let Some(id) = message.get("id").and_then(Value::as_u64)
                && let Some(sender) = pending.lock().await.remove(&id)
            {
                let _ = sender.send(message);
            }
            continue;
        }

        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let event = if method == REQUEST_PERMISSION {
            message
                .get("id")
                .map(|request_id| AgentEvent::PermissionRequest {
                    request_id: request_id.clone(),
                    params: message.get("params").cloned().unwrap_or(Value::Null),
                })
        } else if method == SESSION_UPDATE {
            Some(AgentEvent::Update(
                message.get("params").cloned().unwrap_or(Value::Null),
            ))
        } else {
            None
        };
        if let Some(event) = event
            && events.send(event).await.is_err()
        {
            break;
        }
    }

    // The agent is gone. Fail every in-flight request now rather than letting
    // callers wait out the full request timeout: a dead agent is a known
    // outcome, and the host must classify it while the turn is still fresh.
    pending.lock().await.clear();
    let _ = events.send(AgentEvent::Exited).await;
}

/// A supervised agent child speaking ACP over stdio.
#[derive(Debug)]
pub struct AgentSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl AgentSession {
    /// Spawn the agent and take ownership of its pipes.
    ///
    /// The child runs in its own process group on Unix so the whole tree can be
    /// terminated, and is killed when this value is dropped.
    ///
    /// # Errors
    ///
    /// Returns [`AcpError::Spawn`] when the executable cannot start and
    /// [`AcpError::Pipe`] when a standard stream is unavailable.
    pub fn spawn(command: &AgentCommand) -> Result<Self, AcpError> {
        let argv = command.argv();
        if argv.iter().any(|arg| FORBIDDEN_FLAGS.contains(arg)) {
            return Err(AcpError::ForbiddenFlag);
        }

        let mut builder = Command::new(&command.program);
        builder
            .args(&argv)
            .env(CLIENT_NAME_ENV, CLIENT_IDENTIFIER)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(directory) = &command.working_directory {
            builder.current_dir(directory);
        }
        #[cfg(unix)]
        builder.process_group(0);

        let mut child = builder.spawn().map_err(AcpError::Spawn)?;
        let stdin = child.stdin.take().ok_or(AcpError::Pipe)?;
        let stdout = child.stdout.take().ok_or(AcpError::Pipe)?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        })
    }

    /// Perform the ACP `initialize` handshake.
    ///
    /// # Errors
    ///
    /// Propagates any transport, timeout, or agent error.
    pub async fn initialize(&mut self) -> Result<InitializeResult, AcpError> {
        let params = serde_json::json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false }
            },
            "_meta": { "clientIdentifier": CLIENT_IDENTIFIER }
        });
        let result = self.request("initialize", params).await?;
        serde_json::from_value(result).map_err(|_| AcpError::Malformed)
    }

    /// Send a JSON-RPC request and await its matching response.
    ///
    /// Notifications and server-initiated requests received while waiting are
    /// skipped; a full implementation routes them to the session event loop.
    ///
    /// # Errors
    ///
    /// Propagates transport, timeout, parse, and agent errors.
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value, AcpError> {
        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id;
        let payload = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&payload).map_err(|_| AcpError::Malformed)?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(AcpError::Transport)?;
        self.stdin.flush().await.map_err(AcpError::Transport)?;

        timeout(REQUEST_TIMEOUT, self.await_response(id))
            .await
            .map_err(|_| AcpError::Timeout)?
    }

    async fn await_response(&mut self, id: u64) -> Result<Value, AcpError> {
        loop {
            let message = self.read_message().await?;
            let matches_id = message
                .get("id")
                .and_then(Value::as_u64)
                .is_some_and(|value| value == id);
            if !matches_id {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(agent_error(error));
            }
            return message.get("result").cloned().ok_or(AcpError::Malformed);
        }
    }

    async fn read_message(&mut self) -> Result<Value, AcpError> {
        let mut line = String::new();
        loop {
            line.clear();
            let read = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(AcpError::Transport)?;
            if read == 0 {
                return Err(AcpError::Closed);
            }
            if read > MAX_LINE_BYTES {
                return Err(AcpError::OversizedMessage);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // The agent may emit non-JSON diagnostics; skip rather than fail.
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                return Ok(value);
            }
        }
    }

    /// Terminate the agent and reap it.
    ///
    /// # Errors
    ///
    /// Returns [`AcpError::Transport`] when the child cannot be signalled.
    pub async fn shutdown(mut self) -> Result<(), AcpError> {
        drop(self.stdin);
        self.child.start_kill().map_err(AcpError::Transport)?;
        let _ = self.child.wait().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentCommand, CLIENT_IDENTIFIER, CLIENT_NAME_ENV, FORBIDDEN_FLAGS, MAX_LINE_BYTES,
    };

    #[test]
    fn production_argv_is_exact_and_ordered() {
        let command = AgentCommand::new("grok");
        // Options precede the subcommand: `grok agent [OPTIONS] [COMMAND]`.
        assert_eq!(command.argv(), vec!["agent", "--no-leader", "stdio"]);
    }

    #[test]
    fn production_argv_never_contains_a_forbidden_flag() {
        let command = AgentCommand::new("grok");
        for flag in FORBIDDEN_FLAGS {
            assert!(
                !command.argv().contains(&flag),
                "{flag} must never be passed"
            );
        }
    }

    #[test]
    fn production_argv_never_uses_the_websocket_server() {
        // ADR light 0003: `agent serve` is not a production transport.
        let command = AgentCommand::new("grok");
        assert!(!command.argv().contains(&"serve"));
        assert!(!command.argv().contains(&"headless"));
        assert!(!command.argv().contains(&"leader"));
    }

    #[test]
    fn client_identity_is_the_light_identifier() {
        assert_eq!(CLIENT_IDENTIFIER, "grok-light");
        assert_eq!(CLIENT_NAME_ENV, "GROK_CLIENT_NAME");
    }

    #[test]
    fn client_identity_never_impersonates_another_product() {
        // ADR light 0007: Light must not pose as a recognised client to unlock
        // a richer permission option set.
        for impersonation in [
            "grok-web",
            "grok-desktop",
            "grok-pager",
            "grok-code-extension",
            "nebula",
        ] {
            assert_ne!(CLIENT_IDENTIFIER, impersonation);
        }
    }

    #[test]
    fn working_directory_is_optional_and_settable() {
        let command = AgentCommand::new("grok").with_working_directory("/tmp");
        assert_eq!(
            command.working_directory.as_deref(),
            Some(std::path::Path::new("/tmp"))
        );
    }

    #[test]
    fn line_bound_is_enforced_by_a_constant() {
        const { assert!(MAX_LINE_BYTES > 0) };
        const { assert!(MAX_LINE_BYTES <= 16 * 1024 * 1024) };
    }

    mod agent_errors {
        use super::super::{AcpError, METHOD_NOT_FOUND, agent_error};

        #[test]
        fn the_code_is_kept_alongside_the_message() {
            let error = agent_error(&serde_json::json!({
                "code": -32601,
                "message": "Method not found",
            }));
            assert!(matches!(
                error,
                AcpError::Agent { code: -32601, ref message } if message == "Method not found"
            ));
        }

        #[test]
        fn a_method_the_cli_lacks_is_recognised_as_unsupported() {
            // The user's CLI may predate a capability. That is an answer, not
            // a fault, and the caller is expected to degrade.
            let error = agent_error(&serde_json::json!({ "code": METHOD_NOT_FOUND }));
            assert!(error.is_unsupported_method());
        }

        #[test]
        fn another_failure_is_not_mistaken_for_a_missing_method() {
            let error = agent_error(&serde_json::json!({
                "code": -32000,
                "message": "not authenticated",
            }));
            assert!(!error.is_unsupported_method());
        }

        #[test]
        fn a_message_alone_never_makes_a_failure_look_unsupported() {
            // The message is agent-supplied text. If it could steer the
            // decision, an agent could talk the host into skipping a feature
            // that actually failed.
            let error = agent_error(&serde_json::json!({
                "code": -32000,
                "message": "Method not found",
            }));
            assert!(!error.is_unsupported_method());
        }

        #[test]
        fn a_missing_code_matches_nothing() {
            let error = agent_error(&serde_json::json!({ "message": "broke" }));
            assert!(matches!(error, AcpError::Agent { code: 0, .. }));
            assert!(!error.is_unsupported_method());
        }

        #[test]
        fn a_non_integer_code_is_not_coerced_into_a_real_one() {
            let error = agent_error(&serde_json::json!({ "code": "-32601" }));
            assert!(!error.is_unsupported_method());
        }
    }
}
