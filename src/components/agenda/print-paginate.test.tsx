// @vitest-environment jsdom
/**
 * An agenda too long for Timing prints on continuation sheets that look like the
 * rest (#1227).
 *
 * After #1225 and #1226 an agenda ends at Timing, two sheets, at `compact` if it
 * must. A speech contest can still be too long for that: sheet 2's run of show
 * needs a scale under `MIN_FIT_SCALE`, so `FitPage` drops the sheet's height and
 * the browser cuts the run wherever the paper ends. Timing now PAGINATES it: the
 * run is measured off-screen at scale 1, packed onto sheet 2 and as many
 * continuation sheets as it takes (`paginate`, `src/lib/agenda-paginate.ts`), and
 * each sheet carries the same footer.
 *
 * Two layers, because each sees what the other cannot:
 *
 *   - jsdom with every height stubbed: the wiring. N sheets, a header and a
 *     footer on each, page numbers, the (V) key per sheet, and that nothing
 *     paginates unless sheet 2 flowed at compact. Cannot say a real agenda needs it.
 *   - Chrome, `FitPage`'s and `TimingMeasure`'s real effects
 *     (`src/test/print-paginate-entry.tsx`): a real contest paginates, every sheet
 *     is exactly a page, no presenter's rows are cut, no text is lost, and the
 *     printed PDF has the pages the DOM says. Heights are this machine's fallback
 *     face's (no webfont resolves; CI pins another), so each message carries the
 *     numbers it saw.
 *
 * WHICH FIXTURE. The issue names the contest at seven contestants, ~58 rows. The
 * seeded template at seven is 27 rows here and fits two compact sheets (scale
 * 0.917), as `print-compact.test.tsx` already found, so it never paginates. The
 * sixteen-contestant one does, as #1226's tests use it: 45 rows, N = 3.
 *
 * MEASURED on macOS (headless shell 1234), contestDense16: sheet 2 holds 29 rows
 * at scale 1, one continuation sheet the other 16 rows and the notes, N = 3, all
 * sheets 1056px. contestDense20 (53 rows) is N = 3 as well; the fixtures stop at
 * 53 rows, so the EVEN variant below repeats the run (`repeat`) until a sheet count
 * of 4 appears. Which repeat gives an odd and which an even N is found at run time,
 * not assumed: Linux CI's face is shorter and moves them.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VISITING_TOASTMASTER_LEGEND } from "#/lib/agenda";
import { groupByPresenter } from "#/lib/agenda-groups";
import type { TimelineRow } from "#/lib/agenda-timing";
import { runClientEntry } from "#/test/client-bundle-chrome";
import { printCompactAgenda } from "#/test/print-compact-fixtures";
import {
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
	printedPageCount,
} from "#/test/print-page-count";
import type {
	CopiesSnapshot,
	PaginateScenario,
	SheetsSnapshot,
} from "#/test/print-paginate-entry";
import { MeetingAgendaPrint } from "./meeting-agenda-print";
import { MIN_FIT_SCALE, PAGE_H, PRINT_PAGE_CSS } from "./print-theme";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const QR = "https://example.test/meeting";

/** Collapse whitespace and case: innerText honours `text-transform`, and the
 *  section bands are uppercase on paper. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// ---------------------------------------------------------------------------
// jsdom: the wiring, with every height stubbed
// ---------------------------------------------------------------------------

const CONTEST = "contestDense16" as const;

/**
 * Stub the browser's layout so the pagination pass sees numbers: sheet 2 (and
 * every `[data-fit-inner]`) reports 3000px of content, so it would flow; each
 * `[data-unit]` is `unit` px, the tail `tail`, the whole off-screen sheet 2
 * `firstChrome` px plus its contents, the empty continuation sheet `restChrome`.
 * Capacities are then 1056 - chrome - 2.
 */
function stubLayout(
	o: {
		unit?: number;
		tail?: number;
		firstChrome?: number;
		restChrome?: number;
	} = {},
) {
	const unit = o.unit ?? 300;
	const tail = o.tail ?? 40;
	const firstChrome = o.firstChrome ?? 200;
	const restChrome = o.restChrome ?? 150;
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
		function (this: HTMLElement) {
			return this.hasAttribute("data-fit-inner") ? 3000 : 0;
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		function (this: HTMLElement) {
			const rect = (height: number) => ({ height }) as DOMRect;
			if (this.hasAttribute("data-unit")) return rect(unit);
			if (this.hasAttribute("data-run-tail")) return rect(tail);
			if (this.getAttribute("aria-hidden") === "true") {
				const units = this.querySelectorAll("[data-unit]").length;
				return rect(units > 0 ? firstChrome + units * unit + tail : restChrome);
			}
			return rect(0);
		},
	);
}

