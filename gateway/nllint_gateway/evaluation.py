"""Save expected answers and score rule revisions on the same source."""

import json
from collections import Counter
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import Field, StringConstraints, model_validator

from .auth import Principal, operator
from .contracts import LineRange, Strict, source_lines
from .review import ReviewServices, decode_identity
from .trace_search import RULE_VERSION_ID

router = APIRouter(prefix="/api", dependencies=[Depends(operator)])


class Reference(Strict):
    run_id: int = Field(ge=1, description="Run from the baseline rule revision.")
    labeler_id: int | None = Field(
        default=None, ge=1, description="Use this labeler’s saved result for the run."
    )
    annotation_event_id: int | None = Field(
        default=None,
        ge=1,
        description="Use a past file annotation from this run’s pair.",
    )
    violates: bool | None = Field(
        default=None, description="Explicit expected file verdict."
    )
    ranges: list[LineRange] | None = Field(
        default=None,
        max_length=200,
        description="Complete expected range list. Use an empty list for a confirmed negative.",
    )

    @model_validator(mode="after")
    def consistent(self):
        sources = (
            self.labeler_id is not None,
            self.annotation_event_id is not None,
            self.violates is not None or self.ranges is not None,
        )
        if sum(sources) > 1:
            raise ValueError("Select one reference source per run")
        if (
            self.violates is not None
            and self.ranges is not None
            and self.violates != bool(self.ranges)
        ):
            raise ValueError("The file verdict must agree with the full range list")
        return self


class NewEvalSet(Strict):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
    ]
    examples: list[Reference] = Field(min_length=1, max_length=250)


class Evaluation(Strict):
    rule_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    routing_version: str | None = None
    prompt_hash: str | None = None
    threshold: float = Field(
        default=0.8,
        ge=0,
        le=1,
        description="Minimum confidence for a pipeline range to count as a finding.",
    )
    examples: Literal["errors", "all", "none"] = "errors"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=100)


async def freeze_reference(conn, example: Reference, principal: Principal):
    row = await conn.fetchrow(
        f"""
        SELECT f.id AS pair_id,f.file_label,f.labeler_identity::text,s.body AS source,
               f.key_id,f.file_hash,f.file_path,f.rule_path,f.prompt_hash,r.version AS routing_version,
               {RULE_VERSION_ID} AS rule_version
        FROM runs r JOIN file_rules f ON f.id=r.pair_id
        JOIN trace_runs tr ON tr.run_id=r.id AND tr.trace_id=r.batch_id
        JOIN texts s ON (s.key_id,s.hash)=(f.key_id,f.file_hash)
        WHERE r.id=$1
    """,
        example.run_id,
    )
    if row is None:
        raise HTTPException(404, f"Run {example.run_id} not found")

    if example.labeler_id is not None:
        label = await conn.fetchrow(
            """
            SELECT ranges::text,labeler_identity::text
            FROM agentic_labels WHERE run_id=$1 AND labeler_id=$2
        """,
            example.run_id,
            example.labeler_id,
        )
        if label is None:
            raise HTTPException(
                422, f"Run {example.run_id} has no result from this labeler"
            )
        ranges = json.loads(label["ranges"])
        expected = bool(ranges)
        identity = json.loads(label["labeler_identity"])
    elif example.annotation_event_id is not None:
        event = await conn.fetchrow(
            """
            SELECT decision,labeler_identity::text FROM annotation_history
            WHERE id=$1 AND pair_id=$2 AND start_line IS NULL AND decision IS NOT NULL
        """,
            example.annotation_event_id,
            row["pair_id"],
        )
        if event is None:
            raise HTTPException(
                422,
                f"No file decision for this annotation event on run {example.run_id}",
            )
        expected = event["decision"]
        ranges = [] if expected is False else None
        identity = json.loads(event["labeler_identity"])
    elif example.ranges is not None or example.violates is not None:
        ranges = (
            [span.model_dump() for span in example.ranges]
            if example.ranges is not None
            else None
        )
        expected = bool(ranges) if ranges is not None else example.violates
        identity = {
            "origin": principal.origin,
            "user_id": principal.user_id,
            "kind": "explicit-reference",
        }
    else:
        expected = row["file_label"]
        if expected is None:
            raise HTTPException(422, f"Run {example.run_id} has no file annotation")
        ranges = [] if expected is False else None
        identity = decode_identity(row["labeler_identity"])

    if ranges is not None:
        ranges.sort(key=lambda span: (span["start"], span["end"]))
        end = 0
        count = len(source_lines(row["source"]))
        for span in ranges:
            if span["start"] <= end or span["end"] > count:
                raise HTTPException(
                    422,
                    f"Run {example.run_id} has overlapping or out-of-bounds reference ranges",
                )
            end = span["end"]
    return {
        "violates": expected,
        "ranges": ranges,
        "labeler_identity": identity,
        "annotation_event_id": example.annotation_event_id,
        **{
            field: row[field]
            for field in (
                "key_id",
                "file_hash",
                "file_path",
                "rule_path",
                "prompt_hash",
                "routing_version",
                "rule_version",
            )
        },
    }


