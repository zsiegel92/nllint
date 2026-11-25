use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::Context;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::{
    Config, Engine, config,
    engine::{FileProgress, RunReport, Violation},
    files::{self, FileMatcher},
    gateway::Gateway,
    precondition::PreconditionFailure,
    rule::Severity,
};

const PROTOCOL_VERSION: u8 = 1;

pub struct WatchOptions {
    pub snapshot_file: Option<PathBuf>,
    pub stdout: bool,
    pub stream: bool,
}

pub async fn run(
    config_path: PathBuf,
    include_git_ignored: bool,
    options: WatchOptions,
) -> anyhow::Result<()> {
    let (root, mut config) = config::load_project(&config_path).await?;
    config.include_git_ignored |= include_git_ignored;
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            let _ = sender.send(event);
        },
        notify::Config::default(),
    )?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    if let Some(directory) = config_path.parent().filter(|p| !p.starts_with(&root)) {
        watcher.watch(directory, RecursiveMode::Recursive)?;
    }
    let mut next_sync = tokio::time::Instant::now()
        + std::time::Duration::from_secs(config.annotation_poll_seconds.max(1));

    let mut state = WatchState::default();
    let mut sequence = 1;
    emit_started(sequence, "initial", &[], &options)?;
    let initial = RunSelection::full(&root, &config, &state)?;
    emit_snapshot(
        run_once(&root, &config, sequence, initial, &mut state, &options).await,
        &options,
    )
    .await?;

    loop {
        let first = tokio::select! {
            event = receiver.recv() => match event {
                Some(event) => Some(event),
                None => break,
            },
            _ = tokio::time::sleep_until(next_sync) => None,
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
        };
        let mut periodic = first.is_none();
        let mut paths = first.map(event_paths).transpose()?.unwrap_or_default();
        let debounce = config.watch_debounce();
        while !periodic {
            let until_sync = next_sync.saturating_duration_since(tokio::time::Instant::now());
            if until_sync.is_zero() {
                periodic = true;
                break;
            }
            let Ok(Some(event)) =
                tokio::time::timeout(debounce.min(until_sync), receiver.recv()).await
            else {
                periodic = tokio::time::Instant::now() >= next_sync;
                break;
            };
            paths.extend(event_paths(event)?);
        }
        paths.sort();
        paths.dedup();
        if !periodic && !is_relevant(&root, &config_path, &config, &options, &paths)? {
            continue;
        }

        sequence += 1;
        let changed_paths = relative_paths(&root, &paths);
        emit_started(
            sequence,
            if periodic { "gateway" } else { "filesystem" },
            &changed_paths,
            &options,
        )?;
        let full_run = periodic || requires_full_run(&root, &config_path, &config, &paths);
        if periodic {
            next_sync = tokio::time::Instant::now()
                + std::time::Duration::from_secs(config.annotation_poll_seconds.max(1));
        }
        match config::load_project(&config_path).await {
            Ok((updated_root, mut updated)) if updated_root == root => {
                updated.include_git_ignored |= include_git_ignored;
                if updated.annotation_poll_seconds != config.annotation_poll_seconds {
                    next_sync = tokio::time::Instant::now()
                        + std::time::Duration::from_secs(updated.annotation_poll_seconds.max(1));
                }
                config = updated;
            }
            Ok(_) => {
                emit_snapshot(
                    Snapshot::error(
                        &root,
                        sequence,
                        "Project root changed. Restart watch.".into(),
                        &state,
                    ),
                    &options,
                )
                .await?;
                continue;
            }
            Err(error) => {
                emit_snapshot(
                    Snapshot::error(&root, sequence, format!("{error:#}"), &state),
                    &options,
                )
                .await?;
                continue;
            }
        }
        let selection = if full_run {
            RunSelection::full(&root, &config, &state)
        } else {
            RunSelection::changed(&root, &config, &paths, &state)
        };
        let selection = match selection {
            Ok(selection) => selection,
            Err(error) => {
                emit_snapshot(
                    Snapshot::error(&root, sequence, format!("{error:#}"), &state),
                    &options,
                )
                .await?;
                continue;
            }
        };
        emit_snapshot(
            run_once(&root, &config, sequence, selection, &mut state, &options).await,
            &options,
        )
        .await?;
    }
    drop(watcher);
    Ok(())
}

