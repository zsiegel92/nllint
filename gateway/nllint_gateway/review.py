import json
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import Field
from fastapi.responses import StreamingResponse

from .auth import digest_key, mint_key, operator, sign
from .contracts import (
    FileAnnotation,
    Strict,
    Inheritance,
    KeyName,
    NewProject,
    RangeAnnotation,
    source_lines,
)
from .db import notify_work, request_db
from .routing import RoutingEdit

router = APIRouter(prefix="/api", dependencies=[Depends(operator)])

FILE_POSITIVE_POINTS = 1
RANGE_POSITIVE_POINTS = 2
ADJUDICATED_POSITIVE_POINTS = 3

# Source text is already content-addressed. Scope each version to the supplied
# rule ID and path in its project, independent of the API key that submitted it.
RULE_VERSION_ID = """
encode(sha256(convert_to(
    jsonb_build_array(f.project_id, tr.rule_id, f.rule_path, f.rule_hash)::text, 'UTF8'
)), 'hex')
"""
RANGE_COUNTS = """
CROSS JOIN LATERAL (
    SELECT
        (SELECT count(*) FROM range_candidates c WHERE c.run_id=r.id) AS range_positives,
        (SELECT count(*) FROM questions a
         WHERE a.run_id=r.id AND a.stage='adjudication' AND a.decision) AS adjudicated_positives
) counts
"""
TRACE_SORTS = {
    "relevance": "scored.score DESC, t.created_at DESC, t.id",
    "newest": "t.created_at DESC, t.id",
    "confidence-asc": "scored.confidence_min ASC NULLS LAST, t.created_at DESC, t.id",
    "confidence-desc": "scored.confidence_max DESC NULLS LAST, t.created_at DESC, t.id",
    "path": "t.file_path, t.created_at DESC, t.id",
}

CELL = f"""
    SELECT r.id AS run_id, r.batch_id, r.stage, r.error, f.id AS pair_id,
           f.file_label, f.labeler_identity::text AS labeler_identity, f.rule_path, f.file_hash, f.rule_hash, tr.rule_id,
           tr.trace_id, {RULE_VERSION_ID} AS rule_version,
           q.decision AS file_decision, q.confidence AS file_confidence,
           EXISTS (SELECT 1 FROM questions discovery
                   WHERE discovery.run_id=r.id AND discovery.stage='ranges') AS ranges_checked
    FROM trace_runs tr JOIN runs r ON r.id=tr.run_id
    JOIN file_rules f ON f.id=r.pair_id
    LEFT JOIN questions q ON q.run_id=r.id AND q.stage='file'
"""

FILTERS = {
    "all": "TRUE",
    "file-range-positives": """q.decision AND EXISTS (
        SELECT 1 FROM range_candidates c WHERE c.run_id=r.id)""",
    "adjudicated-positives": """EXISTS (
        SELECT 1 FROM questions a WHERE a.run_id=r.id AND a.stage='adjudication' AND a.decision)""",
    "no-ranges": """q.decision AND r.stage='ready'
        AND NOT EXISTS (SELECT 1 FROM range_candidates c WHERE c.run_id=r.id)""",
    "all-rejected": """q.decision AND r.stage='ready'
        AND EXISTS (SELECT 1 FROM range_candidates c WHERE c.run_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM questions a WHERE a.run_id=r.id AND a.stage='adjudication' AND a.decision)""",
    "disagreements": """(q.decision IS NOT NULL AND f.file_label <> q.decision) OR EXISTS (
        SELECT 1 FROM range_annotations a LEFT JOIN questions j
        ON j.run_id=r.id AND j.stage='adjudication' AND j.start_line=a.start_line AND j.end_line=a.end_line
        WHERE a.pair_id=f.id AND (a.decision <> j.decision OR (a.decision AND j.run_id IS NULL)))""",
    "rejected-candidates": """EXISTS (SELECT 1 FROM questions a
        WHERE a.run_id=r.id AND a.stage='adjudication' AND NOT a.decision)""",
    "unreviewed": """(f.file_label IS NULL AND q.decision IS NOT NULL) OR EXISTS (
        SELECT 1 FROM questions a WHERE a.run_id=r.id AND a.stage='adjudication' AND NOT EXISTS (
            SELECT 1 FROM range_annotations l WHERE l.pair_id=f.id
            AND (l.start_line,l.end_line)=(a.start_line,a.end_line)))""",
    "failed": "r.stage='failed'",
    "low-confidence": "q.confidence <= 0.65",
    "agent-disagreements": """r.stage='ready' AND EXISTS (
        SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id AND (
           (jsonb_array_length(a.ranges)>0) IS DISTINCT FROM q.decision
           OR ARRAY(SELECT format('%s:%s', value->>'start', value->>'end')
                    FROM jsonb_array_elements(a.ranges) ORDER BY 1) <>
              ARRAY(SELECT format('%s:%s', j.start_line, j.end_line)
                    FROM questions j WHERE j.run_id=r.id AND j.stage='adjudication' AND j.decision ORDER BY 1)
        ))""",
}


@router.get("/keys")
async def keys(request: Request):
    async with request_db(request, readonly=True) as conn:
        return [
            dict(row)
            for row in await conn.fetch("""
            SELECT id,name,prefix,created_at,revoked_at FROM api_keys ORDER BY created_at DESC
        """)
        ]