function view(
	over: Partial<React.ComponentProps<typeof MeetingAgendaPrint>> = {},
) {
	const a = printCompactAgenda(CONTEST);
	return (
		<MeetingAgendaPrint
			layout="timing"
			header={a.header}
			roles={a.roles}
			officers={a.officers}
			explainers={[]}
			rows={a.rows}
			qrUrl={QR}
			{...over}
		/>
	);
}

const sheetsOf = (c: HTMLElement) => [
	...c.querySelectorAll<HTMLElement>(".agenda-page"),
];

describe("Timing paginates a run that is still too long at compact", () => {
	// protects=when sheet 2 would flow at compact, Timing prints sheet 2 plus
	//   continuation sheets (N > 2), each with the same dark footer, the QR, and a
	//   "Page k of N" in it; sheets 3..N lead with the continuation header
	// fails_when=the run still flows on one sheet, a sheet has no footer or QR, a
	//   continuation sheet has no header, or the page numbers are not N
	// no_claim=what the stubbed heights mean in a browser (the Chrome tests)
	it("N sheets: a footer with the QR on each, a continuation header on 3..N", () => {
		stubLayout();
		const { container } = render(view({ initialDensity: "compact" }));
		const sheets = sheetsOf(container);
		// Capacities 854 and 904 at 300px a unit: units are folded presenter groups, so
		// the count is the layout's, but it must be more than two sheets.
		expect(sheets.length).toBeGreaterThan(2);
		const n = sheets.length;
		sheets.forEach((sheet, i) => {
			const footer = sheet.querySelector("[data-print-footer]");
			expect(footer, `sheet ${i + 1} footer`).not.toBeNull();
			expect(
				footer?.querySelector(".footer-qr"),
				`sheet ${i + 1} QR`,
			).not.toBeNull();
			expect(footer?.textContent, `sheet ${i + 1}`).toContain(
				`Page ${i + 1} of ${n}`,
			);
			const head = sheet.querySelector("[data-continuation-header]");
			if (i < 2)
				expect(head, `sheet ${i + 1} has no continuation header`).toBeNull();
			else {
				expect(head?.textContent).toContain(`Page ${i + 1} of ${n}`);
				expect(head?.textContent).toContain("continued");
				expect(head?.textContent).toContain(
					printCompactAgenda(CONTEST).header.clubName,
				);
			}
		});
	});

	// protects=the announcements / notes print once, under the last row, and every
	//   continuation sheet repeats the table's column header
	// fails_when=the tail repeats on every sheet, is dropped, or lands on a sheet
	//   that is not the last; a continuation sheet loses its column header
	// no_claim=that it fits there (it is packed as a unit of its own height)
	it("prints the tail once, on the last sheet, and the column header on each", () => {
		stubLayout();
		const { container } = render(view({ initialDensity: "compact" }));
		const sheets = sheetsOf(container);
		const withTail = sheets.filter((s) => s.querySelector("[data-run-tail]"));
		expect(withTail).toHaveLength(1);
		expect(withTail[0]).toBe(sheets.at(-1));
		for (const sheet of sheets.slice(1))
			expect(sheet.textContent, "column header").toContain(
				"Green · Yellow · Red",
			);
	});

	// protects=nothing paginates unless sheet 2 flowed AT COMPACT: an agenda that
	//   fits, and one that flows only at regular, keep two sheets, no continuation
	// fails_when=pagination triggers at regular, or without a flow, or leaves a
	//   continuation header / probe behind
	// no_claim=real agendas (print-compact.test.tsx for the ladder)
	it("two sheets, no continuation, no probe when the run fits", () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-fit-inner") ? 1000 : 0;
			},
		);
		const { container } = render(view());
		expect(sheetsOf(container)).toHaveLength(2);
		expect(container.querySelector("[data-continuation-header]")).toBeNull();
		expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
		expect(container.textContent).toContain("Page 2 of 2");
	});

	// protects=the measuring probes are unmounted once the answer is in: no second
	//   copy of the run (stamps, a footer) is left in the document
	// fails_when=the off-screen sheets stay mounted, doubling every stamp and
	//   footer in the page a person prints
	// no_claim=that they were mounted at all (the N test needs them)
	it("leaves no off-screen probe behind", () => {
		stubLayout();
		const { container } = render(view({ initialDensity: "compact" }));
		expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
		const stamps = container.querySelectorAll("[data-row-time]").length;
		const rows = printCompactAgenda(CONTEST).rows.filter(
			(r) => !r.handoff && !r.section,
		).length;
		expect(stamps).toBe(rows);
	});

	// protects=a new agenda (new `rows`) forgets the pagination and is measured
	//   again, rather than printing the previous agenda's sheet plan
	// fails_when=the plan outlives the rows it was made for
	// no_claim=that the new agenda needs pagination
	it("a new rows array is decided again", () => {
		stubLayout();
		const { container, rerender } = render(view({ initialDensity: "compact" }));
		expect(sheetsOf(container).length).toBeGreaterThan(2);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.hasAttribute("data-fit-inner") ? 1000 : 0;
			},
		);
		rerender(
			view({
				initialDensity: "compact",
				rows: [...printCompactAgenda("mcf").rows],
			}),
		);
		expect(sheetsOf(container)).toHaveLength(2);
		expect(container.querySelector("[data-continuation-header]")).toBeNull();
	});
});

