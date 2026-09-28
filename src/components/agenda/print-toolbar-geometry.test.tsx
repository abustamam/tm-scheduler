/**
 * The print toolbar never covers the sheet, and its controls are readable in
 * both app themes (#998).
 *
 * The toolbar used to be `position: fixed`, top-right, over the sheet. On a
 * 375px phone the agenda's six controls wrap into a card ~112px tall, and it
 * covered the club name, the date, the time and most of the roles block. Since
 * #964 fitted the editorial and grid sheets to exactly one screen there, no
 * scroll position revealed them; on the two-page layouts the header sits at the
 * document top, which was always under the card. `print-screen-fit-geometry`
 * stayed green through all of it because it renders the sheet without the
 * toolbar. This suite renders the two together in headless Chrome and checks,
 * at the top, the middle and the bottom of the scroll, that no text node of a
 * sheet intersects the toolbar row — beside a CONTROL that pins the row back to
 * its old fixed position and must reproduce the overlap.
 *
 * Every surface that renders `PrintToolbar` is covered: the four agenda
 * layouts, the flyer's Letter poster, the Word of the Day poster and the club
 * role sheet (whose back link now shares the toolbar's row). The markup between
 * the real components is synthetic: the routes cannot be mounted without a
 * router and a database, so the tab links copy the routes' inline styles.
 *
 * The contrast half needs the app's REAL stylesheet, because the defect lived
 * there: the Share button is a shadcn outline `Button` whose ink comes from the
 * theme tokens, and under `html.dark` it inherited `#d7ece8` on the always-white
 * card (1.23:1). So `src/styles.css` is compiled with Tailwind for exactly the
 * classes the fixture renders, `html` carries `dark` or not, and each text
 * control's colour and its composited ground are read back through a canvas
 * (which normalises the `color-mix()` values Tailwind emits). The pre-fix
 * control strips the card's pinned palette with `!important` rules.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ShareLinkButton } from "#/components/share-link-button";
import {
	buildFlyerContent,
	DEFAULT_PROMO_TEMPLATE,
	promoValues,
} from "#/lib/promo-template";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	printableDocument,
} from "#/test/print-page-count";
import { ClubRoleSheet, type RoleSheetEntry } from "./club-role-sheet";
import { type AgendaLayout, MeetingAgendaPrint } from "./meeting-agenda-print";
import { MeetingFlyerLetter } from "./meeting-flyer";
import {
	INK,
	MUTED,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
	printPageCss,
} from "./print-theme";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

const hasChrome = findChrome() !== null;
const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = resolve(HERE, "../../styles.css");

const PHONE_W = 375;
const WIDTHS = [PHONE_W, 820, 1280] as const;
const FRAME_H = 812;
const AA = 4.5;

const LAYOUTS: readonly AgendaLayout[] = [
	"editorial",
	"grid",
	"timing",
	"spacious",
];
type Surface = AgendaLayout | "flyer" | "word" | "roles";
const SURFACES: readonly Surface[] = [...LAYOUTS, "flyer", "word", "roles"];
type Theme = "light" | "dark";

// ---------------------------------------------------------------- fixtures

/** The agenda route's tab styles (`club.$clubId_.meeting.$meetingId.print.tsx`). */
const agendaTab = (active: boolean): React.CSSProperties => ({
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 600,
	color: active ? "#fff" : MUTED,
	background: active ? INK : undefined,
	textDecoration: "none",
});

/** The flyer route's tab styles (`club.$clubId_.meeting.$meetingId.flyer.tsx`). */
const flyerTab = (active: boolean): React.CSSProperties => ({
	padding: "6px 12px",
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	textDecoration: "none",
	color: active ? "#fff" : "#173a40",
	background: active ? "#173a40" : "transparent",
});

const LONG_CLUB = "Downtown Evening Speakers and Storytellers of the Valley";

const ROLE_ENTRIES: RoleSheetEntry[] = Array.from({ length: 12 }, (_, i) => ({
	id: String(i),
	name: `Role ${i}`,
	category: (["leadership", "functionary", "speaker", "evaluator"] as const)[
		i % 4
	],
	description: "What this role does, in a sentence that wraps a little.",
}));

const FLYER_CLUB = {
	name: "Downtown Speakers",
	slug: "downtown",
	timezone: "America/Chicago",
};

