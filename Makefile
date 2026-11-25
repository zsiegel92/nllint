.DEFAULT_GOAL := help

ENV_FILE ?= .env
API_PORT ?= 8080
WEB_PORT ?= 5175
API_HOST ?= 127.0.0.1
BACKEND_URL ?= http://127.0.0.1:$(API_PORT)
MODAL ?= uv run --locked modal
ARGS ?=
WEB_DEPS := gateway/web/node_modules/.nllint-installed

GATEWAY_PYTHON = uv run --locked --directory gateway
GATEWAY_RUN = $(GATEWAY_PYTHON) --env-file "$(abspath $(ENV_FILE))"
UVICORN = $(GATEWAY_RUN) uvicorn nllint_gateway.main:app --host $(API_HOST) --port $(API_PORT)
VITE = npm --prefix gateway/web run dev -- --host 127.0.0.1 --port $(WEB_PORT) --strictPort

.PHONY: help dev api-dev web-dev serve web-install web-build modal-serve modal-api deploy deploy-api worker
.PHONY: db-migrate db-check daemon-start daemon-stop cli-build cli-release cli-install cli-run cli-watch ide-package skill-install check test

help: ## List commands and their configurable arguments
	@awk 'BEGIN { FS = ":.*## " } /^##@ / { print "\n" substr($$0, 5) } /^[a-z][a-z-]*:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\n  ENV_FILE=%s  API_HOST=%s  API_PORT=%s  WEB_PORT=%s\n  BACKEND_URL=%s\n  ARGS="..." passes arguments to cli-run or cli-watch.\n' "$(ENV_FILE)" "$(API_HOST)" "$(API_PORT)" "$(WEB_PORT)" "$(BACKEND_URL)"

##@ Local servers
dev: web-install ## Run local FastAPI and Vite together with reload
	+uv run --no-project python tools/dev.py "$(MAKE)"

api-dev: ## Run local FastAPI with reload for a separate Vite server
	NLLINT_DEV_UI_URL=http://localhost:$(WEB_PORT) $(UVICORN) --reload

web-dev: web-install ## Run Vite against BACKEND_URL (local, Modal serve, or deployed)
	$(MAKE) --no-print-directory vite

.PHONY: vite
vite:
	NLLINT_VITE_BACKEND_URL="$(BACKEND_URL)" $(VITE)

serve: web-build ## Serve built frontend assets and FastAPI locally on API_PORT
	$(UVICORN)

web-install: $(WEB_DEPS) ## Install frontend dependencies from the lockfile

$(WEB_DEPS): gateway/web/package.json gateway/web/package-lock.json
	npm --prefix gateway/web ci --no-audit --no-fund
	@touch $@

web-build: web-install ## Build the Vite frontend
	npm --prefix gateway/web run build

##@ Modal
modal-serve: web-build ## Run a temporary Modal gateway with built frontend assets
	cd gateway && NLLINT_MODAL_API_ONLY=0 $(MODAL) serve modal_app.py

modal-api: ## Run a temporary API-only Modal gateway for use with web-dev
	cd gateway && NLLINT_MODAL_API_ONLY=1 $(MODAL) serve modal_app.py

deploy: web-build ## Deploy the gateway and built frontend assets to Modal
	cd gateway && NLLINT_MODAL_API_ONLY=0 $(MODAL) deploy modal_app.py

deploy-api: ## Deploy an API-only gateway to Modal
	cd gateway && NLLINT_MODAL_API_ONLY=1 $(MODAL) deploy modal_app.py

##@ Postgres and workers
worker: ## Run a standalone local queue worker
	$(GATEWAY_RUN) python -m nllint_gateway.worker_main

db-migrate: ## Apply the schema using DATABASE_MIGRATION_URL
	$(GATEWAY_RUN) python -m nllint_gateway.database_command migrate

db-check: ## Verify DATABASE_URL and the restricted runtime role
	$(GATEWAY_RUN) python -m nllint_gateway.database_command check

##@ Rust CLI and daemon
daemon-start: ## Build CLI and start the detached local lint gateway
	NLLINT_ENV_FILE="$(abspath $(ENV_FILE))" NLLINT_HOST=$(API_HOST) NLLINT_PORT=$(API_PORT) cargo run --locked -q -p nllint -- serve -d

daemon-stop: ## Stop the detached local lint gateway
	cargo run --locked -q -p nllint -- stop

cli-build: ## Compile the Rust CLI in debug mode
	cargo build --locked -p nllint

cli-release: ## Compile the optimized Rust CLI into target/release
	cargo build --locked --release -p nllint

cli-install: ## Install the optimized CLI and schemas on your PATH
	./install-to-path.sh

cli-run: ## Run the CLI with ARGS
	cargo run --locked -q -p nllint -- $(ARGS)

cli-watch: ## Run the CLI watcher with ARGS
	cargo run --locked -q -p nllint -- watch $(ARGS)

##@ Integrations and checks
ide-package: ## Build the VS Code extension package
	cd ide-extension && pnpm install --frozen-lockfile && pnpm package

skill-install: ## Install the NLLint agent skill
	./install-skill.sh

check: ## Check the Rust CLI and Python gateway
	cargo fmt --all --check
	cargo clippy --locked --workspace --all-targets -- -D warnings
	uvx ruff check gateway tools

test: ## Run Rust, gateway, and extension tests
	cargo test --locked --workspace
	$(GATEWAY_PYTHON) python -m unittest discover -s tests
	cd ide-extension && pnpm install --frozen-lockfile && pnpm check
