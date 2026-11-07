/**
 * The guest invite editor's tab row at 375px (#1547).
 *
 * Four tabs do not fit one row on a phone, so the row is a 2x2 grid. The shared
 * `TabsList` gives itself a fixed 36px height through a `group-data-` variant,
 * and a plain `h-auto` on the editor's className LOSES to it: the list stayed one
 * row tall and the second row of tabs spilled over the "Message" field's label,
 * found by loading the page at 375x812 before this PR was opened. jsdom has no
 * layout, and a grep sees `h-auto` present, which is the half that is not the
 * bug. Only a browser tells them apart.
 *
 * The class strings come out of the real source files (the editor's own, and
 * `tabs.tsx`'s via `tabsListVariants` and the trigger literal), merged with the
 * same `cn` the components use. The markup BETWEEN them is synthetic: mounting
 * the editor needs server fns. So this proves the class COMBINATION lays out
 * without overlap at a phone width. The CONTROL is the pre-fix classes, which
 * must overlap, so the assertions are able to fail.
 *
 * Does NOT cover: the fonts (they never load here), or the tab panel's contents.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tabsListVariants } from "#/components/ui/tabs";
import { cn } from "#/lib/utils";
import { readSource } from "#/test/guard-source";
import { buildAppCss, renderAndReadTitle } from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const EDITOR = readSource(resolve(HERE, "guest-invite-template-editor.tsx"));
const TABS = readSource(resolve(HERE, "../ui/tabs.tsx"));

const hasChrome = findChrome() !== null;

/** The class string of the editor's tab list and of its triggers, from source. */
function editorClasses(): { list: string; trigger: string } {
	const list = /<TabsList[^>]*?className="([^"]*grid-cols-2[^"]*)"/s.exec(
		EDITOR,
	)?.[1];
	const trigger = /<TabsTrigger[^>]*?className="([^"]*)"/s.exec(EDITOR)?.[1];
	if (!list || !trigger) throw new Error("tab classNames not found in editor");
	return { list, trigger };
}

/** The shared trigger's base literal (the long one), from `tabs.tsx`. */
function triggerBase(): string {
	const hit = [...TABS.matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.find((c) => c.includes("relative inline-flex"));
	if (!hit) throw new Error("trigger classes not found in tabs.tsx");
	return hit;
}

const LABELS = [
	"Never visited",
	"First visit, recent",
	"Repeat visit, recent",
	"Lapsed",
];

function fixture(listClass: string, triggerClass: string) {
	const list = cn(tabsListVariants({ variant: "default" }), listClass);
	const trigger = cn(triggerBase(), triggerClass);
	const html = `
		<div data-slot="tabs" data-orientation="horizontal" class="group/tabs flex gap-2 data-[orientation=horizontal]:flex-col p-4">
			<div id="list" role="tablist" data-slot="tabs-list" data-variant="default" class="group/tabs-list ${list}">
				${LABELS.map((l) => `<button role="tab" class="${trigger}">${l}</button>`).join("")}
			</div>
			<div id="after" class="pt-2 text-sm">Message</div>
		</div>`;
	const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) =>
		(m[1] as string).split(/\s+/),
	);
	return { html, classes: [...new Set(classes)] };
}

async function measure(listClass: string, triggerClass: string) {
	const { html, classes } = fixture(listClass, triggerClass);
	const title = renderAndReadTitle({
		bodyHtml: html,
		css: await buildAppCss(classes),
		viewport: { width: 375, height: 812 },
		tmpPrefix: "guest-invite-tabs-",
		script: `<script>
			var list = document.getElementById("list");
			var after = document.getElementById("after").getBoundingClientRect();
			var tabs = Array.from(list.querySelectorAll("[role=tab]"));
			var lowest = Math.max.apply(null, tabs.map(function (t) { return t.getBoundingClientRect().bottom; }));
			document.title = [
				"listBottom=" + list.getBoundingClientRect().bottom,
				"lowestTab=" + lowest,
				"afterTop=" + after.top,
				"minTab=" + Math.min.apply(null, tabs.map(function (t) { return t.getBoundingClientRect().height; })),
				"docOverflows=" + (document.documentElement.scrollWidth > window.innerWidth),
			].join("|");
		</script>`,
	});
	const kv = new Map(
		title.split("|").map((p) => p.split("=") as [string, string]),
	);
	if (!kv.has("afterTop")) throw new Error(`probe returned: ${title}`);
	return {
		listBottom: Number(kv.get("listBottom")),
		lowestTab: Number(kv.get("lowestTab")),
		afterTop: Number(kv.get("afterTop")),
		minTab: Number(kv.get("minTab")),
		docOverflows: kv.get("docOverflows") === "true",
	};
}

describe("guest invite editor geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the geometry cases would skip",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the guest invite tab row at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		// protects=the 2x2 tab grid encloses its second row and the field below
		// starts under it, with 44px tap targets and no sideways scroll;
		// fails_when=the list's own fixed height wins again (the list ends above the
		// lowest tab, so the next element overlaps it) or a tab is under 44px;
		// no_claim=real fonts, or the tab panel's contents.
		it("encloses all four tabs, clear of the next element", async () => {
			const { list, trigger } = editorClasses();
			const m = await measure(list, trigger);
			expect(m.listBottom).toBeGreaterThanOrEqual(m.lowestTab - 0.5);
			expect(m.afterTop).toBeGreaterThanOrEqual(m.lowestTab - 0.5);
			expect(m.minTab).toBeGreaterThanOrEqual(44 - 0.5);
			expect(m.docOverflows).toBe(false);
		});

		// The CONTROL: the classes this PR first shipped. It must overlap, or the
		// case above could not have failed.
		it("control: the pre-fix classes overlap the next element", async () => {
			const m = await measure(
				"grid h-auto w-full grid-cols-2 md:grid-cols-4",
				"min-h-11 md:min-h-9",
			);
			expect(m.listBottom).toBeLessThan(m.lowestTab - 0.5);
		});
	},
);