@router.post("/keys", status_code=201)
async def create_key(body: KeyName, request: Request):
    async with request_db(request) as conn:
        secret = mint_key()
        row = await conn.fetchrow(
            """
            INSERT INTO api_keys(name,digest,prefix) VALUES ($1,$2,$3) RETURNING id,name,prefix,created_at
        """,
            body.name,
            digest_key(secret),
            secret[:14],
        )
        return {**dict(row), "secret": secret}


@router.delete("/keys/{key_id}", status_code=204)
async def revoke_key(key_id: int, request: Request):
    async with request_db(request) as conn:
        await conn.execute(
            """
            UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1
        """,
            key_id,
        )


@router.get("/projects")
async def projects(request: Request, key_id: int | None = None):
    async with request_db(request, readonly=True) as conn:
        return [
            dict(row)
            for row in await conn.fetch(
                """
            SELECT p.name,p.id,parent.name AS parent, coalesce(r.rules,0) AS rules,
                   coalesce(t.requests,0) AS requests
            FROM projects p LEFT JOIN projects parent ON p.parent_id=parent.id
            LEFT JOIN (
                SELECT project_id, count(DISTINCT rule_path)::int AS rules
                FROM file_rules WHERE $1::bigint IS NULL OR key_id=$1 GROUP BY project_id
            ) r ON r.project_id=p.id
            LEFT JOIN (
                SELECT project_id, count(*) AS requests
                FROM traces WHERE $1::bigint IS NULL OR key_id=$1 GROUP BY project_id
            ) t ON t.project_id=p.id
            WHERE $1::bigint IS NULL OR t.requests IS NOT NULL ORDER BY p.name
        """,
                key_id,
            )
        ]


@router.post("/projects", status_code=201)
async def create_project(body: NewProject, request: Request):
    async with request_db(request) as conn:
        project = await conn.fetchrow(
            "INSERT INTO projects(name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id,name",
            body.name,
        )
        if project is None:
            raise HTTPException(409, "A project with this name already exists")
    return {**dict(project), "parent": None, "rules": 0, "requests": 0}


