import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV1 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	expectedFromBundle,
	notImportedFromBundle,
	placeRoleHolders,
	type PlanContext,
	type PlanExistingMeeting,
	type PlanTargetSlot,
	personKeyOf,
} from "./easy-speak-import-plan";

/**
 * The upcoming half of the planner (#1495). The fixture's meeting 644360 is the
 * upcoming one: Tue 2026-10-13 19:00 in Los Angeles (2026-10-14T02:00Z), with a
 * Timer and a "Timer 2 - Online" (one role, two holders), a Joke Master (no
 * standard role), a Toastmaster and fourteen RSVPs.
 */
const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const DEF = {
	toastmaster: id(101),
	timer: id(102),
	speaker: id(103),
};
const ROLE_DEFINITIONS = [
	{ id: DEF.toastmaster, key: "toastmaster_of_the_day", name: "Toastmaster" },
	{ id: DEF.timer, key: "timer", name: "Timer" },
	{ id: DEF.speaker, key: "speaker", name: "Speaker" },
];
const ROSTER = [
	{ memberId: id(1), name: "Zéphyr Ashlowe" },
	{ memberId: id(2), name: "Kai Larkspur" },
];

/** The fixture cut to its upcoming meeting 644360 alone. */
function upcomingOnly(): EasySpeakBundleV1 {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	bundle.meetings = bundle.meetings.filter((m) => m.esMeetingId === "644360");
	return bundle;
}
const meeting360 = (b: EasySpeakBundleV1) => {
	const m = b.meetings[0];
	if (!m) throw new Error("fixture changed");
	return m;
};

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
	now: NOW,
	clubTimezone: "America/Los_Angeles",
	roster: ROSTER,
	roleDefinitions: ROLE_DEFINITIONS,
	guestIds: new Set(),
	existingMeetings: [],
	refs: [],
	importUpcoming: true,
	newMeetingShape: [
		{ roleDefinitionId: DEF.toastmaster, count: 1 },
		{ roleDefinitionId: DEF.timer, count: 2 },
	],
	...over,
});

/** A GavelUp meeting on the same LOCAL day as 644360, at 11:00 (18:00Z): another instant, another UTC date. */
const SAME_DAY_MORNING: PlanExistingMeeting = {
	id: id(900),
	scheduledAt: new Date("2026-10-13T18:00:00Z"),
	status: "scheduled",
};
const slotsOf = (...rows: PlanTargetSlot[]) =>
	new Map<string, PlanTargetSlot[]>([[SAME_DAY_MORNING.id, rows]]);
const empty = (
	roleDefinitionId: string,
	slotIndex: number,
): PlanTargetSlot => ({
	roleDefinitionId,
	slotIndex,
	holder: null,
});

const upcomingOf = (plan: ReturnType<typeof buildImportPlan>) => {
	const pm = plan.meetings.find((m) => m.esMeetingId === "644360");
	if (!pm) throw new Error("644360 is not in the plan");
	return pm;
};

