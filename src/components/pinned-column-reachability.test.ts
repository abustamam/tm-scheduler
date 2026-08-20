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

/**
 * The two pinned columns in this app, laid out in a real browser, asserting the
 * property that has now broken twice: the bottom of the column is REACHABLE,
 * and getting there does not cost the reader the column's chrome.
 *
 * See `src/test/pinned-column-scroll.ts` for why a browser is the only thing
 * that can see this, and for the honest limits of a synthetic fixture. The
 * class strings are read out of the real source files, so deleting a scroller
 * fails these tests — that half a source grep also covers. The half only this
 * file covers is the COMBINATION: `overflow-y-auto` on a flex child with no
 * `min-h-0` produces a box that grows instead of scrolling, and satisfies every
 * grep that asks whether the class is present.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "app-shell.tsx");
const PANEL = resolve(HERE, "club/meeting-attendance-panel.tsx");
const MEETING_ROUTE = resolve(
	HERE,
	"../routes/club.$clubId.meeting.$meetingId.tsx",
);

/**
 * Both readers are comment-blind. Every one of these elements carries a long
 * explanatory comment that quotes its own class names — matching one would
 * measure a string that is documentation rather than the shipped attribute.
 */

/** First `className="…"` after an opening tag. */
function classAfterTag(file: string, tag: string): string {
	const src = readSource(file);
	const at = src.indexOf(tag);
	expect(at, `\`${tag}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /className="([^"]*)"/.exec(src.slice(at));
	expect(m, `no className after \`${tag}\``).not.toBeNull();
	return m?.[1] ?? "";
}

/**
 * The unique `className="…"` CONTAINING `fragment` — for the elements with no
 * distinctive tag of their own (the nav band and the footer are both plain
 * `<div>`s). Uniqueness is asserted, because a fragment that starts matching
 * two elements would silently measure whichever came first.
 */
function classContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1])
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one className`,
	).toHaveLength(1);
	return hits[0];
}

const hasChrome = findChrome() !== null;

describe("pinned-column harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every reachability measurement would skip and " +
				"the suite would still report green.",
		).toBe(true);
	});
});

/**
 * A short laptop viewport — the case both bugs were reported from — and wide
 * enough that the rail's `lg:` utilities apply. At a narrower width the rail
 * fixture would quietly measure its mobile layout, where nothing is pinned and
 * every assertion here is vacuous.
 */
const VIEWPORT = { width: 1280, height: 600 };

describe.skipIf(!hasChrome)(
	"pinned column reachability",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		const cls: Record<string, string> = {};

		/** The app shell: brand / scrolling nav / pinned mini-profile. */
		const shellHtml = (navBand = cls.navBand) =>
			`<div class="flex min-h-svh w-full">
				<aside class="${cls.aside.replace(/\bhidden\b/, "")}">
					<div class="shrink-0 px-2 pt-1.5 pb-4">GavelUp</div>
					<div class="${navBand}" data-scroller>
						${Array.from(
							{ length: 28 },
							(_, i) =>
								`<a class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm"${
									i === 27 ? " data-tail" : ""
								}>Nav ${i + 1}</a>`,
						).join("")}
					</div>
					<div class="${cls.footer}" data-chrome>Sign out</div>
				</aside>
				<main class="flex min-w-0 flex-1 flex-col"><div style="height:2400px"></div></main>
			</div>`;

		/** The meeting rail: pinned aside → capped card → header + scrolling body. */
		const railHtml = (body = cls.cardBody) =>
			`<div class="flex gap-6">
				<div class="min-w-0 flex-1" style="height:2400px">agenda</div>
				<aside class="${cls.rail}">
					<div class="${cls.card} flex flex-col gap-6 rounded-xl border py-6">
						<div class="${cls.cardHeader} px-6" data-chrome>Planned attendance</div>
						<div class="${body} px-6" data-scroller>
							${Array.from(
								{ length: 40 },
								(_, i) =>
									`<div class="py-4 text-sm"${i === 39 ? " data-tail" : ""}>Member ${i + 1}</div>`,
							).join("")}
						</div>
					</div>
				</aside>
			</div>`;

		const probe = (bodyHtml: string) =>
			probeColumn({
				bodyHtml,
				css,
				scrollerSelector: "[data-scroller]",
				tailSelector: "[data-tail]",
				chromeSelector: "[data-chrome]",
				viewport: VIEWPORT,
			});

		beforeAll(async () => {
			cls.aside = classAfterTag(SHELL, "<aside");
			cls.navBand = classContaining(SHELL, "min-h-0 flex-1 flex-col");
			cls.footer = classContaining(
				SHELL,
				"rounded-xl border border-[var(--line)]",
			);
			cls.rail = classAfterTag(MEETING_ROUTE, "<aside");
			cls.card = classAfterTag(PANEL, "<Card ");
			cls.cardHeader = classAfterTag(PANEL, "<CardHeader");
			cls.cardBody = classAfterTag(PANEL, "<CardContent");
			css = await buildAppCss(candidatesIn(`${shellHtml()}${railHtml()}`));
		});

		describe("app shell sidebar", () => {
			it("reaches the last nav item and keeps sign-out in view", () => {
				const p = probe(shellHtml());
				expect(p.overflowY).toBe("auto");
				expect(p.overflows, "28 nav items should exceed a 600px rail").toBe(
					true,
				);
				expect(p.scrolledBy).toBeGreaterThan(0);
				expect(p.tailVisibleAfterScroll).toBe(true);
				// The whole point of splitting the column into bands: scrolling to
				// item 28 must not cost the reader the control that ends a session.
				expect(p.chromeVisibleAfterScroll).toBe(true);
			});

			it("is not rescued by the page scroll (what made it a bug)", () => {
				// The sticky pin is why the missing scroller was fatal rather than
				// merely awkward. If this ever goes true the sidebar has stopped
				// being pinned and the assertions above describe a different layout.
				expect(probe(shellHtml()).tailReachableByPageScroll).toBe(false);
			});

			it("loses the tail again with the scroller removed (mutation control)", () => {
				// Without this, the assertions above could be passing on a page that
				// scrolls for some unrelated reason. Same fixture, one thing removed.
				const p = probe(
					shellHtml(cls.navBand.replace(/overflow-y-auto|min-h-0/g, "")),
				);
				expect(p.tailVisibleAfterScroll).toBe(false);
				expect(p.tailReachableByPageScroll).toBe(false);
			});
		});

		describe("meeting attendance rail", () => {
			it("reaches the last member row and keeps the card header in view", () => {
				const p = probe(railHtml());
				expect(p.overflowY).toBe("auto");
				expect(p.overflows, "40 member rows should exceed the cap").toBe(true);
				expect(p.scrolledBy).toBeGreaterThan(0);
				expect(p.tailVisibleAfterScroll).toBe(true);
				// v1.19.0.0 made row 40 reachable but scrolled the title, the counts
				// line and the sync status away with it. This is that half.
				expect(p.chromeVisibleAfterScroll).toBe(true);
			});

			it("is not rescued by the page scroll (what made it a bug)", () => {
				expect(probe(railHtml()).tailReachableByPageScroll).toBe(false);
			});

			it("loses the tail again with the scroller removed (mutation control)", () => {
				const p = probe(
					railHtml(cls.cardBody.replace(/lg:overflow-y-auto|lg:min-h-0/g, "")),
				);
				expect(p.tailVisibleAfterScroll).toBe(false);
				expect(p.tailReachableByPageScroll).toBe(false);
			});

			it("loses the header if the scroller moves back out to the <aside>", () => {
				// The v1.19.0.0 layout, reconstructed: the whole column scrolls, so
				// row 40 IS reachable and the card header is gone by the time you get
				// there. This is the half the reachability assertions cannot see —
				// without it, moving the scroller back out would fail nothing.
				const p = probeColumn({
					bodyHtml: railHtml("px-6").replace(
						`class="${cls.rail}"`,
						`class="${cls.rail.replace("lg:flex-col", "lg:overflow-y-auto")}" data-scroller`,
					),
					css,
					scrollerSelector: "[data-scroller]",
					tailSelector: "[data-tail]",
					chromeSelector: "[data-chrome]",
					viewport: VIEWPORT,
				});
				expect(p.tailVisibleAfterScroll).toBe(true);
				expect(p.chromeVisibleAfterScroll).toBe(false);
			});
		});
	},
);
