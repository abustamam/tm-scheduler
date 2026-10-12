import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV1 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	type PlanContext,
	type PlanRosterMember,
	personKeyOf,
	personResolutionSchema,
} from "./easy-speak-import-plan";

/**
 * The planner (#1051) is pure, so these run on the extension's "B fixture"
 * bundle with an injected clock: at 2026-10-12 only meeting 644304 is past.
 */
const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const load = (): EasySpeakBundleV1 => JSON.parse(readFileSync(FIXTURE, "utf8"));

const NOW = new Date("2026-10-12T12:00:00Z");
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Roster: most of the meeting by name, two Elliot Dovecotts, an accented Zephyr. */
const ROSTER: PlanRosterMember[] = [
	{ memberId: id(1), name: "Elliot Tansley" },
	{ memberId: id(2), name: "Zéphyr Ashlowe" },
	{ memberId: id(3), name: "Elliot Dovecott" },
	{ memberId: id(4), name: "Elliot Dovecott" },
	{ memberId: id(5), name: "Parker Vexford" },
	{ memberId: id(6), name: "Zephyr Ironvale" },
	{ memberId: id(7), name: "Jules Valewood" },
	{ memberId: id(8), name: "Kai Larkspur" },
	{ memberId: id(9), name: "Wren Mistlewood" },
	{ memberId: id(10), name: "Umber Yarrowby" },
	{ memberId: id(11), name: "Dana Vexford" },
	{ memberId: id(12), name: "Casey Foxglade" },
	{ memberId: id(13), name: "Blair Yarrowby" },
	{ memberId: id(14), name: "Morgan Ravenscar" },
	{ memberId: id(15), name: "Lane Stonebrook" },
	// Avery Alderfinch is deliberately absent: unmatched, not a guest category.
];

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
	now: NOW,
	clubTimezone: "America/Los_Angeles",
	roster: ROSTER,
	roleDefinitions: [],
	guestIds: new Set(),
	existingMeetings: [],
	refs: [],
	...over,
});

/** The fixture with its 2nd Speaker replaced by a guest speaker, Yael Saltmarsh. */
function withGuestSpeaker(): EasySpeakBundleV1 {
	const bundle = load();
	const yael = { esUserId: "900025", name: "Yael Saltmarsh" };
	const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
	const slot = past?.roles.find((r) => r.role === "2nd Speaker");
	if (!past || !slot) throw new Error("fixture changed");
	slot.holder = yael;
	past.guests.push({ who: yael, category: "guest_speaker" });
	return bundle;
}

const outcomeOf = (
	plan: ReturnType<typeof buildImportPlan>,
	esUserId: string,
) => plan.people.find((p) => p.key === `es:${esUserId}`)?.outcome;

