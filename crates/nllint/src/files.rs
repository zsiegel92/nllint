use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::Context;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;

use crate::{config::Config, rule::Severity};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuleSetting {
    pub severity: Severity,
    pub threshold: f64,
}

pub struct FileMatcher {
    exclude: GlobSet,
    rule_sets: Vec<RuleSetMatcher>,
}

struct RuleSetMatcher {
    files: GlobSet,
    excluded_files: GlobSet,
    rules: BTreeMap<String, RuleSetting>,
}

impl FileMatcher {
    pub fn new(config: &Config) -> anyhow::Result<Self> {
        let rule_sets = config
            .rule_sets
            .iter()
            .map(|rule_set| {
                let rules = rule_set
                    .error
                    .iter()
                    .map(|(id, threshold)| {
                        (
                            id.clone(),
                            RuleSetting {
                                severity: Severity::Error,
                                threshold: threshold.min(1.0),
                            },
                        )
                    })
                    .chain(rule_set.warn.iter().map(|(id, threshold)| {
                        (
                            id.clone(),
                            RuleSetting {
                                severity: Severity::Warning,
                                threshold: threshold.min(1.0),
                            },
                        )
                    }))
                    .filter(|(_, setting)| setting.threshold >= 0.0)
                    .collect();
                Ok(RuleSetMatcher {
                    files: build_globs(&rule_set.patterns)?,
                    excluded_files: build_globs(&rule_set.exclude)?,
                    rules,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self {
            exclude: build_globs(&config.exclude)?,
            rule_sets,
        })
    }

    pub fn is_lintable(&self, relative_path: &Path) -> bool {
        !self.exclude.is_match(relative_path) && !self.rules_for(relative_path).is_empty()
    }

    pub fn rules_for<'a>(&'a self, relative_path: &Path) -> BTreeMap<&'a str, RuleSetting> {
        if self.exclude.is_match(relative_path) {
            return BTreeMap::new();
        }
        self.rule_sets
            .iter()
            .filter(|rule_set| {
                rule_set.files.is_match(relative_path)
                    && !rule_set.excluded_files.is_match(relative_path)
            })
            .flat_map(|rule_set| {
                rule_set
                    .rules
                    .iter()
                    .map(|(id, severity)| (id.as_str(), *severity))
            })
            .collect()
    }
}

pub fn discover(root: &Path, config: &Config) -> anyhow::Result<Vec<PathBuf>> {
    let matcher = FileMatcher::new(config)?;
    let mut files = Vec::new();
    let cache = root.join(&config.cache_dir);
    let rules = root.join(&config.rules_dir);
    let prompt = root.join(&config.system_prompt);
    let project_settings = root.join(crate::config::PROJECT_SETTINGS);
    for entry in WalkBuilder::new(root)
        .filter_entry(move |entry| {
            let path = entry.path();
            let is_rule = path.parent() == Some(rules.as_path())
                && path.extension().is_some_and(|extension| extension == "md");
            entry.depth() == 0
                || (entry.file_name() != ".git"
                    && !is_cache_file(&cache, path)
                    && !is_rule
                    && path != prompt
                    && path != project_settings)
        })
        .hidden(false)
        .git_ignore(!config.include_git_ignored)
        .git_global(!config.include_git_ignored)
        .git_exclude(!config.include_git_ignored)
        .require_git(false)
        .build()
    {
        let entry = entry.context("failed while walking project files")?;
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        if matcher.is_lintable(relative) {
            files.push(relative.to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

pub(crate) fn is_cache_file(cache: &Path, path: &Path) -> bool {
    path == cache
        || (path.parent() == Some(cache)
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "cache.sqlite3" || name.starts_with("cache.sqlite3-")))
}

fn build_globs(patterns: &[String]) -> anyhow::Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern).with_context(|| format!("invalid glob {pattern:?}"))?);
    }
    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use std::collections::BTreeMap;

    use crate::{
        config::{Config, RuleSet},
        rule::Severity,
    };

    use super::{FileMatcher, RuleSetting};

    #[test]
    fn selects_rules_and_severities_from_matching_sets() {
        let config = Config {
            rule_sets: vec![
                RuleSet {
                    patterns: vec!["**/*.py".into()],
                    exclude: vec!["generated/**".into()],
                    error: BTreeMap::from([("python-boundaries".into(), 0.7)]),
                    warn: BTreeMap::new(),
                },
                RuleSet {
                    patterns: vec!["**/*.ts".into()],
                    exclude: Vec::new(),
                    error: BTreeMap::new(),
                    warn: BTreeMap::from([("typescript-boundaries".into(), 0.8)]),
                },
                RuleSet {
                    patterns: vec!["src/**".into()],
                    exclude: Vec::new(),
                    error: BTreeMap::from([("shared-source-rule".into(), 1.5)]),
                    warn: BTreeMap::new(),
                },
            ],
            ..Config::default()
        };
        let matcher = FileMatcher::new(&config).unwrap();

        assert_eq!(
            matcher
                .rules_for(Path::new("src/service.py"))
                .into_iter()
                .collect::<Vec<_>>(),
            vec![
                (
                    "python-boundaries",
                    RuleSetting {
                        severity: Severity::Error,
                        threshold: 0.7
                    }
                ),
                (
                    "shared-source-rule",
                    RuleSetting {
                        severity: Severity::Error,
                        threshold: 1.0
                    }
                )
            ]
        );
        assert_eq!(
            matcher
                .rules_for(Path::new("src/client.ts"))
                .into_iter()
                .collect::<Vec<_>>(),
            vec![
                (
                    "shared-source-rule",
                    RuleSetting {
                        severity: Severity::Error,
                        threshold: 1.0
                    }
                ),
                (
                    "typescript-boundaries",
                    RuleSetting {
                        severity: Severity::Warning,
                        threshold: 0.8
                    }
                )
            ]
        );
        assert!(!matcher.is_lintable(Path::new("generated/models.py")));
        assert!(!matcher.is_lintable(Path::new("README.md")));
    }

    #[test]
    fn no_rule_sets_selects_nothing() {
        let matcher = FileMatcher::new(&Config::default()).unwrap();

        assert!(!matcher.is_lintable(Path::new("src/main.rs")));
        assert!(matcher.rules_for(Path::new("src/main.rs")).is_empty());
    }

    #[test]
    fn negative_threshold_disables_a_rule() {
        let config = Config {
            rule_sets: vec![RuleSet {
                patterns: vec!["*.ts".into()],
                exclude: Vec::new(),
                error: BTreeMap::from([("disabled".into(), -0.1)]),
                warn: BTreeMap::new(),
            }],
            ..Config::default()
        };
        assert!(
            !FileMatcher::new(&config)
                .unwrap()
                .is_lintable(Path::new("app.ts"))
        );
    }
}
