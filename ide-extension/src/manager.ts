import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { DiagnosticStore } from "./diagnostics.js";
import type { Snapshot, WatchMessage } from "./protocol.js";
import { type TraceLevel, WatchSession } from "./watcher.js";

type WatcherState =
	| { kind: "running" }
	| { kind: "snapshot"; snapshot: Snapshot }
	| { kind: "unavailable"; message: string };

export class NLLintManager implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel("NLLint");
	private readonly status = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100,
	);
	private readonly diagnostics = new DiagnosticStore();
	private readonly sessions = new Map<string, WatchSession>();
	private readonly states = new Map<string, WatcherState>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private refreshTimer: NodeJS.Timeout | undefined;
	private refreshGeneration = 0;
	private disposed = false;

	constructor(context: vscode.ExtensionContext) {
		this.status.command = "nllint.showOutput";
		this.status.name = "NLLint";
		this.subscriptions.push(
			vscode.commands.registerCommand("nllint.restart", () => this.restart()),
			vscode.commands.registerCommand("nllint.showOutput", () =>
				this.output.show(),
			),
			vscode.workspace.onDidChangeWorkspaceFolders(() =>
				this.scheduleRefresh(),
			),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("nllint")) void this.restart();
			}),
		);

		const configs =
			vscode.workspace.createFileSystemWatcher("**/.nllintrc.jsonc");
		this.subscriptions.push(
			configs,
			configs.onDidCreate(() => this.scheduleRefresh()),
			configs.onDidDelete(() => this.scheduleRefresh()),
			configs.onDidChange(() => this.scheduleRefresh()),
		);
		if (!vscode.workspace.isTrusted) {
			this.status.text = "$(lock) NLLint";
			this.status.tooltip =
				"NLLint is disabled until this workspace is trusted.";
			this.status.show();
			this.subscriptions.push(
				vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
			);
		}
		context.subscriptions.push(this);
	}

	async start(): Promise<void> {
		if (vscode.workspace.isTrusted) await this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		this.refreshGeneration += 1;
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		this.states.clear();
		for (const subscription of this.subscriptions) subscription.dispose();
		this.diagnostics.dispose();
		this.status.dispose();
		this.output.dispose();
	}

	private async restart(): Promise<void> {
		this.stopAll();
		await this.refresh();
	}

	private stopAll(): void {
		for (const [id, session] of this.sessions) {
			session.dispose();
			this.diagnostics.remove(id);
		}
		this.sessions.clear();
		this.states.clear();
		this.refreshStatus();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, 200);
	}

	private async refresh(): Promise<void> {
		if (this.disposed || !vscode.workspace.isTrusted) return;
		const generation = ++this.refreshGeneration;
		const executable = resolveExecutable();
		const paths = await discoverConfigs(executable, (message) =>
			this.output.appendLine(message),
		);
		if (this.disposed || generation !== this.refreshGeneration) return;

		const desired = new Set(paths);
		for (const [id, session] of this.sessions) {
			if (!desired.has(id)) {
				session.dispose();
				this.sessions.delete(id);
				this.states.delete(id);
				this.diagnostics.remove(id);
			}
		}
		for (const configPath of paths) {
			if (this.sessions.has(configPath)) continue;
			const session = new WatchSession(configPath, executable, {
				onMessage: (id, message) => this.handleMessage(id, message),
				onUnavailable: (id, message) => this.handleUnavailable(id, message),
				log: (message) => this.output.appendLine(message),
				traceLevel: () => traceLevel(),
			});
			this.sessions.set(configPath, session);
			this.states.set(configPath, { kind: "running" });
			session.start();
		}
		if (paths.length === 0)
			this.output.appendLine("No project settings found.");
		this.refreshStatus();
	}

	private handleMessage(id: string, message: WatchMessage): void {
		if (!this.sessions.has(id)) return;
		if (message.kind === "run_started") {
			this.states.set(id, { kind: "running" });
		} else if (message.kind === "file_result") {
			this.diagnostics.updateFile(id, message);
		} else {
			this.states.set(id, { kind: "snapshot", snapshot: message });
			this.diagnostics.update(id, message);
			if (message.status === "error" && message.error !== null) {
				this.output.appendLine(`[${id}] ${message.error}`);
			}
			if (message.precondition !== null) {
				this.output.appendLine(
					`[${id}] precondition failed: ${message.precondition.command.join(" ")}`,
				);
				if (message.precondition.output.length > 0) {
					this.output.appendLine(message.precondition.output);
				}
			}
		}
		this.refreshStatus();
	}

	private handleUnavailable(id: string, message: string): void {
		if (!this.sessions.has(id)) return;
		this.states.set(id, { kind: "unavailable", message });
		this.diagnostics.remove(id);
		this.refreshStatus();
	}

	private refreshStatus(): void {
		if (this.sessions.size === 0) {
			this.status.hide();
			return;
		}
		const states = [...this.states.values()];
		const unavailable = states.find((state) => state.kind === "unavailable");
		if (unavailable?.kind === "unavailable") {
			this.status.text = "$(error) NLLint unavailable";
			this.status.tooltip = unavailable.message;
		} else if (states.some((state) => state.kind === "running")) {
			this.status.text = "$(sync~spin) NLLint";
			this.status.tooltip = "NLLint is checking the workspace.";
		} else {
			const snapshots = states.flatMap((state) =>
				state.kind === "snapshot" ? [state.snapshot] : [],
			);
			const failed = snapshots.find(
				(snapshot) =>
					snapshot.status === "error" ||
					snapshot.status === "precondition_failed",
			);
			const errors = countSeverity(snapshots, "error");
			const warnings = countSeverity(snapshots, "warning");
			if (failed !== undefined) {
				this.status.text = "$(error) NLLint blocked";
				this.status.tooltip =
					failed.error ??
					"A configured precondition failed. See NLLint output.";
			} else if (errors > 0) {
				this.status.text = `$(error) NLLint ${errors}`;
				this.status.tooltip = `${errors} errors and ${warnings} warnings`;
			} else if (warnings > 0) {
				this.status.text = `$(warning) NLLint ${warnings}`;
				this.status.tooltip = `${warnings} warnings`;
			} else {
				this.status.text = "$(check) NLLint";
				this.status.tooltip = "No NLLint violations.";
			}
		}
		this.status.show();
	}
}

