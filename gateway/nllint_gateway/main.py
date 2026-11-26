import asyncio
import os
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security.utils import get_authorization_scheme_param
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.routing import Route

from . import agentic, auth, evaluation, headless, lint, review
from .db import Database
from .jobs import Worker, stop_workers
from .providers import Providers
from .routing import Routing
from .settings import Settings

WEB = Path(
    os.environ.get(
        "NLLINT_WEB_DIR", Path(__file__).resolve().parents[1] / "web" / "dist"
    )
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = Settings.from_env()
    app.state.settings = settings
    app.state.routing = Routing(settings)
    async with AsyncExitStack() as stack:
        db = await Database.open(settings)
        app.state.db = db
        stack.push_async_callback(db.close)
        app.state.providers = Providers(settings)
        stack.push_async_callback(app.state.providers.close)
        app.state.review_services = review.ReviewServices(
            db, settings, app.state.routing, app.state.providers
        )
        mcp = headless.make_mcp(app.state.review_services)
        app.state.mcp_app = mcp.streamable_http_app()
        await stack.enter_async_context(mcp.session_manager.run())
        if settings.nllint_worker_enabled:
            worker = Worker(db, app.state.providers, settings, app.state.routing)
            await stack.enter_async_context(db.listen(worker.wake))
            tasks = [
                asyncio.create_task(worker.run(slot))
                for slot in range(settings.nllint_worker_slots)
            ]
            stack.push_async_callback(stop_workers, tasks)
        yield


app = FastAPI(title="NLLint Gateway", lifespan=lifespan)
app.include_router(auth.session_router)
app.include_router(lint.router)
app.include_router(review.router)
app.include_router(agentic.router)
app.include_router(evaluation.router)
app.include_router(headless.router)


@app.middleware("http")
async def privacy(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/", "/v1/", "/mcp")):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/healthz")
async def health():
    await app.state.db.health()
    return {"status": "ok", "launch_id": os.environ.get("NLLINT_LAUNCH_ID")}


if WEB.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon():
        return FileResponse(WEB / "favicon.ico", media_type="image/x-icon")

    @app.get("/", include_in_schema=False)
    @app.get("/traces", include_in_schema=False)
    @app.get("/traces/{path:path}", include_in_schema=False)
    @app.get("/pipelines", include_in_schema=False)
    @app.get("/pipelines/{path:path}", include_in_schema=False)
    @app.get("/eval-sets", include_in_schema=False)
    @app.get("/agentic-labelers", include_in_schema=False)
    @app.get("/api-keys", include_in_schema=False)
    @app.get("/find-ranges/{path:path}", include_in_schema=False)
    async def index():
        return FileResponse(
            WEB / "index.html",
            headers={
                "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                "Cache-Control": "no-cache",
            },
        )


class McpTransport:
    async def __call__(self, scope, receive, send):
        headers = Headers(scope=scope)
        state = scope["app"].state
        # This bearer-only transport is intended for native clients.
        if "origin" in headers:
            response = JSONResponse(
                {"detail": "Browser origins are unsupported"}, status_code=403
            )
            await response(scope, receive, send)
            return
        try:
            scheme, token = get_authorization_scheme_param(headers.get("authorization"))
            actor = await auth.authenticate_key(
                state.db, state.settings, token if scheme.lower() == "bearer" else None
            )
        except HTTPException as error:
            response = JSONResponse(
                {"detail": error.detail},
                status_code=error.status_code,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})["principal"] = replace(actor, origin="mcp")
        await state.mcp_app(scope, receive, send)


app.router.routes.extend(
    [
        Route("/mcp", McpTransport(), methods=["POST", "GET", "DELETE"]),
    ]
)
