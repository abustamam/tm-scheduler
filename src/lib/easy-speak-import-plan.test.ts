import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV1 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	isJsonbSafeText,
	type PlanContext,
	type PlanRosterMember,
	personKeyOf,
	personResolutionSchema,
	resolutionsSchema,
	scrubJsonbText,
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

	it("creates a former member for a past person only a meeting names, and asks only about the ambiguous (#1240)", () => {
		const plan = buildImportPlan(load(), ctx());
		// Avery Alderfinch holds a role and is on no list and in no guest category.
		expect(outcomeOf(plan, "900001")).toEqual({
			status: "create",
			membership: "former",
			position: null,
			joinedAt: null,
		});
		expect(plan.unresolved.map((p) => p.key)).toEqual(["es:900005"]);
		expect(plan.canApply).toBe(false);
	});

	// protects=Easy-Speak's "Guest Speaker" section imports as `visiting_toastmaster`
	// (#1208), as does its other-club visitor, and a plain visitor stays `visitor`;
	// fails_when=a guest speaker maps to a kind that is not ours (the retired
	// `guest_speaker`) or to `visitor`;
	// no_claim=the kind is the plan's; whether the apply writes it is the history
	// import integration test's, and the stored bundle's categories are
	// Easy-Speak's own strings in a fixture file.
	it("makes a person only in guest categories a guest, with the kind the category gives", () => {
		const bundle = withGuestSpeaker();
		bundle.meetings
			.find((m) => m.esMeetingId === "644304")
			?.guests.push({
				who: { esUserId: "900099", name: "Quin Otherclub" },
				category: "visitor_other_club",
			});
		const plan = buildImportPlan(bundle, ctx());
		expect(outcomeOf(plan, "900099")).toMatchObject({
			status: "guest",
			kind: "visiting_toastmaster",
		});
		expect(outcomeOf(plan, "900025")).toMatchObject({
			status: "guest",
			kind: "visiting_toastmaster",
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

	it("lets a saved answer win over an automatic match (#1240 precedence 1)", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				resolutions: { "es:900057": { action: "skip", reason: "no" } },
			}),
		);
		expect(outcomeOf(plan, "900057")).toMatchObject({ status: "skipped" });
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

	const AT = new Date("2026-09-23T02:00:00.000Z");
	const existing = (
		over: Partial<PlanContext["existingMeetings"][number]> = {},
	): PlanContext["existingMeetings"][number] => ({
		id: "m-1",
		scheduledAt: AT,
		status: "completed",
		...over,
	});

	it("adopts a COMPLETED meeting already at the same instant", () => {
		const adopt = buildImportPlan(
			load(),
			ctx({ existingMeetings: [existing()] }),
		);
		expect(adopt.meetings[0]).toMatchObject({
			action: "adopt",
			existingMeetingId: "m-1",
		});
		expect(adopt.counts.meetingsToAdopt).toBe(1);
		expect(adopt.counts.meetingsToCreate).toBe(0);
	});

	it.each([
		"scheduled",
		"cancelled",
	])("skips a %s meeting at the same instant and says so (D1)", (status) => {
		const plan = buildImportPlan(
			load(),
			ctx({ existingMeetings: [existing({ status })] }),
		);
		const m = plan.meetings[0];
		expect(m).toMatchObject({
			action: "skip",
			existingMeetingId: null,
			slots: [],
			attendance: [],
			awards: [],
		});
		expect(m?.skip?.kind).toBe("exists");
		expect(m?.skip?.reason).toContain(status);
		expect(plan.counts).toMatchObject({
			meetingsToSkip: 1,
			meetingsToAdopt: 0,
			meetingsToCreate: 0,
			roleAssignments: 0,
		});
		// Nobody it names is asked about: only the visitors-introduced chart is left.
		expect(plan.people.every((p) => p.appearances.roles === 0)).toBe(true);
		expect(plan.people.every((p) => p.appearances.attendance <= 1)).toBe(true);
	});

	it("prefers a completed meeting at the instant over a cancelled one", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				existingMeetings: [
					existing({ id: "m-x", status: "cancelled" }),
					existing({ id: "m-2" }),
				],
			}),
		);
		expect(plan.meetings[0]).toMatchObject({
			action: "adopt",
			existingMeetingId: "m-2",
		});
	});

	it("updates a ref'd completed meeting, and skips one that was rescheduled into the future or is no longer completed", () => {
		const refs = [{ kind: "meeting", sourceId: "644304", targetId: "m-1" }];
		expect(
			buildImportPlan(load(), ctx({ refs, existingMeetings: [existing()] }))
				.meetings[0]?.action,
		).toBe("update");
		const future = buildImportPlan(
			load(),
			ctx({
				refs,
				existingMeetings: [
					existing({
						scheduledAt: new Date("2026-11-01T02:00:00Z"),
						status: "scheduled",
					}),
				],
			}),
		);
		expect(future.meetings[0]?.action).toBe("skip");
		expect(future.meetings[0]?.existingMeetingId).toBeNull();
		const reopened = buildImportPlan(
			load(),
			ctx({ refs, existingMeetings: [existing({ status: "cancelled" })] }),
		);
		expect(reopened.meetings[0]?.action).toBe("skip");
		// Completed but dated after the clock: also left alone.
		const later = buildImportPlan(
			load(),
			ctx({
				refs,
				existingMeetings: [
					existing({ scheduledAt: new Date("2026-11-01T02:00:00Z") }),
				],
			}),
		);
		expect(later.meetings[0]?.skip?.reason).toContain("future");
	});

	it("never re-creates a meeting an earlier import made and a human deleted (D2)", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				refs: [{ kind: "meeting", sourceId: "644304", targetId: "gone" }],
			}),
		);
		expect(plan.meetings[0]).toMatchObject({ action: "skip" });
		expect(plan.meetings[0]?.skip?.kind).toBe("deleted");
		expect(plan.counts.meetingsToCreate).toBe(0);
	});

	it("a person whose imported guest was deleted is a tombstone, never re-created or asked about (D2)", () => {
		const base = buildImportPlan(withGuestSpeaker(), ctx());
		expect(outcomeOf(base, "900025")).toMatchObject({ status: "guest" });
		const gone = buildImportPlan(
			withGuestSpeaker(),
			ctx({
				refs: [{ kind: "guest", sourceId: "es:900025", targetId: "gone" }],
			}),
		);
		expect(outcomeOf(gone, "900025")).toEqual({ status: "deleted" });
		expect(gone.unresolved.map((p) => p.key)).not.toContain("es:900025");
		expect(gone.counts.newGuests).toBe(base.counts.newGuests - 1);
		const memberGone = buildImportPlan(
			load(),
			ctx({
				refs: [{ kind: "person", sourceId: "es:900036", targetId: "gone" }],
			}),
		);
		expect(outcomeOf(memberGone, "900036")).not.toEqual({ status: "deleted" });
	});

	it("a member ref whose member row is gone falls back to the name, and creates the person when the name finds nobody (D4)", () => {
		const matched = buildImportPlan(
			load(),
			ctx({
				refs: [{ kind: "person", sourceId: "es:900036", targetId: "gone" }],
			}),
		);
		expect(outcomeOf(matched, "900036")).toEqual({
			status: "member",
			memberId: id(7),
			via: "exact",
		});
		// Avery Alderfinch is on no roster: a stale ref changes nothing about that.
		const asks = buildImportPlan(
			load(),
			ctx({
				refs: [{ kind: "person", sourceId: "es:900001", targetId: "gone" }],
			}),
		);
		expect(outcomeOf(asks, "900001")).toMatchObject({ status: "create" });
		expect(asks.unresolved.map((p) => p.key)).not.toContain("es:900001");
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

describe("people the lists name and no meeting does (#1203)", () => {
	// Avery Alderfinch matches nobody and the roster has two Elliot Dovecotts, both
	// from a meeting: settle them so the only things left to decide are under test.
	const SKIP_AVERY = {
		"es:900001": { action: "skip", reason: "Not a member." },
		"es:900005": { action: "member", memberId: id(3) },
	} as const;
	const person = (plan: ReturnType<typeof buildImportPlan>, esUserId: string) =>
		plan.people.find((p) => p.key === `es:${esUserId}`);

	it("matches a member-list, mentor-chart and requester person to the roster", () => {
		const roster = [
			...ROSTER,
			{ memberId: id(20), name: "Casey Winterbourne" }, // member list + mentor chart
			{ memberId: id(21), name: "Avery Ivybridge" }, // a mentor, and nothing else
			{ memberId: id(22), name: "Xan Tansley" }, // a requester, and nothing else
		];
		const plan = buildImportPlan(
			load(),
			ctx({ roster, resolutions: SKIP_AVERY }),
		);
		expect(person(plan, "900029")).toMatchObject({
			listOnly: true,
			outcome: { status: "member", memberId: id(20), via: "exact" },
			appearances: { memberList: 1, mentorChart: 1, speechRequests: 0 },
		});
		expect(person(plan, "900027")).toMatchObject({
			listOnly: true,
			outcome: { status: "member", memberId: id(21), via: "exact" },
			appearances: { memberList: 0, mentorChart: 1, speechRequests: 0 },
		});
		expect(person(plan, "900050")).toMatchObject({
			listOnly: true,
			outcome: { status: "member", memberId: id(22), via: "exact" },
			appearances: { speechRequests: 1 },
		});
		// A meeting's person is not list-only, whatever else names them.
		expect(person(plan, "900057")?.listOnly).toBe(false);
		expect(person(plan, "900057")?.appearances.mentorChart).toBe(1);
	});

	it("matches a list-only person by folded name and by an earlier import's ref", () => {
		const roster = [
			...ROSTER,
			{ memberId: id(20), name: "casey WINTERBOURNE" },
			{ memberId: id(23), name: "Someone Else" },
		];
		const plan = buildImportPlan(
			load(),
			ctx({
				roster,
				resolutions: SKIP_AVERY,
				refs: [{ kind: "person", sourceId: "es:900033", targetId: id(23) }],
			}),
		);
		expect(person(plan, "900029")?.outcome).toMatchObject({
			status: "member",
			via: "folded",
		});
		expect(person(plan, "900033")?.outcome).toMatchObject({
			status: "member",
			memberId: id(23),
			via: "ref",
		});
	});

	it("leaves a chart-or-request-only person with no roster match unmatched: never a guest, never blocking", () => {
		const before = buildImportPlan(load(), ctx({ resolutions: SKIP_AVERY }));
		const unmatched = before.people.filter(
			(p) => p.listOnly && p.outcome.status === "unmatched",
		);
		expect(unmatched.map((p) => p.name)).toEqual(
			expect.arrayContaining(["Avery Ivybridge"]),
		);
		// Casey Winterbourne is on the member list, so she is a member to create.
		expect(unmatched.map((p) => p.name)).not.toContain("Casey Winterbourne");
		expect(before.unresolved).toEqual([]);
		expect(before.canApply).toBe(true);
		// None of them is a guest to create, however they are named.
		expect(before.counts.newGuests).toBe(
			buildImportPlan(
				{ ...load(), people: [], mentors: [], speechRequests: [] },
				ctx({ resolutions: SKIP_AVERY }),
			).counts.newGuests,
		);
	});

	it("does not read a saved decision for an unmatched chart-only person, nor a guest choice for a list-only one", () => {
		const roster = [
			...ROSTER,
			{ memberId: id(30), name: "Gray Ashlowe" },
			{ memberId: id(31), name: "Gray Ashlowe" },
		];
		const plan = buildImportPlan(
			load(),
			ctx({
				roster,
				resolutions: {
					...SKIP_AVERY,
					// unmatched, list-only: nothing to decide
					"es:900029": { action: "guest", kind: "visitor" },
					"es:900027": { action: "member", memberId: id(1) },
					// ambiguous, list-only: a guest is not on offer
					"es:900033": { action: "guest", kind: "visitor" },
				},
			}),
		);
		expect(person(plan, "900029")?.outcome.status).toBe("create");
		expect(person(plan, "900027")?.outcome.status).toBe("unmatched");
		expect(person(plan, "900033")?.outcome.status).toBe("ambiguous");
		expect(plan.unresolved.map((p) => p.key)).toEqual(["es:900033"]);
		expect(plan.canApply).toBe(false);
	});

	it("asks for an ambiguous list-only name the way it asks for a meeting's", () => {
		const roster = [
			...ROSTER,
			{ memberId: id(30), name: "Gray Ashlowe" },
			{ memberId: id(31), name: "Gray Ashlowe" },
		];
		const asks = buildImportPlan(
			load(),
			ctx({ roster, resolutions: SKIP_AVERY }),
		);
		const gray = person(asks, "900033");
		expect(gray?.listOnly).toBe(true);
		expect(gray?.outcome).toMatchObject({ status: "ambiguous" });
		expect(asks.unresolved.map((p) => p.key)).toContain("es:900033");
		expect(asks.canApply).toBe(false);

		const answered = buildImportPlan(
			load(),
			ctx({
				roster,
				resolutions: {
					...SKIP_AVERY,
					"es:900033": { action: "member", memberId: id(31) },
				},
			}),
		);
		expect(person(answered, "900033")?.outcome).toMatchObject({
			status: "member",
			memberId: id(31),
			via: "chosen",
		});
		expect(answered.canApply).toBe(true);

		const skipped = buildImportPlan(
			load(),
			ctx({
				roster,
				resolutions: {
					...SKIP_AVERY,
					"es:900033": { action: "skip", reason: "Left the club." },
				},
			}),
		);
		expect(person(skipped, "900033")?.outcome.status).toBe("skipped");
		expect(skipped.canApply).toBe(true);
	});

	it("does not let two spellings of one name-only key share an exact match", () => {
		// "José Silva" and "Jose Silva" fold to one key. The roster holds only José,
		// so the exact pass would match the chart's José and hand him Jose's request.
		const bundle = load();
		bundle.mentors.push({
			mentee: { esUserId: null, name: "José Silva" },
			mentor: null,
			wantsMentee: false,
		});
		bundle.speechRequests.push({
			...bundle.speechRequests[0],
			esSpeechId: "sr-jose",
			who: { esUserId: null, name: "Jose Silva" },
		} as EasySpeakBundleV1["speechRequests"][number]);
		const roster = [...ROSTER, { memberId: id(50), name: "José Silva" }];
		const plan = buildImportPlan(
			bundle,
			ctx({ roster, resolutions: SKIP_AVERY }),
		);
		const silva = plan.people.find((p) => p.key === "name:jose silva");
		expect(silva?.outcome).toMatchObject({ status: "ambiguous" });
		expect(
			silva?.outcome.status === "ambiguous" && silva.outcome.candidates,
		).toEqual([{ memberId: id(50), name: "José Silva" }]);
		expect(plan.unresolved.map((p) => p.key)).toContain("name:jose silva");
		expect(plan.canApply).toBe(false);

		// With both spellings on the roster the human sees both, not the first match.
		const both = buildImportPlan(
			bundle,
			ctx({
				roster: [...roster, { memberId: id(51), name: "Jose Silva" }],
				resolutions: SKIP_AVERY,
			}),
		);
		const bothOutcome = both.people.find(
			(p) => p.key === "name:jose silva",
		)?.outcome;
		expect(
			bothOutcome?.status === "ambiguous" &&
				bothOutcome.candidates.map((c) => c.memberId).sort(),
		).toEqual([id(50), id(51)]);

		// A roster with neither spelling leaves them unmatched, never a guess.
		const none = buildImportPlan(bundle, ctx({ resolutions: SKIP_AVERY }));
		expect(
			none.people.find((p) => p.key === "name:jose silva")?.outcome,
		).toEqual({
			status: "unmatched",
		});
		expect(none.canApply).toBe(true);

		// One spelling, case and spacing aside, still matches on its own.
		const same = load();
		same.mentors.push({
			mentee: { esUserId: null, name: "José Silva" },
			mentor: null,
			wantsMentee: false,
		});
		same.speechRequests.push({
			...same.speechRequests[0],
			esSpeechId: "sr-jose",
			who: { esUserId: null, name: "josé  silva" },
		} as EasySpeakBundleV1["speechRequests"][number]);
		const one = buildImportPlan(same, ctx({ roster, resolutions: SKIP_AVERY }));
		expect(
			one.people.find((p) => p.key === "name:jose silva")?.outcome,
		).toMatchObject({
			status: "member",
			memberId: id(50),
		});
	});

	it("applies the same rule when a meeting and a list spell a name differently", () => {
		const bundle = load();
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		const slot = past?.roles.find((r) => r.role === "2nd Speaker");
		if (!past || !slot) throw new Error("fixture changed");
		slot.holder = { esUserId: null, name: "José Silva" };
		bundle.mentors.push({
			mentee: { esUserId: null, name: "Jose Silva" },
			mentor: null,
			wantsMentee: false,
		});
		const roster = [...ROSTER, { memberId: id(50), name: "José Silva" }];
		const plan = buildImportPlan(
			bundle,
			ctx({ roster, resolutions: SKIP_AVERY }),
		);
		const silva = plan.people.find((p) => p.key === "name:jose silva");
		expect(silva?.listOnly).toBe(false);
		expect(silva?.outcome).toMatchObject({ status: "ambiguous" });
		expect(plan.canApply).toBe(false);
	});

	it("keys a person with no profile id by folded name, so a request finds the ref it needs", () => {
		const bundle = load();
		bundle.mentors.push({
			mentee: { esUserId: null, name: "Nova  Quill" },
			mentor: null,
			wantsMentee: false,
		});
		const plan = buildImportPlan(
			bundle,
			ctx({
				roster: [...ROSTER, { memberId: id(40), name: "Nova Quill" }],
				resolutions: SKIP_AVERY,
			}),
		);
		const nova = plan.people.find((p) => p.key === "name:nova quill");
		expect(nova?.outcome).toMatchObject({ status: "member", memberId: id(40) });
		expect(nova?.key).toBe(personKeyOf({ esUserId: null, name: "Nova Quill" }));
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

describe("a resolutions map saved before #1208", () => {
	// protects=an officer's saved import decisions survive the deploy: a stored
	// map holding the retired `guest_speaker` kind still parses, every entry kept,
	// the old one read as `visiting_toastmaster` (`parseImportState` returns {} for
	// the whole map when the schema fails, which would silently wipe them all);
	// fails_when=the retired kind fails validation, or the map loses an entry;
	// no_claim=the database read in `parseImportState`, which just feeds the stored
	// jsonb to this schema; the stored value is not rewritten.
	it("keeps every entry and reads guest_speaker as visiting_toastmaster", () => {
		const memberId = "2f0f4f5e-6d8b-4c1e-9d0a-1b2c3d4e5f60";
		const stored = {
			"es:1": { action: "member", memberId },
			"es:2": { action: "guest", kind: "guest_speaker" },
			"es:3": { action: "guest", kind: "visitor" },
			"es:4": { action: "skip", reason: "left the club" },
		};
		const parsed = resolutionsSchema.safeParse(stored);
		expect(parsed.success).toBe(true);
		expect(parsed.data).toEqual({
			...stored,
			"es:2": { action: "guest", kind: "visiting_toastmaster" },
		});
	});

	it("still refuses a kind that never existed", () => {
		expect(
			personResolutionSchema.safeParse({ action: "guest", kind: "vip" })
				.success,
		).toBe(false);
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

describe("text that has to survive a jsonb column", () => {
	it("a resolution key or a skip reason with NUL or an unpaired surrogate is refused, and an overlong reason too", () => {
		const skip = { action: "skip", reason: "left the club" } as const;
		expect(resolutionsSchema.safeParse({ "es:1": skip }).success).toBe(true);
		expect(resolutionsSchema.safeParse({ "a\u0000b": skip }).success).toBe(
			false,
		);
		expect(resolutionsSchema.safeParse({ "a\ud800b": skip }).success).toBe(
			false,
		);
		expect(
			personResolutionSchema.safeParse({ action: "skip", reason: "x\ud800" })
				.success,
		).toBe(false);
		expect(
			personResolutionSchema.safeParse({
				action: "skip",
				reason: "x".repeat(501),
			}).success,
		).toBe(false);
		expect(
			personResolutionSchema.safeParse({
				action: "skip",
				reason: "x".repeat(500),
			}).success,
		).toBe(true);
	});

	it("keeps a paired surrogate (an emoji) and scrubs a lone one", () => {
		expect(isJsonbSafeText("ok \u{1F600}")).toBe(true);
		expect(isJsonbSafeText("bad \ud800")).toBe(false);
		expect(isJsonbSafeText("bad \udc00 low")).toBe(false);
		expect(scrubJsonbText("a\u0000b\ud800c")).toBe("ab\uFFFDc");
		// A cut that splits a pair leaves a lone high surrogate: scrubbed, not stored.
		expect(scrubJsonbText("ab\u{1F600}", 3)).toBe("ab\uFFFD");
	});
});
