/**
 * The (V) legend on the printed agenda, in a real layout engine (#1164).
 *
 * A visiting Toastmaster reads "Name (V)" and the sheet that shows one carries
 * "(V) Visiting Toastmaster" in its footer, at no cost in sheets. Three things
 * can go wrong that no jsdom test can see, and each is asserted here on the REAL
 * flowed fixtures (MCF's 2026-08-13 agenda and THR's 2026-10-10 timing agenda,
 * the one that overflowed onto a third sheet in production), never on a synthetic
 * overflow (#1181):
 *
 *   · the legend lands on a sheet that shows no (V), or is missing from one that
 *     does (each sheet decides for itself, so a two-sheet layout can differ);
 *   · the legend pushes a sheet past `FitPage`'s flow cliff, so the club prints
 *     one sheet more than it did;
 *   · the legend runs off the right edge of a footer, taking text with it.
 *
 * Sheets are counted from each sheet's natural height against that cliff, because
 * `FitPage`'s scale-or-flow decision is an effect that static markup never runs:
 * a plain PDF page count cannot move (`print-page-count.test.tsx`'s header says
 * so). Every sheet of every variant is laid out in ONE document and one browser
 * launch (#624 measured what a launch per sheet does to CI).
 *
 * Same harness caveat as `ballot-qr-print-fit.test.tsx`: no webfont resolves, the
 * fallback differs between macOS and CI's Ubuntu, so these are comparisons
 * between variants measured together, never absolute figures.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VISITING_TOASTMASTER_LEGEND } from "#/lib/agenda";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import { buildTemplateRows } from "#/lib/agenda-template-rows";
import { meetingHubUrlFor } from "#/lib/meeting-hub";
import {
	MCF_EXPLAINERS,
	MCF_HEADER,
	MCF_OFFICERS,
	MCF_ROLES,
	MCF_ROWS,
} from "#/test/mcf-agenda-fixture";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	measuredHeights,
	printableDocument,
} from "#/test/print-page-count";
import {
	THR_EXPLAINERS,
	THR_HEADER,
	THR_OFFICERS,
	thrAgenda,
} from "#/test/thr-agenda-fixture";
import {
	type AgendaLayout,
	type AgendaRoleEntry,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

type Agenda = {
	roles: AgendaRoleEntry[];
	rows: Parameters<typeof MeetingAgendaPrint>[0]["rows"];
};

const THR = thrAgenda({ veena: "Guest", david: "Guest" });

const FIXTURES = {
	mcf: {
		header: MCF_HEADER,
		officers: MCF_OFFICERS,
		explainers: MCF_EXPLAINERS,
		agenda: { roles: MCF_ROLES, rows: MCF_ROWS } as Agenda,
		qr: meetingHubUrlFor(
			{ clubKey: "mcf-toastmasters", meetingKey: "2026-08-13" },
			"https://gavelup.app",
		),
		// Holders of three role rows (Speaker 1, Speaker 2, Evaluator 3 and Timer).
		switched: ["Jagpal Singh", "Sudheer Isanaka", "Riyaz Mohammed"],
	},
	thr: {
		header: THR_HEADER,
		officers: THR_OFFICERS,
		explainers: THR_EXPLAINERS,
		agenda: THR as Agenda,
		qr: meetingHubUrlFor(
			{ clubKey: "thr-speaking-club", meetingKey: "2026-10-10" },
			"https://gavelup.app",
		),
		// Holders of the three speaker rows.
		switched: ["Zabihullah Kogyani", "Anita Adams", "Fatma Elsawaf"],
	},
} as const;
type FixtureId = keyof typeof FIXTURES;
const FIXTURE_IDS = Object.keys(FIXTURES) as FixtureId[];

const LAYOUTS: readonly AgendaLayout[] = [
	"editorial",
	"grid",
	"timing",
	"spacious",
];

/** How many sheets a layout prints on. */
const SHEETS: Record<AgendaLayout, number> = {
	editorial: 1,
	grid: 1,
	timing: 2,
	spacious: 2,
};

