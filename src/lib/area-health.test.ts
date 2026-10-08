import { describe, expect, it } from "vitest";
import {
	type ClubHealth,
	type ClubHealthData,
	type ClubIdentity,
	chooseTrainingPeriod,
	type DuesPeriodFacts,
	deriveClubHealth,
	RECENT_WINDOW_DAYS,
	recentWindowStart,
	renewalsHealth,
	resolveTrainingWindows,
	sortClubHealth,
	wholeDaysSince,
} from "./area-health";
import { DCP_GOALS } from "./dcp";
import type { TrainingWindow } from "./officer-training";

// A mid-November instant: program year 2026, training year 2026, and period 2's
// default window (Nov 1 to Feb 28) open, in any server timezone.
const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

const IDENTITY: ClubIdentity = {
	areaClubId: "ac-1",
	name: "Alpha Speakers",
	clubNumber: "1234",
	status: "on_gavelup",
};

/** A club that records nothing: every rule's not-tracked branch. */
function emptyData(overrides: Partial<ClubHealthData> = {}): ClubHealthData {
	return {
		meetings: {
			rows: 0,
			recentHeld: 0,
			recentCancelled: 0,
			lastHeldAt: null,
			next: [],
		},
		slots: { filled: 0, total: 0 },
		attendance: { rollTaken: 0, presentMembers: 0, presentGuests: 0 },
		officerSeatsFilled: 0,
		training: { recordRows: 0, records: [], overrides: [] },
		dcpProgress: null,
		duesPeriods: [],
		...overrides,
	};
}

const health = (data: ClubHealthData | null, identity = IDENTITY) =>
	deriveClubHealth(identity, data, NOW);

describe("recent window", () => {
	it("starts exactly 90 x 24h before now, as instants", () => {
		expect(RECENT_WINDOW_DAYS).toBe(90);
		expect(recentWindowStart(NOW).toISOString()).toBe(
			"2026-08-17T12:00:00.000Z",
		);
		// Across a spring-forward in the US, 90 days is still 90 x 24h, not a
		// calendar subtraction that lands an hour off.
		const afterDst = new Date("2026-03-30T12:00:00Z");
		expect(afterDst.getTime() - recentWindowStart(afterDst).getTime()).toBe(
			90 * DAY,
		);
	});

	it("counts whole days since a meeting, flooring", () => {
		expect(wholeDaysSince(new Date(NOW.getTime() - (DAY - 1)), NOW)).toBe(0);
		expect(wholeDaysSince(new Date(NOW.getTime() - DAY), NOW)).toBe(1);
		expect(wholeDaysSince(new Date(NOW.getTime() - (2 * DAY - 1)), NOW)).toBe(
			1,
		);
		expect(wholeDaysSince(ago(100), NOW)).toBe(100);
	});
});

