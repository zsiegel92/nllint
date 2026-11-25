use std::{
    collections::BTreeMap,
    ffi::OsStr,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, anyhow, ensure};
use jsonc_parser::{ParseOptions, parse_to_serde_value};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default = "default_rules_dir")]
    pub rules_dir: PathBuf,
    #[schemars(length(min = 1))]
    pub rule_sets: Vec<RuleSet>,
    #[serde(default = "default_system_prompt")]
    pub system_prompt: PathBuf,
    #[serde(default = "default_cache_dir")]
    pub cache_dir: PathBuf,
    #[serde(default)]
    pub project_root: Option<PathBuf>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub include_git_ignored: bool,
    #[serde(default = "default_sync_seconds")]
    pub annotation_poll_seconds: u64,
    #[serde(default = "default_concurrency")]
    pub concurrency: NonZeroUsize,
    #[serde(default = "default_timeout")]
    pub request_timeout_seconds: u64,
    #[serde(default)]
    pub watch: WatchConfig,
    #[serde(default)]
    pub precondition: Option<PreconditionConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PreconditionConfig {
    pub command: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RuleSet {
    /// File globs relative to the config directory, such as **/*.ts.
    #[serde(rename = "match")]
    #[schemars(length(min = 1))]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    /// Rule IDs to minimum verdict confidence (0 to 1 inclusive).
    #[schemars(schema_with = "rule_thresholds_schema")]
    pub error: BTreeMap<String, f64>,
    #[serde(default)]
    /// Rule IDs to minimum verdict confidence (0 to 1 inclusive).
    #[schemars(schema_with = "rule_thresholds_schema")]
    pub warn: BTreeMap<String, f64>,
}

fn rule_thresholds_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
        }
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct WatchConfig {
    pub debounce_milliseconds: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema: None,
            exclude: vec!["target/**".into(), ".nllint/**".into()],
            rules_dir: default_rules_dir(),
            rule_sets: Vec::new(),
            system_prompt: default_system_prompt(),
            cache_dir: default_cache_dir(),
            project_root: None,
            project_id: None,
            include_git_ignored: false,
            annotation_poll_seconds: default_sync_seconds(),
            concurrency: default_concurrency(),
            request_timeout_seconds: default_timeout(),
            watch: WatchConfig::default(),
            precondition: None,
        }
    }
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            debounce_milliseconds: 300,
        }
    }
}

impl Config {
    pub async fn load(path: &Path) -> anyhow::Result<Self> {
        ensure!(
            path.extension() == Some(OsStr::new("jsonc")),
            "config path must end in .jsonc: {}",
            path.display()
        );
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| {
                let old_path = path.with_extension("json");
                if error.kind() == std::io::ErrorKind::NotFound && old_path.is_file() {
                    anyhow!("rename {} to {}", old_path.display(), path.display())
                } else {
                    error.into()
                }
            })
            .with_context(|| format!("failed to read {}", path.display()))?;
        let config: Self =
            parse_jsonc(&text).with_context(|| format!("invalid config {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            !self.rule_sets.is_empty(),
            "config requires at least one rule_sets entry"
        );
        if let Some(id) = &self.project_id {
            ensure!(
                !id.trim().is_empty() && id.chars().count() <= 200 && !id.contains('\0'),
                "project_id must be nonempty and at most 200 characters"
            );
        }
        if let Some(precondition) = &self.precondition {
            ensure!(
                !precondition.command.is_empty(),
                "precondition.command cannot be empty"
            );
        }
        for (index, rule_set) in self.rule_sets.iter().enumerate() {
            ensure!(
                !rule_set.patterns.is_empty(),
                "rule_sets[{index}].match cannot be empty"
            );
            ensure!(
                !rule_set.error.is_empty() || !rule_set.warn.is_empty(),
                "rule_sets[{index}] requires error or warn rules"
            );
            for (id, threshold) in &rule_set.error {
                ensure!(
                    *threshold < 0.0 || !rule_set.warn.get(id).is_some_and(|value| *value >= 0.0),
                    "rule_sets[{index}] declares {id:?} as both error and warn"
                );
            }
            for threshold in rule_set.error.values().chain(rule_set.warn.values()) {
                ensure!(
                    threshold.is_finite(),
                    "rule_sets[{index}] threshold must be finite"
                );
            }
        }
        Ok(())
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.request_timeout_seconds)
    }

    pub fn watch_debounce(&self) -> Duration {
        Duration::from_millis(self.watch.debounce_milliseconds)
    }
}

fn parse_jsonc<T: serde::de::DeserializeOwned>(text: &str) -> anyhow::Result<T> {
    let options = ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    };
    Ok(parse_to_serde_value(text, &options)?)
}

fn default_rules_dir() -> PathBuf {
    ".nllint-rules".into()
}
fn default_system_prompt() -> PathBuf {
    ".nllint-system.md".into()
}
fn default_cache_dir() -> PathBuf {
    ".nllint".into()
}
fn default_concurrency() -> NonZeroUsize {
    NonZeroUsize::new(5).expect("nonzero")
}
fn default_timeout() -> u64 {
    30
}

fn default_sync_seconds() -> u64 {
    300
}

pub const PROJECT_SETTINGS: &str = ".nllintrc.jsonc";

pub fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"))
        .join("nllint")
}

pub async fn discover(start: &Path) -> anyhow::Result<Option<PathBuf>> {
    let start = start.canonicalize()?;
    let boundary = start.ancestors().find(|p| p.join(".git").exists());
    for directory in start.ancestors() {
        let config = directory.join(PROJECT_SETTINGS);
        if config.is_file() {
            return Ok(Some(config));
        }
        if Some(directory) == boundary || boundary.is_none() {
            break;
        }
    }
    let root = boundary.unwrap_or(&start);
    let registry = config_home().join("projects");
    let mut entries = match tokio::fs::read_dir(registry).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    #[derive(Deserialize)]
    struct ProjectTarget {
        project_root: Option<PathBuf>,
    }

    let mut found = None;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path().join("settings.jsonc");
        if !path.is_file() {
            continue;
        }
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(target) = parse_jsonc::<ProjectTarget>(&text) else {
            continue;
        };
        if target
            .project_root
            .as_ref()
            .filter(|p| p.is_absolute())
            .and_then(|p| p.canonicalize().ok())
            .as_deref()
            == Some(root)
        {
            ensure!(
                found.is_none(),
                "multiple global configurations match {}",
                root.display()
            );
            found = Some(path);
        }
    }
    Ok(found)
}

pub async fn load_project(path: &Path) -> anyhow::Result<(PathBuf, Config)> {
    let mut config = Config::load(path).await?;
    let directory = path.parent().context("config path has no parent")?;
    let root = if let Some(root) = config.project_root.as_ref() {
        ensure!(root.is_absolute(), "project_root must be absolute");
        config.rules_dir = directory.join(&config.rules_dir);
        config.system_prompt = directory.join(&config.system_prompt);
        config.cache_dir = directory.join(&config.cache_dir);
        root.canonicalize()?
    } else {
        ensure!(
            !path.starts_with(config_home().join("projects")),
            "global settings require project_root"
        );
        directory.canonicalize()?
    };
    Ok((root, config))
}
