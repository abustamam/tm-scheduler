/**
 * The square flyer never clips its QR or its disclaimer (#931).
 *
 * The square is a fixed 1080x1080 box with `overflow: hidden`, so content that
 * does not fit is cut off silently — and the two things that must never be
 * cut are the QR (the whole point of the image) and the ADR-0024
 * non-affiliation disclaimer. jsdom does no layout, so this lays the SHIPPED
 * layout out in headless Chrome with EVERY free-text field at its cap and
 * measures both boxes against the canvas.
 *
 * The layout has two independent guards — the text block gives way
 * (`TEXT_BLOCK_GIVES_WAY`) and every field is line-clamped — and each is
 * asserted to hold ALONE by stripping the other from the shipped markup. A
 * control strips both and must overflow: if it ever stops, the fixture has
 * stopped being long enough to prove anything.
 *
 * Mutation record (`bun run mutate`, 2026-09-26), each observed red:
 *   `...TEXT_BLOCK_GIVES_WAY,` → `...{},` ...... KILLED (2 failed)
 *   `WebkitLineClamp: lines,` → `: 99,` ........ KILLED (1 failed)
 *
 * Same Chrome discovery and skip-locally / fail-in-CI rule as the other
 * browser-backed suites (`src/test/print-page-count.ts`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MEETING_LIMITS } from "#/lib/meeting-limits";
import {
	buildFlyerContent,
	DEFAULT_PROMO_TEMPLATE,
	PROMO_LIMITS,
	promoValues,
} from "#/lib/promo-template";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";
import { FLYER_SQUARE_PX, MeetingFlyerSquare } from "./meeting-flyer";

const chrome = findChrome();

/** `n` characters of wrapping prose. */
const prose = (n: number) =>
	"Wonderful words wrap widely ".repeat(Math.ceil(n / 28)).slice(0, n);

const capped = () => {
	const c = buildFlyerContent(
		{ ...DEFAULT_PROMO_TEMPLATE, headline: prose(PROMO_LIMITS.headline) },
		promoValues(
			{ name: prose(120), slug: "downtown", timezone: "America/Chicago" },
			{
				urlKey: "2026-10-01",
				scheduledAt: "2026-10-02T00:30:00Z",
				location: prose(MEETING_LIMITS.location),
				online: true,
				theme: prose(MEETING_LIMITS.theme),
				wordOfTheDay: null,
				meetingNumber: 57,
				promoNote: prose(PROMO_LIMITS.note),
			},
			"https://gavelup.app",
		),
	);
	expect(c.headline).toHaveLength(PROMO_LIMITS.headline);
	expect(c.note).toHaveLength(PROMO_LIMITS.note);
	return c;
};

type Box = { top: number; bottom: number; left: number; right: number };

/** Lay `markup` out and return each selector's box relative to the square. */
function boxes(markup: string, selectors: string[]): Record<string, Box> {
	if (!chrome) throw new Error("no chrome");
	const probe = `<script>
	(function () {
		var root = document.querySelector("[data-flyer-square]").getBoundingClientRect();
		var out = {};
		${JSON.stringify(selectors)}.forEach(function (s) {
			var el = document.querySelector(s);
			if (!el) { out[s] = null; return; }
			var r = el.getBoundingClientRect();
			out[s] = { top: r.top - root.top, bottom: r.bottom - root.top,
				left: r.left - root.left, right: r.right - root.left };
		});
		document.title = JSON.stringify(out);
	})();
	</script>`;
	const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup}${probe}</body></html>`;
	const dir = mkdtempSync(join(tmpdir(), "flyer-geom-"));
	try {
		const path = join(dir, "page.html");
		writeFileSync(path, html, "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1200,1200",
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${path}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 20_000, env: CHROME_ENV },
		);
		const m = dom.match(/<title>([^<]*)<\/title>/);
		if (!m) throw new Error("the probe did not run");
		const json = (m[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
		const out = JSON.parse(json) as Record<string, Box | null>;
		for (const s of selectors) {
			if (!out[s]) throw new Error(`${s} matched nothing`);
		}
		return out as Record<string, Box>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const inside = (b: Box) =>
	b.top >= 0 &&
	b.left >= 0 &&
	b.bottom <= FLYER_SQUARE_PX &&
	b.right <= FLYER_SQUARE_PX;

const SELECTORS = ["[data-flyer-qr]", "[data-flyer-disclaimer]"];

describe("square flyer geometry harness availability", () => {
	it("has a Chrome to lay out in when running in CI", () => {
		if (!process.env.CI) return;
		expect(chrome, "CI has no Chrome on PATH — this gate would skip").not.toBe(
			null,
		);
	});
});

describe.skipIf(!chrome)(
	"the square flyer keeps its QR and disclaimer on the canvas (#931)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		const markup = renderToStaticMarkup(
			<MeetingFlyerSquare content={capped()} clubName={prose(120)} />,
		);

		it("with every free-text field at its cap", () => {
			const b = boxes(markup, SELECTORS);
			for (const s of SELECTORS) {
				expect(inside(b[s] as Box), `${s} ${JSON.stringify(b[s])}`).toBe(true);
			}
		});

		// TWO independent guards, each asserted to hold ALONE, so reverting
		// either one in the source (`bun run mutate`) turns one case red instead
		// of being masked by the other:
		//   - `TEXT_BLOCK_GIVES_WAY`: the text block shrinks and clips;
		//   - the per-field line clamps bound each field's height.
		const noGiveWay = (m: string) =>
			m.replace("flex:1 1 0;min-height:0;overflow:hidden;", "");
		const noClamp = (m: string) => m.replace(/-webkit-line-clamp:\d+;?/g, "");

		it("the text block giving way alone keeps them on (clamps stripped)", () => {
			const stripped = noClamp(markup);
			expect(stripped).not.toBe(markup);
			const b = boxes(stripped, SELECTORS);
			for (const s of SELECTORS) expect(inside(b[s] as Box), s).toBe(true);
		});

		it("the clamps alone keep them on (text block not giving way)", () => {
			const stripped = noGiveWay(markup);
			expect(stripped).not.toBe(markup);
			const b = boxes(stripped, SELECTORS);
			for (const s of SELECTORS) expect(inside(b[s] as Box), s).toBe(true);
		});

		it("with BOTH guards stripped the QR falls off the canvas (control)", () => {
			const b = boxes(noGiveWay(noClamp(markup)), SELECTORS);
			expect(inside(b["[data-flyer-qr]"] as Box)).toBe(false);
		});
	},
);
