// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "#/lib/agenda-timing";
import {
	type AgendaHeader,
	type AgendaLayout,
	MeetingAgendaPrint,
} from "./meeting-agenda-print";

afterEach(cleanup);

const header: AgendaHeader = {
	clubName: "Downtown Toastmasters",
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

// One timed speaker beat (has green/amber/red marks) + one plain beat (no marks).
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

describe("MeetingAgendaPrint one-page timing", () => {
	for (const layout of ["grid", "editorial"] as const) {
		it(`shows the color-coded green/amber/red trio on the ${layout} one-pager`, () => {
			renderLayout(layout);
			// green = 4:00, amber = 5:00, red = 6:00 for the timed speaker beat.
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
			expect(
				screen.getByText(
					"Toastmaster · Lee P. — Introduces the General Evaluator",
				),
			).toBeTruthy();
			expect(
				screen.getByText("Toastmaster · Lee P. — Introduces the speakers"),
			).toBeTruthy();
			expect(
				screen.getByText(
					"Table Topics Master · Rasheed — Introduces the General Evaluator",
				),
			).toBeTruthy();
			expect(
				screen.getByText(
					"General Evaluator · Riyaz — Introduces the speech evaluators",
				),
			).toBeTruthy();
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
			const band = screen.getByText(
				"Toastmaster · Lee P. — Introduces the General Evaluator",
			).parentElement as HTMLElement;
			expect(band.style.paddingLeft).toBe(BAND_STYLE[layout].paddingLeft);
			expect(band.style.fontSize).toBe(BAND_STYLE[layout].fontSize);
		});
	}

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
			const bandFor = (text: string) =>
				screen.getByText(text).parentElement as HTMLElement;
			// Rows 1 and 2 of the fixture: adjacent hand-offs, so one lands on each
			// side of the zebra.
			const odd = bandFor(
				"Toastmaster · Lee P. — Introduces the General Evaluator",
			);
			const even = bandFor("Toastmaster · Lee P. — Introduces the speakers");

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
		const band = screen.getByText(
			"Toastmaster · Lee P. — Introduces the General Evaluator",
		).parentElement as HTMLElement;
		const affordance = band.firstElementChild as HTMLElement;
		expect(affordance.getAttribute("aria-hidden")).toBe("true");
		expect(affordance.textContent).toBe("");
		expect(affordance.style.borderLeftStyle).toBe("solid");
		expect(affordance.style.borderBottomStyle).toBe("solid");
	});
});
