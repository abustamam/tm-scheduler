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

const rows = Array.from({ length: 26 }, (_, i) => ({
	who: i % 3 === 0 ? `Speaker ${i} · Someone Withalongname` : `Role ${i}`,
	detail: "A representative line of run-sheet detail for this beat",
	minutes: 5,
	marks: i % 3 === 0 ? { green: 4, yellow: 5, red: 6 } : null,
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

function agendaHtml(layout: AgendaLayout): string {
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={header}
			roles={[{ label: "Toastmaster", name: "Lee P." }]}
			officers={[]}
			explainers={[]}
			rows={rows}
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
	it("an empty document also prints one page — so 1 is not proof of content", () => {
		expect(pages(PRINT_PAGE_CSS, "")).toBe(1);
	});
});