@router.put("/projects/{project_id}/inheritance", status_code=204)
async def inheritance(project_id: int, body: Inheritance, request: Request):
    async with request_db(request) as conn:
        await conn.execute("SELECT pg_advisory_xact_lock(160307, 0)")
        parent_id = None
        if body.parent:
            parent_id = await conn.fetchval(
                "SELECT id FROM projects WHERE name=$1", body.parent
            )
            if parent_id is None:
                raise HTTPException(404, "Parent project not found")
            cycle = await conn.fetchval(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT id,parent_id FROM projects WHERE id=$1
                    UNION ALL SELECT p.id,p.parent_id FROM ancestors a JOIN projects p ON p.id=a.parent_id
                ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=$2)
            """,
                parent_id,
                project_id,
            )
            if cycle:
                raise HTTPException(409, "Inheritance would create a cycle")
        result = await conn.execute(
            "UPDATE projects SET parent_id=$2 WHERE id=$1", project_id, parent_id
        )
        if result == "UPDATE 0":
            raise HTTPException(404, "Project not found")


@router.get("/projects/{project_id}/routing")
async def provider_routing(project_id: int, request: Request):
    async with request_db(request, readonly=True) as conn:
        project = await conn.fetchrow(
            "SELECT routing FROM projects WHERE id=$1", project_id
        )
        if project is None:
            raise HTTPException(404, "Project not found")
    routing = request.app.state.routing
    return routing.view(project["routing"])


@router.put("/projects/{project_id}/routing")
async def update_routing(project_id: int, body: RoutingEdit, request: Request):
    routing = request.app.state.routing
    async with request_db(request) as conn:
        project = await conn.fetchrow(
            "SELECT routing FROM projects WHERE id=$1 FOR UPDATE", project_id
        )
        if project is None:
            raise HTTPException(404, "Project not found")
        updated = routing.update(project["routing"], body)
        effective = routing.effective(updated)
        await routing.snapshot(conn, project_id, routing.version(effective), effective)
        await conn.execute(
            "UPDATE projects SET routing=$2 WHERE id=$1", project_id, updated
        )
    return routing.view(updated)


@router.get("/history")
async def history(project_id: int, rule: str, request: Request):
    async with request_db(request, readonly=True) as conn:
        return [
            dict(row)
            for row in await conn.fetch(
                """
            WITH RECURSIVE lineage AS (
                SELECT id,parent_id,name FROM projects WHERE id=$1
                UNION ALL SELECT p.id,p.parent_id,p.name FROM lineage l JOIN projects p ON p.id=l.parent_id
            )
            SELECT l.name AS project, f.rule_path, f.rule_hash, x.body AS rule,
                   min(t.created_at) AS first_seen, max(t.created_at) AS last_seen
            FROM lineage l JOIN file_rules f ON f.project_id=l.id
            JOIN texts x ON (x.key_id,x.hash)=(f.key_id,f.rule_hash)
            JOIN runs r ON r.pair_id=f.id JOIN traces t ON t.id=r.batch_id
            WHERE f.rule_path=$2 GROUP BY l.name,f.rule_path,f.rule_hash,x.body
            ORDER BY first_seen DESC
        """,
                project_id,
                rule,
            )
        ]


@router.get("/rules")
async def rules(
    request: Request,
    key_id: int | None = None,
    project: str | None = None,
    trace_id: str | None = None,
    search: str = Query("", max_length=200),
    rule_version: list[str] = Query(default=[], max_length=100),
):
    async with request_db(request, readonly=True) as conn:
        rows = await conn.fetch(
            f"""
            WITH versions AS (
                SELECT DISTINCT r.id AS run_id, {RULE_VERSION_ID} AS id,
                       tr.rule_id AS name,f.rule_path AS path,f.rule_hash AS hash,p.name AS project
                FROM trace_runs tr JOIN runs r ON r.id=tr.run_id
                JOIN file_rules f ON f.id=r.pair_id JOIN projects p ON p.id=f.project_id
                WHERE ($1::bigint IS NULL OR f.key_id=$1) AND ($2::text IS NULL OR p.name=$2)
                AND ($3::text IS NULL OR tr.trace_id=$3)
            ), picked AS (
                SELECT id,name,path,hash,project FROM versions
                WHERE strpos(lower(name),lower($4)) > 0 OR id=ANY($5::text[])
                OR $4='' OR strpos(lower(path),lower($4)) > 0
                GROUP BY id,name,path,hash,project
                ORDER BY id=ANY($5::text[]) DESC,name,path,project,hash LIMIT 60
            )
            SELECT p.id,p.name,p.path,p.hash,p.project,
                   count(*) FILTER (WHERE q.decision)::int AS file_positives,
                   sum(counts.range_positives)::int AS range_positives,
                   sum(counts.adjudicated_positives)::int AS adjudicated_positives
            FROM picked p JOIN versions v ON v.id=p.id JOIN runs r ON r.id=v.run_id
            LEFT JOIN questions q ON q.run_id=r.id AND q.stage='file'
            {RANGE_COUNTS}
            GROUP BY p.id,p.name,p.path,p.hash,p.project
            ORDER BY p.id=ANY($5::text[]) DESC,p.name,p.path,p.project,p.hash
            """,
            key_id,
            project,
            trace_id,
            search.strip(),
            rule_version,
        )
    return [dict(row) for row in rows]


TraceSort = Literal["relevance", "newest", "confidence-asc", "confidence-desc", "path"]
ANNOTATION_FILTERS = {"disagreements", "unreviewed", "agent-disagreements"}


class TraceSearch(Strict):
    key_id: int | None = None
    project: str | None = None
    trace_id: str | None = None
    rule: str | None = None
    rule_version: list[str] = Field(default_factory=list, max_length=100)
    positive_rule_versions_only: bool = False
    issues: list[str] = Field(default_factory=list, max_length=12)
    match: Literal["all", "any"] = "all"
    path: str | None = Field(default=None, max_length=500)
    source_text: str | None = Field(default=None, max_length=500)
    min_confidence: float | None = Field(default=None, ge=0, le=1)
    max_confidence: float | None = Field(default=None, ge=0, le=1)
    sort: TraceSort = "relevance"
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


async def search_rows(conn, search: TraceSearch, *, pipeline_only=False):
    allowed = FILTERS.keys() - ANNOTATION_FILTERS if pipeline_only else FILTERS.keys()
    if any(issue not in allowed for issue in search.issues):
        raise HTTPException(400, "Unknown or unavailable issue filter")
    joiner = " AND " if search.match == "all" else " OR "
    predicate = joiner.join(f"({FILTERS[issue]})" for issue in search.issues) or "TRUE"
    rule_match = f"{RULE_VERSION_ID}=ANY($7::text[])"
    if search.positive_rule_versions_only:
        rule_match = f"q.decision AND ({rule_match})"
    eligible = f"""($4::text IS NULL OR f.rule_path=$4) AND ({predicate})
        AND (cardinality($7::text[])=0 OR ({rule_match}))
        AND ($10::double precision IS NULL OR q.confidence >= $10)
        AND ($11::double precision IS NULL OR q.confidence <= $11)"""
    return await conn.fetch(
        f"""
        SELECT t.id,t.file_path,t.created_at,t.key_id,k.name AS key_name,p.name AS project,p.id AS project_id,
               scored.score,scored.confidence_min,scored.confidence_max,scored.matching_run_ids
        FROM traces t JOIN projects p ON p.id=t.project_id JOIN api_keys k ON k.id=t.key_id
        CROSS JOIN LATERAL (
            SELECT
                sum(CASE WHEN q.decision THEN {FILE_POSITIVE_POINTS} ELSE 0 END
                    + {RANGE_POSITIVE_POINTS} * counts.range_positives
                    + {ADJUDICATED_POSITIVE_POINTS} * counts.adjudicated_positives)::bigint AS score,
                min(q.confidence) FILTER (WHERE match.eligible) AS confidence_min,
                max(q.confidence) FILTER (WHERE match.eligible) AS confidence_max,
                array_agg(r.id ORDER BY r.id) FILTER (WHERE match.eligible) AS matching_run_ids
            FROM trace_runs tr JOIN runs r ON r.id=tr.run_id
            JOIN file_rules f ON f.id=r.pair_id
            LEFT JOIN questions q ON q.run_id=r.id AND q.stage='file'
            {RANGE_COUNTS}
            CROSS JOIN LATERAL (SELECT {eligible} AS eligible) match
            WHERE tr.trace_id=t.id
            AND ($9::text IS NULL OR EXISTS (
                SELECT 1 FROM texts body WHERE (body.key_id,body.hash)=(f.key_id,f.file_hash)
                AND strpos(lower(body.body),lower($9))>0
            ))
        ) scored
        WHERE ($1::bigint IS NULL OR t.key_id=$1) AND ($2::text IS NULL OR p.name=$2)
        AND ($3::text IS NULL OR t.id=$3) AND scored.matching_run_ids IS NOT NULL
        AND ($8::text IS NULL OR strpos(lower(t.file_path),lower($8))>0)
        ORDER BY {TRACE_SORTS[search.sort]} LIMIT $5 OFFSET $6
        """,
        search.key_id,
        search.project,
        search.trace_id,
        search.rule,
        search.limit + 1,
        search.offset,
        search.rule_version,
        search.path,
        search.source_text,
        search.min_confidence,
        search.max_confidence,
    )


@router.get("/traces")
async def traces(
    request: Request,
    key_id: int | None = None,
    project: str | None = None,
    trace_id: str | None = None,
    rule: str | None = None,
    issue: str = "all",
    sort: TraceSort = "relevance",
    rule_version: list[str] = Query(default=[], max_length=100),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    return await search_traces(
        TraceSearch(
            key_id=key_id,
            project=project,
            trace_id=trace_id,
            rule=rule,
            positive_rule_versions_only=issue
            not in {"low-confidence", "agent-disagreements"},
            issues=[issue],
            sort=sort,
            rule_version=rule_version,
            limit=limit,
            offset=offset,
        ),
        request,
    )


@router.post("/traces/search")
async def search_traces(body: TraceSearch, request: Request):
    limit = body.limit
    rule = body.rule
    async with request_db(request, readonly=True) as conn:
        rows = await search_rows(conn, body)
        page = rows[:limit]
        cells = await conn.fetch(
            f"""
            {CELL} WHERE tr.trace_id=ANY($1::text[]) AND ($2::text IS NULL OR f.rule_path=$2)
            ORDER BY f.rule_path
        """,
            [row["id"] for row in page],
            rule,
        )
        ranges = await review_ranges(conn, list({row["run_id"] for row in cells}))
        labels = await agent_labels(conn, [cell["run_id"] for cell in cells])
        with_ranges = {row["pair_id"] for row in cells if ranges.get(row["run_id"])}
        sources = await conn.fetch(
            """
            SELECT f.id,x.body FROM file_rules f JOIN texts x ON (x.key_id,x.hash)=(f.key_id,f.file_hash)
            WHERE f.id=ANY($1::bigint[])
        """,
            list(with_ranges),
        )
        lines_by_pair = {
            record["id"]: source_lines(record["body"]) for record in sources
        }
        for cell in cells:
            for region in ranges.get(cell["run_id"], [])[:8]:
                if "preview" not in region:
                    lines = lines_by_pair[cell["pair_id"]]
                    preview = "\n".join(
                        line[:500]
                        for line in lines[
                            region["start"] - 1 : min(
                                region["end"], region["start"] + 4
                            )
                        ]
                    )
                    region["preview"] = preview[:500]
    by_trace = defaultdict(list)
    for cell in cells:
        by_trace[cell["trace_id"]].append(
            {**review_cell(cell, labels), "ranges": ranges[cell["run_id"]]}
        )
    return {
        "traces": [{**dict(row), "cells": by_trace[row["id"]]} for row in page],
        "more": len(rows) > limit,
    }


@router.get("/traces/{trace_id}/source")
async def trace_source(trace_id: str, request: Request):
    async with request_db(request, readonly=True) as conn:
        row = await conn.fetchrow(
            """
            SELECT t.file_path, s.body AS source
            FROM traces t
            JOIN LATERAL (
                SELECT DISTINCT f.key_id, f.file_hash
                FROM trace_runs tr JOIN runs r ON r.id=tr.run_id
                JOIN file_rules f ON f.id=r.pair_id WHERE tr.trace_id=t.id
            ) file ON true
            JOIN texts s ON (s.key_id,s.hash)=(file.key_id,file.file_hash)
            WHERE t.id=$1
        """,
            trace_id,
        )
        if row is None:
            raise HTTPException(404, "Trace not found")
    return {"file_path": row["file_path"], "source": row["source"]}


async def review_ranges(conn, ids):
    rows = await conn.fetch(
        """
        SELECT r.id AS run_id, details.*
        FROM runs r CROSS JOIN LATERAL (
            SELECT coalesce(c.start_line,l.start_line) AS start,
                   coalesce(c.end_line,l.end_line) AS end,
                   q.decision AS model_decision,q.confidence,
                   l.decision AS annotation, l.labeler_identity::text AS labeler_identity, c.run_id IS NOT NULL AS candidate
            FROM (SELECT * FROM range_candidates WHERE run_id=r.id) c
            FULL JOIN (SELECT * FROM range_annotations WHERE pair_id=r.pair_id) l USING (start_line,end_line)
            LEFT JOIN questions q ON q.run_id=r.id AND q.stage='adjudication'
            AND (q.start_line,q.end_line)=(c.start_line,c.end_line)
        ) details WHERE r.id=ANY($1::bigint[])
        ORDER BY details.start,details.end
    """,
        ids,
    )
    by_run = defaultdict(list)
    for row in rows:
        region = dict(row)
        region["labeler_identity"] = decode_identity(region["labeler_identity"])
        by_run[region.pop("run_id")].append(region)
    return by_run


@router.get("/runs/{run_id}")
async def detail(run_id: int, request: Request):
    async with request_db(request, readonly=True) as conn:
        row = await conn.fetchrow(
            f"""
            {CELL} WHERE r.id=$1 AND tr.trace_id=r.batch_id
        """,
            run_id,
        )
        if not row:
            raise HTTPException(404, "Run not found")
        source = await conn.fetchrow(
            """
            SELECT x.body AS source,y.body AS rule,f.file_path
            FROM file_rules f JOIN texts x ON (x.key_id,x.hash)=(f.key_id,f.file_hash)
            JOIN texts y ON (y.key_id,y.hash)=(f.key_id,f.rule_hash) WHERE f.id=$1
        """,
            row["pair_id"],
        )
        ranges = (await review_ranges(conn, [run_id]))[run_id]
        labels = await agent_labels(conn, [run_id])
    settings = request.app.state.settings
    trace = request.app.state.providers.trace_id(row["batch_id"])
    langfuse_url = None
    if settings.langfuse_project_id:
        langfuse_url = f"{settings.langfuse_base_url.rstrip('/')}/project/{settings.langfuse_project_id}/traces/{trace}"
    return {
        **review_cell(row, labels),
        **dict(source),
        "ranges": ranges,
        "langfuse_url": langfuse_url,
    }


@router.get("/runs/{run_id}/provider-requests")
async def provider_requests(run_id: int, request: Request):
    async with request_db(request, readonly=True) as conn:
        snapshot = await conn.fetchrow(
            """
            SELECT v.id,v.version,v.routing FROM runs r
            JOIN provider_versions v ON v.id=r.provider_version_id
            WHERE r.id=$1
        """,
            run_id,
        )
        if snapshot is None:
            raise HTTPException(404, "Run not found")
        rows = await conn.fetch(
            """
            SELECT p.id,p.provider_version_id,p.stage,p.started_at,p.question_count,
                   p.request_options, NOT (p.run_ids @> ARRAY[$1::bigint]) AS reused,
                   o.finished_at,o.http_status,o.transport_error,o.upstream_request_id,
                   o.resolved_model,o.resolved_service_tier,o.usage
            FROM provider_requests p
            LEFT JOIN provider_request_results o ON o.request_id=p.id
            WHERE p.run_ids @> ARRAY[$1::bigint] OR p.id IN (
                SELECT provider_request_id FROM questions WHERE run_id=$1
            )
            ORDER BY p.started_at,p.id
        """,
            run_id,
        )
    settings = request.app.state.routing.decode(snapshot["routing"])
    requests = [
        {
            **dict(row),
            "request_options": json.loads(row["request_options"]),
            "usage": json.loads(row["usage"]) if row["usage"] is not None else None,
        }
        for row in rows
    ]
    return {
        "settings_version_id": snapshot["id"],
        "settings_version": snapshot["version"],
        "settings": {
            kind: {
                key: route[key]
                for key in ("base_url", "model", "service_tier")
                if key in route
            }
            for kind, route in settings.items()
        },
        "requests": requests,
    }


async def lock_pair(conn, pair_id):
    row = await conn.fetchrow("SELECT * FROM file_rules WHERE id=$1", pair_id)
    if row is None:
        raise HTTPException(404, "File–rule pair not found")
    await conn.execute(
        """
        SELECT 1 FROM streams WHERE key_id=$1 AND project_id=$2 FOR UPDATE
    """,
        row["key_id"],
        row["project_id"],
    )
    return await conn.fetchrow("SELECT * FROM file_rules WHERE id=$1", pair_id)


async def revision(conn, pair):
    value = await conn.fetchval(
        """
        UPDATE streams SET cursor=cursor+1 WHERE key_id=$1 AND project_id=$2 RETURNING cursor
    """,
        pair["key_id"],
        pair["project_id"],
    )
    await conn.execute(
        "UPDATE file_rules SET revision=$2 WHERE id=$1", pair["id"], value
    )


def decode_identity(raw):
    return json.loads(raw) if raw else None


async def agent_labels(conn, ids):
    labels = defaultdict(list)
    for row in await conn.fetch(
        """
        SELECT run_id,labeler_id,ranges::text,labeler_identity::text
        FROM agentic_labels WHERE run_id=ANY($1::bigint[]) ORDER BY labeler_id
    """,
        ids,
    ):
        ranges = json.loads(row["ranges"])
        labels[row["run_id"]].append(
            {
                "labeler_id": row["labeler_id"],
                "ranges": ranges,
                "violates": bool(ranges),
                "labeler_identity": json.loads(row["labeler_identity"]),
            }
        )
    return labels


def review_cell(row, labels):
    return {
        **dict(row),
        "labeler_identity": decode_identity(row["labeler_identity"]),
        "agentic_labels": labels[row["run_id"]],
    }


def annotation_identity(request, body, target):
    if body.decision is None:
        return None
    identity = body.labeler_identity
    web = getattr(request.state, "web_session", False)
    kind = body.labeler_type or (
        identity.type if identity else "HUMAN" if web else "BOT"
    )
    data = identity.model_dump(exclude_none=True) if identity else {"type": kind}
    data["origin"] = getattr(request.state, "annotation_origin", "api")
    if kind == "HUMAN":
        user_id = request.state.user_id
        if identity and identity.user_id not in (None, user_id):
            raise HTTPException(422, "The human labeler must be the authenticated user")
        data["user_id"] = user_id
        if web:
            data["origin"] = "webapp"
            data["signature"] = sign(
                json.dumps([user_id, target, body.decision]),
                "human-labeled-via-webapp",
                request,
            )
    return json.dumps(data)


@router.put("/pairs/{pair_id}/file")
async def annotate_file(pair_id: int, body: FileAnnotation, request: Request):
    settings = request.app.state.settings
    labeler = annotation_identity(request, body, ["file", pair_id])
    async with request_db(request) as conn:
        pair = await lock_pair(conn, pair_id)
        if body.reject_all and body.decision is not False:
            raise HTTPException(
                400, "Rejecting all ranges requires a negative file label"
            )
        await conn.execute(
            "SELECT id FROM runs WHERE pair_id=$1 ORDER BY id FOR UPDATE", pair_id
        )
        project_settings = await conn.fetchval(
            "SELECT routing FROM projects WHERE id=$1", pair["project_id"]
        )
        routing = request.app.state.routing
        version = routing.version(routing.effective(project_settings))
        changed = pair["file_label"] != body.decision or decode_identity(
            pair["labeler_identity"]
        ) != decode_identity(labeler)
        if changed:
            await conn.execute(
                """
                UPDATE file_rules SET file_label=$2,file_labeled_at=now(),force_requested=false,labeler_identity=$3::jsonb WHERE id=$1
            """,
                pair_id,
                body.decision,
                labeler,
            )
            if body.decision:
                await schedule(
                    conn, pair_id, version, settings.nllint_annotation_delay_seconds
                )
                if body.run_id:
                    observed_version = await conn.fetchval(
                        "SELECT version FROM runs WHERE id=$1 AND pair_id=$2",
                        body.run_id,
                        pair_id,
                    )
                    if observed_version and observed_version != version:
                        await schedule(
                            conn,
                            pair_id,
                            observed_version,
                            settings.nllint_annotation_delay_seconds,
                        )
            else:
                await conn.execute(
                    """
                    UPDATE runs r SET stage='ready',attempts=0,error=NULL
                    WHERE pair_id=$1 AND stage='ranges' AND EXISTS (
                        SELECT 1 FROM questions q WHERE q.run_id=r.id AND q.stage='file' AND NOT q.decision
                    )
                """,
                    pair_id,
                )
        if body.reject_all:
            candidates = await conn.fetch(
                """
                SELECT c.start_line,c.end_line
                FROM runs r JOIN range_candidates c ON c.run_id=r.id WHERE r.pair_id=$1
                AND (r.id=$2::bigint OR ($2::bigint IS NULL AND r.version=$3))
            """,
                pair_id,
                body.run_id,
                version,
            )
            await conn.executemany(
                """
                INSERT INTO range_annotations(pair_id,start_line,end_line,decision,labeler_identity)
                VALUES ($1,$2,$3,false,$4::jsonb)
                ON CONFLICT (pair_id,start_line,end_line) DO UPDATE
                SET decision=false,updated_at=now(),labeler_identity=EXCLUDED.labeler_identity
            """,
                [
                    (
                        pair_id,
                        row["start_line"],
                        row["end_line"],
                        annotation_identity(
                            request,
                            body,
                            ["range", pair_id, row["start_line"], row["end_line"]],
                        ),
                    )
                    for row in candidates
                ],
            )
        if changed or body.reject_all:
            await revision(conn, pair)
    return {"decision": body.decision}


async def schedule(conn, pair_id, version, delay):
    # The same row and transition serve debounced annotations and immediate review.
    updated = await conn.execute(
        """
        UPDATE runs r SET stage='ranges', attempts=0,
          available_at=LEAST(
            CASE WHEN stage='ranges' THEN available_at ELSE 'infinity'::timestamptz END,
            now()+make_interval(secs => $3)), error=NULL
        WHERE pair_id=$1 AND version=$2 AND stage IN ('ready','ranges','failed')
        AND EXISTS (SELECT 1 FROM questions q WHERE q.run_id=r.id AND q.stage='file' AND NOT q.decision)
        AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.run_id=r.id AND q.stage='ranges')
    """,
        pair_id,
        version,
        delay,
    )
    if updated != "UPDATE 0":
        await notify_work(conn)


@router.post("/runs/{run_id}/find-ranges")
async def find_ranges(run_id: int, request: Request):
    async with request_db(request) as conn:
        run = await conn.fetchrow("SELECT * FROM runs WHERE id=$1", run_id)
        if run is None:
            raise HTTPException(404, "Run not found")
        pair = await lock_pair(conn, run["pair_id"])
        if not pair["file_label"]:
            raise HTTPException(409, "Label the file as violating first")
        await conn.execute("SELECT 1 FROM runs WHERE id=$1 FOR UPDATE", run_id)
        await conn.execute(
            "UPDATE file_rules SET force_requested=true WHERE id=$1", pair["id"]
        )
        await schedule(conn, pair["id"], run["version"], 0)
        await retry_run(conn, run_id)
    return {"trace_id": run["batch_id"]}


@router.post("/runs/{run_id}/retry")
async def retry(run_id: int, request: Request):
    async with request_db(request) as conn:
        if not await retry_run(conn, run_id):
            raise HTTPException(409, "The run is not a failed job")
    return {"status": "pending"}


async def retry_run(conn, run_id):
    row = await conn.fetchrow(
        """
        UPDATE runs r SET stage=CASE
            WHEN EXISTS (SELECT 1 FROM questions q WHERE q.run_id=r.id AND q.stage='ranges') THEN 'adjudication'
            WHEN EXISTS (SELECT 1 FROM questions q WHERE q.run_id=r.id AND q.stage='file') THEN 'ranges'
            ELSE 'file' END, attempts=0,available_at=now(),error=NULL
        WHERE id=$1 AND stage='failed' RETURNING id
    """,
        run_id,
    )
    if row is not None:
        await notify_work(conn)
    return row is not None


@router.put("/pairs/{pair_id}/range")
async def annotate_range(pair_id: int, body: RangeAnnotation, request: Request):
    labeler = annotation_identity(
        request, body, ["range", pair_id, body.start, body.end]
    )
    async with request_db(request) as conn:
        pair = await lock_pair(conn, pair_id)
        source = await conn.fetchval(
            "SELECT body FROM texts WHERE (key_id,hash)=($1,$2)",
            pair["key_id"],
            pair["file_hash"],
        )
        if body.end > len(source_lines(source)):
            raise HTTPException(422, "Range is outside the file")
        if body.decision is None:
            result = await conn.execute(
                """
                DELETE FROM range_annotations WHERE (pair_id,start_line,end_line)=($1,$2,$3)
            """,
                pair_id,
                body.start,
                body.end,
            )
            changed = result != "DELETE 0"
        else:
            result = await conn.execute(
                """
                INSERT INTO range_annotations(pair_id,start_line,end_line,decision,labeler_identity) VALUES ($1,$2,$3,$4,$5::jsonb)
                ON CONFLICT (pair_id,start_line,end_line) DO UPDATE SET decision=$4,updated_at=now(),labeler_identity=$5::jsonb
                WHERE range_annotations.decision IS DISTINCT FROM $4
                   OR range_annotations.labeler_identity IS DISTINCT FROM $5::jsonb
            """,
                pair_id,
                body.start,
                body.end,
                body.decision,
                labeler,
            )
            changed = result != "INSERT 0 0"
        if changed:
            await revision(conn, pair)
    return {"decision": body.decision}


async def training_records(
    request,
    key_id,
    project,
    rule,
    trace_id,
    rule_version,
    annotated_only,
    include_agentic,
    *,
    agent_only=False,
):
    query = f"""
        SELECT tr.trace_id,r.id AS run_id,f.id AS pair_id,r.version AS routing_version,
               r.provider_version_id,r.stage,r.error,p.name AS project,f.key_id,
               trace.created_at::text AS trace_created_at,trace.file_path,f.file_hash,
               tr.rule_id,f.rule_path,f.rule_hash,{RULE_VERSION_ID} AS rule_version,
               f.prompt_hash,f.file_label,f.labeler_identity::text,s.body AS source,t.body AS rule,pr.body AS prompt,
               COALESCE((SELECT jsonb_agg(
                   jsonb_build_object('stage',q.stage,'start',nullif(q.start_line,0),
                       'end',nullif(q.end_line,0),'decision',q.decision,'confidence',q.confidence,
                       'model',q.model,'provider_request_id',q.provider_request_id)
                   ORDER BY CASE q.stage WHEN 'file' THEN 1 WHEN 'ranges' THEN 2 ELSE 3 END,
                       q.start_line,q.end_line)
                   FROM questions q WHERE q.run_id=r.id),'[]'::jsonb)::text AS questions
        FROM trace_runs tr JOIN traces trace ON trace.id=tr.trace_id
        JOIN runs r ON r.id=tr.run_id JOIN file_rules f ON f.id=r.pair_id
        JOIN projects p ON p.id=f.project_id
        JOIN texts s ON (s.key_id,s.hash)=(f.key_id,f.file_hash)
        JOIN texts t ON (t.key_id,t.hash)=(f.key_id,f.rule_hash)
        JOIN texts pr ON (pr.key_id,pr.hash)=(f.key_id,f.prompt_hash)
        WHERE ($1::bigint IS NULL OR f.key_id=$1) AND ($2::text IS NULL OR p.name=$2)
        AND ($3::text IS NULL OR f.rule_path=$3) AND ($4::text IS NULL OR tr.trace_id=$4)
        AND (cardinality($5::text[])=0 OR {RULE_VERSION_ID}=ANY($5::text[]))
        AND (NOT $6::boolean OR f.file_label IS NOT NULL OR EXISTS (
            SELECT 1 FROM range_annotations a WHERE a.pair_id=f.id
        ) OR ($7::boolean AND EXISTS (SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id)))
        AND (NOT $8::boolean OR EXISTS (SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id))
        ORDER BY tr.trace_id,r.id
    """
    async with request_db(request, readonly=True) as conn:
        cursor = await conn.cursor(
            query,
            key_id,
            project,
            rule,
            trace_id,
            rule_version,
            annotated_only,
            include_agentic,
            agent_only,
        )
        while rows := await cursor.fetch(100):
            ids = list({row["run_id"] for row in rows})
            ranges = await review_ranges(conn, ids) if not agent_only else {}
            labels = await agent_labels(conn, ids) if include_agentic else {}
            for row in rows:
                item = dict(row)
                item["questions"] = json.loads(item["questions"])
                item["labeler_identity"] = decode_identity(item["labeler_identity"])
                if include_agentic:
                    item["agentic_labels"] = labels[item["run_id"]]
                lines = source_lines(item["source"])
                item["ranges"] = [
                    {
                        **region,
                        "snippet": "\n".join(
                            lines[region["start"] - 1 : region["end"]]
                        ),
                    }
                    for region in ranges.get(item["run_id"], [])
                ]
                yield item


@router.get("/export/{kind}")
async def export(
    kind: Literal["files", "adjudication", "ranges", "all", "annotated"],
    request: Request,
    key_id: int | None = None,
    project: str | None = None,
    rule: str | None = None,
    trace_id: str | None = None,
    rule_version: list[str] = Query(default=[], max_length=100),
    include_agentic: bool = False,
):
    query = f"""
        SELECT f.id AS pair_id,p.name AS project,f.key_id,f.file_path,f.rule_path,f.file_label,f.labeler_identity::text,
               s.body AS source,t.body AS rule,q.body AS prompt,f.file_hash,f.rule_hash
        FROM file_rules f JOIN projects p ON p.id=f.project_id
        JOIN texts s ON (s.key_id,s.hash)=(f.key_id,f.file_hash)
        JOIN texts t ON (t.key_id,t.hash)=(f.key_id,f.rule_hash)
        JOIN texts q ON (q.key_id,q.hash)=(f.key_id,f.prompt_hash)
        WHERE ($1::bigint IS NULL OR f.key_id=$1) AND ($2::text IS NULL OR p.name=$2)
        AND ($3::text IS NULL OR f.rule_path=$3) AND f.revision>0
        AND (($4::text IS NULL AND cardinality($5::text[])=0) OR EXISTS (
            SELECT 1 FROM trace_runs tr JOIN runs r ON r.id=tr.run_id
            WHERE r.pair_id=f.id AND ($4::text IS NULL OR tr.trace_id=$4)
            AND (cardinality($5::text[])=0 OR {RULE_VERSION_ID}=ANY($5::text[]))
        )) ORDER BY f.id
    """

    async def records():
        async with request_db(request, readonly=True) as conn:
            async for row in conn.cursor(
                query, key_id, project, rule, trace_id, rule_version
            ):
                item = dict(row)
                item["labeler_identity"] = decode_identity(item["labeler_identity"])
                pair_id = item.pop("pair_id")
                label = item.pop("file_label")
                if kind == "files":
                    if label is not None:
                        yield (
                            json.dumps({**item, "violates": label}, ensure_ascii=False)
                            + "\n"
                        )
                    continue
                regions = await conn.fetch(
                    """
                    SELECT start_line AS start,end_line AS end,decision AS violates,labeler_identity::text
                    FROM range_annotations WHERE pair_id=$1 ORDER BY start_line,end_line
                """,
                    pair_id,
                )
                regions = [
                    {
                        **dict(r),
                        "labeler_identity": decode_identity(r["labeler_identity"]),
                    }
                    for r in regions
                ]
                if kind == "ranges":
                    if label is False:
                        yield (
                            json.dumps(
                                {**item, "ranges": [], "coverage": "file-negative"},
                                ensure_ascii=False,
                            )
                            + "\n"
                        )
                    elif any(r["violates"] for r in regions):
                        accepted = [
                            {
                                "start": r["start"],
                                "end": r["end"],
                                "labeler_identity": r["labeler_identity"],
                            }
                            for r in regions
                            if r["violates"]
                        ]
                        yield (
                            json.dumps(
                                {
                                    **item,
                                    "ranges": accepted,
                                    "coverage": "reviewed-positives",
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )
                else:
                    lines = source_lines(item["source"])
                    for region in regions:
                        snippet = "\n".join(lines[region["start"] - 1 : region["end"]])
                        yield (
                            json.dumps(
                                {**item, **dict(region), "snippet": snippet},
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

    async def examples():
        async for record in records():
            yield record
        if not include_agentic:
            return
        async for item in training_records(
            request,
            key_id,
            project,
            rule,
            trace_id,
            rule_version,
            True,
            True,
            agent_only=True,
        ):
            for field in ("questions", "ranges", "file_label", "labeler_identity"):
                item.pop(field)
            for agent in item.pop("agentic_labels"):
                base = {**item, "labeler_identity": agent["labeler_identity"]}
                if kind == "files":
                    yield (
                        json.dumps(
                            {**base, "violates": agent["violates"]}, ensure_ascii=False
                        )
                        + "\n"
                    )
                elif kind == "ranges":
                    yield (
                        json.dumps(
                            {**base, "ranges": agent["ranges"], "coverage": "agentic"},
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                else:
                    lines = source_lines(item["source"])
                    for region in agent["ranges"]:
                        snippet = "\n".join(lines[region["start"] - 1 : region["end"]])
                        yield (
                            json.dumps(
                                {
                                    **base,
                                    **region,
                                    "violates": True,
                                    "snippet": snippet,
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

    async def dataset():
        async for row in training_records(
            request,
            key_id,
            project,
            rule,
            trace_id,
            rule_version,
            kind == "annotated",
            include_agentic,
        ):
            yield json.dumps(row, ensure_ascii=False) + "\n"

    return StreamingResponse(
        dataset() if kind in {"all", "annotated"} else examples(),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f'attachment; filename="nllint-{kind}.jsonl"'},
    )
