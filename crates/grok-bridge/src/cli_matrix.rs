//! Qualified Grok Build CLI version matrix for product integrity.
//!
//! Light does not pin the binary the way Desktop does (light ADR 0005). It
//! still needs an honest answer to "is this install one we support?" so
//! `doctor`, Setup, and contract tests share one definition of the floor.
//!
//! A version below the minimum is a **support** failure, not a security
//! boundary: the user's configuration already executes with the same authority
//! (light ADR 0004). The host reports the fact; it does not claim containment.

use std::process::Command;

/// Lowest Grok Build CLI version Light qualifies against.
///
/// 0.2.115 is the stdio ACP baseline for review capabilities and the chat
/// history / duplicate-tool-result integrity work that prevents later HTTP 400s
/// on long sessions. Builds below this may still handshake, but product claims
/// and contract fixtures assume at least this floor.
pub const MIN_QUALIFIED_CLI_VERSION: &str = "0.2.115";

/// Human-readable package label for docs and doctor.
pub const MIN_QUALIFIED_CLI_LABEL: &str = "0.2.115";

/// Result of comparing an installed CLI against the qualified matrix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliQualification {
    /// `program --version` could not be run or parsed.
    Unavailable {
        /// Why the version could not be established.
        reason: String,
    },
    /// Version string parsed and compared.
    Known {
        /// Exact version string reported by the CLI (e.g. `0.2.115`).
        version: String,
        /// Whether `version` is at least [`MIN_QUALIFIED_CLI_VERSION`].
        meets_minimum: bool,
    },
}

impl CliQualification {
    /// Whether product integrity accepts this install.
    #[must_use]
    pub fn is_qualified(&self) -> bool {
        matches!(
            self,
            Self::Known {
                meets_minimum: true,
                ..
            }
        )
    }
}

/// Parse a `grok --version` line into a dotted version string.
///
/// Accepts forms like `grok 0.2.115 (dd16b5eb7d) [alpha]` and bare `0.2.115`.
#[must_use]
pub fn parse_cli_version_line(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let candidate = token.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        if is_dotted_version(candidate) {
            return Some(candidate.to_owned());
        }
    }
    None
}

/// Compare two dotted numeric versions (`1.2.3` style).
///
/// Missing trailing components count as zero. Non-numeric segments compare as
/// zero so a parse glitch never ranks above a real release.
#[must_use]
pub fn version_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    let mut left_parts = left.split('.').map(parse_component);
    let mut right_parts = right.split('.').map(parse_component);
    loop {
        match (left_parts.next(), right_parts.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (Some(l), Some(r)) => {
                let order = l.cmp(&r);
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
            (Some(l), None) => {
                if l != 0 {
                    return std::cmp::Ordering::Greater;
                }
            }
            (None, Some(r)) => {
                if r != 0 {
                    return std::cmp::Ordering::Less;
                }
            }
        }
    }
}

/// Whether `version` meets or exceeds the minimum qualified floor.
#[must_use]
pub fn meets_minimum(version: &str) -> bool {
    !matches!(
        version_cmp(version, MIN_QUALIFIED_CLI_VERSION),
        std::cmp::Ordering::Less
    )
}

/// Run `program --version` and classify the install.
#[must_use]
pub fn qualify_program(program: &str) -> CliQualification {
    let output = match Command::new(program).arg("--version").output() {
        Ok(output) if output.status.success() => output,
        Ok(_) => {
            return CliQualification::Unavailable {
                reason: format!("{program} --version exited unsuccessfully"),
            };
        }
        Err(error) => {
            return CliQualification::Unavailable {
                reason: format!("{program} not runnable: {error}"),
            };
        }
    };
    let rendered = String::from_utf8_lossy(&output.stdout);
    let line = rendered.lines().next().unwrap_or(rendered.as_ref()).trim();
    match parse_cli_version_line(line) {
        Some(version) => {
            let meets_minimum = meets_minimum(&version);
            CliQualification::Known {
                version,
                meets_minimum,
            }
        }
        None => CliQualification::Unavailable {
            reason: format!("could not parse version from: {line}"),
        },
    }
}

/// Qualify the default `grok` on `PATH`.
#[must_use]
pub fn qualify_default() -> CliQualification {
    qualify_program("grok")
}

fn is_dotted_version(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let mut saw_digit = false;
    for part in value.split('.') {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
        saw_digit = true;
    }
    saw_digit
}

fn parse_component(part: &str) -> u64 {
    part.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        CliQualification, MIN_QUALIFIED_CLI_VERSION, meets_minimum, parse_cli_version_line,
        version_cmp,
    };
    use std::cmp::Ordering;

    #[test]
    fn parses_grok_version_lines() {
        assert_eq!(
            parse_cli_version_line("grok 0.2.115 (dd16b5eb7d) [alpha]").as_deref(),
            Some("0.2.115")
        );
        assert_eq!(
            parse_cli_version_line("0.2.112").as_deref(),
            Some("0.2.112")
        );
        assert_eq!(parse_cli_version_line("not a version"), None);
    }

    #[test]
    fn version_order_is_numeric_by_component() {
        assert_eq!(version_cmp("0.2.115", "0.2.114"), Ordering::Greater);
        assert_eq!(version_cmp("0.2.9", "0.2.115"), Ordering::Less);
        assert_eq!(version_cmp("0.2.115", "0.2.115"), Ordering::Equal);
        assert_eq!(version_cmp("0.3", "0.2.115"), Ordering::Greater);
    }

    #[test]
    fn minimum_floor_matches_matrix_constant() {
        assert!(meets_minimum(MIN_QUALIFIED_CLI_VERSION));
        assert!(meets_minimum("0.2.116"));
        assert!(!meets_minimum("0.2.114"));
        assert!(!meets_minimum("0.2.112"));
    }

    #[test]
    fn qualification_helper_flags_below_minimum() {
        let known = CliQualification::Known {
            version: "0.2.112".into(),
            meets_minimum: false,
        };
        assert!(!known.is_qualified());
        let ok = CliQualification::Known {
            version: "0.2.115".into(),
            meets_minimum: true,
        };
        assert!(ok.is_qualified());
    }
}
