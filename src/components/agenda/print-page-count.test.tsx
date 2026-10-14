/**
 * Page counts for every print surface (#502).
 *
 * Print CSS is invisible to typecheck, to lint, and to every component test,
 * because those assert the DOM and a blank second sheet is not in the DOM — it
 * is a consequence of geometry that only exists once a browser paginates the
 * page. A missing `.pgwrap` reset shipped exactly that in v1.3.0.0, past six
 * test files and two reviews.
 *
 * WHAT THIS GATE ACTUALLY PINS, measured rather than assumed. Every sheet is a
 * `.agenda-page`, which is `height: PAGE_H; overflow: hidden` (`PAGE_OUTER`),
 * and `FitPage`'s scale-to-fit is a `useEffect` that neither
 * `renderToStaticMarkup` nor a JS-free `file://` page ever runs. So a sheet is
 * exactly one page REGARDLESS of how much content it holds, and content volume
 * cannot move any number here. What can move a number is height contributed
 * OUTSIDE the clipped sheet: the wrapper's padding, its gap, and anything the
 * print stylesheet fails to hide.
 *
 * That makes the honest claim narrow: a review mutation sweep showed 7 of the 8
 * rules in `PRINT_PAGE_CSS` can be deleted with all six counts unchanged. The
 * padding reset is pinned here; `.no-print` is pinned only because the fixtures
 * below reproduce the route's toolbar and footer; the rest are pinned by the
 * greps in `print-page-reset.guard.test.ts`, which is why both files exist.
 * Do not read a passing count as evidence for a rule this cannot see.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { PublicFooter } from "#/components/public-footer";
import { AGENDA_LAYOUT_PAGES, AGENDA_LAYOUTS } from "#/lib/agenda-layouts";
import { posterWordSize } from "#/lib/word-poster";
import { stopChromeAndRemoveDir } from "#/test/chrome-teardown";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
	printedPageCount,
} from "#/test/print-page-count";
import { AgendaCopies, AgendaCopiesStack, sheetPages } from "./agenda-copies";
import { ClubRoleSheet, type RoleSheetEntry } from "./club-role-sheet";
import {
	type AgendaHeader,
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";
import {
	INK,
	MUTED,
	PRINT_PAGE_CSS,
	PrintButton,
	PrintToolbar,
	pageBox,
	printPageCss,
} from "./print-theme";
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

// ---------------------------------------------------------------------------
// The counts below were recorded against the three divergent copies the routes
// carried BEFORE the extraction, and must not move now one constant replaces
// them. The agenda and poster surfaces serve `PRINT_PAGE_CSS` unmodified, so
// they use it directly — an alias per surface would only look like three
// stylesheets under test when there is one.
//
// The roles route is the one surface that could not be fully unioned: it centres
// its single sheet on screen, and flex defaults to a row, so hoisting that rule
// would lay the agenda's two stacked sheets side by side.
// ---------------------------------------------------------------------------

const CSS_ROLES = `${PRINT_PAGE_CSS}
	@media screen {
		.pgwrap { display: flex; justify-content: center; }
	}
`;

// ---------------------------------------------------------------------------
// Fixtures. A full meeting WITH a logo and a long club name — not because
// volume changes the count (it provably does not; see the header), but because
// the logo is the axis that produced the one real multi-page spill this repo
// has had (#496 + #509, where each side's fixtures tested its own axis and the
// cross-product was tested by neither). Keeping it here records that the
// cross-product was considered rather than leaving the next reader to wonder.
// ---------------------------------------------------------------------------

/** A 1x1 PNG. Presence is the axis that matters, not the pixels. */
const LOGO =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const LONG_CLUB =
	"Downtown Metropolitan Professional Speakers Toastmasters Club";

const header: AgendaHeader = {
	clubName: LONG_CLUB,
	logoUrl: LOGO,
	clubNumber: "1234",
	district: "District 5",
	mission: null,
	meetingSchedule: null,
	dateLong: "Wednesday, July 22, 2026",
	dateShort: "Wed · Jul 22, 2026",
	timeRange: "7:00 – 8:15 PM",
	theme: "New Horizons",
	wordOfTheDay: "Ebullient",
	location: null,
	announcements: null,
	meetingNumber: null,
};

/**
 * Every fifth row is a HAND-OFF, and its detail carries the people it
 * introduces (#585).
 *
 * READ THE HEADER ABOVE BEFORE TRUSTING THIS: content volume provably cannot
 * move any number in this file. `.agenda-page` is `height: PAGE_H; overflow:
 * hidden`, so a sheet is exactly one page however much it holds. This fixture
 * therefore does NOT gate the #585 lengthening, and an earlier version of this
 * comment claimed it did — measured wrong, because a 60-row mutation still
 * printed 1 page and that was read as headroom rather than as the gate being
 * structurally blind. The legibility cost of longer rows is caught by
 * `print-density.test.tsx`, which measures printed POINTS; the page count is
 * caught here.
 *
 * What the hand-off rows are still doing here: `HandoffBand` is a
 * differently-sized, italic, differently-padded row that the real agenda emits
 * five to eight times, and it was absent from this fixture entirely. Its
 * PRESENCE (not its length) is what this file can see — a change that made a
 * band render as a full row, or emit a second `.agenda-page`, moves the count.
 *
 * The names are deliberately long and multi-part because the fixture should
 * look like a real agenda: "Bartholomew Fitzgerald-Wellington" is an ordinary
 * name, not a hostile one.
 */
const HANDOFF_DETAIL =
	"Introduces the speech evaluators" +
	"Anneliese Vandermeer-Castellanos & Konstantin Papadopoulos-Nakamura";

/** `n` run-sheet rows of the shape described above. */
function agendaRows(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		who: i % 3 === 0 ? `Speaker ${i} · Someone Withalongname` : `Role ${i}`,
		detail:
			i % 5 === 4
				? HANDOFF_DETAIL
				: "A representative line of run-sheet detail for this beat",
		minutes: i % 5 === 4 ? 0 : 5,
		// `i % 3 === 0`, unnarrowed. Adding `&& i % 5 !== 4` to keep hand-off rows
		// unmarked would ALSO have dropped the marks from i=9 and i=24, quietly
		// shrinking the timing-trio axis this fixture covers — a fixture that gets
		// weaker on one axis while growing on another is the trap in reverse.
		marks: i % 3 === 0 ? { green: 4, yellow: 5, red: 6 } : null,
		handoff: i % 5 === 4 ? true : undefined,
		time: `7:${String(i).padStart(2, "0")}`,
	}));
}