describe("upcoming dispositions (#1495)", () => {
	// protects=an upcoming meeting with nothing on its local day is created at the Easy-Speak instant with the template's slots;
	// fails_when=it is skipped as before, or created at another instant;
	// no_claim=that the apply inserts it (integration test).
	it("creates a meeting where the club has none on that local date", () => {
		const plan = buildImportPlan(upcomingOnly(), ctx());
		const pm = upcomingOf(plan);
		expect(pm).toMatchObject({
			action: "create",
			upcoming: true,
			existingMeetingId: null,
		});
		expect(pm.scheduledAt.toISOString()).toBe("2026-10-14T02:00:00.000Z");
		expect(plan.upcoming).toMatchObject({ toCreate: 1, toAdopt: 0 });
		expect(plan.counts.futureMeetingsSkipped).toBe(0);
	});

	// protects=matching is by CLUB-LOCAL date: a scheduled meeting at 11:00 the same local day, whose UTC date differs from Easy-Speak's, is adopted and keeps its time;
	// fails_when=matching uses the exact instant or the UTC date;
	// no_claim=anything about the apply's write.
	it("adopts a scheduled meeting on the same local date at another time and names both times", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({ existingMeetings: [SAME_DAY_MORNING], upcomingSlots: slotsOf() }),
		);
		const pm = upcomingOf(plan);
		expect(pm).toMatchObject({ action: "adopt", existingMeetingId: id(900) });
		expect(pm.scheduledAt.toISOString()).toBe("2026-10-13T18:00:00.000Z");
		expect(plan.upcoming.timeNotes).toEqual([
			"Easy-Speak has the meeting of 2026-10-13 at 19:00; GavelUp's 11:00 stands.",
		]);
	});

	// protects=a cancelled meeting on that date is left alone and reported, never un-cancelled;
	// fails_when=a cancelled meeting is adopted or a second one is created beside it;
	// no_claim=the status of a meeting that is cancelled after the plan (the apply re-checks).
	it("leaves a cancelled meeting on that date alone and says so", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [{ ...SAME_DAY_MORNING, status: "cancelled" }],
			}),
		);
		const pm = upcomingOf(plan);
		expect(pm).toMatchObject({
			action: "skip",
			skip: {
				kind: "exists",
				reason:
					"Exists in GavelUp, not imported: a cancelled meeting is already at this time.",
			},
		});
		expect(plan.upcoming.leftAlone).toEqual([
			{
				esMeetingId: "644360",
				date: "2026-10-13",
				reason: pm.skip?.reason,
			},
		]);
		// A meeting left alone places nobody.
		expect(plan.people.filter((p) => p.appearances.roles > 0)).toEqual([]);
		expect(plan.counts.futureMeetingsSkipped).toBe(1);
	});

	// protects=a scheduled meeting whose time has already passed is not adopted (it is not an upcoming meeting any more);
	// fails_when=the adopt test drops the "ahead of now" half;
	// no_claim=none beyond protects.
	it("does not adopt a scheduled meeting that is already in the past", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [
					{
						...SAME_DAY_MORNING,
						scheduledAt: new Date("2026-10-13T18:00:00Z"),
					},
				],
				now: new Date("2026-10-13T20:00:00Z"),
			}),
		);
		// 644360 (02:00Z on the 14th) is still ahead; the club's 18:00Z meeting is not.
		expect(upcomingOf(plan).action).toBe("skip");
	});

	// protects=a meeting imported before is updated (fill empty only), and one deleted since is not created again;
	// fails_when=a ref'd meeting is adopted by date, or a deleted one is recreated;
	// no_claim=the fill itself.
	it("treats a ref'd meeting as an update and a ref to a deleted meeting as deleted", () => {
		const refs = [{ kind: "meeting", sourceId: "644360", targetId: id(900) }];
		const updated = buildImportPlan(
			upcomingOnly(),
			ctx({
				refs,
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(),
			}),
		);
		expect(upcomingOf(updated)).toMatchObject({
			action: "update",
			existingMeetingId: id(900),
		});
		const deleted = buildImportPlan(upcomingOnly(), ctx({ refs }));
		expect(upcomingOf(deleted)).toMatchObject({
			action: "skip",
			skip: {
				kind: "deleted",
				reason: "Deleted in GavelUp since import: not created again.",
			},
		});
	});

	// protects=two Easy-Speak meetings on one local date import one meeting: the first claims the date, the second is left alone and reported;
	// fails_when=both are created, or the later one wins;
	// no_claim=which of two same-instant meetings is first beyond the id tie-break.
	it("lets the first of two Easy-Speak meetings on one date claim it", () => {
		const bundle = upcomingOnly();
		const first = meeting360(bundle);
		bundle.meetings.push({
			...structuredClone(first),
			esMeetingId: "644361",
			startsAt: "2026-10-14T03:00:00.000Z",
		});
		const plan = buildImportPlan(bundle, ctx());
		const byId = new Map(plan.meetings.map((m) => [m.esMeetingId, m]));
		expect(byId.get("644360")?.action).toBe("create");
		expect(byId.get("644361")).toMatchObject({
			action: "skip",
			skip: {
				reason:
					"Another Easy-Speak meeting on 2026-10-13 is imported; only one meeting per day is.",
			},
		});
	});
});

