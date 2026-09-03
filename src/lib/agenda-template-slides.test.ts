/**
 * The projected deck for a templated meeting (#agenda-templates PR 2).
 *
 * Two properties get most of the weight here, because they are the ones a
 * generic beat-driven deck can plausibly get wrong:
 *
 * - It PASSES THE ROWS THROUGH rather than re-walking the template. That is what
 *   makes the deck and the printed run sheet structurally unable to disagree,
 *   and it is why `agenda-parity.test.ts` excludes both new slide kinds instead
 *   of comparing them: there is no second derivation to compare against. If this
 *   file ever has to sort, filter or renumber, that claim is void.
 * - SPEAKING ORDER IS DATA. A contest's order is drawn by lot outside the app
 *   (deliberately no randomizer) and RECORDED by moving contestants, so the deck
 *   must follow the rows' order and renumber with it — never remember an order
 *   of its own, and never cache one.
 */
import { describe, expect, it } from "vitest";
import { withBeatIds } from "../test/template-beat-ids";
import type { AgendaRow, AgendaSlot } from "./agenda-runsheet";
import { resolveAgendaRows } from "./agenda-runsheet";
import type { ClubForDeck, MeetingForDeck, Slide } from "./agenda-slides";
import { buildTemplateSlideDeck } from "./agenda-template-slides";
import { CONTEST_TEMPLATE } from "./contest-template";
import { slideName } from "./slide-layout";

const meeting: MeetingForDeck = {
	scheduledAt: new Date("2026-09-10T01:00:00Z"),
	theme: "Courage",
	wordOfTheDay: "Intrepid",
	wodDefinition: null,
	wodExample: null,
	reminders: null,
};

const club: ClubForDeck = {
	name: "MCF Toastmasters",
	logoUrl: null,
	clubNumber: "1234567",
	district: "District 39",
	timezone: "America/Chicago",
	meetingSchedule: "2nd & 4th Thursdays",
	tableTopicsMinSeconds: null,
	tableTopicsMaxSeconds: null,
};

/** A contestant slot for the prepared-speech contest, in draw position `i`. */
function contestant(i: number, name: string): AgendaSlot {
	return {
		id: `c${i}`,
		roleName: "Prepared Speech Contestant",
		roleKey: "contestant_prepared",
		category: "speaker",
		isSpeakerRole: true,
		slotIndex: i,
		assigneeName: name,
		speechTitle: null,
		projectLevel: null,
		minMinutes: 5,
		maxMinutes: 7,
		evaluatesSlotId: null,
		evaluates: null,
	};
}

/** The real seeded contest, rendered through the real row derivation. */
function contestRows(slots: AgendaSlot[]): AgendaRow[] {
	return resolveAgendaRows({
		geIntroducesFunctionaries: false,
		tableTopicsLimits: null,
		template: {
			beats: withBeatIds(CONTEST_TEMPLATE.beats),
			roles: CONTEST_TEMPLATE.roles,
		},
		slots,
	});
}

function deckFor(slots: AgendaSlot[], over: Partial<MeetingForDeck> = {}) {
	return buildTemplateSlideDeck({
		meeting: { ...meeting, ...over },
		club,
		rows: contestRows(slots),
	});
}

const kinds = (deck: Slide[]) => deck.map((s) => s.kind);
const beatLabels = (deck: Slide[]) =>
	deck.flatMap((s) => (s.kind === "templateBeat" ? [s.label] : []));

describe("buildTemplateSlideDeck anchors", () => {
	it("opens on the title splash and closes on the thank-you", () => {
		const deck = deckFor([]);
		expect(deck[0]?.kind).toBe("title");
		expect(deck.at(-1)?.kind).toBe("thankYou");
	});

	it("carries the club identity onto the title slide", () => {
		const title = deckFor([])[0];
		if (title?.kind !== "title") throw new Error("expected a title slide");
		expect(title.clubName).toBe("MCF Toastmasters");
		expect(title.district).toBe("District 39");
		expect(title.clubNumber).toBe("1234567");
	});

	// An empty template must not silently produce a two-slide deck — the exact
	// failure PR 1's guard was standing in for. `resolveAgendaRows` returns [] for
	// an empty template and never falls back, so the deck is anchors-only, which
	// is honest rather than misleading. Pinned so a future "helpful" fallback here
	// is a failing test.
	it("emits anchors only when the template has no beats", () => {
		const deck = buildTemplateSlideDeck({ meeting, club, rows: [] });
		expect(kinds(deck)).toEqual(["title", "thankYou"]);
	});
});

