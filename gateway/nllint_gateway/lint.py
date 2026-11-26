import json

from blake3 import blake3
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .auth import client_key
from .contracts import LintRequest, ProjectName
from .db import identity, notify_work, request_db

router = APIRouter(prefix="/v1")


def digest(text: str) -> str:
    return blake3(text.encode()).hexdigest()


@router.post("/lint")
async def lint(body: LintRequest, request: Request, key_id: int = Depends(client_key)):
    routing = request.app.state.routing
    source_hash = digest(body.source)
    prompt_hash = digest(body.prompt)
    rules = sorted(
        [(rule.id, rule.path, digest(rule.text), rule.text) for rule in body.rules]
    )
    async with request_db(request) as conn:
        project = await conn.fetchrow(
            "SELECT id,routing FROM projects WHERE name=$1 FOR SHARE", body.project
        )
        if project is None:
            await conn.execute(
                "INSERT INTO projects(name) VALUES ($1) ON CONFLICT DO NOTHING",
                body.project,
            )
            project = await conn.fetchrow(
                "SELECT id,routing FROM projects WHERE name=$1 FOR SHARE", body.project
            )
        project_id = project["id"]
        routes = routing.effective(project["routing"])
        version = routing.version(routes)
        trace_id = digest(
            json.dumps(
                [
                    key_id,
                    version,
                    body.project,
                    body.path,
                    source_hash,
                    prompt_hash,
                    [rule[:3] for rule in rules],
                ]
            )
        )[:32]
        await conn.execute(
            """
            INSERT INTO streams(key_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING
        """,
            key_id,
            project_id,
        )
        await conn.execute(
            """
            SELECT 1 FROM streams WHERE key_id=$1 AND project_id=$2 FOR UPDATE
        """,
            key_id,
            project_id,
        )
        created = await conn.fetchval(
            """
            INSERT INTO traces(id,key_id,project_id,file_path,version) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING RETURNING id
        """,
            trace_id,
            key_id,
            project_id,
            body.path,
            version,
        )
        if created:
            provider_id = await routing.snapshot(conn, project_id, version, routes)
            texts = {source_hash: body.source, prompt_hash: body.prompt}
            texts.update({rule_hash: text for _, _, rule_hash, text in rules})
            await conn.executemany(
                """
                INSERT INTO texts(key_id,hash,body) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
            """,
                [
                    (key_id, hash_value, text)
                    for hash_value, text in sorted(texts.items())
                ],
            )
            for rule_id, rule_path, rule_hash, _ in rules:
                args = (
                    key_id,
                    project_id,
                    body.path,
                    rule_path,
                    source_hash,
                    rule_hash,
                    prompt_hash,
                )
                pair_id = await conn.fetchval(
                    """
                    INSERT INTO file_rules(key_id, project_id, file_path, rule_path, file_hash, rule_hash, prompt_hash)
                    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id
                """,
                    *args,
                )
                if pair_id is None:
                    pair_id = await conn.fetchval(
                        """
                        SELECT id FROM file_rules WHERE (key_id,project_id,file_path,rule_path,file_hash,rule_hash,prompt_hash)
                        =($1,$2,$3,$4,$5,$6,$7)
                    """,
                        *args,
                    )
                cache_identity = digest(
                    json.dumps([key_id, source_hash, rule_hash, prompt_hash, version])
                )
                run_id = await conn.fetchval(
                    """
                    INSERT INTO runs(pair_id,version,batch_id,cache_identity,provider_version_id) VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT DO NOTHING RETURNING id
                """,
                    pair_id,
                    version,
                    trace_id,
                    cache_identity,
                    provider_id,
                )
                if run_id is None:
                    run_id = await conn.fetchval(
                        "SELECT id FROM runs WHERE pair_id=$1 AND version=$2",
                        pair_id,
                        version,
                    )
                await conn.execute(
                    """
                    INSERT INTO trace_runs(trace_id,run_id,rule_id) VALUES ($1,$2,$3)
                """,
                    trace_id,
                    run_id,
                    rule_id,
                )
            await notify_work(conn)
        result = await read_result(conn, trace_id, key_id)
    return JSONResponse(
        result, status_code=202 if result["status"] == "pending" else 200
    )


