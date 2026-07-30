//! Host-local shell for Light bash mode (`!` / CLI bang mode).
//!
//! Grok Build's pager treats bang shell as a **client-local** drain, not as an
//! ordinary ACP chat prompt. Light therefore runs the command itself in the
//! session's enrolled workspace cwd and projects the captured output — it does
//! **not** invent `_meta.bash_command` on `session/prompt`.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::bounds::{MAX_TOOL_OUTPUT_BYTES, truncate_utf8};

/// Default wall-clock budget for a host bash turn.
pub const BASH_TIMEOUT: Duration = Duration::from_secs(60);

/// Result of a host-local shell invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashResult {
    /// Command as run (without a leading `!`).
    pub command: String,
    /// Combined stdout/stderr, truncated to host bounds when needed.
    pub output: String,
    /// Process exit code, or -1 when the process could not be started / timed out.
    pub exit_code: i32,
    /// Whether the host truncated the captured output.
    pub truncated: bool,
}

/// Errors starting a host shell turn.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BashError {
    /// Empty command after stripping the bang prefix.
    #[error("empty shell command")]
    EmptyCommand,
    /// Working directory is missing or not a directory.
    #[error("workspace directory is not usable")]
    BadCwd,
}

/// Strip a leading `!` / `! ` from user text.
#[must_use]
pub fn strip_bang(text: &str) -> &str {
    text.strip_prefix("! ")
        .or_else(|| text.strip_prefix('!'))
        .unwrap_or(text)
        .trim()
}

/// Run `command` with `cwd` as the working directory via `/bin/sh -c`.
///
/// Output is bounded. This never calls the Grok agent process.
///
/// # Errors
///
/// Returns [`BashError`] when the command is empty or `cwd` is unusable.
pub fn run_in_cwd(cwd: &Path, command: &str) -> Result<BashResult, BashError> {
    let command = strip_bang(command);
    if command.is_empty() {
        return Err(BashError::EmptyCommand);
    }
    if !cwd.is_dir() {
        return Err(BashError::BadCwd);
    }

    let shell = if Path::new("/bin/sh").exists() {
        "/bin/sh"
    } else {
        "sh"
    };

    let cwd_buf = cwd.to_path_buf();
    let command_owned = command.to_owned();
    let shell_owned = shell.to_owned();
    let handle = std::thread::spawn(move || {
        Command::new(&shell_owned)
            .arg("-c")
            .arg(&command_owned)
            .current_dir(&cwd_buf)
            .output()
    });

    match wait_thread(handle, BASH_TIMEOUT) {
        ThreadWait::Done(Ok(output)) => {
            let mut combined = String::new();
            if !output.stdout.is_empty() {
                combined.push_str(&String::from_utf8_lossy(&output.stdout));
            }
            if !output.stderr.is_empty() {
                if !combined.is_empty() && !combined.ends_with('\n') {
                    combined.push('\n');
                }
                combined.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            if combined.is_empty() {
                combined = format!("[grok-light] exit {}", output.status.code().unwrap_or(-1));
            }
            let (output_text, truncated) = truncate_utf8(&combined, MAX_TOOL_OUTPUT_BYTES);
            Ok(BashResult {
                command: command.to_owned(),
                output: output_text,
                exit_code: output.status.code().unwrap_or(-1),
                truncated,
            })
        }
        ThreadWait::Done(Err(_)) => Ok(BashResult {
            command: command.to_owned(),
            output: "[grok-light] failed to start shell".into(),
            exit_code: -1,
            truncated: false,
        }),
        ThreadWait::TimedOut => Ok(BashResult {
            command: command.to_owned(),
            output: format!(
                "[grok-light] command timed out after {}s",
                BASH_TIMEOUT.as_secs()
            ),
            exit_code: -1,
            truncated: false,
        }),
    }
}

enum ThreadWait<T> {
    Done(T),
    TimedOut,
}

fn wait_thread<T: Send + 'static>(
    handle: std::thread::JoinHandle<T>,
    budget: Duration,
) -> ThreadWait<T> {
    let start = std::time::Instant::now();
    loop {
        if handle.is_finished() {
            return match handle.join() {
                Ok(value) => ThreadWait::Done(value),
                Err(_) => ThreadWait::TimedOut,
            };
        }
        if start.elapsed() >= budget {
            return ThreadWait::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::{run_in_cwd, strip_bang};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn strip_bang_handles_prefixes() {
        assert_eq!(strip_bang("! ls"), "ls");
        assert_eq!(strip_bang("!ls"), "ls");
        assert_eq!(strip_bang("  echo hi  "), "echo hi");
    }

    #[test]
    fn host_shell_runs_in_cwd_and_captures_output() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-bash-{stamp}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(root.join("marker.txt"), "ok").expect("write");

        let result = run_in_cwd(&root, "! cat marker.txt").expect("run");
        assert_eq!(result.command, "cat marker.txt");
        assert!(result.output.contains("ok"), "output={}", result.output);
        assert_eq!(result.exit_code, 0);
        assert!(!result.output.contains("bash_command"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_command_is_refused() {
        let root = std::env::temp_dir();
        assert!(run_in_cwd(&root, "!").is_err());
        assert!(run_in_cwd(&root, "!   ").is_err());
    }
}