/** Which sheet carries the roster and which the run of show. One-sheet layouts
 *  carry both on their one sheet. */
const SHEET_HAS: Record<
	AgendaLayout,
	readonly { roles: boolean; rows: boolean }[]
> = {
	editorial: [{ roles: true, rows: true }],
	grid: [{ roles: true, rows: true }],
	timing: [
		{ roles: true, rows: false },
		{ roles: false, rows: true },
	],
	spacious: [
		{ roles: true, rows: false },
		{ roles: false, rows: true },
	],
};

/** The same agenda with each named person marked "(V)" wherever the roster or a
 *  row names them — what `assigneeDisplayName` produces for the same slots, applied
 *  to the fixture's already-rendered strings — and `visiting: true` on every entry
 *  that changed, which is what the loaders set from the slot and what the sheet's
 *  legend is decided from (#1164): the harness stands in for a visiting slot, so
 *  it must set the flag the slot would. */
function markVisiting(
	agenda: Agenda,
	names: readonly string[],
	where: { roles: boolean; rows: boolean },
): Agenda {
	const mark = (text: string) =>
		names.reduce((t, n) => t.split(n).join(`${n} (V)`), text);
	const flagged = <T extends object>(before: T, after: T) =>
		JSON.stringify(before) === JSON.stringify(after)
			? after
			: { ...after, visiting: true as const };
	return {
		roles: where.roles
			? agenda.roles.map((r) =>
					flagged(r, {
						...r,
						name: r.name == null ? null : mark(r.name),
						...(r.holders ? { holders: r.holders.map(mark) } : {}),
					}),
				)
			: agenda.roles,
		rows: where.rows
			? agenda.rows.map((r) =>
					flagged(r, {
						...r,
						who: mark(r.who),
						detail: mark(r.detail),
						...(r.holder != null ? { holder: mark(r.holder) } : {}),
						...(r.holders ? { holders: r.holders.map(mark) } : {}),
						...(r.introduces ? { introduces: r.introduces.map(mark) } : {}),
					}),
				)
			: agenda.rows,
	};
}

/** `base` is the unmodified fixture; `both` switches the holders everywhere they
 *  are named; `rolesOnly` / `rowsOnly` put the (V) on one kind of sheet so a
 *  two-sheet layout has one sheet with and one without. */
const VARIANTS = {
	base: { roles: false, rows: false },
	both: { roles: true, rows: true },
	rolesOnly: { roles: true, rows: false },
	rowsOnly: { roles: false, rows: true },
} as const;
type Variant = keyof typeof VARIANTS;
const VARIANT_IDS = Object.keys(VARIANTS) as Variant[];

function sheetHtml(f: FixtureId, layout: AgendaLayout, v: Variant): string {
	const fx = FIXTURES[f];
	const { roles, rows } = markVisiting(fx.agenda, fx.switched, VARIANTS[v]);
	return renderToStaticMarkup(
		<MeetingAgendaPrint
			layout={layout}
			header={fx.header}
			roles={roles}
			officers={fx.officers}
			explainers={fx.explainers}
			rows={rows}
			qrUrl={fx.qr}
		/>,
	);
}

const partId = (f: FixtureId, layout: AgendaLayout, v: Variant) =>
	`${f}-${layout}-${v}`;
const sheetRoot = (id: string, n: number) =>
	`#${id} .agenda-page:nth-of-type(${n})`;

type Sheet = {
	height: number;
	/** Sideways overflow of the widest footer element on this sheet, px. */
	footerOverflow: number;
	/** Whether this sheet's footer carries the legend. */
	legend: boolean;
};
type Measured = Partial<Record<Variant, Sheet[]>>;

/**
 * The variants a layout is measured in. The one-sheet layouts carry the roster
 * and the rows on the same sheet, so `rolesOnly` / `rowsOnly` would repeat `both`;
 * only a two-sheet layout has a sheet with a (V) beside a sheet without.
 */
