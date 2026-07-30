//! Grok-only model catalog projection for Light.
//!
//! Reads the user's `models_cache.json` under GROK_HOME (same store the CLI
//! uses) and projects only models Light may offer: Grok / xAI / SpaceXAI /
//! grok-build family. Never third-party providers. Credentials in the cache
//! are never projected.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::bounds::MAX_MODELS;
use crate::session_catalog::grok_home;

/// One selectable model as the browser may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProjection {
    /// Catalog / routing id (e.g. `grok-4.5`, `grok-build`).
    pub id: String,
    /// Human label.
    pub name: String,
    /// Whether the model exposes reasoning-effort controls.
    pub supports_reasoning_effort: bool,
    /// Effort options when supported (empty otherwise).
    pub reasoning_efforts: Vec<EffortOption>,
    /// Default effort id when supported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

/// One reasoning-effort level for a model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    /// Wire / meta value (e.g. `high`, `medium`, `low`).
    pub id: String,
    /// UI label.
    pub label: String,
}

/// Whether a catalog id is a Grok/xAI family model Light may offer.
#[must_use]
pub fn is_grok_model_id(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    if lower.is_empty() || lower.contains('/') && !lower.starts_with("xai/") {
        // Foreign provider paths like `anthropic/claude` are refused.
        if lower.contains("claude")
            || lower.contains("gpt-")
            || lower.contains("openai")
            || lower.contains("gemini")
            || lower.contains("anthropic")
        {
            return false;
        }
    }
    lower.starts_with("grok")
        || lower.contains("grok-build")
        || lower.starts_with("xai/")
        || lower.contains("spacexai")
}

/// List Grok-only models from the user's cache (or empty if missing).
#[must_use]
pub fn list_models() -> Vec<ModelProjection> {
    list_models_in(&grok_home())
}

/// Same as [`list_models`] with an explicit Grok home.
#[must_use]
pub fn list_models_in(home: &Path) -> Vec<ModelProjection> {
    let path = home.join("models_cache.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(models) = root.get("models").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (key, entry) in models {
        if !is_grok_model_id(key) {
            continue;
        }
        let info = entry.get("info").unwrap_or(entry);
        if info.get("hidden").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let id = info
            .get("id")
            .or_else(|| info.get("model"))
            .and_then(Value::as_str)
            .unwrap_or(key)
            .to_owned();
        if !is_grok_model_id(&id) {
            continue;
        }
        let name = info
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned();
        let supports = info
            .get("supports_reasoning_effort")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut efforts = Vec::new();
        let mut default_effort = None;
        if supports {
            if let Some(list) = info.get("reasoning_efforts").and_then(Value::as_array) {
                for item in list {
                    let effort_id = item
                        .get("id")
                        .or_else(|| item.get("value"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if effort_id.is_empty() {
                        continue;
                    }
                    let label = item
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or(effort_id)
                        .to_owned();
                    if item.get("default").and_then(Value::as_bool) == Some(true) {
                        default_effort = Some(effort_id.to_owned());
                    }
                    efforts.push(EffortOption {
                        id: effort_id.to_owned(),
                        label,
                    });
                }
            }
            if default_effort.is_none() {
                default_effort = info
                    .get("reasoning_effort")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| efforts.first().map(|e| e.id.clone()));
            }
        }
        out.push(ModelProjection {
            id,
            name,
            supports_reasoning_effort: supports && !efforts.is_empty(),
            reasoning_efforts: efforts,
            default_effort,
        });
        if out.len() >= MAX_MODELS {
            break;
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Default model id from `config.toml` `[models] default = "…"`, if Grok.
#[must_use]
pub fn default_model_id() -> Option<String> {
    default_model_id_in(&grok_home())
}

/// Same as [`default_model_id`] with an explicit home.
#[must_use]
pub fn default_model_id_in(home: &Path) -> Option<String> {
    let raw = fs::read_to_string(home.join("config.toml")).ok()?;
    for line in raw.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("default") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let value = rest.trim().trim_matches('"').trim_matches('\'');
                if is_grok_model_id(value) {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{is_grok_model_id, list_models_in};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn grok_ids_pass_and_foreign_fail() {
        assert!(is_grok_model_id("grok-4.5"));
        assert!(is_grok_model_id("grok-build"));
        assert!(is_grok_model_id("Grok 4"));
        assert!(!is_grok_model_id("claude-opus"));
        assert!(!is_grok_model_id("gpt-5.6"));
        assert!(!is_grok_model_id("openai/gpt-4"));
    }

    #[test]
    fn list_filters_to_grok_and_exposes_efforts() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("light-models-{stamp}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("mkdir");
        fs::write(
            root.join("models_cache.json"),
            r#"{
              "models": {
                "grok-4.5": {
                  "info": {
                    "id": "grok-4.5",
                    "name": "Grok 4.5",
                    "supports_reasoning_effort": true,
                    "reasoning_effort": "high",
                    "reasoning_efforts": [
                      {"id": "high", "value": "high", "label": "High", "default": true},
                      {"id": "low", "value": "low", "label": "Low"}
                    ]
                  }
                },
                "claude-opus": {
                  "info": { "id": "claude-opus", "name": "Claude" }
                }
              }
            }"#,
        )
        .expect("write");
        let models = list_models_in(&root);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "grok-4.5");
        assert!(models[0].supports_reasoning_effort);
        assert_eq!(models[0].reasoning_efforts.len(), 2);
        assert_eq!(models[0].default_effort.as_deref(), Some("high"));
        let _ = fs::remove_dir_all(&root);
    }
}
