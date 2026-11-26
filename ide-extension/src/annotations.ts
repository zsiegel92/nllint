import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

export function registerAnnotations(
	context: vscode.ExtensionContext,
	pairFor: (
		uri: vscode.Uri,
		diagnostic: vscode.Diagnostic,
	) => number | undefined,
): void {
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file" },
			{
				provideCodeActions(document, _range, context) {
					if (!vscode.workspace.isTrusted || document.isDirty) return [];
					return context.diagnostics.flatMap((diagnostic) => {
						const pair = pairFor(document.uri, diagnostic);
						if (pair === undefined) return [];
						return [true, false].map((decision) => {
							const title = decision
								? "NLLint: Confirm violation"
								: "NLLint: Mark as no violation";
							const action = new vscode.CodeAction(
								title,
								vscode.CodeActionKind.QuickFix,
							);
							action.diagnostics = [diagnostic];
							action.command = {
								title,
								command: "nllint.annotateRange",
								arguments: [
									document.uri,
									pair,
									diagnostic.range.start.line + 1,
									diagnostic.range.end.line + 1,
									decision,
								],
							};
							return action;
						});
					});
				},
			},
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
		vscode.commands.registerCommand("nllint.annotateRange", annotateRange),
	);
}

async function annotateRange(
	uri: vscode.Uri,
	pair: number,
	start: number,
	end: number,
	decision: boolean,
): Promise<void> {
	if (!vscode.workspace.isTrusted || uri.scheme !== "file") return;
	try {
		if (
			vscode.workspace.textDocuments.some(
				(document) =>
					document.uri.toString() === uri.toString() && document.isDirty,
			)
		) {
			throw new Error(
				"Save the file and wait for NLLint to refresh the diagnostic.",
			);
		}
		const source = await readFile(uri.fsPath, "utf8");
		const { base, key } = await credentials();
		const response = await fetch(`${base}/v1/editor/pairs/${pair}/range`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ source, start, end, decision }),
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			const failure = (await response.json().catch(() => undefined)) as
				| { detail?: unknown }
				| undefined;
			throw new Error(
				typeof failure?.detail === "string"
					? failure.detail
					: `Gateway error (${response.status})`,
			);
		}
		void vscode.window.showInformationMessage("NLLint annotation saved.");
	} catch (error) {
		void vscode.window.showErrorMessage(
			`NLLint: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function credentials(): Promise<{ base: string; key: string }> {
	const config = path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
		"nllint",
		"config.json",
	);
	const contents = await readFile(config, "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "{}";
			throw error;
		},
	);
	const saved = JSON.parse(contents) as {
		gateway_base_url?: string;
		gateway_api_key?: string;
	};
	const base =
		process.env.NLLINT_GATEWAY_BASE_URL?.trim() || saved.gateway_base_url;
	const key =
		process.env.NLLINT_GATEWAY_API_KEY?.trim() || saved.gateway_api_key;
	if (!base || !key)
		throw new Error(
			"Configure the gateway URL and API key in NLLint credentials.",
		);
	return { base: base.replace(/\/+$/, ""), key };
}
