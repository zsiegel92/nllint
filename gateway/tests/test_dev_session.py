from base64 import urlsafe_b64encode
from hashlib import sha256
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from nllint_gateway.auth import CALLBACK, session_router


class DevSessionTest(TestCase):
    def test_hosted_login_returns_a_browser_bound_session_to_vite(self):
        app = FastAPI()
        app.include_router(session_router)
        hosted = "https://gateway.example.test"
        vite = "http://localhost:5175"
        app.state.settings = SimpleNamespace(
            oauth_enabled=True,
            nllint_app_url=hosted,
            nllint_dev_ui_url=None,
            nllint_remote_dev_origin=vite,
            nllint_session_secret=SecretStr("test-session-secret"),
            github_client_id="client",
            github_client_secret=SecretStr("mock"),
            allows=lambda user_id: user_id == 123,
        )
        app.state.db = AsyncMock()
        verifier = "a" * 43
        challenge = (
            urlsafe_b64encode(sha256(verifier.encode()).digest()).decode().rstrip("=")
        )
        with TestClient(app, base_url=hosted, follow_redirects=False) as client:
            start = client.get(
                "/api/session/github/start", params={"dev_challenge": challenge}
            )
            params = parse_qs(urlsplit(start.headers["location"]).query)
            self.assertEqual(params["redirect_uri"], [hosted + CALLBACK])
            provider = AsyncMock()
            provider.__aenter__.return_value = provider
            provider.post.return_value = httpx.Response(
                200,
                request=httpx.Request("POST", "https://github.com"),
                json={"access_token": "test"},
            )
            provider.get.return_value = httpx.Response(
                200,
                request=httpx.Request("GET", "https://api.github.com"),
                json={"id": 123},
            )
            with patch("nllint_gateway.auth.httpx.AsyncClient", return_value=provider):
                callback = client.get(
                    CALLBACK, params={"code": "mock", "state": params["state"][0]}
                )
            target = urlsplit(callback.headers["location"])
            self.assertEqual(f"{target.scheme}://{target.netloc}", vite)
            ticket = parse_qs(target.fragment)["dev_ticket"][0]
            exchange = vite + "/api/session/dev/exchange"
            headers = {"Origin": vite, "X-NLLint-UI": "1"}
            body = {"ticket": ticket, "verifier": verifier}
            self.assertEqual(
                client.post(
                    exchange, json=body, headers={**headers, "Origin": hosted}
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    exchange, json={**body, "verifier": "b" * 43}, headers=headers
                ).status_code,
                401,
            )
            self.assertEqual(
                client.post(exchange, json=body, headers=headers).status_code, 204
            )
            self.assertEqual(client.get(vite + "/api/session").json()["user_id"], "123")