function surfaceBody(surface: Surface): { css: string; body: string } {
	if (surface === "word") {
		return {
			css: printPageCss("landscape"),
			body: renderToStaticMarkup(
				<div>
					<PrintToolbar>
						<PrintButton />
					</PrintToolbar>
					<div
						className="pgwrap"
						style={{ display: "flex", justifyContent: "center" }}
					>
						<WordOfTheDayPoster
							word="Ephemeral"
							definition="Lasting for a very short time; fleeting."
							example="The applause was ephemeral, but the lesson stayed."
							clubName="MCF Toastmasters"
							dateLong="Friday, July 31, 2026"
							logoUrl={null}
						/>
					</div>
				</div>,
			),
		};
	}
	if (surface === "flyer") {
		const content = buildFlyerContent(
			DEFAULT_PROMO_TEMPLATE,
			promoValues(
				FLYER_CLUB,
				{
					urlKey: "2026-10-01",
					scheduledAt: "2026-10-02T00:30:00Z",
					location: "Library, Room 4",
					online: true,
					theme: "Beginnings",
					wordOfTheDay: null,
					meetingNumber: 57,
					promoNote: "It's our open house, bring a friend!",
				},
				"https://gavelup.app",
			),
		);
		return {
			css: PRINT_PAGE_CSS,
			body: renderToStaticMarkup(
				<div>
					<PrintToolbar>
						<a href="#letter" style={flyerTab(true)}>
							Poster
						</a>
						<a href="#square" style={flyerTab(false)}>
							Square image
						</a>
						<PrintButton />
					</PrintToolbar>
					<div
						className="pgwrap"
						style={{ display: "flex", justifyContent: "center" }}
					>
						<MeetingFlyerLetter
							content={content}
							clubName={FLYER_CLUB.name}
							logoUrl={null}
						/>
					</div>
				</div>,
			),
		};
	}
	if (surface === "roles") {
		return {
			css: `${PRINT_PAGE_CSS} @media screen { .pgwrap { display: flex; justify-content: center; } }`,
			body: renderToStaticMarkup(
				<div>
					<PrintToolbar
						leading={
							<a
								href="#club"
								className="roles-back"
								style={{
									display: "block",
									minWidth: 0,
									maxWidth: "min(48vw, 320px)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									background: "#fff",
									borderRadius: 10,
									padding: "9px 14px",
									color: INK,
									fontSize: 13,
									fontWeight: 700,
									textDecoration: "none",
								}}
							>
								← {LONG_CLUB}
							</a>
						}
					>
						<ShareLinkButton path="/club/x/roles" label="Copy shareable link" />
						<PrintButton />
					</PrintToolbar>
					<ClubRoleSheet
						clubName={LONG_CLUB}
						clubNumber="1234567"
						roles={ROLE_ENTRIES}
						logoUrl={null}
					/>
				</div>,
			),
		};
	}
	return {
		css: PRINT_PAGE_CSS,
		body: renderToStaticMarkup(
			<div>
				<PrintToolbar>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
						{LAYOUTS.map((l) => (
							<a key={l} href={`#${l}`} style={agendaTab(l === surface)}>
								{l[0].toUpperCase() + l.slice(1)}
							</a>
						))}
					</div>
					<ShareLinkButton
						path="/club/x/meeting/y"
						label="Copy shareable link"
					/>
					<PrintButton />
				</PrintToolbar>
				<MeetingAgendaPrint
					layout={surface}
					header={MCF_HEADER}
					roles={MCF_ROLES}
					officers={MCF_OFFICERS}
					explainers={MCF_EXPLAINERS}
					rows={MCF_ROWS}
				/>
			</div>,
		),
	};
}

/**
 * The pre-fix toolbar, restored from a stylesheet: the row pinned where the
 * card used to float (fixed, 12px in from the top corners, the old back link
 * on the left), and the card's pinned palette stripped so its controls take
 * the app theme's ink again. `!important` beats the inline declarations.
 */
const CONTROL_CSS = `
[data-print-toolbar] { position: fixed !important; top: 12px !important; left: 12px !important; right: 12px !important; padding: 0 !important; }
[data-print-toolbar] > :last-child {
	color: inherit !important; color-scheme: normal !important;
	--background: inherit !important; --foreground: inherit !important;
	--accent: inherit !important; --accent-foreground: inherit !important;
	--border: inherit !important; --input: inherit !important; --ring: inherit !important;
}`;

