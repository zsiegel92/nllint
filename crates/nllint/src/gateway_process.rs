use std::{
    fs::File,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Context;

pub async fn serve(detach: bool) -> anyhow::Result<i32> {
    let gateway = std::env::var_os("NLLINT_GATEWAY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../gateway"));
    let gateway = gateway
        .canonicalize()
        .context("set NLLINT_GATEWAY_DIR to the gateway checkout")?;
    let mut command = Command::new("uv");
    command.current_dir(&gateway).args(["run", "--locked"]);
    if let Some(path) = std::env::var_os("NLLINT_ENV_FILE").filter(|path| !path.is_empty()) {
        command.arg("--env-file").arg(std::path::absolute(path)?);
    } else if let Some(path) = gateway
        .parent()
        .map(|root| root.join(".env"))
        .filter(|path| path.is_file())
    {
        command.arg("--env-file").arg(path);
    }
    let host = std::env::var("NLLINT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("NLLINT_PORT").unwrap_or_else(|_| "8080".into());
    command.args([
        "uvicorn",
        "nllint_gateway.main:app",
        "--host",
        &host,
        "--port",
        &port,
    ]);
    if !detach {
        build_web(&gateway, None)?;
        return Ok(command.status()?.code().unwrap_or(1));
    }
    detached::start(command, &gateway, &host, &port).await
}

fn build_web(gateway: &Path, log: Option<&File>) -> anyhow::Result<()> {
    for args in [&["ci", "--no-audit", "--no-fund"][..], &["run", "build"]] {
        let mut command = Command::new("npm");
        command
            .current_dir(gateway)
            .args(["--prefix", "web"])
            .args(args);
        if let Some(log) = log {
            command.stdout(log.try_clone()?).stderr(log.try_clone()?);
        }
        anyhow::ensure!(command.status()?.success(), "npm {} failed", args.join(" "));
    }
    Ok(())
}

pub async fn stop() -> anyhow::Result<i32> {
    detached::stop().await
}

#[cfg(not(unix))]
mod detached {
    pub async fn start(
        _: std::process::Command,
        _: &std::path::Path,
        _: &str,
        _: &str,
    ) -> anyhow::Result<i32> {
        anyhow::bail!("detached gateway startup requires Unix")
    }

    pub async fn stop() -> anyhow::Result<i32> {
        anyhow::bail!("stopping a detached gateway requires Unix")
    }
}

#[cfg(unix)]
mod detached {
    use std::{
        fs::{self, File, OpenOptions},
        io::{self, Write},
        os::unix::process::CommandExt,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use anyhow::{Context, ensure};
    use serde::{Deserialize, Serialize};
    use tokio::time::{Instant, sleep};

    const POLL_INTERVAL: Duration = Duration::from_millis(250);
    const STOP_TIMEOUT: Duration = Duration::from_secs(15);

    #[derive(Deserialize, Serialize)]
    struct GatewayProcess {
        pid: i32,
        started: String,
    }

    struct RunDirectory {
        path: PathBuf,
        _lock: File,
    }

    impl RunDirectory {
        fn lock() -> anyhow::Result<Self> {
            let path = nllint::config::config_home().join("run");
            fs::create_dir_all(&path)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path.join("gateway.lock"))?;
            lock.try_lock()
                .context("another gateway lifecycle command is running")?;
            Ok(Self { path, _lock: lock })
        }

        fn state_path(&self) -> PathBuf {
            self.path.join("gateway-process.json")
        }

        fn current(&self) -> anyhow::Result<Option<GatewayProcess>> {
            let state = match fs::read(self.state_path()) {
                Ok(bytes) => serde_json::from_slice::<GatewayProcess>(&bytes)
                    .context("invalid gateway process record")?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            ensure!(
                state.pid > 1 && !state.started.is_empty(),
                "invalid gateway process record"
            );
            if process_start(state.pid)?.as_ref() == Some(&state.started) {
                return Ok(Some(state));
            }
            self.clear()?;
            Ok(None)
        }

        fn save(&self, process: &GatewayProcess) -> anyhow::Result<()> {
            let mut file = tempfile::NamedTempFile::new_in(&self.path)?;
            serde_json::to_writer(&mut file, process)?;
            file.flush()?;
            file.persist(self.state_path())?;
            Ok(())
        }

        fn clear(&self) -> io::Result<()> {
            match fs::remove_file(self.state_path()) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result,
            }
        }
    }

    pub async fn start(
        mut command: Command,
        gateway: &Path,
        host: &str,
        port: &str,
    ) -> anyhow::Result<i32> {
        let run = RunDirectory::lock()?;
        if let Some(gateway) = run.current()? {
            anyhow::bail!(
                "gateway is already running (PID {}); use nllint stop first",
                gateway.pid
            );
        }
        let url = gateway_url(host, port);
        let health_url = format!("{url}/healthz");
        let probe = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()?;
        let log_path = run.path.join("gateway.log");
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        super::build_web(gateway, Some(&log))
            .with_context(|| format!("see {}", log_path.display()))?;
        let launch_id = nllint::hash::key(
            "launch",
            &(
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
            ),
        )?;
        let mut child = command
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .process_group(0)
            .env("NLLINT_LAUNCH_ID", &launch_id)
            .spawn()?;
        let pid = i32::try_from(child.id())?;
        let result = async {
            let started = process_start(pid)?.with_context(|| {
                format!(
                    "gateway launcher exited before startup; see {}",
                    log_path.display()
                )
            })?;
            run.save(&GatewayProcess { pid, started })?;
            wait_ready(&mut child, &probe, &health_url, &launch_id, &log_path).await
        }
        .await;
        if let Err(error) = result {
            if child.try_wait()?.is_none() {
                terminate_group(pid)?;
                wait_stopped(pid).await?;
            }
            run.clear()?;
            return Err(error);
        }
        println!("Gateway ready at {url}");
        println!("Gateway launcher PID {pid}. Log {}", log_path.display());
        Ok(0)
    }

    async fn wait_ready(
        child: &mut std::process::Child,
        probe: &reqwest::Client,
        health_url: &str,
        launch_id: &str,
        log_path: &Path,
    ) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                anyhow::bail!(
                    "gateway launcher exited ({status}); see {}",
                    log_path.display()
                );
            }
            if let Ok(response) = probe.get(health_url).send().await
                && let Ok(status) = response.error_for_status()
                && let Ok(status) = status.json::<serde_json::Value>().await
                && status.get("launch_id").and_then(|value| value.as_str()) == Some(launch_id)
            {
                return Ok(());
            }
            sleep(POLL_INTERVAL).await;
        }
        anyhow::bail!(
            "gateway launcher did not report readiness; see {}",
            log_path.display()
        )
    }

    pub async fn stop() -> anyhow::Result<i32> {
        let run = RunDirectory::lock()?;
        let Some(gateway) = run.current()? else {
            println!("No managed detached gateway is running.");
            return Ok(0);
        };
        terminate_group(gateway.pid)?;
        wait_stopped(gateway.pid).await?;
        run.clear()?;
        println!("Stopped gateway (PID {}).", gateway.pid);
        Ok(0)
    }

    fn process_start(pid: i32) -> anyhow::Result<Option<String>> {
        let output = Command::new("ps")
            .args([
                "-p",
                &pid.to_string(),
                "-o",
                "pgid=",
                "-o",
                "stat=",
                "-o",
                "lstart=",
            ])
            .env("LC_ALL", "C")
            .output()?;
        let stdout = String::from_utf8(output.stdout)?;
        if output.status.code() == Some(1) && stdout.trim().is_empty() && output.stderr.is_empty() {
            return Ok(None);
        }
        ensure!(
            output.status.success(),
            "could not inspect gateway launcher PID {pid}"
        );
        let mut fields = stdout.split_whitespace();
        let group = fields.next().and_then(|value| value.parse::<i32>().ok());
        let status = fields.next().unwrap_or_default();
        let started = fields.collect::<Vec<_>>().join(" ");
        Ok((group == Some(pid)
            && !status.is_empty()
            && !status.starts_with('Z')
            && !started.is_empty())
        .then_some(started))
    }

    fn terminate_group(pid: i32) -> io::Result<()> {
        // The caller verified that the recorded process is the group leader.
        if unsafe { libc::kill(-pid, libc::SIGTERM) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(error)
    }

    async fn wait_stopped(pid: i32) -> anyhow::Result<()> {
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            let output = Command::new("ps")
                .args(["-A", "-o", "pgid=", "-o", "stat="])
                .output()?;
            ensure!(
                output.status.success(),
                "could not inspect gateway process group {pid}"
            );
            let running = String::from_utf8(output.stdout)?.lines().any(|line| {
                let mut fields = line.split_whitespace();
                fields.next().and_then(|value| value.parse::<i32>().ok()) == Some(pid)
                    && fields.next().is_some_and(|status| !status.starts_with('Z'))
            });
            if !running {
                return Ok(());
            }
            sleep(POLL_INTERVAL).await;
        }
        anyhow::bail!("gateway process group {pid} did not exit after SIGTERM")
    }

    fn gateway_url(host: &str, port: &str) -> String {
        let connect_host = match host {
            "0.0.0.0" => "127.0.0.1".to_owned(),
            "::" => "[::1]".to_owned(),
            ipv6 if ipv6.contains(':') && !ipv6.starts_with('[') => format!("[{ipv6}]"),
            _ => host.to_owned(),
        };
        format!("http://{connect_host}:{port}")
    }
}
