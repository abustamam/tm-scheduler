import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	SPLASH_LOGO_HEIGHT_PCT,
	SPLASH_LOGO_MAX_WIDTH_PCT,
} from "#/lib/slide-layout";
import { readSource } from "#/test/guard-source";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

/**
 * How big the club's logo actually RENDERS on a projected splash, and whether
 * the column it leads still fits the 16:9 frame (#725).
 *
 * Nothing else here can see either. `meeting-present.test.tsx` runs in jsdom,
 * which does no layout: it can assert that `height: "15cqw"` reached the
 * `<img>`, and it would assert exactly the same thing for `0.15cqw`, for a
 * column three times too tall for the frame, and for a 10:1 banner running off
 * both edges of the slide. The splash has no `useFitTransform` either — unlike
 * a content slide, nothing shrinks it to fit — so "too tall" means the sub
 * lines render outside the coloured panel, on the black page behind it.
 *
 * Same split as the other browser-backed gates in this repo: the SEAM is
 * `SPLASH_LOGO_HEIGHT_PCT` / `SPLASH_LOGO_MAX_WIDTH_PCT`, imported from the
 * module the component imports them from, so the fixture cannot agree with
 * itself and disagree with the shipped slide. The markup between them is
 * synthetic (mounting the real `MeetingPresent` needs a router context and a
 * mocked `#/server/voting`), so the class strings it models are pinned against
 * source at the bottom of this file.
 *
 * A PRE-FIX CONTROL renders beside every fixed case: the arrangement that
 * shipped before #725, a 9cqw logo stacked above the word with a 2.2cqw gap.
 * Without it, a fixture that could never overflow would pass every assertion
 * here for any logo size at all — including one too small to read.
 *
 * Numbers measured through this harness are not comparable to the deployed
 * deck: it runs with `MAP * ~NOTFOUND`, so Fraunces and Manrope never load and
 * the platform's substitute has its own metrics.
 *
 * The NOISE FLOOR, though, is zero, which is why the absolute heights below can
 * be asserted against the frame at all: every element on a splash carries an
 * explicit NUMERIC line-height (`leading-tight`, `leading-snug`, or preflight's
 * 1.5), so each line box is `font-size x ratio` and no glyph metric enters the
 * sum. Measured across Noto Sans, DejaVu Sans, Liberation Sans and FreeSans —
 * the four a runner is likely to substitute — the column came out at exactly
 * 680px every time, and the pre-fix control at exactly 745px. What this metric
 * CANNOT see is wrapping: a club name long enough to take a second headline
 * line adds ~100px and would overflow, which it does today as well (a
 * pre-existing condition this change improves but does not fix).
 */
const hasChrome = findChrome() !== null;

/** A 720p slide: the frame is `aspect-ratio: 16/9` on a container-query box, so
 *  `1cqw` is 12.8px here and every length below is a proportion of the width. */
const FRAME_W = 1280;
const FRAME_H = 720;

/** The logo height before #725, when the word "Toastmasters" sat beneath it. */
const PRE_FIX_LOGO_PCT = 9;
/** …and the ceiling it carried. */
const PRE_FIX_MAX_WIDTH_PCT = 46;

/** An image with a real intrinsic size, so `width: auto` has a ratio to use.
 *  A data URI rather than a file: the harness resolves no hostnames. */
function logoSrc(w: number, h: number): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#123"/></svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The shapes a club actually uploads, at the extremes the bounds exist for. */
const SQUARE = logoSrc(512, 512);
const BANNER = logoSrc(3000, 300); // 10:1 — width-bound
const TOWER = logoSrc(300, 1800); // 1:6 — height-bound

/** The title splash's worst case: every optional sub-line present. */
const TITLE_SUB = [
	"District 39",
	"Club #28677176",
	"Meeting #412",
	"Thursday, June 25, 2026",
	"Start time: 6:45 PM",
];
/** The closing splash's worst case: a real next meeting, so five lines again —
 *  one muted, a spacer, a muted label and two `strong` lines. */
const THANKS_SUB = [
	"CONGRATULATIONS on another great learning session!",
	"__SPACER__",
	"Next Meeting:",
	"__STRONG__Thursday, July 23, 2026",
	"__STRONG__6:00 PM",
];

type Case = {
	id: string;
	/** null renders the word instead, the way a club with no logo sees it. */
	src: string | null;
	logoPct: number;
	maxWidthPct: number;
	/** The pre-#725 arrangement renders BOTH the logo and the word. */
	word: boolean;
	headline: string;
	sub: string[];
};

function subLine(text: string): string {
	if (text === "__SPACER__") return `<div style="height:2.4cqw"></div>`;
	if (text.startsWith("__STRONG__"))
		return `<div style="font-size:2.8cqw;font-weight:600;line-height:1.25">${text.slice(10)}</div>`;
	return `<div style="font-size:2.5cqw;line-height:1.375">${text}</div>`;
}

