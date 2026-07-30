//! Grok Light v1 permission matching.
//!
//! Implements ADR light 0007. Light renders and answers exactly three native
//! option identifiers, never fabricates one, and never answers an option the
//! agent did not offer.
//!
//! The identifiers below are the agent's own constants, not Light inventions.
//! A qualified CLI version is contract-tested against them.

use std::collections::BTreeSet;

/// Allow the current request once.
pub const ALLOW_ONCE: &str = "allow-once";

/// Reject the current request once.
pub const REJECT_ONCE: &str = "reject-once";

/// Allow edits for the remainder of the agent session.
pub const ALLOW_EDITS_SESSION: &str = "allow-edits-session";

/// Persistent allow, deliberately never rendered by Light.
pub const ALWAYS_ALLOW: &str = "always-allow";

/// Persistent reject, deliberately never rendered by Light.
pub const REJECT_ALWAYS: &str = "reject-always";

/// Persistent MCP allow, deliberately never rendered by Light.
pub const ALLOW_ALWAYS_MCP: &str = "allow-always-mcp";

/// Persistent domain allow, deliberately never rendered by Light.
pub const ALLOW_ALWAYS_DOMAIN: &str = "allow-always-domain";

/// Global auto-approve toggle, deliberately never rendered or enabled.
pub const ENABLE_ALWAYS_APPROVE: &str = "enable-always-approve";

/// Option identifiers Light may render, in presentation order.
pub const RENDERABLE: [&str; 3] = [ALLOW_ONCE, ALLOW_EDITS_SESSION, REJECT_ONCE];

/// Option identifiers Light must never render or answer.
pub const WITHHELD: [&str; 5] = [
    ALWAYS_ALLOW,
    REJECT_ALWAYS,
    ALLOW_ALWAYS_MCP,
    ALLOW_ALWAYS_DOMAIN,
    ENABLE_ALWAYS_APPROVE,
];

/// Errors produced while matching or answering a permission request.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PermissionError {
    /// The agent offered no single-use option, so Light cannot present a
    /// dialog whose only choice is Deny. See ADR light 0007.
    #[error("agent offered no single-use option for this request")]
    NoSingleUseOption,
    /// The answer referenced an option the agent did not offer.
    #[error("option was not offered for this request")]
    OptionNotOffered,
    /// The answer referenced an option Light deliberately withholds.
    #[error("option is withheld by the Light v1 permission contract")]
    OptionWithheld,
}

/// A permission request projected for the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderablePermission {
    /// The agent's request identifier.
    pub request_id: String,
    /// Option identifiers the browser may present, in presentation order.
    pub options: Vec<String>,
}

/// Project the agent's offered options onto the Light v1 contract.
///
/// Returns only the identifiers Light renders. Withheld identifiers are
/// dropped silently: they remain answerable through Grok Build itself.
///
/// # Errors
///
/// Returns [`PermissionError::NoSingleUseOption`] when the agent offered
/// neither [`ALLOW_ONCE`] nor [`REJECT_ONCE`], which is the incompatibility
/// state described in ADR light 0007 rather than a dialog with only Deny.
pub fn project(
    request_id: &str,
    offered: &[String],
) -> Result<RenderablePermission, PermissionError> {
    let offered_set: BTreeSet<&str> = offered.iter().map(String::as_str).collect();
    if !offered_set.contains(ALLOW_ONCE) || !offered_set.contains(REJECT_ONCE) {
        return Err(PermissionError::NoSingleUseOption);
    }
    let options = RENDERABLE
        .iter()
        .filter(|candidate| offered_set.contains(*candidate))
        .map(|candidate| (*candidate).to_owned())
        .collect();
    Ok(RenderablePermission {
        request_id: request_id.to_owned(),
        options,
    })
}

/// Validate a browser answer against what the agent actually offered.
///
/// The host verifies the option was offered and is renderable before it is
/// forwarded to the agent.
///
/// # Errors
///
/// Returns [`PermissionError::OptionWithheld`] for a deliberately hidden
/// identifier and [`PermissionError::OptionNotOffered`] for anything the agent
/// did not present.
pub fn authorize_answer(offered: &[String], option_id: &str) -> Result<(), PermissionError> {
    if WITHHELD.contains(&option_id) {
        return Err(PermissionError::OptionWithheld);
    }
    if !RENDERABLE.contains(&option_id) {
        return Err(PermissionError::OptionNotOffered);
    }
    if !offered.iter().any(|candidate| candidate == option_id) {
        return Err(PermissionError::OptionNotOffered);
    }
    Ok(())
}

/// The option Light uses when it must fail closed.
///
/// Timeout, saturation, a lost controlling tab, or a stale controller epoch all
/// resolve to a single-use rejection when the agent offered one.
#[must_use]
pub fn fail_closed_option(offered: &[String]) -> Option<&'static str> {
    offered
        .iter()
        .any(|candidate| candidate == REJECT_ONCE)
        .then_some(REJECT_ONCE)
}

#[cfg(test)]
mod tests {
    use super::{
        ALLOW_ALWAYS_DOMAIN, ALLOW_ALWAYS_MCP, ALLOW_EDITS_SESSION, ALLOW_ONCE, ALWAYS_ALLOW,
        ENABLE_ALWAYS_APPROVE, PermissionError, REJECT_ALWAYS, REJECT_ONCE, authorize_answer,
        fail_closed_option, project,
    };

