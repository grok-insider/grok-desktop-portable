//! Read-only MCP + skill name projection, scoped global vs project.
//!
//! Never projects paths, commands, URLs, headers, or skill bodies.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::bounds::{MAX_INTEGRATIONS, MAX_SKILLS};
use crate::integrations::{self, Integration};
use crate::session_catalog::grok_home;

/// Where a tool/skill is configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolScope {
    /// User GROK_HOME config / skills.
    Global,
    /// Project-local config under the workspace cwd.
    Project,
}

/// One MCP or skill name the browser may show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProjection {
    /// Display name only.
    pub name: String,
    /// `mcp` or `skill`.
    pub kind: &'static str,
    /// Global vs project.
    pub scope: ToolScope,
    /// Whether enabled (MCP); skills are always listed as enabled when present.
    pub enabled: bool,
    /// MCP transport when kind is mcp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<&'static str>,
}

/// Project tools for a workspace cwd (host path) plus global tools.
#[must_use]
pub fn list_tools_for_cwd(cwd: Option<&Path>) -> Vec<ToolProjection> {
    let mut out = Vec::new();

    for entry in integrations::list() {
        push_mcp(&mut out, &entry, ToolScope::Global);
    }
    for name in list_skill_names(&grok_home().join("skills")) {
        push_skill(&mut out, name, ToolScope::Global);
    }
    // Bundled / installed-plugin skill names (directory basenames only).
    for name in list_skill_names(&grok_home().join("bundled").join("skills")) {
        push_skill(&mut out, name, ToolScope::Global);
    }

    if let Some(cwd) = cwd {
        for name in project_mcp_names(cwd) {
            if out.len() >= MAX_INTEGRATIONS + MAX_SKILLS {
                break;
            }
            out.push(ToolProjection {
                name,
                kind: "mcp",
                scope: ToolScope::Project,
                enabled: true,
                transport: None,
            });
        }
        for name in list_skill_names(&cwd.join(".grok").join("skills")) {
            push_skill(&mut out, name, ToolScope::Project);
        }
    }

    out
}

fn push_mcp(out: &mut Vec<ToolProjection>, entry: &Integration, scope: ToolScope) {
    if out.len() >= MAX_INTEGRATIONS + MAX_SKILLS {
        return;
    }
    out.push(ToolProjection {
        name: entry.name.clone(),
        kind: "mcp",
        scope,
        enabled: entry.enabled,
        transport: Some(entry.transport),
    });
}

fn push_skill(out: &mut Vec<ToolProjection>, name: String, scope: ToolScope) {
    if out.len() >= MAX_INTEGRATIONS + MAX_SKILLS {
        return;
    }
    if out
        .iter()
        .any(|t| t.kind == "skill" && t.name == name && t.scope == scope)
    {
        return;
    }
    out.push(ToolProjection {
        name,
        kind: "skill",
        scope,
        enabled: true,
        transport: None,
    });
}

fn list_skill_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if !name.starts_with('.') && path.join("SKILL.md").is_file() {
                    names.push(name.to_owned());
                }
            }
        }
    }
    names.sort();
    names.truncate(MAX_SKILLS);
    names
}

/// Server names from project `.mcp.json` and `.grok/config.toml` (names only).
fn project_mcp_names(cwd: &Path) -> Vec<String> {
    let mut names = Vec::new();
    // Walk cwd → parents for .mcp.json (cheap fixed depth).
    let mut dir = Some(cwd.to_path_buf());
    for _ in 0..8 {
        let Some(current) = dir else {
            break;
        };
        let mcp = current.join(".mcp.json");
        if mcp.is_file() {
            if let Ok(raw) = fs::read_to_string(&mcp) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    // Common shapes: { "mcpServers": { "name": … } } or { "name": … }
                    let map = value
                        .get("mcpServers")
                        .and_then(|v| v.as_object())
                        .or_else(|| value.as_object());
                    if let Some(map) = map {
                        for key in map.keys() {
                            if key != "mcpServers" {
                                names.push(key.clone());
                            }
                        }
                    }
                }
            }
        }
        let project_cfg = current.join(".grok").join("config.toml");
        if project_cfg.is_file() {
            if let Ok(raw) = fs::read_to_string(&project_cfg) {
                for line in raw.lines() {
                    let line = line.trim();
                    if let Some(rest) = line.strip_prefix("[mcp_servers.") {
                        if let Some(name) = rest.strip_suffix(']') {
                            let name = name.split('.').next().unwrap_or(name);
                            if !name.is_empty() {
                                names.push(name.to_owned());
                            }
                        }
                    }
                }
            }
        }
        dir = current.parent().map(PathBuf::from);
        if current.join(".git").exists() {
            break;
        }
    }
    names.sort();
    names.dedup();
    names.truncate(MAX_INTEGRATIONS);
    names
}

#[cfg(test)]
mod tests {
    use super::{ToolScope, list_tools_for_cwd};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn project_mcp_and_skills_are_scoped_without_paths() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-tools-{stamp}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".grok/skills/demo")).expect("skills");
        fs::write(root.join(".grok/skills/demo/SKILL.md"), "# demo\n").expect("skill");
        fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"local-db":{"command":"secret"}}}"#,
        )
        .expect("mcp");
        let tools = list_tools_for_cwd(Some(&root));
        let project: Vec<_> = tools
            .iter()
            .filter(|t| t.scope == ToolScope::Project)
            .collect();
        assert!(
            project
                .iter()
                .any(|t| t.name == "local-db" && t.kind == "mcp")
        );
        assert!(
            project
                .iter()
                .any(|t| t.name == "demo" && t.kind == "skill")
        );
        let blob = serde_json::to_string(&tools).expect("json");
        assert!(!blob.contains("secret"));
        assert!(!blob.contains(root.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(&root);
    }
}