/** The splash column, modelling `Splash` in `meeting-present.tsx`. */
function splash(c: Case): string {
	const logo =
		c.src === null
			? ""
			: `<span style="flex:none;display:inline-flex;background:#fff;border-radius:4px;padding:4px;line-height:0"><img class="logo" src="${c.src}" alt="" style="height:${c.logoPct}cqw;width:auto;max-width:${c.maxWidthPct}cqw;object-fit:contain"></span>`;
	// `font-display` is `'Fraunces', Georgia, serif`, and Fraunces cannot load
	// here — so the fallback the harness actually renders is the serif.
	const word = c.word
		? `<div style="font-family:Georgia,serif;font-weight:600;letter-spacing:-0.01em;font-size:6cqw${c.src === null ? "" : ";margin-top:2.2cqw"}">Toastmasters</div>`
		: "";
	return `<div class="frame" id="${c.id}" style="position:relative;aspect-ratio:16/9;width:${FRAME_W}px;container-type:inline-size;margin-bottom:80px;background:#eee">
	<div class="col" style="display:flex;height:100%;width:100%;flex-direction:column;align-items:center;justify-content:center;padding-left:8cqw;padding-right:8cqw;text-align:center">
		${logo}${word}
		<div class="rule" style="margin-top:3.4cqw;margin-bottom:3.4cqw;height:1px;width:58cqw;background:#004062"></div>
		<div class="headline" style="font-size:6.4cqw;font-weight:800;line-height:1.25;text-wrap:balance">${c.headline}</div>
		<div style="margin-top:2.6cqw;display:flex;flex-direction:column;gap:0.7cqw">${c.sub.map(subLine).join("")}</div>
	</div>
</div>`;
}

type Measured = {
	/** First child's top to last child's bottom — what the column needs. */
	contentHeight: number;
	/** Frame top to the column's first child. Negative = spilling out. */
	topGap: number;
	/** The logo's rendered box. Zero when the splash shows the word instead. */
	logoWidth: number;
	logoHeight: number;
	/** Frame-relative edges of that box, for the gutter and the rule. */
	logoLeft: number;
	logoRight: number;
	logoBottom: number;
	/** The rule's top edge, frame-relative: the first thing under the logo. */
	ruleTop: number;
	/** The column's content box, inside the 8cqw gutters. */
	contentLeft: number;
	contentRight: number;
	/** The image's INTRINSIC width, so a case that measured a broken image —
	 *  which collapses to nothing and "fits" trivially — fails instead. */
	naturalWidth: number;
};

function measure(cases: readonly Case[]): Map<string, Measured> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — cannot measure splash geometry.");
	const ids = cases.map((c) => c.id);
	const probe = `<script>
	document.title = ${JSON.stringify(ids)}.map(function (id) {
		var f = document.getElementById(id);
		var col = f.querySelector(".col");
		var img = f.querySelector(".logo");
		var fb = f.getBoundingClientRect();
		var cs = getComputedStyle(col);
		var kids = col.children;
		var first = kids[0].getBoundingClientRect();
		var last = kids[kids.length - 1].getBoundingClientRect();
		var ib = img
			? img.getBoundingClientRect()
			: { width: 0, height: 0, left: fb.left, right: fb.left, bottom: fb.top };
		var rule = f.querySelector(".rule").getBoundingClientRect();
		return [
			last.bottom - first.top,
			first.top - fb.top,
			ib.width,
			ib.height,
			ib.left - fb.left,
			ib.right - fb.left,
			ib.bottom - fb.top,
			rule.top - fb.top,
			parseFloat(cs.paddingLeft),
			fb.width - parseFloat(cs.paddingRight),
			img ? img.naturalWidth : 0
		].join(",");
	}).join("|");
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "splash-logo-"));
	try {
		const path = join(dir, "page.html");
		writeFileSync(
			path,
			// `line-height: 1.5` on the root stands in for Tailwind's preflight,
			// which is what the word "Toastmasters" — the only element on the
			// splash with no leading utility of its own — inherits.
			`<!doctype html><html><head><title>x</title><style>html{line-height:1.5;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0}img{max-width:100%}</style></head><body>${cases.map(splash).join("")}${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				`--window-size=${FRAME_W + 120},1200`,
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${path}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 15_000 },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
		const rows = title.split("|");
		if (rows.length !== ids.length) {
			throw new Error(`The probe did not run; Chrome reported "${title}".`);
		}
		const out = new Map<string, Measured>();
		rows.forEach((row, i) => {
			const n = row.split(",").map(Number);
			const id = ids[i];
			if (id === undefined || n.length !== 11 || n.some(Number.isNaN)) {
				throw new Error(`Bad measurement for ${ids[i]}: "${row}"`);
			}
			out.set(id, {
				contentHeight: n[0] as number,
				topGap: n[1] as number,
				logoWidth: n[2] as number,
				logoHeight: n[3] as number,
				logoLeft: n[4] as number,
				logoRight: n[5] as number,
				logoBottom: n[6] as number,
				ruleTop: n[7] as number,
				contentLeft: n[8] as number,
				contentRight: n[9] as number,
				naturalWidth: n[10] as number,
			});
		});
		return out;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Every case in ONE browser launch. A Chrome process per assertion is this
 *  harness's whole running cost, and #624 is the precedent for what a suite
 *  that launches generously does to its neighbours. */
