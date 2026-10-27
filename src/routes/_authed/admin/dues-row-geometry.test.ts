/**
 * An unpaid member's name stays readable at 375px (#1361). The name block was
 * `min-w-0 flex-1`, so with the badge and the Record / Waive buttons on the same
 * line the browser shrank it to a letter or two before letting anything wrap.
 *
 * jsdom lays nothing out; only a browser tells the two shapes apart. The class
 * strings come out of the real source (comment-blind); the contents are synthetic.
 * CONTROL: the pre-fix `min-w-0` must measure a narrower name.
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
const hasChrome = findChrome() !== null;

const NAME = "Abdul-Rasheed Bustamam";
/** Real page: 16px gutters, 1px card border. */
const CARD_PX = 375 - 32;

function after(src: string, anchor: string, re: RegExp): string {
	const at = src.indexOf(anchor);
	expect(at, `\`${anchor}\` not found`).toBeGreaterThan(-1);
	const m = re.exec(src.slice(at));
	expect(m, `${re} not found after ${anchor}`).not.toBeNull();
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
	"an unpaid dues row at 375px (#1361)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let row = "";
		let nameBox = "";
		let buttons = "";
		let btnBase = "";

		function measure(box: string) {
			const btn = (label: string) =>
				`<button class="${btnBase} h-8 px-3">${label}</button>`;
			const html = `<div style="width:${CARD_PX}px"><div class="${row}" data-row><div class="${box}"><span style="width:36px;height:36px;flex:none"></span><div class="min-w-0"><div class="truncate text-sm font-bold" data-name>${NAME}</div><div class="text-xs">No payment recorded</div></div></div><span data-badge class="inline-flex px-2 text-xs">Unpaid</span><div class="${buttons}">${btn("Record")}${btn("Waive")}</div></div></div>`;
			const script = `<script>(function(){var n=document.querySelector("[data-name]");var r=document.querySelector("[data-row]");document.title="nameWidth="+Math.round(n.getBoundingClientRect().width)+";truncated="+(n.scrollWidth>n.clientWidth?1:0)+";pageOverflow="+(document.documentElement.scrollWidth-document.documentElement.clientWidth)+";rowHeight="+r.clientHeight;})();</script>`;
			const title = renderAndReadTitle({
				bodyHtml: html,
				css,
				script,
				viewport: { width: 500, height: 800 },
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
				pageOverflow: n("pageOverflow"),
			};
		}

		beforeAll(async () => {
			const src = readSource(SRC);
			row = after(src, "function MemberRow", /className="([^"]*)"/);
			const at = src.indexOf("function MemberRow");
			nameBox =
				/<div className="([^"]*)">\s*<MemberAvatar/.exec(src.slice(at))?.[1] ??
				"";
			expect(nameBox, "name block className").not.toBe("");
			buttons = after(
				src,
				"<StatusBadge status={row.status} />",
				/className="([^"]*)"/,
			);
			btnBase = after(readSource(BUTTON), "cva(", /"([^"]*)"/);
			css = await buildAppCss(
				candidatesIn(
					[row, nameBox, buttons, btnBase, "min-w-0", "h-8 px-3", "truncate"]
						.map((c) => `<i class="${c}"></i>`)
						.join(""),
				),
			);
		});

		it("gives the name a readable box: the badge and buttons wrap under it", () => {
			const m = measure(nameBox);
			expect(
				m.nameWidth,
				`name box is ${m.nameWidth}px`,
			).toBeGreaterThanOrEqual(100);
			expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(0);
		});

		it("CONTROL: the pre-fix `min-w-0` leaves the name a sliver", () => {
			const m = measure(nameBox.replace(/min-w-\[[^\]]*\]/, "min-w-0"));
			expect(m.nameWidth).toBeLessThan(60);
			expect(m.truncated).toBe(true);
		});
	},
);
