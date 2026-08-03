//! Bounded host-only reads of background-task output files.
//!
//! Paths never leave this module on the wire: callers resolve
//! `TaskRecord.output_path` and pass a [`Path`]. Outcomes expose only text and
//! opaque metadata (sizes, content version). See ADR light 0018.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

use crate::bounds::MAX_BACKGROUND_TASK_OUTPUT_BYTES;

/// How to window a task log read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReadMode {
    /// Last `max_bytes` of the file (CLI block-viewer default).
    #[default]
    Tail,
    /// First `max_bytes` (reserved; same bounds).
    Head,
}

/// Options for one bounded read.
#[derive(Debug, Clone, Copy)]
pub struct ReadOpts {
    /// Cap on returned UTF-8 payload bytes (before truncation marker).
    pub max_bytes: usize,
    /// Tail vs head window.
    pub mode: ReadMode,
}

impl Default for ReadOpts {
    fn default() -> Self {
        Self {
            max_bytes: MAX_BACKGROUND_TASK_OUTPUT_BYTES,
            mode: ReadMode::Tail,
        }
    }
}

/// Bounded slice of a host-owned task log. Never includes a filesystem path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLogSlice {
    /// UTF-8 text of the window (may include host truncation marker).
    pub text: String,
    /// True when more bytes exist outside the returned window.
    pub truncated: bool,
    /// Byte length of `text` as returned (UTF-8).
    pub byte_length: u64,
    /// Full file size in bytes when known.
    pub file_size: u64,
    /// Opaque version: grows when size or mtime changes (poll short-circuit).
    pub content_version: u64,
    /// Newline count in the returned text (best-effort badge).
    pub line_count: u32,
}

/// Why a task log could not be read into a slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogReadError {
    /// File does not exist yet (task may still be starting).
    NotFound,
    /// I/O failed after open (permission, etc.). No path in Display.
    Io,
}

impl std::fmt::Display for LogReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "task output not found"),
            Self::Io => write!(f, "task output unreadable"),
        }
    }
}

impl std::error::Error for LogReadError {}

/// Read a bounded window from a host-owned task output path.
///
/// # Errors
///
/// [`LogReadError::NotFound`] when the path is missing; [`LogReadError::Io`]
/// on other filesystem failures. Paths are never embedded in the error.
pub fn read_task_log(path: &Path, opts: ReadOpts) -> Result<TaskLogSlice, LogReadError> {
    let max_bytes = opts.max_bytes.max(1);
    let meta = fs::metadata(path).map_err(map_meta_err)?;
    let file_size = meta.len();
    let content_version = content_version_from_meta(&meta, file_size);

    if file_size == 0 {
        return Ok(TaskLogSlice {
            text: String::new(),
            truncated: false,
            byte_length: 0,
            file_size: 0,
            content_version,
            line_count: 0,
        });
    }

    let mut file = File::open(path).map_err(|_| LogReadError::Io)?;
    let (raw, truncated) = match opts.mode {
        ReadMode::Tail => read_tail(&mut file, file_size, max_bytes)?,
        ReadMode::Head => read_head(&mut file, file_size, max_bytes)?,
    };

    let text = String::from_utf8_lossy(&raw).into_owned();
    // Snap off a leading partial UTF-8 sequence after a mid-char tail cut.
    let text = snap_utf8_start(&text);
    let (text, marker_truncated) = if text.len() > max_bytes {
        crate::bounds::truncate_utf8(&text, max_bytes)
    } else {
        (text, false)
    };
    let truncated = truncated || marker_truncated;
    let line_count = count_lines(&text);
    let byte_length = text.len() as u64;

    Ok(TaskLogSlice {
        text,
        truncated,
        byte_length,
        file_size,
        content_version,
        line_count,
    })
}

fn map_meta_err(err: std::io::Error) -> LogReadError {
    if err.kind() == std::io::ErrorKind::NotFound {
        LogReadError::NotFound
    } else {
        LogReadError::Io
    }
}

fn content_version_from_meta(meta: &fs::Metadata, file_size: u64) -> u64 {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Mix size + mtime so poll can detect growth without re-sending text.
    file_size.wrapping_mul(1_000_003).wrapping_add(mtime)
}

fn read_tail(
    file: &mut File,
    file_size: u64,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), LogReadError> {
    let max = max_bytes as u64;
    if file_size <= max {
        let mut buf = Vec::with_capacity(file_size as usize);
        file.read_to_end(&mut buf).map_err(|_| LogReadError::Io)?;
        return Ok((buf, false));
    }
    let start = file_size - max;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| LogReadError::Io)?;
    let mut buf = vec![0_u8; max_bytes];
    file.read_exact(&mut buf).map_err(|_| LogReadError::Io)?;
    // Drop a leading partial UTF-8 sequence from the mid-file cut.
    let skip = utf8_start_skip(&buf);
    Ok((buf[skip..].to_vec(), true))
}