// ------------------------------------------------------------ harness

type Overlap = { scrollY: number; hits: string[] };
type Control = {
	text: string;
	fg: [number, number, number, number];
	bg: [number, number, number];
};
/**
 * Every theme token the outline `Button` recipe reads (`ui/button.tsx`),
 * including the hover ones (`accent`, `accent-foreground`, `input`) that no
 * resting-state contrast measurement can see.
 */
const SHARE_TOKENS = [
	"--background",
	"--foreground",
	"--accent",
	"--accent-foreground",
	"--border",
	"--input",
	"--ring",
] as const;

type Frame = {
	clientWidth: number;
	scrollWidth: number;
	sheetTextNodes: number;
	overlaps: Overlap[];
	controls: Control[];
	/** Each of `SHARE_TOKENS` as resolved on the Share button, as RGBA. */
	shareTokens: Record<string, string>;
};

type Case = { id: string; html: string; width: number };

const caseId = (s: Surface, w: number, theme: Theme, fixed: boolean) =>
	`${s}-${w}-${theme}-${fixed ? "fixed" : "control"}`;

/**
 * Inside each frame: at three scroll positions, which sheet text nodes touch
 * the toolbar row's items; then every text control in the card, with its ink
 * and the ground composited beneath it, both normalised through a canvas.
 */
const FRAME_PROBE = `<script>
var TOKENS = ${JSON.stringify(SHARE_TOKENS)};
addEventListener("load", function () {
	var d = document.documentElement;
	var row = document.querySelector("[data-print-toolbar]");
	var items = Array.prototype.slice.call(row.children);
	function rects() { return items.map(function (e) { return e.getBoundingClientRect(); }); }
	function hit(a, b) { return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5; }
	var texts = [];
	document.querySelectorAll(".agenda-page").forEach(function (p) {
		var w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
		var n;
		while ((n = w.nextNode())) if (n.nodeValue.trim()) texts.push(n);
	});
	var max = d.scrollHeight - innerHeight;
	var overlaps = [0, Math.round(max / 2), max].map(function (y) {
		scrollTo(0, y);
		var bars = rects(), hits = [];
		texts.forEach(function (t) {
			var r = document.createRange(); r.selectNodeContents(t);
			var rs = r.getClientRects();
			for (var i = 0; i < rs.length; i++) {
				if (rs[i].width === 0 || rs[i].height === 0) continue;
				if (bars.some(function (b) { return hit(rs[i], b); })) { hits.push(t.nodeValue.trim().slice(0, 40)); break; }
			}
		});
		return { scrollY: scrollY, hits: hits };
	});
	scrollTo(0, 0);

	var cv = document.createElement("canvas"); cv.width = cv.height = 1;
	var ctx = cv.getContext("2d", { willReadFrequently: true });
	function px() { var p = ctx.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2], p[3]]; }
	function paint(c) { ctx.fillStyle = "#000"; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
	var card = items[items.length - 1];
	var controls = [];
	card.querySelectorAll("a, button, span").forEach(function (el) {
		var own = Array.prototype.some.call(el.childNodes, function (c) { return c.nodeType === 3 && c.nodeValue.trim(); });
		if (!own) return;
		var chain = [], e = el;
		while (e) { chain.unshift(e); if (e === card) break; e = e.parentElement; }
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1, 1);
		chain.forEach(function (c) { paint(getComputedStyle(c).backgroundColor); });
		var bg = px();
		// "copy" keeps the ink's own alpha; the test composites it onto bg.
		ctx.globalCompositeOperation = "copy";
		paint(getComputedStyle(el).color);
		ctx.globalCompositeOperation = "source-over";
		var fg = px();
		controls.push({ text: el.textContent.trim(), fg: [fg[0], fg[1], fg[2], fg[3] / 255], bg: [bg[0], bg[1], bg[2]] });
	});
	var tokens = {};
	var btn = card.querySelector("button[data-slot=button]");
	if (btn) {
		var cs = getComputedStyle(btn);
		TOKENS.forEach(function (t) {
			ctx.clearRect(0, 0, 1, 1);
			ctx.globalCompositeOperation = "copy";
			paint(cs.getPropertyValue(t).trim() || "transparent");
			ctx.globalCompositeOperation = "source-over";
			tokens[t] = px().join(",");
		});
	}
	parent.postMessage({ id: location.hash.slice(1), frame: {
		clientWidth: d.clientWidth, scrollWidth: d.scrollWidth,
		sheetTextNodes: texts.length, overlaps: overlaps, controls: controls,
		shareTokens: tokens
	} }, "*");
});
</script>`;

