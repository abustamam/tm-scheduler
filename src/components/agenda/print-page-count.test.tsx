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
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicFooter } from "#/components/public-footer";
import {
	findChrome,
	printableDocument,
	printedPageCount,
} from "#/test/print-page-count";
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

const rows = Array.from({ length: 26 }, (_, i) => ({
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

const roleSheetRoles: RoleSheetEntry[] = Array.from({ length: 12 }, (_, i) => ({
	id: String(i),
	name: `Role ${i}`,
	category: (["leadership", "functionary", "speaker", "evaluator"] as const)[
		i % 4
	],
	description: "What this role does, in a sentence that wraps a little.",
}));

// Exercised on every layout, not just the ones that render it (#510): passing
// it unconditionally proves `GridLayout` really does ignore it (no DarkFooter
// to put it in) rather than that omission being untested by accident, and
// proves the QR itself — present on editorial/spacious/timing's `DarkFooter` —
// does not move any of the counts below.
const BALLOT_URL = "https://gavelup.app/club/downtown/meeting/2026-07-22/vote";

function agendaHtml(layout: AgendaLayout): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
			ballotUrl={BALLOT_URL}
		/>,
	);
}

function pages(css: string, html: string): number {
	return printedPageCount(printableDocument(css, html));
}

// ---------------------------------------------------------------------------

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

describe.skipIf(!hasChrome)("printed page counts", () => {
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
		const html = renderToStaticMarkup(
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<WordOfTheDayPoster
					word="Ephemeral"
					definition="Lasting for a very short time; fleeting."
					example="The applause was ephemeral, but the lesson stayed."
					clubName={LONG_CLUB}
					dateLong="Friday, July 31, 2026"
					logoUrl={LOGO}
				/>
			</div>,
		);
		expect(pages(PRINT_PAGE_CSS, html)).toBe(1);
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
				ballotUrl={BALLOT_URL}
			/>,
		);
		expect(pages(PRINT_PAGE_CSS, html)).toBe(1);
	});

	it("an empty document also prints one page — so 1 is not proof of content", () => {
		expect(pages(PRINT_PAGE_CSS, "")).toBe(1);
	});
});
