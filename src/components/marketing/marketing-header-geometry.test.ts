/**
 * Every marketing header link stays on screen at phone width (#870).
 *
 * #870 added a third header link ("How it works"). The brand plus three ghost
 * buttons need ~430px on one row, a phone has ~320-335px inside the gutters,
 * and `Button` is `shrink-0 whitespace-nowrap`, so nothing gives. `body` is
 * `overflow-x: hidden`, so the overflow does not scroll either: "Sign in" is
 * simply clipped off the right edge. Codex caught it in review with every
 * other gate green, because jsdom performs no layout.
 *
 * The footer gained two links in the same change; its five fit a 375px screen
 * with no slack at all, so it wraps too and is measured below.
 *
 * Same construction as `confirm-table-geometry.test.ts`: the real `className`
 * strings are read out of source (and `buttonVariants` imported), the markup
 * between them is synthetic, and a pre-fix control without `flex-wrap`
 * reproduces the clipping so the main assertion can fail.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buttonVariants } from "#/components/ui/button";
import { readSource } from "#/test/guard-source";
import { buildAppCss, candidatesIn } from "#/test/pinned-column-scroll";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";
import { FOOTER_LINKS, HEADER_LINKS } from "./marketing-shell";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, "marketing-shell.tsx");
const BRAND = resolve(HERE, "../brand-mark.tsx");

/** The unique `className="…"` in `file` containing `fragment` (comment-blind). */
function classContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one className in ${file}`,
	).toHaveLength(1);
	return hits[0] as string;
}

/**
 * Over every `#<rootId> a`: the widest right and narrowest left edge, how many
 * distinct rows the links sit on, the viewport width, and how many links broke
 * their own label across two lines.
 */
function measureLinks(
	bodyHtml: string,
	css: string,
	width: number,
	rootId = "header",
): {
	maxRight: number;
	minLeft: number;
	rows: number;
	viewport: number;
	links: number;
	wrapped: number;
} {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome — set CHROME_PATH.");
	const probe = `<script>
		var frame = document.getElementById("frame");
		var edge = frame.getBoundingClientRect().left;
		var as = document.querySelectorAll("#${rootId} a");
		// A flex item is blockified, so the element's own getClientRects() reports
		// ONE box even when its label wraps inside it. A Range over its text
		// reports one rect per line box, which is what sees the break.
		var max = 0, min = Infinity, wrapped = 0, rowTops = {};
		as.forEach(function (a) {
			var box = a.getBoundingClientRect();
			max = Math.max(max, box.right - edge);
			min = Math.min(min, box.left - edge);
			rowTops[Math.round(box.top)] = 1;
			var range = document.createRange();
			range.selectNodeContents(a);
			var tops = {};
			Array.prototype.forEach.call(range.getClientRects(), function (r) {
				tops[Math.round(r.top)] = 1;
			});
			if (Object.keys(tops).length > 1) wrapped++;
		});
		document.title = "maxRight=" + Math.ceil(max) + ";minLeft=" + Math.floor(min) + ";rows=" + Object.keys(rowTops).length + ";viewport=" + frame.clientWidth + ";links=" + as.length + ";wrapped=" + wrapped;
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "marketing-header-"));
	try {
		writeFileSync(join(dir, "app.css"), css, "utf8");
		writeFileSync(
			join(dir, "page.html"),
			`<!doctype html><html><head><meta charset="utf-8">` +
				`<link rel="stylesheet" href="./app.css"></head><body style="margin:0">` +
				// The PHONE is this frame, not the window: Chrome clamps a headless
				// window to a minimum width (500px on CI's google-chrome, where
				// `--window-size=360,…` measured a 500px viewport), and a
				// headless-shell build does not. Its `overflow-x: hidden` stands in
				// for body's, which is what clips an overflowing link in the app.
				`<div id="frame" style="width:${width}px;overflow-x:hidden">${bodyHtml}</div>${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				// Above the clamp, below Tailwind's `sm` (640px): the `sm:` padding
				// and margin must NOT apply, or this measures a tablet header.
				"--window-size=600,700",
				"--virtual-time-budget=3000",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--dump-dom",
				`file://${join(dir, "page.html")}`,
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
				env: CHROME_ENV,
			},
		);
		const title = /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? "";
		if (!title.includes("maxRight=")) {
			throw new Error(`probe produced no measurement (title: ${title || "∅"})`);
		}
		const kv = new Map(
			title.split(";").map((p) => p.split("=") as [string, string]),
		);
		return {
			maxRight: Number(kv.get("maxRight")),
			minLeft: Number(kv.get("minLeft")),
			rows: Number(kv.get("rows")),
			viewport: Number(kv.get("viewport")),
			links: Number(kv.get("links")),
			wrapped: Number(kv.get("wrapped")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const hasChrome = findChrome() !== null;

describe("marketing header geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome, "CI has no Chrome, so the geometry gate would skip").toBe(
			true,
		);
	});
});

/**
 * A 360px Android phone, the narrowest common width. Not 375: unfixed, the
 * footer's last link ends at 355px of a 375px screen, flush against the gutter
 * with zero slack, measured in the FALLBACK face (fonts do not load here). A
 * gate at 375 would pass a footer that breaks on the next phone down.
 */