const variantsFor = (layout: AgendaLayout): Variant[] =>
	SHEETS[layout] === 1 ? ["base", "both"] : VARIANT_IDS;

/**
 * The harness reads back `scrollHeight` and nothing else, so what is wanted
 * besides height is written into the HEIGHT of a marker div by a script that runs
 * before the harness's own probe: 1px plus the footer's worst sideways overflow,
 * and 1 or 2px for "the footer carries the legend" (a zero is refused below as
 * "not a measurement", which is also what a sheet with NO footer band reports).
 */
function probeScript(
	parts: readonly { id: string; sheets: number }[],
	legend: string,
): string {
	return `<script>
	(function () {
		var legend = ${JSON.stringify(legend)};
		${JSON.stringify(parts)}.forEach(function (p) {
			for (var n = 1; n <= p.sheets; n++) {
				var root = document.querySelector("#" + p.id + " .agenda-page:nth-of-type(" + n + ")");
				var band = root && root.querySelector("[data-print-footer]");
				var worst = 0;
				if (band) {
					[band].concat(Array.prototype.slice.call(band.querySelectorAll("*"))).forEach(function (el) {
						if (el.clientWidth > 0) worst = Math.max(worst, el.scrollWidth - el.clientWidth);
					});
				}
				var o = document.createElement("div");
				o.id = "ovf-" + p.id + "-" + n;
				o.style.height = band ? 1 + worst + "px" : "0px";
				document.body.appendChild(o);
				var l = document.createElement("div");
				l.id = "leg-" + p.id + "-" + n;
				l.style.height = band ? (band.textContent.indexOf(legend) >= 0 ? "2px" : "1px") : "0px";
				document.body.appendChild(l);
			}
		});
	})();
	</script>`;
}

/**
 * One browser launch per fixture and layout, every variant of it in one
 * document. Not one launch for everything: the harness reads the page back
 * through `--dump-dom`, whose output a 1MB pipe buffer caps (`ENOBUFS`), and 16
 * laid-out sheets exceed it. Eight launches stay well under the cost #624
 * measured for a launch per sheet.
 */
const cache = new Map<string, Measured>();
function measure(f: FixtureId, layout: AgendaLayout): Measured {
	const key = `${f}/${layout}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const parts = variantsFor(layout).map((v) => ({
		id: partId(f, layout, v),
		v,
		sheets: SHEETS[layout],
	}));
	const body =
		parts
			.map((p) => `<div id="${p.id}">${sheetHtml(f, layout, p.v)}</div>`)
			.join("") +
		probeScript(
			parts.map((p) => ({ id: p.id, sheets: p.sheets })),
			VISITING_TOASTMASTER_LEGEND,
		);
	const selectors = parts.flatMap((p) =>
		Array.from({ length: p.sheets }, (_, i) => i + 1).flatMap((n) => [
			`${sheetRoot(p.id, n)} [data-fit-inner]`,
			`#ovf-${p.id}-${n}`,
			`#leg-${p.id}-${n}`,
		]),
	);
	const values = measuredHeights(
		printableDocument(PRINT_PAGE_CSS, body),
		selectors,
	);
	for (const [i, h] of values.entries()) {
		if (!h || h <= 0)
			throw new Error(`Measured ${h} for ${selectors[i]} — not a measurement.`);
	}
	let at = 0;
	const out: Measured = {};
	for (const p of parts) {
		out[p.v] = Array.from({ length: p.sheets }, () => {
			const height = values[at] ?? 0;
			const footerOverflow = (values[at + 1] ?? 1) - 1;
			const legend = values[at + 2] === 2;
			at += 3;
			return { height, footerOverflow, legend };
		});
	}
	cache.set(key, out);
	return out;
}

/** `FitPage` scales a sheet while its natural height allows, and flows it onto
 *  more sheets past this cliff. */
const fits = (h: number) => (PAGE_H - 2) / h >= MIN_FIT_SCALE;
function sheetsPrinted(h: number): number {
	return fits(h) ? 1 : Math.ceil(h / PAGE_H);
}
const totalSheets = (sheets: Sheet[]) =>
	sheets.reduce((n, s) => n + sheetsPrinted(s.height), 0);

