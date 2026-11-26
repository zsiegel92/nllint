import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from .db import Database


class ProviderAudit:
    def __init__(
        self,
        db: Database,
        user_id: int,
        provider_version_id: int,
        trace_id: str,
        stage: str,
        run_ids: list[int],
    ):
        self.db = db
        self.user_id = user_id
        self.provider_version_id = provider_version_id
        self.trace_id = trace_id
        self.stage = stage
        self.run_ids = run_ids
        self.request_id: int | None = None

    async def record(
        self, body: dict[str, Any], send: Callable[[], Awaitable[httpx.Response]]
    ) -> httpx.Response:
        # Commit independently so a rejected result, retry, or failed run write
        # cannot erase a provider attempt that may already have incurred usage.
        options = {
            key: body[key]
            for key in ("model", "service_tier", "provider", "response_format")
            if key in body
        }
        count = len(body["questions"]) if "questions" in body else None
        async with self.db.tenant(self.user_id) as conn:
            self.request_id = await conn.fetchval(
                """
                INSERT INTO provider_requests(provider_version_id,trace_id,stage,run_ids,question_count,request_options)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id
                """,
                self.provider_version_id,
                self.trace_id,
                self.stage,
                self.run_ids,
                count,
                json.dumps(options),
            )
        try:
            response = await send()
        except httpx.RequestError as error:
            await self.finish(transport_error=type(error).__name__)
            raise
        await self.finish(response=response)
        return response

    async def finish(
        self,
        *,
        response: httpx.Response | None = None,
        transport_error: str | None = None,
    ):
        payload: dict[str, Any] = {}
        if response is not None:
            try:
                data = response.json()
                if isinstance(data, dict):
                    payload = data
            except ValueError:
                pass
        usage = payload.get("usage")
        request_id = (
            response.headers.get("x-request-id") if response is not None else None
        )
        async with self.db.tenant(self.user_id) as conn:
            await conn.execute(
                """
                INSERT INTO provider_request_results(
                    request_id,http_status,transport_error,upstream_request_id,
                    resolved_model,resolved_service_tier,usage
                ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
                """,
                self.request_id,
                response.status_code if response is not None else None,
                transport_error,
                string_field(payload, "id") or request_id,
                string_field(payload, "model"),
                string_field(payload, "service_tier"),
                json.dumps(usage) if isinstance(usage, dict) else None,
            )


def string_field(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return value if isinstance(value, str) else None
