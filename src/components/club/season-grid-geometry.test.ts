/**
 * The sign-up sheet scrolls inside its own box on a phone (#820).
 *
 * `/schedule` is the surface the landing page advertises as the phone-first
 * one — "Members claim their own roles from one shared sheet" — so 375px is
 * the device this grid was designed for, not an edge case. A label column,
 * eight meeting columns and two contact columns do not fit it, and there are
 * two ways for a too-wide table to behave: the BOX scrolls, or the DOCUMENT
 * does. When the document scrolls, the "Sign-up sheet" heading, the "Copy
 * sign-up sheet link" button, the Roles×Meetings toggle and the "Meetings
 * shown" control all slide off the screen with the table, and the member has
 * to scroll back left to reach any of them.
 *
 * ## The scroller was never the bug
 *
 * Measured on production at 375px: `documentElement.scrollWidth` 876 against a
 * `clientWidth` of 360, and isolated to this one page — nine other surfaces
 * sat exactly at width. Yet the containment chain was built correctly and was
 * working: the `overflow-auto` box was 326px wide, clipping a 978px table.
 *
 * What escaped was the `sr-only` spans. Tailwind's `sr-only` is
 * `position: absolute`, and an absolutely positioned element lays out against
 * its nearest POSITIONED ancestor — the initial containing block when there is
 * none, which no `overflow` on an unpositioned box can clip. The scroller
 * computed `position: static`, so those spans sat at the table's right edge,
 * ~876px into a 360px screen, and dragged the document's scroll width out with
 * them. They carry the WhatsApp contact labels, composed as a span rather than
 * an `aria-label` for reasons `whatsapp-phone-link.tsx` sets out and which
 * this must not undo.
 *
 * This is the third table of that shape here. `confirm-table-geometry.test.ts`
 * measured the identical defect at 861px on the guest-book confirm table
 * (#806), and `pinned-column-reachability.test.ts` covers the vertical
 * version. This grid was covered by neither, which is why it reached
 * production.
 *
 * ## Why a browser, and why not a grep
 *
 * jsdom performs no layout and loads no stylesheet, so `season-grid.test.tsx`
 * beside this one reports the same (zero) geometry whether the container is
 * right or wrong. A source grep can see that `overflow-auto` is PRESENT — and
 * that is precisely the half that is not the bug, because it was present the
 * whole time the page scrolled sideways. Only a browser tells a static
 * scroller from a positioned one, which is what `probeColumn` is for.
 *
 * ## What this proves, and what it does not
 *
 * The class strings come out of the real source files, so deleting `relative`
 * or the scroller fails this. The markup BETWEEN them is synthetic: mounting
 * the real `SeasonGrid` needs a router context and the server types its props
 * come from. So this proves the class COMBINATION lays out reachably at a
 * phone width — pair it with `season-grid.test.tsx`, which pins what the grid
 * renders.
 *
 * Deliberately NO clipping ancestor in the fixture, though the real
 * `/schedule` has one (the app shell's `overflow-x-hidden` section). An
 * ancestor that clips can only make the document LESS likely to overflow, so
 * modelling it would loosen the assertion into "the shell saves us". The grid
 * has to contain its own overflow: it also renders on the public club page,
 * whose wrapper clips nothing.
 *
 * The CONTROLS at the bottom are what make the rest able to fail: the same
 * fixture with `relative` removed reproduces the shipped bug, measured.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { scrollAnchorClearOfPinnedColumn } from "#/lib/season-grid-anchor-scroll";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	probeColumn,
} from "#/test/pinned-column-scroll";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID = resolve(HERE, "season-grid.tsx");
const WHATSAPP = resolve(HERE, "../whatsapp-phone-link.tsx");
const CONTAINER = resolve(HERE, "../page-container.tsx");
const GRID_CELL = resolve(HERE, "grid-cell.tsx");

/**
 * The unique `className="…"` CONTAINING `fragment`.
 *
 * Comment-blind via {@link readSource}: this file's subjects carry long
 * explanatory comments that quote their own class names, and matching one
 * would measure documentation rather than the shipped attribute. Uniqueness is
 * asserted, because a fragment that started matching two elements would
 * silently measure whichever came first.
 */
function classContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one className in ${file}`,
	).toHaveLength(1);
	return hits[0] as string;
}

/**
 * The first string literal containing `fragment` — the `cn(…)` case, where a
 * class list is assembled from several literals rather than being one
 * `className="…"` attribute. Existence is asserted rather than uniqueness:
 * several of these are the repeated cells (two contact headers, two contact
 * cells), where the point is the shipped string and not which identical copy
 * supplied it.
 */
function classLiteralContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(hits.length, `\`${fragment}\` not found in ${file}`).toBeGreaterThan(
		0,
	);
	return hits[0] as string;
}

const hasChrome = findChrome() !== null;

describe("season-grid geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		// A silently absent geometry gate reads exactly like a passing one, so in
		// CI its absence is a failure rather than a skip.
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every geometry measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

/** A phone. The width eleven columns genuinely do not fit. */
const VIEWPORT = { width: 375, height: 700 };

/** Eight meeting columns, as `Meetings shown 8` renders them. */
const MEETINGS = 8;

describe.skipIf(!hasChrome)(
	"the sign-up sheet at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let scroller = "";
		let frame = "";
		let table = "";
		let root = "";
		let controls = "";
		let labelHead = "";
		let meetingHead = "";
		let contactHead = "";
		let rowHead = "";
		let contactCell = "";
		let srOnly = "";
		let waLink = "";
		let page = "";

		/**
		 * One row, ending in the two contact columns.
		 *
		 * The `sr-only` span in the phone cell is not scenery — it is the whole
		 * subject. `WhatsAppPhoneLink` composes the contact label as an `sr-only`
		 * span rather than an `aria-label` so the number stays the accessible
		 * NAME, and that reasoning is sound; the span's absolute positioning is
		 * what escapes. A fixture that rendered only the meeting columns would
		 * measure a clean document and pass against a page that scrolls sideways
		 * in a real browser, which is exactly how #806's first fixture passed.
		 *
		 * Fixtures omit things. What they omit is what they cannot see.
		 */
		const row = (i: number) => `
			<tr class="group transition-colors">
				<th class="${rowHead}"><a href="#">Member ${i} Lastname</a></th>
				${Array.from(
					{ length: MEETINGS },
					() =>
						`<td class="p-0"><div class="px-2 py-1 text-center text-xs">open</div></td>`,
				).join("")}
				<td class="${contactCell}">
					<a href="#" class="${waLink}">member${i}@example.com</a>
				</td>
				<td class="${contactCell}"${i === 5 ? ' id="tail"' : ""}>
					<a href="#" class="${waLink}">+1555000000${i}<span class="${srOnly}">— message Member ${i} Lastname on WhatsApp, opens in a new tab</span></a>
				</td>
			</tr>`;

		function fixture(scrollerClass: string): string {
			return `
				<div class="${page} space-y-4">
					<div class="flex flex-wrap items-center justify-between gap-3" id="chrome">
						<h1 class="font-display text-3xl font-semibold tracking-[-0.02em]">Sign-up sheet</h1>
						<button type="button">Copy sign-up sheet link</button>
					</div>
					<div class="${root}">
						<div class="${controls}">
							<div class="inline-flex overflow-hidden rounded-lg border">
								<button type="button" class="px-3 py-1.5 text-xs font-semibold">Roles × Meetings</button>
								<button type="button" class="px-3 py-1.5 text-xs font-semibold">Members × Meetings</button>
							</div>
							<div class="inline-flex items-center gap-2">
								<span class="text-xs font-medium">Meetings shown</span>
							</div>
						</div>
						<div class="${frame}">
							<div class="${scrollerClass}" id="scroller">
								<table class="${table}">
									<thead>
										<tr>
											<th class="${labelHead}">Member</th>
											${Array.from(
												{ length: MEETINGS },
												(_, i) =>
													`<th class="${meetingHead}"><span class="block py-2 md:py-0">Oct ${i + 1}</span></th>`,
											).join("")}
											<th class="${contactHead}">Email</th>
											<th class="${contactHead}">Phone</th>
										</tr>
									</thead>
									<tbody>${Array.from({ length: 6 }, (_, i) => row(i)).join("")}</tbody>
								</table>
							</div>
						</div>
					</div>
				</div>`;
		}

		/** The scroller's class string with one class removed. */
		const strip = (cls: string) =>
			scroller.replace(new RegExp(`\\b${cls}\\b`), "").trim();

		beforeAll(async () => {
			scroller = classContaining(GRID, "scroll-fade-r");
			frame = classContaining(GRID, "rounded-xl border");
			table = classContaining(GRID, "border-separate");
			root = classContaining(GRID, "space-y-4");
			controls = classContaining(GRID, "flex flex-wrap items-center gap-4");
			labelHead = classLiteralContaining(GRID, "sticky top-0 left-0");
			meetingHead = classLiteralContaining(GRID, "sticky top-0 min-w-[3.5rem]");
			contactHead = classLiteralContaining(GRID, "sticky top-0 bg-card");
			rowHead = classLiteralContaining(GRID, "sticky left-0 z-10");
			contactCell = classLiteralContaining(
				GRID,
				"px-3 py-1 text-left text-xs whitespace-nowrap",
			);
			srOnly = classContaining(WHATSAPP, "sr-only");
			waLink = classLiteralContaining(
				WHATSAPP,
				"inline-flex items-center gap-1.5",
			);
			page = classLiteralContaining(CONTAINER, "max-w-workspace");
			// Every fixture's candidates, so the mutation controls below are styled
			// by the same stylesheet as the real one.
			css = await buildAppCss([
				...candidatesIn(fixture(scroller)),
				...candidatesIn(fixture(strip("relative"))),
				...candidatesIn(fixture(strip("overflow-auto"))),
			]);
		});

		it("reads the shipped class strings out of source", () => {
			// Vacuity floor: an empty class string would make every measurement
			// below describe a plain unstyled document.
			expect(scroller).toContain("overflow-auto");
			// The containing-block half, and the whole of #820. `overflow-auto`
			// alone does not clip an absolutely positioned descendant, and the
			// contact labels are exactly that — see the control below.
			expect(scroller).toContain("relative");
			expect(srOnly).toContain("sr-only");
			expect(table).toContain("border-separate");
			expect(page).toContain("max-w-workspace");
		});

		it("scrolls the box, and not the page", () => {
			const probe = probeColumn({
				bodyHtml: fixture(scroller),
				css,
				scrollerSelector: "#scroller",
				tailSelector: "#tail",
				chromeSelector: "#chrome",
				viewport: VIEWPORT,
			});

			// The grid really is too wide here — without this the rest passes
			// vacuously on a fixture that happened to fit.
			expect(probe.overflowsX).toBe(true);
			expect(probe.overflowX).toBe("auto");
			// And driving it right actually moves it: an `overflow-auto` box whose
			// content does not exceed it reports `auto` and scrolls nowhere.
			expect(probe.scrolledRightBy).toBeGreaterThan(0);

			// THE claim. The heading, the copy-link button and the two controls
			// stay where the member left them.
			expect(
				probe.documentOverflowsX,
				"the document scrolls sideways at 375px, so the heading, the " +
					"Copy sign-up sheet link button and the Meetings shown control " +
					"all leave the screen with the grid",
			).toBe(false);
		});

		it("without `relative`, the sr-only contact label drags the page sideways", () => {
			// The control for the half that actually shipped broken, and the reason
			// this suite is not `overflow-auto` restated. A mutation that changes
			// nothing is a control that proves nothing, so the strip is checked
			// before it is measured.
			const mutated = strip("relative");
			expect(
				mutated,
				"`relative` is not on the scroller, so this control mutates nothing " +
					"and would pass against the shipped bug",
			).not.toBe(scroller);

			const probe = probeColumn({
				bodyHtml: fixture(mutated),
				css,
				scrollerSelector: "#scroller",
				tailSelector: "#tail",
				chromeSelector: "#chrome",
				viewport: VIEWPORT,
			});
			// The box is still doing its job: `overflow-auto` is untouched here, and
			// it is still clipping the table correctly.
			expect(probe.overflowX).toBe("auto");
			expect(probe.overflowsX).toBe(true);
			// And the page scrolls anyway — one `position:absolute` descendant laid
			// out against the viewport instead was the whole 876px.
			expect(probe.documentOverflowsX).toBe(true);
		});

		it("without the scroller, the DOCUMENT overflows instead", () => {
			// The other mutation control. Remove the overflow and the grid's own
			// width goes to the document, which is a failure `relative` cannot
			// prevent — so neither class is load-bearing on its own.
			const mutated = strip("overflow-auto");
			expect(mutated, "`overflow-auto` is not on the scroller").not.toBe(
				scroller,
			);

			const probe = probeColumn({
				bodyHtml: fixture(mutated),
				css,
				scrollerSelector: "#scroller",
				tailSelector: "#tail",
				chromeSelector: "#chrome",
				viewport: VIEWPORT,
			});
			expect(probe.overflowX).not.toBe("auto");
			expect(probe.scrolledRightBy).toBe(0);
			expect(probe.documentOverflowsX).toBe(true);
		});
	},
);