const hasChrome = findChrome() !== null;

describe("visiting legend print-fit harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the legend's print fit would skip and read green.",
		).toBe(true);
	});
});

describe("the fixtures", () => {
	// protects=the fixtures really do name the switched people on the roster and in
	// the rows, so a "(V)" variant differs from the base one;
	// fails_when=a name is misspelled or a fixture is reworded, which would leave
	// `markVisiting` changing nothing and every fit assertion below passing on two
	// identical sheets;
	// no_claim=none beyond protects.
	it("name each switched person in the roster or a row, and the (V) variant changes them", () => {
		for (const f of FIXTURE_IDS) {
			const fx = FIXTURES[f];
			const both = markVisiting(fx.agenda, fx.switched, VARIANTS.both);
			const rosterText = (a: Agenda) =>
				a.roles.map((r) => `${r.name} ${(r.holders ?? []).join()}`).join("|");
			const rowText = (a: Agenda) =>
				a.rows.map((r) => `${r.who} ${r.holder} ${r.detail}`).join("|");
			for (const n of fx.switched) {
				expect(
					rosterText(fx.agenda) + rowText(fx.agenda),
					`${f}: ${n}`,
				).toContain(n);
				expect(rosterText(both) + rowText(both), `${f}: ${n}`).toContain(
					`${n} (V)`,
				);
			}
			expect(rowText(fx.agenda)).not.toContain("(V)");
			expect(rosterText(fx.agenda)).not.toContain("(V)");
			// And the flag follows the text: set where a (V) was written, absent from
			// the base fixture, so a legend decided from the flag is decided by the
			// same entries the (V) was put on.
			expect(fx.agenda.roles.some((r) => r.visiting)).toBe(false);
			expect(fx.agenda.rows.some((r) => r.visiting)).toBe(false);
			expect(
				[...both.roles, ...both.rows].filter((e) => e.visiting).length,
				`${f}: nothing was flagged`,
			).toBeGreaterThan(0);
		}
	});
});

describe("the (V) legend and a section's hidden note", () => {
	// protects=a two-sheet layout prints the key only on the sheet that shows a
	// (V): a SECTION band prints its title and never its note, so a note naming
	// the visiting Toastmaster (who is on page one's roster) must not put a key on
	// page two, which shows no (V);
	// fails_when=a section row's `visiting` is set from its hidden detail, as
	// be38104 did, so page two carries a legend over no "(V)";
	// no_claim=none beyond protects. Static markup, no browser.
	it.each([
		"timing",
		"spacious",
	] as const)("prints the key once, on the roster sheet only, in the %s layout", (layout) => {
		const visitor: AgendaSlot = {
			id: "ttm-0",
			roleName: "Table Topics Master",
			roleKey: "table_topics_master",
			category: "leadership",
			isSpeakerRole: false,
			slotIndex: 0,
			assigneeName: "Jane Doe",
			speechTitle: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			evaluatesSlotId: null,
			evaluates: null,
			assigneeIsGuest: true,
			assigneeIsVisitingToastmaster: true,
		};
		const rows = buildTemplateRows(
			[
				{
					id: "b0",
					sortOrder: 0,
					kind: "section",
					label: "ROUND ONE",
					detail: "{names:table_topics_master}",
					minutes: 0,
					roleKey: null,
					repeatsRoleKey: null,
					flex: false,
					handoff: false,
					markGreen: null,
					markYellow: null,
					markRed: null,
					clubGoverned: false,
				},
			],
			[
				{
					key: "table_topics_master",
					name: "Table Topics Master",
					isSpeakerRole: false,
				},
			],
			[visitor],
		).map((r) => ({ ...r, time: "" }));
		expect(rows[0]?.section).toBe(true);
		const html = renderToStaticMarkup(
			<MeetingAgendaPrint
				layout={layout}
				header={THR_HEADER}
				roles={[
					{
						label: "Table Topics Master",
						name: "Jane Doe (V)",
						visiting: true,
					},
				]}
				officers={THR_OFFICERS}
				explainers={THR_EXPLAINERS}
				rows={rows}
				qrUrl={FIXTURES.thr.qr}
			/>,
		);
		// The key sits on the first sheet, with the roster's (V), and the second
		// sheet (the run of show, a section band and no (V)) carries none.
		const sheets = html.split("agenda-page");
		expect(sheets.length - 1).toBe(2);
		expect(html.split(VISITING_TOASTMASTER_LEGEND).length - 1).toBe(1);
		expect(sheets[1]).toContain(VISITING_TOASTMASTER_LEGEND);
		expect(sheets[2]).not.toContain(VISITING_TOASTMASTER_LEGEND);
	});
});

