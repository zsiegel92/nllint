import json
from contextlib import nullcontext
from unittest import IsolatedAsyncioTestCase
from unittest.mock import Mock

import httpx
from pydantic import ValidationError

from nllint_gateway.providers import Providers
from nllint_gateway.routing import RoutingEdit


class RangeServiceTierTest(IsolatedAsyncioTestCase):
    async def test_range_requests_pass_the_selected_tier(self):
        def reply(request: httpx.Request):
            body = json.loads(request.content)
            self.assertEqual(body.get("service_tier"), expected)
            return httpx.Response(
                200, json={"choices": [{"message": {"content": '{"ranges":[]}'}}]}
            )

        provider = Providers.__new__(Providers)
        provider.observation = Mock(return_value=nullcontext())
        async with httpx.AsyncClient(transport=httpx.MockTransport(reply)) as http:
            provider.http = http
            for expected in ("flex", "fast", None):
                route = {
                    "model": "openai/gpt-6-luna",
                    "base_url": "https://example.test/v1",
                    "api_key": "mock",
                }
                if expected is not None:
                    route["service_tier"] = expected
                await provider.candidates(
                    "test",
                    {"source": "print(1)", "rule": "test", "prompt": "", "pair_id": 1},
                    route,
                )

    def test_only_range_routes_accept_supported_tiers(self):
        for body in (
            {"ranges": {"service_tier": "unknown"}},
            {"decision": {"service_tier": "fast"}},
        ):
            with self.assertRaises(ValidationError):
                RoutingEdit.model_validate(body)
