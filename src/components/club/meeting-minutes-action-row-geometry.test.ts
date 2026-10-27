/**
 * #1349: at 375px the Minutes header's action row (Download PDF + Email the
 * minutes) ran past the card's padding because the header and the row were
 * both non-wrapping rows.
 *
 * Class strings come from the real sources (meeting-minutes.tsx, card.tsx,
 * button.tsx) and the buttons are built with `buttonVariants` using each
 * button's real variant and size. The markup between them is synthetic
 * (mounting MeetingMinutes needs the router).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buttonVariants } from "#/components/ui/button";
import { cn } from "#/lib/utils";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const MINUTES_SRC = resolve(HERE, "meeting-minutes.tsx");
const CARD_SRC = resolve(HERE, "../ui/card.tsx");

/** The text between `open` and the next `close` in a source file. */
function sourceBetween(file: string, open: string, close: string): string {
	const src = readSource(file);
	const i = src.indexOf(open);
	expect(i, `${open} not in ${file}`).toBeGreaterThan(-1);
	const j = src.indexOf(close, i + open.length);
	return src.slice(i + open.length, j);
}

/** `cn(` first string argument of a card.tsx component, by its data-slot. */
function cardSlotClasses(slot: string): string {
	const src = readSource(CARD_SRC);
	const at = src.indexOf(`data-slot="${slot}"`);
	expect(at, `${slot} not in card.tsx`).toBeGreaterThan(-1);
	const m = /cn\(\s*"([^"]+)"/.exec(src.slice(at));
	expect(m, `no cn() string after ${slot}`).not.toBeNull();
	return m?.[1] ?? "";
}

const dropToken = (classes: string, token: string) =>
	classes
		.split(/\s+/)
		.filter((t) => t !== token)
		.join(" ");

const hasChrome = findChrome() !== null;