describe("the (V) key on a paginated sheet (jsdom)", () => {
	/** The beat rows, as indices into `rows`, in stamp order. */
	const beatIndices = (rows: TimelineRow[]) =>
		rows.flatMap((r, i) => (r.handoff || r.section ? [] : [i]));

	// protects=each paginated sheet decides its own (V) key from the rows it shows:
	//   the sheet carrying a visiting Toastmaster prints it, the others do not
	// fails_when=the key is on every sheet, on none, or on a sheet that does not
	//   show the visitor (decided from the whole run, as before pagination)
	// no_claim=that the footer fits the key without growing (the probe measures it
	//   with the key on, and the Chrome test checks every sheet is still a page)
	it("only the sheet that shows a (V) prints the legend", () => {
		stubLayout();
		const base = printCompactAgenda(CONTEST).rows;
		const { container: plain } = render(view({ initialDensity: "compact" }));
		const stamped = sheetsOf(plain).map(
			(s) => [...s.querySelectorAll("[data-row-time]")].length,
		);
		cleanup();
		const beats = beatIndices(base);
		// One visitor in the first row of the LAST sheet.
		const lastStart = stamped.slice(0, -1).reduce((a, b) => a + b, 0);
		const visitor = beats[lastStart];
		const rows = base.map((r, i) =>
			i === visitor ? { ...r, visiting: true as const } : r,
		);
		const { container } = render(view({ initialDensity: "compact", rows }));
		const sheets = sheetsOf(container);
		sheets.forEach((s, i) => {
			expect(
				s
					.querySelector("[data-print-footer]")
					?.textContent?.includes(VISITING_TOASTMASTER_LEGEND),
				`sheet ${i + 1}`,
			).toBe(i === sheets.length - 1);
		});
	});
});

// ---------------------------------------------------------------------------
// Chrome: the real effects
// ---------------------------------------------------------------------------

const hasChrome = findChrome() !== null;

describe("print paginate harness availability", () => {
	// protects=a CI run cannot go green with the Chrome scenarios silently skipped
	// fails_when=CI is set and no browser is found (the suite below skips whole)
	// no_claim=that the browser found is the right version
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every pagination measurement would skip and the suite would still report green.",
		).toBe(true);
	});
});

const ENTRY = "src/test/print-paginate-entry.tsx";
const scenario = (
	id: string,
	kind: PaginateScenario["kind"],
	fixture: PaginateScenario["fixture"],
	more: Partial<PaginateScenario> = {},
): PaginateScenario => ({ id, kind, fixture, ...more });
const run = (scenarios: PaginateScenario[]) =>
	runClientEntry<Record<string, SheetsSnapshot | CopiesSnapshot>>(
		ENTRY,
		PRINT_PAGE_CSS,
		{ scenarios },
	);

const REPEATS = [1, 2, 3, 4];
let first: Record<string, SheetsSnapshot | CopiesSnapshot> = {};
let second: Record<string, SheetsSnapshot | CopiesSnapshot> = {};
const sheetsAt = (id: string) => first[id] as SheetsSnapshot;
const nat = (s: SheetsSnapshot) =>
	`sheets=${JSON.stringify(
		s.sheets.map((x) => ({
			h: x.height,
			scale: x.scale,
			rows: x.times.length,
			cont: x.continuation !== null,
		})),
	)}`;