describe("upcoming slot placement (#1495)", () => {
	const holderOf = (plan: ReturnType<typeof buildImportPlan>, label: string) =>
		upcomingOf(plan).slots.find((s) => s.label === label);

	// protects=the i-th holder of a role goes to the slot with that index when it is empty, in Easy-Speak order;
	// fails_when=holders are placed in a different order or on the wrong index;
	// no_claim=the write.
	it("places the i-th holder on slot index i", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(empty(DEF.timer, 0), empty(DEF.timer, 1)),
			}),
		);
		expect(holderOf(plan, "Timer")).toMatchObject({ slotIndex: 0 });
		expect(holderOf(plan, "Timer 2 - Online")).toMatchObject({ slotIndex: 1 });
		expect(holderOf(plan, "Timer")?.kept).toBeUndefined();
		expect(plan.upcoming.unslottedRoles.map((r) => r.planKey)).not.toContain(
			"std:timer",
		);
	});

	// protects=when slot i is taken in GavelUp the holder takes the lowest empty slot, and one with none left is kept out, not placed over anyone;
	// fails_when=a filled slot is chosen, or the holder with no empty slot is placed;
	// no_claim=a slot claimed after the plan (the apply's isNull guard; integration test).
	it("falls back to the first empty slot and keeps GavelUp's holder when none is left", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(
					{ ...empty(DEF.timer, 0), holder: { memberId: id(77) } },
					empty(DEF.timer, 1),
				),
			}),
		);
		expect(holderOf(plan, "Timer")).toMatchObject({ slotIndex: 1 });
		expect(holderOf(plan, "Timer")?.kept).toBeUndefined();
		expect(holderOf(plan, "Timer 2 - Online")).toMatchObject({ kept: "taken" });
		expect(plan.upcoming.keptGavelUpHolder).toBe(1);
	});

	// protects=a holder who already holds the role on the meeting is neither placed twice nor displaced;
	// fails_when=the same person is given a second slot;
	// no_claim=a person who is not yet resolved (a new member) cannot already hold anything.
	it("does not place a holder who already holds that role", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				// Zephyr Ashlowe (Toastmaster in 644360) already holds the Toastmaster slot.
				upcomingSlots: slotsOf({
					...empty(DEF.toastmaster, 0),
					holder: { memberId: id(1) },
				}),
			}),
		);
		expect(holderOf(plan, "Toastmaster")).toMatchObject({ kept: "already" });
		// The slot they hold, so its speech and evaluator link can still come over (R5).
		expect(holderOf(plan, "Toastmaster")?.slotIndex).toBe(0);
	});

	// protects="Add a slot" adds the overflow count after the highest existing index and places as many holders as there are empty slots;
	// fails_when=the added slot reuses an index, or the overflow is miscounted;
	// no_claim=the insert.
	it("adds a slot for a holder over the template's count", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(empty(DEF.timer, 0)),
			}),
		);
		expect(holderOf(plan, "Timer")).toMatchObject({ slotIndex: 0 });
		expect(holderOf(plan, "Timer 2 - Online")).toMatchObject({
			slotIndex: 1,
			addSlot: true,
		});
		expect(plan.upcoming.unslottedRoles).toContainEqual({
			planKey: "std:timer",
			name: "Timer",
			meetings: 1,
			holders: 1,
			skipped: false,
		});
	});

	// protects="Skip" drops the overflow holders, adds no slot and leaves the role in the report as skipped;
	// fails_when=Skip still adds the slot or drops the first holder instead of the last;
	// no_claim=the report row (integration test).
	it("drops the overflow holders of a skipped role without adding a slot", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(empty(DEF.timer, 0)),
				skipUpcomingRoles: new Set(["std:timer"]),
			}),
		);
		expect(holderOf(plan, "Timer")).toMatchObject({ slotIndex: 0 });
		expect(holderOf(plan, "Timer 2 - Online")).toMatchObject({
			kept: "skipped",
		});
		expect(
			upcomingOf(plan).slots.some(
				(s) => s.roleKey === "std:timer" && s.addSlot === true,
			),
		).toBe(false);
		expect(
			plan.upcoming.unslottedRoles.find((r) => r.planKey === "std:timer"),
		).toMatchObject({
			planKey: "std:timer",
			skipped: true,
		});
	});

	// protects=a role with no definition (Joke Master) gets a slot and a new definition when added, and neither when skipped;
	// fails_when=a skipped role still creates a role definition, or an added one has no definition to write;
	// no_claim=the definition's insert.
	it("makes a role definition for an added own role, and none for a skipped one", () => {
		const added = buildImportPlan(
			upcomingOnly(),
			ctx({ existingMeetings: [SAME_DAY_MORNING], upcomingSlots: slotsOf() }),
		);
		expect(holderOf(added, "Joke Master")).toMatchObject({
			roleKey: "own:joke master",
			slotIndex: 0,
			addSlot: true,
		});
		expect(added.roleDefinitions.map((d) => d.planKey)).toContain(
			"own:joke master",
		);
		const skipped = buildImportPlan(
			upcomingOnly(),
			ctx({
				existingMeetings: [SAME_DAY_MORNING],
				upcomingSlots: slotsOf(),
				skipUpcomingRoles: new Set(["own:joke master"]),
			}),
		);
		expect(skipped.roleDefinitions.map((d) => d.planKey)).not.toContain(
			"own:joke master",
		);
		expect(holderOf(skipped, "Joke Master")).toMatchObject({ kept: "skipped" });
		expect(skipped.counts.newRoleDefinitions).toBeLessThan(
			added.counts.newRoleDefinitions,
		);
	});
});

