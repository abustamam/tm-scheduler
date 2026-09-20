/**
 * The confirm table scrolls inside its own box on a phone (#806, AC17).
 *
 * Six columns do not fit 375px, and 375px is where a club officer actually
 * transcribes a guest book — phone in one hand, paper page in the other. There
 * are two ways for a too-wide table to behave and only one of them is usable:
 * the BOX scrolls, or the DOCUMENT does. When the document scrolls, the page
 * heading, the summary counts and the "Record this page" button all slide off
 * the screen with the table, and the reader has to scroll back left to find the
 * button they were reaching for.
 *
 * jsdom performs no layout and loads no stylesheet, so the component test
 * beside this one reports the same (zero) geometry whether the container is
 * right or wrong, and typecheck and lint have no view of Tailwind semantics.
 * A source grep can see that `overflow-x-auto` is PRESENT — and that is exactly
 * the half that is not the bug: a scroller whose child has no width floor never
 * overflows and never scrolls, and one inside a parent with no width constraint
 * hands the overflow to the document instead. Both satisfy every grep. Only a
 * browser can tell them apart, which is what `probeColumn` is for.
 *
 * The class strings come out of the real source files, so deleting the scroller
 * or the `min-w` floor fails this. The markup BETWEEN them is synthetic:
 * mounting the real `ConfirmEntriesTable` would need the router context and the
 * server types its props come from. So this proves the class COMBINATION lays
 * out reachably at a phone width — pair it with the component test, which pins
 * what the table renders.
 *
 * The CONTROL at the bottom is what makes the rest able to fail: the same
 * fixture with the scroller's overflow removed hands the overflow to the
 * document, which is the bug, measured.
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
const TABLE = resolve(HERE, "confirm-entries-table.tsx");
const CONTAINER = resolve(HERE, "../page-container.tsx");

/**
 * The unique `className="…"` CONTAINING `fragment`.
 *
 * Comment-blind: this file's subject carries a long explanatory comment that
 * quotes its own class names, and matching one would measure documentation
 * rather than the shipped attribute. Uniqueness is asserted, because a fragment
 * that started matching two elements would silently measure whichever came
 * first.
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

/** The first template-literal className containing `fragment` (the `cn(…)` case). */
function classLiteralContaining(file: string, fragment: string): string {
	const src = readSource(file);
	const hits = [...src.matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(hits.length, `\`${fragment}\` not found in ${file}`).toBeGreaterThan(
		0,
	);
	return hits[0] as string;
}

const hasChrome = findChrome() !== null;

describe("confirm-table geometry harness availability", () => {
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

/** A phone. The width the six columns genuinely do not fit. */
const VIEWPORT = { width: 375, height: 700 };

describe.skipIf(!hasChrome)(
	"the confirm table at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let scroller = "";
		let table = "";
		let page = "";

		/**
		 * The header row, INCLUDING the `sr-only` label on the last column.
		 *
		 * That span is not scenery. Tailwind's `sr-only` is `position:absolute`,
		 * and an absolutely positioned element is laid out against its nearest
		 * POSITIONED ancestor — the viewport, when there is none. So it sat at
		 * the table's right edge, ~861px into a 375px screen, and dragged
		 * `documentElement.scrollWidth` out with it while the scroller itself was
		 * clipping perfectly. The first version of this fixture rendered only a
		 * `<tbody>`, measured a clean document, and passed against a page that
		 * scrolled sideways in a real browser.
		 *
		 * Fixtures omit things. What they omit is what they cannot see.
		 */
		const HEAD = `
			<thead>
				<tr class="border-b border-[var(--line)] bg-[var(--foam)]">
					<th class="px-3 py-2 text-left text-xs">Name</th>
					<th class="px-3 py-2 text-left text-xs">Goes by</th>
					<th class="px-3 py-2 text-left text-xs">Email</th>
					<th class="px-3 py-2 text-left text-xs">Phone</th>
					<th class="px-3 py-2 text-left text-xs">What happens</th>
					<th class="px-3 py-2 text-left text-xs"><span class="sr-only">Include</span></th>
				</tr>
			</thead>`;

		/** Six columns of plausible width, as the real table renders them. */
		const ROWS = Array.from(
			{ length: 6 },
			(_, i) => `
				<tr>
					<td class="px-3 py-2 align-top"><input class="h-9 min-w-[8rem]" value="Visitor ${i}" /></td>
					<td class="px-3 py-2 align-top"><input class="h-9 min-w-[8rem]" value="Vis" /></td>
					<td class="px-3 py-2 align-top"><input class="h-9 min-w-[8rem]" value="visitor${i}@example.com" /></td>
					<td class="px-3 py-2 align-top"><input class="h-9 min-w-[8rem]" value="+1555000000${i}" /></td>
					<td class="px-3 py-2 align-top min-w-[14rem]">New guest</td>
					<td class="px-3 py-2 align-top whitespace-nowrap"><button type="button" id="${i === 5 ? "tail" : `drop-${i}`}">Drop</button></td>
				</tr>`,
		).join("");

		function fixture(scrollerClass: string): string {
			return `
				<div class="${page}">
					<div class="flex flex-wrap items-center gap-3" id="chrome">
						<h1 class="font-display text-3xl font-semibold">Confirm the guest book</h1>
					</div>
					<div class="${scrollerClass}" id="scroller">
						<table class="${table}">
							${HEAD}
							<tbody>${ROWS}</tbody>
						</table>
					</div>
					<div class="flex flex-wrap items-center gap-3">
						<button type="button">Record this page</button>
					</div>
				</div>`;
		}

		/** The fixture with one class removed — the mutation controls below. */
		const without = (cls: string) =>
			fixture(scroller.replace(new RegExp(`\\b${cls}\\b`), ""));

		beforeAll(async () => {
			scroller = classContaining(TABLE, "overflow-x-auto");
			table = classContaining(TABLE, "min-w-[54rem]");
			page = classLiteralContaining(CONTAINER, "max-w-workspace");
			// Every fixture's candidates, so the mutation controls below are styled
			// by the same stylesheet as the real one.
			css = await buildAppCss([
				...candidatesIn(fixture(scroller)),
				...candidatesIn(without("overflow-x-auto")),
				...candidatesIn(without("relative")),
			]);
		});

		it("reads the shipped class strings out of source", () => {
			// Vacuity floor: an empty class string would make every measurement
			// below describe a plain unstyled document.
			expect(scroller).toContain("overflow-x-auto");
			expect(scroller).toContain("w-full");
			// The containing-block half. `overflow-x-auto` alone does not clip an
			// absolutely positioned descendant, and the header's `sr-only` label is
			// one — see the component, and the control below.
			expect(scroller).toContain("relative");
			expect(table).toMatch(/min-w-\[\d+rem\]/);
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

			// The table really is too wide here — without this the rest passes
			// vacuously on a fixture that happened to fit.
			expect(probe.overflowsX).toBe(true);
			expect(probe.overflowX).toBe("auto");
			// And driving it right actually moves it: an `overflow-x-auto` box whose
			// child has no width floor reports `auto` and scrolls nowhere.
			expect(probe.scrolledRightBy).toBeGreaterThan(0);

			// THE claim. The page heading and the Record button stay put.
			expect(
				probe.documentOverflowsX,
				"the document scrolls sideways at 375px, so the page heading, the " +
					"summary and the Record button all leave the screen with the table",
			).toBe(false);
		});

		it("without `relative`, the sr-only header drags the page sideways", () => {
			// The control for the half that actually shipped broken, and the reason
			// this suite is not just `overflow-x-auto` restated. With the scroller
			// clipping perfectly, one `position:absolute` descendant laid out
			// against the VIEWPORT instead was enough to make the whole page scroll
			// — MEASURED at 861px of document width on a 375px screen.
			const probe = probeColumn({
				bodyHtml: without("relative"),
				css,
				scrollerSelector: "#scroller",
				tailSelector: "#tail",
				chromeSelector: "#chrome",
				viewport: VIEWPORT,
			});
			// The box is still doing its job: `overflow-x-auto` is untouched here.
			expect(probe.overflowX).toBe("auto");
			expect(probe.overflowsX).toBe(true);
			// And the page scrolls anyway.
			expect(probe.documentOverflowsX).toBe(true);
		});

		it("without the scroller, the DOCUMENT overflows instead", () => {
			// The mutation control. Remove the one class under test and the
			// overflow goes to the document — which is the bug, and is what makes
			// the assertion above mean something rather than describing a table
			// that was never wide enough to matter.
			const probe = probeColumn({
				bodyHtml: without("overflow-x-auto"),
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
