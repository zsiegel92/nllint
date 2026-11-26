"""Composable trace selection for the control plane, MCP, and agent context tools."""

from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .contracts import Strict

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
    "disagreement": "scored.disagreements DESC, scored.confidence_max DESC NULLS LAST, t.created_at DESC, t.id",
}


def reviewer_matches(identity: str) -> str:
    return f"""(options.reviewer_origin IS NULL OR
        (options.reviewer_origin='human' AND {identity}->>'type'='HUMAN') OR
        (options.reviewer_origin='legacy' AND {identity} IS NULL) OR
        {identity}->>'origin'=options.reviewer_origin)"""


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
    "disagreements": f"""(q.decision IS NOT NULL AND f.file_label <> q.decision
        AND {reviewer_matches("f.labeler_identity")}) OR EXISTS (
        SELECT 1 FROM range_annotations a LEFT JOIN questions j
        ON j.run_id=r.id AND j.stage='adjudication' AND j.start_line=a.start_line AND j.end_line=a.end_line
        WHERE a.pair_id=f.id AND {reviewer_matches("a.labeler_identity")} AND (a.decision <> j.decision OR (a.decision AND j.run_id IS NULL)))""",
    "rejected-candidates": """EXISTS (SELECT 1 FROM questions a
        WHERE a.run_id=r.id AND a.stage='adjudication' AND NOT a.decision)""",
    "unreviewed": """(f.file_label IS NULL AND q.decision IS NOT NULL) OR EXISTS (
        SELECT 1 FROM questions a WHERE a.run_id=r.id AND a.stage='adjudication' AND NOT EXISTS (
            SELECT 1 FROM range_annotations l WHERE l.pair_id=f.id
            AND (l.start_line,l.end_line)=(a.start_line,a.end_line)))""",
    "failed": "r.stage='failed'",
    "low-confidence": "q.confidence <= 0.65",
    "agent-disagreements": """r.stage='ready' AND EXISTS (
        SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id
        AND (options.agent_id IS NULL OR a.labeler_id=options.agent_id) AND (
           (jsonb_array_length(a.ranges)>0) IS DISTINCT FROM q.decision
           OR ARRAY(SELECT format('%s:%s', value->>'start', value->>'end')
                    FROM jsonb_array_elements(a.ranges) ORDER BY 1) <>
              ARRAY(SELECT format('%s:%s', j.start_line, j.end_line)
                    FROM questions j WHERE j.run_id=r.id AND j.stage='adjudication' AND j.decision ORDER BY 1)
        ))""",
    "agent-review-disagreements": f"""EXISTS (
        SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id
        AND (options.agent_id IS NULL OR a.labeler_id=options.agent_id) AND (
            (f.file_label IS NOT NULL AND f.file_label <> (jsonb_array_length(a.ranges)>0)
             AND {reviewer_matches("f.labeler_identity")})
            OR EXISTS (SELECT 1 FROM range_annotations l WHERE l.pair_id=f.id
                AND {reviewer_matches("l.labeler_identity")} AND l.decision <> (a.ranges @> jsonb_build_array(
                    jsonb_build_object('start',l.start_line,'end',l.end_line))))
        ))""",
    "agent-agent-disagreements": """EXISTS (
        SELECT 1 FROM agentic_labels a
        JOIN agentic_labels b ON a.run_id=b.run_id AND a.labeler_id<>b.labeler_id
        WHERE a.run_id=r.id AND a.ranges<>b.ranges
        AND (options.agent_id IS NULL OR a.labeler_id=options.agent_id)
        AND (options.peer_id IS NULL OR b.labeler_id=options.peer_id))""",
    "agent-unlabeled": """NOT EXISTS (SELECT 1 FROM agentic_labels a WHERE a.run_id=r.id
        AND (options.agent_id IS NULL OR a.labeler_id=options.agent_id))""",
}


TraceSort = Literal[
    "relevance", "newest", "confidence-asc", "confidence-desc", "path", "disagreement"
]
ANNOTATION_FILTERS = {
    "disagreements",
    "unreviewed",
    "agent-disagreements",
    "agent-review-disagreements",
    "agent-unlabeled",
    "agent-agent-disagreements",
}


ReviewerOrigin = Literal["human", "webapp", "ide", "api", "mcp", "legacy"]