describe("upcoming people, RSVPs and counts (#1495)", () => {
	const holderKeys = (b: EasySpeakBundleV1, label: string) => {
		const holder = meeting360(b).roles.find((r) => r.role === label)?.holder;
		if (!holder) throw new Error(`no ${label}`);
		return personKeyOf(holder);
	};

	// protects=unticked, the plan still shows what ticking would do but writes no upcoming meeting and touches nobody; ticked, the meetings join the plan;
	// fails_when=unticked puts an upcoming meeting or person in the plan, or ticked leaves them out;
	// no_claim=the apply.
	it("previews the upcoming meetings either way and writes them only when ticked", () => {
		const bundle = upcomingOnly();
		const oakley = holderKeys(bundle, "Timer");
		const off = buildImportPlan(bundle, ctx({ importUpcoming: false }));
		expect(off.meetings).toEqual([]);
		expect(off.people.map((p) => p.key)).not.toContain(oakley);
		expect(off.counts.futureMeetingsSkipped).toBe(1);
		expect(off.upcoming).toMatchObject({ included: false, toCreate: 1 });
		expect(off.upcoming.roleAssignments).toBeGreaterThan(0);
		const on = buildImportPlan(bundle, ctx());
		expect(on.meetings.map((m) => m.esMeetingId)).toEqual(["644360"]);
		expect(on.people.map((p) => p.key)).toContain(oakley);
		expect(on.upcoming.included).toBe(true);
		expect(on.counts.futureMeetingsSkipped).toBe(0);
		expect(on.counts.meetings).toBe(1);
		expect(on.counts.roleAssignments).toBe(on.upcoming.roleAssignments);
	});

	// protects=an attending or not-attending RSVP maps to coming or not_coming once per person; tentative and unknown write nothing;
	// fails_when=unknown is written, a person is counted twice, or the mapping is swapped;
	// no_claim=that an answer already in GavelUp is kept (the seam fills only what is absent).
	it("maps RSVPs to coming and not_coming, and leaves unknown out", () => {
		const bundle = upcomingOnly();
		const plan = buildImportPlan(bundle, ctx());
		const plans = upcomingOf(plan).plans;
		const row = meeting360(bundle).attendance.find(
			(a) => a.who.name === "Zephyr Ashlowe",
		);
		const ashlowe = plans.find(
			(p) =>
				p.personKey === personKeyOf(row?.who ?? { esUserId: null, name: "" }),
		);
		expect(ashlowe?.status).toBe("coming");
		expect(plans.filter((p) => p.status === "coming")).toHaveLength(6);
		expect(plans.filter((p) => p.status === "not_coming")).toHaveLength(4);
		// "Up to": only the replies of people who resolve to an active member (3 of
		// the 10 are on the roster), never a guest or an unresolved name (R8).
		expect(plan.upcoming.rsvps).toBe(3);
		expect(new Set(plans.map((p) => p.personKey)).size).toBe(plans.length);
	});

	// protects=an upcoming-only holder goes through the same person ladder: an ambiguous name blocks the apply when ticked and is not asked about when unticked;
	// fails_when=an upcoming holder is never resolved, or is resolved while unticked;
	// no_claim=the other outcomes of the ladder, covered by the past tests.
	it("resolves an upcoming-only ambiguous holder only when ticked", () => {
		const bundle = upcomingOnly();
		meeting360(bundle).roles.push({
			role: "Ah Master",
			slot: 99,
			holder: { esUserId: "999001", name: "Quinn Marsh" },
		});
		const roster = [
			...ROSTER,
			{ memberId: id(5), name: "Quinn Marsh" },
			{ memberId: id(6), name: "Quinn Marsh" },
		];
		const on = buildImportPlan(bundle, ctx({ roster }));
		expect(on.unresolved.map((p) => p.key)).toContain("es:999001");
		expect(on.canApply).toBe(false);
		const off = buildImportPlan(bundle, ctx({ roster, importUpcoming: false }));
		expect(off.people.map((p) => p.key)).not.toContain("es:999001");
		expect(off.canApply).toBe(true);
	});

	// protects=a holder of a role the admin skipped names nobody: no person is made for them;
	// fails_when=the skipped role's holder is still resolved and created;
	// no_claim=a skipped role's partial overflow, whose holders are resolved with the rest.
	it("touches no one for a skipped role", () => {
		const bundle = upcomingOnly();
		const joke = holderKeys(bundle, "Joke Master");
		const kept = buildImportPlan(bundle, ctx());
		const rolesOf = (plan: ReturnType<typeof buildImportPlan>) =>
			plan.people.find((p) => p.key === joke)?.appearances.roles ?? 0;
		expect(rolesOf(kept)).toBe(1);
		const skipped = buildImportPlan(
			bundle,
			ctx({ skipUpcomingRoles: new Set(["own:joke master"]) }),
		);
		// The person is still on Easy-Speak's member list; no role touches them.
		expect(rolesOf(skipped)).toBe(0);
	});
});

