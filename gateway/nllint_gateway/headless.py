from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from . import review
from .auth import Principal, client_key
from .contracts import BotIdentity, FileAnnotation, RangeAnnotation, Strict
from .db import request_db
from .lint import digest

router = APIRouter(prefix="/v1", dependencies=[Depends(client_key)])
router.add_api_route("/traces/search", review.search_traces, methods=["POST"])
router.add_api_route("/traces/{trace_id}/source", review.trace_source, methods=["GET"])
router.add_api_route("/runs/{run_id}", review.detail, methods=["GET"])
router.add_api_route("/pairs/{pair_id}/file", review.annotate_file, methods=["PUT"])
router.add_api_route("/pairs/{pair_id}/range", review.annotate_range, methods=["PUT"])
router.add_api_route("/export/{kind}", review.export, methods=["GET"])


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
    async def search_traces(query: review.TraceSearch, ctx: Context) -> dict[str, Any]:
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

    return mcp