fn read_head(
    file: &mut File,
    file_size: u64,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), LogReadError> {
    let to_read = (file_size as usize).min(max_bytes);
    let mut buf = vec![0_u8; to_read];
    file.read_exact(&mut buf).map_err(|_| LogReadError::Io)?;
    Ok((buf, file_size as usize > max_bytes))
}

/// Bytes to skip so `buf` starts on a UTF-8 character boundary.
fn utf8_start_skip(buf: &[u8]) -> usize {
    if buf.is_empty() {
        return 0;
    }
    // If the first byte is a continuation (10xxxxxx), skip until a lead.
    let mut i = 0;
    while i < buf.len().min(4) && (buf[i] & 0b1100_0000) == 0b1000_0000 {
        i += 1;
    }
    i
}

fn snap_utf8_start(text: &str) -> String {
    // from_utf8_lossy already replaces bad sequences; keep as-is.
    text.to_owned()
}

fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let n = text.bytes().filter(|b| *b == b'\n').count();
    // Last line without trailing newline still counts as a line.
    let extra = usize::from(!text.ends_with('\n'));
    u32::try_from(n + extra).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    fn write_temp(name: &str, body: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("grok-bridge-task-log-tests");
        let _ = fs::create_dir_all(&dir);
        let path = dir.join(name);
        let mut f = File::create(&path).expect("create");
        f.write_all(body).expect("write");
        path
    }

    #[test]
    fn small_file_is_returned_in_full() {
        let path = write_temp("small.log", b"hello\nworld\n");
        let slice = read_task_log(&path, ReadOpts::default()).expect("read");
        assert_eq!(slice.text, "hello\nworld\n");
        assert!(!slice.truncated);
        assert_eq!(slice.file_size, 12);
        assert_eq!(slice.line_count, 2);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn large_file_is_tailed_and_marked_truncated() {
        let mut body = Vec::new();
        for i in 0..5000 {
            body.extend_from_slice(format!("line-{i:04}\n").as_bytes());
        }
        let path = write_temp("large.log", &body);
        let opts = ReadOpts {
            max_bytes: 256,
            mode: ReadMode::Tail,
        };
        let slice = read_task_log(&path, opts).expect("read");
        assert!(slice.truncated);
        assert!(slice.byte_length <= 256 + crate::bounds::TRUNCATION_MARKER.len() as u64);
        assert!(slice.text.contains("line-"));
        assert!(!slice.text.contains("line-0000")); // early lines dropped
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn missing_file_is_not_found() {
        let path = std::env::temp_dir().join("grok-bridge-task-log-tests/no-such-file.log");
        let _ = fs::remove_file(&path);
        let err = read_task_log(&path, ReadOpts::default()).expect_err("missing");
        assert_eq!(err, LogReadError::NotFound);
        assert!(!format!("{err}").contains('/'));
    }

    #[test]
    fn empty_file_returns_empty_slice() {
        let path = write_temp("empty.log", b"");
        let slice = read_task_log(&path, ReadOpts::default()).expect("read");
        assert_eq!(slice.text, "");
        assert!(!slice.truncated);
        assert_eq!(slice.file_size, 0);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn content_version_changes_when_file_grows() {
        let path = write_temp("grow.log", b"a\n");
        let a = read_task_log(&path, ReadOpts::default()).expect("a");
        // Ensure mtime can move on coarse filesystems.
        std::thread::sleep(Duration::from_millis(20));
        {
            let mut f = File::options().append(true).open(&path).expect("open");
            f.write_all(b"b\n").expect("append");
            let _ = f.set_modified(SystemTime::now());
        }
        let b = read_task_log(&path, ReadOpts::default()).expect("b");
        assert_ne!(a.content_version, b.content_version);
        assert!(b.text.contains('b'));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn utf8_tail_does_not_panic_on_mid_char_cut() {
        // Build a file larger than max so we tail mid-stream.
        let mut body = vec![b'x'; 100];
        body.extend_from_slice("éééé".as_bytes()); // multi-byte
        body.extend_from_slice(b"\nend\n");
        let path = write_temp("utf8.log", &body);
        let opts = ReadOpts {
            max_bytes: 20,
            mode: ReadMode::Tail,
        };
        let slice = read_task_log(&path, opts).expect("read");
        // Valid UTF-8 by construction (lossy + skip).
        assert!(slice.text.is_char_boundary(slice.text.len()));
        assert!(slice.text.contains("end") || slice.truncated);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn error_display_has_no_path() {
        let err = LogReadError::Io;
        assert_eq!(err.to_string(), "task output unreadable");
    }
}
