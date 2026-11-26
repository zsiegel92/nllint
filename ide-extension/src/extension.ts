import type * as vscode from "vscode";
import { registerAnnotations } from "./annotations.js";
import { NLLintManager } from "./manager.js";

export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	registerAnnotations(context);
	const manager = new NLLintManager(context);
	await manager.start();
}

export function deactivate(): void {}
