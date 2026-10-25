// Real-cascade check for the styles.css foundation (#1306): compiles
// `src/styles.css` with Tailwind, loads it in Chrome, and reads computed
// styles. Skips without Chrome like the other browser suites
// (`docs/agents/commands.md`: set CHROME_PATH on a Mac).
//
// protects: the `ease-enter` utility exists and computes the token's curve;
//   `bg-surface-raised` / `text-link` resolve to the same colour as the brand
//   var they alias, in light and dark.
// fails_when: an alias or the @theme easing is missing or mistyped (Tailwind
//   then emits no rule and the computed value is the default).
// no_claim: nothing about components; none uses the aliases yet.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	printableDocument,
} from "#/test/print-page-count";

const SRC = dirname(fileURLToPath(import.meta.url));
const chrome = findChrome();

type Report = Record<string, string>;

async function measure(): Promise<Report> {
	const compiler = await compile(
		readFileSync(resolve(SRC, "styles.css"), "utf8"),
		{ base: SRC, onDependency: () => {} },
	);
	const css = compiler.build([
		"ease-enter",
		"bg-surface-raised",
		"text-link",
		"bg-[var(--surface-strong)]",
		"text-[var(--lagoon-deep)]",
	]);
	const body = `
<div id="ease" class="ease-enter"></div>
<div id="light"><i id="l-raised" class="bg-surface-raised"></i><i id="l-var" class="bg-[var(--surface-strong)]"></i><b id="l-link" class="text-link"></b><b id="l-linkvar" class="text-[var(--lagoon-deep)]"></b></div>
<div id="dark" class="dark"><i id="d-raised" class="bg-surface-raised"></i><i id="d-var" class="bg-[var(--surface-strong)]"></i><b id="d-link" class="text-link"></b><b id="d-linkvar" class="text-[var(--lagoon-deep)]"></b></div>
<script>
var out = {};
var cs = function (id, prop) { return getComputedStyle(document.getElementById(id))[prop]; };
out.ease = cs("ease", "transitionTimingFunction");
["l","d"].forEach(function (k) {
	out[k + "raised"] = cs(k + "-raised", "backgroundColor");
	out[k + "var"] = cs(k + "-var", "backgroundColor");
	out[k + "link"] = cs(k + "-link", "color");
	out[k + "linkvar"] = cs(k + "-linkvar", "color");
});
document.documentElement.setAttribute("data-result", encodeURIComponent(JSON.stringify(out)));
</script>`;
	const dir = mkdtempSync(join(tmpdir(), "styles-foundation-"));
	try {
		// Drop the Google Fonts @import: the harness blocks the network anyway.
		writeFileSync(
			join(dir, "page.html"),
			printableDocument(css.replace(/@import url\([^)]*\);?/g, ""), body),
		);
		const dom = execFileSync(
			chrome as string,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 50_000, env: CHROME_ENV },
		);
		const raw = /data-result="([^"]*)"/.exec(dom)?.[1];
		if (raw === undefined) throw new Error("the page never reported");
		return JSON.parse(decodeURIComponent(raw)) as Report;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe.skipIf(!chrome)("styles.css foundation in Chrome (#1306)", () => {
	let report: Report;
	const get = async () => (report ??= await measure());

	it(
		"ease-enter computes the token's curve",
		async () => {
			expect((await get()).ease).toBe("cubic-bezier(0.2, 0, 0, 1)");
		},
		CHROME_TEST_TIMEOUT_MS,
	);

	it(
		"surface-raised and link equal the vars they alias, in light and dark",
		async () => {
			const r = await get();
			for (const k of ["l", "d"]) {
				expect(r[`${k}var`], `${k} bg var resolved`).toMatch(/^rgb/);
				expect(r[`${k}raised`], `${k} bg-surface-raised`).toBe(r[`${k}var`]);
				expect(r[`${k}linkvar`], `${k} text var resolved`).toMatch(/^rgb/);
				expect(r[`${k}link`], `${k} text-link`).toBe(r[`${k}linkvar`]);
			}
			// Light and dark must really differ, or the dark half proves nothing.
			expect(r.lraised).not.toBe(r.draised);
			expect(r.llink).not.toBe(r.dlink);
		},
		CHROME_TEST_TIMEOUT_MS,
	);
});