const CASES: Case[] = [
	// The shipped arrangement, one per logo shape.
	{
		id: "square",
		src: SQUARE,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: SPLASH_LOGO_MAX_WIDTH_PCT,
		word: false,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
	{
		id: "banner",
		src: BANNER,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: SPLASH_LOGO_MAX_WIDTH_PCT,
		word: false,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
	{
		id: "tower",
		src: TOWER,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: SPLASH_LOGO_MAX_WIDTH_PCT,
		word: false,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
	// The closing splash, which #725 gave a logo for the first time.
	{
		id: "closing",
		src: SQUARE,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: SPLASH_LOGO_MAX_WIDTH_PCT,
		word: false,
		headline: "Thank You",
		sub: THANKS_SUB,
	},
	// A club with no logo: the word, exactly as before.
	{
		id: "wordOnly",
		src: null,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: SPLASH_LOGO_MAX_WIDTH_PCT,
		word: true,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
	// PRE-FIX CONTROL: 9cqw logo stacked above the word.
	{
		id: "control",
		src: SQUARE,
		logoPct: PRE_FIX_LOGO_PCT,
		maxWidthPct: PRE_FIX_MAX_WIDTH_PCT,
		word: true,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
	// …and the shape the width ceiling exists for, without one.
	{
		id: "unbounded",
		src: BANNER,
		logoPct: SPLASH_LOGO_HEIGHT_PCT,
		maxWidthPct: 1000,
		word: false,
		headline: "MCF Toastmasters Club",
		sub: TITLE_SUB,
	},
];

describe("splash-logo harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the splash logo's geometry would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the club logo on a projected splash (#725)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const m = measure(CASES);
		const of = (id: string): Measured => {
			const v = m.get(id);
			if (!v) throw new Error(`no measurement for ${id}`);
			return v;
		};

		// Not vacuous. A src the browser cannot decode renders a zero box, which
		// would satisfy every bound below and read as a perfectly laid-out slide.
		it("actually decoded the fixture images", () => {
			expect(of("square").naturalWidth).toBe(512);
			expect(of("banner").naturalWidth).toBe(3000);
			expect(of("tower").naturalWidth).toBe(300);
			expect(of("wordOnly").naturalWidth).toBe(0);
		});

		it("renders the mark far larger than the arrangement it replaces", () => {
			const now = of("square");
			const before = of("control");
			expect(before.logoHeight).toBeGreaterThan(0);
			// 15cqw against 9: two thirds taller, and nearly three times the area.
			expect(now.logoHeight / before.logoHeight).toBeGreaterThan(1.5);
			expect(
				(now.logoWidth * now.logoHeight) /
					(before.logoWidth * before.logoHeight),
			).toBeGreaterThan(2);
		});

		// The point of dropping the word: the room gets a bigger mark AND the
		// column stops spilling out of the frame. The control is what shipped.
		it("fits the 16:9 frame, where the arrangement it replaces did not", () => {
			const before = of("control");
			expect(
				before.contentHeight,
				"the pre-#725 control no longer overflows, so nothing below can fail",
			).toBeGreaterThan(FRAME_H);
			expect(before.topGap).toBeLessThan(0);

			for (const id of ["square", "banner", "tower", "closing", "wordOnly"]) {
				const c = of(id);
				expect(
					c.contentHeight,
					`${id} needs ${c.contentHeight}px of a ${FRAME_H}px frame`,
				).toBeLessThanOrEqual(FRAME_H);
				expect(c.topGap).toBeGreaterThanOrEqual(0);
			}
		});

		// The word's line and its margin are what paid for the bigger logo. If a
		// later change renders both again, this is the assertion that says so.
		it("needs less of the frame than the stacked arrangement did", () => {
			expect(of("square").contentHeight).toBeLessThan(
				of("control").contentHeight,
			);
		});

		it("holds every logo shape inside the slide's own gutters", () => {
			for (const id of ["square", "banner", "tower", "closing"]) {
				const c = of(id);
				expect(c.logoWidth).toBeGreaterThan(0);
				expect(c.logoLeft, `${id} runs past the left gutter`).toBeGreaterThan(
					c.contentLeft - 0.5,
				);
				expect(c.logoRight, `${id} runs past the right gutter`).toBeLessThan(
					c.contentRight + 0.5,
				);
			}
		});

		// The ceiling is not decoration: a 10:1 banner contained by height alone
		// is 30cqw wider than the whole slide.
		it("is the width ceiling that keeps a wide wordmark on the slide", () => {
			const free = of("unbounded");
			expect(free.logoRight).toBeGreaterThan(FRAME_W);
			expect(of("banner").logoRight).toBeLessThan(FRAME_W);
		});

		// Bounded in the other direction too: a 1:6 tower is held by its height,
		// so it cannot push the headline down the frame.
		it("holds a tall logo to the same height as a wide one", () => {
			expect(of("tower").logoHeight).toBeCloseTo(of("banner").logoHeight, 0);
			expect(of("tower").logoWidth).toBeLessThan(of("square").logoWidth);
		});

		it("clears the rule under it on every shape", () => {
			for (const id of ["square", "banner", "tower", "closing"]) {
				const c = of(id);
				expect(c.logoBottom, `${id} collides with the rule`).toBeLessThan(
					c.ruleTop,
				);
			}
		});
	},
);

describe("the shape of the logo's box", () => {
	// Not a size guard — the browser cases above are that — but a guard on the
	// RELATIONSHIP between the two constants, which nothing else states.
	//
	// `ClubLogo` locks the height and lets `object-fit: contain` letterbox
	// anything wider than the box, inside a white plate that is plainly visible
	// on the dark closing splash. So the box's aspect ratio decides which
	// wordmarks get white bands around them, and raising the HEIGHT alone — the
	// obvious way to answer "make the logo bigger" — makes more of them do so
	// while every assertion about fitting the frame still passes.
	it("does not letterbox a materially wider range than before #725", () => {
		const now = SPLASH_LOGO_MAX_WIDTH_PCT / SPLASH_LOGO_HEIGHT_PCT;
		const before = PRE_FIX_MAX_WIDTH_PCT / PRE_FIX_LOGO_PCT; // 46/9 = 5.1:1
		expect(
			now,
			`the box is now ${now.toFixed(1)}:1 against ${before.toFixed(1)}:1 ` +
				"before, so wordmarks that used to fill it now sit in white bands",
		).toBeGreaterThan(before * 0.7);
	});

	// The mark should not read as wider than the rule it sits above.
	it("is no wider than the rule beneath it", () => {
		expect(SPLASH_LOGO_MAX_WIDTH_PCT).toBeLessThanOrEqual(58);
	});
});

/**
 * The fixture above is synthetic markup. These pin the literals it copied, so a
 * change to the real splash fails HERE rather than leaving a geometry gate
 * quietly measuring a slide the app no longer renders.
 */
describe("the fixture still models the real splash", () => {
	const src = readSource(
		new URL("./meeting-present.tsx", import.meta.url).pathname,
	);
	const start = src.indexOf("function Splash(");
	const body = src.slice(start, src.indexOf("\nfunction ", start + 1));

	it("finds the component", () => {
		expect(start).toBeGreaterThan(-1);
		expect(body).toContain("layout.tone");
	});

	it("still lays the column out the way the fixture does", () => {
		for (const cls of [
			"flex-col",
			"items-center",
			"justify-center",
			"px-[8cqw]",
			"my-[3.4cqw]",
			"w-[58cqw]",
			"text-[6.4cqw]",
			"leading-tight",
			"mt-[2.6cqw]",
			"gap-[0.7cqw]",
		]) {
			expect(body, `the splash no longer uses ${cls}`).toContain(cls);
		}
	});

	it("still sizes the logo from the shared proportions", () => {
		expect(body).toContain("cqw(SPLASH_LOGO_HEIGHT_PCT)");
		expect(body).toContain("cqw(SPLASH_LOGO_MAX_WIDTH_PCT)");
		// A literal here would put the two renderers back where #359 found them.
		expect(body).not.toMatch(/height="[\d.]+cqw"/);
		expect(body).not.toMatch(/maxWidth="[\d.]+cqw"/);
	});

	// The fixture's `word: false` cases model a splash showing ONLY the logo. If
	// the component went back to rendering both, every height above would be
	// measuring an arrangement the app does not produce.
	it("still renders the word only when no logo is shown", () => {
		expect(body).toMatch(/\{showLogo && \(/);
		expect(body).toMatch(/\{!showLogo && \(/);
	});

	// `LineView`'s splash sizes, which the fixture's sub lines copy.
	it("still sizes the sub lines the way the fixture does", () => {
		const lv = src.slice(src.indexOf("function LineView("));
		expect(lv).toContain("text-[2.5cqw]");
		expect(lv).toContain("leading-snug");
		expect(lv).toContain("text-[2.8cqw]");
		expect(lv).toContain("h-[2.4cqw]");
	});
});
