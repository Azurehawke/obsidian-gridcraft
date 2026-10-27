// Bundles the plugin into main.js.
//
//   node esbuild.config.mjs              development build (watches; loads engine.wasm from the plugin folder)
//   node esbuild.config.mjs production   release build (fingerprints the engine built by scripts/build-engine.sh)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const prod = process.argv[2] === "production";
const wasmPath = "engine/pkg/gridcraft_obsidian_engine_bg.wasm";

if (!existsSync("engine/pkg/gridcraft_obsidian_engine.js")) {
	console.error("The engine isn't built yet. Run `npm run engine` first.");
	process.exit(1);
}

// A release build pins the exact engine it was built with: the plugin downloads that file and
// refuses any other. A development build leaves this empty and loads engine.wasm as-is.
let engineSha256 = "";
if (prod) {
	engineSha256 = createHash("sha256").update(readFileSync(wasmPath)).digest("hex");
	console.log(`engine sha256 ${engineSha256}`);
}

const repo = process.env.GITHUB_REPOSITORY || "Azurehawke/obsidian-gridcraft";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	define: {
		ENGINE_SHA256: JSON.stringify(engineSha256),
		ENGINE_REPO: JSON.stringify(repo),
		// The engine glue only falls back to fetching its .wasm by URL when it isn't handed
		// the bytes; the plugin always hands them over.
		"import.meta.url": JSON.stringify("app://gridcraft-viewer/"),
	},
});

if (prod) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