describe("minutes action row harness availability", () => {
	it("has a browser when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the Minutes header geometry",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let headerClasses = "";
		let titleBlockClasses = "";
		let actionsClasses = "";
		let cardClasses = "";
		let cardHeaderBase = "";
		let css = "";

		// Real buttons: Download PDF is `outline`/`sm` (meeting-minutes.tsx), the
		// Email trigger is `outline`/default (send-minutes-dialog.tsx).
		const downloadClasses = buttonVariants({ variant: "outline", size: "sm" });
		const emailClasses = buttonVariants({ variant: "outline" });

		const fixture = (cardWidth: number, header: string, actions: string) => `
			<div style="width:${cardWidth}px;padding:0 16px;box-sizing:border-box">
			<div class="${cardClasses}" id="card">
				<div class="${cn(cardHeaderBase, header)}" id="header">
					<div class="${titleBlockClasses}" id="title"><h2 class="font-semibold">Minutes</h2>
						<p class="text-sm">Attendance, Table Topics speakers, and awards — the record of what happened.</p></div>
					<div class="${actions}" id="actions">
						<a class="${downloadClasses}" href="#"><svg class="size-4"></svg>Download PDF</a>
						<button class="${emailClasses}" type="button"><svg class="size-4"></svg>Email the minutes</button>
					</div>
				</div>
			</div></div>`;

		/** Render at `viewport` px and measure the header's actions. */
		const measureHeader = (
			viewport: number,
			header: string,
			actions: string,
		) => {
			const script = `<script>
				const hd=document.getElementById("header"), ac=document.getElementById("actions"), ti=document.getElementById("title");
				const edge=hd.getBoundingClientRect().right-parseFloat(getComputedStyle(hd).paddingRight);
				const kids=[...ac.children].map(c=>c.getBoundingClientRect().right);
				document.title="over="+(Math.max(...kids)-edge)
					+";doc="+(document.documentElement.scrollWidth>innerWidth)
					+";titleW="+ti.getBoundingClientRect().width
					+";actionsTop="+ac.getBoundingClientRect().top
					+";titleBottom="+ti.getBoundingClientRect().bottom;
			</script>`;
			const title = renderAndReadTitle({
				bodyHtml: fixture(viewport, header, actions),
				css,
				script,
				viewport: { width: viewport, height: 700 },
			});
			const num = (k: string) =>
				Number(new RegExp(`${k}=([-\\d.]+)`).exec(title)?.[1]);
			return {
				overflowPastContentEdge: num("over"),
				documentScrolls: /doc=true/.test(title),
				titleWidth: num("titleW"),
				actionsStackBelowTitle: num("actionsTop") >= num("titleBottom") - 0.5,
			};
		};

		beforeAll(async () => {
			headerClasses = sourceBetween(
				MINUTES_SRC,
				'<CardHeader className="',
				'"',
			);
			titleBlockClasses = sourceBetween(
				MINUTES_SRC,
				'<CardHeader className="' +
					headerClasses +
					'">\n\t\t\t\t<div className="',
				'"',
			);
			const actionsMatch = readSource(MINUTES_SRC).match(
				/<div className="(flex[^"]*)">\s*<Button asChild variant="outline" size="sm">\s*<a\s+href=\{`\/api\/meetings\/\$\{meetingId\}\/minutes\/pdf`\}/,
			);
			actionsClasses = actionsMatch?.[1] ?? "";
			cardClasses = cardSlotClasses("card");
			cardHeaderBase = cardSlotClasses("card-header");
			css = await buildAppCss([
				...candidatesIn(
					`<div class="${[
						cardClasses,
						cardHeaderBase,
						headerClasses,
						titleBlockClasses,
						actionsClasses,
						downloadClasses,
						emailClasses,
						"size-4 font-semibold text-sm",
					].join(" ")}">`,
				),
			]);
		});

		it("reads real class strings", () => {
			expect(headerClasses.split(/\s+/)).toContain("flex");
			expect(headerClasses.split(/\s+/)).toContain("flex-wrap");
			expect(titleBlockClasses).toContain("min-w-0");
			expect(actionsClasses.split(/\s+/)).toContain("flex-wrap");
			expect(cardClasses).toContain("rounded-xl");
			expect(cardHeaderBase.split(/\s+/)).toContain("grid");
		});

		/** Inside the content box, no page scroll, title keeps a readable measure. */
		const isSane = (r: ReturnType<typeof measureHeader>) =>
			r.overflowPastContentEdge <= 0.5 &&
			!r.documentScrolls &&
			r.titleWidth >= 250;

		it("375px: the buttons stay inside the content box, below the title", () => {
			const r = measureHeader(375, headerClasses, actionsClasses);
			expect(r.overflowPastContentEdge).toBeLessThanOrEqual(0.5);
			expect(r.documentScrolls).toBe(false);
			expect(r.titleWidth).toBeGreaterThanOrEqual(250);
			expect(r.actionsStackBelowTitle).toBe(true);
		});

		it("1100px: the title and the buttons sit side by side", () => {
			const r = measureHeader(1100, headerClasses, actionsClasses);
			expect(isSane(r)).toBe(true);
			expect(r.actionsStackBelowTitle).toBe(false);
		});

		it("375px control: without the actions' `flex-wrap` the buttons spill", () => {
			const r = measureHeader(
				375,
				headerClasses,
				dropToken(actionsClasses, "flex-wrap"),
			);
			expect(r.overflowPastContentEdge).toBeGreaterThan(0.5);
		});

		it("375px control: without the header's `flex-wrap` the title is squeezed", () => {
			const r = measureHeader(
				375,
				dropToken(headerClasses, "flex-wrap"),
				actionsClasses,
			);
			expect(isSane(r)).toBe(false);
			expect(r.titleWidth).toBeLessThan(250);
		});

		it("1100px control: without the header's `flex` (the old grid) the buttons drop below the title", () => {
			const r = measureHeader(
				1100,
				dropToken(headerClasses, "flex"),
				actionsClasses,
			);
			expect(r.actionsStackBelowTitle).toBe(true);
		});
	},
);