const rows = agendaRows(26);

const roleSheetRoles: RoleSheetEntry[] = Array.from({ length: 12 }, (_, i) => ({
	id: String(i),
	name: `Role ${i}`,
	category: (["leadership", "functionary", "speaker", "evaluator"] as const)[
		i % 4
	],
	description: "What this role does, in a sentence that wraps a little.",
}));

// Exercised on every layout (#510, #717): the QR sits in every layout's
// footer — `DarkFooter` on three, `GridLayout`'s hand-rolled band on the
// fourth — and this proves it does not move any of the counts below. Since
// #913 it is the meeting page "in the room" and prints whether or not the club
// votes on phones, so a sheet WITH it is the only one the app prints.
const QR_URL = "https://gavelup.app/club/downtown/meeting/2026-07-22?room=1";

function agendaHtml(layout: AgendaLayout): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
			qrUrl={QR_URL}
		/>,
	);
}

function copiesHtml(
	layout: AgendaLayout,
	copies: number,
	duplex: boolean,
): string {
	return renderToStaticMarkup(
		<AgendaCopies
			copies={copies}
			duplex={duplex}
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
			qrUrl={QR_URL}
		/>,
	);
}

/**
 * The copies stack with each copy's PHYSICAL page count stated, and chosen
 * sheets made taller than a page.
 *
 * `FitPage` lets a long agenda flow onto extra pages, but its flow branch is
 * set by an effect that no static render runs (see the note above the
 * contest-agenda test). So the overflow is reproduced the way that test
 * reproduces it: the sheet's fixed height and clip are swapped for a taller,
 * unclipped box, which the browser paginates exactly as it does a flowing one.
 * `tall` maps a non-blank sheet's index (document order) to its height in px.
 */
function overflowingCopiesHtml(
	layout: AgendaLayout,
	pagesPerCopy: number[],
	duplex: boolean,
	tall: Record<number, number>,
): string {
	let n = -1;
	return renderToStaticMarkup(
		<AgendaCopiesStack
			pagesPerCopy={pagesPerCopy}
			duplex={duplex}
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
			qrUrl={QR_URL}
		/>,
	).replace(
		/(<div class="agenda-page"(?! data-agenda-blank)[^>]*style=")([^"]*)"/g,
		(_m, head: string, style: string) => {
			n++;
			const h = tall[n];
			if (h === undefined) return `${head}${style}"`;
			return `${head}${style
				.replace("height:1056px", `height:${h}px`)
				.replace("overflow:hidden", "overflow:visible")}"`;
		},
	);
}

function pages(css: string, html: string): number {
	return printedPageCount(printableDocument(css, html));
}

/**
 * The Word of the Day poster inside the ROUTE's wrapper — see the page-count
 * assertion below for why the wrapper is not optional.
 *
 * A function rather than a constant because #718 needs the same page at both
 * ends of the size table: the word drives `posterWordSize`, which drives the
 * body size beneath it, so "Apt" and a 22-letter word compose very differently
 * tall pages out of identical markup. The definition and example are held
 * fixed so the word is the only thing varying.
 */
