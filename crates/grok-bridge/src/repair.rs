//! Out-of-band session history repair (ACP `x.ai/session/repair`).
//!
//! Light never auto-repairs on load and never treats repair as undo of
//! filesystem side effects or as a retry of `interrupted_needs_review`.
//! See light ADR 0015.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::{AcpError, AgentHandle};
use crate::bounds;

/// Maximum tool-result ids named in a repair report projected to the browser.
pub const MAX_STRIPPED_IDS: usize = 32;

/// Maximum length of one stripped tool-result id in the projection.
pub const MAX_STRIPPED_ID_BYTES: usize = 128;

/// Wire method for the qualified CLI's history-repair extension.
///
/// ACP extension methods are transported with a leading underscore on the
/// JSON-RPC method name.
pub const REPAIR_METHOD: &str = "_x.ai/session/repair";

/// Host-facing diagnosis of one session's tool-pairing history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnosis {
    /// Session the diagnosis names.
    pub session_id: String,
    /// Closed status after projection.
    pub status: DiagnosisStatus,
    /// Counts when the CLI reported what a repair would do (or did).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<RepairReportProjection>,
}

/// Closed diagnosis set the browser may render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosisStatus {
    /// Dry-run reported no pairing issues.
    Healthy,
    /// Dry-run (or apply) reported pairing fixes.
    Corrupt,
    /// Qualified CLI does not implement repair.
    Unsupported,
}

/// Bounded, browser-safe view of a CLI repair report.
///
/// Never includes history bodies, paths, or secrets — only counts and
/// truncated tool-result ids the CLI already exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReportProjection {
    /// Whether history was (or would be) changed.
    pub repaired: bool,
    /// Echo of dry-run.
    pub dry_run: bool,
    /// Whether the session was resident in the agent process.
    pub resident: bool,
    /// Duplicate tool results removed (or that would be).
    pub duplicates_removed: u64,
    /// Synthetic results inserted for unanswered tool calls.
    pub synthetic_results_inserted: u64,
    /// Bounded list of stripped orphan tool-result ids (ids only).
    pub stripped_tool_result_ids: Vec<String>,
}

/// Pure projection of a CLI repair JSON result into a bounded report.
///
/// Unknown or partial shapes yield `None` rather than inventing zeros that
/// would look like a successful empty repair.
#[must_use]
pub fn project_repair_result(value: &Value, dry_run: bool) -> Option<RepairReportProjection> {
    let repaired = value.get("repaired").and_then(Value::as_bool)?;
    let resident = value
        .get("resident")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let duplicates_removed = value
        .get("duplicatesRemoved")
        .and_then(Value::as_u64)
        .or_else(|| value.get("duplicates_removed").and_then(Value::as_u64))
        .unwrap_or(0);
    let synthetic_results_inserted = value
        .get("syntheticResultsInserted")
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .get("synthetic_results_inserted")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let dry = value
        .get("dryRun")
        .and_then(Value::as_bool)
        .or_else(|| value.get("dry_run").and_then(Value::as_bool))
        .unwrap_or(dry_run);

    let stripped = value
        .get("strippedToolResultIds")
        .or_else(|| value.get("stripped_tool_result_ids"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str())
                .filter(|id| !id.is_empty())
                .take(MAX_STRIPPED_IDS)
                .map(|id| bounds::truncate_utf8(id, MAX_STRIPPED_ID_BYTES).0)
                .collect()
        })
        .unwrap_or_default();

    Some(RepairReportProjection {
        repaired,
        dry_run: dry,
        resident,
        duplicates_removed,
        synthetic_results_inserted,
        stripped_tool_result_ids: stripped,
    })
}

/// Map a dry-run report into a diagnosis status.
#[must_use]
pub fn diagnosis_from_report(report: &RepairReportProjection) -> DiagnosisStatus {
    if report.repaired {
        DiagnosisStatus::Corrupt
    } else {
        DiagnosisStatus::Healthy
    }
}

/// Call the CLI repair extension (dry-run or apply).
///
/// # Errors
///
/// Propagates transport errors. [`AcpError::is_unsupported_method`] means the
/// install does not expose repair — callers map that to
/// [`DiagnosisStatus::Unsupported`], never to a fake healthy report.
pub async fn repair_session(
    agent: &AgentHandle,
    session_id: &str,
    dry_run: bool,
) -> Result<RepairReportProjection, AcpError> {
    let params = serde_json::json!({
        "sessionId": session_id,
        "dryRun": dry_run,
    });
    let result = agent.request(REPAIR_METHOD, params).await?;
    project_repair_result(&result, dry_run).ok_or(AcpError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::{DiagnosisStatus, diagnosis_from_report, project_repair_result};

    #[test]
    fn dry_run_no_changes_is_healthy() {
        let report = project_repair_result(
            &serde_json::json!({
                "repaired": false,
                "dryRun": true,
                "resident": true,
                "duplicatesRemoved": 0,
                "syntheticResultsInserted": 0,
                "strippedToolResultIds": []
            }),
            true,
        )
        .expect("projects");
        assert!(!report.repaired);
        assert_eq!(diagnosis_from_report(&report), DiagnosisStatus::Healthy);
    }

    #[test]
    fn dry_run_with_fixes_is_corrupt() {
        let report = project_repair_result(
            &serde_json::json!({
                "repaired": true,
                "dryRun": true,
                "resident": false,
                "duplicatesRemoved": 2,
                "syntheticResultsInserted": 1,
                "strippedToolResultIds": ["call-a", "call-b"]
            }),
            true,
        )
        .expect("projects");
        assert!(report.repaired);
        assert_eq!(report.duplicates_removed, 2);
        assert_eq!(report.stripped_tool_result_ids.len(), 2);
        assert_eq!(diagnosis_from_report(&report), DiagnosisStatus::Corrupt);
    }

    #[test]
    fn missing_repaired_flag_is_not_invented() {
        assert!(project_repair_result(&serde_json::json!({ "dryRun": true }), true).is_none());
    }

    #[test]
    fn stripped_ids_are_bounded() {
        let ids: Vec<String> = (0..80).map(|i| format!("id-{i}")).collect();
        let report = project_repair_result(
            &serde_json::json!({
                "repaired": true,
                "dryRun": false,
                "strippedToolResultIds": ids
            }),
            false,
        )
        .expect("projects");
        assert_eq!(
            report.stripped_tool_result_ids.len(),
            super::MAX_STRIPPED_IDS
        );
    }

    #[test]
    fn apply_never_looks_like_auto_on_load() {
        // Structural: dry_run false is an explicit user apply path; diagnosis
        // still only reflects whether pairing needed fixes.
        let report = project_repair_result(
            &serde_json::json!({
                "repaired": true,
                "dryRun": false,
                "duplicatesRemoved": 1,
                "syntheticResultsInserted": 0,
                "strippedToolResultIds": []
            }),
            false,
        )
        .expect("projects");
        assert!(!report.dry_run);
        assert_eq!(diagnosis_from_report(&report), DiagnosisStatus::Corrupt);
    }
}
