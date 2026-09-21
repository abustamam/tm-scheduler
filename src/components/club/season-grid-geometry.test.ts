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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	probeColumn,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID = resolve(HERE, "season-grid.tsx");
const WHATSAPP = resolve(HERE, "../whatsapp-phone-link.tsx");
const CONTAINER = resolve(HERE, "../page-container.tsx");

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
