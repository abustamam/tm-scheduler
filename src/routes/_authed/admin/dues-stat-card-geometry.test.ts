/**
 * The Collected card's note stays inside its card at phone width (#1386).
 * `StatCard`'s value/note row was a non-wrapping `flex`, so "from entered
 * amounts" ran past the card edge beside `$655.00` at 375px.
 *
 * Every class string is read from dues.tsx (the stat grid, the card, the label,
 * the row, the value, the note) and the page gutter from page-container.tsx, so
 * a change to the source changes what is measured. Only the text is synthetic.
 * Headless Chrome lays no window out narrower than 500px, so the page is a div
 * of the phone's width inside a 500px viewport.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "dues.tsx");
const CONTAINER = resolve(HERE, "../../../components/page-container.tsx");
const hasChrome = findChrome() !== null;

function capture(src: string, anchor: string, re: RegExp): string {
	const at = src.indexOf(anchor);
	expect(at, `\`${anchor}\` not found`).toBeGreaterThan(-1);
	const m = re.exec(src.slice(at));
	expect(m, `${re} not found after ${anchor}`).not.toBeNull();
	return m?.[1] ?? "";
}

describe("dues stat card harness availability", () => {
	it("has a browser when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome; the geometry cases would skip").toBe(
			true,
		);
	});
});

describe.skipIf(!hasChrome)(
	"the Collected stat card (#1386)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let pageBox = "";
		let grid = "";
		let card = "";
		let label = "";
		let valueRow = "";
		let valueCls = "";
		let noteCls = "";

		function measure(o: { page: number; value: string; row?: string }) {
			const body =
				`<div data-page style="width:${o.page}px"><div class="${pageBox}">` +
				`<div class="${grid}">` +
				// The real grid holds four cards; three siblings keep the column
				// count (two at 375px) the Collected card really gets.
				[1, 2, 3]
					.map(
						() =>
							`<div class="${card}"><div class="${label}">Paid</div><div class="${valueRow}"><span class="${valueCls}">0</span></div></div>`,
					)
					.join("") +
				`<div class="${card}" data-card>` +
				`<div class="${label}">Collected</div>` +
				`<div class="${o.row ?? valueRow}" data-row><span class="${valueCls}" data-value>${o.value}</span>` +
				`<span class="${noteCls}" data-note>from entered amounts</span></div>` +
				`</div></div></div></div>`;
			const script = `<script>(function(){var q=function(s){return document.querySelector(s)};var c=q("[data-card]").getBoundingClientRect();var n=q("[data-note]").getBoundingClientRect();var v=q("[data-value]").getBoundingClientRect();var p=q("[data-page]");document.title="noteRight="+Math.round(n.right)+";cardRight="+Math.round(c.right)+";noteTop="+Math.round(n.top)+";valueBottom="+Math.round(v.bottom)+";noteLeft="+Math.round(n.left)+";valueLeft="+Math.round(v.left)+";pageOverflow="+(p.scrollWidth-p.clientWidth);})();</script>`;
			const title = renderAndReadTitle({
				bodyHtml: body,
				css,
				script,
				viewport: { width: Math.max(500, o.page), height: 800 },
				tmpPrefix: "dues-stat-",
			});
			expect(title, "probe produced no measurement").toContain("noteRight=");
			const kv = new Map(
				title.split(";").map((p) => p.split("=") as [string, string]),
			);
			const n = (k: string) => Number(kv.get(k));
			return {
				noteRight: n("noteRight"),
				cardRight: n("cardRight"),
				noteTop: n("noteTop"),
				valueBottom: n("valueBottom"),
				noteLeft: n("noteLeft"),
				valueLeft: n("valueLeft"),
				pageOverflow: n("pageOverflow"),
			};
		}

		beforeAll(async () => {
			const src = readSource(SRC);
			grid = capture(
				src,
				"{totals ? (",
				/<div className="(grid grid-cols-\[[^"]*)"/,
			);
			card = capture(
				src,
				"function StatCard",
				/"(rounded-xl border bg-surface-raised[^"]*)"/,
			);
			label = capture(
				src,
				"function StatCard",
				/<div className="(text-xs font-bold[^"]*)"/,
			);
			valueRow = capture(
				src,
				"function StatCard",
				/<div className="(mt-2 flex[^"]*)"/,
			);
			valueCls = capture(src, "function StatCard", /"(font-display[^"]*)"/);
			noteCls = capture(
				src,
				"function StatCard",
				/<span className="(text-xs text-muted-foreground)">\{note\}/,
			);
			pageBox = capture(readSource(CONTAINER), "cn(", /"([^"]*)"/);
			css = await buildAppCss(
				candidatesIn(
					[pageBox, grid, card, label, valueRow, valueCls, noteCls]
						.map((c) => `<i class="${c}"></i>`)
						.join(""),
				),
			);
		});

		for (const page of [375, 320]) {
			it(`${page}px: the note stays inside the card, under the value`, () => {
				const m = measure({ page, value: "$655.00" });
				expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(0);
				expect(m.noteRight, "note runs past the card").toBeLessThanOrEqual(
					m.cardRight,
				);
				expect(m.noteTop, "note should drop under the value").toBeGreaterThan(
					m.valueBottom - 1,
				);
				expect(m.noteLeft, "wrapped note stays left-aligned").toBe(m.valueLeft);
			});
		}

		it("CONTROL: without `flex-wrap` the note runs past the card at 375px", () => {
			const m = measure({
				page: 375,
				value: "$655.00",
				row: valueRow.replace(/\bflex-wrap\b/, ""),
			});
			expect(m.noteRight).toBeGreaterThan(m.cardRight);
		});

		it("CONTROL: a short value on a wide card keeps the note on the value's line", () => {
			const m = measure({ page: 1000, value: "$5" });
			expect(m.noteTop).toBeLessThan(m.valueBottom);
			expect(m.noteLeft).toBeGreaterThan(m.valueLeft);
			expect(m.noteRight).toBeLessThanOrEqual(m.cardRight);
		});
	},
);
