"""Tools for reviewing traces, running labelers, and evaluating rules over MCP."""

import asyncio
from typing import Annotated, Any

from fastapi import HTTPException
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

from . import agentic, evaluation, review
from .auth import Principal
from .contracts import BotIdentity, FileAnnotation, RangeAnnotation
from .trace_search import TraceSearch


def make_mcp(services: review.ReviewServices):
    mcp = FastMCP(
        "NLLint",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
        instructions=(
            "A trace is a recorded lint request for one file. A run is one rule's result "
            "within a trace. Search by project and use matching_run_ids to find runs to inspect. "
            "Use the pair_id from read_run to annotate a file or range. Saved labeler results "
            "are second opinions. Explicit annotations can change CLI and editor diagnostics. "
            "Save an evaluation set to score later rule revisions against fixed answers."
        ),
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
        """Find lint traces. Read matching_run_ids for the rules that matched and cells for context.

        Set summary_only to skip snippets and ranges. Advance offset by limit if more is true.
        """
        return await review.find_traces(query, principal(ctx), services)

    @mcp.tool()
    async def read_source(trace_id: str, ctx: Context) -> dict[str, Any]:
        """Read the source snapshot for a trace, including related files found by search_traces."""
        return await review.read_source(trace_id, principal(ctx), services)

    @mcp.tool()
    async def read_run(run_id: int, ctx: Context) -> dict[str, Any]:
        """Read a run by run_id. Returns the source, rule text, pipeline decisions, agent results, and current annotations."""
        return await review.read_run(run_id, principal(ctx), services)

    @mcp.tool()
    async def annotate_file(
        pair_id: int,
        decision: bool | None,
        ctx: Context,
        run_id: int | None = None,
        identity: BotIdentity | None = None,
    ) -> dict[str, bool | None]:
        """Annotate a file and rule using pair_id from read_run.

        True confirms a violation, false suppresses findings for the pair, and null clears
        the annotation. Pass the reviewed run_id when available. Human and legacy annotations
        are protected from replacement.
        """
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
        """Annotate one range using pair_id and inclusive, one-based start and end lines.

        True confirms a violation, false rejects the range, and null clears the annotation.
        Human and legacy annotations are protected from replacement.
        """
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
        """List past file and range annotation edits with attribution. A null decision marks a cleared annotation."""
        return await review.annotation_history(
            pair_id, principal(ctx), services, limit, offset
        )

    @mcp.tool()
    async def list_labelers(ctx: Context) -> list[dict[str, Any]]:
        """List saved agent labelers and their IDs for use in searches, labeling, and evaluation sets."""
        return await agentic.list_labelers(principal(ctx), services)

    @mcp.tool()
    async def configure_labeler(
        config: agentic.Labeler, ctx: Context
    ) -> dict[str, Any]:
        """Create or update an agent labeler by name. Set its OpenRouter model, context lookup limit, and extra instructions."""
        return await agentic.configure_labeler(config, principal(ctx), services)

    @mcp.tool()
    async def label_run(run_id: int, labeler_id: int, ctx: Context) -> dict[str, Any]:
        """Run a saved agent labeler on one run. Saves its verdict and ranges as a separate result for review."""
        result = await agentic.run_labeler(run_id, labeler_id, principal(ctx), services)
        return {**result, "run_id": run_id}

    @mcp.tool()
    async def label_runs(
        run_ids: Annotated[list[int], Field(min_length=1, max_length=6)],
        labeler_id: int,
        ctx: Context,
    ) -> dict[str, Any]:
        """Run a saved agent labeler on up to six runs. Returns each result or error and saves completed results."""
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
        """List saved evaluation sets, their IDs, and their example counts."""
        return await evaluation.list_sets(principal(ctx), services)

    @mcp.tool()
    async def list_eval_examples(
        set_id: int,
        ctx: Context,
        offset: Annotated[int, Field(ge=0)] = 0,
        limit: Annotated[int, Field(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        """List source paths, baseline run IDs, and expected answers for rerunning an evaluation. Omits source text."""
        return await evaluation.get_examples(
            set_id, principal(ctx), services, offset, limit
        )

    @mcp.tool()
    async def create_eval_set(
        dataset: evaluation.NewEvalSet, ctx: Context
    ) -> dict[str, Any]:
        """Save runs from one rule revision with a copy of their expected answers.

        For each run, use a saved agent result, a past file annotation, or an explicit answer.
        With only run_id, the current file annotation supplies the answer. Returns a set ID
        and a REST path for downloading its JSONL.
        """
        result = await evaluation.create_set(dataset, principal(ctx), services)
        return {**result, "export_path": f"/v1/eval-sets/{result['id']}/export"}

    @mcp.tool()
    async def score_eval_set(
        set_id: int, query: evaluation.Evaluation, ctx: Context
    ) -> dict[str, Any]:
        """Score a rule revision on the same source using saved expected answers.

        Rerun lint on the set's files first. Scores use raw pipeline ranges that meet the
        threshold. Pass examples='none' for counts and metrics without the example rows.
        """
        return await evaluation.score_set(set_id, query, principal(ctx), services)

    return mcp