describe("the reconciliation reads upcoming meetings (#1495)", () => {
	// protects=with upcoming included the report expects the upcoming meetings and their role holders, and without it the bundle's past-only numbers are unchanged;
	// fails_when=the flag is ignored in either direction;
	// no_claim=what the apply wrote (integration test).
	it("expects upcoming meetings and roles only when they were included", () => {
		const bundle = upcomingOnly();
		const without = expectedFromBundle(bundle, NOW, "America/Los_Angeles");
		expect(without.meetings).toEqual([]);
		expect(without.roleAssignments).toEqual([]);
		const withUpcoming = expectedFromBundle(
			bundle,
			NOW,
			"America/Los_Angeles",
			new Set(),
			true,
		);
		expect(withUpcoming.meetings).toEqual(["644360"]);
		expect(withUpcoming.roleAssignments).toHaveLength(15);
		expect(withUpcoming.attendance).toEqual([]);
	});

	// protects=the "Future meetings" not-imported row stays when upcoming meetings were not imported and goes when they were;
	// fails_when=the row is shown beside an import of the same meetings, or dropped when they were not imported;
	// no_claim=the omission rows that replace it (integration test).
	it("drops the Future meetings row once upcoming meetings are imported", () => {
		const bundle = upcomingOnly();
		const names = (include: boolean) =>
			notImportedFromBundle(
				bundle,
				NOW,
				"America/Los_Angeles",
				new Set(),
				include,
			).map((r) => r.what);
		expect(names(false)).toContain("Future meetings");
		expect(names(true)).not.toContain("Future meetings");
	});
});

const holderKey = (b: EasySpeakBundleV1, label: string) => {
	const holder = meeting360(b).roles.find((r) => r.role === label)?.holder;
	if (!holder) throw new Error(`no ${label}`);
	return personKeyOf(holder);
};
const planSlotOf = (
	plan: ReturnType<typeof buildImportPlan>,
	label: string,
) => upcomingOf(plan).slots.find((sl) => sl.label === label);

describe("a role the admin skipped drops only the overflow (#1495 S1)", () => {
	// protects=Skip drops the LAST `overflow` holders only: the one the template has a slot for is resolved and placed, the overflow holder is resolved by nobody and reported as skipped;
	// fails_when=every holder of a skipped role is dropped (the in-slot holder is never resolved and silently lost at the apply);
	// no_claim=the apply's omission rows (integration test).
	it("resolves and places the in-slot holder, drops the overflow one", () => {
		const bundle = upcomingOnly();
		const oakley = holderKey(bundle, "Timer");
		const val = holderKey(bundle, "Timer 2 - Online");
		const plan = buildImportPlan(
			bundle,
			ctx({
				newMeetingShape: [
					{ roleDefinitionId: DEF.toastmaster, count: 1 },
					{ roleDefinitionId: DEF.timer, count: 1 },
				],
				skipUpcomingRoles: new Set(["std:timer"]),
			}),
		);
		// Val also sits on the mentor chart, so they are a person either way:
		// what the skipped overflow holder lacks is the ROLE appearance.
		const rolesOf = (key: string) =>
			plan.people.find((p) => p.key === key)?.appearances.roles ?? 0;
		expect(rolesOf(oakley)).toBeGreaterThan(0);
		expect(rolesOf(val)).toBe(0);
		expect(planSlotOf(plan, "Timer")).toMatchObject({ slotIndex: 0 });
		expect(planSlotOf(plan, "Timer")?.kept).toBeUndefined();
		expect(planSlotOf(plan, "Timer 2 - Online")).toMatchObject({
			kept: "skipped",
		});
	});
});

