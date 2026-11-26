# Gateway API and MCP

Create a key under **API keys** in the gateway. Send it as `Authorization: Bearer <key>` on REST requests or configure it as the bearer token for the MCP Streamable HTTP endpoint at `/mcp`. The lint and editor endpoints are scoped to the calling key. Review endpoints can access traces owned by the key's account across projects and keys. Use `project` and, when needed, `key_id` to narrow searches.

The gateway serves an interactive REST reference at `/docs` and its OpenAPI document at `/openapi.json`. Use the `/v1` routes in integrations. The signed-in web app uses `/api`.

## Identifiers

| Field | What it identifies |
| --- | --- |
| `trace_id` | A recorded lint request for one file. The trace contains a cell for each submitted rule. |
| `run_id` | One rule's pipeline result for that file. Cached results can appear in more than one trace. |
| `pair_id` | The annotation target for an exact file, rule, and prompt in its project and API-key context. Read it from the run. |
| `rule_version` | The submitted revision of a rule, identified by the project, rule ID, path, and Markdown content. |

## Find and review runs

| Action | REST | MCP |
| --- | --- | --- |
| Search traces | `POST /v1/traces/search` | `search_traces(query)` |
| Read the saved file | `GET /v1/traces/{trace_id}/source` | `read_source` |
| Read one rule run | `GET /v1/runs/{run_id}` | `read_run` |
| Annotate a file or range | `PUT /v1/pairs/{pair_id}/file` or `/range` | `annotate_file` or `annotate_range` |
| Read annotation edits | `GET /v1/pairs/{pair_id}/history` | `annotation_history` |

For REST, send the search object directly as JSON. For MCP, pass it as `query`.

```json
{
  "project": "demo",
  "path": "src/parser",
  "issues": ["agent-disagreements"],
  "agent_labeler_id": 5,
  "sort": "confidence-desc",
  "summary_only": true,
  "limit": 10
}
```

This finds agent–pipeline disagreements with the highest pipeline file-check confidence first. Read `matching_run_ids` to identify the matches within each trace. Other cells can appear for context. When `more` is true, advance `offset` by `limit`.

- `path` and `source_text` search for case-insensitive substrings. `rule` matches an exact project-relative Markdown path. `rule_version` takes a list of version IDs.
- `min_confidence` and `max_confidence` apply to the pipeline's file check. `low-confidence` selects file checks at or below 0.65. `match` applies all or any requested issues to a single run.
- Use `agent_labeler_id` to choose a saved labeler for agent comparisons or the `agent-unlabeled` filter. Use `peer_labeler_id` with `agent-agent-disagreements` to choose the second labeler. Use `reviewer_origin` to choose which annotations count in reviewer comparisons.

Set `decision` to `true` for a violation, `false` for no violation, or `null` to clear the annotation. Pass `run_id` when writing a file annotation if you reviewed a specific run. For a range, pass `start` and `end` as inclusive, one-based line numbers. A negative file annotation suppresses findings for that pair. A range annotation applies to its exact bounds. The CLI and IDE pick up edits on their next sync.

MCP writes have bot attribution. REST defaults to bot attribution for bearer-key requests. Bot writes return a conflict if they would replace a human or legacy annotation, or if a negative file decision would suppress a human or legacy confirmed range. The gateway records the write channel and signs browser annotations.

## Get a second opinion and compare rule revisions

- Create or update a named OpenRouter labeler with `POST /v1/agentic-labelers` or `configure_labeler`. Use `GET /v1/agentic-labelers` or `list_labelers` to find its ID.
- Run it with `POST /v1/runs/{run_id}/agentic-label`, `label_run`, or `label_runs`. Saved agent results are available for comparison, export, and evaluation. Use an explicit annotation to change diagnostics.
- Save an evaluation set with `POST /v1/eval-sets` or `create_eval_set`. Choose runs from one rule revision. Each example copies an expected answer from a saved agent result, a file annotation, or an explicit verdict or range list. An explicit range list must be complete. Use `ranges: []` for a confirmed negative.
- Run lint on the same source files with the revised rule. Score the stored results with `POST /v1/eval-sets/{set_id}/score` or `score_eval_set`, passing the revised `rule_version` and the range confidence `threshold`. Scores use raw pipeline output. Exact-range scores use examples with complete expected ranges. Check the missing, failed, and incomplete counts before comparing revisions.

## Download JSONL

- Use `GET /v1/export/{kind}` to download by project, API key, rule, or trace. Use `files`, `ranges`, or `adjudication` for labeled examples. Use `all` for full run records or `annotated` for runs with annotations. Add `include_agentic=true` to include saved labeler results.
- Use `POST /v1/export/selection` with `{"selection": [{"trace_id": "…", "run_id": 123}]}` to download specific runs. You can choose which saved labeler results and annotations to include and whether to include annotation history.
- Use `GET /v1/eval-sets/{set_id}/export` to download the source and expected answers for a saved evaluation set.

See the [NLLint skill](../skills/nllint/SKILL.md) for MCP setup and a rule calibration workflow.
