---
name: nllint
description: Configure or run NLLint in a project, author natural-language lint rules and thresholds, set up its gateway API key and IDE watcher, or search and annotate gateway traces through MCP or REST.
---

# Use NLLint

NLLint sends configured source files and Markdown rules to a gateway and reports confirmed line ranges. Use the intended gateway for the project.

## Set up the client

1. Install the CLI with `./install-to-path.sh` from the NLLint checkout. For VS Code, tell the user to run `./ide-extension/install.sh` from that checkout. This builds and installs the VSIX using `code`. Set `CODE_BIN` for a different compatible CLI. For a remote workspace, install the CLI on the extension host.
2. Open the gateway web app, sign in with an allowed GitHub account or the local development token, and choose **API keys → Create API key**. Name the key for the app or environment and save the secret shown at creation. For unattended use, set `NLLINT_GATEWAY_BASE_URL` and `NLLINT_GATEWAY_API_KEY`. For an IDE launched outside the terminal, use `~/.config/nllint/config.json` (or under `XDG_CONFIG_HOME`) with `gateway_base_url` and `gateway_api_key`. Keep credentials out of source control.
3. From the target repo, run `nllint init` to create `.nllintrc.jsonc`, a starter rule, and a prompt. For private project settings, put `settings.jsonc` in `~/.config/nllint/projects/<name>/` and set `project_root` to the project's absolute directory. Place its `rules_dir` and optional `system_prompt` beside those settings. File globs are relative to the target project in either mode. An in-repo config takes precedence.

The checkout provides `schema/nllint.schema.json` for project JSONC and `schema/credentials.schema.json` for client JSON. A `file://` URL to the installed schema or checkout works for editor completion.

## Write and calibrate rules

- Put one rule in each Markdown file in `rules_dir`. Its filename stem is the rule ID. Put the actionable diagnostic before the first `---` separator, then specific detection instructions, exceptions, and contrasting examples.
- Add the rule ID under `warn` or `error` in the relevant `rule_sets` entry. Use `match` and `exclude` globs for the smallest useful set of paths. For example, `{"match":["src/**/*.ts"],"warn":{"unsafe-default":0.8}}` applies `unsafe-default.md` as a warning there.
- Start a new rule around `0.8` as a warning. Test representative violations and near misses. Compare model decisions and labels in the gateway before adjusting. Raise the threshold for noisy positive adjudications. When the pipeline misses an issue, refine the rule or annotate the file in the gateway. The client threshold applies to final range confidence.
- Run `nllint --dry-run` to verify selected paths before sending source. Git-ignored files are excluded by default. Use `--include-git-ignored` for a run or `include_git_ignored` in that project's settings if intentionally needed.

## Calibrate false positives on one file

1. Pick one representative false positive and read the source, the exact rule revision, and the adjudicated range. Determine whether the rule is too broad, the code is ambiguous, or the model misapplied a clear rule.
2. Copy the rule to a new Markdown file with a distinct rule ID. Add a temporary `rule_sets` entry whose `match` contains the single file's project-relative path. Enable the variant as a warning and scope the original rule away from that file if you want to isolate the variant's diagnostics.
3. Run `nllint --dry-run`, then `nllint --json`. Inspect the new trace and rule revision after each relevant change. Tighten the rule with concrete criteria, exceptions, or near-miss examples. Check known positives as well as the false positive.
4. Expand the selector to a few related files and repeat. Once both violations and near misses look right, widen the selector to its intended scope. Remove temporary targets and superseded variants when you finish the calibration.
5. Use MCP or REST to annotate clear false positives, missed file decisions, and precise ranges when review labels are useful. File and range annotations flow back into ordinary CLI and IDE diagnostics for the matching source, rule, and prompt. An annotation makes an inline ignore redundant for that version. If the code itself is ambiguous, consider a clearer name or a short explanatory comment first.

## Run and review

- Run `nllint` for a one-shot check or `nllint --json` for structured output. Exit 1 means lint errors or a failed precondition. Exit 2 means the check could not complete.
- Run `nllint watch` for diagnostic snapshots or `nllint watch --stream` for incremental file findings. The IDE uses the same protocol. If credentials or project settings change in the IDE, use **NLLint: Restart Watchers** and inspect **NLLint: Show Output** for errors.
- Filter gateway traces by project, API key, and rule. Use **File decisions** to label whether a file contains a violation. Use **Ranges** to label spans in the source. If the file model missed a violation, label the file as violating and open **Find and annotate ranges** to start the review immediately.

