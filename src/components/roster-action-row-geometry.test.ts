/**
 * The roster's action row fits its column at a laptop width, and nothing
 * inside the app shell's content column can scroll it sideways (#999).
 *
 * ## Two defects, one screen
 *
 * Measured on production at a 1024px window with the sidebar open: the
 * officer's action row under "Club roster" (Export club data, Merge
 * duplicates, Invite all, Bulk import, Upload TM CSV, + Add member) was a
 * non-wrapping `flex gap-2`, wider than the column it sat in, so the primary
 * action read "+ Add memb" and ended past the window's right edge.
 *
 * The second defect is the shell's, and it is what turned a clipped button
 * into a page that moves. The content `<section>` was `overflow-x-hidden`.
 * `hidden` clips, but it also makes the box a SCROLL CONTAINER: it has a
 * `scrollLeft`, and focusing or scrolling-into-view anything past its right
 * edge moves it. A user has no scrollbar and no gesture to move it back, so
 * clicking a control near the edge left the whole page shifted ~42px with the
 * heading reading "lub roster". `overflow-x-clip` clips the same pixels and is
 * not a scroll container at all, so there is no offset for focus to change.
 *
 * ## Why a browser
 *
 * jsdom performs no layout and has no scroll offsets, so neither property is
 * visible to it, and a grep can only see which class is present. Same
 * construction as `pinned-column-reachability.test.ts`: the class strings come
 * out of the real source files (comment-blind), the markup between them is
 * synthetic, and a pre-fix control reproduces the shipped bug beside the
 * fixed layout so the assertions are able to fail.
 *
 * What it cannot see: the buttons' labels are typeset in the harness's pinned
 * fallback face, not Manrope, so the row's width differs from production by a
 * few percent. The pre-fix control overflowing is what shows the fixture is
 * still wide enough to exercise the wrap.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buttonVariants } from "#/components/ui/button";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "app-shell.tsx");
const CONTAINER = resolve(HERE, "page-container.tsx");
const ROSTER = resolve(HERE, "../routes/_authed/roster.tsx");

/** First `className="…"` after `marker` in the comment-stripped source. */
function classAfter(file: string, marker: string): string {
	const src = readSource(file);
	const at = src.indexOf(marker);
	expect(at, `\`${marker}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /className="([^"]*)"/.exec(src.slice(at));
	expect(m, `no className after \`${marker}\``).not.toBeNull();
	return m?.[1] ?? "";
}

/** The unique `className="…"` containing `fragment`. */
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

