mod gateway_process;

use std::{
    ffi::OsStr,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, ensure};
use clap::{Parser, Subcommand};
use nllint::{
    Config, Engine,
    config::{self, PROJECT_SETTINGS},
    files,
    gateway::{Credentials, Gateway},
    report,
    watch::{self, WatchOptions},
};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    include_git_ignored: bool,
    #[arg(long)]
    dry_run: bool,
    /// Print a one-shot check as structured JSON instead of human-readable text.
    #[arg(long)]
    json: bool,
    /// Stream file findings before the final report or watch snapshot.
    #[arg(long, global = true)]
    stream: bool,
    /// Ignore cached results for this check without changing the project's cache.
    #[arg(long)]
    force_fresh: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the local FastAPI gateway and built control plane.
    Serve {
        #[arg(short = 'd', long)]
        detach: bool,
    },
    /// Stop the local gateway started by serve --detach.
    Stop,
    /// Print the discovered project settings path, if configured.
    ConfigPath,

    /// Create a starter JSONC config, prompt, and rule in the current project.
    Init,
    /// Print the JSON Schema derived from the Rust config types.
    Schema {
        /// Write the schema to this path instead of stdout.
        #[arg(long)]
        output: Option<PathBuf>,
        #[arg(long)]
        credentials: bool,
    },
    /// Watch the project and emit complete diagnostic snapshots as JSON Lines.
    Watch {
        /// Atomically replace this file with the latest JSON snapshot.
        #[arg(long)]
        output: Option<PathBuf>,
        /// Write snapshots only to --output, not standard output.
        #[arg(long)]
        no_stdout: bool,
    },
}

#[tokio::main]
async fn main() {
    let status = match run().await {
        Ok(status) => status,
        Err(error) => {
            eprintln!("nllint: {error:#}");
            2
        }
    };
    std::process::exit(status);
}

async fn run() -> anyhow::Result<i32> {
    let cli = Cli::parse();
    let explicit = cli.config.as_deref().map(absolute).transpose()?;
    let config_path = match &cli.command {
        Some(Command::Serve { .. } | Command::Stop | Command::Schema { .. }) => None,
        Some(Command::Init) => Some(explicit.unwrap_or(absolute(Path::new(PROJECT_SETTINGS))?)),
        _ => match explicit {
            Some(path) => Some(path),
            None => config::discover(&std::env::current_dir()?).await?,
        },
    };
    match cli.command {
        Some(Command::Serve { detach }) => gateway_process::serve(detach).await,
        Some(Command::Stop) => gateway_process::stop().await,
        Some(Command::ConfigPath) => {
            if let Some(path) = config_path {
                println!("{}", path.display());
            }
            Ok(0)
        }

        Some(Command::Init) => {
            ensure!(!cli.json, "--json is only valid for one-shot checks");
            ensure!(!cli.stream, "--stream is only valid for checks and watch");
            ensure!(
                !cli.force_fresh,
                "--force-fresh is only valid for one-shot checks"
            );
            init(&config_path.context("missing project settings path")?)?;
            Ok(0)
        }
        Some(Command::Schema {
            output,
            credentials,
        }) => {
            ensure!(!cli.json, "--json is only valid for one-shot checks");
            ensure!(!cli.stream, "--stream is only valid for checks and watch");
            ensure!(
                !cli.force_fresh,
                "--force-fresh is only valid for one-shot checks"
            );
            schema(output.as_deref(), credentials)?;
            Ok(0)
        }
        Some(Command::Watch { output, no_stdout }) => {
            ensure!(!cli.json, "watch already emits JSON Lines");
            ensure!(
                !cli.force_fresh,
                "--force-fresh is only valid for one-shot checks"
            );
            ensure!(!cli.dry_run, "--dry-run cannot be used with watch");
            ensure!(!cli.stream || !no_stdout, "--stream requires stdout");
            ensure!(
                output.is_some() || !no_stdout,
                "watch needs stdout or --output"
            );
            let Some(config_path) = config_path else {
                return Ok(0);
            };
            watch::run(
                config_path,
                cli.include_git_ignored,
                WatchOptions {
                    snapshot_file: output.map(|path| absolute(&path)).transpose()?,
                    stdout: !no_stdout,
                    stream: cli.stream,
                },
            )
            .await?;
            Ok(0)
        }
        None => {
            let Some(config_path) = config_path else {
                if cli.json {
                    println!(
                        "{}",
                        serde_json::json!({"files_checked":0,"rules":0,"api_requests":0,"cache_hits":0,"violations":[],"precondition_failure":null})
                    );
                } else {
                    eprintln!("nllint: no settings for this project");
                }
                return Ok(0);
            };
            check(
                config_path,
                cli.include_git_ignored,
                cli.dry_run,
                cli.json,
                cli.stream,
                cli.force_fresh,
            )
            .await
        }
    }
}