- In VS Code, use **Quick Fix** on a saved NLLint diagnostic to confirm its range or mark it as no violation. The extension uses the gateway key from NLLint credentials, and the gateway records the annotation as human, attributed to the key's owner. The watch stream refreshes diagnostics as gateway changes arrive.
- To sample difficult examples in the gateway, configure a model and a context-search limit under **Agent labelers**. In **Traces**, use **Low file-check confidence** to sample uncertain file decisions. Invoke the labeler on a rule, a file's rules, or matching runs on the current page. **Stop after current run** skips the rest of a batch and keeps completed labels. Then use **Agent and pipeline disagree** to find file or range disagreements, with the highest file-decision confidence first. A saved labeler provides a second opinion. Write a file or range annotation to apply a correction to diagnostics.

## Connect an agent to MCP

The gateway serves Streamable HTTP at `/mcp`. Use a gateway API key as the bearer token. A key authenticates its owning account, so the server can see that account's traces across projects and keys. Set `project` and optionally `key_id` in searches to keep the task scoped.

In Codex CLI, export `NLLINT_GATEWAY_API_KEY` before starting Codex, then register the endpoint once.

```sh
codex mcp add nllint --url "${NLLINT_GATEWAY_BASE_URL%/}/mcp" \
  --bearer-token-env-var NLLINT_GATEWAY_API_KEY
codex mcp list
```

In Claude Code, add the following to the MCP configuration for your local user session. Set both environment variables before launching Claude Code. Variable references keep the credential out of the configuration file.

```json
{
  "mcpServers": {
    "nllint": {
      "type": "http",
      "url": "${NLLINT_GATEWAY_BASE_URL}/mcp",
      "headers": {"Authorization": "Bearer ${NLLINT_GATEWAY_API_KEY}"}
    }
  }
}
```

Use a base URL without a trailing slash in that configuration. Run `/mcp` in Claude Code to verify the connection.

### Find and annotate a run

A trace records one file submission. Each rule cell is a run. Read the run to get its pair ID, which identifies the exact file, rule, and prompt to annotate.

1. Call `search_traces` with a `query` object. For example, `{"project":"demo","path":"src/parser.py","sort":"newest","limit":5}`. `path` and `source_text` are case-insensitive substring matches. You can combine `rule` (exact project-relative rule path), `rule_version` (array of version IDs), `key_id`, `trace_id`, and `min_confidence` or `max_confidence` (file-decision confidence, 0–1).
2. For sampling, set `issues` to a list such as `["agent-disagreements"]` and `sort` to `"confidence-desc"`. Use `["low-confidence"]` with `"confidence-asc"` for uncertain file decisions. Other filters include `file-range-positives`, `adjudicated-positives`, `no-ranges`, `all-rejected`, `rejected-candidates`, `disagreements`, `unreviewed`, and `failed`. `match` combines issues as `"all"` or `"any"` within a run. Continue using `offset` if `more` is true. Use `matching_run_ids` to identify eligible cells.
3. Call `read_run` with the cell's `run_id` to read its source, rule, pipeline results, and existing annotations. Use `read_source` with the parent `trace_id` to read a related traced file. Confirm that the source and rule are the versions you mean to label.
4. Call `annotate_file` with `pair_id`, `run_id`, and `decision` for a file decision. Call `annotate_range` with `pair_id`, one-based inclusive `start` and `end`, and `decision` for a span. Use `true` for a violation and `false` for no violation. A `null` decision clears a label. Optionally pass `identity: {"type":"BOT","model":"provider/model","name":"review agent"}`. MCP records bot attribution automatically and can replace existing bot labels. If a write would replace or clear a human or legacy annotation, or suppress a human-confirmed range with a negative file label, the gateway reports a conflict. Leave the existing decision in place and surface the disagreement for human review.
5. Re-read the run to verify the annotation. Run `nllint --json` or check the IDE diagnostics for the same project to verify how it is applied.

### Use REST

Open `/docs` on the gateway for the REST reference.

Use the same bearer key and send JSON to the corresponding endpoints. Search uses the same object as the MCP `query`.

```sh
curl --fail-with-body "${NLLINT_GATEWAY_BASE_URL%/}/v1/traces/search" \
  -H "Authorization: Bearer $NLLINT_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"project":"demo","issues":["agent-disagreements"],"sort":"confidence-desc","limit":10}'
```

