/**
 * The Pathways card keeps its path tabs and project chips inside the card at a
 * phone width, for a member enrolled in two paths (#1218).
 *
 * jsdom performs no layout, so the class-string test in
 * `pathways-progress.test.tsx` could not see that `h-auto` loses to the base
 * TabsList class `group-data-[orientation=horizontal]/tabs:h-9`: the list stayed
 * 36px tall and a wrapped second row of tabs spilled onto the content below.
 * This renders the REAL component to markup and measures it in headless Chrome.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PathViewModel } from "#/server/pathways-read-logic";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
import { PathwaysProgress } from "./pathways-progress";

const PHONE = 375;
const LONG = "Understanding Emotional Intelligence And Its Many Long Facets";

const base: PathViewModel = {
	courseCode: "8701",
	pathName: "Presentation Mastery And Public Speaking Excellence",
	status: "current",
	ringPercent: 40,
	currentLevel: 3,
	complete: false,
	workingLevel: 3,
	projectsLeftAtWorkingLevel: 3,
	levels: [{ level: 3, completed: 1, total: 4, approved: false }],
	levelsSource: "basecamp",
	hasBasecamp: true,
	wins: [],
	upNext: [{ projectId: "p1", name: LONG, isRequired: true }],
	// A null projectId renders the plain (non-button) chip even with onMark.
	upNextElectives: {
		chooseCount: 1,
		options: [{ projectId: null, name: `Plain chip: ${LONG}` }],
	},
	upNextSeries: [],
} as unknown as PathViewModel;

const hasChrome = findChrome() !== null;

describe.skipIf(!hasChrome)(
	"the Pathways card at 375px with two paths",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("keeps the tab list, tabs and chips inside the card with no overlap", async () => {
			const html = renderToStaticMarkup(
				<PathwaysProgress
					paths={[
						base,
						{
							...base,
							courseCode: "8702",
							pathName: "Dynamic Leadership With An Equally Long Name",
						},
					]}
					timeZone="UTC"
					onMark={() => {}}
				/>,
			);
			const css = await buildAppCss(candidatesIn(html));
			const script = `<script>
				var frame = document.getElementById("frame");
				var card = frame.querySelector("[data-slot=card]");
				var cardRight = card.getBoundingClientRect().right;
				var list = frame.querySelector("[data-slot=tabs-list]");
				var content = frame.querySelector("[data-slot=tabs-content]");
				var tabs = frame.querySelectorAll("[data-slot=tabs-trigger]");
				var chips = frame.querySelectorAll("[data-slot=badge]");
				var buttons = frame.querySelectorAll("button[aria-label^=Mark]");
				var maxTab = 0, maxChip = 0, tabTops = {};
				tabs.forEach(function (t) {
					var r = t.getBoundingClientRect();
					maxTab = Math.max(maxTab, r.right);
					tabTops[Math.round(r.top)] = 1;
				});
				chips.forEach(function (c) { maxChip = Math.max(maxChip, c.getBoundingClientRect().right); });
				buttons.forEach(function (c) { maxChip = Math.max(maxChip, c.getBoundingClientRect().right); });
				var lastTabBottom = 0;
				tabs.forEach(function (t) { lastTabBottom = Math.max(lastTabBottom, t.getBoundingClientRect().bottom); });
				document.title = [
					"cardRight=" + Math.ceil(cardRight),
					"maxTab=" + Math.ceil(maxTab),
					"maxChip=" + Math.ceil(maxChip),
					"listTop=" + Math.floor(list.getBoundingClientRect().top),
					"listBottom=" + Math.floor(list.getBoundingClientRect().bottom),
					"tabBottom=" + Math.ceil(lastTabBottom),
					"contentTop=" + Math.ceil(content.getBoundingClientRect().top),
					"rows=" + Object.keys(tabTops).length,
					"tabs=" + tabs.length,
					"chips=" + chips.length,
					"buttons=" + buttons.length,
				].join(";");
			</script>`;
			const title = renderAndReadTitle({
				bodyHtml: `<div id="frame" style="width:${PHONE}px;overflow-x:hidden">${html}</div>`,
				css,
				script,
				viewport: { width: 600, height: 900 },
				tmpPrefix: "pathways-geometry-",
			});
			expect(title, "the probe produced no measurement").toContain(
				"cardRight=",
			);
			const m = Object.fromEntries(
				title.split(";").map((p) => {
					const [k, v] = p.split("=");
					return [k, Number(v)];
				}),
			) as Record<string, number>;

			expect(m.tabs).toBe(2);
			// One plain chip, one `onMark` button wrapping a chip, plus the chip in it.
			expect(m.buttons).toBe(1);
			expect(m.chips).toBeGreaterThanOrEqual(2);
			// The long names must wrap their labels (tabs share the row and break
			// inside), so the list has to grow past its 36px default; otherwise
			// this would not exercise the fixed height that used to clip them.
			expect(
				m.tabBottom - m.listTop,
				"the tab labels should wrap",
			).toBeGreaterThan(40);
			expect(m.maxTab).toBeLessThanOrEqual(m.cardRight);
			expect(m.maxChip).toBeLessThanOrEqual(m.cardRight);
			// The list grows with its wrapped row instead of staying 36px.
			expect(
				m.listBottom,
				"the tab list is shorter than its wrapped tabs",
			).toBeGreaterThanOrEqual(m.tabBottom - 1);
			expect(m.listBottom).toBeLessThanOrEqual(m.contentTop);
		});
	},
);
