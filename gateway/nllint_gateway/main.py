import asyncio
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, lint, review
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


@app.middleware("http")
async def privacy(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/", "/v1/")):
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