/**
 * Where the anchor meeting lands after load, beside the pinned label column
 * (#930).
 *
 * `SeasonGrid` scrolls the next meeting into view on mount. It used to call
 * `scrollIntoView({ inline: "center" })` bare, which centres the column in the
 * scroller's WHOLE width — including the part the `sticky left-0` Role column
 * covers. At 1280px that centre is clear of the label; at 375px it put the
 * highlighted meeting's left half under it (MEASURED on production: 210px of
 * scroll, names reading "az …mmed").
 *
 * The browser cannot be asked "is this hidden under a sticky cell" by any
 * source grep, and jsdom scrolls nothing, so this lays the grid out in Chrome
 * and reads back three rectangles. The fix lives in JS
 * (`scrollAnchorClearOfPinnedColumn`), not in a class string, so the fixture
 * runs THAT function's own source in the page — `fn.toString()` — rather than
 * a copy of its logic that could agree with this test and disagree with the
 * component. The source guard below pins that the component calls it.
 *
 * The CONTROL runs the shipped pre-fix call on the same fixture and must
 * reproduce the overlap, which is what lets the fixed assertion fail.
 */
type AnchorProbe = {
	/** Right edge of the pinned label `<th>`, viewport px. */
	labelRight: number;
	anchorLeft: number;
	anchorRight: number;
	/** The scroller's visible box: left edge and right edge (minus scrollbar). */
	scrollerLeft: number;
	scrollerRight: number;
	scrollLeft: number;
	overflowsX: boolean;
};