describe("deriveClubHealth", () => {
	it("is untracked when the club has no meetings at all, not zero", () => {
		const h = health(emptyData());
		expect(h.meetings).toEqual({ tracked: false });
		expect(h.roleFillRate).toEqual({ tracked: false });
		expect(h.attendance).toEqual({ tracked: false });
	});

	it("reports held and cancelled counts, days since the last, and at most two next", () => {
		const h = health(
			emptyData({
				meetings: {
					rows: 9,
					recentHeld: 4,
					recentCancelled: 1,
					lastHeldAt: new Date(NOW.getTime() - (3 * DAY + 5 * 3_600_000)),
					next: [ahead(2), ahead(9), ahead(16)],
				},
			}),
		);
		expect(h.meetings).toEqual({
			tracked: true,
			value: {
				held: 4,
				cancelled: 1,
				daysSinceLast: 3,
				next: [ahead(2).toISOString(), ahead(9).toISOString()],
			},
		});
	});

	it("has a null days-since when the club has meetings but none held yet", () => {
		const h = health(
			emptyData({
				meetings: {
					rows: 2,
					recentHeld: 0,
					recentCancelled: 0,
					lastHeldAt: null,
					next: [ahead(7)],
				},
			}),
		);
		expect(h.meetings).toMatchObject({
			tracked: true,
			value: { held: 0, daysSinceLast: null },
		});
	});

	it("leaves the role fill rate untracked with no recent held meeting, or with no slots", () => {
		const meetings = {
			rows: 3,
			recentHeld: 0,
			recentCancelled: 0,
			lastHeldAt: ago(200),
			next: [],
		};
		// Slots exist but none of the meetings they belong to is a recent held one.
		expect(
			health(emptyData({ meetings, slots: { filled: 3, total: 9 } }))
				.roleFillRate,
		).toEqual({ tracked: false });
		// Recent held meetings exist and have no slots at all.
		expect(
			health(
				emptyData({
					meetings: { ...meetings, recentHeld: 2 },
					slots: { filled: 0, total: 0 },
				}),
			).roleFillRate,
		).toEqual({ tracked: false });
		expect(
			health(
				emptyData({
					meetings: { ...meetings, recentHeld: 2 },
					slots: { filled: 3, total: 9 },
				}),
			).roleFillRate,
		).toEqual({ tracked: true, value: { filled: 3, total: 9 } });
	});

	it("averages attendance over the meetings with a roll, and reports how many that was", () => {
		const meetings = {
			rows: 5,
			recentHeld: 3,
			recentCancelled: 0,
			lastHeldAt: ago(5),
			next: [],
		};
		const h = health(
			emptyData({
				meetings,
				attendance: { rollTaken: 2, presentMembers: 9, presentGuests: 1 },
			}),
		);
		expect(h.attendance).toEqual({
			tracked: true,
			value: { avgMembers: 4.5, avgGuests: 0.5, rollTaken: 2, held: 3 },
		});
		// No roll taken is untracked even though meetings were held: zero members
		// is a claim about the room, and nobody made it.
		expect(health(emptyData({ meetings })).attendance).toEqual({
			tracked: false,
		});
	});

	it("always tracks officers for a GavelUp club, with seven seats, and leaves training untracked without records", () => {
		const h = health(emptyData({ officerSeatsFilled: 0 }));
		expect(h.officers).toEqual({
			tracked: true,
			value: {
				seatsFilled: 0,
				seatsTotal: 7,
				trained: { tracked: false },
			},
		});
	});

	it("counts trained offices in the chosen period, de-duplicating an office", () => {
		const record = (
			membershipId: string,
			position: "president" | "secretary",
			period: 1 | 2,
		) => ({
			membershipId,
			position,
			period,
		});
		const h = health(
			emptyData({
				officerSeatsFilled: 3,
				training: {
					recordRows: 5,
					// Period 2 is open on NOW; two members recorded for one office.
					records: [
						record("a", "president", 2),
						record("b", "president", 2),
						record("c", "secretary", 2),
						record("d", "secretary", 1),
					],
					overrides: [],
				},
			}),
		);
		expect(h.officers).toMatchObject({
			tracked: true,
			value: { seatsFilled: 3, trained: { tracked: true, value: 2 } },
		});
	});

	it("tracks training at zero when the club has records, just none for this year", () => {
		const h = health(
			emptyData({
				training: { recordRows: 4, records: [], overrides: [] },
			}),
		);
		expect(h.officers).toMatchObject({
			tracked: true,
			value: { trained: { tracked: true, value: 0 } },
		});
	});

	it("scores DCP from stored progress only, and leaves it untracked without a scoreboard", () => {
		expect(health(emptyData()).dcp).toEqual({ tracked: false });
		const target = (key: string) =>
			DCP_GOALS.find((g) => g.key === key)?.target ?? 0;
		const h = health(
			emptyData({
				dcpProgress: {
					g1: target("g1"),
					g2: target("g2"),
					g3: target("g3") - 1,
					g5: target("g5"),
				},
			}),
		);
		expect(h.dcp).toEqual({ tracked: true, value: { goalsMet: 3 } });
		// A scoreboard with no goal rows is a started board with nothing met.
		expect(health(emptyData({ dcpProgress: {} })).dcp).toEqual({
			tracked: true,
			value: { goalsMet: 0 },
		});
	});

	it("leaves every field untracked, officers included, for a club that is not on GavelUp or is archived", () => {
		for (const status of ["not_on_gavelup", "archived"] as const) {
			// Data is passed on purpose: a status that is not on_gavelup wins.
			const h = deriveClubHealth(
				{ ...IDENTITY, status },
				emptyData({ officerSeatsFilled: 7 }),
				NOW,
			);
			expect(h).toEqual({
				areaClubId: "ac-1",
				name: "Alpha Speakers",
				clubNumber: "1234",
				status,
				meetings: { tracked: false },
				roleFillRate: { tracked: false },
				attendance: { tracked: false },
				officers: { tracked: false },
				dcp: { tracked: false },
				renewals: { tracked: false },
			});
		}
	});
});

