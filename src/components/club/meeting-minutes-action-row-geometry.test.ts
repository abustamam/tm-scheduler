/**
 * #1349: at 375px the Minutes header's action row (Download PDF + Email the
 * minutes) ran past the card's padding because the header and the row were
 * both non-wrapping flex rows. The header's right content edge is the bound.
 *
 * Class strings come from the real source; the markup between them is
 * synthetic (mounting MeetingMinutes needs the router). The control is the
 * pre-fix classes, which must overflow, so the measurement can fail.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { cn } from "#/lib/utils";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "meeting-minutes.tsx");
const CARD = resolve(HERE, "../ui/card.tsx");

const PRE_FIX_HEADER = "flex-row items-start justify-between gap-3 space-y-0";
const PRE_FIX_ACTIONS = "flex items-center gap-2";
const BUTTON =
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border px-4 h-9 text-sm font-semibold";

function between(open: string, close: string): string {
	const src = readSource(SRC);
	const i = src.indexOf(open);
	expect(i, `${open} not in source`).toBeGreaterThan(-1);
	const j = src.indexOf(close, i + open.length);
	return src.slice(i + open.length, j);
}

const hasChrome = findChrome() !== null;

describe("minutes action row harness availability", () => {
	it("has a browser when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the Minutes header at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let header = "";
		let titleBlock = "";
		let actions = "";
		let css = "";
		let cardHeaderBase = "";

		const fixture = (h: string, t: string, a: string) => `
			<div style="width:375px;padding:0 16px;box-sizing:border-box">
			<div class="flex flex-col gap-6 rounded-xl border py-6" id="card" style="box-sizing:border-box">
				<div class="${cn(cardHeaderBase, h)}" id="header">
					<div class="${t}"><h2 class="font-semibold">Minutes</h2>
						<p class="text-sm">Attendance, Table Topics speakers, and awards — the record of what happened.</p></div>
					<div class="${a}" id="actions">
						<a class="${BUTTON}" href="#"><span class="size-4"></span>Download PDF</a>
						<button class="${BUTTON}" type="button"><span class="size-4"></span>Email the minutes</button>
					</div>
				</div>
			</div></div>`;

		const probe = (h: string, t: string, a: string) => {
			const script = `<script>
				const hd=document.getElementById("header"), ac=document.getElementById("actions");
				const cs=getComputedStyle(hd);
				const edge=hd.getBoundingClientRect().right-parseFloat(cs.paddingRight);
				const kids=[...ac.children].map(c=>c.getBoundingClientRect().right);
				document.title="over="+(Math.max(...kids)-edge)+";doc="+(document.documentElement.scrollWidth>innerWidth);
			</script>`;
			const title = renderAndReadTitle({
				bodyHtml: fixture(h, t, a),
				css,
				script,
				viewport: { width: 375, height: 700 },
			});
			return {
				over: Number(/over=([-\d.]+)/.exec(title)?.[1]),
				doc: /doc=true/.test(title),
			};
		};

		beforeAll(async () => {
			header = between('<CardHeader className="', '"');
			titleBlock = "min-w-0 space-y-1";
			const actionsLine = readSource(SRC).match(
				/<div className="(flex[^"]*)">\s*<Button asChild variant="outline" size="sm">\s*<a\s+href=\{`\/api\/meetings\/\$\{meetingId\}\/minutes\/pdf`\}/,
			);
			actions = actionsLine?.[1] ?? "";
			const m = /"(@container\/card-header[^"]*)"/.exec(readSource(CARD));
			cardHeaderBase = m?.[1] ?? "";
			css = await buildAppCss([
				...candidatesIn(
					`<div class="flex flex-col gap-6 rounded-xl border py-6 ${cn(cardHeaderBase, header)} ${cn(cardHeaderBase, PRE_FIX_HEADER)} ${titleBlock} ${actions} ${PRE_FIX_HEADER} ${PRE_FIX_ACTIONS} ${BUTTON}">`,
				),
			]);
		});

		it("reads real class strings", () => {
			expect(header).toContain("flex-row");
			expect(actions).toContain("flex");
			expect(cardHeaderBase).toContain("grid");
		});

		it("control: the pre-fix classes run past the padding", () => {
			const r = probe(PRE_FIX_HEADER, "space-y-1", PRE_FIX_ACTIONS);
			expect(r.over).toBeGreaterThan(1);
		});

		it("keeps both buttons inside the header's content box", () => {
			const r = probe(header, titleBlock, actions);
			expect(r.over).toBeLessThanOrEqual(0.5);
			expect(r.doc).toBe(false);
		});
	},
);