- `GET /v1/runs/{run_id}` returns the run and its file–rule `pair_id`. `GET /v1/traces/{trace_id}/source` returns stored source.
- `PUT /v1/pairs/{pair_id}/file` accepts `{"decision":false,"run_id":123,"labeler_type":"BOT"}`.
- `PUT /v1/pairs/{pair_id}/range` accepts `{"start":8,"end":10,"decision":false,"labeler_type":"BOT","labeler_identity":{"type":"BOT","model":"provider/model"}}`.
- `GET /v1/export/{kind}` streams JSONL for `files`, `ranges`, `adjudication`, `annotated`, or `all`. Add `include_agentic=true` to include agentic results. Both modes carry the attribution of existing labels where available.
- Omitted attribution defaults to `BOT` for bearer-key requests. Use bot attribution for agent writes. Only a signed browser session can produce the webapp signature. IDE annotations use their own API-key origin.

## Optimize a rule against a repeatable evaluation set

1. **Find candidates.** Use `search_traces` with `summary_only: true` to get run IDs, rule version IDs, file decisions, and agent verdicts without source previews or range arrays. Start with low confidence, then include high-confidence disagreements, representative positives, and near-miss negatives. Keep a separate held-out set for the final comparison.
2. **Delegate first-pass labeling.** Use `list_labelers` or `configure_labeler`. For example, pass `{"config":{"name":"parser-review","model":"provider/reasoning-model","max_tool_calls":4,"instructions":"Check parser contracts and distinguish unchecked input from already-validated input."}}`. Call `label_run` with a run ID and the returned labeler ID. Use `label_runs` for up to six IDs at a time. These calls return decisions and ranges while the gateway agent reads the source. Model calls may take a few minutes. Use single-run calls if the MCP client times out on batches. Use the `agent-unlabeled` issue with `agent_labeler_id` to find examples that still need that reviewer.
3. **Audit disagreement without reading everything.** Use `agent-disagreements` with `agent_labeler_id` for pipeline vs. saved agent, `agent-agent-disagreements` with `agent_labeler_id` and `peer_labeler_id` for two saved agents, or `agent-review-disagreements` with `reviewer_origin: "human"` for agent vs. current human labels. Sort by `disagreement` for the most disagreeing rules per trace or by `confidence-desc` for high-confidence hits. Add a second issue with `issues` and choose `match: "all"` or `"any"`. Read only disputed runs and use `annotation_history` to see older human, REST, and MCP edits.
4. **Save the expected answers.** Call `create_eval_set` with a name and run IDs from one baseline rule revision. An example such as `{"run_id":123,"labeler_id":5}` copies a saved agent result. `{"run_id":124,"ranges":[{"start":8,"end":10}]}` records a complete reference range list. Use `ranges: []` for a confirmed negative. `{"run_id":125,"violates":true}` scores only the file verdict. With just a run ID, the set uses the current file annotation. Pass an `annotation_event_id` from `annotation_history` to use a past file decision. Use `list_eval_examples` to recover the exact file list without loading source. Saved references stay fixed when traces are relabeled. Create a separate set if you change which examples or labels you trust.
5. **Score, edit, and rerun.** Call `score_eval_set` with `set_id` and `query: {"rule_version":"<id from search>","threshold":0.8}`. Set the threshold to the target's CLI threshold. The gateway matches the same project, key, file path, and file hash. It keeps the baseline routing version and project prompt fixed by default. Use `routing_version` or `prompt_hash` only when intentionally testing one of those changes. The score uses raw pipeline adjudications. The score excludes annotations and local ignore comments. Inspect false positives and negatives, open the relevant run only when needed, edit the Markdown rule prompt, and run `nllint --json --file src/parser.py --file src/validator.py` with the paths from `list_eval_examples`. Repeat `--file` for each target. Confirm the paths with `--dry-run` before making provider calls. Search for the new rule version and score it against the same set. Review missing, failed, and incomplete counts before comparing scores. Exact-range scores use only references with a complete range list.
6. **Export the dataset you used.** `create_eval_set` returns an authenticated JSONL `export_path`. Alternatively, use **Evaluation sets** in the web app. To download trace records, check rule cells in **Traces** and open **Selected runs**. Choose which agent results, current annotations, and annotation history to download. REST clients can send the same explicit `{trace_id, run_id}` pairs to `POST /v1/export/selection`. Keep held-out source and answers out of edits to the candidate prompt.

Use a stable interpretation of the rule while optimizing wording. If you change what the rule is intended to detect, curate a new reference set for that behavior.
