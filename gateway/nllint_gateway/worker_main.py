import asyncio
import signal

from .main import app, lifespan


async def run():
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stop.set)
    async with lifespan(app):
        if not app.state.settings.nllint_worker_enabled:
            raise RuntimeError("Enable NLLINT_WORKER_ENABLED on the worker process")
        await stop.wait()


if __name__ == "__main__":
    asyncio.run(run())
