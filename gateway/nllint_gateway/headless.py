"""Bearer-authenticated REST routes for trace review and the editor."""

from dataclasses import replace

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import Field

from . import agentic, evaluation, review
from .auth import client_key
from .contracts import RangeAnnotation, Strict
from .db import request_db
from .lint import digest

router = APIRouter(prefix="/v1", dependencies=[Depends(client_key)])

router.add_api_route(
    "/traces/search",
    review.search_traces,
    methods=["POST"],
    tags=["Trace review"],
    summary="Search lint traces",
    description="A trace records linting one file. Each cell is a run of one rule. "
    "The matching_run_ids list identifies the runs that satisfy the query.",
)
router.add_api_route(
    "/traces/{trace_id}/source",
    review.trace_source,
    methods=["GET"],
    tags=["Trace review"],
    summary="Read a trace’s source",
)
router.add_api_route(
    "/runs/{run_id}",
    review.detail,
    methods=["GET"],
    tags=["Trace review"],
    summary="Read a rule run",
    description="Read the file, rule, pipeline results, agent results and current annotations. "
    "Use pair_id from this response when writing annotations.",
)
router.add_api_route(
    "/pairs/{pair_id}/file",
    review.annotate_file,
    methods=["PUT"],
    tags=["Trace review"],
    summary="Set or clear a file annotation",
)
router.add_api_route(
    "/pairs/{pair_id}/range",
    review.annotate_range,
    methods=["PUT"],
    tags=["Trace review"],
    summary="Set or clear a range annotation",
)
router.add_api_route(
    "/pairs/{pair_id}/history",
    review.recent_annotations,
    methods=["GET"],
    tags=["Trace review"],
    summary="List annotation changes",
)

JSONL_RESPONSE = {
    200: {"description": "JSON Lines download", "content": {"application/x-ndjson": {}}}
}
router.add_api_route(
    "/export/selection",
    review.export_selection,
    methods=["POST"],
    tags=["Exports"],
    summary="Download selected runs as JSONL",
    description="Streams the selected trace and run pairs with pipeline results and optional labels or annotation history.",
    response_class=StreamingResponse,
    responses=JSONL_RESPONSE,
)
router.add_api_route(
    "/export/{kind}",
    review.export,
    methods=["GET"],
    tags=["Exports"],
    summary="Download trace data by scope as JSONL",
    description="Filter by project, API key, rule, or trace. The files, ranges, and adjudication kinds "
    "export labeled examples. The all and annotated kinds export run records.",
    response_class=StreamingResponse,
    responses=JSONL_RESPONSE,
)
router.add_api_route(
    "/agentic-labelers",
    agentic.labelers,
    methods=["GET"],
    tags=["Agent labelers"],
    summary="List saved agent labelers",
)
router.add_api_route(
    "/agentic-labelers",
    agentic.save_labeler,
    methods=["POST"],
    status_code=201,
    tags=["Agent labelers"],
    summary="Create or update an agent labeler by name",
)
router.add_api_route(
    "/runs/{run_id}/agentic-label",
    agentic.label_run,
    methods=["POST"],
    tags=["Agent labelers"],
    summary="Run a saved agent labeler",
    description="Saves a second opinion for the run. Submit an explicit annotation to change diagnostics.",
)
router.add_api_route(
    "/eval-sets",
    evaluation.eval_sets,
    methods=["GET"],
    tags=["Evaluation sets"],
    summary="List saved evaluation sets",
)
router.add_api_route(
    "/eval-sets",
    evaluation.add_eval_set,
    methods=["POST"],
    status_code=201,
    tags=["Evaluation sets"],
    summary="Save an evaluation set with fixed expected answers",
)
router.add_api_route(
    "/eval-sets/{set_id}/score",
    evaluation.evaluate,
    methods=["POST"],
    tags=["Evaluation sets"],
    summary="Score a rule revision against an evaluation set",
    description="Run lint with the rule revision on the same files first. Scoring reads stored pipeline "
    "results and applies the range confidence threshold.",
)
router.add_api_route(
    "/eval-sets/{set_id}/export",
    evaluation.export_set,
    methods=["GET"],
    tags=["Evaluation sets"],
    summary="Download an evaluation set as JSONL",
    response_class=StreamingResponse,
    responses=JSONL_RESPONSE,
)


class EditorAnnotation(Strict):
    source: str = Field(max_length=1_000_000)
    start: int = Field(strict=True, ge=1)
    end: int = Field(strict=True, ge=1)
    decision: bool


@router.put(
    "/editor/pairs/{pair_id}/range",
    tags=["Lint clients"],
    summary="Review an editor diagnostic",
    description="The API key must match the diagnostic and the submitted source must match its saved snapshot.",
)
async def editor_range(
    pair_id: int,
    body: EditorAnnotation,
    request: Request,
    key_id: int = Depends(client_key),
):
    async with request_db(request, readonly=True) as conn:
        file_hash = await conn.fetchval(
            "SELECT file_hash FROM file_rules WHERE id=$1 AND key_id=$2",
            pair_id,
            key_id,
        )
    if file_hash is None:
        raise HTTPException(404, "File–rule pair not found for this key")
    if file_hash != digest(body.source):
        raise HTTPException(
            409, "The diagnostic refers to an earlier version of the file"
        )
    if body.end < body.start:
        raise HTTPException(422, "End must be at or after start")
    return await review.write_range_annotation(
        pair_id,
        RangeAnnotation(
            start=body.start,
            end=body.end,
            decision=body.decision,
            labeler_type="HUMAN",
        ),
        replace(request.state.principal, origin="ide"),
        request.app.state.review_services,
    )
