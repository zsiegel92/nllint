.PHONY: dev test

dev:
	npm --prefix gateway/web ci --no-audit --no-fund
	@set -eu; \
	(cd gateway && NLLINT_DEV_UI_URL=http://localhost:5175 exec uv run --locked --env-file ../.env uvicorn nllint_gateway.main:app --reload --host 127.0.0.1 --port 8080) & api=$$!; \
	(cd gateway/web && exec ./node_modules/.bin/vite --host 127.0.0.1 --port 5175 --strictPort) & web=$$!; \
	trap 'kill "$$api" "$$web" 2>/dev/null || true; wait "$$api" "$$web" 2>/dev/null || true' EXIT; \
	trap 'exit 130' INT; trap 'exit 143' TERM; \
	while kill -0 "$$api" 2>/dev/null && kill -0 "$$web" 2>/dev/null; do sleep 1; done; \
	if kill -0 "$$api" 2>/dev/null; then wait "$$web"; else wait "$$api"; fi

test:
	cargo test --locked --workspace