/** Which repeat of the dense-20 contest makes an odd N, and which an even N,
 *  both at least 3 sheets, in THIS browser. */
function variants() {
	const n = (r: number) => sheetsAt(`rep${r}`).sheets.length;
	return {
		odd: REPEATS.find((r) => n(r) >= 3 && n(r) % 2 === 1),
		even: REPEATS.find((r) => n(r) >= 3 && n(r) % 2 === 0),
	};
}

describe.skipIf(!hasChrome)(
	"paginated Timing in Chrome, FitPage's real effect",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		beforeAll(async () => {
			first = await run([
				scenario("c16", "sheets", CONTEST),
				scenario("thr", "sheets", "thrLong"),
				scenario("mcf", "sheets", "mcf"),
				...REPEATS.map((r) =>
					scenario(`rep${r}`, "sheets", "contestDense20", { repeat: r }),
				),
			]);
			const { odd, even } = variants();
			const c16 = sheetsAt("c16");
			// A visitor on each sheet in turn, found from where the rows landed.
			const rows = printCompactAgenda(CONTEST).rows;
			const beats = rows.flatMap((r, i) => (r.handoff || r.section ? [] : [i]));
			let at = 0;
			const firstBeatOf = c16.sheets.map((s) => {
				const idx = beats[at];
				at += s.times.length;
				return idx;
			});
			second = await run([
				...(odd !== undefined
					? [
							scenario("copiesOdd", "copies", "contestDense20", {
								repeat: odd,
							}),
						]
					: []),
				...(even !== undefined
					? [
							scenario("copiesEven", "copies", "contestDense20", {
								repeat: even,
							}),
						]
					: []),
				...c16.sheets.map((s, i) =>
					s.times.length > 0
						? scenario(`visitor${i}`, "sheets", CONTEST, {
								visiting: [firstBeatOf[i]],
							})
						: scenario(`visitor${i}`, "sheets", CONTEST),
				),
			]);
		}, 180_000);

		// protects=a contest too long for two compact sheets prints N >= 3 sheets, each
		//   exactly one page tall (none flowed), each with its footer, sheets 3..N each
		//   with the continuation header naming its page of N, sheets 1 and 2 without
		// fails_when=the run still flows (a sheet taller than 1056), a sheet has no
		//   footer, a continuation header is missing or says the wrong page, or sheets
		//   1 and 2 grow one
		// no_claim=that Linux CI's face needs exactly this many sheets (the message
		//   carries this machine's numbers)
		it("a long contest: N >= 3 sheets, all a page tall, a footer on each, a header on 3..N", () => {
			const s = sheetsAt("c16");
			const n = s.sheets.length;
			expect(n, nat(s)).toBeGreaterThanOrEqual(3);
			s.sheets.forEach((sheet, i) => {
				expect(sheet.height, `sheet ${i + 1} ${nat(s)}`).toBe(PAGE_H);
				expect(sheet.footers, `sheet ${i + 1} ${nat(s)}`).toBe(1);
				expect(sheet.footerText, `sheet ${i + 1}`).toContain(
					`Page ${i + 1} of ${n}`,
				);
				if (i < 2)
					expect(sheet.continuation, `sheet ${i + 1} ${nat(s)}`).toBeNull();
				else {
					expect(sheet.continuation, `sheet ${i + 1} ${nat(s)}`).toContain(
						`Page ${i + 1} of ${n}`,
					);
					// The slim band the issue allows: 48px at most.
					expect(
						sheet.continuationHeight,
						`sheet ${i + 1} ${nat(s)}`,
					).toBeLessThanOrEqual(48);
				}
			});
		});

		// protects=every sheet prints at its declared sizes: no sheet needs a scale
		//   under MIN_FIT_SCALE, which is the whole point of paginating
		// fails_when=a sheet is scaled below the floor (or at all more than the
		//   rounding drift of a few px), so continuation sheets print smaller than Timing
		// no_claim=that the type is large enough (print-density.test.tsx)
		it("no sheet is scaled below MIN_FIT_SCALE, and all but a rounding drift print at 1", () => {
			const s = sheetsAt("c16");
			for (const [i, sheet] of s.sheets.entries()) {
				expect(sheet.scale, `sheet ${i + 1} ${nat(s)}`).toBeGreaterThanOrEqual(
					MIN_FIT_SCALE,
				);
				expect(sheet.scale, `sheet ${i + 1} ${nat(s)}`).toBeGreaterThanOrEqual(
					0.98,
				);
			}
		});

		// protects=a presenter's rows are never split across sheets, and no sheet ends
		//   on a section band
		// fails_when=a presenter group's stamps land on two sheets, or the last thing on
		//   a sheet is a section's title
		// no_claim=that the groups are the ones a person would draw (groupByPresenter's)
		it("no presenter group is split, and no sheet ends on a section band", () => {
			const s = sheetsAt("c16");
			const rows = printCompactAgenda(CONTEST).rows;
			const beats = rows.flatMap((r, i) => (r.handoff || r.section ? [] : [i]));
			const groupOfRow: number[] = [];
			groupByPresenter(rows).forEach((g, gi) => {
				for (const _ of g.rows) groupOfRow.push(gi);
			});
			// The DOM's stamps, sheet by sheet, are the beats in order.
			const sheetOfBeat: number[] = [];
			s.sheets.forEach((sheet, si) => {
				for (const _ of sheet.times) sheetOfBeat.push(si);
			});
			expect(sheetOfBeat.length, nat(s)).toBe(beats.length);
			expect(
				s.sheets.flatMap((x) => x.times),
				"stamps in row order",
			).toEqual(beats.map((i) => rows[i].time));
			const sheetOfGroup = new Map<number, number>();
			beats.forEach((rowIndex, b) => {
				const g = groupOfRow[rowIndex];
				const seen = sheetOfGroup.get(g);
				if (seen === undefined) sheetOfGroup.set(g, sheetOfBeat[b]);
				else
					expect(
						sheetOfBeat[b],
						`group ${g} (${rows[rowIndex].who}) split across sheets ${seen + 1} and ${sheetOfBeat[b] + 1} ${nat(s)}`,
					).toBe(seen);
			});
			const sections = new Set(
				rows.filter((r) => r.section).map((r) => norm(r.who)),
			);
			expect(sections.size, "the fixture has sections").toBeGreaterThan(0);
			for (const [i, sheet] of s.sheets.entries())
				if (sheet.lastText !== null)
					expect(
						sections.has(norm(sheet.lastText)),
						`sheet ${i + 1} ends on a section band: ${sheet.lastText}`,
					).toBe(false);
		});

		// protects=the announcements / notes print once, on the last sheet only
		// fails_when=they repeat, or are on a sheet before the last
		// no_claim=that they fit (the packer places them as a unit)
		it("the tail is on the last sheet only", () => {
			const s = sheetsAt("c16");
			expect(
				s.sheets.map((x) => x.tail),
				nat(s),
			).toEqual(s.sheets.map((_, i) => i === s.sheets.length - 1));
		});

		/** Every needle of every row (`who`, `detail`, `time`), in row order. */
		const needlesOf = (rows: TimelineRow[]) =>
			rows.flatMap((r, i) =>
				(["time", "who", "detail"] as const)
					.map((k) => ({ i, k, s: norm(r[k] ?? "") }))
					.filter((n) => n.s !== ""),
			);
		const occurrences = (hay: string, needle: string) => {
			const out: number[] = [];
			for (
				let at = hay.indexOf(needle);
				at !== -1;
				at = hay.indexOf(needle, at + 1)
			)
				out.push(at);
			return out;
		};

		// protects=pagination loses no text and duplicates none: for every row, in row
		//   order, each of its who, detail and time occurs on the sheets' run-of-show
		//   regions as often as on #1226's single compact sheet 2, in the same order
		// fails_when=a row, a hand-off or a detail is dropped, printed on two sheets, or
		//   moved across another row's text; or a section band repeats on a continuation
		// no_claim=that the strings are readable, or case (innerText follows
		//   text-transform, so both sides are lower-cased)
		it("the same strings, as often, in the same order as the single compact sheet", () => {
			const s = sheetsAt("c16");
			const { rows } = printCompactAgenda(CONTEST);
			const paginated = norm(s.sheets.map((x) => x.region ?? "").join(" "));
			const reference = norm(s.reference);
			expect(reference.length, "reference text is empty").toBeGreaterThan(500);
			expect(
				paginated.length,
				`paginated text is empty ${nat(s)}`,
			).toBeGreaterThan(500);
			const needles = needlesOf(rows);
			expect(needles.length).toBeGreaterThan(rows.length);
			for (const str of new Set(needles.map((n) => n.s)))
				expect(
					occurrences(paginated, str).length,
					`"${str}" paginated vs single sheet`,
				).toBe(occurrences(reference, str).length);
			const sequence = (hay: string) =>
				needles
					.flatMap((n) =>
						occurrences(hay, n.s).map((at) => ({
							at,
							label: `${n.i}:${n.k}`,
						})),
					)
					.sort((a, b) => a.at - b.at || a.label.localeCompare(b.label))
					.map((o) => o.label);
			expect(sequence(paginated)).toEqual(sequence(reference));
		});

		// protects=agendas that do not need it are untouched: THR's overflow fixture and
		//   the MCF agenda keep two sheets, no continuation header, "Page k of 2"
		// fails_when=pagination triggers for an agenda that fits Timing at compact, or
		//   sheets 1 and 2 gain a header or a different page number
		// no_claim=how those sheets are laid out (thr-timing-print-fit, print-compact)
		for (const id of ["thr", "mcf"] as const) {
			it(`${id}: two sheets, no continuation header, no page numbers beyond 2`, () => {
				const s = sheetsAt(id);
				expect(s.sheets, nat(s)).toHaveLength(2);
				s.sheets.forEach((sheet, i) => {
					expect(sheet.height, `${id} ${nat(s)}`).toBe(PAGE_H);
					expect(sheet.continuation, `${id} ${nat(s)}`).toBeNull();
					expect(sheet.footerText).toContain(`Page ${i + 1} of 2`);
				});
			});
		}

		// protects=the (V) key on a continuation sheet iff that sheet shows a (V), for a
		//   visitor on each sheet in turn
		// fails_when=the key is on a sheet without the visitor, or missing on the one
		//   with, or marking a visitor moves rows onto another sheet (the pagination
		//   measured the footer without the key)
		// no_claim=sheet 1 (the roster has no visitor here, so it never prints the key)
		it("the legend is on exactly the sheet that shows a (V)", () => {
			const c16 = sheetsAt("c16");
			c16.sheets.forEach((sheet, i) => {
				if (sheet.times.length === 0) return;
				const v = second[`visitor${i}`] as SheetsSnapshot;
				expect(
					v.sheets.map((x) => x.times.length),
					`visitor on sheet ${i + 1}: rows per sheet moved`,
				).toEqual(c16.sheets.map((x) => x.times.length));
				expect(
					v.sheets.map((x) => x.legend),
					`visitor on sheet ${i + 1}`,
				).toEqual(v.sheets.map((_, j) => j === i));
				for (const x of v.sheets) expect(x.height).toBe(PAGE_H);
			});
			// And with no visitor, none.
			expect(c16.sheets.map((x) => x.legend)).toEqual(
				c16.sheets.map(() => false),
			);
		});

		describe("copies and duplex", () => {
			// protects=with copies=2 and duplex, a blank goes after copy 1 exactly when a
			//   copy prints an ODD number of pages, N counted from the copy's own sheets,
			//   and the printed PDF has 2N + blanks pages
			// fails_when=the stack assumes the layout's nominal two sheets per copy (so
			//   an odd N gets no blank, or an even N gets one), or the DOM and the PDF
			//   disagree (#1181)
			// no_claim=what N is on another machine: it is measured here, and the
			//   variant of each parity is found at run time
			for (const parity of ["odd", "even"] as const) {
				it(`${parity} N: the blank follows the copy's own sheet count, and the PDF agrees`, () => {
					const repeat = variants()[parity];
					const sweep = REPEATS.map(
						(r) => `repeat ${r}: N=${sheetsAt(`rep${r}`).sheets.length}`,
					).join(", ");
					expect(
						repeat,
						`no repeat of the contest gives an ${parity} N >= 3 here (${sweep})`,
					).toBeDefined();
					const c = second[
						parity === "odd" ? "copiesOdd" : "copiesEven"
					] as CopiesSnapshot;
					const n = sheetsAt(`rep${repeat}`).sheets.length;
					const ctx = `${parity} N=${n} (${sweep}) heights=${c.heights.join(",")}`;
					expect(c.perCopy, ctx).toEqual([n, n]);
					expect(
						c.heights.every((h) => h === PAGE_H),
						ctx,
					).toBe(true);
					const blanks = parity === "odd" ? 1 : 0;
					expect(c.blanks, ctx).toBe(blanks);
					expect(printedPageCount(`<!doctype html>${c.html}`), ctx).toBe(
						2 * n + blanks,
					);
				});
			}
		});
	},
);
