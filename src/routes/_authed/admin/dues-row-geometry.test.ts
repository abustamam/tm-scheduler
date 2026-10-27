/**
 * A dues row stays readable at phone width (#1361). The name block was
 * `min-w-0 flex-1`, so with the badge and the Record / Waive buttons on the same
 * line the browser shrank it to a letter or two before letting anything wrap.
 *
 * jsdom lays nothing out; only a browser tells the shapes apart. The fixture
 * reproduces the route's wrapper (PageContainer gutter, then the Section card,
 * which is `overflow-hidden`, so a row that outgrows it is CLIPPED rather than
 * scrolled) around a row built from the real source's class strings: the row,
 * the name block, the name, the avatar size, the `Badge` and `Button` cva
 * strings and the real labels. Only the row's contents are synthetic.
 *
 * Headless Chrome lays no window out narrower than 500px, so the page is a div
 * of the phone's width inside a 500px viewport (`sm:` is 640px, so it stays off).
 *
 * CONTROLS: the pre-fix `min-w-0` must measure a sliver, and a row without
 * `flex-wrap` must push the buttons out past the card.
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
const BUTTON = resolve(HERE, "../../../components/ui/button.tsx");
const BADGE = resolve(HERE, "../../../components/ui/badge.tsx");
const CONTAINER = resolve(HERE, "../../../components/page-container.tsx");
const hasChrome = findChrome() !== null;

const NAME = "Abdul-Rasheed Bustamam";
const VIEWPORT = { width: 500, height: 800 };

function capture(
	src: string,
	anchor: string,
	re: RegExp,
	what = String(re),
): string {
	const at = src.indexOf(anchor);
	expect(at, `\`${anchor}\` not found`).toBeGreaterThan(-1);
	const m = re.exec(src.slice(at));
	expect(m, `${what} not found after ${anchor}`).not.toBeNull();
	return m?.[1] ?? "";
}

describe("dues harness availability", () => {
	it("has a browser when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome; the geometry cases would skip").toBe(
			true,
		);
	});
});

describe.skipIf(!hasChrome)(
	"a dues row on a phone (#1361)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let pageBox = "";
		let card = "";
		let row = "";
		let nameBox = "";
		let nameWrap = "";
		let nameCls = "";
		let subCls = "";
		let avatar = 0;
		let btnsWrap = "";
		let badgeBase = "";
		let badgeOutline = "";
		let badgeDefault = "";
		let badgePaid = "";
		let btnBase = "";
		let btnDefault = "";
		let btnOutline = "";
		let btnGhost = "";
		let btnSm = "";

		function html(opts: {
			phone: number;
			row: string;
			nameBox: string;
			paid: boolean;
		}): string {
			const btn = (variant: string, label: string) =>
				`<button class="${btnBase} ${variant} ${btnSm}" data-btn>${label}</button>`;
			const badge = opts.paid
				? `<span class="${badgeBase} ${badgeDefault} ${badgePaid}">Paid</span>`
				: `<span class="${badgeBase} ${badgeOutline}">Unpaid</span>`;
			const sub = opts.paid ? "$25.00 · Oct 3, 2026" : "No payment recorded";
			const buttons = opts.paid
				? btn(btnGhost, "Undo")
				: `${btn(btnDefault, "Record")}${btn(btnOutline, "Waive")}`;
			return (
				`<div data-page style="width:${opts.phone}px"><div class="${pageBox}">` +
				`<div class="${card}" data-card><div class="${opts.row}" data-row>` +
				`<div class="${opts.nameBox}"><span style="width:${avatar}px;height:${avatar}px;flex:none"></span>` +
				`<div class="${nameWrap}"><div class="${nameCls}" data-name>${NAME}</div><div class="${subCls}">${sub}</div></div></div>` +
				`${badge}<div class="${btnsWrap}">${buttons}</div>` +
				`</div></div></div></div>`
			);
		}

		function measure(o: {
			phone: number;
			row?: string;
			nameBox?: string;
			paid?: boolean;
		}) {
			const script = `<script>(function(){var q=function(s){return document.querySelector(s)};var n=q("[data-name]");var c=q("[data-card]");var cr=c.getBoundingClientRect();var inner=cr.left+c.clientLeft+c.clientWidth;var maxR=0;document.querySelectorAll("[data-btn]").forEach(function(b){maxR=Math.max(maxR,b.getBoundingClientRect().right)});var rowEl=q("[data-row]");document.title="nameWidth="+Math.round(n.getBoundingClientRect().width)+";truncated="+(n.scrollWidth>n.clientWidth?1:0)+";btnRight="+Math.round(maxR)+";cardInnerRight="+Math.round(inner)+";rowScroll="+(rowEl.scrollWidth-rowEl.clientWidth)+";pageOverflow="+(q("[data-page]").scrollWidth-q("[data-page]").clientWidth)+";rowHeight="+rowEl.clientHeight;})();</script>`;
			const title = renderAndReadTitle({
				bodyHtml: html({
					phone: o.phone,
					row: o.row ?? row,
					nameBox: o.nameBox ?? nameBox,
					paid: o.paid ?? false,
				}),
				css,
				script,
				viewport: VIEWPORT,
				tmpPrefix: "dues-row-",
			});
			expect(title, "probe produced no measurement").toContain("nameWidth=");
			const kv = new Map(
				title.split(";").map((p) => p.split("=") as [string, string]),
			);
			const n = (k: string) => Number(kv.get(k));
			return {
				nameWidth: n("nameWidth"),
				truncated: n("truncated") === 1,
				btnRight: n("btnRight"),
				cardInnerRight: n("cardInnerRight"),
				rowScroll: n("rowScroll"),
				pageOverflow: n("pageOverflow"),
				rowHeight: n("rowHeight"),
			};
		}

		beforeAll(async () => {
			const src = readSource(SRC);
			const at = src.indexOf("function MemberRow");
			const memberRow = src.slice(at);
			row = capture(src, "function MemberRow", /className="([^"]*)"/);
			nameBox = capture(
				src,
				"function MemberRow",
				/<div className="([^"]*)">\s*<MemberAvatar/,
			);
			avatar = Number(
				capture(memberRow, "<MemberAvatar", /size=\{(\d+)\}/, "avatar size"),
			);
			nameWrap = capture(
				memberRow,
				"<MemberAvatar",
				/<div className="([^"]*)">\s*<div className="truncate/,
			);
			nameCls = capture(
				memberRow,
				"<MemberAvatar",
				/<div className="([^"]*)">\{row\.name\}/,
			);
			subCls = capture(
				memberRow,
				"{row.name}",
				/<div className="(text-xs[^"]*)"/,
			);
			btnsWrap = capture(
				memberRow,
				"<StatusBadge",
				/<div className="([^"]*)">/,
			);
			card = capture(
				src,
				"function Section",
				/<div className="(overflow-hidden[^"]*)"/,
			);
			pageBox = capture(readSource(CONTAINER), "cn(", /"([^"]*)"/);
			badgePaid = capture(
				src,
				"function StatusBadge",
				/<Badge className="([^"]*)">Paid/,
			);

			const badge = readSource(BADGE);
			badgeBase = capture(badge, "cva(", /"([^"]*)"/);
			badgeOutline = capture(badge, "variant: {", /outline:\s*"([^"]*)"/);
			badgeDefault = capture(badge, "variant: {", /default:\s*"([^"]*)"/);
			const button = readSource(BUTTON);
			btnBase = capture(button, "cva(", /"([^"]*)"/);
			btnDefault = capture(button, "variant: {", /default:\s*"([^"]*)"/);
			btnOutline = capture(button, "variant: {", /outline:\s*"([^"]*)"/);
			btnGhost = capture(button, "variant: {", /ghost:\s*"([^"]*)"/);
			btnSm = capture(button, "size: {", /\n\s*sm:\s*"([^"]*)"/);

			// The variants the route uses, so a swap in dues.tsx fails here.
			expect(memberRow).toContain('<Button size="sm" variant="outline"');
			expect(memberRow).toContain('<Button size="sm" variant="ghost"');

			css = await buildAppCss(
				candidatesIn(
					[
						pageBox,
						card,
						row,
						nameBox,
						nameWrap,
						nameCls,
						subCls,
						btnsWrap,
						badgeBase,
						badgeOutline,
						badgeDefault,
						badgePaid,
						btnBase,
						btnDefault,
						btnOutline,
						btnGhost,
						btnSm,
						"min-w-0",
					]
						.map((c) => `<i class="${c}"></i>`)
						.join(""),
				),
			);
		});

		for (const phone of [375, 320]) {
			it(`${phone}px: the name is readable and Record / Waive stay inside the card`, () => {
				const m = measure({ phone });
				expect(
					m.nameWidth,
					`name box is ${m.nameWidth}px`,
				).toBeGreaterThanOrEqual(100);
				expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(0);
				expect(
					m.btnRight,
					"a button sits past the card's inner edge (the card clips it)",
				).toBeLessThanOrEqual(m.cardInnerRight);
			});

			it(`${phone}px: a paid row (one Undo button) stays inside the card`, () => {
				const m = measure({ phone, paid: true });
				expect(m.nameWidth).toBeGreaterThanOrEqual(100);
				expect(m.pageOverflow).toBeLessThanOrEqual(0);
				expect(m.btnRight).toBeLessThanOrEqual(m.cardInnerRight);
				expect(m.rowHeight, "paid row grew past two lines").toBeLessThan(120);
			});
		}

		it("CONTROL: the pre-fix `min-w-0` leaves the name a sliver", () => {
			const m = measure({
				phone: 375,
				nameBox: nameBox.replace(/min-w-\[[^\]]*\]/, "min-w-0"),
			});
			expect(m.nameWidth).toBeLessThan(60);
			expect(m.truncated).toBe(true);
		});

		it("CONTROL: a row without `flex-wrap` pushes the buttons past the card", () => {
			const m = measure({
				phone: 375,
				row: row.replace(/\bflex-wrap\b/, ""),
			});
			expect(m.btnRight).toBeGreaterThan(m.cardInnerRight);
		});
	},
);
