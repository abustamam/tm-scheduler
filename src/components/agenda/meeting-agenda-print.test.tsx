// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_LABEL } from "#/lib/agenda-runsheet";
import type { TimelineRow } from "#/lib/agenda-timing";
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
			// "Left of the club name, vertically centered": the image's own flex
			// row centers its children, and the club-name block is the very next
			// sibling — not merely present somewhere on the page.
			const row = img?.parentElement as HTMLElement;
			expect(row.style.alignItems).toBe("center");
			expect(img?.nextElementSibling?.textContent).toContain(header.clubName);
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