function posterHtml(word = "Ephemeral"): string {
	return renderToStaticMarkup(
		<div
			className="pgwrap"
			style={{ display: "flex", justifyContent: "center" }}
		>
			<WordOfTheDayPoster
				word={word}
				definition="Lasting for a very short time; fleeting."
				example="The applause was ephemeral, but the lesson stayed."
				clubName={LONG_CLUB}
				dateLong="Friday, July 31, 2026"
				logoUrl={LOGO}
			/>
		</div>,
	);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Copies measured under the REAL `FitPage` (#1181).
//
// `overflowingCopiesHtml` above fakes an overflowing sheet by swapping its box,
// which is exactly why #1179 shipped green with a bug in the measuring: `FitPage`
// decides to flow in an effect after the fonts load, and `AgendaCopies` has to
// hear that sheet change height. Nothing static can exercise that, so this
// bundles the real components, runs them in Chrome until they settle, and then
// reads what they did.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..", "..");

/** How long the stack must hold still before a draw counts as settled. */
const QUIET_MS = 400;

/** One drawn state of the copies stack, read back once it had settled. */
type CopiesStage = {
	layout: AgendaLayout;
	/** Each copy-sheet's rendered height in px, document order, blanks excluded. */
	heights: number[];
	blanks: number;
};

let copiesBundle = "";

async function bundleCopiesEntry(): Promise<string> {
	const out = await build({
		stdin: {
			contents: `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AgendaCopies } from "./src/components/agenda/agenda-copies";
const fx = window.__fixture;
// A browser that is not drawing frames (a background tab, a tool with no visible
// pane) never delivers a ResizeObserver callback, and one old enough has no
// ResizeObserver at all. Both are stood in for here, BEFORE anything mounts.
if (fx.resizeObserver === "inert") {
	window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
} else if (fx.resizeObserver === "absent") {
	delete window.ResizeObserver;
}
const root = createRoot(document.getElementById("root"));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
const copySheets = () => [...document.querySelectorAll(".agenda-page:not([data-agenda-blank])")];
const read = () => {
	const sheets = [...document.querySelectorAll(".agenda-page")];
	return {
		heights: sheets.filter((s) => !s.hasAttribute("data-agenda-blank")).map((s) => s.offsetHeight),
		blanks: sheets.filter((s) => s.hasAttribute("data-agenda-blank")).length,
	};
};
async function until(done, what) {
	const t0 = Date.now();
	while (!done()) {
		if (Date.now() - t0 > 8000) throw new Error("never saw " + what);
		await wait(10);
	}
}
// Settled = nothing changed for ${QUIET_MS}ms. FitPage flows after the fonts
// resolve and AgendaCopies hears it, so there is no one event to await.
async function settle() {
	let last = "";
	let since = Date.now();
	const t0 = since;
	while (Date.now() - t0 < 8000) {
		const now = JSON.stringify(read());
		if (now !== last) { last = now; since = Date.now(); }
		else if (Date.now() - since > ${QUIET_MS}) break;
		await wait(25);
	}
}
// The quiet window must not start until the stack is the REQUESTED layout's:
// on a busy runner React's commit and FitPage's font-gated flow can take longer
// than ${QUIET_MS}ms, and the PREVIOUS layout's stable DOM would be read instead.
async function show(layout) {
	const before = new Set(copySheets());
	root.render(createElement(AgendaCopies, { ...fx.props, layout, copies: fx.copies, duplex: fx.duplex }));
	// A layout switch replaces every sheet; the first draw has none to replace.
	await until(() => {
		const now = copySheets();
		return now.length > 0 && now.every((s) => !before.has(s));
	}, layout + "'s sheets");
	await document.fonts.ready;
	await frame();
	await frame();
	await settle();
}
window.__result = (async () => {
	const stages = [];
	for (const layout of fx.layouts) {
		await show(layout);
		stages.push({ layout, ...read() });
	}
	// A sheet that grows with NO change to the DOM or an inline style under the
	// stack, as a logo or a late font does: only a ResizeObserver on the CURRENT
	// sheets can hear it.
	if (fx.growCss) {
		const style = document.createElement("style");
		style.textContent = fx.growCss;
		document.head.append(style);
		await settle();
		stages.push({ layout: fx.layouts[fx.layouts.length - 1], ...read() });
	}
	for (const s of [...document.querySelectorAll("script")]) s.remove();
	return { stages, html: document.documentElement.outerHTML };
})();
`,
			resolveDir: ROOT,
			loader: "ts",
		},
		bundle: true,
		format: "iife",
		platform: "browser",
		write: false,
		logLevel: "silent",
		alias: { "#": join(ROOT, "src") },
		define: { "process.env.NODE_ENV": '"production"' },
	});
	return out.outputFiles[0]?.text ?? "";
}

type CdpMessage = {
	id?: number;
	result?: Record<string, unknown>;
	error?: unknown;
};

/**
 * Run `expression` (a promise) in a real-time Chrome that has loaded `htmlPath`
 * and return its value, over the DevTools protocol on a pipe.
 *
 * Real time, not `--dump-dom --virtual-time-budget`: virtual time draws almost
 * no frames, and a ResizeObserver is only heard on a frame, so the very thing
 * under test (a sheet growing after `FitPage` flows) never settled there.
 */
async function evaluateInChrome<T>(
	htmlPath: string,
	dir: string,
	expression: string,
): Promise<T> {
	const chrome = findChrome();
	if (!chrome) throw new Error("no chrome");
	const proc = spawn(
		chrome,
		[
			"--headless",
			"--disable-gpu",
			"--no-sandbox",
			`--user-data-dir=${dir}`,
			"--disable-extensions",
			"--host-resolver-rules=MAP * ~NOTFOUND",
			"--remote-debugging-pipe",
			`file://${htmlPath}`,
		],
		{
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			env: CHROME_ENV,
			detached: true,
		},
	);
	const toChrome = proc.stdio[3] as Writable;
	const fromChrome = proc.stdio[4] as Readable;
	const pending = new Map<number, (msg: CdpMessage) => void>();
	let nextId = 0;
	let buffered = "";
	let died: Error | null = null;
	const failAll = (err: Error) => {
		died ??= err;
		for (const settle of pending.values()) settle({ error: err.message });
		pending.clear();
	};
	proc.on("error", (e) =>
		failAll(new Error(`Chrome did not start: ${e.message}`)),
	);
	proc.on("exit", (code) =>
		failAll(new Error(`Chrome exited early (${code})`)),
	);
	toChrome.on("error", (e) => failAll(e));
	fromChrome.on("error", (e) => failAll(e));
	fromChrome.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		let nul = buffered.indexOf("\0");
		while (nul !== -1) {
			const msg = JSON.parse(buffered.slice(0, nul)) as CdpMessage;
			buffered = buffered.slice(nul + 1);
			if (msg.id !== undefined) {
				pending.get(msg.id)?.(msg);
				pending.delete(msg.id);
			}
			nul = buffered.indexOf("\0");
		}
	});
	const send = (
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	) =>
		new Promise<CdpMessage>((ok) => {
			if (died) return ok({ error: died.message });
			const id = ++nextId;
			pending.set(id, ok);
			toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
		});
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	try {
		const run = (async () => {
			let targetId: string | undefined;
			for (let i = 0; i < 100 && !targetId; i++) {
				const { result } = await send("Target.getTargets");
				targetId = (
					result?.targetInfos as
						| { type: string; targetId: string; url: string }[]
						| undefined
				)?.find(
					(t) => t.type === "page" && t.url.startsWith("file://"),
				)?.targetId;
				if (!targetId) await pause(50);
			}
			if (!targetId) throw new Error("Chrome opened no page");
			const attached = await send("Target.attachToTarget", {
				targetId,
				flatten: true,
			});
			const sessionId = attached.result?.sessionId as string;
			// Re-asked while the navigation still tears the context down.
			let evaluated: CdpMessage = {};
			for (let i = 0; i < 50; i++) {
				evaluated = await send(
					"Runtime.evaluate",
					{ expression, awaitPromise: true, returnByValue: true },
					sessionId,
				);
				const inner = evaluated.result?.result as
					| { value?: unknown }
					| undefined;
				if (!evaluated.error && inner?.value !== undefined) break;
				await pause(50);
			}
			const value = (evaluated.result?.result as { value?: T } | undefined)
				?.value;
			if (value === undefined) {
				throw new Error(`the page returned ${JSON.stringify(evaluated)}`);
			}
			return value;
		})();
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(
				() => reject(new Error("the page did not settle in 40s")),
				40_000,
			).unref();
		});
		return await Promise.race([run, timeout]);
	} finally {
		proc.removeAllListeners("exit");
		died ??= new Error("done");
		await stopChromeAndRemoveDir(proc, dir);
	}
}

/**
 * Mount `copies` agendas of `rowCount` rows in Chrome, drawing `layouts` one
 * after another into the SAME stack (a layout switch is a re-render, as on the
 * print route's tabs), and report what each draw settled to plus the pages the
 * final document prints.
 *
 * The final count is taken from a script-free snapshot of the settled DOM: its
 * inline styles are what `FitPage` left, so printing it is printing the page
 * the person would have.
 */
