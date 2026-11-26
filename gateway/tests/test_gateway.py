"""Run against a disposable Postgres database initialized with schema.sql."""

import asyncio
import json
import os
import unittest
from secrets import randbelow
from time import monotonic, sleep
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlsplit

import asyncpg
import httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from nllint_gateway.contracts import LineRange
from nllint_gateway.main import app
from nllint_gateway.providers import Providers
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel

UI = {"X-NLLint-UI": "1"}


@unittest.skipUnless(
    os.environ.get("NLLINT_TEST_DATABASE_URL"), "set NLLINT_TEST_DATABASE_URL"
)
class GatewayTest(unittest.TestCase):
    def test_review_provider_versions_and_tenant_isolation(self):
        user = 50_000_000 + randbelow(1_000_000_000)
        other = user + 1
        env = {
            "DATABASE_URL": os.environ["NLLINT_TEST_DATABASE_URL"],
            "NLLINT_SESSION_SECRET": "local-integration-signing-secret-123456",
            "NLLINT_PROVIDER_ENCRYPTION_KEY": Fernet.generate_key().decode(),
            "TYPESAFE_API_KEY": "mock",
            "OPENROUTER_API_KEY": "mock",
            "LANGFUSE_PUBLIC_KEY": "pk-test",
            "LANGFUSE_SECRET_KEY": "sk-test",
            "LANGFUSE_TRACING_ENABLED": "false",
            "NLLINT_APP_URL": "http://127.0.0.1",
            "GITHUB_CLIENT_ID": "test-client",
            "GITHUB_CLIENT_SECRET": "mock",
            "ALLOWED_GITHUB_USER_IDS": f"{user},{other}",
            "NLLINT_ANNOTATION_DELAY_SECONDS": "2",
            "NLLINT_DECISION_REQUESTS_PER_MINUTE": "6000",
            "NLLINT_RANGE_REQUESTS_PER_MINUTE": "6000",
            "NLLINT_ALLOWED_PROVIDER_BASE_URLS": "https://model.example.test",
        }
        calls = []

        async def fake_response():
            return httpx.Response(
                200,
                json={
                    "id": "mock-request",
                    "model": "resolved-model",
                    "usage": {
                        "prompt_tokens": 12,
                        "completion_tokens": 3,
                        "cost": 0.001,
                    },
                },
            )

        async def decisions(
            _, batch, state, instructions, stage, metadata, route, *, audit=None
        ):
            calls.append((stage, len(instructions), route["model"]))
            assert audit is not None
            await audit.record(
                {"model": route["model"], "questions": instructions}, fake_response
            )
            return {
                key: (
                    ("detect" in instruction)
                    if stage == "file-candidates"
                    else key == "2",
                    0.95,
                    route["model"],
                )
                for key, instruction in instructions.items()
            }

        async def candidates(_, batch, pair, route, *, audit=None):
            calls.append(("ranges", pair["rule_path"], route["model"]))
            assert audit is not None
            await audit.record(
                {"model": route["model"], "service_tier": route["service_tier"]},
                fake_response,
            )
            return [LineRange(start=2, end=3), LineRange(start=5, end=5)], route[
                "model"
            ]

        with (
            patch.dict(os.environ, env),
            patch.object(Providers, "decisions", decisions),
            patch.object(Providers, "candidates", candidates),
            TestClient(app, base_url="http://127.0.0.1") as client,
        ):
            self.assertEqual(client.get("/api/keys").status_code, 401)
            self.login(client, user)
            self.assertEqual(
                client.post("/api/keys", json={"name": "blocked"}).status_code, 403
            )
            key = self.key(client)
            registered = self.json(
                client.post("/api/projects", headers=UI, json={"name": "demo"}), 201
            )
            self.assertEqual(registered["requests"], 0)
            data = {
                "project": "demo",
                "path": "a.py",
                "source": "a\nb\nc\nd\ne\n",
                "rules": [
                    {"id": "a", "path": "rules/a.md", "text": "detect the marker"},
                    {
                        "id": "b",
                        "path": "rules/b.md",
                        "text": "find a different marker",
                    },
                ],
            }
            trace_id = self.submit(client, key, data)
            ready = self.wait(client, key, trace_id)
            self.assertEqual(
                self.json(client.get(f"/api/traces/{trace_id}/source")),
                {"file_path": data["path"], "source": data["source"]},
            )
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0][:2], ("file-candidates", 2))
            self.assertEqual(self.submit(client, key, data), trace_id)
            project = self.json(client.get("/api/projects"))[0]
            self.assertEqual((project["rules"], project["requests"]), (2, 1))
            key_id = self.json(client.get("/api/keys"))[0]["id"]
            self.assertEqual(
                self.json(client.get("/api/projects", params={"key_id": key_id})),
                [project],
            )
            self.assertEqual(
                self.json(client.get("/api/projects", params={"key_id": -1})), []
            )
            trace = self.json(client.get("/api/traces"))["traces"][0]
            first, second = trace["cells"]
            self.assertTrue(first["ranges_checked"])
            self.assertFalse(second["ranges_checked"])
            response = client.get("/api/export/all", params={"trace_id": trace_id})
            records = [json.loads(line) for line in response.text.splitlines()]
            positive, negative = sorted(records, key=lambda row: row["rule_id"])
            self.assertEqual(positive["source"], data["source"])
            self.assertEqual(positive["ranges"][0]["snippet"], "b\nc")
            self.assertIsNone(positive["ranges"][0]["annotation"])
            self.assertFalse(negative["questions"][0]["decision"])
            self.assertEqual(negative["ranges"], [])
            self.assertEqual(
                client.get("/api/export/annotated", params={"trace_id": trace_id}).text,
                "",
            )
            self.assertEqual(first["ranges"][0]["preview"], "b\nc")
            self.assertEqual(ready[1]["ranges"], [])
            for issue in ("file-range-positives", "adjudicated-positives"):
                filtered = self.json(
                    client.get(
                        "/api/traces", params={"issue": issue, "trace_id": trace_id}
                    )
                )
                self.assertEqual(
                    [trace["id"] for trace in filtered["traces"]], [trace_id]
                )
                clean = self.json(
                    client.get(
                        "/api/traces", params={"issue": issue, "rule": "rules/b.md"}
                    )
                )
                self.assertEqual(clean["traces"], [])

            history_path = f"/api/runs/{first['run_id']}/provider-requests"
            history = self.json(client.get(history_path))
            self.assertEqual(len(history["requests"]), 3)
            self.assertEqual(history["settings"]["ranges"]["service_tier"], "flex")
            self.assertEqual(history["requests"][0]["question_count"], 2)
            self.assertEqual(history["requests"][1]["usage"]["cost"], 0.001)
            self.assertEqual(
                history["requests"][1]["request_options"]["service_tier"], "flex"
            )
            self.assertTrue(all(not item["reused"] for item in history["requests"]))

            renamed = self.submit(client, key, {**data, "path": "renamed.py"})
            renamed_ready = self.wait(client, key, renamed)
            self.assertEqual(
                [(row["rule_id"], row["ranges"]) for row in renamed_ready],
                [(row["rule_id"], row["ranges"]) for row in ready],
            )
            self.assertNotEqual(renamed_ready[0]["pair_id"], ready[0]["pair_id"])
            self.assertEqual(
                len(calls), 3, "a different path reused the three model stages"
            )

            renamed_view = self.json(client.get(f"/api/traces?trace_id={renamed}"))[
                "traces"
            ][0]
            renamed_run = renamed_view["cells"][0]["run_id"]
            reused = self.json(client.get(f"/api/runs/{renamed_run}/provider-requests"))
            self.assertEqual(
                [item["id"] for item in reused["requests"]],
                [item["id"] for item in history["requests"]],
            )
            self.assertTrue(all(item["reused"] for item in reused["requests"]))

            catalog = self.json(
                client.get("/api/rules", params={"search": "rules/a.md"})
            )
            self.assertEqual(len(catalog), 1)
            selected_a = catalog[0]
            self.assertEqual(selected_a["name"], "a")
            self.assertEqual(selected_a["file_positives"], 2)
            self.assertEqual(selected_a["range_positives"], 4)
            self.assertEqual(selected_a["adjudicated_positives"], 2)
            alternate = {
                **data,
                "path": "more.py",
                "rules": [
                    data["rules"][0],
                    {**data["rules"][1], "text": "detect a second marker"},
                ],
            }
            higher = self.submit(client, key, alternate)
            self.wait(client, key, higher)
            newer = self.submit(client, key, {**data, "path": "later.py"})
            self.wait(client, key, newer)
            filter_params = [("rule_version", selected_a["id"])]
            ranked = self.json(client.get("/api/traces", params=filter_params))[
                "traces"
            ]
            self.assertEqual((ranked[0]["id"], ranked[0]["score"]), (higher, 16))
            self.assertEqual(ranked[1]["score"], 8)
            newest = self.json(
                client.get("/api/traces", params=[*filter_params, ("sort", "newest")])
            )
            self.assertEqual(newest["traces"][0]["id"], newer)
            versions = self.json(
                client.get("/api/rules", params={"search": "rules/b.md"})
            )
            self.assertEqual(len(versions), 2)
            self.assertNotEqual(versions[0]["id"], versions[1]["id"])
            positive_b = next(item for item in versions if item["file_positives"])
            negative_b = next(item for item in versions if not item["file_positives"])
            only_b = self.json(
                client.get("/api/traces", params={"rule_version": positive_b["id"]})
            )
            self.assertEqual([item["id"] for item in only_b["traces"]], [higher])
            any_selected = self.json(
                client.get(
                    "/api/traces",
                    params=[
                        *filter_params,
                        ("rule_version", negative_b["id"]),
                    ],
                )
            )
            self.assertEqual(
                [item["id"] for item in any_selected["traces"]],
                [item["id"] for item in ranked],
            )

            self.json(
                client.put(
                    f"/api/pairs/{second['pair_id']}/file",
                    headers=UI,
                    json={"decision": True},
                )
            )
            self.assertEqual(
                client.get(f"/v1/lint/{trace_id}", headers=key).status_code, 202
            )
            self.assertEqual(
                self.wait(client, key, trace_id)[1]["ranges"][0]["start"], 2
            )
            labeled_file = self.json(
                client.get("/api/export/annotated", params={"trace_id": trace_id})
            )
            self.assertEqual(labeled_file["rule_id"], second["rule_id"])
            self.assertTrue(labeled_file["file_label"])
            self.json(
                client.put(
                    f"/api/pairs/{second['pair_id']}/range",
                    headers=UI,
                    json={"start": 4, "end": 4, "decision": True},
                )
            )
            since = self.json(
                client.get("/v1/sync", headers=key, params={"project": "demo"})
            )
            self.assertTrue(since["changes"][0]["has_violation"])
            self.assertIn('"snippet": "d"', client.get("/api/export/adjudication").text)
            response = client.get(
                "/api/export/all",
                params={"trace_id": trace_id, "rule_version": second["rule_version"]},
            )
            annotated = json.loads(response.text)
            self.assertTrue(annotated["file_label"])
            self.assertTrue(
                any(
                    region["annotation"] and not region["candidate"]
                    for region in annotated["ranges"]
                )
            )
            self.assertEqual(
                self.json(
                    client.get("/api/export/annotated", params={"trace_id": trace_id})
                ),
                annotated,
            )
            self.assertIn(
                '"coverage": "reviewed-positives"',
                client.get("/api/export/ranges").text,
            )

            self.assertEqual(annotated["labeler_identity"]["user_id"], user)
            self.assertEqual(annotated["labeler_identity"]["origin"], "webapp")
            self.assertEqual(len(annotated["labeler_identity"]["signature"]), 64)
            self.assertEqual(ready[0]["pair_id"], first["pair_id"])
            self.assertEqual(client.post("/v1/traces/search", json={}).status_code, 401)
            search = {"path": "a.py", "source_text": "d", "min_confidence": 0.8}
            self.assertEqual(
                self.json(client.post("/v1/traces/search", headers=key, json=search))[
                    "traces"
                ][0]["id"],
                trace_id,
            )
            mcp_request = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "search_traces", "arguments": {"query": search}},
            }
            mcp_headers = {
                **key,
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2025-06-18",
            }
            self.assertEqual(client.post("/mcp", json=mcp_request).status_code, 401)
            mcp_response = self.json(
                client.post("/mcp", json=mcp_request, headers=mcp_headers)
            )
            self.assertFalse(mcp_response["result"].get("isError"), mcp_response)
            self.assertEqual(
                mcp_response["result"]["structuredContent"]["traces"][0]["id"], trace_id
            )

            write = self.json(
                client.post(
                    "/mcp",
                    headers=mcp_headers,
                    json={
                        **mcp_request,
                        "params": {
                            "name": "annotate_range",
                            "arguments": {
                                "pair_id": first["pair_id"],
                                "start": 1,
                                "end": 1,
                                "decision": False,
                                "identity": {
                                    "type": "BOT",
                                    "model": "example/reviewer",
                                },
                            },
                        },
                    },
                )
            )
            self.assertEqual(write["result"]["structuredContent"], {"decision": False})
            run = self.json(client.get(f"/v1/runs/{first['run_id']}", headers=key))
            self.assertEqual(
                run["ranges"][0]["labeler_identity"],
                {
                    "type": "BOT",
                    "origin": "api",
                    "model": "example/reviewer",
                },
            )

            labeler = self.json(
                client.post(
                    "/api/agentic-labelers",
                    headers=UI,
                    json={
                        "name": "Test labeler",
                        "model": "example/reasoning",
                        "max_tool_calls": 1,
                    },
                ),
                201,
            )

            def mock_agent(messages, info):
                if info.function_tools:
                    return ModelResponse(
                        parts=[
                            ToolCallPart(
                                "search_files",
                                {
                                    "query": {"path": "renamed.py"},
                                    "start_line": 1,
                                },
                            )
                        ]
                    )
                context = next(
                    part
                    for message in messages
                    for part in message.parts
                    if isinstance(part, ToolReturnPart)
                    and part.tool_name == "search_files"
                )
                self.assertEqual(context.content[0]["path"], "renamed.py")
                self.assertEqual(
                    context.content[0]["source"], data["source"].rstrip("\n")
                )
                return ModelResponse(
                    parts=[
                        ToolCallPart(
                            info.output_tools[0].name,
                            {
                                "ranges": [{"start": 1, "end": 1}],
                            },
                        )
                    ]
                )

            with patch(
                "nllint_gateway.agentic.OpenRouterModel",
                return_value=FunctionModel(mock_agent),
            ):
                agentic = self.json(
                    client.post(
                        f"/api/runs/{first['run_id']}/agentic-label",
                        headers=UI,
                        json={"labeler_id": labeler["id"]},
                    )
                )
            self.assertTrue(agentic["violates"])
            self.assertEqual(agentic["labeler_identity"]["harness_version"], "1")
            disagreement = self.json(
                client.get(
                    "/api/traces",
                    params={
                        "issue": "agent-disagreements",
                        "sort": "confidence-desc",
                        "trace_id": trace_id,
                    },
                )
            )
            self.assertEqual(
                disagreement["traces"][0]["matching_run_ids"], [first["run_id"]]
            )
            exported = client.get(
                "/api/export/ranges",
                params={"trace_id": trace_id, "include_agentic": True},
            )
            self.assertIn('"coverage": "agentic"', exported.text)
            self.assertIn('"origin": "agentic"', exported.text)
            self.assertNotIn(
                '"origin": "agentic"', client.get("/api/export/ranges").text
            )

            editor_path = f"/v1/editor/pairs/{first['pair_id']}/range"
            editor = {"source": data["source"], "start": 2, "end": 3, "decision": True}
            self.assertEqual(
                client.put(
                    editor_path, headers=key, json={**editor, "source": "stale"}
                ).status_code,
                409,
            )
            self.json(client.put(editor_path, headers=key, json=editor))
            run = self.json(client.get(f"/v1/runs/{first['run_id']}", headers=key))
            self.assertEqual(
                next(
                    region["labeler_identity"]
                    for region in run["ranges"]
                    if region["start"] == 2
                ),
                {"type": "HUMAN", "origin": "ide", "user_id": user},
            )
            self.assertEqual(
                client.put(
                    f"/v1/pairs/{first['pair_id']}/file",
                    headers=key,
                    json={
                        "decision": True,
                        "labeler_type": "HUMAN",
                        "labeler_identity": {"type": "HUMAN", "user_id": other},
                    },
                ).status_code,
                422,
            )
            self.json(
                client.put(
                    f"/v1/pairs/{first['pair_id']}/file",
                    headers=key,
                    json={"decision": True},
                )
            )
            run = self.json(client.get(f"/v1/runs/{first['run_id']}", headers=key))
            self.assertEqual(run["labeler_identity"], {"type": "BOT", "origin": "api"})

            for decision in (False, None):
                self.assertEqual(
                    client.put(
                        f"/v1/pairs/{second['pair_id']}/file",
                        headers=key,
                        json={"decision": decision},
                    ).status_code,
                    409,
                )
                self.assertEqual(
                    client.put(
                        f"/v1/pairs/{first['pair_id']}/range",
                        headers=key,
                        json={"start": 2, "end": 3, "decision": decision},
                    ).status_code,
                    409,
                )
            file_path = f"/v1/pairs/{first['pair_id']}/file"
            # A negative file label would suppress the positive IDE annotation.
            self.assertEqual(
                client.put(
                    file_path, headers=key, json={"decision": False}
                ).status_code,
                409,
            )
            self.json(
                client.put(editor_path, headers=key, json={**editor, "decision": False})
            )
            # Bulk rejection must also preserve attribution on an already rejected range.
            response = client.put(
                file_path,
                headers=key,
                json={
                    "decision": False,
                    "run_id": first["run_id"],
                    "reject_all": True,
                },
            )
            self.assertEqual(response.status_code, 409)
            run = self.json(client.get(f"/v1/runs/{first['run_id']}", headers=key))
            self.assertTrue(run["file_label"])
            self.assertEqual(
                next(
                    region["labeler_identity"]["origin"]
                    for region in run["ranges"]
                    if region["start"] == 2
                ),
                "ide",
            )
            self.json(
                client.put(
                    f"/v1/pairs/{first['pair_id']}/range",
                    headers=key,
                    json={"start": 1, "end": 1, "decision": None},
                )
            )

            project_id = trace["project_id"]
            self.assertEqual(registered["id"], project_id)
            path = f"/api/projects/{project_id}/routing"
            self.assertEqual(
                client.put(
                    path,
                    headers=UI,
                    json={
                        "ranges": {
                            "base_url": "https://unknown.example.test",
                            "api_key": "mock",
                        }
                    },
                ).status_code,
                422,
            )
            updated = self.json(
                client.put(
                    path,
                    headers=UI,
                    json={
                        "ranges": {
                            "base_url": "https://model.example.test",
                            "model": "range-finetune",
                            "api_key": "project-secret",
                        }
                    },
                )
            )
            self.assertTrue(updated["ranges"]["custom_key"])
            self.assertNotIn("project-secret", str(updated))
            new_version = self.json(
                client.get("/v1/sync", headers=key, params={"project": "demo"})
            )
            self.assertNotEqual(new_version["version"], since["version"])
            self.assertEqual(self.json(client.get(history_path)), history)
            self.wait(client, key, self.submit(client, key, data))
            self.assertTrue(
                any(
                    call[0] == "ranges" and call[2] == "range-finetune"
                    for call in calls
                )
            )

            self.login(client, other)
            other_key = self.key(client)
            self.assertEqual(self.json(client.get("/api/traces"))["traces"], [])
            self.assertEqual(
                client.get(f"/api/runs/{first['run_id']}").status_code, 404
            )
            self.assertEqual(client.get(history_path).status_code, 404)
            self.assertEqual(
                client.get(f"/api/traces/{trace_id}/source").status_code, 404
            )
            self.assertEqual(client.get(path).status_code, 404)
            self.assertEqual(
                client.get(f"/v1/lint/{trace_id}", headers=other_key).status_code, 404
            )
            self.assertEqual(
                client.put(
                    f"/api/pairs/{first['pair_id']}/range",
                    headers=UI,
                    json={"start": 1, "end": 1, "decision": True},
                ).status_code,
                404,
            )
            self.assertEqual(client.get("/api/export/adjudication").text, "")
            self.assertEqual(client.get("/api/export/all").text, "")
            self.assertEqual(
                client.get(
                    f"/v1/runs/{first['run_id']}", headers=other_key
                ).status_code,
                404,
            )
            foreign = self.json(
                client.post(
                    "/v1/traces/search",
                    headers=other_key,
                    json={"trace_id": trace_id},
                )
            )
            self.assertEqual(foreign["traces"], [])
            self.wait(client, other_key, self.submit(client, other_key, data))
            self.assertNotEqual(
                self.json(client.get("/api/traces"))["traces"][0]["project_id"],
                project_id,
            )
            asyncio.run(self.assert_rls(user, other, project_id))

    def login(self, client, user):
        client.cookies.clear()
        start = client.get(
            "/api/session/github/start?next=%2F%3FtraceId%3Dexample",
            follow_redirects=False,
        )
        params = parse_qs(urlsplit(start.headers["location"]).query)
        self.assertEqual(params["code_challenge_method"], ["S256"])
        self.assertEqual(
            client.get(
                "/api/session/github/callback?code=mock&state=wrong"
            ).status_code,
            401,
        )
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
            json={"id": user},
        )
        with patch("nllint_gateway.auth.httpx.AsyncClient", return_value=provider):
            done = client.get(
                "/api/session/github/callback",
                params={"code": "mock", "state": params["state"][0]},
                follow_redirects=False,
            )
        self.assertEqual(done.headers["location"], "/?traceId=example")
        self.assertEqual(self.json(client.get("/api/session"))["user_id"], str(user))

    async def assert_rls(self, user, other, project_id):
        # A runtime transaction without a tenant sees no tenant rows.
        from nllint_gateway.db import Database
        from nllint_gateway.settings import Settings

        db = await Database.open(Settings.from_env())
        try:
            async with db.tenant(user, readonly=True) as conn:
                self.assertEqual(
                    await conn.fetchval(
                        "SELECT id FROM projects WHERE id=$1", project_id
                    ),
                    project_id,
                )
            async with db.tenant(other, readonly=True) as conn:
                self.assertIsNone(
                    await conn.fetchval(
                        "SELECT id FROM projects WHERE id=$1", project_id
                    )
                )
            with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                async with db.tenant(other) as conn:
                    await conn.execute(
                        "INSERT INTO projects(user_id,name) VALUES ($1,'wrong owner')",
                        user,
                    )
            async with db._control() as conn:
                self.assertEqual(
                    await conn.fetchval("SELECT count(*) FROM projects"), 0
                )
                self.assertEqual(
                    await conn.fetchval("SELECT current_user"), "nllint_runtime"
                )
        finally:
            await db.close()

    def key(self, client):
        secret = self.json(
            client.post("/api/keys", json={"name": "Client"}, headers=UI), 201
        )["secret"]
        return {"Authorization": f"Bearer {secret}"}

    def submit(self, client, key, data):
        response = client.post("/v1/lint", headers=key, json=data)
        self.assertIn(response.status_code, (200, 202), response.text)
        return response.json()["id"]

    def wait(self, client, key, trace_id):
        end = monotonic() + 15
        while monotonic() < end:
            response = client.get(f"/v1/lint/{trace_id}", headers=key)
            if response.status_code == 200:
                body = response.json()
                self.assertEqual(body["status"], "ready", body)
                return body["results"]
            self.assertEqual(response.status_code, 202, response.text)
            sleep(0.05)
        self.fail("gateway job did not finish")

    def json(self, response, status=200):
        self.assertEqual(response.status_code, status, response.text)
        return response.json()
