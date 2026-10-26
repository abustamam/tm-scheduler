/**
 * `Button size="touch"` is 44px tall on a phone and 32px from `md` up (#1307).
 *
 * jsdom performs no layout and a Tailwind class string is just text there, so
 * the only way to see that `h-11 md:h-8` actually produces those heights, and
 * that tailwind-merge did not drop one of the pair, is to build the app CSS and
 * measure in Chrome. Same construction as `marketing-header-geometry.test.ts`:
 * the real `buttonVariants` class string, synthetic markup.
 *
 * protects: the 44px phone / 32px desktop heights of the `touch` size.
 * fails_when: the `md:h-8` half is lost (desktop stays 44), the `h-11` half is
 *   lost (phone stays 32), or the size is renamed out from under its callers.
 * no_claim: says nothing about which buttons use `touch`; the component tests
 *   pin `data-size="touch"` on each.
 *
 * The phone is a 600px window, not 375: Chrome clamps a headless window to a
 * minimum width on CI's google-chrome, and a media query reads the WINDOW, so a
 * frame would not move `md`. 600 is under `md` (768) on every build, and the
 * probe records `innerWidth` so a clamp past `md` fails loudly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buttonVariants } from "#/components/ui/button";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";

function measure(
	html: string,
	css: string,
	windowWidth: number,
): { inner: number; touch: number; sm: number } {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");
	const probe = `<script>
		var t = document.getElementById("touch").getBoundingClientRect().height;
		var s = document.getElementById("sm").getBoundingClientRect().height;
		document.title = "inner=" + window.innerWidth + ";touch=" + t + ";sm=" + s;
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "button-touch-"));
	try {
		writeFileSync(join(dir, "app.css"), css, "utf8");
		writeFileSync(
			join(dir, "page.html"),
			`<!doctype html><html><head><meta charset="utf-8">` +
				`<link rel="stylesheet" href="./app.css"></head><body style="margin:0">${html}${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				`--window-size=${windowWidth},800`,
				"--virtual-time-budget=3000",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
				env: CHROME_ENV,
			},
		);
		const title = /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? "";
		if (!title.includes("touch=")) {
			throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
		}
		const kv = new Map(
			title.split(";").map((p) => p.split("=") as [string, string]),
		);
		return {
			inner: Number(kv.get("inner")),
			touch: Number(kv.get("touch")),
			sm: Number(kv.get("sm")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const hasChrome = findChrome() !== null;

describe("button touch geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome, so the geometry gate would skip").toBe(
			true,
		);
	});
});

describe.skipIf(!hasChrome)(
	"Button size=touch",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let html = "";
		beforeAll(async () => {
			html =
				`<button id="touch" class="${buttonVariants({ variant: "outline", size: "touch" })}">Present</button>` +
				`<button id="sm" class="${buttonVariants({ variant: "outline", size: "sm" })}">Present</button>`;
			// `flex` on a wrapper: buildAppCss refuses CSS with no `display:flex`,
			// and `buttonVariants` only emits `inline-flex`.
			css = await buildAppCss(candidatesIn(`<div class="flex">${html}</div>`));
		});

		it("is 44px tall on a phone", () => {
			const m = measure(html, css, 600);
			expect(m.inner, "the window must stay under md (768px)").toBeLessThan(
				768,
			);
			expect(m.touch).toBe(44);
			// The control: `sm` is 32 here, so a pass is not "every button is 44".
			expect(m.sm).toBe(32);
		});

		it("is 32px tall from md up", () => {
			const m = measure(html, css, 1280);
			expect(m.inner).toBeGreaterThanOrEqual(768);
			expect(m.touch).toBe(32);
			expect(m.sm).toBe(32);
		});
	},
);