async fn run_once(
    root: &Path,
    config: &Config,
    sequence: u64,
    selection: RunSelection,
    state: &mut WatchState,
    options: &WatchOptions,
) -> Snapshot {
    let RunSelection {
        lint_paths,
        updated_paths,
        full_update,
    } = selection;
    if lint_paths.is_empty() {
        return Snapshot::from_report(
            root,
            sequence,
            RunReport {
                files_checked: 0,
                rules: 0,
                api_requests: 0,
                cache_hits: 0,
                violations: Vec::new(),
                precondition_failure: None,
            },
            updated_paths,
            full_update,
            state,
        );
    }
    let result = async {
        let provider = Arc::new(Gateway::from_config(config, root).await?);
        let engine = Engine::new(root.to_owned(), config.clone(), provider);
        if options.stream && options.stdout {
            engine
                .run_files_with_progress(lint_paths, |file| {
                    write_json_line(&FileResult::new(root, sequence, file))
                })
                .await
        } else {
            engine.run_files(lint_paths).await
        }
    }
    .await;
    match result {
        Ok(report) => {
            Snapshot::from_report(root, sequence, report, updated_paths, full_update, state)
        }
        Err(error) => Snapshot::error(root, sequence, format!("{error:#}"), state),
    }
}

#[derive(Default)]
struct WatchState {
    diagnostics: BTreeMap<PathBuf, Vec<Diagnostic>>,
}

impl WatchState {
    fn paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.diagnostics.keys()
    }

    fn contains(&self, path: &Path) -> bool {
        self.diagnostics.contains_key(path)
    }

    fn all_diagnostics(&self) -> Vec<Diagnostic> {
        self.diagnostics.values().flatten().cloned().collect()
    }
}

struct RunSelection {
    lint_paths: Vec<PathBuf>,
    updated_paths: Vec<PathBuf>,
    full_update: bool,
}

impl RunSelection {
    fn full(root: &Path, config: &Config, state: &WatchState) -> anyhow::Result<Self> {
        let lint_paths = files::discover(root, config)?;
        let updated_paths = lint_paths
            .iter()
            .chain(state.paths())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        Ok(Self {
            lint_paths,
            updated_paths,
            full_update: true,
        })
    }

    fn changed(
        root: &Path,
        config: &Config,
        paths: &[PathBuf],
        state: &WatchState,
    ) -> anyhow::Result<Self> {
        let matcher = FileMatcher::new(config)?;
        let updated_paths = paths
            .iter()
            .filter_map(|path| path.strip_prefix(root).ok())
            .filter(|relative| matcher.is_lintable(relative) || state.contains(relative))
            .map(Path::to_owned)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let discovered: BTreeSet<_> = files::discover(root, config)?.into_iter().collect();
        let lint_paths = updated_paths
            .iter()
            .filter(|relative| discovered.contains(*relative))
            .cloned()
            .collect();
        Ok(Self {
            lint_paths,
            updated_paths,
            full_update: false,
        })
    }
}

fn requires_full_run(root: &Path, config_path: &Path, config: &Config, paths: &[PathBuf]) -> bool {
    let rules = root.join(&config.rules_dir);
    let prompt = root.join(&config.system_prompt);
    paths.iter().any(|path| {
        path == config_path || path == &prompt || path.starts_with(&rules) || ignore_file(path)
    })
}

fn ignore_file(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".gitignore" | ".ignore")
    ) || path.ends_with(".git/info/exclude")
}

fn event_paths(event: notify::Result<Event>) -> anyhow::Result<Vec<PathBuf>> {
    Ok(event.context("filesystem watcher failed")?.paths)
}

fn is_relevant(
    root: &Path,
    config_path: &Path,
    config: &Config,
    options: &WatchOptions,
    paths: &[PathBuf],
) -> anyhow::Result<bool> {
    let matcher = FileMatcher::new(config)?;
    let rules = root.join(&config.rules_dir);
    let prompt = root.join(&config.system_prompt);
    let cache = root.join(&config.cache_dir);
    Ok(paths.iter().any(|path| {
        if options
            .snapshot_file
            .as_ref()
            .is_some_and(|file| path == file)
            || files::is_cache_file(&cache, path)
        {
            return false;
        }
        if path == config_path || path == &prompt || path.starts_with(&rules) || ignore_file(path) {
            return true;
        }
        path.strip_prefix(root)
            .is_ok_and(|relative| matcher.is_lintable(relative))
    }))
}

fn relative_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn emit_started(
    sequence: u64,
    trigger: &'static str,
    changed_paths: &[String],
    options: &WatchOptions,
) -> anyhow::Result<()> {
    if options.stdout {
        write_json_line(&Started {
            schema_version: PROTOCOL_VERSION,
            kind: "run_started",
            sequence,
            trigger,
            changed_paths,
        })?;
    }
    Ok(())
}