/** Tailwind over the app's own stylesheet, for the classes `html` uses. */
async function appCss(html: readonly string[]): Promise<string> {
	// The Google Fonts import is a network fetch the harness blocks anyway.
	const src = readFileSync(STYLES, "utf8").replace(/@import url\([^)]*\);/, "");
	const compiler = await compile(src, {
		base: dirname(STYLES),
		onDependency: () => {},
	});
	const candidates = new Set<string>();
	for (const doc of html) {
		for (const m of doc.matchAll(/class="([^"]*)"/g)) {
			for (const c of m[1].split(/\s+/)) if (c) candidates.add(c);
		}
	}
	return compiler.build([...candidates]);
}

async function buildCases(): Promise<Case[]> {
	const bodies = new Map(SURFACES.map((s) => [s, surfaceBody(s)]));
	const css = await appCss([...bodies.values()].map((b) => b.body));
	const cases: Case[] = [];
	for (const s of SURFACES) {
		const b = bodies.get(s);
		if (!b) throw new Error(s);
		for (const width of WIDTHS) {
			for (const theme of ["light", "dark"] as const) {
				for (const fixed of [true, false]) {
					const doc = printableDocument(
						`${css}\n${b.css}${fixed ? "" : CONTROL_CSS}`,
						b.body,
					).replace(
						"<html>",
						theme === "dark" ? '<html class="dark">' : "<html>",
					);
					cases.push({ id: caseId(s, width, theme, fixed), html: doc, width });
				}
			}
		}
	}
	return cases;
}

/** Every case from ONE Chrome launch, as `print-screen-fit-geometry` does. */
function measureAll(cases: readonly Case[]): Map<string, Frame> {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const dir = mkdtempSync(join(tmpdir(), "print-toolbar-"));
	try {
		const frames = cases
			.map((c) => {
				const file = `${c.id}.html`;
				writeFileSync(
					join(dir, file),
					c.html.replace("</body>", `${FRAME_PROBE}</body>`),
					"utf8",
				);
				return `<iframe src="${file}#${c.id}" style="display:block;border:0;width:${c.width}px;height:${FRAME_H}px"></iframe>`;
			})
			.join("");
		// Listener in <head>, before any frame exists (see print-screen-fit-geometry).
		const outer = `<!doctype html><html><head><title>pending</title>
<script>
var got = {}, want = ${cases.length};
addEventListener("message", function (e) {
	got[e.data.id] = e.data.frame;
	if (Object.keys(got).length === want) {
		document.getElementById("out").textContent = JSON.stringify(got);
		document.title = "done";
	}
});
</script></head><body style="margin:0">
<pre id="out"></pre>${frames}
</body></html>`;
		const outerPath = join(dir, "outer.html");
		writeFileSync(outerPath, outer, "utf8");
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1400,900",
				"--virtual-time-budget=30000",
				"--dump-dom",
				`file://${outerPath}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 40_000, env: CHROME_ENV },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1];
		const json = dom.match(/<pre id="out">([^<]*)<\/pre>/)?.[1];
		if (title !== "done" || !json) {
			throw new Error(
				`Not every frame reported back; Chrome's title was "${title}".`,
			);
		}
		const parsed = JSON.parse(
			json
				.replace(/&quot;/g, '"')
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&"),
		) as Record<string, Frame>;
		return new Map(Object.entries(parsed));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** WCAG 2 contrast of `fg` (alpha composited onto `bg`) against `bg`. */