function configuration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration("nllint");
}

function traceLevel(): TraceLevel {
	const value = configuration().get<string>("trace.server", "off");
	return value === "messages" || value === "verbose" ? value : "off";
}

function resolveExecutable(): string {
	const configured = configuration().get<string>("executablePath", "nllint");
	if (configured !== "nllint") return configured;
	const localInstall = path.join(os.homedir(), ".local", "bin", "nllint");
	return existsSync(localInstall) ? localInstall : configured;
}

async function discoverConfigs(
	executable: string,
	log: (message: string) => void,
): Promise<string[]> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const found = await Promise.all(
		folders
			.filter((folder) => ["file", "vscode-remote"].includes(folder.uri.scheme))
			.map(async (folder) => {
				const files = await vscode.workspace.findFiles(
					new vscode.RelativePattern(folder, "**/.nllintrc.jsonc"),
					"**/{.git,.nllint,node_modules,target,.venv,venv}/**",
				);
				if (files.length) return files.map((uri) => uri.fsPath);
				return new Promise<string[]>((resolve) => {
					execFile(
						executable,
						["config-path"],
						{
							cwd: folder.uri.fsPath,
							timeout: 5000,
							windowsHide: true,
						},
						(error, stdout, stderr) => {
							if (error)
								log(`[${folder.uri.fsPath}] ${stderr.trim() || error.message}`);
							const config = stdout.trim();
							resolve(!error && config ? [config] : []);
						},
					);
				});
			}),
	);
	return [...new Set(found.flat())].sort();
}

function countSeverity(
	snapshots: readonly Snapshot[],
	severity: "error" | "warning",
): number {
	return snapshots.reduce(
		(total, snapshot) =>
			total +
			snapshot.diagnostics.filter(
				(diagnostic) => diagnostic.severity === severity,
			).length,
		0,
	);
}
