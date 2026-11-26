import asyncio
from dataclasses import replace
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from . import agentic, evaluation, review
from .auth import Principal, client_key
from .contracts import BotIdentity, FileAnnotation, RangeAnnotation, Strict
from .db import request_db
from .lint import digest
from .trace_search import TraceSearch

router = APIRouter(prefix="/v1", dependencies=[Depends(client_key)])
router.add_api_route("/traces/search", review.search_traces, methods=["POST"])
router.add_api_route("/traces/{trace_id}/source", review.trace_source, methods=["GET"])
router.add_api_route("/runs/{run_id}", review.detail, methods=["GET"])
router.add_api_route("/pairs/{pair_id}/file", review.annotate_file, methods=["PUT"])
router.add_api_route("/pairs/{pair_id}/range", review.annotate_range, methods=["PUT"])
router.add_api_route("/export/selection", review.export_selection, methods=["POST"])
router.add_api_route("/export/{kind}", review.export, methods=["GET"])

router.add_api_route(
    "/pairs/{pair_id}/history", review.recent_annotations, methods=["GET"]
)
router.add_api_route("/agentic-labelers", agentic.labelers, methods=["GET"])
router.add_api_route(
    "/agentic-labelers", agentic.save_labeler, methods=["POST"], status_code=201
)
router.add_api_route(
    "/runs/{run_id}/agentic-label", agentic.label_run, methods=["POST"]
)
router.add_api_route("/eval-sets", evaluation.eval_sets, methods=["GET"])
router.add_api_route(
    "/eval-sets", evaluation.add_eval_set, methods=["POST"], status_code=201
)
router.add_api_route("/eval-sets/{set_id}/score", evaluation.evaluate, methods=["POST"])
router.add_api_route(
    "/eval-sets/{set_id}/export", evaluation.export_set, methods=["GET"]
)


class EditorAnnotation(Strict):
    source: str = Field(max_length=1_000_000)
    start: int = Field(strict=True, ge=1)
    end: int = Field(strict=True, ge=1)
    decision: bool


@router.put("/editor/pairs/{pair_id}/range")
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