describe("chooseTrainingPeriod", () => {
	const window = (
		period: 1 | 2,
		startsOn: string,
		endsOn: string,
	): TrainingWindow => ({ period, startsOn, endsOn });

	it("takes the higher period when both overlapping windows are open", () => {
		const windows = [
			window(1, "2026-10-01", "2026-12-31"),
			window(2, "2026-11-01", "2027-02-28"),
		];
		expect(chooseTrainingPeriod(windows, "2026-11-15")).toBe(2);
	});

	it("takes period 1 when no window has started", () => {
		const windows = [
			window(1, "2027-06-01", "2027-08-31"),
			window(2, "2027-11-01", "2028-02-29"),
		];
		expect(chooseTrainingPeriod(windows, "2027-01-10")).toBe(1);
	});

	it("takes the latest closed window between windows, and period 2 once both are shut", () => {
		const windows = [
			window(1, "2026-06-01", "2026-08-31"),
			window(2, "2026-11-01", "2027-02-28"),
		];
		expect(chooseTrainingPeriod(windows, "2026-09-20")).toBe(1);
		expect(chooseTrainingPeriod(windows, "2027-03-20")).toBe(2);
	});

	it("prefers an open window to a higher closed one", () => {
		// Period 2 was edited to end early; period 1 was edited to run on.
		const windows = [
			window(1, "2026-09-01", "2026-12-31"),
			window(2, "2026-09-05", "2026-10-31"),
		];
		expect(chooseTrainingPeriod(windows, "2026-11-15")).toBe(1);
	});

	it("resolves each period to its stored window, else the default", () => {
		const resolved = resolveTrainingWindows(2026, [
			window(2, "2026-12-01", "2027-01-31"),
		]);
		expect(resolved).toEqual([
			window(1, "2026-06-01", "2026-08-31"),
			window(2, "2026-12-01", "2027-01-31"),
		]);
	});

	it("makes the club's own window decide the period in deriveClubHealth", () => {
		// Default period 2 would be open on NOW; this club starts it in December,
		// so period 1 is the latest closed window and its record is the one counted.
		const h = health(
			emptyData({
				training: {
					recordRows: 2,
					records: [
						{ membershipId: "a", position: "president", period: 1 },
						{ membershipId: "b", position: "treasurer", period: 2 },
					],
					overrides: [window(2, "2026-12-01", "2027-01-31")],
				},
			}),
		);
		expect(h.officers).toMatchObject({
			value: { trained: { tracked: true, value: 1 } },
		});
	});
});

describe("renewalsHealth", () => {
	let n = 0;
	const period = (
		dueInDays: number,
		paid: number,
		overrides: Partial<DuesPeriodFacts> = {},
	): DuesPeriodFacts => ({
		id: `p${++n}`,
		dueDate: dueInDays < 0 ? ago(-dueInDays) : ahead(dueInDays),
		createdAt: ago(400),
		paid,
		...overrides,
	});

	it("compares the active period with the one before it", () => {
		const periods = [period(-200, 6), period(-20, 4), period(150, 1)];
		expect(renewalsHealth(periods, NOW)).toEqual({
			tracked: true,
			value: { paidThisPeriod: 4, paidLastPeriod: 6 },
		});
	});

	it("is untracked with no periods", () => {
		expect(renewalsHealth([], NOW)).toEqual({ tracked: false });
	});

	it("is untracked when the active period is the only one", () => {
		expect(renewalsHealth([period(-20, 4)], NOW)).toEqual({ tracked: false });
	});

	it("is untracked when both periods are still upcoming, because the earliest is then active", () => {
		// Two periods is not enough: the fallback activates the EARLIEST of them,
		// and nothing precedes it.
		expect(renewalsHealth([period(30, 2), period(200, 0)], NOW)).toEqual({
			tracked: false,
		});
	});

	it("breaks a tie on due date by created_at, then id", () => {
		const due = ago(10);
		const earlier = period(-10, 7, {
			id: "z-earlier-created",
			dueDate: due,
			createdAt: ago(300),
		});
		const later = period(-10, 3, {
			id: "a-later-created",
			dueDate: due,
			createdAt: ago(200),
		});
		expect(renewalsHealth([later, earlier], NOW)).toEqual({
			tracked: true,
			value: { paidThisPeriod: 3, paidLastPeriod: 7 },
		});
		// Same due date and created_at: the id decides, whatever order they arrive in.
		const a = period(-10, 1, { id: "a", dueDate: due, createdAt: ago(5) });
		const b = period(-10, 2, { id: "b", dueDate: due, createdAt: ago(5) });
		expect(renewalsHealth([b, a], NOW)).toEqual(renewalsHealth([a, b], NOW));
		expect(renewalsHealth([a, b], NOW)).toMatchObject({
			value: { paidThisPeriod: 2, paidLastPeriod: 1 },
		});
	});
});

describe("sortClubHealth", () => {
	const club = (
		name: string,
		status: ClubHealth["status"],
		id = name,
	): ClubHealth =>
		deriveClubHealth({ ...IDENTITY, areaClubId: id, name, status }, null, NOW);

	it("puts GavelUp clubs first, then clubs that are not, then archived ones, each by name", () => {
		const sorted = sortClubHealth([
			club("A archived", "archived"),
			club("Zulu", "on_gavelup"),
			club("B not on", "not_on_gavelup"),
			club("Alpha", "on_gavelup"),
			club("C archived", "archived"),
			club("A not on", "not_on_gavelup"),
		]);
		expect(sorted.map((c) => c.name)).toEqual([
			"Alpha",
			"Zulu",
			"A not on",
			"B not on",
			"A archived",
			"C archived",
		]);
	});

	it("compares numbers as numbers, and breaks a name tie on the row id", () => {
		const sorted = sortClubHealth([
			club("Club 10", "on_gavelup"),
			club("Club 2", "on_gavelup"),
			club("Same", "on_gavelup", "b"),
			club("Same", "on_gavelup", "a"),
		]);
		expect(sorted.map((c) => c.areaClubId)).toEqual([
			"Club 2",
			"Club 10",
			"a",
			"b",
		]);
	});
});