async def create_set(body: NewEvalSet, principal: Principal, services: ReviewServices):
    ids = {example.run_id for example in body.examples}
    if len(ids) != len(body.examples):
        raise HTTPException(422, "Each run may appear once per evaluation set")
    async with services.db.tenant(principal.user_id) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO eval_sets(name) VALUES ($1) ON CONFLICT DO NOTHING
            RETURNING id,name,created_at
        """,
            body.name,
        )
        if row is None:
            raise HTTPException(409, "An evaluation set with this name already exists")
        references = [
            (example.run_id, await freeze_reference(conn, example, principal))
            for example in body.examples
        ]
        if len({ref["rule_version"] for _, ref in references}) != 1:
            raise HTTPException(
                422, "Choose one baseline rule revision per evaluation set"
            )
        targets = {(ref["key_id"], ref["file_path"]) for _, ref in references}
        if len(targets) != len(references):
            raise HTTPException(422, "Choose one reference per file and API key")
        await conn.executemany(
            "INSERT INTO eval_examples(set_id,run_id,reference) VALUES ($1,$2,$3::jsonb)",
            [
                (row["id"], run_id, json.dumps(reference))
                for run_id, reference in references
            ],
        )
    return {
        **dict(row),
        "examples": len(ids),
        "baseline_rule_version": references[0][1]["rule_version"],
    }


async def list_sets(principal: Principal, services: ReviewServices):
    async with services.db.tenant(principal.user_id, readonly=True) as conn:
        return [
            dict(row)
            for row in await conn.fetch("""
            SELECT s.id,s.name,s.created_at,count(e.run_id) AS examples,
                   min(e.reference->>'rule_version') AS baseline_rule_version
            FROM eval_sets s JOIN eval_examples e ON e.set_id=s.id GROUP BY s.id ORDER BY s.id DESC
        """)
        ]


def metrics(counts):
    tp, fp, fn = (counts[key] for key in ("tp", "fp", "fn"))
    return {
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "f1": 2 * tp / (2 * tp + fp + fn) if tp + fp + fn else None,
    }


async def score_set(
    set_id: int, query: Evaluation, principal: Principal, services: ReviewServices
):
    async with services.db.tenant(principal.user_id, readonly=True) as conn:
        rows = await conn.fetch(
            f"""
            SELECT e.run_id AS reference_run_id,e.reference::text,
                   candidate.id AS run_id,candidate.stage,candidate.batch_id AS trace_id,p.name AS project,
                   gate.decision AS file_decision,gate.confidence,
                   coalesce((
                       SELECT jsonb_agg(jsonb_build_object('start',q.start_line,'end',q.end_line)
                                        ORDER BY q.start_line,q.end_line)
                       FROM questions q WHERE q.run_id=candidate.id AND q.stage='adjudication'
                       AND q.decision AND q.confidence >= $5 AND gate.decision
                   ), '[]'::jsonb)::text AS ranges
            FROM eval_examples e
            JOIN runs original ON original.id=e.run_id
            JOIN file_rules base ON base.id=original.pair_id
            JOIN projects p ON p.id=base.project_id
            LEFT JOIN LATERAL (
                SELECT r.id,r.stage,r.batch_id
                FROM file_rules f JOIN runs r ON r.pair_id=f.id
                JOIN trace_runs tr ON tr.run_id=r.id AND tr.trace_id=r.batch_id
                WHERE (f.project_id,f.key_id,f.file_path,f.file_hash)=
                      (base.project_id,base.key_id,base.file_path,base.file_hash)
                AND f.prompt_hash=coalesce($4::text,base.prompt_hash)
                AND r.version=coalesce($3::text,original.version)
                AND {RULE_VERSION_ID}=$2
                ORDER BY r.id DESC LIMIT 1
            ) candidate ON true
            LEFT JOIN questions gate ON gate.run_id=candidate.id AND gate.stage='file'
            WHERE e.set_id=$1 ORDER BY e.run_id
        """,
            set_id,
            query.rule_version,
            query.routing_version,
            query.prompt_hash,
            query.threshold,
        )
    if not rows:
        raise HTTPException(404, "Evaluation set not found")

    counts = Counter()
    range_counts = Counter()
    results = []
    exact_range_examples = 0
    for row in rows:
        reference = json.loads(row["reference"])
        predicted_ranges = json.loads(row["ranges"])
        stage = row["stage"]
        if stage != "ready" or row["file_decision"] is None:
            outcome = (
                "missing"
                if stage is None
                else "failed"
                if stage == "failed"
                else "incomplete"
            )
            predicted = None
            ranges_differ = False
        else:
            predicted = bool(predicted_ranges)
            expected = reference["violates"]
            outcome = (
                ("tp" if predicted else "fn")
                if expected
                else ("fp" if predicted else "tn")
            )
            ranges_differ = False
            if reference["ranges"] is not None:
                exact_range_examples += 1
                expected_spans = {
                    (span["start"], span["end"]) for span in reference["ranges"]
                }
                predicted_spans = {
                    (span["start"], span["end"]) for span in predicted_ranges
                }
                range_counts.update(
                    tp=len(expected_spans & predicted_spans),
                    fp=len(predicted_spans - expected_spans),
                    fn=len(expected_spans - predicted_spans),
                )
                ranges_differ = expected_spans != predicted_spans
        counts[outcome] += 1
        if query.examples == "all" or (
            query.examples == "errors"
            and (outcome not in {"tp", "tn"} or ranges_differ)
        ):
            results.append(
                {
                    "reference_run_id": row["reference_run_id"],
                    "run_id": row["run_id"],
                    "path": reference["file_path"],
                    "project": row["project"],
                    "trace_id": row["trace_id"],
                    "range_mismatch": ranges_differ,
                    "outcome": outcome,
                    "stage": stage,
                    "file_gate": row["file_decision"],
                    "file_confidence": row["confidence"],
                    "expected": reference["violates"],
                    "predicted": predicted,
                    "expected_ranges": reference["ranges"],
                    "predicted_ranges": predicted_ranges
                    if predicted is not None
                    else None,
                }
            )
    return {
        "set_id": set_id,
        "rule_version": query.rule_version,
        "threshold": query.threshold,
        "total": len(rows),
        "exact_range_examples": exact_range_examples,
        "file_metrics": metrics(counts),
        "exact_range_metrics": metrics(range_counts),
        "file_counts": {
            key: counts[key]
            for key in ("tp", "fp", "tn", "fn", "missing", "failed", "incomplete")
        },
        "exact_range_counts": {key: range_counts[key] for key in ("tp", "fp", "fn")},
        "examples": results[query.offset : query.offset + query.limit],
        "more": len(results) > query.offset + query.limit,
    }


async def get_examples(
    set_id: int, principal: Principal, services: ReviewServices, offset: int, limit: int
):
    async with services.db.tenant(principal.user_id, readonly=True) as conn:
        info = await conn.fetchrow(
            "SELECT id,name,created_at FROM eval_sets WHERE id=$1", set_id
        )
        if info is None:
            raise HTTPException(404, "Evaluation set not found")
        rows = await conn.fetch(
            """
            SELECT e.run_id,e.reference::text,t.id AS trace_id,p.name AS project
            FROM eval_examples e JOIN runs r ON r.id=e.run_id JOIN traces t ON t.id=r.batch_id
            JOIN projects p ON p.id=t.project_id
            WHERE e.set_id=$1 ORDER BY e.run_id OFFSET $2 LIMIT $3
        """,
            set_id,
            offset,
            limit + 1,
        )
    return {
        **dict(info),
        "examples": [
            {**dict(row), "reference": json.loads(row["reference"])}
            for row in rows[:limit]
        ],
        "more": len(rows) > limit,
    }


async def dataset_records(set_id: int, principal: Principal, services: ReviewServices):
    async with services.db.tenant(principal.user_id, readonly=True) as conn:
        async for row in conn.cursor(
            """
            SELECT e.run_id,e.reference::text,p.name AS project,s.body AS source,t.body AS rule,
                   prompt.body AS prompt
            FROM eval_examples e JOIN runs r ON r.id=e.run_id
            JOIN file_rules f ON f.id=r.pair_id JOIN projects p ON p.id=f.project_id
            JOIN texts s ON (s.key_id,s.hash)=(f.key_id,f.file_hash)
            JOIN texts t ON (t.key_id,t.hash)=(f.key_id,f.rule_hash)
            JOIN texts prompt ON (prompt.key_id,prompt.hash)=(f.key_id,f.prompt_hash)
            WHERE e.set_id=$1 ORDER BY e.run_id
        """,
            set_id,
            prefetch=8,
        ):
            yield (
                json.dumps(
                    {**dict(row), "reference": json.loads(row["reference"])},
                    ensure_ascii=False,
                )
                + "\n"
            )


@router.get("/eval-sets")
async def eval_sets(request: Request):
    return await list_sets(request.state.principal, request.app.state.review_services)


@router.post("/eval-sets", status_code=201)
async def add_eval_set(body: NewEvalSet, request: Request):
    return await create_set(
        body, request.state.principal, request.app.state.review_services
    )


@router.post("/eval-sets/{set_id}/score")
async def evaluate(set_id: int, body: Evaluation, request: Request):
    return await score_set(
        set_id, body, request.state.principal, request.app.state.review_services
    )


@router.get("/eval-sets/{set_id}/export")
async def export_set(set_id: int, request: Request):
    principal = request.state.principal
    services = request.app.state.review_services
    async with services.db.tenant(principal.user_id, readonly=True) as conn:
        if not await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM eval_sets WHERE id=$1)", set_id
        ):
            raise HTTPException(404, "Evaluation set not found")

    return StreamingResponse(
        dataset_records(set_id, principal, services),
        media_type="application/x-ndjson",
        headers={
            "Content-Disposition": f'attachment; filename="nllint-eval-{set_id}.jsonl"'
        },
    )