function probeAnchor(opts: {
	bodyHtml: string;
	css: string;
	/** JS run with `s` (scroller), `label` (pinned th) and `a` (anchor th) bound. */
	scroll: string;
	viewport: { width: number; height: number };
}): AnchorProbe {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");
	const probe = `<script>
	(function () {
		var s = document.getElementById("scroller");
		var label = document.getElementById("label");
		var a = document.getElementById("anchor");
		if (!s || !label || !a) { document.title = "ERROR:fixture"; return; }
		try { ${opts.scroll} } catch (e) { document.title = "ERROR:" + e; return; }
		var sr = s.getBoundingClientRect();
		var lr = label.getBoundingClientRect();
		var ar = a.getBoundingClientRect();
		var out = {
			labelRight: lr.right,
			anchorLeft: ar.left,
			anchorRight: ar.right,
			scrollerLeft: sr.left + s.clientLeft,
			scrollerRight: sr.left + s.clientLeft + s.clientWidth,
			scrollLeft: s.scrollLeft,
			overflowsX: s.scrollWidth > s.clientWidth ? 1 : 0
		};
		document.title = Object.keys(out).map(function (k) {
			return k + "=" + out[k];
		}).join(";");
	})();
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "season-grid-anchor-"));
	try {
		writeFileSync(join(dir, "app.css"), opts.css, "utf8");
		writeFileSync(
			join(dir, "page.html"),
			`<!doctype html><html><head><meta charset="utf-8">` +
				`<link rel="stylesheet" href="./app.css"></head><body>` +
				`${opts.bodyHtml}${probe}</body></html>`,
			"utf8",
		);
		// Same spawn as `probeColumn` (profile isolation, pinned fonts, a hang
		// detector a sync call needs) — see `pinned-column-scroll.ts` for why
		// each flag is there.
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				`--window-size=${opts.viewport.width},${opts.viewport.height}`,
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
		if (title.startsWith("ERROR:")) throw new Error(`probe: ${title.slice(6)}`);
		if (!title.includes("anchorLeft=")) {
			throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
		}
		const kv = new Map(
			title.split(";").map((p) => p.split("=") as [string, string]),
		);
		const num = (k: string) => Number(kv.get(k));
		return {
			labelRight: num("labelRight"),
			anchorLeft: num("anchorLeft"),
			anchorRight: num("anchorRight"),
			scrollerLeft: num("scrollerLeft"),
			scrollerRight: num("scrollerRight"),
			scrollLeft: num("scrollLeft"),
			overflowsX: kv.get("overflowsX") === "1",
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The fixed call: the shipped function's own source, run in the page. */
const FIXED_SCROLL = `(${scrollAnchorClearOfPinnedColumn.toString()})(s, label, a);`;
/** What `SeasonGrid` did before #930, verbatim. */
const PRE_FIX_SCROLL = `a.scrollIntoView({ inline: "center", block: "nearest" });`;

/**
 * Role names as a club actually has them — the label column is as wide as the
 * longest, which is what the fix measures and a fixed constant could not know.
 */
const ROLES = [
	"Toastmaster of the Day",
	"General Evaluator",
	"Table Topics Master",
	"Speaker 1",
	"Evaluator 1",
	"Timer",
];
const NAMES = ["Riaz Mohammed", "Sudheer Kaka", "Ana Lopez", "Open", "Ben Wu"];

describe.skipIf(!hasChrome)(
	"the anchor meeting clears the pinned Role column (#930)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const PHONE = { width: 375, height: 812 };
		const DESKTOP = { width: 1280, height: 800 };
		/**
		 * Headless Chrome will not lay a window out narrower than 500px —
		 * MEASURED here: `--window-size=375,812` reports `innerWidth` 500 — so a
		 * phone is modelled by pinning the page's width, not the window's. Both
		 * sit below the `md` breakpoint, so no media query differs between them,
		 * and the first assertion below checks the scroller came out at the
		 * width production measured (341px) rather than trusting the wrapper.
		 */
		const PHONE_WIDTH = 375;
		let css = "";
		let scroller = "";
		let frame = "";
		let table = "";
		let labelHead = "";
		let meetingHead = "";
		let anchorRing = "";
		let rowHead = "";
		let cell = "";
		let page = "";

		/**
		 * `anchor` is the next meeting's index — past meetings sit to its left, as
		 * live. `width` pins the page to a phone's (see `PHONE_WIDTH`).
		 */
		function fixture(
			meetings: number,
			anchor: number,
			width?: number,
			anchorName?: string,
		): string {
			const heads = Array.from({ length: meetings }, (_, i) => {
				const isAnchor = i === anchor;
				return `<th class="${meetingHead}${isAnchor ? ` ${anchorRing}` : ""}"${isAnchor ? ' id="anchor"' : ""}><span class="block py-2 md:py-0">Thu, Oct ${i + 1}</span></th>`;
			}).join("");
			const rows = ROLES.map(
				(role, r) => `
				<tr class="group transition-colors">
					<th class="${rowHead}">${role}</th>
					${Array.from(
						{ length: meetings },
						(_, i) =>
							`<td class="p-0"><div class="${cell}">${i === anchor && anchorName ? anchorName : NAMES[(r + i) % NAMES.length]}</div></td>`,
					).join("")}
				</tr>`,
			).join("");
			return `
				<div${width ? ` style="width:${width}px"` : ""}><div class="${page}">
					<div class="${frame}">
						<div class="${scroller}" id="scroller">
							<table class="${table}">
								<thead><tr><th class="${labelHead}" id="label">Role</th>${heads}</tr></thead>
								<tbody>${rows}</tbody>
							</table>
						</div>
					</div>
				</div></div>`;
		}
		const phone = () => fixture(8, 3, PHONE_WIDTH);
		const desktop = () => fixture(16, 8);
		/** A column wider than the room the label leaves: one long name, held on one line. */
		const wideAnchor = () =>
			fixture(8, 3, PHONE_WIDTH, "Abdurrahman&nbsp;Oyelaran&nbsp;Castillo");

		beforeAll(async () => {
			scroller = classContaining(GRID, "scroll-fade-r");
			frame = classContaining(GRID, "rounded-xl border");
			table = classContaining(GRID, "border-separate");
			labelHead = classContaining(GRID, "sticky top-0 left-0");
			meetingHead = classLiteralContaining(GRID, "sticky top-0 min-w-[3.5rem]");
			anchorRing = classLiteralContaining(GRID, "ring-2 ring-primary");
			rowHead = classLiteralContaining(GRID, "sticky left-0 z-10");
			cell = classLiteralContaining(GRID_CELL, "flex h-11 min-w-[3rem]");
			page = classLiteralContaining(CONTAINER, "max-w-workspace");
			css = await buildAppCss([
				...candidatesIn(phone()),
				...candidatesIn(desktop()),
				...candidatesIn(wideAnchor()),
			]);
		});

		it("SeasonGrid scrolls its anchor through the pinned-column-aware helper", () => {
			// The geometry below measures the helper; this pins that the component
			// is what calls it, with the pinned label <th> — a revert to a bare
			// `scrollIntoView` in the component would otherwise leave every
			// measurement here green.
			const src = readSource(GRID);
			expect(src).toMatch(
				/scrollAnchorClearOfPinnedColumn\(\s*scroller,\s*labelHeadRef\.current,\s*anchor,?\s*\)/,
			);
			expect(src).toMatch(
				/<th\s+ref=\{labelHeadRef\}\s+className="sticky top-0 left-0/,
			);
			expect(src).toMatch(
				/ref=\{scrollerRef\}\s+className="relative scroll-fade-r/,
			);
			expect(src).not.toMatch(/anchorRef\.current\?\.scrollIntoView/);
		});

		it("at 375px the anchor column lands fully to the right of the label column", () => {
			const p = probeAnchor({
				bodyHtml: phone(),
				css,
				scroll: FIXED_SCROLL,
				viewport: PHONE,
			});
			// The phone is really a phone: production measured a 341px scroller.
			expect(p.scrollerRight - p.scrollerLeft).toBeLessThanOrEqual(345);
			// Not vacuous: the grid genuinely has to scroll to reach the anchor.
			expect(p.overflowsX).toBe(true);
			expect(p.scrollLeft).toBeGreaterThan(0);
			expect(
				p.anchorLeft,
				"the anchor meeting's left edge is under the pinned Role column",
			).toBeGreaterThanOrEqual(p.labelRight - 0.5);
			expect(p.anchorRight).toBeLessThanOrEqual(p.scrollerRight + 0.5);
		});

		it("a column too wide to centre beside the label start-aligns against it", () => {
			// Centring a column wider than the room left beside the label spills
			// its left edge back under the label — #930 again — so it aligns to the
			// label's edge instead, and its left edge (the name's start) is legible.
			const p = probeAnchor({
				bodyHtml: wideAnchor(),
				css,
				scroll: FIXED_SCROLL,
				viewport: PHONE,
			});
			// Not vacuous: the column really is wider than the room.
			expect(p.anchorRight - p.anchorLeft).toBeGreaterThan(
				p.scrollerRight - p.labelRight,
			);
			expect(p.anchorLeft).toBeGreaterThanOrEqual(p.labelRight - 0.5);
			expect(p.anchorLeft).toBeLessThanOrEqual(p.labelRight + 0.5);
		});

		it("at 1280px the anchor column is still in view and clear of the label", () => {
			// 16 meetings with the anchor mid-way, so the desktop grid still has
			// to scroll to reach it and centring is not clamped at either end.
			const p = probeAnchor({
				bodyHtml: desktop(),
				css,
				scroll: FIXED_SCROLL,
				viewport: DESKTOP,
			});
			expect(p.overflowsX).toBe(true);
			expect(p.scrollLeft).toBeGreaterThan(0);
			expect(p.anchorLeft).toBeGreaterThanOrEqual(p.labelRight - 0.5);
			expect(p.anchorRight).toBeLessThanOrEqual(p.scrollerRight + 0.5);
			// Still CENTRED on a wide screen (in the unobscured part of the box),
			// so past and upcoming meetings both show either side of it, as before.
			const regionMid = (p.labelRight + p.scrollerRight) / 2;
			const anchorMid = (p.anchorLeft + p.anchorRight) / 2;
			expect(Math.abs(anchorMid - regionMid)).toBeLessThan(2);
		});

		it("control: the pre-fix centred scroll hides the anchor under the label at 375px", () => {
			const p = probeAnchor({
				bodyHtml: phone(),
				css,
				scroll: PRE_FIX_SCROLL,
				viewport: PHONE,
			});
			expect(p.overflowsX).toBe(true);
			expect(
				p.anchorLeft,
				"the pre-fix call no longer reproduces #930, so the fixed assertion " +
					"above cannot fail",
			).toBeLessThan(p.labelRight - 0.5);
		});
	},
);