describe("buildImportPlan on the B fixture", () => {
	it("imports the one past meeting and counts the future ones as skipped", () => {
		const plan = buildImportPlan(load(), ctx());
		expect(plan.counts.meetings).toBe(1);
		expect(plan.counts.futureMeetingsSkipped).toBe(2);
		expect(plan.meetings.map((m) => m.esMeetingId)).toEqual(["644304"]);
		expect(plan.futureMeetings.map((m) => m.esMeetingId)).toEqual([
			"644360",
			"644363",
		]);
		expect(plan.counts.roleAssignments).toBe(14);
		expect(plan.counts.speeches).toBe(2);
		expect(plan.counts.evaluatorLinks).toBe(2);
		expect(plan.counts.awards).toBe(3);
	});

	it("matches exactly, then by folded name, and flags a name shared by two members", () => {
		const plan = buildImportPlan(load(), ctx());
		expect(outcomeOf(plan, "900057")).toMatchObject({
			status: "member",
			memberId: id(1),
			via: "exact",
		});
		expect(outcomeOf(plan, "900026")).toMatchObject({
			status: "member",
			memberId: id(2),
			via: "folded",
		});
		const ambiguous = outcomeOf(plan, "900005");
		expect(ambiguous?.status).toBe("ambiguous");
		expect(
			ambiguous?.status === "ambiguous" &&
				ambiguous.candidates.map((c) => c.memberId).sort(),
		).toEqual([id(3), id(4)]);
	});

	it("leaves a member-list name that is not on the roster unmatched, never a guest", () => {
		const plan = buildImportPlan(load(), ctx());
		expect(outcomeOf(plan, "900001")?.status).toBe("unmatched");
		expect(plan.unresolved.map((p) => p.key).sort()).toEqual([
			"es:900001",
			"es:900005",
		]);
		expect(plan.canApply).toBe(false);
	});

	it("makes a person only in guest categories a guest, with the kind the category gives", () => {
		const plan = buildImportPlan(withGuestSpeaker(), ctx());
		expect(outcomeOf(plan, "900025")).toMatchObject({
			status: "guest",
			kind: "guest_speaker",
			via: "category",
		});
		expect(outcomeOf(plan, "900060")).toMatchObject({
			status: "guest",
			kind: "visitor",
		});
	});

	it("takes a human's answer for an unresolved person and then allows the apply", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				resolutions: {
					"es:900005": { action: "member", memberId: id(3) },
					"es:900001": { action: "skip", reason: "Not a club member" },
				},
			}),
		);
		expect(outcomeOf(plan, "900005")).toMatchObject({
			status: "member",
			memberId: id(3),
			via: "chosen",
		});
		expect(outcomeOf(plan, "900001")).toMatchObject({ status: "skipped" });
		expect(plan.unresolved).toEqual([]);
		expect(plan.canApply).toBe(true);
	});

	it("does not take an answer naming a member who is not on the roster", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				resolutions: {
					"es:900005": { action: "member", memberId: id(999) },
				},
			}),
		);
		const person = plan.people.find((p) => p.key === "es:900005");
		expect(person?.outcome.status).toBe("ambiguous");
		expect(person?.rejectedChoice).toBe(id(999));
		expect(plan.canApply).toBe(false);
	});

	it("does not let an answer override an automatic match", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				resolutions: { "es:900057": { action: "skip", reason: "no" } },
			}),
		);
		expect(outcomeOf(plan, "900057")).toMatchObject({ status: "member" });
	});

	it("maps the roles to standard keys and gives the club's own roles their own definitions", () => {
		const plan = buildImportPlan(load(), ctx());
		const byKey = new Map(plan.roleDefinitions.map((r) => [r.planKey, r]));
		expect(byKey.get("std:speaker")?.labels).toEqual([
			"1st Speaker",
			"2nd Speaker",
		]);
		expect(byKey.get("std:timer")?.labels).toEqual([
			"Timer",
			"Timer 2 - Online",
		]);
		expect(byKey.get("own:joke master")?.standardKey).toBeNull();
		expect(byKey.get("own:listener")?.name).toBe("Listener");
	});

	it("links each evaluator to the speaker slot it evaluates", () => {
		const plan = buildImportPlan(load(), ctx());
		const slots = plan.meetings[0]?.slots ?? [];
		const first = slots.find((s) => s.label === "1st Evaluator");
		const second = slots.find((s) => s.label === "2nd Evaluator");
		expect(first?.evaluatesEsSlot).toBe(3);
		expect(second?.evaluatesEsSlot).toBe(4);
		expect(slots.find((s) => s.esSlot === 3)?.speech?.title).toBe(
			"Make Your Impact",
		);
		expect(slots.find((s) => s.esSlot === 4)?.speech?.title).toBe(
			"The Career I Never Expected",
		);
	});

	it("a guest speaker's speech sits on a slot held by that same guest", () => {
		const plan = buildImportPlan(withGuestSpeaker(), ctx());
		const slot = plan.meetings[0]?.slots.find((s) => s.esSlot === 4);
		expect(slot?.holderKey).toBe("es:900025");
		expect(slot?.speech?.sourceId).toBe("1472117");
	});

	it("adopts a meeting already at the same instant ", () => {
		const at = new Date("2026-09-23T02:00:00.000Z");
		const adopt = buildImportPlan(
			load(),
			ctx({
				existingMeetings: [
					{
						id: "m-1",
						scheduledAt: at,
					} as PlanContext["existingMeetings"][number],
				],
			}),
		);
		expect(adopt.meetings[0]).toMatchObject({
			action: "adopt",
			existingMeetingId: "m-1",
		});
		expect(adopt.counts.meetingsToAdopt).toBe(1);
		expect(adopt.counts.meetingsToCreate).toBe(0);
	});

	it("imports nothing from a meeting in the future, however the clock moves", () => {
		const plan = buildImportPlan(
			load(),
			ctx({ now: new Date("2026-09-01T00:00:00Z") }),
		);
		expect(plan.meetings).toEqual([]);
		expect(plan.counts.futureMeetingsSkipped).toBe(3);
	});
});

describe("personResolutionSchema", () => {
	it("needs a reason to skip, and strips NUL from it", () => {
		expect(
			personResolutionSchema.safeParse({ action: "skip", reason: "  " })
				.success,
		).toBe(false);
		const parsed = personResolutionSchema.parse({
			action: "skip",
			reason: "a\u0000b",
		});
		expect(parsed).toEqual({ action: "skip", reason: "ab" });
	});

	it("defaults a guest to a visitor", () => {
		expect(personResolutionSchema.parse({ action: "guest" })).toEqual({
			action: "guest",
			kind: "visitor",
		});
	});
});

describe("personKeyOf", () => {
	it("keys by Easy-Speak id, else the folded name", () => {
		expect(personKeyOf({ esUserId: "1", name: "A B" })).toBe("es:1");
		expect(personKeyOf({ esUserId: null, name: " Zéphyr  Ash " })).toBe(
			"name:zephyr ash",
		);
	});
});
