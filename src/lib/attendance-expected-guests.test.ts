import { describe, expect, it } from "vitest";
import {
	buildPlanPanel,
	guestsPhrase,
	guestVisitLabel,
	pendingExpectedGuests,
	publicCountsLine,
} from "#/lib/attendance-panel";
import type { MinutesData } from "#/server/minutes-logic";
import type { MinutesOp } from "./offline-minutes-queue";
import { deriveRollGuests } from "./roll-attendance";

describe("guestVisitLabel", () => {
	// protects=AC5: a first-time and a returning guest read differently, and the
	// ordinals are right through the teens.
	// fails_when=visitNumber 1 reads "1st visit", or 11/12/13 read "11st".
	it("labels first and returning visits", () => {
		expect(guestVisitLabel(1)).toBe("first visit");
		expect(guestVisitLabel(2)).toBe("2nd visit");
		expect(guestVisitLabel(3)).toBe("3rd visit");
		expect(guestVisitLabel(4)).toBe("4th visit");
		expect(guestVisitLabel(11)).toBe("11th visit");
		expect(guestVisitLabel(12)).toBe("12th visit");
		expect(guestVisitLabel(21)).toBe("21st visit");
		expect(guestVisitLabel(112)).toBe("112th visit");
	});
});

describe("guest counts in the counts lines", () => {
	// protects=the officer's line gains "· 2 guests"; everyone else's reads
	// "14 coming · 2 guests"; zero guests changes nothing.
	// fails_when=the guests phrase is dropped, pluralised wrong, or shown at zero.
	it("appends guests to the plan panel line and builds the public line", () => {
		const roster = [{ id: "m1", name: "Ada" }] as never;
		const plan = [{ memberId: "m1", status: "coming" as const }];
		const withGuests = buildPlanPanel({
			roster,
			plan,
			roleByMemberId: {},
			guestCount: 2,
		});
		expect(withGuests.countsLine).toBe("1 coming · 2 guests");
		expect(
			buildPlanPanel({ roster, plan, roleByMemberId: {} }).countsLine,
		).toBe("1 coming");
		expect(guestsPhrase(1)).toBe("1 guest");
		expect(publicCountsLine(14, 2)).toBe("14 coming · 2 guests");
		expect(publicCountsLine(0, 2)).toBe("2 guests");
		expect(publicCountsLine(5, 0)).toBe("5 coming");
		expect(publicCountsLine(0, 0)).toBe("");
	});
});

const meta = (n: number) => ({ opId: `op-${n}`, queuedAt: 1000 + n });
const noAward = { memberId: null, guestId: null, name: null, isGuest: false };
const minutes = {
	actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
	meetingId: "meeting-1",
	clubId: "club-1",
	members: [],
	guests: [],
	tableTopicsSpeakers: [],
	awards: [
		{ category: "best_speaker", ...noAward },
		{ category: "best_evaluator", ...noAward },
		{ category: "best_table_topics", ...noAward },
	],
	awardEligible: {
		best_speaker: { memberIds: [], guestIds: [] },
		best_evaluator: { memberIds: [], guestIds: [] },
		best_table_topics: { memberIds: [], guestIds: [] },
	},
	counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
} as unknown as MinutesData;
const RSVPS = [
	{ guestId: "g-dana", name: "Dana" },
	{ guestId: "g-sam", name: "Sam" },
];

describe("pendingExpectedGuests with the offline queue", () => {
	// protects=D7 offline: Here queues an addGuest (the roll's existing write); the
	// derived guest list then shows the guest present and the expected row goes
	// away at once, and a queued removal brings it back.
	// fails_when=an offline Here leaves the row (an invitation to tap twice), or
	// the expected list is built from the raw loader rows instead of the derived.
	it("drops a guest whose Here is queued offline, and restores one removed", () => {
		const here: MinutesOp = {
			type: "addGuest",
			...meta(1),
			guestId: "g-dana",
			name: "Dana",
		};
		const present = deriveRollGuests({
			online: false,
			minutes,
			snapshot: null,
			queue: [here],
		});
		expect(pendingExpectedGuests(RSVPS, present).map((g) => g.name)).toEqual([
			"Sam",
		]);

		const removed = deriveRollGuests({
			online: false,
			minutes,
			snapshot: null,
			queue: [
				here,
				{ type: "removeGuest", ...meta(2), guestId: "g-dana" } as MinutesOp,
			],
		});
		expect(pendingExpectedGuests(RSVPS, removed)).toHaveLength(2);
	});

	// protects=nothing present yet lists everyone; undefined (roll not wired) too.
	it("lists everyone when nobody is on the roll", () => {
		expect(pendingExpectedGuests(RSVPS, [])).toHaveLength(2);
		expect(pendingExpectedGuests(RSVPS, undefined)).toHaveLength(2);
	});
});