class TraceSearch(Strict):
    key_id: int | None = Field(
        default=None, description="API key ID that submitted the trace."
    )
    project: str | None = Field(default=None, description="Exact client project ID.")
    trace_id: str | None = Field(default=None, description="Exact trace ID.")
    rule: str | None = Field(
        default=None, description="Exact project-relative Markdown rule path."
    )
    rule_version: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="Match any of these rule version IDs.",
    )
    positive_rule_versions_only: bool = Field(
        default=False,
        description="When filtering by rule version, require a positive pipeline file check.",
    )
    summary_only: bool = Field(
        default=False,
        description="Omit snippets and range arrays while retaining verdicts and agent range counts.",
    )
    agent_labeler_id: int | None = Field(
        default=None,
        ge=1,
        description="Use this saved agent labeler for agent comparisons or missing-result checks.",
    )
    peer_labeler_id: int | None = Field(
        default=None,
        ge=1,
        description="Use this second labeler for agent-to-agent comparisons.",
    )
    reviewer_origin: ReviewerOrigin | None = Field(
        default=None,
        description="Limit comparisons to annotations from this source. Use human for any human annotation.",
    )
    issues: list[str] = Field(
        default_factory=list,
        max_length=12,
        description="Issue filters to apply to runs. Supported values are "
        + ", ".join(FILTERS)
        + ".",
    )
    match: Literal["all", "any"] = Field(
        default="all", description="Require all or any issues on the same run."
    )
    path: str | None = Field(
        default=None,
        max_length=500,
        description="Case-insensitive substring of the file path.",
    )
    source_text: str | None = Field(
        default=None,
        max_length=500,
        description="Case-insensitive substring of the stored source.",
    )
    min_confidence: float | None = Field(
        default=None, ge=0, le=1, description="Minimum pipeline file-check confidence."
    )
    max_confidence: float | None = Field(
        default=None, ge=0, le=1, description="Maximum pipeline file-check confidence."
    )
    sort: TraceSort = Field(
        default="relevance",
        description="Confidence sorts consider matching file checks. Disagreement sorts by the number of matching runs with a disagreement.",
    )
    limit: int = Field(
        default=20, ge=1, le=100, description="Maximum number of traces per page."
    )
    offset: int = Field(
        default=0, ge=0, description="Number of traces to skip before this page."
    )


async def search_rows(conn, search: TraceSearch, *, pipeline_only=False):
    allowed = FILTERS.keys() - ANNOTATION_FILTERS if pipeline_only else FILTERS.keys()
    if any(issue not in allowed for issue in search.issues):
        raise HTTPException(400, "Unknown or unavailable issue filter")
    joiner = " AND " if search.match == "all" else " OR "
    predicate = joiner.join(f"({FILTERS[issue]})" for issue in search.issues) or "TRUE"
    rule_match = f"{RULE_VERSION_ID}=ANY($7::text[])"
    if search.positive_rule_versions_only:
        rule_match = f"q.decision AND ({rule_match})"
    disagreements = (
        "FALSE"
        if pipeline_only or search.sort != "disagreement"
        else " OR ".join(
            f"({FILTERS[name]})"
            for name in (
                "disagreements",
                "agent-disagreements",
                "agent-review-disagreements",
                "agent-agent-disagreements",
            )
        )
    )
    eligible = f"""($4::text IS NULL OR f.rule_path=$4) AND ({predicate})
        AND (cardinality($7::text[])=0 OR ({rule_match}))
        AND ($10::double precision IS NULL OR q.confidence >= $10)
        AND ($11::double precision IS NULL OR q.confidence <= $11)"""
    return await conn.fetch(
        f"""
        WITH options AS (
            SELECT $12::bigint AS agent_id, $13::bigint AS peer_id, $14::text AS reviewer_origin
        )
        SELECT t.id,t.file_path,t.created_at,t.key_id,k.name AS key_name,p.name AS project,p.id AS project_id,
               scored.score,scored.confidence_min,scored.confidence_max,scored.matching_run_ids,scored.disagreements
        FROM traces t JOIN projects p ON p.id=t.project_id JOIN api_keys k ON k.id=t.key_id
        CROSS JOIN options
        CROSS JOIN LATERAL (
            SELECT
                sum(CASE WHEN q.decision THEN {FILE_POSITIVE_POINTS} ELSE 0 END
                    + {RANGE_POSITIVE_POINTS} * counts.range_positives
                    + {ADJUDICATED_POSITIVE_POINTS} * counts.adjudicated_positives)::bigint AS score,
                min(q.confidence) FILTER (WHERE match.eligible) AS confidence_min,
                max(q.confidence) FILTER (WHERE match.eligible) AS confidence_max,
                count(*) FILTER (WHERE match.eligible AND ({disagreements})) AS disagreements,
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
        search.agent_labeler_id,
        search.peer_labeler_id,
        search.reviewer_origin,
    )