    fn offered(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn edit_request_renders_three_options() {
        // Shape observed for an Edit access kind.
        let offered = offered(&[ALLOW_ONCE, ALLOW_EDITS_SESSION, REJECT_ONCE]);
        let projected = project("perm-1", &offered).expect("project");
        assert_eq!(
            projected.options,
            vec![ALLOW_ONCE, ALLOW_EDITS_SESSION, REJECT_ONCE]
        );
    }

    #[test]
    fn bash_request_hides_persistent_allows() {
        // Shape observed for a Bash access kind: always-allow and reject-always
        // are offered by the agent and must not reach the browser.
        let offered = offered(&[ALWAYS_ALLOW, ALLOW_ONCE, REJECT_ONCE, REJECT_ALWAYS]);
        let projected = project("perm-2", &offered).expect("project");
        assert_eq!(projected.options, vec![ALLOW_ONCE, REJECT_ONCE]);
    }

    #[test]
    fn mcp_request_hides_allow_always_mcp() {
        let offered = offered(&[ALLOW_ALWAYS_MCP, ALLOW_ONCE, REJECT_ONCE]);
        let projected = project("perm-3", &offered).expect("project");
        assert_eq!(projected.options, vec![ALLOW_ONCE, REJECT_ONCE]);
    }

    #[test]
    fn web_fetch_request_hides_allow_always_domain() {
        let offered = offered(&[ALLOW_ALWAYS_DOMAIN, ALLOW_ONCE, REJECT_ONCE]);
        let projected = project("perm-4", &offered).expect("project");
        assert_eq!(projected.options, vec![ALLOW_ONCE, REJECT_ONCE]);
    }

    #[test]
    fn enable_always_approve_is_never_rendered() {
        let offered = offered(&[ENABLE_ALWAYS_APPROVE, ALLOW_ONCE, REJECT_ONCE]);
        let projected = project("perm-5", &offered).expect("project");
        assert!(
            !projected
                .options
                .iter()
                .any(|id| id == ENABLE_ALWAYS_APPROVE)
        );
    }

    #[test]
    fn presentation_order_is_stable_regardless_of_agent_order() {
        let a = project("p", &offered(&[REJECT_ONCE, ALLOW_ONCE])).expect("project");
        let b = project("p", &offered(&[ALLOW_ONCE, REJECT_ONCE])).expect("project");
        assert_eq!(a.options, b.options);
        assert_eq!(a.options, vec![ALLOW_ONCE, REJECT_ONCE]);
    }

    #[test]
    fn missing_single_use_option_is_an_incompatibility_not_a_deny_only_dialog() {
        // Only persistent options offered: Light must refuse to render.
        let offered = offered(&[ALWAYS_ALLOW, REJECT_ALWAYS]);
        assert_eq!(
            project("perm-6", &offered).unwrap_err(),
            PermissionError::NoSingleUseOption
        );
    }

    #[test]
    fn allow_once_without_reject_once_is_also_an_incompatibility() {
        let offered = offered(&[ALLOW_ONCE]);
        assert_eq!(
            project("perm-7", &offered).unwrap_err(),
            PermissionError::NoSingleUseOption
        );
    }

    #[test]
    fn empty_offer_is_an_incompatibility() {
        assert_eq!(
            project("perm-8", &[]).unwrap_err(),
            PermissionError::NoSingleUseOption
        );
    }

    #[test]
    fn withheld_options_cannot_be_answered_even_if_offered() {
        let offered = offered(&[ALWAYS_ALLOW, ALLOW_ONCE, REJECT_ONCE, REJECT_ALWAYS]);
        for withheld in [ALWAYS_ALLOW, REJECT_ALWAYS] {
            assert_eq!(
                authorize_answer(&offered, withheld).unwrap_err(),
                PermissionError::OptionWithheld,
                "{withheld} must never be answerable"
            );
        }
    }

    #[test]
    fn unknown_options_are_rejected() {
        let offered = offered(&[ALLOW_ONCE, REJECT_ONCE]);
        assert_eq!(
            authorize_answer(&offered, "yolo").unwrap_err(),
            PermissionError::OptionNotOffered
        );
    }

    #[test]
    fn a_renderable_option_not_offered_here_is_rejected() {
        // allow-edits-session is renderable in general but was not offered.
        let offered = offered(&[ALLOW_ONCE, REJECT_ONCE]);
        assert_eq!(
            authorize_answer(&offered, ALLOW_EDITS_SESSION).unwrap_err(),
            PermissionError::OptionNotOffered
        );
    }

    #[test]
    fn offered_and_renderable_options_are_accepted() {
        let offered = offered(&[ALLOW_ONCE, ALLOW_EDITS_SESSION, REJECT_ONCE]);
        for accepted in [ALLOW_ONCE, ALLOW_EDITS_SESSION, REJECT_ONCE] {
            assert!(authorize_answer(&offered, accepted).is_ok());
        }
    }

    #[test]
    fn fail_closed_prefers_single_use_rejection() {
        let offered = offered(&[ALLOW_ONCE, REJECT_ONCE, REJECT_ALWAYS]);
        assert_eq!(fail_closed_option(&offered), Some(REJECT_ONCE));
    }

    #[test]
    fn fail_closed_never_falls_back_to_a_persistent_reject() {
        let offered = offered(&[ALLOW_ONCE, REJECT_ALWAYS]);
        assert_eq!(fail_closed_option(&offered), None);
    }

    #[test]
    fn projection_carries_the_request_id() {
        let projected = project("perm-9", &offered(&[ALLOW_ONCE, REJECT_ONCE])).expect("project");
        assert_eq!(projected.request_id, "perm-9");
    }
}
