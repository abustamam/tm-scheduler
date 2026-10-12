/**
 * Page counts and fit for the printable meeting sign (#1167).
 *
 * The sign is one letter-LANDSCAPE sheet, and "one sheet" is a consequence of
 * geometry only a browser can see: a name that wrapped to a third line, or a
 * wrapper's padding, would push it onto a second page with every jsdom test
 * green. Same harness as `print-page-count.test.tsx` (skips without Chrome; CI
 * fails if Chrome is missing).
 *
 * Two readings, because the count alone is blind here: the sheet is
 * `overflow: hidden`, so a clamped-away third line of the club name still prints
 * as one page. The sheet's `scrollHeight` is what sees content that has outgrown
 * it, so it is asserted equal to the sheet's 816px height.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
	printedPageCount,
} from "#/test/print-page-count";
import { MeetingSign, type SignArrow } from "./meeting-sign";
import { pageBox, printPageCss } from "./print-theme";

const FIXTURES = {
	short: "THR Speaking Club",
	fortyChars: "Downtown Lunchtime Communicators Society",
	// One unbroken 60-character word: only `overflow-wrap: anywhere` can break it.
	unbroken: "W".repeat(60),
	// Far past two lines at the smaller size: only the line clamp holds this.
	absurd: "Metropolitan Professional Speakers ".repeat(12).trim(),
} as const;

/** The route's markup: the stylesheet it serves, and its `.pgwrap` wrapper. */
function signHtml(clubName: string, arrow: SignArrow): string {
	return printableDocument(
		printPageCss("landscape"),
		renderToStaticMarkup(
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<MeetingSign clubName={clubName} arrow={arrow} />
			</div>,
		),
	);
}

/**
 * How the club name actually laid out (`offsetHeight`, a LAYOUT size: the screen fit
 * scales the sheet with a transform, and a bounding rect would report that): its box height in lines, and whether its
 * text spills sideways. Neither is visible to the page count or the sheet's
 * `scrollHeight`: the name box is `overflow: hidden`, so a dropped line clamp
 * leaves the sheet at 816px with the name quietly clipped, and a dropped
 * `overflow-wrap` leaves one long word running out of its box. "Spills" allows
 * 40px: the clamp's ellipsis sits a few px past the last glyph (13px measured),
 * while an unwrapped 60-letter word is ~1400px past.
 */
function nameLayout(html: string): { lines: number; spills: boolean } {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const probe = `<script>
	(function () {
		var el = document.querySelector('[data-testid="sign-club-name"]');
		var lh = parseFloat(getComputedStyle(el).lineHeight);
		document.title = [Math.round(el.offsetHeight / lh), el.scrollWidth > el.clientWidth + 40 ? 1 : 0].join("|");
	})();
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "sign-name-"));
	try {
		const htmlPath = join(dir, "page.html");
		writeFileSync(htmlPath, html.replace("</body>", `${probe}</body>`), "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${htmlPath}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 10_000, env: CHROME_ENV },
		);
		const [lines, spills] = (dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? "")
			.split("|")
			.map(Number);
		if (lines === undefined || spills === undefined || Number.isNaN(lines)) {
			throw new Error("The name probe did not run");
		}
		return { lines, spills: spills === 1 };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const hasChrome = findChrome() !== null;

describe("meeting sign page-count harness availability", () => {
	it("has a browser to print with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the meeting sign's page-count assertions would " +
				"skip and the suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"meeting sign printed page counts",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const variants: Array<[string, SignArrow]> = [
			["no arrow", null],
			["arrow left", "left"],
			["arrow right", "right"],
		];

		it.each(variants)("%s prints exactly one landscape page", (_l, arrow) => {
			expect(printedPageCount(signHtml(FIXTURES.short, arrow))).toBe(1);
		});

		it.each(
			Object.entries(FIXTURES),
		)("a %s club name stays on one page and inside the sheet, in every variant", (_k, name) => {
			const sheetH = pageBox("landscape").height;
			for (const [, arrow] of variants) {
				const html = signHtml(name, arrow);
				expect(printedPageCount(html)).toBe(1);
				const [sheet] = measuredHeights(html, [".agenda-page"]);
				expect(sheet, `${name} (${arrow}) outgrew the sheet`).toBe(sheetH);
			}
		});

		it.each(
			Object.entries(FIXTURES),
		)("a %s club name lays out in at most two lines without spilling sideways", (_k, name) => {
			const { lines, spills } = nameLayout(signHtml(name, null));
			expect(lines).toBeLessThanOrEqual(2);
			expect(lines).toBeGreaterThanOrEqual(1);
			expect(spills).toBe(false);
		});
	},
);