@router.get("/lint/{trace_id}")
async def result(trace_id: str, request: Request, key_id: int = Depends(client_key)):
    async with request_db(request, readonly=True) as conn:
        response = await read_result(conn, trace_id, key_id)
    return JSONResponse(
        response, status_code=202 if response["status"] == "pending" else 200
    )


async def read_result(conn, trace_id, key_id):
    rows = await conn.fetch(
        """
        SELECT tr.rule_id, r.id, r.stage, r.pair_id, t.version, f.file_label FROM traces t
        JOIN trace_runs tr ON tr.trace_id=t.id JOIN runs r ON r.id=tr.run_id
        JOIN file_rules f ON f.id=r.pair_id
        WHERE t.id=$1 AND t.key_id=$2 ORDER BY tr.rule_id
    """,
        trace_id,
        key_id,
    )
    if not rows:
        raise HTTPException(404, "Lint job not found")
    identity = {"id": trace_id, "version": rows[0]["version"]}
    unconfirmed = [row for row in rows if row["file_label"] is not False]
    if any(row["stage"] == "failed" for row in unconfirmed):
        return {**identity, "status": "failed"}
    if any(row["stage"] != "ready" for row in unconfirmed):
        return {**identity, "status": "pending"}
    ranges = await conn.fetch(
        """
        SELECT r.id AS run_id, labels.start, labels.end, labels.confidence
        FROM runs r JOIN file_rules f ON f.id=r.pair_id
        CROSS JOIN LATERAL (
            SELECT coalesce(q.start_line,a.start_line) AS start,
                   coalesce(q.end_line,a.end_line) AS end,
                   CASE WHEN a.decision THEN 1.0 ELSE q.confidence END AS confidence
            FROM (SELECT * FROM questions WHERE run_id=r.id AND stage='adjudication') q
            FULL JOIN (SELECT * FROM range_annotations WHERE pair_id=r.pair_id) a
            USING (start_line,end_line)
            WHERE coalesce(a.decision,q.decision)
        ) labels
        WHERE r.id=ANY($1::bigint[]) AND f.file_label IS DISTINCT FROM false
        ORDER BY labels.start, labels.end
    """,
        [row["id"] for row in rows],
    )
    by_run = {}
    for row in ranges:
        by_run.setdefault(row["run_id"], []).append(
            {"start": row["start"], "end": row["end"], "confidence": row["confidence"]}
        )
    return {
        **identity,
        "status": "ready",
        "results": [
            {
                "rule_id": row["rule_id"],
                "pair_id": row["pair_id"],
                "ranges": by_run.get(row["id"], []),
            }
            for row in rows
        ],
    }


@router.get("/sync")
async def sync(
    project: ProjectName,
    request: Request,
    key_id: int = Depends(client_key),
    cursor: int = Query(0, ge=0),
):
    routing = request.app.state.routing
    async with request_db(request, readonly=True) as conn:
        row = await conn.fetchrow(
            """
            SELECT s.cursor, p.id AS project_id,p.routing FROM projects p
            LEFT JOIN streams s ON s.project_id=p.id AND s.key_id=$1
            WHERE p.name=$2
        """,
            key_id,
            project,
        )
        current = (row["cursor"] or 0) if row else 0
        rows = (
            await conn.fetch(
                """
            SELECT * FROM file_rules WHERE key_id=$1 AND project_id=$2 AND revision>$3 ORDER BY revision
        """,
                key_id,
                row["project_id"],
                cursor if cursor <= current else 0,
            )
            if current
            else []
        )
        version = routing.version(routing.effective(row["routing"] if row else None))
    return {
        "version": version,
        "cursor": current,
        "changes": [
            {
                "identity": identity(row),
                "revision": row["revision"],
                "has_violation": row["file_label"],
            }
            for row in rows
        ],
    }
