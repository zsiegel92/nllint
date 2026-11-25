from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg

from .settings import Settings


async def migrate(url: str):
    connection = await asyncpg.connect(url)
    try:
        async with connection.transaction():
            await connection.execute("SELECT pg_advisory_xact_lock(160304, 0)")
            await connection.execute(Path(__file__).with_name("schema.sql").read_text())
    finally:
        await connection.close()


class Database:
    def __init__(self, pool):
        self._pool = pool

    @classmethod
    async def open(cls, settings: Settings):
        if settings.database_migration_url is not None:
            await migrate(settings.database_migration_url.get_secret_value())
        pool = await asyncpg.create_pool(
            settings.database_url.get_secret_value(),
            min_size=1,
            max_size=settings.nllint_worker_slots + 8,
        )
        db = cls(pool)
        try:
            async with db._control() as conn:
                await conn.fetchval("SELECT public.nllint_user_id()")
                privileged = await conn.fetchval("""
                    SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user
                """)
                if privileged:
                    raise RuntimeError(
                        "The nllint_runtime role must be subject to row-level security"
                    )
        except BaseException:
            await db.close()
            raise
        return db

    @asynccontextmanager
    async def _control(self):
        async with self._pool.acquire() as connection, connection.transaction():
            await connection.execute("SET LOCAL ROLE nllint_runtime")
            await connection.execute("SET LOCAL search_path=pg_catalog,public")
            yield connection

    @asynccontextmanager
    async def tenant(self, user_id: int, *, readonly: bool = False):
        if type(user_id) is not int or user_id < 0:
            raise ValueError("An authenticated user ID is required")
        kwargs = {"isolation": "repeatable_read", "readonly": True} if readonly else {}
        async with self._pool.acquire() as connection, connection.transaction(**kwargs):
            await connection.execute("SET LOCAL ROLE nllint_runtime")
            await connection.execute("SET LOCAL search_path=pg_catalog,public")
            await connection.execute(
                "SELECT set_config('nllint.user_id',$1,true)", str(user_id)
            )
            yield connection

    async def lookup_key(self, digest):
        async with self._control() as conn:
            return await conn.fetchrow(
                "SELECT * FROM public.nllint_lookup_key($1)", digest
            )

    async def register(self, user_id):
        async with self._control() as conn:
            await conn.fetchval("SELECT public.nllint_register_user($1)", user_id)

    async def worker_users(self):
        async with self._control() as conn:
            return [
                row[0]
                for row in await conn.fetch("SELECT public.nllint_worker_users()")
            ]

    async def reserve(self, provider: str, requests_per_minute: int):
        async with self._control() as conn:
            return float(
                await conn.fetchval(
                    "SELECT public.nllint_reserve_provider($1,$2)",
                    provider,
                    60 / requests_per_minute,
                )
            )

    @asynccontextmanager
    async def listen(self, wake):
        async with self._pool.acquire() as conn:
            await conn.add_listener("nllint_queue", wake)
            try:
                yield
            finally:
                if not conn.is_closed():
                    await conn.remove_listener("nllint_queue", wake)

    async def health(self):
        async with self._control() as conn:
            await conn.fetchval("SELECT 1")

    async def close(self):
        await self._pool.close()


def request_db(request, *, readonly=False):
    return request.app.state.db.tenant(request.state.user_id, readonly=readonly)


async def notify_work(conn):
    await conn.execute("SELECT pg_notify('nllint_queue', '')")


def identity(pair):
    return [
        pair[column]
        for column in (
            "file_path",
            "rule_path",
            "file_hash",
            "rule_hash",
            "prompt_hash",
        )
    ]
