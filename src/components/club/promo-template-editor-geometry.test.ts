/**
 * The editor and its preview at a 375px phone (#1537).
 *
 * jsdom lays nothing out, so the editor suite cannot see the two ways this
 * page went sideways in a real browser. Found on the first look at 375px:
 *
 * 1. The Save / Discard / Reset row was a non-wrapping flex row of `shrink-0`,
 *    `whitespace-nowrap` buttons, so Reset ran 130px past the screen edge.
 * 2. Put inside a grid whose single track was a bare `auto`, that same row
 *    sized the track to its own width and the preview column (343px of room)
 *    came out 487px wide, with the flyer thumbnail and the toggles past the edge.
 *
 * The class strings are read out of the real source. The markup between them is
 * synthetic (the real editor needs the server module and the router), so this
 * proves the class COMBINATION lays out inside a phone, beside the editor's
 * jsdom test which pins what it renders. Headless Chrome will not lay a window
 * out below 500px, so the fixture pins its own 375px wrapper and measures
 * against that. The CONTROL reproduces the pre-fix classes and must overflow.
 */
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	probeColumn,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const EDITOR = resolve(__dirname, "promo-template-editor.tsx");
const PREVIEW = resolve(__dirname, "promo-preview.tsx");
const BUTTON = resolve(__dirname, "../ui/button.tsx");
const PHONE = 375;
const THUMB = 320;

function classContaining(fragment: string, file = EDITOR): string {
	const hits = [...readSource(file).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(hits, `\`${fragment}\` should match one className`).toHaveLength(1);
	return hits[0] as string;
}

const hasChrome = findChrome() !== null;

describe("editor geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome; the geometry gate would skip").toBe(
			true,
		);
	});
});

describe.skipIf(!hasChrome)(
	"the editor at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let grid = "";
		let aside = "";
		let actions = "";
		let panel = "";
		// The muted line under the button row.
		let note = "";

		// `Button`'s real base and default-size classes, read from its source.
		let buttonClass = "";
		const btn = (label: string) =>
			`<button type="button" class="${buttonClass}">${label}</button>`;

		function fixture(g: string, a: string): string {
			return `
				<div style="width:${PHONE}px">
					<div class="${g}">
						<div class="space-y-4">
							<div class="${a}" id="actions">
								<button type="submit" class="min-w-48 flex-1 h-9">Save template</button>
								${btn("Discard changes")}
								${btn("Start over with GavelUp's template")}
							</div>
							<p class="${note}" id="note">Starting over also picks up improvements GavelUp makes to its template later.</p>
						</div>
						<aside class="${aside}" id="aside">
							<div id="panels">
								<div class="${panel}" data-state="active" id="panel-on">on</div>
								<div class="${panel}" data-state="inactive" id="panel-off">off<br>off</div>
							</div>
							<div style="width:${THUMB}px;height:${THUMB}px" id="thumb"></div>
							<span id="tail">end</span>
						</aside>
					</div>
					<div id="chrome"></div>
				</div>`;
		}

		const probe = (g: string, a: string, scroller: string) =>
			probeColumn({
				bodyHtml: fixture(g, a),
				css,
				scrollerSelector: scroller,
				tailSelector: "#tail",
				chromeSelector: "#chrome",
				viewport: { width: PHONE, height: 800 },
			});

		beforeAll(async () => {
			const src = readSource(BUTTON);
			const base = /cva\(\s*"([^"]*)"/.exec(src)?.[1];
			const size = /default:\s*"(h-9[^"]*)"/.exec(src)?.[1];
			expect(base, "Button's cva base string").toBeTruthy();
			expect(size, "Button's default size string").toBeTruthy();
			buttonClass = `${base} ${size}`;
			panel = classContaining("data-[state=inactive]:hidden", PREVIEW);
			grid = classContaining("lg:grid-cols");
			aside = classContaining("lg:sticky");
			actions = classContaining("flex flex-wrap gap-2");
			note = classContaining("text-xs text-muted-foreground");
			const preFixGrid = grid.replace(/\bgrid-cols-1\b/, "");
			const preFixActions = actions.replace(/\bflex-wrap\b/, "");
			css = await buildAppCss([
				...candidatesIn(fixture(grid, actions)),
				...candidatesIn(fixture(preFixGrid, preFixActions)),
			]);
		});

		// protects=the fixture's grid, aside, actions and panel classes are the ones in the component source (grid-cols-1, the lg two-column track, lg:top-20, flex-wrap, the inactive-hidden variant);
		// fails_when=a class is renamed or dropped in the source and the fixture silently measures something else;
		// no_claim=that the classes lay out correctly (the next tests measure that).
		it("reads the shipped class strings out of source", () => {
			expect(grid).toContain("grid-cols-1");
			expect(grid).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]");
			expect(aside).toContain("lg:top-20");
			expect(actions).toContain("flex-wrap");
		});

		// protects=at 375px the preview column is at most 375px wide yet fits the 320px thumbnail, and the Save / Discard / Reset row does not overflow horizontally;
		// fails_when=the grid track sizes to the button row, or the row stops wrapping, so content runs past the screen edge;
		// no_claim=the real editor's markup or the real Button beyond its source class string.
		it("keeps the preview column and the button row inside the phone", () => {
			const column = probe(grid, actions, "#aside");
			expect(column.scrollerClientWidth).toBeLessThanOrEqual(PHONE);
			// The thumbnail's own width fits its column.
			expect(column.scrollerClientWidth).toBeGreaterThanOrEqual(THUMB);
			const row = probe(grid, actions, "#actions");
			expect(
				row.overflowsX,
				"the Save / Discard / Reset row runs past the screen edge",
			).toBe(false);
			expect(
				probe(grid, actions, "#note").overflowsX,
				"the muted line under the button row runs past the screen edge",
			).toBe(false);
		});

		// protects=in headless Chrome a panel with data-state=inactive and the source's class string has a zero-width box while the active one does not;
		// fails_when=the inactive-hidden variant is dropped or misspelled so a force-mounted panel shows beside the active one;
		// no_claim=that Radix sets data-state in the real DOM (the jsdom test reads it).
		it("hides an inactive force-mounted panel and shows the active one", () => {
			expect(probe(grid, actions, "#panel-off").scrollerClientWidth).toBe(0);
			expect(
				probe(grid, actions, "#panel-on").scrollerClientWidth,
			).toBeGreaterThan(0);
		});

		// protects=the harness can see the defect: removing grid-cols-1 and flex-wrap makes the column and the row overflow;
		// fails_when=the harness cannot detect overflow, so the passing test above proves nothing;
		// no_claim=that the shipped classes are right.
		it("control: the pre-fix classes push both past the phone", () => {
			const preGrid = grid.replace(/\bgrid-cols-1\b/, "");
			const preActions = actions.replace(/\bflex-wrap\b/, "");
			expect(
				probe(preGrid, preActions, "#aside").scrollerClientWidth,
			).toBeGreaterThan(PHONE);
			expect(probe(grid, preActions, "#actions").overflowsX).toBe(true);
		});
	},
);