const PHONE = 360;

describe.skipIf(!hasChrome)(
	"the marketing header at 360px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let header = "";
		let nav = "";
		let brandRow = "";
		let chip = "";
		const button = `${buttonVariants({ variant: "ghost" })} font-semibold`;

		function fixture(headerClass: string, navClass: string): string {
			const links = HEADER_LINKS.map(
				(l) => `<a class="${button}" href="#">${l.label}</a>`,
			).join("");
			return `
				<header class="${headerClass}" id="header">
					<div class="${brandRow}">
						<span class="${chip} size-[38px]"></span>
						<div class="leading-[1.05]"><div class="font-display font-semibold text-[19px]">GavelUp</div></div>
					</div>
					<nav class="${navClass}">${links}</nav>
				</header>`;
		}

		const strip = (cls: string) =>
			cls.replace(/\bflex-wrap\b/g, "").replace(/\s+/g, " ");

		beforeAll(async () => {
			header = classContaining(SHELL, "justify-between gap-y-2");
			nav = classContaining(SHELL, "items-center gap-1");
			brandRow = classContaining(BRAND, "gap-[11px]");
			chip = "flex shrink-0 items-center justify-center";
			css = await buildAppCss([
				...candidatesIn(fixture(header, nav)),
				...candidatesIn(fixture(strip(header), strip(nav))),
			]);
		});

		it("keeps every header link inside the viewport", () => {
			const m = measureLinks(fixture(header, nav), css, PHONE);
			expect(m.viewport).toBe(PHONE);
			expect(m.links).toBe(HEADER_LINKS.length);
			expect(
				m.maxRight,
				`a header link ends at ${m.maxRight}px on a ${PHONE}px screen, clipped by body's overflow-x: hidden`,
			).toBeLessThanOrEqual(PHONE);
			// `-ml-4` lines the first button's TEXT up with the brand; it must not
			// push the button itself past the left edge.
			expect(m.minLeft).toBeGreaterThanOrEqual(0);
			// The nav drops below the brand as ONE row. Without the header's own
			// `flex-wrap` the nav instead wraps its buttons into a stack beside
			// the brand: on screen, but ragged, and this is what tells them apart.
			expect(m.rows, "the header nav should sit on one row").toBe(1);
		});

		it("without flex-wrap, the last link runs off the right edge (pre-fix control)", () => {
			const m = measureLinks(fixture(strip(header), strip(nav)), css, PHONE);
			expect(m.links).toBe(HEADER_LINKS.length);
			expect(m.maxRight).toBeGreaterThan(PHONE);
		});
	},
);

describe.skipIf(!hasChrome)(
	"the marketing footer at 360px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		let container = "";
		let row = "";
		let linkRow = "";
		let link = "";
		let brandRow = "";

		/**
		 * The footer's links are plain flex items, not `Button`s: they SHRINK
		 * rather than overflow, so the failure here is a label broken across two
		 * lines ("How it / works") rather than one clipped off-screen. Both are
		 * measured.
		 */
		function fixture(linkRowClass: string): string {
			const links = FOOTER_LINKS.map(
				(l) => `<a class="${link}" href="#">${l.label}</a>`,
			).join("");
			return `
				<footer id="footer">
					<div class="${container}">
						<div class="${row}">
							<div class="${brandRow}">
								<span class="flex shrink-0 size-[30px]"></span>
								<div class="leading-[1.05]"><div class="font-display font-semibold text-[16px]">GavelUp</div></div>
							</div>
							<div class="${linkRowClass}">${links}</div>
						</div>
					</div>
				</footer>`;
		}

		const strip = (cls: string) =>
			cls
				.replace(/\bflex-wrap\b/g, "")
				.replace(/\bgap-y-\S+/g, "")
				.replace(/\s+/g, " ");

		beforeAll(async () => {
			container = classContaining(SHELL, "flex-col gap-4");
			row = classContaining(SHELL, "justify-between gap-3");
			linkRow = classContaining(SHELL, "gap-x-4");
			link = classContaining(SHELL, "text-[var(--sea-ink)] no-underline");
			brandRow = classContaining(BRAND, "gap-[11px]");
			css = await buildAppCss([
				...candidatesIn(fixture(linkRow)),
				...candidatesIn(fixture(strip(linkRow))),
			]);
		});

		it("keeps every footer link on screen and on one line", () => {
			const m = measureLinks(fixture(linkRow), css, PHONE, "footer");
			expect(m.links).toBe(FOOTER_LINKS.length);
			expect(m.maxRight).toBeLessThanOrEqual(PHONE);
			expect(m.wrapped, "a footer link label broke across two lines").toBe(0);
		});

		it("without flex-wrap, labels break mid-link (pre-fix control)", () => {
			const m = measureLinks(fixture(strip(linkRow)), css, PHONE, "footer");
			expect(m.links).toBe(FOOTER_LINKS.length);
			expect(m.wrapped > 0 || m.maxRight > PHONE).toBe(true);
		});
	},
);