/** The unique string literal containing `fragment` (a `cn(…)` argument). */
function literalContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one string literal in ${file}`,
	).toHaveLength(1);
	return hits[0] as string;
}

const hasChrome = findChrome() !== null;

describe("roster action row geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every geometry measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

/**
 * The width the bug was measured at: exactly the `lg` breakpoint, so the
 * desktop sidebar (248px) is showing and the column is as narrow as it gets
 * with it open.
 */
const VIEWPORT = { width: 1024, height: 768 };

/**
 * The rest of the range #999 names, 768 to 1440. 768 is below `lg`, so the
 * sidebar is a drawer and the column is the whole window, but the page's own
 * padding still leaves it narrower than the unwrapped row.
 */
const OTHER_WIDTHS = [768, 1440] as const;

type Probe = {
	sectionLeft: number;
	sectionRight: number;
	/** The layout viewport's width, less any vertical scrollbar. */
	clientWidth: number;
	/** How many action buttons end past the section's right edge. */
	clippedButtons: number;
	/** The right edge of "+ Add member". */
	addMemberRight: number;
	/** The section's `scrollLeft` after focusing a control inside a too-wide child. */
	scrollLeftAfterWideFocus: number;
	/** The section's `scrollLeft` after a script tries to set it. */
	scrollLeftAfterAssign: number;
	/** Is the heading's left edge still inside the section after all that? */
	headingInside: boolean;
	documentOverflowsX: boolean;
	sectionOverflowX: string;
	/**
	 * The viewport top of a `sticky top-24` child after the DOCUMENT scrolls
	 * well past it. 96 means it pinned; a negative number means it scrolled
	 * away with the page, because its scroll container was the column.
	 */
	stickyTopAfterScroll: number;
};

function probe(
	bodyHtml: string,
	css: string,
	viewport: { width: number; height: number } = VIEWPORT,
): Probe {
	const script = `<script>
	(function () {
		function fail(why) { document.title = "ERROR:" + why; }
		var s = document.querySelector("#section");
		var h = document.querySelector("#heading");
		var add = document.querySelector("#add-member");
		var wide = document.querySelector("#wide-control");
		if (!s || !h || !add || !wide) return fail("fixture incomplete");
		var sr = s.getBoundingClientRect();
		var clipped = 0;
		document.querySelectorAll("#actions > *").forEach(function (b) {
			if (b.getBoundingClientRect().right > sr.right + 0.5) clipped++;
		});
		var out = {
			sectionLeft: Math.round(sr.left),
			sectionRight: Math.round(sr.right),
			clientWidth: document.documentElement.clientWidth,
			clippedButtons: clipped,
			addMemberRight: Math.round(add.getBoundingClientRect().right),
			sectionOverflowX: getComputedStyle(s).overflowX
		};
		wide.focus();
		out.scrollLeftAfterWideFocus = s.scrollLeft;
		s.scrollLeft = 42;
		out.scrollLeftAfterAssign = s.scrollLeft;
		out.headingInside =
			h.getBoundingClientRect().left >= sr.left - 0.5 ? 1 : 0;
		var doc = document.documentElement;
		out.documentOverflowsX = doc.scrollWidth > doc.clientWidth ? 1 : 0;
		window.scrollTo(0, 1500);
		out.stickyTopAfterScroll = Math.round(
			document.querySelector("#sticky").getBoundingClientRect().top
		);
		document.title = Object.keys(out).map(function (k) {
			return k + "=" + out[k];
		}).join(";");
	})();
	</script>`;
	const title = renderAndReadTitle({
		bodyHtml,
		css,
		script,
		viewport,
		tmpPrefix: "roster-action-row-",
	});
	if (!title.includes("sectionRight=")) {
		throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
	}
	const kv = new Map(
		title.split(";").map((p) => p.split("=") as [string, string]),
	);
	const num = (k: string) => Number(kv.get(k) ?? "NaN");
	return {
		sectionLeft: num("sectionLeft"),
		sectionRight: num("sectionRight"),
		clientWidth: num("clientWidth"),
		clippedButtons: num("clippedButtons"),
		addMemberRight: num("addMemberRight"),
		scrollLeftAfterWideFocus: num("scrollLeftAfterWideFocus"),
		scrollLeftAfterAssign: num("scrollLeftAfterAssign"),
		headingInside: kv.get("headingInside") === "1",
		documentOverflowsX: kv.get("documentOverflowsX") === "1",
		sectionOverflowX: kv.get("sectionOverflowX") ?? "",
		stickyTopAfterScroll: num("stickyTopAfterScroll"),
	};
}

describe.skipIf(!hasChrome)(
	"the roster header and the shell column, 768 to 1440px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let frame = "";
		let aside = "";
		let main = "";
		let section = "";
		let container = "";
		let header = "";
		let titleBlock = "";
		let actions = "";
		const outline = buttonVariants({ variant: "outline", size: "sm" });
		const primary = buttonVariants({ size: "sm" });
		const icon = `<svg viewBox="0 0 16 16" aria-hidden="true"></svg>`;

		function fixture(sectionClass: string, actionsClass: string): string {
			return `
			<div class="${frame}">
				<aside class="${aside}">nav</aside>
				<main class="${main}">
					<section class="${sectionClass}" id="section">
						<div class="${container}">
							<div class="${header}">
								<div class="${titleBlock}">
									<h1 id="heading" class="font-display text-3xl font-semibold tracking-[-0.02em]">Club roster</h1>
									<p class="mt-1 text-sm">Every member of your club at a glance · Spring 2026 term</p>
								</div>
								<div class="${actionsClass}" id="actions">
									<a href="#" class="${outline}">${icon}Export club data</a>
									<button type="button" class="${outline}">Merge duplicates</button>
									<button type="button" class="${outline}">${icon}Invite all</button>
									<button type="button" class="${outline}">Bulk import</button>
									<button type="button" class="${outline}">${icon}Upload TM CSV</button>
									<button type="button" class="${primary}" id="add-member">+ Add member</button>
								</div>
							</div>
							<!-- Some other page's too-wide child. The shell cannot make every
							     page fit, but it must never let one move the column. -->
							<div style="width:1400px;display:flex;justify-content:flex-end">
								<label><input type="checkbox" id="wide-control"> Show former members' Pathways</label>
							</div>
							<!-- The meeting page's attendance rail is \`lg:sticky lg:top-24\`
							     inside this column; this stands in for it. -->
							<div style="height:3000px">
								<div class="sticky top-24" id="sticky">rail</div>
							</div>
						</div>
					</section>
				</main>
			</div>`;
		}

		let css = "";
		let fixed: Probe;
		let preFix: Probe;
		const atWidth = new Map<number, Probe>();

		beforeAll(async () => {
			frame = classContaining(SHELL, "flex min-h-svh w-full");
			aside = classAfter(SHELL, "<aside");
			main = classAfter(SHELL, "<main");
			section = classAfter(SHELL, "<section");
			container = literalContaining(CONTAINER, "max-w-workspace");
			header = classContaining(ROSTER, "mb-5 flex flex-wrap items-end");
			titleBlock = classContaining(ROSTER, "min-w-[240px] flex-1");
			actions = classAfter(ROSTER, "Every member of your club at a glance");

			const preFixSection = section.replace(
				/\boverflow-x-clip\b/,
				"overflow-x-hidden",
			);
			const preFixActions = actions.replace(/\s*\bflex-wrap\b/, "");
			const all = `${fixture(section, actions)}${fixture(preFixSection, preFixActions)}`;
			css = await buildAppCss(candidatesIn(all));
			fixed = probe(fixture(section, actions), css);
			preFix = probe(fixture(preFixSection, preFixActions), css);
			for (const width of OTHER_WIDTHS) {
				atWidth.set(
					width,
					probe(fixture(section, actions), css, { width, height: 768 }),
				);
			}
		});

		it("lays the column out where the sidebar leaves it", () => {
			// The aside is 248px at lg+. If the breakpoint did not fire the
			// column would be the whole window and nothing below would bind.
			expect(fixed.sectionLeft).toBe(248);
			expect(fixed.sectionRight).toBe(fixed.clientWidth);
			// A classic scrollbar takes ~15px of the 1024; nothing more should.
			expect(fixed.clientWidth).toBeGreaterThan(VIEWPORT.width - 20);
		});

		it("wraps the action row so every action ends inside the column", () => {
			expect(fixed.clippedButtons).toBe(0);
			expect(fixed.addMemberRight).toBeLessThanOrEqual(fixed.sectionRight);
		});

		it.each(
			OTHER_WIDTHS,
		)("keeps every action inside the column at %ipx too", (width) => {
			const p = atWidth.get(width);
			expect(p, `no probe at ${width}px`).toBeDefined();
			if (!p) return;
			expect(p.clippedButtons).toBe(0);
			expect(p.addMemberRight).toBeLessThanOrEqual(p.sectionRight);
			expect(p.documentOverflowsX).toBe(false);
		});

		it("gives the content column no horizontal scroll offset for focus to move", () => {
			expect(fixed.sectionOverflowX).toBe("clip");
			expect(fixed.scrollLeftAfterWideFocus).toBe(0);
			expect(fixed.scrollLeftAfterAssign).toBe(0);
			expect(fixed.headingInside).toBe(true);
		});

		it("still keeps a too-wide page from scrolling the document sideways", () => {
			// What `hidden` was there for. `clip` must keep doing it.
			expect(fixed.documentOverflowsX).toBe(false);
		});

		it("lets a sticky child pin against the document scroll", () => {
			// The shell change's reach beyond the roster. Under \`hidden\` the
			// column was a scroll container that never scrolled, so a sticky child
			// scrolled away with the page; \`clip\` is not one, so the child pins
			// at its \`top\` as the meeting page's rail was written to.
			expect(fixed.stickyTopAfterScroll).toBe(96);
		});

		// The controls: the shipped classes, measured. Without these the
		// assertions above could be passing on a fixture too narrow to overflow.
		it("CONTROL: the non-wrapping row clips + Add member past the column", () => {
			expect(preFix.clippedButtons).toBeGreaterThan(0);
			expect(preFix.addMemberRight).toBeGreaterThan(preFix.sectionRight);
		});

		it("CONTROL: an overflow-x-hidden column is scrolled sideways by focus", () => {
			expect(preFix.sectionOverflowX).toBe("hidden");
			expect(preFix.scrollLeftAfterWideFocus).toBeGreaterThan(0);
			expect(preFix.scrollLeftAfterAssign).toBe(42);
			expect(preFix.headingInside).toBe(false);
		});

		it("CONTROL: a sticky child of an overflow-x-hidden column does not pin", () => {
			expect(preFix.stickyTopAfterScroll).toBeLessThan(0);
		});
	},
);
