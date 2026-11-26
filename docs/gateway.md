# Gateway pipeline

The Rust client sends one file and the rules with local cache misses. It polls pending results with backoff. Each result contains one entry per submitted rule, with 1-based inclusive line ranges and adjudication confidence.

| Route | Purpose |
| --- | --- |
| `POST /v1/lint` | Submit a project-relative file path, UTF-8 source, optional project prompt, and rules with IDs, relative paths, and Markdown text. |
| `GET /v1/lint/{id}` | Poll the trace. A pending response uses HTTP 202. A terminal response is ready or failed. |
| `GET /v1/sync?project=…&cursor=…` | Return the processing version and changed file–rule annotation revisions for this API key and project. |
| `GET /api/rules` | Search stored rule versions and their positive counts as a signed-in operator. |
| `GET /api/runs/{id}/provider-requests` | Read the run’s settings snapshot and upstream requests as a signed-in operator. |
| `/docs` | FastAPI request and operator route reference. |

## Ownership

GitHub user IDs are the owner IDs for application data. Every application transaction supplies the authenticated owner through the database module and assumes a runtime role. RLS and composite foreign keys enforce isolation. Key authentication resolves a secret digest through a narrow lookup function and uses the resulting owner for the entire request.

## Postgres storage

The gateway hashes file, rule, and prompt texts itself. Trace rows record batches, join rows identify their member runs, and question rows record the file decision, range-model invocation, and each adjudication. Range candidates and human range labels have separate rows. A project and relative rule path identify rule history across text revisions. Within one API key, successful model answers are reused across paths and projects when the file, rule, prompt, and processing version match. Paths are kept as trace metadata. Labels target an exact file–rule identity and can survive changes to the gateway's processing version.

Workers batch file questions, persist the mined candidate ranges, and adjudicate each candidate against the rule and full file context. Each stage commits before the next stage. Transactions claim work with row or advisory locks and hold a cluster-wide advisory slot while calling the upstream provider. Postgres notifications wake workers on new jobs. Periodic wakeups also pick up delayed or missed notifications. A separate committed database reservation paces starts for TypeSafe and OpenRouter across all replicas. Failed calls retry with backoff. Operator review can retry a terminal failure. Deferred work stays in Postgres across process restarts.

A positive label on a model-negative file makes the range stage eligible after the debounce. Immediate review advances its deadline on the same row. Changing the label during the debounce can cancel the forced range stage. Once generated, model ranges and adjudications are retained for review.

The local SQLite cache scopes entries to the gateway URL, API key, project, file and rule paths, their content hashes, the optional project prompt, the pipeline version, and the annotation revision. It stores the whole result including empty findings. The client syncs metadata every 300 seconds by default, configurable as `annotation_poll_seconds`. Changing `NLLINT_CACHE_EPOCH` or a project’s effective provider settings changes the version. A queued run keeps its encrypted provider configuration snapshot. Review edits advance a per-key, per-project revision stream and refresh affected file–rule entries after the next sync.

The gateway retains submitted source and rule text in Postgres for review and exports. Source goes to the project’s configured decision provider and OpenRouter-compatible range endpoint. Langfuse records stage observations with rule identifiers and model outputs.


## Projects and API keys

The client sends a project ID with each lint request. Set `project_id` in project settings to use a stable name across checkouts. Without it, the CLI combines the project folder name with a short hash of its canonical path. The gateway creates the project on the first lint. Create it in Pipelines first if you want to configure models beforehand.

API keys authenticate clients. A key can submit work for multiple projects, and a project can receive work from multiple keys. Creating a key does not create a project. A rule history parent includes revisions of matching relative rule paths in the child's Rule history. Rule selection and model routing still come from the project's own settings.

## Rule search and trace rank

The gateway stores the Markdown content and hash submitted with each rule. The Rules picker groups versions by project, client rule ID, relative path, and content hash. Two pieces of Markdown at the same path appear as separate versions when their hashes differ. The counts reflect positive file decisions, candidate ranges, and positive adjudications in the selected project and API-key scope.

Selecting versions shows traces with a positive file decision for any selected version. The default relevance sort adds one point per positive file decision, two per candidate range, and three per positive adjudication across all rule results on the trace. Newer traces break ties. Find presets and ordering strategies are defined separately in the gateway.

## Provider history and usage

Editing a project changes the routing used for future runs. Existing runs reference encrypted, append-only `provider_versions` snapshots. PostgreSQL rejects updates, deletes, and truncation of snapshots and provider history.

Each outbound decision batch, range request, and adjudication batch gets a `provider_requests` row before the call. The gateway appends its outcome and any provider-reported usage in `provider_request_results`, independently of the job transaction, so retries and failed validation do not erase usage. A request with no outcome has unconfirmed usage. Cache hits refer to the original request rather than generating a second usage event.

The **Provider requests** panel shows the recorded settings and usage. It exposes model and tier information while keeping credentials encrypted. For future billing, count each request ID once and use the provider's cost and usage fields where supplied. Runs created before request logging still have their settings snapshot. Historical provider charges cannot be reconstructed from those settings.

## Extension points

An IDE annotation flow can reuse the same range labels and cursor invalidation. It needs a project-scoped client annotation endpoint and an exact diagnostic identity issued by the gateway. The CLI can keep its existing file–rule cache because a label raises that pair’s revision.

Rule identity uses the relative Markdown path, while execution fingerprints use the input texts. A future optimized rule can retain the original path and store both prompt variants, with explicit provenance and a selection in the project configuration. The executed prompt variant belongs in the stage cache identity.
