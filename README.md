# NLLint

NLLint applies Markdown lint rules to a project's source code. The Rust CLI and VS Code extension share project settings and a file–rule cache. The FastAPI gateway runs the lint pipeline and serves a web app for review.

## Start the gateway

Prepare Postgres and configure provider credentials and sign-in using the [self-hosting guide](docs/self-hosting.md). It includes setup for Modal and a standalone FastAPI deployment. For loopback development, copy `.env.example` to `.env` in the repo root and fill in the values. The guide shows how to use a local token.

```sh
cargo run --locked -p nllint -- serve
# After installing the CLI
nllint serve
nllint serve -d
nllint stop
```

Open `http://localhost:8080`. The detached command waits for readiness and prints the launcher PID and log path. Run `nllint stop` to shut down a gateway started with `nllint serve -d`. The launcher passes the repo-root `.env` to `uv run --env-file`. Set `NLLINT_ENV_FILE` to use a different file. `NLLINT_HOST` and `NLLINT_PORT` configure the launcher. Set `NLLINT_GATEWAY_DIR` if the installed binary's source checkout has moved.

## Configure a client

Install the binary with `./install-to-path.sh`, or build locally with `cargo build --locked`. In the gateway, go to **API keys**, create a key, and copy its secret. Set `NLLINT_GATEWAY_BASE_URL` and `NLLINT_GATEWAY_API_KEY` in the client environment. You can also save them in `~/.config/nllint/config.json`:

```json
{
  "$schema": "file:///absolute/path/to/nl-lint/schema/credentials.schema.json",
  "gateway_base_url": "http://localhost:8080",
  "gateway_api_key": "nllint_..."
}
```

Use `nllint init` inside a repo. It creates `.nllintrc.jsonc` and a starter Markdown rule. Edit the rule and its `rule_sets` globs and severity. Thresholds apply to adjudicated range confidence. An explicit human-positive range has confidence 1. Prefix a source-line comment with `nllint-ignore` to suppress diagnostics on that line.

To keep settings outside a repo, place this in `~/.config/nllint/projects/my-app/settings.jsonc` and put `my-rule.md` under `rules/` beside it:

```jsonc
{
  "$schema": "file:///absolute/path/to/nl-lint/schema/nllint.schema.json",
  "project_root": "/absolute/path/to/my-app",
  "project_id": "my-app",
  "rules_dir": "rules",
  "rule_sets": [{ "match": ["src/**/*.ts"], "warn": { "my-rule": 0.8 } }]
}
```

The CLI and IDE prefer in-repo settings. External settings are selected by an exact canonical project root match. If no project settings match, NLLint skips the project. Set the same `project_id` on worktrees or machines that should share gateway history for a project. The default identifies a local checkout. Config lookup respects `XDG_CONFIG_HOME`.

```sh
nllint --dry-run
nllint
nllint --json
nllint --json --file src/parser.py --file src/validator.py
nllint watch --stream
nllint --include-git-ignored
```

Repeat `--file` to check selected project-relative files. Project selectors and ignore rules still apply.

`include_git_ignored` enables ignored files for a particular project. Configured glob exclusions still apply. `--force-fresh` bypasses the local cache for that invocation. The gateway can still return work from its own cache.

Build and install the [VS Code extension](ide-extension/README.md) with `make ide-install`. Install the [NLLint skill](skills/nllint/SKILL.md) with `./install-skill.sh`.

## Review results and tune rules

Open **Traces** to review recorded lint requests. Each row is a file snapshot, and each rule cell is a run. The pipeline first checks the file, then suggests candidate ranges and checks each candidate. Use **Find** to look for missed ranges, rejected candidates, or disagreements.

- Open **File decisions** to mark whether the file violates the rule. If the pipeline missed a violation, **Find and annotate ranges** starts range processing immediately. Otherwise it starts after the configured delay.
- Open **Ranges** to review a span in the file. Use **Add range** and drag in the gutter to annotate lines the pipeline missed. The CLI and VS Code pick up annotations on their next sync.
- Run an **Agent labeler** for a second opinion. Compare its saved result with the pipeline or an annotation. Save a file or range annotation to apply a correction to diagnostics.
- Use **Export JSONL** to download records for the current project, API key, rule, or trace, or for the runs you selected. Open **Build eval set** to add page matches and save an evaluation set with fixed expected answers. To compare rule revisions, rerun lint on the same files and open **Evaluation sets**.

Use **Projects** to configure the models that process future lint requests or to include rule history from another project. See the [REST and MCP guide](docs/api.md) for integrations and the [gateway design](docs/gateway.md) for pipeline and cache behavior.

## Development

Run `make help` for the complete command list. The most common configurations are:

| Configuration | Command |
| --- | --- |
| Vite and local FastAPI, both with reload | `make dev` |
| Vite and local FastAPI in separate terminals | `make api-dev` and `make web-dev` |
| Built frontend and local FastAPI | `make serve` |
| Built frontend and a temporary Modal server | `make modal-serve` |
| Vite and a temporary Modal backend | `make modal-api`, then `make web-dev BACKEND_URL=https://…` with its printed URL |
| Vite and an already deployed backend | `make web-dev BACKEND_URL=https://…` |
| Deploy to Modal | `make deploy` or `make deploy-api` |
| Local detached gateway | `make daemon-start`, `make daemon-stop`, and `make daemon-restart` |

Vite defaults to [localhost:5175](http://localhost:5175) and FastAPI defaults to port 8080. Use `ENV_FILE`, `API_PORT`, and `WEB_PORT` to override those settings. If you change the local backend port, update `NLLINT_APP_URL` and the GitHub callback to match. For Vite against a hosted gateway, set `NLLINT_REMOTE_DEV_ORIGIN=http://localhost:5175` on the gateway to enable sign-in from that origin. Keep the GitHub callback registered at the gateway's HTTPS URL.

- `make db-migrate` applies the schema using `DATABASE_MIGRATION_URL`. `make db-check` verifies the runtime connection from `DATABASE_URL`.
- `make cli-build` and `make cli-release` compile the Rust CLI. `make cli-install` installs it. Use `make cli-run ARGS="--dry-run"` or `make cli-watch ARGS="--stream"` to pass flags through.
- `make test` runs Rust, gateway, and extension tests. Set `NLLINT_TEST_DATABASE_URL` in your shell to include Postgres integration tests against a disposable database with the gateway schema. Use `make check` for Rust and Python static checks.

Regenerate config schemas after changing the Rust settings types:

```sh
cargo run -q -p nllint -- schema --output schema/nllint.schema.json
cargo run -q -p nllint -- schema --credentials --output schema/credentials.schema.json
```