def make_mcp(services: review.ReviewServices):
    mcp = FastMCP(
        "NLLint",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
        instructions="Search lint traces, read source and run details, then record bot annotations by pair ID.",
    )

    def principal(ctx: Context) -> Principal:
        original = ctx.request_context.request
        actor = (
            getattr(original.state, "principal", None) if original is not None else None
        )
        if not isinstance(actor, Principal) or actor.key_id is None:
            raise HTTPException(401, "Valid gateway API key required")
        return actor

    @mcp.tool()
    async def search_traces(query: TraceSearch, ctx: Context) -> dict[str, Any]:
        """Search traces using project, path, source text, rule, confidence, issue filters and sorting."""
        return await review.find_traces(query, principal(ctx), services)

    @mcp.tool()
    async def read_source(trace_id: str, ctx: Context) -> dict[str, Any]:
        """Read the source stored for a trace."""
        return await review.read_source(trace_id, principal(ctx), services)

    @mcp.tool()
    async def read_run(run_id: int, ctx: Context) -> dict[str, Any]:
        """Read the target file, rule, pipeline results and annotations for a run."""
        return await review.read_run(run_id, principal(ctx), services)

    @mcp.tool()
    async def annotate_file(
        pair_id: int,
        decision: bool | None,
        ctx: Context,
        run_id: int | None = None,
        identity: BotIdentity | None = None,
    ) -> dict[str, bool | None]:
        """Record a bot file decision. True confirms a violation, false rejects it, and null clears the label."""
        return await review.write_file_annotation(
            pair_id,
            FileAnnotation(
                decision=decision,
                run_id=run_id,
                labeler_type="BOT",
                labeler_identity=identity,
            ),
            principal(ctx),
            services,
        )

    @mcp.tool()
    async def annotate_range(
        pair_id: int,
        start: int,
        end: int,
        decision: bool | None,
        ctx: Context,
        identity: BotIdentity | None = None,
    ) -> dict[str, bool | None]:
        """Record a bot decision for an inclusive, one-based range. Null clears the label."""
        return await review.write_range_annotation(
            pair_id,
            RangeAnnotation(
                start=start,
                end=end,
                decision=decision,
                labeler_type="BOT",
                labeler_identity=identity,
            ),
            principal(ctx),
            services,
        )

    @mcp.tool()
    async def annotation_history(
        pair_id: int,
        ctx: Context,
        limit: Annotated[int, Field(ge=1, le=100)] = 30,
        offset: Annotated[int, Field(ge=0)] = 0,
    ) -> dict[str, Any]:
        """Page through attributable file and range edits, including cleared labels."""
        return await review.annotation_history(
            pair_id, principal(ctx), services, limit, offset
        )

    @mcp.tool()
    async def list_labelers(ctx: Context) -> list[dict[str, Any]]:
        """List saved gateway agentic labeler configurations and their IDs."""
        return await agentic.list_labelers(principal(ctx), services)

    @mcp.tool()
    async def configure_labeler(
        config: agentic.Labeler, ctx: Context
    ) -> dict[str, Any]:
        """Save an OpenRouter labeler by name with its model, search budget, and optional reviewer instructions."""
        return await agentic.configure_labeler(config, principal(ctx), services)

    @mcp.tool()
    async def label_run(run_id: int, labeler_id: int, ctx: Context) -> dict[str, Any]:
        """Ask a saved gateway agent to label a run. It reads source and returns ranges without loading source into your context."""
        result = await agentic.run_labeler(run_id, labeler_id, principal(ctx), services)
        return {**result, "run_id": run_id}

    @mcp.tool()
    async def label_runs(
        run_ids: Annotated[list[int], Field(min_length=1, max_length=6)],
        labeler_id: int,
        ctx: Context,
    ) -> dict[str, Any]:
        """Label up to six runs with a saved gateway agent. Returns each result or error; successful labels persist."""
        actor = principal(ctx)
        slots = asyncio.Semaphore(3)

        async def label(run_id):
            async with slots:
                try:
                    result = await agentic.run_labeler(
                        run_id, labeler_id, actor, services
                    )
                    return {"run_id": run_id, **result}
                except HTTPException as error:
                    return {"run_id": run_id, "error": error.detail}

        return {
            "results": await asyncio.gather(
                *(label(run_id) for run_id in dict.fromkeys(run_ids))
            )
        }

    @mcp.tool()
    async def list_eval_sets(ctx: Context) -> list[dict[str, Any]]:
        """List immutable evaluation sets, their IDs, and their example counts."""
        return await evaluation.list_sets(principal(ctx), services)

    @mcp.tool()
    async def list_eval_examples(
        set_id: int,
        ctx: Context,
        offset: Annotated[int, Field(ge=0)] = 0,
        limit: Annotated[int, Field(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        """List frozen run IDs, source paths and reference labels without loading source text."""
        return await evaluation.get_examples(
            set_id, principal(ctx), services, offset, limit
        )

    @mcp.tool()
    async def create_eval_set(
        dataset: evaluation.NewEvalSet, ctx: Context
    ) -> dict[str, Any]:
        """Freeze selected runs and reference labels. Each example uses an agent labeler ID, explicit labels, or the current file annotation."""
        result = await evaluation.create_set(dataset, principal(ctx), services)
        return {**result, "export_path": f"/v1/eval-sets/{result['id']}/export"}

    @mcp.tool()
    async def score_eval_set(
        set_id: int, query: evaluation.Evaluation, ctx: Context
    ) -> dict[str, Any]:
        """Score a rule revision against frozen references on identical source. Returns counts and compact error examples; pass examples='none' for only counts."""
        return await evaluation.score_set(set_id, query, principal(ctx), services)

    return mcp
