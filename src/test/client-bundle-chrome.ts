/**
 * Run a CLIENT-rendered React entry in headless Chrome and read back what it
 * reported, so a test can see an effect that `renderToStaticMarkup` never runs
 * (`FitPage`'s measure-then-scale-or-flow decision, #1179 / #1181).
 *
 * The entry is bundled with vite (no `tanstackStart` plugin, so nothing reaches
 * the server graph), written next to an HTML document carrying the print
 * stylesheet, and loaded with `--dump-dom`. The entry reports by calling
 * `window.__report(value)`; the value is read back from `data-result` on
 * `<html>`, URL-encoded so no markup in it can disturb the dump.
 *
 * Same caveat as every browser-backed suite here (`docs/agents/commands.md`):
 * no webfont resolves, so a height measured through this is NOT comparable to
 * one measured on the deployed page. Comparable to each other, and to the
 * fallback the page lays out in.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import {
	CHROME_ENV,
	findChrome,
	printableDocument,
} from "#/test/print-page-count";

const ROOT = resolve(__dirname, "..", "..");

/** One bundle per entry per process: a bundle costs seconds, a case costs a launch. */
const bundles = new Map<string, Promise<string>>();

/** `from` is matched as a whole module id, `to` is a path under the repo root. */
export type ClientAlias = Record<string, string>;

export function bundleClientEntry(
	entry: string,
	alias: ClientAlias = {},
): Promise<string> {
	const key = JSON.stringify([entry, alias]);
	const hit = bundles.get(key);
	if (hit) return hit;
	const made = (async () => {
		const out = await build({
			configFile: false,
			mode: "production",
			root: ROOT,
			logLevel: "silent",
			resolve: {
				tsconfigPaths: true,
				alias: Object.entries(alias).map(([from, to]) => ({
					find: new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
					replacement: resolve(ROOT, to),
				})),
			},
			oxc: { jsx: { runtime: "automatic", development: false } },
			define: { "process.env.NODE_ENV": JSON.stringify("production") },
			build: {
				write: false,
				minify: false,
				lib: { entry, formats: ["iife"], name: "ClientEntry" },
			},
		});
		const outputs = Array.isArray(out) ? out : [out];
		for (const o of outputs) {
			if (!("output" in o)) continue;
			for (const chunk of o.output) {
				if (chunk.type === "chunk" && chunk.isEntry) return chunk.code;
			}
		}
		throw new Error(`vite produced no entry chunk for ${entry}`);
	})();
	bundles.set(key, made);
	return made;
}

/**
 * Bundle `entry`, load it in Chrome with `css` as the page stylesheet and
 * `globals` as `window.__INPUT__`, and return what it handed `window.__report`.
 * Throws when the entry never reports, naming what the page did log, so a
 * crash in the bundle is a failure and not an empty result.
 */
export async function runClientEntry<T>(
	entry: string,
	css: string,
	globals: unknown,
	alias: ClientAlias = {},
): Promise<T> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");
	const code = await bundleClientEntry(entry, alias);
	const dir = mkdtempSync(join(tmpdir(), "client-bundle-"));
	try {
		writeFileSync(join(dir, "bundle.js"), code, "utf8");
		const html = printableDocument(
			css,
			`<div id="root"></div>
<script>
window.__INPUT__ = ${JSON.stringify(globals)};
window.__report = function (v) {
	document.documentElement.setAttribute("data-result", encodeURIComponent(JSON.stringify(v)));
};
window.addEventListener("unhandledrejection", function (e) {
	document.documentElement.setAttribute("data-error", encodeURIComponent(String(e.reason && e.reason.stack || e.reason)));
});
window.addEventListener("error", function (e) {
	document.documentElement.setAttribute("data-error", encodeURIComponent(String(e.message)));
});
</script>
<script src="bundle.js"></script>`,
		);
		writeFileSync(join(dir, "page.html"), html, "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				"--window-size=1400,1000",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--virtual-time-budget=120000",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 50_000, env: CHROME_ENV },
		);
		const result = /data-result="([^"]*)"/.exec(dom)?.[1];
		if (result === undefined) {
			const err = /data-error="([^"]*)"/.exec(dom)?.[1];
			throw new Error(
				`the client entry never reported${err ? `: ${decodeURIComponent(err)}` : ""}`,
			);
		}
		return JSON.parse(decodeURIComponent(result)) as T;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