describe("buildTemplateSlideDeck sections and beats", () => {
	it("projects every section band as its own divider slide", () => {
		const deck = deckFor([contestant(0, "Ada")]);
		const sections = deck.flatMap((s) =>
			s.kind === "templateSection" ? [s.title] : [],
		);
		// The seeded contest divides into three segments; the print sheet asserts
		// the same count from the same rows (contest-template.test.ts).
		expect(sections).toHaveLength(3);
		expect(new Set(sections).size).toBe(3);
	});

	it("projects one beat slide per non-section row, in row order", () => {
		const slots = [contestant(0, "Ada"), contestant(1, "Grace")];
		const rows = contestRows(slots);
		const deck = buildTemplateSlideDeck({ meeting, club, rows });

		// The pass-through property, stated as an equality rather than a count: the
		// deck's beat slides ARE the non-section rows, in order, by their `who`.
		// A deck that re-walked the template could match on count and still
		// reorder, renumber or drop a repeat.
		expect(beatLabels(deck)).toEqual(
			rows.filter((r) => !r.section).map((r) => r.who),
		);
		// And the interleaving survives: sections sit where they sit among beats.
		expect(kinds(deck).slice(1, -1)).toEqual(
			rows.map((r) => (r.section ? "templateSection" : "templateBeat")),
		);
	});

	it("names a contestant beat with the person, not just the role", () => {
		const deck = deckFor([contestant(0, "Ada Lovelace")]);
		expect(beatLabels(deck)).toContain("Contest speech · Ada Lovelace");
	});

	it("carries the beat's detail and drops it when blank", () => {
		const deck = deckFor([contestant(0, "Ada")]);
		const withDetail = deck.find(
			(s) => s.kind === "templateBeat" && s.detail !== null,
		);
		expect(withDetail).toBeTruthy();
		for (const s of deck) {
			// Never an empty string — the layout tests `if (slide.detail)`, so ""
			// would render an empty bullet rather than no bullet.
			if (s.kind === "templateBeat") expect(s.detail).not.toBe("");
		}
	});

	it("emits no vote slides, and no standard-meeting beats", () => {
		const deck = deckFor([contestant(0, "Ada")]);
		// A contest is scored by judges on paper, not by the club's digital ballot
		// (#510); projecting a club vote QR would invite the room to vote in a
		// contest they are not the judges of.
		for (const forbidden of [
			"voteSpeaker",
			"voteTableTopics",
			"voteEvaluator",
			"toastmaster",
			"tableTopics",
			"awards",
			"guestComments",
			"functionaryIntro",
		]) {
			expect(kinds(deck)).not.toContain(forbidden);
		}
	});

	it("keeps meeting announcements, which no beat would carry", () => {
		const deck = deckFor([], { reminders: "  Dues are due.  " });
		const reminders = deck.find((s) => s.kind === "reminders");
		if (reminders?.kind !== "reminders") throw new Error("no reminders slide");
		expect(reminders.text).toBe("Dues are due.");
		// Before the closing splash, matching the standard deck's closing order.
		expect(kinds(deck).at(-2)).toBe("reminders");
	});

	it("omits the announcements slide when the club typed none", () => {
		expect(kinds(deckFor([], { reminders: "   " }))).not.toContain("reminders");
	});
});

describe("buildTemplateSlideDeck timing", () => {
	it("projects the contest signals and the qualifying window", () => {
		const deck = deckFor([contestant(0, "Ada")]);
		const timed = deck.find(
			(s) => s.kind === "templateBeat" && s.timing !== null,
		);
		if (timed?.kind !== "templateBeat" || !timed.timing)
			throw new Error("expected a timed beat");
		// Absolute clock strings, not a restatement of whatever the marks are: in a
		// contest the ±30s grace window IS the disqualification rule (#357), so the
		// wall and the paper agreeing on it is the point.
		expect(timed.timing.green).toMatch(/^\d+:\d\d$/);
		expect(timed.timing.qualifies).toContain("–");
	});

	it("leaves an untimed beat's timing null rather than inventing one", () => {
		const rows: AgendaRow[] = [
			{ who: "Call to order", detail: "", minutes: 2, marks: null },
		];
		const deck = buildTemplateSlideDeck({ meeting, club, rows });
		const beat = deck.find((s) => s.kind === "templateBeat");
		if (beat?.kind !== "templateBeat") throw new Error("no beat slide");
		expect(beat.timing).toBeNull();
		expect(beat.minutes).toBe(2);
	});

	// `qualifyingWindowForMarks` returns null unless BOTH edges are real, so a
	// half-specified beat must not project a window built from one of them.
	it("treats a half-specified window as untimed", () => {
		const rows: AgendaRow[] = [
			{
				who: "Odd beat",
				detail: "",
				minutes: 5,
				marks: { green: 5, yellow: 6, red: Number.NaN },
			},
		];
		const beat = buildTemplateSlideDeck({ meeting, club, rows })[1];
		if (beat?.kind !== "templateBeat") throw new Error("no beat slide");
		expect(beat.timing).toBeNull();
	});
});

