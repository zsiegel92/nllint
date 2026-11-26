use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    cache::Cache,
    config::{self, Config},
    engine::LineRegion,
    hash, request_limit,
    rule::Rule,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct RuleAnswer {
    pub rule_id: String,
    #[serde(default)]
    pub pair_id: Option<i64>,
    pub ranges: Vec<Finding>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Finding {
    #[serde(flatten)]
    pub region: LineRegion,
    pub confidence: f64,
}

type PairIdentity = [String; 5];

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct SyncState {
    pub version: String,
    #[serde(default)]
    pub pair_ids: Option<bool>,
    cursor: i64,
    #[serde(default)]
    fetched: u64,
    #[serde(default)]
    changes: Vec<Change>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Change {
    identity: PairIdentity,
    revision: i64,
}

impl SyncState {
    pub fn revision(&self, identity: &PairIdentity) -> i64 {
        self.changes
            .binary_search_by(|change| change.identity.cmp(identity))
            .map_or(0, |index| self.changes[index].revision)
    }
}

#[derive(Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    #[serde(rename = "$schema")]
    schema: Option<String>,
    gateway_base_url: Option<String>,
    gateway_api_key: Option<String>,
}

#[derive(Debug)]
pub struct VersionChanged;

impl std::fmt::Display for VersionChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "gateway version changed during linting")
    }
}

impl std::error::Error for VersionChanged {}

pub struct Gateway {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    pub project: String,
    pub namespace: String,
}

impl Gateway {
    pub async fn from_config(config: &Config, root: &Path) -> anyhow::Result<Self> {
        let path = config::config_home().join("config.json");
        let saved: Credentials = match tokio::fs::read_to_string(path).await {
            Ok(text) => serde_json::from_str(&text).context("invalid nllint config.json")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Credentials::default(),
            Err(error) => return Err(error.into()),
        };
        let required = |name, fallback: Option<String>| {
            std::env::var(name)
                .ok()
                .filter(|text| !text.trim().is_empty())
                .or(fallback)
                .filter(|text| !text.trim().is_empty())
                .with_context(|| format!("set {name} or configure nllint config.json"))
        };
        let base_url = required("NLLINT_GATEWAY_BASE_URL", saved.gateway_base_url)?;
        let base_url = base_url.trim_end_matches('/').to_owned();
        let url = url::Url::parse(&base_url)?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "invalid gateway base URL"
        );
        let api_key = required("NLLINT_GATEWAY_API_KEY", saved.gateway_api_key)?;
        let project = config.project_id.clone().unwrap_or_else(|| {
            let name = root.file_name().unwrap_or_default().to_string_lossy();
            let digest = hash::bytes(root.to_string_lossy().as_bytes());
            format!("{name}-{}", &digest[..12])
        });
        let namespace = hash::key("gateway", &(&base_url, &api_key, &project))?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(config.request_timeout())
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base_url,
            api_key,
            project,
            namespace,
        })
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> anyhow::Result<T> {
        let _permit = request_limit::acquire().await?;
        let response = request
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("gateway request failed")?
            .error_for_status()?;
        response
            .json()
            .await
            .context("invalid response from nllint gateway")
    }

    pub async fn sync(&self, cache: &Cache, interval: u64) -> anyhow::Result<SyncState> {
        let key = format!("sync:{}", self.namespace);
        let mut state: SyncState = cache
            .get_many(vec![key.clone()])
            .await?
            .pop()
            .flatten()
            .unwrap_or_default();
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if !state.version.is_empty()
            && state.pair_ids.is_some()
            && now.saturating_sub(state.fetched) < interval
        {
            return Ok(state);
        }
        let delta: SyncState = match self
            .request(self.http.get(format!("{}/v1/sync", self.base_url)).query(&[
                ("project", self.project.as_str()),
                ("cursor", &state.cursor.to_string()),
            ]))
            .await
        {
            Ok(delta) => delta,
            Err(error) if !state.version.is_empty() && is_transient(&error) => {
                eprintln!("nllint: gateway sync unavailable; using previously cached metadata");
                return Ok(state);
            }
            Err(error) => return Err(error),
        };
        if delta.cursor < state.cursor {
            state.changes.clear();
        }
        state.version = delta.version;
        state.pair_ids = Some(delta.pair_ids.unwrap_or(false));
        state.cursor = delta.cursor;
        state.changes.extend(delta.changes);
        state.changes.sort_by(|left, right| {
            left.identity
                .cmp(&right.identity)
                .then(right.revision.cmp(&left.revision))
        });
        state
            .changes
            .dedup_by(|left, right| left.identity == right.identity);
        state.fetched = now;
        cache.put_many(vec![(key, state.clone())]).await?;
        Ok(state)
    }

    pub async fn lint(
        &self,
        prompt: &str,
        path: &str,
        source: &str,
        rules: &[(&Rule, String)],
        expected_version: &str,
    ) -> anyhow::Result<Vec<RuleAnswer>> {
        #[derive(Deserialize)]
        struct Status {
            id: String,
            status: String,
            version: String,
            results: Option<Vec<RuleAnswer>>,
        }
        let url = format!("{}/v1/lint", self.base_url);
        let mut state: Status = self
            .request(self.http.post(&url).json(&json!({
                "project": self.project, "path": path, "source": source, "prompt": prompt,
                "rules": rules.iter().map(|(rule, path)| json!({
                    "id": rule.id, "path": path, "text": rule.markdown
                })).collect::<Vec<_>>(),
            })))
            .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
        let mut delay = Duration::from_millis(500);
        loop {
            if state.version != expected_version {
                return Err(VersionChanged.into());
            }
            match state.status.as_str() {
                "ready" => return state.results.context("gateway omitted results"),
                "pending" => (),
                _ => anyhow::bail!(
                    "gateway job {} failed; open its trace for details",
                    state.id
                ),
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "gateway job {} timed out",
                state.id
            );
            ensure!(
                state.id.len() == 32 && state.id.bytes().all(|c| c.is_ascii_hexdigit()),
                "invalid gateway job ID"
            );
            tokio::time::sleep(delay).await;
            match self
                .request(self.http.get(format!("{url}/{}", state.id)))
                .await
            {
                Ok(result) => state = result,
                Err(error) if is_transient(&error) => (),
                Err(error) => return Err(error),
            }
            delay = (delay * 2).min(Duration::from_secs(5));
        }
    }
}

fn is_transient(error: &anyhow::Error) -> bool {
    error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
        error.is_connect()
            || error.is_timeout()
            || error
                .status()
                .is_some_and(|status| status.is_server_error() || status.as_u16() == 429)
    })
}
