/**
 * The Collected card's note stays inside its card at phone width (#1386).
 * `StatCard`'s value/note row was a non-wrapping `flex`, so "from entered
 * amounts" ran past the card edge beside `$655.00` at 375px.
 *
 * `StatCard` itself is rendered (exported from dues.tsx), so its markup and
 * classes are the source's own. Only the surrounding stat grid and the page
 * gutter are read from dues.tsx / page-container.tsx by regex. Headless Chrome
 * lays no window out narrower than 500px, so the page is a div of the phone's
 * width inside a 500px viewport.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";
import { StatCard } from "./dues";

// dues.tsx reaches `#/db` through the server modules it imports, which throws
// at import without a DATABASE_URL. StatCard never touches the database.
vi.mock("#/db", () => ({ db: {} }));

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

const collected = (value: string) =>
	renderToStaticMarkup(
		<StatCard label="Collected" value={value} note="from entered amounts" />,
	).replace("<div", "<div data-card");
const sibling = () => renderToStaticMarkup(<StatCard label="Paid" value="0" />);

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

		function measure(o: {
			page: number;
			value: string;
			stripFlexWrap?: boolean;
		}) {
			let card = collected(o.value);
			if (o.stripFlexWrap) card = card.replace(/\bflex-wrap\b/, "");
			const body =
				`<div data-page style="width:${o.page}px"><div class="${pageBox}">` +
				// The real grid holds four cards; three siblings keep the column
				// count (two at 375px) the Collected card really gets.
				`<div class="${grid}">${sibling()}${sibling()}${sibling()}${card}</div>` +
				"</div></div>";
			const script = `<script>(function(){var r=function(e){return e.getBoundingClientRect()};var c=document.querySelector("[data-card]");var sp=c.querySelectorAll("span");var cr=r(c),v=r(sp[0]),n=r(sp[1]);var p=document.querySelector("[data-page]");document.title="noteRight="+Math.round(n.right)+";cardRight="+Math.round(cr.right)+";noteTop="+Math.round(n.top)+";valueBottom="+Math.round(v.bottom)+";noteLeft="+Math.round(n.left)+";valueLeft="+Math.round(v.left)+";pageOverflow="+(p.scrollWidth-p.clientWidth);})();</script>`;
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
			const num = (k: string) => Number(kv.get(k));
			return {
				noteRight: num("noteRight"),
				cardRight: num("cardRight"),
				noteTop: num("noteTop"),
				valueBottom: num("valueBottom"),
				noteLeft: num("noteLeft"),
				valueLeft: num("valueLeft"),
				pageOverflow: num("pageOverflow"),
			};
		}

		beforeAll(async () => {
			grid = capture(
				readSource(SRC),
				"{totals ? (",
				/<div className="(grid grid-cols-\[[^"]*)"/,
			);
			pageBox = capture(readSource(CONTAINER), "cn(", /"([^"]*)"/);
			css = await buildAppCss(
				candidatesIn(
					`<i class="${pageBox} ${grid}"></i>${collected("$655.00")}${sibling()}`,
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
				stripFlexWrap: true,
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
