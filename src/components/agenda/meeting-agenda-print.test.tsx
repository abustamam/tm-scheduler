// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import { expandRunSheet, OPEN_LABEL } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";
import { buildTimeline } from "#/lib/agenda-timing";
import {
	type AgendaHeader,
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";

afterEach(cleanup);

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

// One timed speaker beat (has green/yellow/red marks) + one plain beat (no marks).
const rows: TimelineRow[] = [
	{
		who: "Toastmaster",
		detail: "Opens the meeting",
		minutes: 5,
		marks: null,
		time: "7:00",
	},
	{
		who: "Speaker 1 · Jane Doe",
		detail: "Ice Breaker",
		minutes: 6,
		marks: { green: 4, yellow: 5, red: 6 },
		time: "7:10",
	},
];

function renderLayout(layout: AgendaLayout) {
	return render(
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

describe("MeetingAgendaPrint prints yellow, never amber (#507)", () => {
	// The rename shipped once already with the committed PDFs still printing
	// "Amber", because every test asserted DATA and none asserted the printed
	// words. These pin the words.
	it("labels the timing signal Yellow", () => {
		const { getByText, queryByText } = renderLayout("timing");
		expect(getByText("Yellow")).toBeTruthy();
		expect(queryByText(/Amber/)).toBeNull();
	});

	it("heads the marks column Green · Yellow · Red", () => {
		const { getByText } = renderLayout("timing");
		expect(getByText("Green · Yellow · Red")).toBeTruthy();
	});
});

describe("MeetingAgendaPrint — a flex segment's marks are per-response (#507)", () => {
	// The spacious layout renders marks as a muted `green–red` RANGE after the
	// name, and a range in that position reads as "this row lasts this long".
	// True for a speaker and an evaluator, whose marks describe their own
	// duration. FALSE for the squishy Table Topics segment: its marks are one
	// response (1:00–2:00) while the row is booked for the whole segment, so the
	// range labelled a 20-minute segment "1:00–2:00".
	const flexRows: TimelineRow[] = [
		{
			who: "Table Topics Master · Rasheed",
			detail: "Impromptu topics using the Word of the Day",
			minutes: 20,
			flex: true,
			marks: { green: 1, yellow: 1.5, red: 2 },
			time: "7:20",
		},
		{
			who: "Evaluator 1 · Sudheer",
			detail: "Evaluate Jane Doe",
			minutes: 3,
			marks: { green: 2, yellow: 2.5, red: 3 },
			time: "7:45",
		},
	];

	function renderSpacious() {
		return render(
			<MeetingAgendaPrint
				layout="spacious"
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={flexRows}
			/>,
		);
	}

	it("does not print the per-response window as the segment's duration", () => {
		const { queryByText } = renderSpacious();
		expect(queryByText(/1:00–2:00/)).toBeNull();
	});

	it("still prints the range for a NON-flex timed row", () => {
		// The evaluator's 2:00–3:00 IS that row's duration, so it stays.
		const { getByText } = renderSpacious();
		expect(getByText(/2:00–3:00/)).toBeTruthy();
	});
});

describe("MeetingAgendaPrint one-page timing", () => {
	for (const layout of ["grid", "editorial"] as const) {
		it(`shows the color-coded green/yellow/red trio on the ${layout} one-pager`, () => {
			renderLayout(layout);
			// green = 4:00, yellow = 5:00, red = 6:00 for the timed speaker beat.
			expect(screen.getByText("4:00")).toBeTruthy();
			expect(screen.getByText("5:00")).toBeTruthy();
			expect(screen.getByText("6:00")).toBeTruthy();
		});

		it(`shows the timing-signals legend on the ${layout} one-pager`, () => {
			renderLayout(layout);
			expect(screen.getByText("Min reached")).toBeTruthy();
			expect(screen.getByText("Approaching")).toBeTruthy();
			expect(screen.getByText("Wrap up")).toBeTruthy();
		});

		// #357 — the grace period, with this agenda's own numbers (4:00–6:00 ⇒
		// qualifies 3:30–6:30), not a hardcoded 5–7 example.
		it(`states the 30-second grace window on the ${layout} one-pager`, () => {
			renderLayout(layout);
			expect(
				screen.getByText(
					"±0:30 grace — e.g. a 4:00–6:00 speech qualifies 3:30–6:30",
				),
			).toBeTruthy();
		});

		it(`falls back to the bare grace rule on the ${layout} one-pager when nothing is timed`, () => {
			render(
				<MeetingAgendaPrint
					layout={layout}
					header={header}
					roles={[{ label: "Toastmaster", name: "Lee P." }]}
					officers={[]}
					explainers={[]}
					rows={rows.map((r) => ({ ...r, marks: null }))}
				/>,
			);
			expect(
				screen.getByText(
					"±0:30 grace — 0:30 before green through 0:30 after red",
				),
			).toBeTruthy();
		});
	}
});

// #357 — the two-page timing layout has room to spell the rule out in full.
describe("MeetingAgendaPrint timing-signals callout", () => {
	it("states the qualifying window in the Timing Signals callout", () => {
		renderLayout("timing");
		expect(
			screen.getByText(
				"A speech qualifies from 0:30 before green through 0:30 after red — a 4:00–6:00 speech qualifies between 3:30 and 6:30.",
			),
		).toBeTruthy();
	});

	it("still states the rule when no beat is timed", () => {
		render(
			<MeetingAgendaPrint
				layout="timing"
				header={header}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows.map((r) => ({ ...r, marks: null }))}
			/>,
		);
		expect(
			screen.getByText(
				"A speech qualifies from 0:30 before green through 0:30 after red.",
			),
		).toBeTruthy();
	});
});

describe("MeetingAgendaPrint announcements", () => {
	const withAnnouncements: AgendaHeader = {
		...header,
		announcements: "Bring a guest\n\nRenew your dues",
	};

	function renderWith(layout: AgendaLayout, h: AgendaHeader) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={h}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial"] as const) {
		it(`renders the announcements list on the ${layout} one-pager`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getAllByText("Announcements").length).toBeGreaterThan(0);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.getByText("Renew your dues")).toBeTruthy();
		});

		it(`renders no announcements on the ${layout} one-pager when empty`, () => {
			renderWith(layout, header);
			expect(screen.queryByText("Bring a guest")).toBeNull();
		});
	}

	// #358 — the club's own meeting number, on every layout.
	const withNumber: AgendaHeader = { ...header, meetingNumber: 56 };

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: prints the meeting number when the club has one`, () => {
			renderWith(layout, withNumber);
			expect(screen.getByText(/Meeting #56/)).toBeTruthy();
		});

		it(`${layout}: prints no meeting-number label when there is none`, () => {
			renderWith(layout, header);
			expect(screen.queryByText(/Meeting #/)).toBeNull();
		});
	}

	for (const layout of ["spacious", "timing"] as const) {
		it(`${layout}: announcements replace the ruled Meeting Notes lines when present`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.queryByText("Meeting Notes")).toBeNull();
			expect(screen.getByText(/Tonight.s Votes/)).toBeTruthy();
		});

		it(`${layout}: keeps the Meeting Notes lines when there are no announcements`, () => {
			renderWith(layout, header);
			expect(screen.getByText("Meeting Notes")).toBeTruthy();
			expect(screen.queryByText("Bring a guest")).toBeNull();
			expect(screen.getByText(/Tonight.s Votes/)).toBeTruthy();
		});
	}
});

// #363 — a hand-off books 0 minutes, so `buildTimeline` stamps it with the clock
// time of the row it introduces. Rendered as a full segment block it reads as a
// duplicate of that row, so every layout renders it as a compact band instead.
describe("MeetingAgendaPrint hand-off band", () => {
	// A real stretch of an MCF agenda: the opening pair of same-owner hand-offs
	// (a club with a General Evaluator but no functionaries — the case the old
	// `${time}-${who}` key collided on), then the Table Topics → General
	// Evaluator → evaluators chain, where three rows share one stamp.
	const handoffRows: TimelineRow[] = [
		{
			who: "Toastmaster · Lee P.",
			detail: "Opens meeting · introduces the theme",
			minutes: 3,
			marks: null,
			time: "7:03",
		},
		{
			who: "Toastmaster · Lee P.",
			detail: "Introduces the General Evaluator",
			minutes: 0,
			marks: null,
			handoff: true,
			time: "7:06",
		},
		{
			who: "Toastmaster · Lee P.",
			detail: "Introduces the speakers",
			minutes: 0,
			marks: null,
			handoff: true,
			time: "7:06",
		},
		{
			who: "Speaker 1 · Jane Doe",
			detail: "Prepared speech",
			minutes: 6,
			marks: { green: 4, yellow: 5, red: 6 },
			time: "7:06",
		},
		{
			who: "Table Topics Master · Rasheed",
			detail:
				"Calls for the Timer's report · opens voting for Best Table Topics",
			minutes: 1,
			marks: null,
			time: "7:20",
		},
		{
			who: "Table Topics Master · Rasheed",
			detail: "Introduces the General Evaluator",
			minutes: 0,
			marks: null,
			handoff: true,
			time: "7:21",
		},
		{
			who: "General Evaluator · Riyaz",
			detail: "Introduces the speech evaluators",
			minutes: 0,
			marks: null,
			handoff: true,
			time: "7:21",
		},
		{
			who: "Evaluator 1 · Sudheer",
			detail: "Evaluates Jagpal Singh",
			minutes: 3,
			marks: null,
			time: "7:21",
		},
	];

	/** The stamps the four timed beats own; the four hand-offs print none. */
	const TIMED_STAMPS = ["7:03", "7:06", "7:20", "7:21"];

	/** The band a `detail` was rendered into. `who`, the separator and `detail`
	 *  are three sibling nodes (see `HandoffBand`), so the whole line is the
	 *  PARENT's text — and reading it there is what proves the three nodes
	 *  compose into one readable sentence. */
	const bandOf = (detailNode: HTMLElement) =>
		detailNode.parentElement as HTMLElement;
	const bandFor = (detail: string) => bandOf(screen.getByText(detail));

	function renderHandoffs(layout: AgendaLayout) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={handoffRows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: prints every hand-off, holder and cue on one line`, () => {
			renderHandoffs(layout);
			// Both hand-offs into the General Evaluator, in page order — the pair the
			// old `${time}-${who}` key could not tell apart.
			expect(
				screen
					.getAllByText("Introduces the General Evaluator")
					.map((el) => bandOf(el).textContent),
			).toEqual([
				"Toastmaster · Lee P. · Introduces the General Evaluator",
				"Table Topics Master · Rasheed · Introduces the General Evaluator",
			]);
			expect(bandFor("Introduces the speakers").textContent).toBe(
				"Toastmaster · Lee P. · Introduces the speakers",
			);
			expect(bandFor("Introduces the speech evaluators").textContent).toBe(
				"General Evaluator · Riyaz · Introduces the speech evaluators",
			);
		});

		it(`${layout}: repeats no clock stamp on a hand-off`, () => {
			const { container } = renderHandoffs(layout);
			const stamps = Array.from(
				container.querySelectorAll("[data-row-time]"),
			).map((el) => el.textContent);
			expect(stamps).toEqual(TIMED_STAMPS);
		});

		it(`${layout}: keys the run-of-show rows uniquely`, () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				renderHandoffs(layout);
				const dupes = spy.mock.calls.filter((call) =>
					call.some((arg) => String(arg).includes("same key")),
				);
				expect(dupes).toEqual([]);
			} finally {
				spy.mockRestore();
			}
		});
	}

	// Review fix (#363): the tests above are layout-agnostic — every one would
	// still pass if all four call sites pasted identical styling. This pins the
	// one requirement that had zero coverage: the band must respect each
	// layout's own visual language (type scale + gutter) rather than one style
	// copied three times. Values read off the component's own call sites, not
	// asserted from spec.
	const BAND_STYLE: Record<
		AgendaLayout,
		{ paddingLeft: string; fontSize: string }
	> = {
		editorial: { paddingLeft: "69px", fontSize: "10px" }, // RunNarrative sm
		spacious: { paddingLeft: "83px", fontSize: "11.5px" }, // RunNarrative lg
		grid: { paddingLeft: "68px", fontSize: "10px" },
		timing: { paddingLeft: "58px", fontSize: "10px" },
	};

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: the hand-off band uses this layout's own paddingLeft/fontSize`, () => {
			renderHandoffs(layout);
			const band = bandFor("Introduces the speakers");
			expect(band.style.paddingLeft).toBe(BAND_STYLE[layout].paddingLeft);
			expect(band.style.fontSize).toBe(BAND_STYLE[layout].fontSize);
		});
	}

	/**
	 * A GROUP hand-off names its members on the two-page layouts and NOT on the
	 * one-page ones (#578).
	 *
	 * The asymmetry IS the feature, so both halves are asserted. A club reported
	 * having to flip pages to see who they were introducing, which happens only
	 * when the group's rows land on the next sheet. #585 measured the names
	 * costing 5% of every word's printed size on the one-page layouts, where the
	 * group's rows are the very next thing anyway — so those keep ignoring the
	 * field, and a change that "helpfully" turned them on would silently shrink
	 * every agenda in the app.
	 *
	 * `textContent` rather than `getByText`, because the names and the detail are
	 * deliberately one text node: they are one sentence, and they have to wrap
	 * together rather than as independent flex items.
	 *
	 * The separator is `NAMES_SEPARATOR` (": "), shared with the singular
	 * hand-offs' `{names:…}` token so both read identically on the page. Two
	 * docstrings in `agenda-runsheet.ts` advertised an em dash here until #578 —
	 * they were stale, and asserting the rendered string rather than a
	 * reconstruction is what surfaced it.
	 */
	const namedRows: TimelineRow[] = [
		{
			who: "Toastmaster · Lee P.",
			detail: "Introduces the speakers",
			introduces: ["Jagpal", "Rehanna", "Faisal"],
			minutes: 0,
			marks: null,
			handoff: true,
			time: "6:53",
		},
		{
			who: "Speaker 1 · Jagpal",
			roleKey: "speaker",
			detail: "Prepared speech",
			minutes: 7,
			marks: null,
			time: "6:53",
		},
	];

	function renderNamed(layout: AgendaLayout) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={namedRows}
			/>,
		);
	}

	for (const layout of ["spacious", "timing"] as const) {
		it(`${layout} (two pages): names the group, because its rows can be overleaf`, () => {
			const { container } = renderNamed(layout);
			const text = container.textContent ?? "";
			expect(text).toContain(
				"Introduces the speakers: Jagpal, Rehanna & Faisal",
			);
		});
	}

	for (const layout of ["editorial", "grid"] as const) {
		it(`${layout} (one page): does NOT name the group — #585's measurement stands`, () => {
			const { container } = renderNamed(layout);
			const text = container.textContent ?? "";
			expect(text).toContain("Introduces the speakers");
			// The separator, not the names: "Jagpal" also appears in the speaker row
			// one line down, which is the entire reason #585 left it out.
			expect(text).not.toContain("Introduces the speakers:");
		});
	}

	it("prints no dangling separator when the group is unassigned", () => {
		// `expandRunSheet` omits `introduces` entirely for an unheld group rather
		// than carrying `[]`, and `introducedSuffix([])` is "" either way — so this
		// holds for both shapes.
		const { container } = render(
			<MeetingAgendaPrint
				layout="spacious"
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={[{ ...namedRows[0], introduces: [] }, namedRows[1]]}
			/>,
		);
		expect(container.textContent).not.toContain("speakers:");
	});

	// The other half of the same requirement. `BAND_STYLE` above pins the type
	// scale and gutter each call site passes; `chrome` — the zebra stripe and the
	// hairline rule — is the half that had none, and it is the whole reason the
	// prop exists. The two table layouts hand the band the row chrome so it reads
	// as a quiet row of the table; the two narrative layouts pass none, so the
	// band has no spine and no rule and runs straight into the beat it
	// introduces. Drop `chrome` from a grid call site and the band punches a
	// white, ruleless hole through a striped table with nothing failing.
	const BANDS_IN_THE_TABLE: Record<AgendaLayout, boolean> = {
		grid: true,
		timing: true,
		editorial: false,
		spacious: false,
	};

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: the hand-off band ${
			BANDS_IN_THE_TABLE[layout] ? "keeps" : "drops"
		} the row stripe and rule`, () => {
			renderHandoffs(layout);
			// Rows 1 and 2 of the fixture: adjacent hand-offs, so one lands on each
			// side of the zebra.
			const odd = bandOf(
				screen.getAllByText("Introduces the General Evaluator")[0],
			);
			const even = bandFor("Introduces the speakers");

			if (BANDS_IN_THE_TABLE[layout]) {
				expect(odd.style.background).not.toBe("");
				expect(even.style.background).not.toBe("");
				// Striped WITH the table rather than painted one flat colour.
				expect(odd.style.background).not.toBe(even.style.background);
				expect(odd.style.borderBottom).not.toBe("");
			} else {
				expect(odd.style.background).toBe("");
				expect(even.style.background).toBe("");
				expect(odd.style.borderBottom).toBe("");
			}
			// Either way the band keeps the semantics `HandoffBand` owns — `chrome`
			// spreads first precisely so a call site cannot reach them.
			expect(odd.style.fontStyle).toBe("italic");
			expect(odd.style.display).toBe("flex");
		});
	}

	it("renders the elbow affordance as a decorative, screen-reader-hidden cue", () => {
		renderHandoffs("editorial");
		// It is a bordered box, not a glyph (see `HandoffBand`): "↳" is outside
		// Manrope's served unicode-range, so it always fell back to another face
		// and the band's italic synthesised an oblique on it. Asserting the
		// borders is what would catch a revert to a text glyph.
		const affordance = bandFor("Introduces the speakers")
			.firstElementChild as HTMLElement;
		expect(affordance.getAttribute("aria-hidden")).toBe("true");
		expect(affordance.textContent).toBe("");
		// The mark is the wrapper's inline-block child: the wrapper carries the
		// band's type so the browser can sit the mark on the real text baseline
		// (`verticalAlign: "baseline"`), instead of a hand-computed offset that was
		// wrong at both of the sizes it claimed to cover.
		const mark = affordance.firstElementChild as HTMLElement;
		expect(mark.style.display).toBe("inline-block");
		expect(mark.style.verticalAlign).toBe("baseline");
		expect(mark.style.borderLeftStyle).toBe("solid");
		expect(mark.style.borderBottomStyle).toBe("solid");
	});

	// The regression the em-dash separator shipped with: `who` carries the run
	// sheet's own punctuation, and for an enabled-but-unclaimed role that is
	// `OPEN_LABEL` — em dashes. Joined with an em dash the band printed
	// "Toastmaster of the Day · — open — — Introduces the speakers". Three nodes
	// with the separator in its own node is why no character choice can collide.
	it("prints an unclaimed hand-off holder without doubling the separator", () => {
		render(
			<MeetingAgendaPrint
				layout="editorial"
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={[
					{
						who: `Toastmaster of the Day · ${OPEN_LABEL}`,
						detail: "Introduces the speakers",
						minutes: 0,
						marks: null,
						handoff: true,
						time: "7:06",
					},
				]}
			/>,
		);
		const band = bandFor("Introduces the speakers");
		// Spelled out rather than built from `OPEN_LABEL`: the literal IS the
		// hazard, so a future change to the placeholder should land here.
		expect(band.textContent).toBe(
			"Toastmaster of the Day · — open — · Introduces the speakers",
		);
		expect(band.textContent).not.toContain("— —");
	});
});

// #445. `who` used to be OUR canonical role name on every row, and the spine
// colour was picked by matching English substrings of it ("speaker" -> teal).
// Once the label follows a club rename, that match silently stops firing and the
// club loses the colour coding — a regression invisible to every test here,
// because they all use canonical names. The row carries `roleKey` now and the
// colour reads that; this pins it on a club that renamed the role.
describe("spine colour follows the ROLE, not its name (#445)", () => {
	const speechRow = (over: Partial<TimelineRow>): TimelineRow => ({
		who: "Speaker · Jagpal",
		roleKey: "speaker",
		detail: "Prepared speech",
		minutes: 6,
		marks: null,
		time: "7:10",
		...over,
	});

	// Selected through `data-row-time`, the layout's own test hook: it is the exact
	// element carrying `borderLeft: 4px solid ${beatColor(r)}`. A looser
	// `[style*="border-left"]` matched chrome elsewhere on the sheet and returned
	// the same colour for both clubs, so the test passed with the fix disabled.
	const spineOf = (row: TimelineRow): string => {
		const { container } = render(
			<MeetingAgendaPrint
				layout="grid"
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={[row]}
			/>,
		);
		const spine = container.querySelector<HTMLElement>("[data-row-time]");
		if (spine == null) throw new Error("no spine element rendered");
		return spine.style.borderLeftColor;
	};

	// Every key `expandRunSheet` actually emits, each paired with the name the old
	// match keyed off. Only `speaker` was pinned at first, which left a typo in any
	// of the other four able to re-ship #445's exact regression: silent grey for a
	// renamed club, green suite for a canonical one.
	it.each([
		["toastmaster_of_the_day", "Toastmaster of the Day · Faisal"],
		["table_topics_master", "Table Topics Master · Rasheed"],
		["general_evaluator", "General Evaluator · Riyaz"],
		["evaluator", "Evaluator 1 · Sudheer"],
		["speaker", "Speaker 1 · Jagpal"],
	])("colours %s from the key, not the name", (roleKey, canonicalWho) => {
		const canonical = spineOf(speechRow({ roleKey, who: canonicalWho }));
		const renamed = spineOf(speechRow({ roleKey, who: "Renamed · Somebody" }));
		expect(renamed).toBe(canonical);
		expect(renamed).not.toBe("");
	});

	// The pair-agreement above proves the colour is KEYED, and nothing more: both
	// sides read the same `ROLE_KEY_COLOR` entry, so they agree for any value it
	// holds. Collapsing every entry to MUTED leaves it green — the exact trap
	// CLAUDE.md records, that an agreement test cannot see a defect present on both
	// sides. Distinctness is the half that pins the mapping, and it still hardcodes
	// no hex, since `print-theme.tsx` owns those.
	it("gives the segment roles visibly different spines", () => {
		const colourOf = (roleKey: string) =>
			spineOf(speechRow({ roleKey, who: "Renamed · Somebody" }));
		expect(
			new Set([
				colourOf("speaker"),
				colourOf("table_topics_master"),
				colourOf("evaluator"),
				colourOf("toastmaster_of_the_day"),
			]).size,
		).toBe(4);
		// The one pair that shares a colour on purpose: the Toastmaster covers the
		// General Evaluator's role at a club that runs none (#363), so the two read
		// as one voice down the page.
		expect(colourOf("toastmaster_of_the_day")).toBe(
			colourOf("general_evaluator"),
		);
	});

	// The seeded Speech Contest template (#agenda-templates) added ten keys to
	// `ROLE_KEY_COLOR`. `beatColor` falls back to MUTED for any unmapped key, so
	// deleting all ten leaves every assertion in this file green while the
	// contest sheet prints one undifferentiated grey spine — the same #445 shape
	// the block above exists to catch, one template later. Assert DISTINCTNESS,
	// not pair-agreement: an agreement test reads the same map entry twice and
	// cannot see a defect present on both sides.
	it("gives the seeded contest roles the same spine vocabulary as a standard meeting", () => {
		const colourOf = (roleKey: string) =>
			spineOf(speechRow({ roleKey, who: "Renamed · Somebody" }));
		const muted = colourOf("a_key_no_template_declares");

		// The contestant IS the speaking slot, so it reads as `speaker` does.
		expect(colourOf("contestant_prepared")).toBe(colourOf("speaker"));
		// The three the three-contest template declared are gone, and an
		// unmapped key must fall to muted rather than borrowing a neighbour's
		// colour — the map is authoritative once a key is present.
		for (const key of [
			"contestant_impromptu",
			"contestant_evaluation",
			"test_speaker",
		]) {
			expect(colourOf(key), key).toBe(muted);
		}
		// Chair and Chief Judge run the contest — the leadership voice.
		for (const key of ["contest_chair", "chief_judge"]) {
			expect(colourOf(key), key).toBe(colourOf("toastmaster_of_the_day"));
		}
		// Judges evaluate.
		expect(colourOf("judge")).toBe(colourOf("evaluator"));
		// Functionaries stay muted — deliberately the fallback colour, so this
		// arm alone would pass with the entries deleted. The distinctness
		// assertion below is what makes the whole set load-bearing.
		for (const key of ["ballot_counter", "contest_timer", "sergeant_at_arms"]) {
			expect(colourOf(key), key).toBe(muted);
		}
		// Three visibly different voices down a contest sheet, not one.
		expect(
			new Set([
				colourOf("contestant_prepared"),
				colourOf("contest_chair"),
				colourOf("judge"),
				colourOf("ballot_counter"),
			]).size,
		).toBe(4);
	});

	it("highlights a speech row by its key, not its name", () => {
		// Every row gets a background (mint when highlighted, else the zebra
		// stripe), so "has one" proves nothing — compare rows against each other.
		const bgOf = (row: TimelineRow): string => {
			const { container } = render(
				<MeetingAgendaPrint
					layout="grid"
					header={header}
					roles={[]}
					officers={[]}
					explainers={[]}
					rows={[row]}
				/>,
			);
			const spine = container.querySelector<HTMLElement>("[data-row-time]");
			// The highlight sits on the row wrapper, the spine's parent.
			return (spine?.parentElement as HTMLElement).style.backgroundColor;
		};
		const speakerCanonical = bgOf(speechRow({ who: "Speaker 1 · Jagpal" }));
		const speakerRenamed = bgOf(speechRow({ who: "Presenter 1 · Jagpal" }));
		const notASpeaker = bgOf(
			speechRow({
				who: "Table Topics Master · Rasheed",
				roleKey: "table_topics_master",
			}),
		);
		// The rename must not change it, and a non-speaker must not get it.
		expect(speakerRenamed).toBe(speakerCanonical);
		expect(speakerRenamed).not.toBe(notASpeaker);
	});

	// Event beats own no role, so their rows carry no key and the name match is the
	// only thing left to colour them. Asserted as President vs Sergeant-at-Arms
	// rather than "is non-empty": MUTED is BOTH the sergeant branch's colour and
	// the function's default, so a non-empty check on the sergeant alone stays
	// green with the entire fallback deleted. President returns INK, so the pair
	// differing is the one thing that proves the fallback still runs.
	it("still colours event rows, which carry no roleKey", () => {
		const eventRow = (who: string) =>
			spineOf(speechRow({ who, roleKey: undefined, detail: "Call to Order" }));
		expect(eventRow("President")).not.toBe(eventRow("Sergeant-at-Arms"));
	});
});

// #495 — the club's own uploaded logo, left of the club name on all four
// print header sites (never on TimingLayout's running footer — that one
// stays text-only on purpose).
describe("MeetingAgendaPrint club logo", () => {
	const LOGO_URL = "/api/club/abc-123/logo?v=1690000000000";

	function renderWithLogo(layout: AgendaLayout, logoUrl: string | null) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={{ ...header, logoUrl }}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: renders the club's own logo, immediately left of the club name, in a vertically-centered row`, () => {
			const { container } = renderWithLogo(layout, LOGO_URL);
			// Identified by ITS OWN url, not just "an img exists" — a stale/wrong
			// logoUrl plumbed through would still satisfy a bare presence check.
			const img = container.querySelector("img");
			expect(img).not.toBeNull();
			expect(img?.getAttribute("src")).toBe(LOGO_URL);
			// Decorative — never names a mark in text a screen reader announces.
			expect(img?.getAttribute("alt")).toBe("");
			// The image sits inside the light plate `ClubLogo` renders behind it
			// (invisible on these white pages, load-bearing on the dark surfaces).
			const plate = img?.parentElement as HTMLElement;
			// jsdom normalizes #fff to its rgb() form.
			expect(plate.style.background).toBe("rgb(255, 255, 255)");
			// "Left of the club name, vertically centered": the plate's own flex
			// row centers its children, and the club-name block is the very next
			// sibling — not merely present somewhere on the page.
			const row = plate.parentElement as HTMLElement;
			expect(row.style.alignItems).toBe("center");
			expect(plate.nextElementSibling?.textContent).toContain(header.clubName);
		});

		it(`${layout}: renders no image and no gap when the club has no logo`, () => {
			const { container } = renderWithLogo(layout, null);
			expect(container.querySelector("img")).toBeNull();
			// Club name still renders exactly where it always has — no leftover
			// spacer from a null-rendering ClubLogo. `getAllByText`, not
			// `getByText`: TimingLayout's page-2 running footer also names the
			// club (deliberately, per #495 — that site keeps no logo), so a
			// single-match query is unsound on that one layout.
			expect(screen.getAllByText(header.clubName).length).toBeGreaterThan(0);
		});
	}

	// TimingLayout's running footer (page 2) names the club again — pinned as
	// the ONE header-adjacent site that must NOT gain a logo (an image there
	// fights the running-footer layout; deliberate, not an oversight).
	it("timing: the page-2 running footer keeps no image even when the club has a logo", () => {
		const { container } = renderWithLogo("timing", LOGO_URL);
		// Exactly one image on the whole two-page sheet — the page-1 header's.
		expect(container.querySelectorAll("img").length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// #508 — the three meeting-script cues must reach the PAGE, on every layout.
//
// Built from the real pipeline (`expandRunSheet` → `buildTimeline`) rather than
// hand-written fixtures, deliberately: a fixture that hardcodes the cue text
// proves only that the renderer can print a string it was handed, and would keep
// passing if `buildRunOfShow` stopped emitting the cue entirely. This is the
// assertion class #507 shipped without — every test checked DATA, none checked
// the printed words, and five PDFs went out saying "Amber".
// ---------------------------------------------------------------------------
describe("MeetingAgendaPrint — the meeting-script cues reach the page (#508)", () => {
	const club: AgendaSlot[] = [
		{
			id: "tm",
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			category: "leadership",
			assigneeName: "Faisal",
		},
		{
			id: "ttm",
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			category: "leadership",
			assigneeName: "Rasheed",
		},
		{
			id: "sp",
			roleKey: "speaker",
			roleName: "Speaker",
			category: "speaker",
			assigneeName: "Jagpal",
			isSpeakerRole: true,
		},
		{
			id: "ev",
			roleKey: "evaluator",
			roleName: "Evaluator",
			category: "evaluator",
			assigneeName: "Sudheer",
		},
		{
			id: "ge",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
			category: "leadership",
			assigneeName: "Riyaz",
		},
		{
			id: "ti",
			roleKey: "timer",
			roleName: "Timer",
			category: "functionary",
			assigneeName: "Muhammad",
		},
		{
			id: "gr",
			roleKey: "grammarian",
			roleName: "Grammarian",
			category: "functionary",
			assigneeName: "Gina",
		},
	].map((s) => ({
		isSpeakerRole: false,
		slotIndex: 0,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
		...s,
	})) as AgendaSlot[];

	const realRows = buildTimeline(
		expandRunSheet(club),
		new Date("2026-08-08T19:00:00Z"),
		"UTC",
	);

	const CUES = [
		"the Grammarian gives the Word of the Day",
		"asks the Timer to explain the timing",
		"Asks the Timer to explain the timing for an evaluation",
	];

	// Every layout, because the four render rows through different components and
	// a cue that reaches one is not evidence it reaches the rest.
	for (const layout of ["grid", "spacious", "timing", "editorial"] as const) {
		it(`prints all three cues on the ${layout} layout`, () => {
			const { container } = render(
				<MeetingAgendaPrint
					layout={layout as AgendaLayout}
					header={header}
					roles={[]}
					officers={[]}
					explainers={[]}
					rows={realRows}
				/>,
			);
			const text = container.textContent ?? "";
			for (const cue of CUES) expect(text).toContain(cue);
		});
	}
});

// #510 review finding 1. The printed footer QR is the ballot's entry point for
// a club that prints instead of projecting, and a reviewer proved it had NO
// regression net: disabling `DarkFooter`'s `ballotUrl` branch left the whole
// suite green. These assertions close that gap on the DOM side — the real-PDF
// page-count gate in `print-page-count.test.tsx` covers the printed-page shape
// separately and does not itself look for the `<svg>`.
describe("MeetingAgendaPrint — the scan-to-vote QR (#510)", () => {
	const BALLOT_URL = "https://gavelup.test/club/mcf/meeting/2026-06-25/vote";

	// All four, not just the three that route through `DarkFooter`: `GridLayout`
	// carries its own smaller copy in its hand-rolled officer footer (see that
	// component's file-header note on why it can't share `DarkFooter`), and a
	// per-layout loop is the only way a broken wire on ONE layout can't hide
	// behind the other three passing.
	for (const layout of ["editorial", "grid", "spacious", "timing"] as const) {
		it(`renders a real QR svg in .footer-qr on the ${layout} layout`, () => {
			const { container } = render(
				<MeetingAgendaPrint
					layout={layout}
					header={header}
					roles={[{ label: "Toastmaster", name: "Lee P." }]}
					officers={[{ office: "President", name: "Pat Lee" }]}
					explainers={[]}
					rows={rows}
					ballotUrl={BALLOT_URL}
				/>,
			);
			const qr = container.querySelector(".footer-qr");
			expect(qr).not.toBeNull();
			expect(qr?.querySelector("svg")).not.toBeNull();
			expect(qr?.textContent?.toLowerCase()).toContain("scan to");
		});

		it(`renders no QR at all on the ${layout} layout when ballotUrl is undefined`, () => {
			// The pre-origin-effect gap (#510): the print route's client-side
			// effect hasn't computed an absolute URL yet on the very first render.
			const { container } = render(
				<MeetingAgendaPrint
					layout={layout}
					header={header}
					roles={[{ label: "Toastmaster", name: "Lee P." }]}
					officers={[{ office: "President", name: "Pat Lee" }]}
					explainers={[]}
					rows={rows}
				/>,
			);
			expect(container.querySelector(".footer-qr")).toBeNull();
		});
	}
});

// ---------------------------------------------------------------------------
// Adjacent beats with the same presenter print as ONE block on the narrative
// layouts. Both halves are asserted everywhere below — the name appears once
// AND every clock stamp survives — because either alone is a test that cannot
// fail the way this change can break. Counting names passes on a renderer that
// dropped the extra beats entirely; counting stamps passes on the old renderer
// that never merged anything.
// ---------------------------------------------------------------------------
describe("MeetingAgendaPrint consolidates adjacent same-presenter beats", () => {
	/** The real MCF agenda's tail: a four-beat General Evaluator run, a hand-off,
	 *  then the three-beat President close (#442/#352). */
	const consecutiveRows: TimelineRow[] = [
		{
			who: "General Evaluator · Faisal",
			roleKey: "general_evaluator",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
			minutes: 1,
			marks: null,
			time: "7:34",
		},
		{
			who: "General Evaluator · Faisal",
			roleKey: "general_evaluator",
			detail: "Evaluates the evaluators",
			minutes: 2,
			marks: { green: 2, yellow: 3, red: 4 },
			time: "7:35",
		},
		{
			who: "General Evaluator · Faisal",
			roleKey: "general_evaluator",
			detail: "Calls for the Timer, Grammarian & Ah-Counter to report",
			minutes: 3,
			marks: null,
			time: "7:37",
		},
		{
			who: "General Evaluator · Faisal",
			roleKey: "general_evaluator",
			detail: "Overall meeting evaluation · returns control",
			minutes: 2,
			marks: null,
			time: "7:40",
		},
		{
			who: "Toastmaster of the Day · Ali",
			roleKey: "toastmaster_of_the_day",
			detail: "Awards · hands over to the President",
			minutes: 2,
			marks: null,
			time: "7:42",
		},
		{
			who: "President",
			detail: "Club business · announcements",
			minutes: 2,
			marks: null,
			time: "7:44",
		},
		{
			who: "President",
			detail: "Guest Comments · invites our guests to share their thoughts",
			minutes: 2,
			marks: null,
			time: "7:46",
		},
		{
			who: "President",
			detail: "Adjourns",
			minutes: 1,
			marks: null,
			time: "7:48",
		},
	];

	/** Every stamp in the fixture — none is a hand-off, so all eight must print
	 *  however the beats are grouped. */
	const ALL_STAMPS = [
		"7:34",
		"7:35",
		"7:37",
		"7:40",
		"7:42",
		"7:44",
		"7:46",
		"7:48",
	];

	function renderConsecutive(layout: AgendaLayout, rows = consecutiveRows) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				// Deliberately NOT the presenters under test: the roster and the
				// officer rail print names too, and a count of "President" on the page
				// would otherwise be measuring those.
				roles={[{ label: "Timer", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows}
			/>,
		);
	}

	const stampsIn = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("[data-row-time]")).map(
			(el) => el.textContent,
		);

	/** What prints immediately beside each clock stamp, in page order.
	 *
	 *  Read through `data-row-time` rather than by searching the page for a name,
	 *  because the roster, the officer rail and a hand-off band all print names
	 *  too — a raw text count measures those as readily as the run of show, which
	 *  is how the first version of this suite passed for the wrong reason. Every
	 *  layout puts SOMETHING beside its stamp, so one helper reads all four. */
	const besideStampsIn = (container: HTMLElement) =>
		Array.from(container.querySelectorAll("[data-row-time]")).map(
			(el) => el.nextElementSibling?.textContent,
		);

	/** How many times each presenter's name is printed beside a stamp.
	 *
	 *  This single table IS the change: the two narrative layouts collapse a run
	 *  to one name, and grid/timing — which already put the name and the detail on
	 *  one line, so merging would save no height — must keep printing it per beat.
	 *  Expressing both as the same assertion is deliberate; a separate "grid is
	 *  untouched" test written some other way would not fail if consolidation
	 *  leaked into it in some shape this one does not describe. */
	const NAMES_BESIDE_STAMPS = {
		editorial: { president: 1, generalEvaluator: 1 },
		spacious: { president: 1, generalEvaluator: 1 },
		grid: { president: 3, generalEvaluator: 4 },
		timing: { president: 3, generalEvaluator: 4 },
	} as const;

	for (const layout of ["editorial", "spacious", "grid", "timing"] as const) {
		it(`${layout}: prints a repeated presenter's name ${NAMES_BESIDE_STAMPS[layout].president}× across 3 President beats`, () => {
			const { container } = renderConsecutive(layout);
			const beside = besideStampsIn(container);
			const starting = (name: string) =>
				beside.filter((t) => t?.startsWith(name)).length;
			expect({
				president: starting("President"),
				generalEvaluator: starting("General Evaluator · Faisal"),
			}).toEqual(NAMES_BESIDE_STAMPS[layout]);
		});

		it(`${layout}: keeps every beat's stamp, merged or not`, () => {
			// The other half. Counting names alone passes on a renderer that dropped
			// the extra beats outright, which is the failure this change could
			// plausibly have: eight beats in, eight stamps out, on every layout.
			const { container } = renderConsecutive(layout);
			expect(stampsIn(container)).toEqual(ALL_STAMPS);
		});

		it(`${layout}: keeps every beat's own detail line`, () => {
			renderConsecutive(layout);
			// The merge drops the repeated NAME, never a beat. Each of the three
			// President beats stays separately readable and separately timed.
			for (const detail of [
				"Club business · announcements",
				"Guest Comments · invites our guests to share their thoughts",
				"Adjourns",
			]) {
				expect(screen.getByText(detail)).toBeTruthy();
			}
		});
	}

	for (const layout of ["editorial", "spacious"] as const) {
		it(`${layout}: a hand-off between two beats of one presenter breaks the block`, () => {
			// The rule that makes the merge safe to read: an introduction is a real
			// event, so the beats either side of one must not print as a single
			// uninterrupted turn. Both names appear beside their own stamp again.
			const { container } = renderConsecutive(layout, [
				consecutiveRows[5],
				{
					who: "President",
					detail: "Introduces the Toastmaster",
					minutes: 0,
					marks: null,
					handoff: true,
					time: "7:46",
				},
				consecutiveRows[6],
			]);
			expect(besideStampsIn(container)).toEqual(["President", "President"]);
			expect(stampsIn(container)).toEqual(["7:44", "7:46"]);
		});
	}

	it("editorial: moves a merged beat's timing trio onto that beat's own line", () => {
		// The trio belongs to ONE beat. In a merged block it can no longer sit
		// beside the name, so it moves to the beat's line — and this pins that it
		// moved rather than got dropped, or worse, got attached to the beat that
		// opens the block and mislabelled a different segment's timing.
		const { container } = renderConsecutive("editorial");
		const beside = besideStampsIn(container);
		expect(beside[1]).toContain("Evaluates the evaluators");
		expect(beside[1]).toContain("2:00");
		expect(beside[1]).toContain("4:00");
		// …and the 7:34 beat that opens the block carries no trio of its own.
		expect(beside[0]).toBe("General Evaluator · Faisal");
	});
});

/**
 * Section bands — a TEMPLATED agenda's segment headers (#agenda-templates).
 *
 * The failure this guards is silent and layout-specific: a section row that
 * falls through to a layout's ordinary row renderer prints as a normal beat
 * WITH a clock stamp, and `TimingLayout` additionally splits `who` on " \u00b7 " to
 * fill its 150px Role column. Both read as "someone presents this segment
 * header". Every layout therefore needs its own arm, and every layout is
 * asserted here — the plan originally patched only the narrative pair.
 */
describe("section bands", () => {
	const sectionRows: TimelineRow[] = [
		{
			who: "OPENING",
			roleKey: null,
			section: true,
			detail: "",
			minutes: 0,
			marks: null,
			time: "8:00",
		},
		{
			who: "Call to order \u00b7 Ada Lovelace",
			roleKey: "sergeant_at_arms",
			detail: "Opens the room",
			minutes: 5,
			marks: null,
			time: "8:00",
		},
		{
			who: "PREPARED SPEECH CONTEST",
			roleKey: null,
			section: true,
			detail: "",
			minutes: 0,
			marks: null,
			time: "8:05",
		},
		{
			who: "Contestant 1 \u00b7 Grace Hopper",
			roleKey: "contestant_prepared",
			detail: "Delivers the prepared speech",
			minutes: 7,
			marks: { green: 5, yellow: 6, red: 7 },
			time: "8:05",
		},
	];

	function renderSections(layout: AgendaLayout) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={sectionRows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial", "spacious", "timing"] as const) {
		it(`${layout}: prints each section title exactly once`, () => {
			renderSections(layout);
			expect(screen.getAllByText("OPENING")).toHaveLength(1);
			expect(screen.getAllByText("PREPARED SPEECH CONTEST")).toHaveLength(1);
		});

		it(`${layout}: a section carries no clock stamp and is not split`, () => {
			renderSections(layout);
			// A section consumes no minutes, so a stamp on it claims the segment
			// header has a start of its own. TimingLayout also splits `who` on
			// " \u00b7 " into its Role column; this pins that a section never reaches
			// that path.
			const band = screen.getByText("PREPARED SPEECH CONTEST");
			expect(band.textContent).toBe("PREPARED SPEECH CONTEST");
		});

		it(`${layout}: ordinary rows still render beside sections`, () => {
			renderSections(layout);
			expect(screen.getAllByText(/Call to order/).length).toBeGreaterThan(0);
			expect(screen.getAllByText(/Contestant 1/).length).toBeGreaterThan(0);
		});
	}
});

/**
 * The timing layout reads the row's two halves instead of splitting `who` (#463).
 *
 * `TimingLayout` fills two columns — role and name — and used to get them from
 * `r.who.split(" · ")`. Both directions of that split are wrong in general:
 *
 *  - FIRST-split (what shipped) breaks when the ROLE half holds the separator.
 *    Since #445 that half is the club's own free text, validated only non-empty,
 *    so a club role named "Timer · Assistant" shifted "Assistant" into the name
 *    column.
 *  - LAST-split breaks the other case, because the HOLDER half holds it too on a
 *    guest row: "Speaker 1 · Jane · Guest".
 *
 * So the string was genuinely ambiguous and no split direction could be right.
 * #363 already shipped a bug from this exact shape — `OPEN_LABEL` is "— open —",
 * so `who` can carry a middot AND em dashes — and the recorded rule is not to
 * join row fields with a separator chosen because it does not currently appear.
 *
 * Both hostile shapes are asserted, because fixing one by flipping the split
 * direction was the tempting wrong answer.
 */
describe("timing layout splits nothing (#463)", () => {
	/**
	 * The role column's two parts, read from the DOM the layout actually builds.
	 *
	 * There are not two columns: `{role}` is a bare text node and the holder is a
	 * nested muted `<span>` reading `" · <name>"`. So the SPAN is the observable
	 * that distinguishes carrying two fields from splitting one string — with the
	 * old first-split, a role named "Timer · Assistant" put "Assistant · Riyaz"
	 * in there.
	 */
	const parts = (row: TimelineRow) => {
		const { container } = render(
			<MeetingAgendaPrint
				layout="timing"
				header={header}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={[row]}
			/>,
		);
		const stamp = container.querySelector<HTMLElement>("[data-row-time]");
		// [0] is the time stamp; [1] is the role column.
		const column = stamp?.parentElement?.children[1] as HTMLElement | undefined;
		const span = column?.querySelector("span");
		return {
			whole: column?.textContent ?? "",
			// Text before the nested span — the role half.
			role: (column?.firstChild?.textContent ?? "").trim(),
			// `null` when the row has no holder and the span is not rendered.
			holderPart: span ? span.textContent : null,
		};
	};

	it("keeps a middot inside a club's own role name out of the holder span", () => {
		const p = parts({
			who: "Timer · Assistant · Riyaz",
			roleLabel: "Timer · Assistant",
			holder: "Riyaz",
			roleKey: "timer",
			detail: "Times the speeches",
			minutes: 2,
			marks: null,
			time: "7:00",
		});
		expect(p.role).toBe("Timer · Assistant");
		// The old first-split put "Assistant · Riyaz" here.
		expect(p.holderPart).toBe(" · Riyaz");
	});

	it("keeps the Guest marker with the name, not in the role half", () => {
		const p = parts({
			who: "Speaker 1 · Jane · Guest",
			roleLabel: "Speaker 1",
			holder: "Jane · Guest",
			roleKey: "speaker",
			detail: "Prepared speech",
			minutes: 7,
			marks: null,
			time: "7:10",
		});
		expect(p.role).toBe("Speaker 1");
		// A LAST-split — the tempting fix for the case above — would have put
		// "Speaker 1 · Jane" in the role half and "Guest" here.
		expect(p.holderPart).toBe(" · Jane · Guest");
	});

	it("renders an event row's whole label with no holder span at all", () => {
		// Event and section beats carry no halves — their `who` was never ambiguous
		// and splitting it was already a no-op, which is what the `??` fallback in
		// the layout preserves.
		const p = parts({
			who: "Sergeant-at-Arms",
			detail: "Call to order",
			minutes: 1,
			marks: null,
			time: "6:45",
		});
		expect(p.role).toBe("Sergeant-at-Arms");
		expect(p.holderPart).toBeNull();
		expect(p.whole).toBe("Sergeant-at-Arms");
	});
});