async function realFitPageCopies(
	layouts: AgendaLayout[],
	rowCount: number,
	copies: number,
	duplex: boolean,
	options: {
		/** `inert`: observes nothing, ever (a browser drawing no frames).
		 *  `absent`: no ResizeObserver exists. Default: Chrome's own. */
		resizeObserver?: "native" | "inert" | "absent";
		/** CSS added to the document once the last layout settled, to grow the
		 *  sheets without touching the DOM or an inline style under the stack. */
		growCss?: string;
	} = {},
): Promise<{ stages: CopiesStage[]; printedPages: number }> {
	const fixture = {
		layouts,
		copies,
		duplex,
		resizeObserver: options.resizeObserver ?? "native",
		growCss: options.growCss ?? null,
		props: {
			header,
			roles: [{ label: "Toastmaster", name: "Lee P." }],
			officers: [],
			explainers: [],
			rows: agendaRows(rowCount),
			qrUrl: QR_URL,
		},
	};
	const html = printableDocument(
		PRINT_PAGE_CSS,
		`<div id="root"></div>
<script>window.__fixture = ${JSON.stringify(fixture).replace(/</g, "\\u003c")};</script>
<script>${copiesBundle.replace(/<\/script/gi, "<\\/script")}</script>`,
	);
	const dir = mkdtempSync(join(tmpdir(), "copies-flow-"));
	const htmlPath = join(dir, "page.html");
	writeFileSync(htmlPath, html, "utf8");
	const { stages, html: settled } = await evaluateInChrome<{
		stages: CopiesStage[];
		html: string;
	}>(htmlPath, dir, "window.__result");
	return {
		stages,
		printedPages: printedPageCount(`<!doctype html>${settled}`),
	};
}

const FLIP_MIN = 30;
const FLIP_MAX = 90;

type FlipLayout = "grid" | "editorial";

type ParityFlip = {
	/** A row count where one layout prints 1 page and the other 2, or null. */
	rows: number | null;
	/** The layout on exactly 1 page at `rows` (null with `rows`). */
	onePage: FlipLayout | null;
	/** The layout on exactly 2 pages at `rows` (null with `rows`). */
	twoPage: FlipLayout | null;
	/** Every row count measured: `rows: grid height (pages), editorial height (pages)`. */
	table: string;
};

/**
 * A row count at which Grid and Editorial print on 1 page and 2 pages (either way
 * round), in THIS browser (#1230). WHICH of them flows first depends on the browser's
 * font face: a Mac flows Grid at 52 rows and Editorial at 57, Linux CI the other way
 * round (Editorial at 53, Grid at 55), so the answer names both layouts. Both
 * layouts' page counts only grow with the row count, so the first row where each
 * flows is found by binary search over `FLIP_MIN`..`FLIP_MAX`, one Chrome launch per
 * probe, both layouts drawn in each. The rows from the earlier first-flow row up to
 * the row before the later one are where the page parity differs; its middle is the
 * answer, the farthest from either edge. A face that moves a layout by a row or two
 * then changes the answer, not the verdict. An empty band, or a probe that is not
 * exactly 1 page and 2 pages, is `rows: null` with the measured table, for the
 * caller to fail on.
 */
async function findParityFlip(): Promise<ParityFlip> {
	const seen = new Map<number, { grid: number; editorial: number }>();
	const probe = async (rows: number) => {
		const known = seen.get(rows);
		if (known) return known;
		const { stages } = await realFitPageCopies(
			["grid", "editorial"],
			rows,
			1,
			false,
		);
		const grid = stages[0]?.heights[0] ?? 0;
		const editorial = stages[1]?.heights[0] ?? 0;
		const m = { grid, editorial };
		seen.set(rows, m);
		return m;
	};
	const firstFlowing = async (layout: FlipLayout) => {
		let lo = FLIP_MIN;
		let hi = FLIP_MAX;
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (sheetPages((await probe(mid))[layout]) >= 2) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};
	const grid = await firstFlowing("grid");
	const editorial = await firstFlowing("editorial");
	let rows: number | null = null;
	let onePage: FlipLayout | null = null;
	let twoPage: FlipLayout | null = null;
	const first = Math.min(grid, editorial);
	const last = Math.max(grid, editorial) - 1;
	if (last >= first) {
		const mid = Math.floor((first + last) / 2);
		const m = await probe(mid);
		const g = sheetPages(m.grid);
		const e = sheetPages(m.editorial);
		if (g === 1 && e === 2) {
			rows = mid;
			onePage = "grid";
			twoPage = "editorial";
		} else if (g === 2 && e === 1) {
			rows = mid;
			onePage = "editorial";
			twoPage = "grid";
		}
	}
	const table = [...seen.entries()]
		.sort(([a], [b]) => a - b)
		.map(
			([n, m]) =>
				`${n} rows: grid ${m.grid}px (${sheetPages(m.grid)}p), editorial ${m.editorial}px (${sheetPages(m.editorial)}p)`,
		)
		.join("\n");
	return {
		rows,
		onePage,
		twoPage,
		table: `${table}\nGrid first flows at ${grid} rows, Editorial at ${editorial}`,
	};
}

const hasChrome = findChrome() !== null;