function contrast(c: Control): number {
	const [r, g, b, a] = c.fg;
	const fg = [r, g, b].map((v, i) => v * a + c.bg[i] * (1 - a));
	const lum = (rgb: number[]) => {
		const [R, G, B] = rgb.map((v) => {
			const s = v / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * R + 0.7152 * G + 0.0722 * B;
	};
	const [hi, lo] = [lum(fg), lum(c.bg)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("print toolbar harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the toolbar overlap and contrast gates would " +
				"skip and the suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the print toolbar never covers the sheet, and reads in both themes (#998)",
	{ timeout: CHROME_TEST_TIMEOUT_MS * 2 },
	() => {
		let cache: Map<string, Frame>;
		beforeAll(async () => {
			cache = measureAll(await buildCases());
		}, CHROME_TEST_TIMEOUT_MS * 2);
		const frame = (s: Surface, w: number, theme: Theme, fixed: boolean) => {
			const f = cache.get(caseId(s, w, theme, fixed));
			if (!f)
				throw new Error(`no measurement for ${caseId(s, w, theme, fixed)}`);
			if (f.sheetTextNodes === 0)
				throw new Error(`${s} rendered no sheet text`);
			return f;
		};

		// Every surface but the Word of the Day poster, whose one-control card
		// (Print alone) ends above the scaled poster's first line of text: the old
		// fixed toolbar never covered it at 375px, so no control can fail there.
		// The in-flow assertion below still covers it at every width.
		const COVERED_BEFORE = SURFACES.filter((s) => s !== "word");

		it.each(
			COVERED_BEFORE,
		)("%s: CONTROL — the old fixed toolbar covers sheet text at 375px", (surface) => {
			const f = frame(surface, PHONE_W, "light", false);
			expect(
				f.overlaps[0].hits.length,
				JSON.stringify(f.overlaps),
			).toBeGreaterThan(0);
		});

		it.each(
			SURFACES.flatMap((s) => WIDTHS.map((w) => [s, w] as const)),
		)("%s at %ipx: no sheet text is under the toolbar at any scroll position", (surface, width) => {
			const f = frame(surface, width, "light", true);
			for (const o of f.overlaps) {
				expect(o.hits, `scrollY ${o.scrollY}`).toEqual([]);
			}
		});

		it.each(
			SURFACES,
		)("%s: the toolbar adds no sideways scroll at 375px", (surface) => {
			const f = frame(surface, PHONE_W, "light", true);
			expect(f.scrollWidth).toBeLessThanOrEqual(f.clientWidth);
		});

		const WITH_SHARE: readonly Surface[] = ["editorial", "roles"];

		it.each(
			SURFACES.flatMap((s) =>
				(["light", "dark"] as const).map((t) => [s, t] as const),
			),
		)("%s, %s theme: every text control in the toolbar meets AA", (surface, theme) => {
			const f = frame(surface, PHONE_W, theme, true);
			expect(f.controls.length).toBeGreaterThan(0);
			for (const c of f.controls) {
				expect(contrast(c), JSON.stringify(c)).toBeGreaterThanOrEqual(AA);
			}
		});

		it.each(
			WITH_SHARE.flatMap((s) =>
				(["light", "dark"] as const).map((t) => [s, t] as const),
			),
		)("%s, %s theme: Copy shareable link meets AA", (surface, theme) => {
			const share = frame(surface, PHONE_W, theme, true).controls.find(
				(c) => c.text === "Copy shareable link",
			);
			expect(share, "no Share control measured").toBeDefined();
			if (share) expect(contrast(share)).toBeGreaterThanOrEqual(AA);
		});

		it.each(
			WITH_SHARE,
		)("%s: the Share button resolves every theme token the same in dark as in light", (surface) => {
			// Covers the hover state too: under the dark theme,
			// `hover:text-accent-foreground` would put #d7ece8 on the card.
			const dark = frame(surface, PHONE_W, "dark", true).shareTokens;
			const light = frame(surface, PHONE_W, "light", true).shareTokens;
			expect(Object.keys(light).sort()).toEqual([...SHARE_TOKENS].sort());
			expect(dark).toEqual(light);
		});

		it.each(
			WITH_SHARE,
		)("%s: CONTROL — without the pinned palette, every dark token differs", (surface) => {
			const dark = frame(surface, PHONE_W, "dark", false).shareTokens;
			const light = frame(surface, PHONE_W, "light", false).shareTokens;
			for (const t of SHARE_TOKENS) expect(dark[t], t).not.toBe(light[t]);
		});

		it.each(
			WITH_SHARE,
		)("%s: CONTROL — without the pinned palette, Share is unreadable in dark theme", (surface) => {
			const share = frame(surface, PHONE_W, "dark", false).controls.find(
				(c) => c.text === "Copy shareable link",
			);
			expect(share).toBeDefined();
			if (share) expect(contrast(share)).toBeLessThan(2);
		});
	},
);
