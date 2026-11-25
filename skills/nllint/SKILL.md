---
name: nllint
description: Configure or run NLLint in a project, author natural-language lint rules and thresholds, or set up its gateway API key and IDE watcher.
---

# Use NLLint

NLLint sends configured source files and Markdown rules to a gateway and reports confirmed line ranges. Use the intended gateway for the project.

## Set up the client

1. Install the CLI with `./install-to-path.sh` from the NLLint checkout. For VS Code, tell the user to run `./ide-extension/install.sh` from that checkout. This builds and installs the VSIX using `code`. Set `CODE_BIN` for a different compatible CLI. For a remote workspace, install the CLI on the extension host.
2. Open the gateway control plane, sign in with an allowed GitHub account or the local development token, and choose **API keys → Create API key**. Name the key for the app or environment and save the secret shown at creation. For unattended use, set `NLLINT_GATEWAY_BASE_URL` and `NLLINT_GATEWAY_API_KEY`. For an IDE launched outside the terminal, use `~/.config/nllint/config.json` (or under `XDG_CONFIG_HOME`) with `gateway_base_url` and `gateway_api_key`. Keep credentials out of source control.
3. From the target repo, run `nllint init` to create `.nllintrc.jsonc`, a starter rule, and a prompt. For private project settings, put `settings.jsonc` in `~/.config/nllint/projects/<name>/` and set `project_root` to the project's absolute directory. Place its `rules_dir` and optional `system_prompt` beside those settings. File globs are relative to the target project in either mode. An in-repo config takes precedence.

The checkout provides `schema/nllint.schema.json` for project JSONC and `schema/credentials.schema.json` for client JSON. A `file://` URL to the installed schema or checkout works for editor completion.

## Write and calibrate rules

- Put one rule in each Markdown file in `rules_dir`. Its filename stem is the rule ID. Put the actionable diagnostic before the first `---` separator, then specific detection instructions, exceptions, and contrasting examples.
- Add the rule ID under `warn` or `error` in the relevant `rule_sets` entry. Use `match` and `exclude` globs for the smallest useful set of paths. For example, `{"match":["src/**/*.ts"],"warn":{"unsafe-default":0.8}}` applies `unsafe-default.md` as a warning there.
- Start a new rule around `0.8` as a warning. Test representative violations and near misses. Compare model decisions and labels in the gateway before adjusting. Raise the threshold for noisy positive adjudications. When candidate identification misses an issue entirely, refine the rule or annotate the file in the gateway. The client threshold applies to final range confidence.
- Run `nllint --dry-run` to verify selected paths before sending source. Git-ignored files are excluded by default. Use `--include-git-ignored` for a run or `include_git_ignored` in that project's settings if intentionally needed.

## Run and review

- Run `nllint` for a one-shot check or `nllint --json` for structured output. Exit 1 means lint errors or a failed precondition. Exit 2 means the check could not complete.
- Run `nllint watch` for diagnostic snapshots or `nllint watch --stream` for incremental file findings. The IDE uses the same protocol. If credentials or project settings change in the IDE, use **NLLint: Restart Watchers** and inspect **NLLint: Show Output** for errors.
- Filter gateway traces by project, API key, and rule. Use **File decisions** to label whether a file contains a violation. Use **Adjudication** or **Ranges** to label snippets. If the file model missed a violation, label the file as violating and open **Find and annotate ranges** to start the review immediately.
