# NLLint for VS Code

The extension starts one `nllint watch --stream` process per configured project in a trusted workspace. Findings appear in native editor diagnostics and the Problems panel. Diagnostic codes link to the Markdown rules. The extension supports multi-root workspaces and restarts failed watch processes with backoff.

## Install

From the NLLint checkout run:

```sh
./install-to-path.sh
./ide-extension/install.sh
```

The extension installer checks and builds the code, packages `nllint-vscode.vsix`, and installs it using `code`. Set `CODE_BIN` for another compatible VS Code CLI. For SSH or a dev container, install and configure NLLint where the workspace extension host runs.

## Configure

The extension discovers `.nllintrc.jsonc` files in the workspace. When it finds none in a folder, it asks the CLI to find the settings for that project, including a matching global `settings.jsonc`. It contributes the project JSON Schema for `.nllintrc.jsonc` files.

Set `NLLINT_GATEWAY_BASE_URL` and `NLLINT_GATEWAY_API_KEY` on the extension host or store them in `~/.config/nllint/config.json`. Use the keys `gateway_base_url` and `gateway_api_key` in that JSON file. The binary defaults to `nllint` on `PATH` and can fall back to `~/.local/bin/nllint`. Set `nllint.executablePath` to override it.

Run **NLLint: Restart Watchers** after adding external settings or changing credentials. Use **NLLint: Show Output** for errors and precondition output. Set `nllint.trace.server` to `messages` or `verbose` to inspect the watch protocol.

For development, run `pnpm install --frozen-lockfile`, `pnpm check`, and `pnpm build` in this directory.
