import type { Diagnostic } from "vscode";

type DiagnosticLocation = Pick<Diagnostic, "source" | "code" | "message"> & {
	range: { start: { line: number }; end: { line: number } };
};

export function resolveAnnotationPair<T extends DiagnosticLocation>(
	diagnostic: DiagnosticLocation,
	candidates: readonly T[],
	pairFor: (candidate: T) => number | undefined,
): number | undefined {
	if (diagnostic.source !== "nllint") return undefined;
	const rule =
		typeof diagnostic.code === "object"
			? diagnostic.code.value
			: diagnostic.code;
	const pairs = new Set<number | undefined>();
	for (const candidate of candidates) {
		const candidateRule =
			typeof candidate.code === "object"
				? candidate.code.value
				: candidate.code;
		// VS Code can copy diagnostics and normalize their columns before requesting actions.
		if (
			candidateRule === rule &&
			candidate.message === diagnostic.message &&
			candidate.range.start.line === diagnostic.range.start.line &&
			candidate.range.end.line === diagnostic.range.end.line
		) {
			pairs.add(pairFor(candidate));
		}
	}
	return pairs.size === 1 ? pairs.values().next().value : undefined;
}
