use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone)]
pub struct Cache {
    database: Arc<Mutex<Connection>>,
}

impl Cache {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let path = path.to_owned();
        let database = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let connection = Connection::open(path)?;
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, value BLOB NOT NULL);",
            )?;
            Ok(connection)
        })
        .await??;
        Ok(Self {
            database: Arc::new(Mutex::new(database)),
        })
    }

    pub async fn get_many<T>(&self, keys: Vec<String>) -> anyhow::Result<Vec<Option<T>>>
    where
        T: DeserializeOwned + Send + 'static,
    {
        let database = Arc::clone(&self.database);
        tokio::task::spawn_blocking(move || {
            let connection = database
                .lock()
                .map_err(|_| anyhow::anyhow!("cache lock poisoned"))?;
            let mut query = connection.prepare_cached("SELECT value FROM results WHERE key=?1")?;
            keys.iter()
                .map(|key| {
                    let value: Option<Vec<u8>> =
                        query.query_row([key], |row| row.get(0)).optional()?;
                    value
                        .map(|bytes| serde_json::from_slice(&bytes).context("invalid cached value"))
                        .transpose()
                })
                .collect()
        })
        .await?
    }

    pub async fn put_many<T>(&self, values: Vec<(String, T)>) -> anyhow::Result<()>
    where
        T: Serialize + Send + 'static,
    {
        let database = Arc::clone(&self.database);
        tokio::task::spawn_blocking(move || {
            let serialized = values.into_iter()
                .map(|(key, value)| Ok((key, serde_json::to_vec(&value)?)))
                .collect::<anyhow::Result<Vec<_>>>()?;
            let mut connection = database.lock().map_err(|_| anyhow::anyhow!("cache lock poisoned"))?;
            let transaction = connection.transaction()?;
            {
                let mut query = transaction.prepare_cached(
                    "INSERT INTO results(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                )?;
                for (key, value) in serialized {
                    query.execute(params![key, value])?;
                }
            }
            transaction.commit()?;
            Ok(())
        }).await?
    }
}
