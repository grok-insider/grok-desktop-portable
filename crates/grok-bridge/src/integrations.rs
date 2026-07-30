//! Which MCP integrations the user's Grok Build is configured with.
//!
//! Light drives the user's own CLI with the user's own configuration (light
//! ADR 0004), so the tools an agent can reach come from `[mcp_servers.*]` in
//! `$GROK_HOME/config.toml`. Showing which are present is honest context for a
//! surface that runs with the user's full authority.
//!
//! **Only the name and whether it is enabled leave this module.** That file
//! holds bearer tokens in `[mcp_servers.*.headers]`, API keys inside URLs, and
//! commands, arguments, and environment for local servers. None of it is
//! projected, and the parser here does not even retain it: a value is read only
//! to decide the transport word, then dropped.

use std::path::Path;

/// One configured MCP server, as the browser may see it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    /// The name the user gave it in their configuration.
    pub name: String,
    /// Whether it is switched on.
    pub enabled: bool,
    /// `remote` for a URL-addressed server, `local` for a spawned process.
    ///
    /// Deliberately coarse: it says how the agent reaches the server without
    /// saying where, which is the part that carries credentials.
    pub transport: &'static str,
}

/// Read the configured MCP servers from a Grok home.
///
/// A missing or unreadable file yields an empty list rather than an error:
/// having no integrations and not being able to tell are the same thing to the
/// interface, and neither is a failure worth interrupting the user for.
#[must_use]
pub fn list_for_home(home: &Path) -> Vec<Integration> {
    let Ok(raw) = std::fs::read_to_string(home.join("config.toml")) else {
        return Vec::new();
    };
    parse(&raw)
}

/// Read the configured MCP servers from the user's Grok home.
#[must_use]
pub fn list() -> Vec<Integration> {
    list_for_home(&crate::session_catalog::grok_home())
}

/// Extract `[mcp_servers.NAME]` sections, and nothing else.
///
/// Hand-parsed rather than deserialised so the shape of the rest of the file
/// cannot matter and no value is ever held: a line inside a section is only
/// inspected for the two keys below and then discarded.
fn parse(raw: &str) -> Vec<Integration> {
    let mut found: Vec<Integration> = Vec::new();
    let mut current: Option<Integration> = None;

    for line in raw.lines() {
        let line = line.trim();
        if let Some(header) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            let header = header.trim_start_matches('[').trim_end_matches(']');
            if let Some(name) = server_name(header) {
                if let Some(done) = current.take() {
                    found.push(done);
                }
                // A sub-table such as `[mcp_servers.x.headers]` belongs to the
                // server already being read; it is not a new one, and nothing
                // inside it is looked at.
                if found.iter().all(|entry| entry.name != name) {
                    current = Some(Integration {
                        name,
                        enabled: true,
                        transport: "local",
                    });
                }
            } else {
                if let Some(done) = current.take() {
                    found.push(done);
                }
                current = None;
            }
            continue;
        }

        let Some(server) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            // The value is inspected, never kept: a URL carries the API key.
            "url" => server.transport = "remote",
            "enabled" => server.enabled = value.trim() != "false",
            _ => {}
        }
    }
    if let Some(done) = current.take() {
        found.push(done);
    }

    found.sort_by(|left, right| left.name.cmp(&right.name));
    found.truncate(crate::bounds::MAX_INTEGRATIONS);
    found
}

/// The server name in a `mcp_servers.NAME` header, if it names one directly.
///
/// `mcp_servers.name.headers` returns the same name so its sub-table is
/// attributed to the server rather than read as another one.
fn server_name(header: &str) -> Option<String> {
    let rest = header.strip_prefix("mcp_servers.")?;
    let name = rest.split('.').next()?.trim().trim_matches('"');
    if name.is_empty() || name.len() > 128 {
        return None;
    }
    Some(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{Integration, parse};

    /// The user's real configuration shape, secrets and all.
    const CONFIG: &str = r#"
[ui]
compact_mode = false

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp?exaApiKey=SECRETKEY"
enabled = true

[mcp_servers.wisp]
command = "/run/current-system/sw/bin/env"
args = ["WISP_MCP_ALLOW_REAL=1", "node", "/home/friend/dev/personal/wisp/server.cjs"]
enabled = true

[mcp_servers.coolify]
url = "http://167.233.231.205:8000/mcp"
enabled = false

[mcp_servers.coolify.headers]
Authorization = "Bearer 2|SUPERSECRETTOKEN"

[models]
default = "grok-build"
"#;

    #[test]
    fn every_configured_server_is_listed_once() {
        let found = parse(CONFIG);
        let names: Vec<&str> = found.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["coolify", "exa", "wisp"]);
    }

    #[test]
    fn a_credential_never_leaves_this_module() {
        // The configuration holds a bearer token and an API key inside a URL.
        // The projection is the only thing that reaches the browser, so it is
        // the projection that must be clean.
        let encoded = serde_json::to_string(&parse(CONFIG)).expect("serialise");
        for secret in [
            "SUPERSECRETTOKEN",
            "SECRETKEY",
            "Authorization",
            "Bearer",
            "mcp.exa.ai",
            "167.233.231.205",
            "/home/friend",
            "WISP_MCP_ALLOW_REAL",
        ] {
            assert!(
                !encoded.contains(secret),
                "projection must not carry {secret}: {encoded}"
            );
        }
    }

    #[test]
    fn how_it_is_reached_is_said_without_saying_where() {
        let found = parse(CONFIG);
        let by_name = |name: &str| -> Integration {
            found
                .iter()
                .find(|entry| entry.name == name)
                .cloned()
                .expect("present")
        };
        assert_eq!(by_name("exa").transport, "remote");
        assert_eq!(by_name("wisp").transport, "local");
    }

    #[test]
    fn a_server_switched_off_is_shown_as_off_rather_than_hidden() {
        // Hiding it would be indistinguishable from not having configured it,
        // and the user would wonder why a tool they set up is absent.
        let found = parse(CONFIG);
        let coolify = found
            .iter()
            .find(|entry| entry.name == "coolify")
            .expect("present");
        assert!(!coolify.enabled);
    }

    #[test]
    fn a_sub_table_is_not_read_as_another_server() {
        assert_eq!(
            parse(CONFIG)
                .iter()
                .filter(|entry| entry.name == "coolify")
                .count(),
            1
        );
    }

    #[test]
    fn a_configuration_without_integrations_lists_none() {
        assert!(parse("[ui]\ncompact_mode = true\n").is_empty());
    }

    #[test]
    fn a_missing_home_is_not_an_error() {
        assert!(super::list_for_home(std::path::Path::new("/nonexistent-grok-home")).is_empty());
    }

    #[test]
    fn the_list_is_bounded() {
        use std::fmt::Write as _;
        let mut raw = String::new();
        for index in 0..(crate::bounds::MAX_INTEGRATIONS * 3) {
            let _ = writeln!(raw, "[mcp_servers.s{index:04}]\nenabled = true");
        }
        assert_eq!(parse(&raw).len(), crate::bounds::MAX_INTEGRATIONS);
    }
}