// The gate must never be able to skip itself into green in CI. Locally, no
// browser means these are skipped so `bun run test` still runs for someone
// without Chrome; in CI, a missing browser is a failure, because a silently
// absent print gate is indistinguishable from a passing one — the exact shape
// CLAUDE.md flags for the DB-backed suites.
describe("print page-count harness availability", () => {
	it("has a browser to print with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome on PATH, so every print page-count assertion would " +
				"skip and the suite would still report green. Install Chrome on the " +
				"runner or this gate is decorative.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"printed page counts",
	// Every case here spawns a browser — see CHROME_TEST_TIMEOUT_MS.
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		// One sheet each. The grid and editorial layouts are single-page designs.
		it.each([
			["grid", 1],
			["editorial", 1],
		] as const)("agenda · %s prints %i page(s)", (layout, expected) => {
			expect(pages(PRINT_PAGE_CSS, agendaHtml(layout))).toBe(expected);
		});

		// Two sheets each, structurally: both wrap their content in `TwoPage`, which
		// emits two `.agenda-page` elements regardless of how many rows there are.
		it.each([
			["spacious", 2],
			["timing", 2],
		] as const)("agenda · %s prints %i page(s)", (layout, expected) => {
			expect(pages(PRINT_PAGE_CSS, agendaHtml(layout))).toBe(expected);
		});

		// #1166: `AGENDA_LAYOUT_PAGES` is what decides whether a duplex run puts a
		// blank between copies, so it must be what the layouts really print. Read
		// against the same measured counts as above, for every layout in the list.
		it("AGENDA_LAYOUT_PAGES is each layout's real page count", () => {
			expect(Object.keys(AGENDA_LAYOUT_PAGES).sort()).toEqual(
				[...AGENDA_LAYOUTS].sort(),
			);
			for (const layout of AGENDA_LAYOUTS) {
				expect(pages(PRINT_PAGE_CSS, agendaHtml(layout)), layout).toBe(
					AGENDA_LAYOUT_PAGES[layout],
				);
			}
		});

		// #1166, acceptance criterion 6. Measured, not derived: the copies sit in a
		// wrapper the single-copy page does not have, and the blank is a sheet of
		// its own, so only a browser can say they paginate to what the issue says.
		it.each([
			["grid", 3, true, 5],
			["editorial", 3, true, 5],
			["timing", 3, true, 6],
			["spacious", 3, true, 6],
			["grid", 3, false, 3],
			["timing", 3, false, 6],
			["grid", 1, true, 1],
		] as const)("%s x%i copies, duplex=%s prints %i pages", (layout, copies, duplex, expected) => {
			expect(pages(PRINT_PAGE_CSS, copiesHtml(layout, copies, duplex))).toBe(
				expected,
			);
		});

		// #1166 review: a copy that OVERFLOWS its nominal page count. The blank
		// follows the pages a copy really prints, not the layout's nominal count.
		it.each([
			// [label, layout, pages per copy, duplex, tall sheets, expected pages]
			// A one-page layout whose copy 1 flows onto a second page: 2 + 1, and NO
			// blank, because copy 2 already starts on a front.
			[
				"one-page layout, copy 1 overflows",
				"grid",
				[2, 1],
				true,
				{ 0: 1800 },
				3,
			],
			// …and with the nominal count it would have padded: 2 + blank + 1.
			[
				"one-page layout, copy 2 overflows",
				"grid",
				[1, 2],
				true,
				{ 1: 1800 },
				4,
			],
			// A two-page layout whose second sheet flows to two pages: 1 + 2 = 3, odd,
			// so a blank, then the next copy's 2.
			[
				"two-page layout overflows to 3",
				"timing",
				[3, 2],
				true,
				{ 1: 1800 },
				6,
			],
			// Even though it overflows, 2 + 2 = 4 is even: no blank, and the next copy's
			// first sheet (also flowing) starts on a fresh page: 4 + 3. (Measured: that
			// needs no rule of ours, since `.agenda-page { break-inside: avoid }` moves
			// a box that cannot stay whole to the top of the next page.)
			[
				"two-page layout, even overflow, next copy flows too",
				"timing",
				[4, 3],
				true,
				{ 0: 1800, 1: 1800, 2: 1800 },
				7,
			],
		] as const)("duplex copies that overflow: %s prints %i pages", (_label, layout, per, duplex, tall, expected) => {
			expect(
				pages(
					PRINT_PAGE_CSS,
					overflowingCopiesHtml(layout, [...per], duplex, tall),
				),
			).toBe(expected);
		});

		// #1181. The blank after a copy follows the pages `FitPage` REALLY made it
		// print, and that has to survive the layout being switched under the stack.
		// Every case below runs the real components in Chrome (see
		// `realFitPageCopies`), so these are the cases #1179's box-swap tests could
		// not see.
		describe("copies measured under the real FitPage (#1181)", () => {
			beforeAll(async () => {
				copiesBundle = await bundleCopiesEntry();
				// About a dozen Chrome launches (a binary search), at ~1.3s each.
				flip = await findParityFlip();
			}, 120_000);

			// Rows enough that the grid flows (its scale would fall under
			// `MIN_FIT_SCALE`) onto two pages.
			//
			// MEASURED (macOS, 2026-10-14, one copy, the harness's offline fallback
			// fonts, with the compact density of #1226 in place), sheet height by row
			// count. Cliff = (1056 - 2) / 0.72 = 1464px: a sheet whose natural height
			// is under it SCALES onto one page, over it FLOWS and is as tall as its
			// content.
			//   rows   grid         editorial
			//   49-51  1056 (1p)    1056 (1p)
			//   52     1472 (2p)    1056 (1p)
			//   53     1491 (2p)    1056 (1p)
			//   54     1510 (2p)    1056 (1p)
			//   55     1542 (2p)    1056 (1p)
			//   56     1557 (2p)    1056 (1p)
			//   57     1576 (2p)    1465 (2p)
			//   58     1603 (2p)    1485 (2p)
			//   84     2144 (3p)    1991 (2p)
			// Grid is on two pages from 52 through 82 rows. Compact moved Editorial's
			// limits (it was 2 pages from 31 rows and 3 from 48 before #1226): it now
			// holds one page through 56 rows and never has three pages next to a
			// two-page Grid at any row count. Grid/Editorial pages, swept 30 to 100 at
			// even row counts (and 49 to 59 at odd ones): 2/1 for 52 to 56, 2/2 for 57
			// to 82, 3/2 for 84 to 88, then 3/3.
			// LONG = 60: Grid is 1641px on a Mac, 177px over the cliff, and still two
			// pages (Grid is on two pages from 52 through 82 rows). Chosen for margin, not
			// as the first row count that flows: Linux CI's fallback face lays out about
			// 0.945 of a Mac's height (run 38634218891), which put the Mac-cliff fixture
			// of 52 rows (1472px) under the cliff there, Grid on ONE page, and failed
			// every case below that needs it to flow. 60 rows is about 1551px on Linux,
			// still 87px over. The cases only need Grid on TWO pages, and they assert it.
			// "A sheet that grows" adds 1100px: 1641 + 1100 is about 2740, three pages
			// (2114 < h <= 3170), on a Mac and on Linux.
			const LONG = 60;

			// Rows where the layouts' page PARITY differs: one layout on 2 pages (even,
			// no blank after a duplex copy), the other on 1 (odd, a blank after every
			// copy but the last). WHICH layout is the 2-page one differs per browser,
			// because the two layouts' faces move their flow points by different
			// amounts: on a Mac Grid flows at 52 rows and Editorial at 57 (Grid 2,
			// Editorial 1 at 52 to 56); on Linux CI (run 38640902515) Editorial flows
			// at 53 and Grid at 55 (Editorial 2, Grid 1 at 53 to 54, a band only 2 rows
			// wide). No ONE row count, or layout order, is right for both, so both are
			// MEASURED in whatever browser runs the suite: `findParityFlip`
			// binary-searches 30 to 90 rows for the first row where each layout flows
			// and takes the middle of the rows between. The band is as narrow as 2 rows
			// on Linux, which is fine because it is measured in the same browser that
			// then runs the switch. If there is no such row the suite FAILS with the
			// measured table. It never skips.
			let flip: ParityFlip | null = null;
			const flipCase = (): {
				rows: number;
				onePage: FlipLayout;
				twoPage: FlipLayout;
			} => {
				if (!flip?.rows || !flip.onePage || !flip.twoPage) {
					throw new Error(
						`no row count in ${FLIP_MIN} to ${FLIP_MAX} has one of Grid/Editorial on 1 page and the other on 2 in this browser. Measured:\n${flip?.table ?? "(not measured)"}`,
					);
				}
				return {
					rows: flip.rows,
					onePage: flip.onePage,
					twoPage: flip.twoPage,
				};
			};

			// protects=the precondition of the two switch cases below: in THIS browser
			//   some row count prints one of Grid/Editorial on 1 page and the other on 2
			// fails_when=none does (a face or layout change moved the bands apart), and
			//   then the measured table says where each layout flowed, instead of the
			//   switch cases passing about nothing or being skipped
			// no_claim=which layout is the 2-page one, or at what row count: both are
			//   chosen per browser (Mac: Grid 2 / Editorial 1 at about 54; Linux CI run
			//   38640902515: Editorial 2 / Grid 1 at 53 to 54)
			it("some row count prints one of Grid/Editorial on 1 page and the other on 2", () => {
				expect(
					flip?.rows,
					`rows ${FLIP_MIN} to ${FLIP_MAX}:\n${flip?.table ?? "(not measured)"}`,
				).toBeTypeOf("number");
				expect(flip?.onePage).not.toBe(flip?.twoPage);
			});

			it("a grid agenda that flows to 2 pages gets no blank between copies", async () => {
				const { stages, printedPages } = await realFitPageCopies(
					["grid"],
					LONG,
					3,
					true,
				);
				const [grid] = stages;
				// The precondition the case rests on: the sheet really flowed to 2 pages.
				expect(grid?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(grid?.blanks).toBe(0);
				expect(printedPages).toBe(6);
			});

			it("a grid agenda that fits one page gets a blank after each copy but the last", async () => {
				const { stages, printedPages } = await realFitPageCopies(
					["grid"],
					10,
					3,
					true,
				);
				const [grid] = stages;
				expect(grid?.heights.map(sheetPages)).toEqual([1, 1, 1]);
				expect(grid?.blanks).toBe(2);
				expect(printedPages).toBe(5);
			});

			// #1226 rewrote these two. They were "a 3-page editorial to a 2-page grid"
			// and back (odd to even, even to odd), on `LONG` rows. The compact density
			// made Editorial fit one page there, so Editorial never out-paginates Grid
			// by a full page again (see the table above); the same parity flip is now a
			// 1-page layout and a 2-page one, on `flipCase().rows` rows. Which of Grid
			// and Editorial is which is measured per browser (see above). What they
			// protect is unchanged: after a layout switch under a duplex stack, the
			// blank after each copy is recomputed from the pages `FitPage` REALLY made,
			// in both directions.

			// protects=a switch to a layout with an EVEN page count drops the blanks the
			//   odd one needed: they follow the pages FitPage really made the new layout
			//   print, not the ones the old layout printed
			// fails_when=the stack keeps the old layout's page counts after the switch
			//   (the blanks stay: 2 where 0 is right, 6 pages become 8), or measures
			//   once at mount and never again
			// no_claim=which of Grid/Editorial is the 1-page layout, or that the row
			//   count is the same in any other browser (both are chosen per browser,
			//   `findParityFlip`; each stage asserts its own preconditions); the grid
			//   that grows later
			it("switching from the 1-page layout to the 2-page layout drops the blanks", async () => {
				const { rows, onePage, twoPage } = flipCase();
				const { stages, printedPages } = await realFitPageCopies(
					[onePage, twoPage],
					rows,
					3,
					true,
				);
				const [one, two] = stages;
				// Preconditions: the first layout fits one page (odd), so every copy but
				// the last is followed by a blank (3 copies: 2 blanks) ...
				expect(one?.heights.map(sheetPages)).toEqual([1, 1, 1]);
				expect(one?.blanks).toBe(2);
				// ... and the second flowed to two (even): the 2 blanks are gone.
				expect(two?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(two?.blanks).toBe(0);
				// 3 copies of 2 pages, nothing between them.
				expect(printedPages).toBe(6);
			});

			// protects=a switch to a layout with an ODD page count adds the blanks the
			//   even one did not need
			// fails_when=the stack keeps the old layout's page counts after the switch
			//   (no blanks where 2 are needed: 3 pages instead of 5), or measures once
			//   at mount and never again
			// no_claim=which of Grid/Editorial is the 2-page layout, or that the row
			//   count is the same in any other browser (both are chosen per browser,
			//   `findParityFlip`)
			it("switching from the 2-page layout to the 1-page layout adds the blanks", async () => {
				const { rows, onePage, twoPage } = flipCase();
				const { stages, printedPages } = await realFitPageCopies(
					[twoPage, onePage],
					rows,
					3,
					true,
				);
				const [two, one] = stages;
				expect(two?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(two?.blanks).toBe(0);
				expect(one?.heights.map(sheetPages)).toEqual([1, 1, 1]);
				expect(one?.blanks).toBe(2);
				// 1 + blank + 1 + blank + 1
				expect(printedPages).toBe(5);
			});

			// A browser that draws no frames (a tab opened in the background, a tool
			// with no visible pane) never delivers a ResizeObserver callback. On a
			// fresh load of `?layout=grid&copies=3&duplex=1` the copies are measured
			// once, at mount, before `FitPage` flows them, and the count stayed at
			// the grid's nominal 1: a blank after every copy (#1181, as reported).
			it("a flowing grid gets no blank even when no ResizeObserver callback ever arrives", async () => {
				const { stages, printedPages } = await realFitPageCopies(
					["grid"],
					LONG,
					3,
					true,
					{ resizeObserver: "inert" },
				);
				expect(stages[0]?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(stages[0]?.blanks).toBe(0);
				expect(printedPages).toBe(6);
			});

			// The `typeof ResizeObserver === "undefined"` branch.
			it("a flowing grid gets no blank in a browser with no ResizeObserver", async () => {
				const { stages, printedPages } = await realFitPageCopies(
					["grid"],
					LONG,
					3,
					true,
					{ resizeObserver: "absent" },
				);
				expect(stages[0]?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(stages[0]?.blanks).toBe(0);
				expect(printedPages).toBe(6);
			});

			// The sheets the ResizeObserver hears must be the CURRENT ones. After a
			// layout switch replaced every sheet, a sheet that then grows with no
			// mutation under the stack (a logo or a late font loading) can only be
			// heard by an observer re-armed on the new sheets.
			it("a sheet that grows after a layout switch is still heard", async () => {
				const { stages } = await realFitPageCopies(
					["editorial", "grid"],
					LONG,
					3,
					true,
					{ growCss: "[data-fit-inner]{padding-bottom:1100px}" },
				);
				const [, grid, grown] = stages;
				expect(grid?.heights.map(sheetPages)).toEqual([2, 2, 2]);
				expect(grid?.blanks).toBe(0);
				// 1100px more puts each copy on a third page, which is odd.
				expect(grown?.heights.map(sheetPages)).toEqual([3, 3, 3]);
				expect(grown?.blanks).toBe(2);
			});

			it("without duplex a one-page grid is never padded", async () => {
				const { stages, printedPages } = await realFitPageCopies(
					["grid"],
					10,
					3,
					false,
				);
				expect(stages[0]?.heights.map(sheetPages)).toEqual([1, 1, 1]);
				expect(stages[0]?.blanks).toBe(0);
				expect(printedPages).toBe(3);
			});
		});

		/**
		 * The load-bearing CSS assumption behind the contest agenda
		 * (#agenda-templates). `FitPage` normally scales a sheet down to fit, but a
		 * speech contest runs ~40 rows at four contestants and ~58 at seven, and
		 * scaling that to one page printed the body text at 2.6pt. Below
		 * `MIN_FIT_SCALE` it therefore drops the fixed height and the `overflow:
		 * hidden` clip and lets the browser paginate instead.
		 *
		 * That only works if the sheet is allowed to break. `PRINT_PAGE_CSS` applies
		 * `.agenda-page { break-inside: avoid }` — added when every `.agenda-page`
		 * was a fixed `PAGE_H` box where it could never bind — and the flowing
		 * element still carries the same class. If `break-inside` won, a contest
		 * would print its first sheet and silently drop the rest, which is strictly
		 * worse than the crushed type it replaced.
		 *
		 * It does not win: a fragmentation break is forced when the box exceeds the
		 * page. Measured here rather than assumed, because nothing else in the repo
		 * can see it — the density suite measures HEIGHT, and a height that grows
		 * past `PAGE_H` reads identically whether the tail prints or is thrown away.
		 *
		 * Deliberately synthetic content and a hand-built `.agenda-page`: the
		 * subject is the STYLESHEET, not the component. `FitPage`'s flow branch is
		 * set by a `useEffect`, and both print harnesses feed static SSR markup to
		 * Chrome, so React never mounts and the branch is unreachable from any test
		 * in this repo (recorded in TODOS.md).
		 */
		it("an .agenda-page taller than its sheet paginates instead of being clipped", () => {
			const row = (i: number) =>
				`<div style="height:24px">Contest row ${i}</div>`;
			const tall = `<div class="agenda-page" style="width:816px;background:#fff">${Array.from(
				{ length: 120 },
				(_, i) => row(i),
			).join("")}</div>`;
			// 120 × 24px ≈ 2880px against ~1056px of usable sheet.
			expect(pages(PRINT_PAGE_CSS, tall)).toBeGreaterThan(1);

			// The control that makes the assertion above mean something: the SAME
			// markup short enough to fit is one page, so the count is responding to
			// content height and not to some other property of the fixture.
			const short = `<div class="agenda-page" style="width:816px;background:#fff">${Array.from(
				{ length: 10 },
				(_, i) => row(i),
			).join("")}</div>`;
			expect(pages(PRINT_PAGE_CSS, short)).toBe(1);
		});

		it("the Word of the Day poster prints exactly one page", () => {
			// The surface that shipped a blank second sheet in v1.3.0.0.
			//
			// The `.pgwrap` wrapper is reproduced from the ROUTE, not the component.
			// `WordOfTheDayPoster` does not carry the class — the word route's page
			// component does — and rendering the component alone makes every
			// `.pgwrap` rule inert,
			// which silently turns this assertion into a measurement of a page the
			// club never prints. Verified: without this wrapper, deleting the
			// `padding: 0 !important` reset (the actual v1.3.0.0 defect) does not
			// change the count. Where the wrapper lives differs per surface — the
			// role sheet and `TwoPage` carry their own, and the grid and editorial
			// agendas have none at all.
			//
			// The STYLESHEET is the route's too, and since #718 that is no longer
			// `PRINT_PAGE_CSS` — the poster is the one landscape surface, so it
			// serves `printPageCss("landscape")`.
			expect(pages(printPageCss("landscape"), posterHtml())).toBe(1);

			// MEASURED, NOT ASSUMED: the count above cannot tell you the poster
			// printed landscape. Serving the portrait default instead also prints
			// 1 — a 1056px-wide sheet in an 816px-wide page box OVERFLOWS
			// HORIZONTALLY, and horizontal overflow is clipped rather than
			// paginated, so the club gets one sheet with the right third of the
			// poster missing and every gate green. (Expected 2 here first; Chrome
			// said 1. The mechanism is why, not a quirk.)
			//
			// So the orientation itself is pinned where it CAN be seen: at the
			// source, by `print-page-reset.guard.test.ts` (which route calls
			// `printPageCss("landscape")`) and by `word-of-the-day-poster.test.tsx`
			// (that the sheet `FitPage` renders is the landscape box). This line
			// records the blindness rather than leaving the 1 above to be read as
			// evidence it does not carry — the same job as the empty-document
			// control at the bottom of this file.
			expect(pages(PRINT_PAGE_CSS, posterHtml())).toBe(1);
		});

		/**
		 * That the landscape `@page` rule REACHES Chrome, which the poster's own
		 * count cannot show (see above).
		 *
		 * A 1056px-tall sheet is one page under `letter portrait` and two under
		 * `letter landscape`, because the landscape page box is only 816px tall and
		 * VERTICAL overflow is the kind that paginates. So the pair below is a
		 * direct read of the page box's height: it can only pass if the browser
		 * honoured the orientation this change added.
		 *
		 * Synthetic markup and a hand-built `.agenda-page`, deliberately, for the
		 * same reason as the pagination test above it: the subject is the
		 * STYLESHEET, not any component.
		 */
		it("the landscape page box is really 816px tall, not 1056", () => {
			const portraitSheet =
				'<div class="agenda-page" style="width:816px;height:1056px;background:#fff"></div>';
			expect(pages(printPageCss("landscape"), portraitSheet)).toBe(2);
			// The control that makes that mean something: the identical sheet under
			// the portrait page box is one page. Without it, a 2 could come from
			// anything about the fixture.
			expect(pages(PRINT_PAGE_CSS, portraitSheet)).toBe(1);
		});

		/**
		 * The height half of the landscape turn (#718), which no other gate sees.
		 *
		 * `FitPage` scales a sheet down when its content overruns, which prints the
		 * word SMALLER than `posterWordSize` declares with the count unchanged —
		 * the same blindness `print-density.test.tsx` exists for on the agenda.
		 * #718 spent 23% of the sheet's height (1056 → 816) to buy 35% of its
		 * width, so height is the axis the change could plausibly have broken, and
		 * AC 6 is exactly "the scale-down must not fire for normal inputs". One
		 * word per bucket, measured directly.
		 *
		 * READ THIS BEFORE ADDING A WORD. The harness runs with
		 * `MAP * ~NOTFOUND`, so Fraunces never loads and the platform's fallback
		 * serif does the drawing — and that face is WIDER than Fraunces at these
		 * sizes. Every bucket's size is priced at 92–98% of the measure in
		 * Fraunces, so the fallback wraps each bucket's WIDEST word onto a second
		 * line here and nowhere real. Measured: "Wampum" composes 932px against
		 * this 816px sheet and would fail — and it does the same thing at the
		 * PORTRAIT sizes this change replaced ("Wampum" @173px in a 704px box is
		 * two lines too), so it is a property of the harness, not of #718.
		 *
		 * Two consequences. The words below are chosen to carry more slack than a
		 * wrapped word line costs at their size, because CI's Ubuntu fallback is a
		 * different face again and moves where lines break. And an exact line
		 * count is deliberately NOT asserted for the same reason — it would be
		 * green here and red on the runner.
		 *
		 * One browser launch for all of them, per the note on `measuredHeights`:
		 * launches are this harness's whole running cost and a generous file
		 * starves its neighbours rather than itself.
		 */
		it("no bucket needs FitPage's scale-down", () => {
			const sheet = pageBox("landscape").height;
			// One word per bucket: 233 / 157 / 124 / 111 / 93 px of display type,
			// plus an all-caps word off the second table. macOS slacks at the time
			// of writing: 115 / 181 / 216 / 113 / 155 / 211 px.
			const words = [
				"Apt",
				"Ephemeral",
				"Ephemerally",
				"Telecommunications",
				"Electroencephalographs",
				"EPHEMERAL",
			];
			const doc = printableDocument(
				printPageCss("landscape"),
				words.map((w, i) => `<div id="w${i}">${posterHtml(w)}</div>`).join(""),
			);
			const heights = measuredHeights(
				doc,
				words.map((_, i) => `#w${i} [data-fit-inner]`),
			);
			words.forEach((word, i) => {
				const natural = heights[i] as number;
				expect(
					natural,
					`"${word}" composes ${natural}px of content against a ${sheet}px ` +
						"landscape sheet. Over it, FitPage scales the whole poster down — " +
						"the page count stays 1 and the word prints smaller than " +
						`posterWordSize says (${posterWordSize(word)}px), silently. If ` +
						"this is a few px over on a runner whose fallback serif wraps a " +
						"line differently, the fix is a narrower fixture word, not a " +
						"bigger sheet.",
				).toBeLessThanOrEqual(sheet);
			});
		});

		it("the club role sheet prints exactly one page", () => {
			// The full route shell, not a bare sheet. `.no-print` is the rule that
			// hides the toolbar and the on-screen footer when printing, and it is
			// UNCOVERABLE without them: with a bare `<ClubRoleSheet>` fixture,
			// deleting `.no-print { display: none !important }` from PRINT_PAGE_CSS
			// changes nothing; with the route's own toolbar and footer present, the
			// same deletion pushes this surface to two pages and fails here.
			//
			// This is the same lesson as the `.pgwrap` wrapper one line of reasoning
			// up, one element further out: a fixture that stops short of the route's
			// DOM silently narrows what the gate can see.
			const html = renderToStaticMarkup(
				<div>
					{/* The route's screen-only back link (#542) — reproduced here for the
				    same reason as the toolbar and footer: the fixture is the route's
				    DOM, and `.no-print` is only covered by the chrome it hides. */}
					<a
						className="no-print roles-back"
						href="/club/downtown"
						style={{ position: "fixed", top: 12, left: 12 }}
					>
						← {LONG_CLUB}
					</a>
					<PrintToolbar>
						<PrintButton />
					</PrintToolbar>
					<ClubRoleSheet
						clubName={LONG_CLUB}
						clubNumber="1234567"
						roles={roleSheetRoles}
						logoUrl={LOGO}
					/>
					<PublicFooter
						className="no-print"
						style={{ color: MUTED, borderColor: `${INK}24` }}
					/>
				</div>,
			);
			expect(pages(CSS_ROLES, html)).toBe(1);
		});

		// A control, not a surface. Chrome exits 0 and writes a VALID ONE-PAGE PDF
		// for a page that rendered nothing at all — an empty body, or even a
		// file:// URL that does not exist. Four of the assertions above are
		// `toBe(1)`, so on their own they cannot tell "this surface prints one
		// sheet" from "this surface produced nothing": a component that starts
		// returning null, markup that fails to serialise, or a stylesheet that
		// fails to parse would all read as PASS.
		//
		// Recording the empty case makes that ambiguity explicit rather than
		// leaving every 1 to be read against an unstated zero.
		/**
		 * The companion control to the empty-document one below, and the reason the
		 * hand-off fixture above carries a disclaimer instead of a guarantee (#585).
		 *
		 * The file header asserts in PROSE that content volume cannot move a page
		 * count here. This makes that claim checkable: forty long names on every
		 * hand-off row — ~1,500 characters each, far past anything a club can enter —
		 * still print one sheet. So a reviewer who reaches for this file to gate a
		 * copy change gets told NO by a test rather than by a comment, and is sent to
		 * `print-density.test.tsx`, which measures printed points and does see it.
		 */
		it("page count is insensitive to detail length — the density gate owns that", () => {
			const long = rows.map((r) => ({
				...r,
				detail: `${r.detail} ${"Bartholomew Fitzgerald-Wellington, ".repeat(40)}`,
			}));
			const html = renderToStaticMarkup(
				<MeetingAgendaPrint
					layout="editorial"
					header={header}
					roles={[{ label: "Toastmaster", name: "Lee P." }]}
					officers={[]}
					explainers={[]}
					rows={long}
					qrUrl={QR_URL}
				/>,
			);
			expect(pages(PRINT_PAGE_CSS, html)).toBe(1);
		});

		it("an empty document also prints one page — so 1 is not proof of content", () => {
			expect(pages(PRINT_PAGE_CSS, "")).toBe(1);
		});
	},
);