describe("who an upcoming role may be given to (#1495 R2)", () => {
	// protects=a person only an upcoming meeting names, whom nobody lists, is not minted as a former member for it;
	// fails_when=the old "signalled -> former" rule applies to an upcoming role;
	// no_claim=the same person named by a PAST meeting (the past tests: they are still created).
	it("does not create a former member for an upcoming-only holder", () => {
		const bundle = upcomingOnly();
		const plan = buildImportPlan(bundle, ctx());
		const oakley = plan.people.find((p) => p.key === holderKey(bundle, "Timer"));
		expect(oakley?.outcome.status).toBe("unmatched");
		// The former members that remain are minted by the member list, never by
		// an upcoming role.
		for (const p of plan.people) {
			if (p.outcome.status === "create" && p.outcome.membership === "former") {
				expect(p.appearances.memberList).toBeGreaterThan(0);
			}
		}
		expect(oakley?.appearances.memberList).toBe(0);
	});

	// protects=an inactive member holding an upcoming role is not placed and the slot stays for someone else;
	// fails_when=the roster's status is ignored;
	// no_claim=a member who goes inactive between the plan and the apply (the apply re-reads the status).
	it("keeps an inactive member out of the lineup", () => {
		const plan = buildImportPlan(
			upcomingOnly(),
			ctx({
				roster: [
					{ memberId: id(1), name: "Zéphyr Ashlowe", active: false },
					{ memberId: id(2), name: "Kai Larkspur" },
				],
			}),
		);
		expect(planSlotOf(plan, "Toastmaster")).toMatchObject({ kept: "inactive" });
		// Their RSVP is not counted either: Zephyr's is one of the three.
		expect(plan.upcoming.rsvps).toBe(2);
	});
});

describe("placeRoleHolders (#1495 section 3)", () => {
	const slot = (slotIndex: number, memberId?: string): PlanTargetSlot => ({
		roleDefinitionId: DEF.timer,
		slotIndex,
		holder: memberId ? { memberId } : null,
	});
	// protects=a holder who already holds a slot is `already` on THAT slot and consumes no empty one;
	// fails_when=they are placed again or reported on index -1;
	// no_claim=the write.
	it("puts an already-holder on the slot they hold", () => {
		const out = placeRoleHolders(
			[{ ownerId: "m:a" }, { ownerId: "m:b" }],
			[slot(0, "a"), slot(1)],
			false,
		);
		expect(out.placements).toEqual([
			{ index: 0, kept: "already" },
			{ index: 1, addSlot: false },
		]);
	});
	// protects="Skip" drops the last overflow holders, "Add a slot" appends after the highest index;
	// fails_when=the wrong holders are dropped or an index is reused;
	// no_claim=none beyond protects.
	it("skips the last overflow holders or adds slots after the highest index", () => {
		const holders = [{ ownerId: null }, { ownerId: null }, { ownerId: null }];
		const mine = [slot(0), slot(1)];
		expect(placeRoleHolders(holders, mine, true).placements).toEqual([
			{ index: 0, addSlot: false },
			{ index: 1, addSlot: false },
			{ index: -1, kept: "skipped" },
		]);
		expect(placeRoleHolders(holders, mine, false).placements).toEqual([
			{ index: 0, addSlot: false },
			{ index: 1, addSlot: false },
			{ index: 2, addSlot: true },
		]);
	});
	// protects=a holder with no empty slot left is `taken`: nobody is moved;
	// fails_when=a held slot is handed to the holder;
	// no_claim=none beyond protects.
	it("reports a holder with no empty slot as taken", () => {
		const out = placeRoleHolders(
			[{ ownerId: null }],
			[slot(0, "x"), slot(1, "y")],
			false,
		);
		expect(out.placements).toEqual([{ index: -1, kept: "taken" }]);
	});
});
