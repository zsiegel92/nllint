import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveAnnotationPair } from "./annotation-target.js";

const diagnostic = {
	source: "nllint",
	code: "sample-rule",
	message: "Use the validated input",
	range: { start: { line: 1, character: 4 }, end: { line: 2, character: 99 } },
};

test("resolves a copied diagnostic with normalized columns", () => {
	const originals = [{ ...diagnostic, pair: 14 }];
	const copy = {
		...diagnostic,
		range: {
			start: { line: 1, character: 4 },
			end: { line: 2, character: 20 },
		},
	};
	assert.equal(
		resolveAnnotationPair(copy, originals, (item) => item.pair),
		14,
	);
});

test("skips ambiguous diagnostics from overlapping watchers", () => {
	const originals = [
		{ ...diagnostic, pair: 14 },
		{ ...diagnostic, pair: 15 },
	];
	assert.equal(
		resolveAnnotationPair(diagnostic, originals, (item) => item.pair),
		undefined,
	);
});