/**
 * The drawn-order contract. A contest's speaking order is drawn by lot at the
 * briefing — physically, with the room watching — and the app has no randomizer
 * on purpose. The officer records the result by moving contestants, which swaps
 * `slot_index` (`applyMoveSpeakerSlot`). Everything downstream must simply
 * follow.
 */
describe("buildTemplateSlideDeck follows the drawn speaking order", () => {
	const ada = "Ada Lovelace";
	const grace = "Grace Hopper";
	const alan = "Alan Turing";

	it("projects contestants in slot order", () => {
		const deck = deckFor([
			contestant(0, ada),
			contestant(1, grace),
			contestant(2, alan),
		]);
		const speeches = beatLabels(deck).filter((l) =>
			l.startsWith("Contest speech"),
		);
		expect(speeches).toEqual([
			`Contest speech 1 · ${ada}`,
			`Contest speech 2 · ${grace}`,
			`Contest speech 3 · ${alan}`,
		]);
	});

	// The property that makes recording a draw work: the NUMBER is the position,
	// not the person. After a re-draw, "Contest speech 1" is whoever now holds
	// slot 0. A deck that keyed its numbering off the assignee — or that cached an
	// earlier order — would put the old numbers on the new order, and the room
	// would call the wrong contestant to the lectern.
	it("renumbers when the draw is re-recorded, rather than keeping the old order", () => {
		const drawn = deckFor([
			contestant(0, ada),
			contestant(1, grace),
			contestant(2, alan),
		]);
		// Same three people, re-drawn: Alan first, Ada last.
		const redrawn = deckFor([
			contestant(0, alan),
			contestant(1, ada),
			contestant(2, grace),
		]);

		const first = (deck: Slide[]) =>
			beatLabels(deck).find((l) => l.startsWith("Contest speech 1"));
		expect(first(drawn)).toBe(`Contest speech 1 · ${ada}`);
		expect(first(redrawn)).toBe(`Contest speech 1 · ${alan}`);
		// Ada is still in the contest, just not first — a re-draw reorders, it does
		// not drop anybody.
		expect(beatLabels(redrawn)).toContain(`Contest speech 2 · ${ada}`);
	});

	it("shrinks the deck when a contestant withdraws, without renumbering gaps", () => {
		const deck = deckFor([contestant(0, ada), contestant(1, grace)]);
		const speeches = beatLabels(deck).filter((l) =>
			l.startsWith("Contest speech"),
		);
		expect(speeches).toEqual([
			`Contest speech 1 · ${ada}`,
			`Contest speech 2 · ${grace}`,
		]);
	});

	// Non-consecutive `slot_index` values are what a withdrawal actually leaves
	// behind — the remaining slots keep their original indices. The draw order is
	// the SORT, never the raw index, so the room never sees "Contest speech 4"
	// with three contestants standing.
	it("numbers by position even when slot indices are not consecutive", () => {
		const deck = deckFor([contestant(0, ada), contestant(7, grace)]);
		const speeches = beatLabels(deck).filter((l) =>
			l.startsWith("Contest speech"),
		);
		expect(speeches).toEqual([
			`Contest speech 1 · ${ada}`,
			`Contest speech 2 · ${grace}`,
		]);
	});
});

describe("buildTemplateSlideDeck jump-grid labels", () => {
	// The jump grid (#360) labels its cells with `slideName`, and two ADJACENT
	// cells reading the same thing is the failure #446 was about. The cross-kind
	// check in slide-layout.test.ts samples one slide per kind, so it is blind to
	// this by construction: every beat on a contest shares one kind and takes its
	// name from content. The seed's two briefing beats were renamed apart for the
	// print sheet; this is the assertion that keeps them apart on the wall.
	it("gives no two adjacent slides the same name on the real contest deck", () => {
		const deck = deckFor([
			contestant(0, "Ada"),
			contestant(1, "Grace"),
			contestant(2, "Alan"),
			contestant(3, "Katherine"),
		]);
		const names = deck.map(slideName);
		const collisions = names.filter((n, i) => i > 0 && names[i - 1] === n);
		expect(collisions).toEqual([]);
	});

	it("gives every slide a non-empty name", () => {
		const deck = deckFor([contestant(0, "Ada")]);
		for (const name of deck.map(slideName)) expect(name.trim()).not.toBe("");
	});
});
