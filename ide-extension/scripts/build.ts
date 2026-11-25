import { context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("schema", { recursive: true });
await copyFile("../schema/nllint.schema.json", "schema/nllint.schema.json");

const build = await context({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["vscode"],
	outfile: "dist/extension.cjs",
	sourcemap: true,
	sourcesContent: false,
	logLevel: "info",
});

if (process.argv.includes("--watch")) {
	await build.watch();
	console.log("Watching NLLint extension sources...");
} else {
	await build.rebuild();
	await build.dispose();
}