describe.skipIf(!hasChrome)(
	"the (V) legend on the printed agenda",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		// protects=each sheet carries the legend exactly when it shows a (V): all
		// sheets of the fully switched fixture, none of the unmodified one, and on a
		// two-sheet layout only the sheet whose roster or rows hold the (V);
		// fails_when=a sheet prints the legend with no (V) on it, omits it with one,
		// or one sheet's (V) puts the legend on the other (a condition made
		// unconditional, or read from the wrong list);
		// no_claim=where in the footer it sits: the grid and spacious page 1 place
		// it in hand-rolled bands, which the overflow case below measures.
		it("sits in the footer of exactly the sheets that show a (V)", () => {
			for (const f of FIXTURE_IDS) {
				for (const layout of LAYOUTS) {
					const m = measure(f, layout);
					for (const v of variantsFor(layout)) {
						const expected = SHEET_HAS[layout].map(
							(has) =>
								(has.roles && VARIANTS[v].roles) ||
								(has.rows && VARIANTS[v].rows),
						);
						expect(
							m[v]?.map((s) => s.legend),
							`${f} ${layout} ${v}`,
						).toEqual(expected);
					}
				}
			}
		});

		// protects=the legend costs no sheet: each layout prints the same number of
		// sheets with three role rows held by a visiting Toastmaster as it does for
		// the unmodified real fixture;
		// fails_when=the (V) text or the legend pushes a sheet past the flow cliff
		// so the club prints one more sheet (the way THR's timing sheet once went
		// to three);
		// no_claim=sheet COUNT, not height: the legend may add height inside a
		// band. A sheet already past the cliff on this machine's fonts (spacious
		// page 2) is counted as it flows, identically in both variants.
		it("prints the same number of sheets as the unmodified fixture, on every layout", () => {
			for (const f of FIXTURE_IDS) {
				for (const layout of LAYOUTS) {
					const m = measure(f, layout);
					const base = m.base ?? [];
					const both = m.both ?? [];
					expect(base.length).toBe(SHEETS[layout]);
					expect(totalSheets(both), `${f} ${layout}`).toBe(totalSheets(base));
				}
			}
		});

		// protects=no footer element runs off the right edge of its band, with the
		// legend present or not: not the QR caption, not the disclaimer, not the
		// grid's top row;
		// fails_when=the legend is laid out on a no-wrap line that cannot shrink,
		// which costs no height and so passes the sheet-count case while clipping
		// the QR caption or the "Meets" line off the paper;
		// no_claim=pixel clipping by `overflow: hidden` ancestors that report no
		// scrollWidth excess; the band and every descendant with a width are
		// measured.
		it("lets no footer element overflow sideways, with the legend or without", () => {
			for (const f of FIXTURE_IDS) {
				for (const layout of LAYOUTS) {
					const m = measure(f, layout);
					for (const v of variantsFor(layout)) {
						for (const [i, s] of (m[v] ?? []).entries()) {
							expect(
								s.footerOverflow,
								`${f} ${layout} ${v} sheet ${i + 1}`,
							).toBeLessThanOrEqual(0);
						}
					}
				}
			}
		});
	},
);
