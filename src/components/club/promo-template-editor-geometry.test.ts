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
const PHONE = 375;
const THUMB = 320;

function classContaining(fragment: string): string {
	const hits = [...readSource(EDITOR).matchAll(/className="([^"]*)"/g)]
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

		// What `Button` contributes that matters here: `shrink-0`, `whitespace-nowrap`.
		const btn = (label: string) =>
			`<button type="button" class="inline-flex shrink-0 items-center whitespace-nowrap px-4 h-9">${label}</button>`;

		function fixture(g: string, a: string): string {
			return `
				<div style="width:${PHONE}px">
					<div class="${g}">
						<div class="space-y-4">
							<div class="${a}" id="actions">
								<button type="submit" class="min-w-48 flex-1 h-9">Save promo template</button>
								${btn("Discard changes")}
								${btn("Reset to default (follows future updates)")}
							</div>
						</div>
						<aside class="${aside}" id="aside">
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
			grid = classContaining("lg:grid-cols");
			aside = classContaining("lg:sticky");
			actions = classContaining("flex flex-wrap gap-2");
			const preFixGrid = grid.replace(/\bgrid-cols-1\b/, "");
			const preFixActions = actions.replace(/\bflex-wrap\b/, "");
			css = await buildAppCss([
				...candidatesIn(fixture(grid, actions)),
				...candidatesIn(fixture(preFixGrid, preFixActions)),
			]);
		});

		it("reads the shipped class strings out of source", () => {
			expect(grid).toContain("grid-cols-1");
			expect(grid).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]");
			expect(aside).toContain("lg:top-20");
			expect(actions).toContain("flex-wrap");
		});

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
		});

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
