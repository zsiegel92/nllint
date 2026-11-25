use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use crate::{
    cache::Cache,
    config::Config,
    files,
    gateway::{Gateway, RuleAnswer, SyncState, VersionChanged},
    hash,
    precondition::{CommandPrecondition, Precondition, PreconditionFailure},
    rule::{self, Rule, Severity},
};

#[derive(Debug, Deserialize, Serialize)]
pub struct RunReport {
    pub files_checked: usize,
    pub rules: usize,
    pub api_requests: usize,
    pub cache_hits: usize,
    pub violations: Vec<Violation>,
    pub precondition_failure: Option<PreconditionFailure>,
}

impl RunReport {
    pub fn count(&self, severity: Severity) -> usize {
        self.violations
            .iter()
            .filter(|violation| violation.severity == severity)
            .count()
    }

    pub fn has_errors(&self) -> bool {
        self.violations
            .iter()
            .any(|violation| violation.severity == Severity::Error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Violation {
    pub path: PathBuf,
    pub rule_id: String,
    pub rule_path: PathBuf,
    pub message: String,
    pub confidence: f64,
    pub severity: Severity,
    pub regions: Vec<LineRegion>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LineRegion {
    pub start: usize,
    pub end: usize,
}

pub struct Engine {
    root: PathBuf,
    config: Config,
    provider: Arc<Gateway>,
    precondition: Option<Arc<dyn Precondition>>,
}

impl Engine {
    pub fn new(root: PathBuf, config: Config, provider: Arc<Gateway>) -> Self {
        let precondition = config
            .precondition
            .clone()
            .map(|value| Arc::new(CommandPrecondition::new(value)) as Arc<dyn Precondition>);
        Self {
            root,
            config,
            provider,
            precondition,
        }
    }

    pub fn selected_files(&self) -> anyhow::Result<Vec<PathBuf>> {
        files::discover(&self.root, &self.config)
    }

    pub async fn run(&self) -> anyhow::Result<RunReport> {
        let files = self.selected_files()?;
        self.run_files(files).await
    }

    pub async fn run_files(&self, files: Vec<PathBuf>) -> anyhow::Result<RunReport> {
        self.run_files_with_progress(files, |_| Ok(())).await
    }

    pub async fn run_with_progress(
        &self,
        on_file: impl FnMut(&FileProgress) -> anyhow::Result<()>,
    ) -> anyhow::Result<RunReport> {
        let files = self.selected_files()?;
        self.run_files_with_progress(files, on_file).await
    }

    pub async fn run_files_with_progress(
        &self,
        files: Vec<PathBuf>,
        mut on_file: impl FnMut(&FileProgress) -> anyhow::Result<()>,
    ) -> anyhow::Result<RunReport> {
        let rules = Arc::new(rule::load(&self.root.join(&self.config.rules_dir)).await?);
        validate_rule_sets(&self.config, &rules)?;
        let matcher = files::FileMatcher::new(&self.config)?;
        let jobs = files
            .into_iter()
            .map(|path| {
                let selected = matcher.rules_for(&path);
                let rules = rules
                    .iter()
                    .enumerate()
                    .filter_map(|(index, rule)| {
                        selected.get(rule.id.as_str()).map(|setting| SelectedRule {
                            index,
                            setting: *setting,
                        })
                    })
                    .collect();
                FileJob { path, rules }
            })
            .collect::<Vec<_>>();
        let precondition_files = jobs.iter().map(|job| job.path.clone()).collect::<Vec<_>>();
        if let Some(precondition) = &self.precondition
            && let Some(failure) = precondition.check(&self.root, &precondition_files).await?
        {
            return Ok(RunReport {
                files_checked: 0,
                rules: rules.len(),
                api_requests: 0,
                cache_hits: 0,
                violations: Vec::new(),
                precondition_failure: Some(failure),
            });
        }

        let prompt =
            match tokio::fs::read_to_string(self.root.join(&self.config.system_prompt)).await {
                Ok(prompt) => prompt,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(error) => return Err(error.into()),
            };
        let prompt_hash = hash::bytes(&prompt);
        let cache =
            Cache::open(&self.root.join(&self.config.cache_dir).join("cache.sqlite3")).await?;
        let sync = self
            .provider
            .sync(&cache, self.config.annotation_poll_seconds)
            .await?;
        let context = Arc::new(FileContext {
            root: self.root.clone(),
            sync,
            rules_dir: self.root.join(&self.config.rules_dir),
            prompt,
            prompt_hash,
            rules,
            cache,
            provider: Arc::clone(&self.provider),
        });
        let mut reports = match self
            .dispatch(Arc::clone(&context), &jobs, &mut on_file)
            .await
        {
            Err(error) if error.is::<VersionChanged>() => {
                let mut updated = (*context).clone();
                updated.sync = self.provider.sync(&updated.cache, 0).await?;
                self.dispatch(Arc::new(updated), &jobs, &mut on_file)
                    .await?
            }
            result => result?,
        };

        reports.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(RunReport {
            files_checked: reports.len(),
            rules: context.rules.len(),
            api_requests: reports.iter().map(|x| x.api_requests).sum(),
            cache_hits: reports.iter().map(|x| x.cache_hits).sum(),
            violations: reports.into_iter().flat_map(|x| x.violations).collect(),
            precondition_failure: None,
        })
    }

    async fn dispatch(
        &self,
        context: Arc<FileContext>,
        jobs: &[FileJob],
        on_file: &mut impl FnMut(&FileProgress) -> anyhow::Result<()>,
    ) -> anyhow::Result<Vec<FileProgress>> {
        let mut pending = jobs.iter().cloned();
        let mut tasks = JoinSet::new();
        let mut reports = Vec::new();
        for _ in 0..self.config.concurrency.get() {
            if let Some(job) = pending.next() {
                spawn_file(&mut tasks, Arc::clone(&context), job);
            }
        }
        while let Some(result) = tasks.join_next().await {
            let report = result??;
            on_file(&report)?;
            reports.push(report);
            if let Some(job) = pending.next() {
                spawn_file(&mut tasks, Arc::clone(&context), job);
            }
        }
        Ok(reports)
    }
}

fn validate_rule_sets(config: &Config, rules: &[Rule]) -> anyhow::Result<()> {
    let known = rules
        .iter()
        .map(|rule| rule.id.as_str())
        .collect::<BTreeSet<_>>();
    for (set_index, rule_set) in config.rule_sets.iter().enumerate() {
        for rule_id in rule_set
            .error
            .iter()
            .chain(rule_set.warn.iter())
            .filter_map(|(id, threshold)| (*threshold >= 0.0).then_some(id))
        {
            ensure!(
                known.contains(rule_id.as_str()),
                "rule_sets[{set_index}] references unknown rule {rule_id:?}"
            );
        }
    }
    Ok(())
}

fn spawn_file(
    tasks: &mut JoinSet<anyhow::Result<FileProgress>>,
    context: Arc<FileContext>,
    job: FileJob,
) {
    tasks.spawn(async move { lint_file(context, job).await });
}

#[derive(Clone)]
struct FileJob {
    path: PathBuf,
    rules: Vec<SelectedRule>,
}

#[derive(Clone)]
struct SelectedRule {
    index: usize,
    setting: files::RuleSetting,
}

#[derive(Clone)]
struct FileContext {
    root: PathBuf,
    sync: SyncState,
    rules_dir: PathBuf,
    prompt: String,
    prompt_hash: String,
    rules: Arc<Vec<Rule>>,
    cache: Cache,
    provider: Arc<Gateway>,
}

pub struct FileProgress {
    pub path: PathBuf,
    pub api_requests: usize,
    pub cache_hits: usize,
    pub violations: Vec<Violation>,
}

async fn lint_file(context: Arc<FileContext>, job: FileJob) -> anyhow::Result<FileProgress> {
    let FileJob {
        path,
        rules: selections,
    } = job;
    let display_path = path.to_string_lossy().replace('\\', "/");
    let source = tokio::fs::read_to_string(context.root.join(&path))
        .await
        .with_context(|| format!("failed to read {}", path.display()))?;
    let file_hash = hash::bytes(&source);
    let rules = selections
        .iter()
        .map(|selection| {
            let rule = &context.rules[selection.index];
            let relative = rule
                .source_path
                .strip_prefix(&context.root)
                .or_else(|_| rule.source_path.strip_prefix(&context.rules_dir))
                .unwrap_or(&rule.source_path);
            (rule, relative.to_string_lossy().replace('\\', "/"))
        })
        .collect::<Vec<_>>();
    let keys = rules
        .iter()
        .map(|(rule, rule_path)| {
            let identity = [
                display_path.clone(),
                rule_path.clone(),
                file_hash.clone(),
                rule.hash.clone(),
                context.prompt_hash.clone(),
            ];
            hash::key(
                "file-rule-v1",
                &(
                    &context.provider.namespace,
                    &context.sync.version,
                    context.sync.revision(&identity),
                    &identity,
                ),
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut answers: Vec<Option<RuleAnswer>> = context.cache.get_many(keys.clone()).await?;
    let missing = answers
        .iter()
        .enumerate()
        .filter_map(|(index, answer)| answer.is_none().then_some(index))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        let requested = missing
            .iter()
            .map(|&index| rules[index].clone())
            .collect::<Vec<_>>();
        let mut fresh = context
            .provider
            .lint(
                &context.prompt,
                &display_path,
                &source,
                &requested,
                &context.sync.version,
            )
            .await?
            .into_iter()
            .map(|answer| (answer.rule_id.clone(), answer))
            .collect::<BTreeMap<_, _>>();
        ensure!(
            fresh.len() == missing.len(),
            "gateway returned the wrong rule answers"
        );
        let mut entries = Vec::new();
        let lines = source.lines().count();
        for index in &missing {
            let answer = fresh
                .remove(&rules[*index].0.id)
                .context("gateway omitted a rule")?;
            for finding in &answer.ranges {
                ensure!(
                    finding.region.start > 0
                        && finding.region.end >= finding.region.start
                        && finding.region.end <= lines
                        && (0.0..=1.0).contains(&finding.confidence),
                    "gateway returned an invalid range or confidence"
                );
            }
            entries.push((keys[*index].clone(), answer.clone()));
            answers[*index] = Some(answer);
        }
        context.cache.put_many(entries).await?;
    }
    let mut violations = Vec::new();
    for ((answer, selection), (rule, _)) in answers.into_iter().zip(selections).zip(rules) {
        let ranges = answer.context("missing result")?.ranges;
        let selected = ranges
            .into_iter()
            .filter(|finding| finding.confidence >= selection.setting.threshold)
            .collect::<Vec<_>>();
        if !selected.is_empty() {
            violations.push(Violation {
                path: path.clone(),
                rule_id: rule.id.clone(),
                rule_path: rule
                    .source_path
                    .strip_prefix(&context.root)
                    .unwrap_or(&rule.source_path)
                    .to_owned(),
                message: rule.message.clone(),
                confidence: selected
                    .iter()
                    .map(|finding| finding.confidence)
                    .fold(0.0, f64::max),
                severity: selection.setting.severity,
                regions: selected.into_iter().map(|finding| finding.region).collect(),
            });
        }
    }
    apply_nllint_ignores(&source, &mut violations);
    Ok(FileProgress {
        path,
        api_requests: usize::from(!missing.is_empty()),
        cache_hits: keys.len() - missing.len(),
        violations,
    })
}

fn apply_nllint_ignores(source: &str, violations: &mut Vec<Violation>) {
    let ignored_lines = source
        .lines()
        .enumerate()
        .filter_map(|(index, line)| line.contains("nllint-ignore").then_some(index + 1))
        .collect::<BTreeSet<_>>();
    if ignored_lines.is_empty() {
        return;
    }

    violations.retain_mut(|violation| {
        if violation.regions.is_empty() {
            return true;
        }
        let mut visible_lines = violation
            .regions
            .iter()
            .flat_map(|region| region.start..=region.end)
            .filter(|line| !ignored_lines.contains(line))
            .collect::<Vec<_>>();
        visible_lines.sort_unstable();
        visible_lines.dedup();
        violation.regions = regions(&visible_lines);
        !violation.regions.is_empty()
    });
}

fn regions(lines: &[usize]) -> Vec<LineRegion> {
    let mut result = Vec::new();
    for &line in lines {
        match result.last_mut() {
            Some(LineRegion { end, .. }) if *end + 1 == line => *end = line,
            _ => result.push(LineRegion {
                start: line,
                end: line,
            }),
        }
    }
    result
}