async fn emit_snapshot(snapshot: Snapshot, options: &WatchOptions) -> anyhow::Result<()> {
    if options.stdout {
        write_json_line(&snapshot)?;
    }
    if let Some(path) = &options.snapshot_file {
        write_snapshot(path.clone(), snapshot).await?;
    }
    Ok(())
}

fn write_json_line(value: &impl Serialize) -> anyhow::Result<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

async fn write_snapshot(path: PathBuf, snapshot: Snapshot) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || {
        let parent = path.parent().context("snapshot path has no parent")?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, &snapshot)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path).map_err(|error| error.error)?;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[derive(Serialize)]
struct Started<'a> {
    schema_version: u8,
    kind: &'static str,
    sequence: u64,
    trigger: &'static str,
    changed_paths: &'a [String],
}

#[derive(Serialize)]
struct FileResult {
    schema_version: u8,
    kind: &'static str,
    sequence: u64,
    root: PathBuf,
    path: PathBuf,
    diagnostics: Vec<Diagnostic>,
}

impl FileResult {
    fn new(root: &Path, sequence: u64, file: &FileProgress) -> Self {
        Self {
            schema_version: PROTOCOL_VERSION,
            kind: "file_result",
            sequence,
            root: root.to_owned(),
            path: file.path.clone(),
            diagnostics: file
                .violations
                .iter()
                .cloned()
                .map(Diagnostic::from)
                .collect(),
        }
    }
}

#[derive(Serialize)]
struct Snapshot {
    schema_version: u8,
    kind: &'static str,
    sequence: u64,
    root: PathBuf,
    line_base: u8,
    status: Status,
    full_update: bool,
    updated_paths: Vec<PathBuf>,
    diagnostics: Vec<Diagnostic>,
    stats: Option<Stats>,
    precondition: Option<PreconditionStatus>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Clean,
    Violations,
    PreconditionFailed,
    Error,
}

#[derive(Clone, Serialize)]
struct Diagnostic {
    path: PathBuf,
    rule_id: String,
    rule_path: PathBuf,
    message: String,
    severity: Severity,
    confidence: f64,
    regions: Vec<Region>,
}

#[derive(Clone, Serialize)]
struct Region {
    start_line: usize,
    end_line: usize,
}

#[derive(Serialize)]
struct Stats {
    files_checked: usize,
    rules: usize,
    api_requests: usize,
    cache_hits: usize,
    violations: usize,
    errors: usize,
    warnings: usize,
}

#[derive(Serialize)]
struct PreconditionStatus {
    command: Vec<String>,
    exit_code: Option<i32>,
    output: String,
    skipped_files: Vec<PathBuf>,
}

impl Snapshot {
    fn from_report(
        root: &Path,
        sequence: u64,
        report: RunReport,
        updated_paths: Vec<PathBuf>,
        full_update: bool,
        state: &mut WatchState,
    ) -> Self {
        let precondition_failed = report.precondition_failure.is_some();
        let (updated_paths, full_update) = if precondition_failed {
            (Vec::new(), false)
        } else {
            for path in &updated_paths {
                state.diagnostics.remove(path);
            }
            for violation in report.violations {
                state
                    .diagnostics
                    .entry(violation.path.clone())
                    .or_default()
                    .push(Diagnostic::from(violation));
            }
            (updated_paths, full_update)
        };
        let diagnostics = state.all_diagnostics();
        let errors = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
            .count();
        let warnings = diagnostics.len() - errors;
        let status = if precondition_failed {
            Status::PreconditionFailed
        } else if diagnostics.is_empty() {
            Status::Clean
        } else {
            Status::Violations
        };
        let stats = Stats {
            files_checked: report.files_checked,
            rules: report.rules,
            api_requests: report.api_requests,
            cache_hits: report.cache_hits,
            violations: diagnostics.len(),
            errors,
            warnings,
        };
        Self {
            schema_version: PROTOCOL_VERSION,
            kind: "snapshot",
            sequence,
            root: root.to_owned(),
            line_base: 1,
            status,
            full_update,
            updated_paths,
            diagnostics,
            stats: Some(stats),
            precondition: report.precondition_failure.map(PreconditionStatus::from),
            error: None,
        }
    }

    fn error(root: &Path, sequence: u64, error: String, state: &WatchState) -> Self {
        Self {
            schema_version: PROTOCOL_VERSION,
            kind: "snapshot",
            sequence,
            root: root.to_owned(),
            line_base: 1,
            status: Status::Error,
            full_update: true,
            updated_paths: Vec::new(),
            diagnostics: state.all_diagnostics(),
            stats: None,
            precondition: None,
            error: Some(error),
        }
    }
}