fn schema(output: Option<&Path>, credentials: bool) -> anyhow::Result<()> {
    let schema = if credentials {
        schemars::schema_for!(Credentials)
    } else {
        schemars::schema_for!(Config)
    };
    let value = serde_json::to_string_pretty(&schema)?;
    match output {
        Some(path) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, format!("{value}\n"))?;
        }
        None => println!("{value}"),
    }
    Ok(())
}

fn init(path: &Path) -> anyhow::Result<()> {
    ensure!(
        path.extension() == Some(OsStr::new("jsonc")),
        "config path must end in .jsonc: {}",
        path.display()
    );
    let old_path = path.with_extension("json");
    ensure!(
        !old_path.exists(),
        "rename {} to {} before running init",
        old_path.display(),
        path.display()
    );
    let root = path.parent().context("config path has no parent")?;
    let mut config = Config::default();
    config.rule_sets = vec![nllint::config::RuleSet {
        patterns: vec!["*.rs".into(), "**/*.rs".into()],
        exclude: Vec::new(),
        error: [("example-rule".into(), 0.8)].into(),
        warn: Default::default(),
    }];
    let schema_path = std::env::current_exe()?
        .parent()
        .and_then(Path::parent)
        .map(|parent| parent.join("share/nllint/nllint.schema.json"));
    let schema_path = schema_path.filter(|path| path.is_file()).or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../schema/nllint.schema.json")
            .canonicalize()
            .ok()
    });
    if let Some(schema_path) = schema_path {
        config.schema = Some(
            url::Url::from_file_path(schema_path)
                .map_err(|_| anyhow::anyhow!("invalid installed schema path"))?
                .to_string(),
        );
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("cannot create {} (it may already exist)", path.display()))?;
    writeln!(file, "{}", serde_json::to_string_pretty(&config)?)?;
    let rules_dir = root.join(&config.rules_dir);
    std::fs::create_dir_all(&rules_dir)?;
    create_if_absent(
        &root.join(&config.system_prompt),
        "You are a conservative semantic code linter. Report only clear violations visible in the supplied file.\n",
    )?;
    create_if_absent(
        &rules_dir.join("example-rule.md"),
        "# Example rule\n\nDescribe the issue here.\n\n---\n\nWrite detailed instructions for the model here.\n",
    )?;
    println!("Created {}", path.display());
    Ok(())
}

fn create_if_absent(path: &Path, content: &str) -> anyhow::Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(content.as_bytes())?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn check(
    config_path: PathBuf,
    include_git_ignored: bool,
    dry_run: bool,
    json: bool,
    stream: bool,
    force_fresh: bool,
) -> anyhow::Result<i32> {
    ensure!(!dry_run || !json, "--dry-run and --json cannot be combined");
    ensure!(
        !dry_run || !stream,
        "--dry-run and --stream cannot be combined"
    );
    ensure!(!json || !stream, "--json and --stream cannot be combined");
    ensure!(
        !dry_run || !force_fresh,
        "--dry-run and --force-fresh cannot be combined"
    );
    let (root, mut config) = config::load_project(&config_path).await?;
    config.include_git_ignored |= include_git_ignored;
    if dry_run {
        let selected = files::discover(&root, &config)?;
        println!("nllint: would lint {} files", selected.len());
        for path in selected {
            println!("{}", path.display());
        }
        return Ok(0);
    }
    let temporary_cache = force_fresh.then(tempfile::tempdir).transpose()?;
    if let Some(directory) = &temporary_cache {
        config.cache_dir = directory.path().to_path_buf();
    }
    let provider = Arc::new(Gateway::from_config(&config, &root).await?);
    let engine = Engine::new(root, config, provider);
    let result = if stream {
        engine
            .run_with_progress(|file| {
                let stdout = std::io::stdout();
                let mut output = stdout.lock();
                report::print_violations(&file.violations, &mut output)?;
                output.flush()?;
                Ok(())
            })
            .await?
    } else {
        engine.run().await?
    };
    if json {
        println!("{}", serde_json::to_string(&result)?);
    } else if stream && result.precondition_failure.is_none() {
        report::print_summary(&result, std::io::stdout())?;
    } else {
        report::print(&result, std::io::stdout(), std::io::stderr())?;
    }
    Ok(
        if result.precondition_failure.is_some() || result.has_errors() {
            1
        } else {
            0
        },
    )
}

fn absolute(path: &Path) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
