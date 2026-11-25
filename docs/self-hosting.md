# Self-host NLLint Gateway

The gateway needs a Postgres database, TypeSafe-compatible decision credentials, an OpenRouter key for range generation, and Langfuse credentials. For hosted sign-in, create a GitHub OAuth app and allowlist each user's numeric GitHub account ID.

## Prepare Postgres

Use a dedicated database and its direct or session-mode endpoint. Workers use `LISTEN/NOTIFY` and transaction-scoped advisory locks. Set `DATABASE_MIGRATION_URL` to the migration role DSN and run `make db-migrate` from the repo root. You can also apply the schema directly:

```sh
psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f gateway/nllint_gateway/schema.sql
```

The schema creates a `nllint_runtime` role if needed. Provision a separate database login that can assume this role. For example, run the following in `psql` as your database operator:

```sql
CREATE ROLE nllint_login LOGIN NOINHERIT NOBYPASSRLS;
GRANT nllint_runtime TO nllint_login;
\password nllint_login
```

Use that login's DSN for `DATABASE_URL` and verify it with `make db-check`. Hosted app containers only need the runtime DSN. Each request transaction sets the authenticated user ID locally and assumes the non-owner runtime role. RLS on application tables enforces ownership. Bootstrap and key lookup use narrow database functions. The schema and functions live in [gateway/nllint_gateway/schema.sql](../gateway/nllint_gateway/schema.sql).

## Set secrets and sign-in

Start with the repo-root [.env.example](../.env.example). For local development, run `cp .env.example .env` from the repo root. Generate a session secret with `openssl rand -hex 32` and a Fernet encryption key with:

```sh
openssl rand -base64 32 | tr '/+' '_-'
```

Set `NLLINT_SESSION_SECRET` and `NLLINT_PROVIDER_ENCRYPTION_KEY`. Keep the provider encryption key stable across replicas and deploys because it decrypts saved project routes and the credentials used by queued work.

Set `NLLINT_APP_URL` to the public HTTPS origin. In GitHub, register an OAuth app with that homepage and callback `<origin>/api/session/github/callback`. Use that app's `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and comma-separated `ALLOWED_GITHUB_USER_IDS`. GitHub sessions are scoped to the authenticated account. [GitHub OAuth app authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

Set `TYPESAFE_BASE_URL` when using a custom TypeSafe endpoint. Set `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`. Optionally set `LANGFUSE_BASE_URL` and `LANGFUSE_PROJECT_ID` for a different Langfuse deployment and trace links. The range model must support structured outputs. [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)

For loopback development, leave GitHub settings empty and set `NLLINT_ADMIN_TOKEN` to a random string of at least 32 characters. Use the local token in the sign-in form.

## Deploy to Modal

With the Modal CLI signed into your workspace, create a Modal Secret named `nllint-gateway` from the settings above. You can use the dashboard's dotenv import. [Modal Secrets](https://modal.com/docs/guide/secrets)

```sh
make deploy
```

Use the deployed URL for `NLLINT_APP_URL` and the GitHub callback. If the URL differs from what you configured, update the secret and redeploy. The default URL uses the workspace name and the `nllint-gateway` endpoint label. The app keeps one container warm so deferred jobs run without traffic. Adjust the replica limit to fit your Postgres connection budget. [Modal Web Function URLs](https://modal.com/docs/guide/webhook-urls) [Modal warm containers](https://frontend.modal.com/docs/guide/cold-start)

For a temporary Modal server, use `make modal-serve`. If its public URL differs from the deployment, use a separate Modal secret with the temporary `NLLINT_APP_URL` and matching GitHub OAuth callback. Select it with `NLLINT_MODAL_SECRET=nllint-gateway-dev make modal-serve`. To iterate on the frontend with a Modal backend, use `make modal-api` or an existing deployment and point `make web-dev BACKEND_URL=https://…` at its URL. Enable sign-in for that workflow by setting `NLLINT_REMOTE_DEV_ORIGIN=http://localhost:5175` in the Modal secret. The backend keeps the GitHub callback on its HTTPS origin and returns a short-lived, browser-bound sign-in ticket to Vite.

## Run on your own host

Build the web UI as above and run this from `gateway` with the settings in the process environment. If you keep the settings in the repo-root `.env`, add `--env-file ../.env` after `uv run`.

```sh
uv run --locked uvicorn nllint_gateway.main:app --host 0.0.0.0 --port 8080
```

Put it behind an HTTPS reverse proxy. The API process also runs workers by default. If the API scales to zero, run a persistent worker with the same credentials and provider encryption key, set `NLLINT_WORKER_ENABLED=false` on the API, and run `uv run --locked python -m nllint_gateway.worker_main` on the worker host.

Set the same `NLLINT_WORKER_SLOTS`, `NLLINT_DECISION_REQUESTS_PER_MINUTE`, and `NLLINT_RANGE_REQUESTS_PER_MINUTE` on participating instances. The slot cap and each provider's request-start rate are global to the database.

In the control plane, **Pipelines → Configure models** lets each user set a project's decision and range models, base URLs, and credentials. Create the project with the same ID as the client's `project_id` to configure routing before the first source submission. The gateway encrypts credentials in Postgres and versions the effective configuration. Add custom routing URLs to the comma-separated `NLLINT_ALLOWED_PROVIDER_BASE_URLS` list. A project using a custom URL supplies a key for that URL.