impl From<Violation> for Diagnostic {
    fn from(value: Violation) -> Self {
        Self {
            path: value.path,
            rule_id: value.rule_id,
            rule_path: value.rule_path,
            message: value.message,
            severity: value.severity,
            confidence: value.confidence,
            regions: value
                .regions
                .into_iter()
                .map(|region| Region {
                    start_line: region.start,
                    end_line: region.end,
                })
                .collect(),
        }
    }
}

impl From<PreconditionFailure> for PreconditionStatus {
    fn from(value: PreconditionFailure) -> Self {
        Self {
            command: value.command,
            exit_code: value.status,
            output: value.output,
            skipped_files: value.files,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RuleSet;

    #[tokio::test]
    async fn atomically_writes_a_machine_readable_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state/diagnostics.json");
        write_snapshot(
            path.clone(),
            Snapshot::error(
                directory.path(),
                7,
                "temporary failure".into(),
                &WatchState::default(),
            ),
        )
        .await
        .unwrap();

        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["kind"], "snapshot");
        assert_eq!(value["sequence"], 7);
        assert_eq!(value["status"], "error");
        assert_eq!(value["diagnostics"], serde_json::json!([]));
        assert_eq!(value["full_update"], true);
    }

    #[test]
    fn file_result_contains_only_its_file() {
        let file = FileProgress {
            path: "src/a.ts".into(),
            api_requests: 1,
            cache_hits: 0,
            violations: vec![Violation {
                path: "src/a.ts".into(),
                rule_id: "rule".into(),
                rule_path: ".nllint-rules/rule.md".into(),
                message: "Rule".into(),
                confidence: 0.9,
                severity: Severity::Error,
                regions: Vec::new(),
            }],
        };
        let value = serde_json::to_value(FileResult::new(Path::new("/project"), 3, &file)).unwrap();
        assert_eq!(value["kind"], "file_result");
        assert_eq!(value["path"], "src/a.ts");
        assert_eq!(value["diagnostics"][0]["path"], "src/a.ts");
    }

    #[test]
    fn watches_sources_and_linter_inputs_but_not_cache_files() {
        let root = Path::new("/project");
        let config_path = root.join(".nllintrc.jsonc");
        let config = Config {
            rule_sets: vec![RuleSet {
                patterns: vec!["**/*.ts".into()],
                exclude: Vec::new(),
                error: BTreeMap::from([("security".into(), 0.8)]),
                warn: BTreeMap::new(),
            }],
            ..Config::default()
        };
        let options = WatchOptions {
            snapshot_file: None,
            stdout: true,
            stream: false,
        };

        assert!(
            is_relevant(
                root,
                &config_path,
                &config,
                &options,
                &[root.join("src/app.ts")]
            )
            .unwrap()
        );
        assert!(
            is_relevant(
                root,
                &config_path,
                &config,
                &options,
                &[root.join(".nllint-rules/security.md")]
            )
            .unwrap()
        );
        assert!(
            !is_relevant(
                root,
                &config_path,
                &config,
                &options,
                &[root.join(".nllint/cache.redb")]
            )
            .unwrap()
        );
    }

    #[test]
    fn partial_snapshot_preserves_unaffected_diagnostics() {
        let root = Path::new("/project");
        let mut state = WatchState::default();
        let violation = |path: &str| Violation {
            path: PathBuf::from(path),
            rule_id: "rule".into(),
            rule_path: ".nllint-rules/rule.md".into(),
            message: "Rule message".into(),
            confidence: 0.9,
            severity: Severity::Error,
            regions: Vec::new(),
        };
        let report = |violations| RunReport {
            files_checked: 2,
            rules: 1,
            api_requests: 0,
            cache_hits: 2,
            violations,
            precondition_failure: None,
        };

        Snapshot::from_report(
            root,
            1,
            report(vec![violation("a.ts"), violation("b.ts")]),
            vec!["a.ts".into(), "b.ts".into()],
            true,
            &mut state,
        );
        let partial = Snapshot::from_report(
            root,
            2,
            report(Vec::new()),
            vec!["a.ts".into()],
            false,
            &mut state,
        );

        assert_eq!(partial.updated_paths, vec![PathBuf::from("a.ts")]);
        assert_eq!(partial.diagnostics.len(), 1);
        assert_eq!(partial.diagnostics[0].path, Path::new("b.ts"));
    }
}
