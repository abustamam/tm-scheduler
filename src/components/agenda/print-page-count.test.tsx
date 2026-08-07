/**
 * Page counts for every print surface (#502).
 *
 * This is the gate the repo has never had. Print CSS is invisible to typecheck,
 * to lint, and to every component test, because those assert the DOM and a
 * blank second sheet is not in the DOM — it is a consequence of geometry that
 * only exists once a browser paginates the page. A missing `.pgwrap` reset
 * shipped exactly that in v1.3.0.0, past six test files and two reviews.
 *
 * These assertions are a BASELINE first and a gate second. They were recorded
 * against the three style blocks as the routes served them before
 * `PRINT_PAGE_CSS` was extracted, so the extraction has something to be checked
 * against rather than a promise that a union of five divergent copies is
 * harmless. If a number here changes, a print surface gained or lost a sheet.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
import { WordOfTheDayPoster } from "./word-of-the-day-poster";

// ---------------------------------------------------------------------------
// The style blocks, verbatim from the routes. Replaced by the shared constant
// once the extraction lands; the numbers below must not move when that happens.
// ---------------------------------------------------------------------------

const CSS_AGENDA_PRINT = `
	@media screen { body { background: #d8e6dd; } }
	.pgwrap { padding: 28px 0; }
	@media print {
		.no-print { display: none !important; }
		body { background: #fff; }
		.pgwrap { padding: 0 !important; gap: 0 !important; }
		.agenda-page { box-shadow: none !important; break-after: page; break-inside: avoid; }
		.agenda-page:last-child { break-after: auto; }
		@page { size: letter portrait; margin: 0; }
	}
`;

const CSS_WORD = `
	@media screen { body { background: #d8e6dd; } }
	.pgwrap { padding: 28px 0; }
	@media print {
		.no-print { display: none !important; }
		body { background: #fff; }
		.pgwrap { padding: 0 !important; }
		.agenda-page { box-shadow: none !important; }
		@page { size: letter portrait; margin: 0; }
	}
`;

const CSS_ROLES = `
	@media screen { body { background: #d8e6dd; } }
	.pgwrap { padding: 28px 0; display: flex; justify-content: center; }
	@media print {
		.no-print { display: none !important; }
		body { background: #fff; }
		.pgwrap { padding: 0 !important; }
		.agenda-page { box-shadow: none !important; break-after: page; break-inside: avoid; }
		.agenda-page:last-child { break-after: auto; }
		@page { size: letter portrait; margin: 0; }
	}
`;

// ---------------------------------------------------------------------------
// Fixtures. Deliberately a FULL meeting, not the two-row fixture the component
// tests use: the pagination rules only engage on a surface that fills a sheet,
// so a small fixture would make this gate vacuous for the exact CSS it guards.
// ---------------------------------------------------------------------------

const header: AgendaHeader = {
	clubName: "Downtown Toastmasters",
	logoUrl: null,
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
		expect(pages(CSS_AGENDA_PRINT, agendaHtml(layout))).toBe(expected);
	});

	// Two sheets each, structurally: both wrap their content in `TwoPage`, which
	// emits two `.agenda-page` elements regardless of how many rows there are.
	it.each([
		["spacious", 2],
		["timing", 2],
	] as const)("agenda · %s prints %i page(s)", (layout, expected) => {
		expect(pages(CSS_AGENDA_PRINT, agendaHtml(layout))).toBe(expected);
	});

	it("the Word of the Day poster prints exactly one page", () => {
		// The surface that shipped a blank second sheet in v1.3.0.0.
		//
		// The `.pgwrap` wrapper is reproduced from the ROUTE, not the component.
		// `WordOfTheDayPoster` does not carry the class — `word.tsx:166` does —
		// and rendering the component alone makes every `.pgwrap` rule inert,
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
					clubName="Downtown Toastmasters"
					dateLong="Friday, July 31, 2026"
				/>
			</div>,
		);
		expect(pages(CSS_WORD, html)).toBe(1);
	});

	it("the club role sheet prints exactly one page", () => {
		const html = renderToStaticMarkup(
			<ClubRoleSheet
				clubName="Downtown Toastmasters"
				clubNumber="1234567"
				roles={roleSheetRoles}
			/>,
		);
		expect(pages(CSS_ROLES, html)).toBe(1);
	});
});
