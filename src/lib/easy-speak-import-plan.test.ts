import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV1 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	DEFERRED_ANSWERED_REASON,
	DEFERRED_NAMESAKES_REASON,
	DEFERRED_REJECTED_REASON,
	DEFERRED_UNAVAILABLE_REASON,
	isJsonbSafeText,
	needsDecision,
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

/** The fixture with Avery Alderfinch (an attendance row only, with no reply) given a role. */
function withAveryRole(): EasySpeakBundleV1 {
	const bundle = load();
	bundle.meetings
		.find((m) => m.esMeetingId === "644304")
		?.roles.push({
			role: "Ah-Counter",
			slot: 99,
			holder: { esUserId: "900001", name: "Avery Alderfinch" },
		});
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

	// protects=a person is matched to the roster by exact name, then by folded name, and a name two members share is ambiguous, never guessed;
	// fails_when=the folded pass is skipped, or a shared name is handed to the first member;
	// no_claim=who is created or asked about; the next tests.
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

	// protects=a past person a meeting SIGNALS (a role here) and nobody lists is created as a former member and does not block the apply; only the ambiguous are asked about;
	// fails_when=the person is left unmatched, or asked about, or created active;
	// no_claim=the member-list and guest-category precedence, which are their own tests.
	it("creates a former member for a past person only a meeting names, and asks only about the ambiguous (#1240)", () => {
		const plan = buildImportPlan(withAveryRole(), ctx());
		// Avery Alderfinch is on no list and in no guest category.
		expect(outcomeOf(plan, "900001")).toEqual({
			status: "create",
			membership: "former",
			position: null,
			joinedAt: null,
		});
		expect(plan.unresolved.map((p) => p.key)).toEqual(["es:900005"]);
		expect(plan.canApply).toBe(false);
	});

	/** The fixture with one more person on the past meeting's attendance list only. */
	const withAttendanceOnly = (
		plan: "attending" | "not_attending" | "tentative" | "unknown" | null,
		record: "attended" | "attended_online" | null,
	) => {
		const bundle = load();
		bundle.meetings
			.find((m) => m.esMeetingId === "644304")
			?.attendance.push({
				who: { esUserId: "900777", name: "Ottoline Listedonly" },
				plan,
				record,
			});
		return buildImportPlan(bundle, ctx());
	};

	// protects=the REAL fixture's Avery Alderfinch, a bare attendance row (no reply, no
	// record) on a past meeting and on no list, is not made a former member;
	// fails_when=any attendance row counts as "named by a meeting";
	// no_claim=the apply.
	it("does not create the real fixture's unsignalled attendance row (Avery Alderfinch)", () => {
		const plan = buildImportPlan(load(), ctx());
		expect(outcomeOf(plan, "900001")).toEqual({ status: "unmatched" });
		expect(plan.unresolved.map((p) => p.key)).toEqual(["es:900005"]);
	});

	// protects=a person who is only a row on the attendance list with no reply and no
	// record (a guest-section visitor with "Unknown") is not made a former member:
	// matched when the roster has them, else left alone and not asked about;
	// fails_when=any attendance row counts as "named by a meeting";
	// no_claim=what a recorded attendance imports, the integration suite's.
	it.each([
		["unknown", "unknown", null],
		["not_attending", "not_attending", null],
		["no plan and no record", null, null],
		["a tentative reply (never imported as attendance)", "tentative", null],
	] as const)("does not create a former member from an unsignalled attendance row (%s)", (_label, planAnswer, record) => {
		const plan = withAttendanceOnly(planAnswer, record);
		expect(outcomeOf(plan, "900777")).toEqual({ status: "unmatched" });
		expect(plan.unresolved.map((p) => p.key)).not.toContain("es:900777");
		expect(plan.counts.newFormerMembers).toBe(
			buildImportPlan(load(), ctx()).counts.newFormerMembers,
		);
	});

	// protects=an attendance row with a record, or an attending reply, is
	// a real meeting signal: the unlisted person is still a former member;
	// fails_when=the signal test drops a kind of row;
	// no_claim=the unsignalled rows, above.
	it.each([
		["a record", null, "attended"],
		["an online record", null, "attended_online"],
		["an attending reply", "attending", null],
	] as const)("still creates a former member from %s", (_label, planAnswer, record) => {
		const plan = withAttendanceOnly(planAnswer, record);
		expect(outcomeOf(plan, "900777")).toMatchObject({
			status: "create",
			membership: "former",
		});
	});

	// protects=a role, an award, Table Topics or an introducer link each count as a
	// meeting signal for an unlisted person;
	// fails_when=the signal test names only some of them;
	// no_claim=the attendance rows, above.
	it.each([
		[
			"a role",
			(b: EasySpeakBundleV1, who: { esUserId: string; name: string }) => {
				b.meetings[0]?.roles.push({
					role: "Ah-Counter",
					slot: 98,
					holder: who,
				});
			},
		],
		[
			"an award",
			(b: EasySpeakBundleV1, who: { esUserId: string; name: string }) => {
				b.meetings[0]?.awards.push({ category: "best_speaker", who });
			},
		],
		[
			"Table Topics",
			(b: EasySpeakBundleV1, who: { esUserId: string; name: string }) => {
				b.meetings[0]?.tableTopics.push({ who, topic: null });
			},
		],
		[
			"an introducer link",
			(b: EasySpeakBundleV1, who: { esUserId: string; name: string }) => {
				b.visitorsIntroduced.push({
					visitor: { esUserId: "900778", name: "Some Visitor" },
					introducedBy: who,
				});
			},
		],
	] as const)("counts %s as a meeting signal", (_label, add) => {
		const bundle = load();
		const who = { esUserId: "900777", name: "Ottoline Listedonly" };
		add(bundle, who);
		expect(outcomeOf(buildImportPlan(bundle, ctx()), "900777")).toMatchObject({
			status: "create",
			membership: "former",
		});
	});

	// protects=an unsignalled attendance-only person is still matched to the roster
	// by name, as a list-only person is;
	// fails_when=the match is skipped for a person with no signal;
	// no_claim=creation.
	it("matches an unsignalled attendance-only person to the roster", () => {
		const bundle = load();
		bundle.meetings
			.find((m) => m.esMeetingId === "644304")
			?.attendance.push({
				who: { esUserId: "900777", name: "Ottoline Listedonly" },
				plan: "unknown",
				record: null,
			});
		const plan = buildImportPlan(
			bundle,
			ctx({
				roster: [...ROSTER, { memberId: id(40), name: "Ottoline Listedonly" }],
			}),
		);
		expect(outcomeOf(plan, "900777")).toEqual({
			status: "member",
			memberId: id(40),
			via: "exact",
		});
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

	// protects=a saved skip beats the roster match the plan would make (precedence 1);
	// fails_when=the automatic match is applied over the saved answer;
	// no_claim=a saved guest answer over a ref, which is the integration re-apply test.
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

	// protects=a vanished ref to a member the import did NOT create falls back to the name and is created when the name finds nobody; one the import created is a tombstone;
	// fails_when=a vanished ref is trusted, or an import-created member the club removed is re-created (an admin with a term);
	// no_claim=the apply writes, which the integration suite covers.
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
			withAveryRole(),
			ctx({
				refs: [{ kind: "person", sourceId: "es:900001", targetId: "gone" }],
			}),
		);
		expect(outcomeOf(asks, "900001")).toMatchObject({ status: "create" });
		expect(asks.unresolved.map((p) => p.key)).not.toContain("es:900001");
	});

	// protects=a vanished ref to a member an earlier apply created is a tombstone
	// (never re-created, never asked about), and only when the import made them;
	// fails_when=the tombstone is dropped, or applied to any vanished member ref;
	// no_claim=the removal itself is the integration suite's.
	it("treats a vanished ref to an import-created member as a tombstone", () => {
		const refs = [{ kind: "person", sourceId: "es:900001", targetId: "gone" }];
		const made = buildImportPlan(
			load(),
			ctx({ refs, removedMemberIds: new Set(["gone"]) }),
		);
		expect(outcomeOf(made, "900001")).toEqual({ status: "deleted" });
		expect(made.unresolved.map((p) => p.key)).not.toContain("es:900001");
	});

	const dupeBundle = (extraListed: boolean) => {
		const bundle = load();
		bundle.people = [
			{
				esUserId: "900901",
				name: "Dupe Person",
				status: "Member",
				joined: null,
			},
			...(extraListed
				? [
						{
							esUserId: "900902",
							name: "Dupe Person",
							status: "Member",
							joined: null,
						},
					]
				: []),
		];
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		if (!past) throw new Error("fixture changed");
		past.guests = [];
		past.roles = [
			{
				role: "Timer",
				slot: 1,
				holder: { esUserId: null, name: "dupe person" },
			},
		];
		return bundle;
	};
	const dupesOf = (plan: ReturnType<typeof buildImportPlan>) =>
		plan.people.filter((p) => p.name.toLowerCase() === "dupe person");

	// protects=one list entry plus a name-only meeting reference folding to one name
	// is one human: one create, the reference joined to it, never blocked;
	// fails_when=both are created, or both are made ambiguous with no way out;
	// no_claim=the writer's use of mergedKeys, the integration suite's.
	it("merges a name-only reference into the one list entry that folds to its name", () => {
		const plan = buildImportPlan(dupeBundle(false), ctx());
		const dupes = dupesOf(plan);
		expect(dupes).toHaveLength(1);
		expect(dupes[0]?.key).toBe("es:900901");
		expect(dupes[0]?.outcome).toMatchObject({
			status: "create",
			mergedKeys: [personKeyOf({ esUserId: null, name: "dupe person" })],
		});
		expect(dupes[0]?.appearances.roles).toBe(1);
		expect(plan.unresolved.map((p) => p.name)).not.toContain("dupe person");
	});

	const nameOnlyKey = personKeyOf({ esUserId: null, name: "dupe person" });

	// protects=two DISTINCT Easy-Speak ids with one name stay two creates (two
	// namesakes), and the name-only reference is DEFERRED: not blocking, not an
	// answer, nothing imported for it this time (the next preview asks, with both
	// as candidates, once the namesakes are on the roster);
	// fails_when=the reference is made ambiguous with no candidates (a dead end), merged onto one
	// namesake, or left blocking the apply;
	// no_claim=the apply and the next preview, the integration suite's.
	it("defers a name-only reference beside two es: namesakes, blocking nothing", () => {
		const plan = buildImportPlan(dupeBundle(true), ctx());
		const dupes = dupesOf(plan);
		expect(dupes.map((d) => d.key).sort()).toEqual(
			[nameOnlyKey, "es:900901", "es:900902"].sort(),
		);
		for (const d of dupes) {
			if (d.key === nameOnlyKey) {
				expect(d.outcome).toEqual({
					status: "skipped",
					reason: DEFERRED_NAMESAKES_REASON,
				});
				expect(needsDecision(d)).toBe(false);
			} else {
				expect(d.outcome.status).toBe("create");
				expect(d.outcome).not.toHaveProperty("mergedKeys");
			}
		}
		expect(plan.unresolved.map((p) => p.key)).not.toContain(nameOnlyKey);
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain("dupe person");
		expect(plan.notes[0]).toMatch(/more than one person/u);
	});

	// protects=an UNLISTED es: meeting holder is the one create a same-name name-only
	// reference joins: never two Persons for one human;
	// fails_when=the merge needs a member-list row, so both are created;
	// no_claim=the list-entry case, covered above.
	it("merges a name-only reference into an unlisted es: holder", () => {
		const bundle = dupeBundle(false);
		bundle.people = [];
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		if (!past) throw new Error("fixture changed");
		past.roles.push({
			role: "Ah-Counter",
			slot: 1,
			holder: { esUserId: "900903", name: "Dupe Person" },
		});
		const dupes = dupesOf(buildImportPlan(bundle, ctx()));
		expect(dupes).toHaveLength(1);
		expect(dupes[0]?.key).toBe("es:900903");
		expect(dupes[0]?.outcome).toMatchObject({
			status: "create",
			mergedKeys: [personKeyOf({ esUserId: null, name: "dupe person" })],
		});
	});

	// protects=one listed plus one unlisted es: namesake is two humans: the name-only
	// reference is deferred, not guessed onto the listed one;
	// fails_when=the merge picks the single listed entry whatever else shares the name;
	// no_claim=resolution of the ambiguity.
	it("defers a name-only reference beside a listed and an unlisted es: namesake", () => {
		const bundle = dupeBundle(false);
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		if (!past) throw new Error("fixture changed");
		past.roles.push({
			role: "Ah-Counter",
			slot: 1,
			holder: { esUserId: "900903", name: "Dupe Person" },
		});
		const plan = buildImportPlan(bundle, ctx());
		const dupes = dupesOf(plan);
		expect(dupes).toHaveLength(3);
		expect(dupes.find((d) => d.key === nameOnlyKey)?.outcome).toEqual({
			status: "skipped",
			reason: DEFERRED_NAMESAKES_REASON,
		});
		for (const k of ["es:900901", "es:900903"]) {
			const o = dupes.find((d) => d.key === k)?.outcome;
			expect(o?.status).toBe("create");
			expect(o).not.toHaveProperty("mergedKeys");
		}
		expect(plan.notes).toHaveLength(1);
	});

	// protects=a saved answer on the one es: create keeps the fold off: the name-only
	// reference is deferred, never merged under an answer that may mean "not this one";
	// fails_when=the fold ignores a saved answer on the target;
	// no_claim=the apply.
	it("defers a name-only reference when the one es: create has a saved answer", () => {
		const plan = buildImportPlan(
			dupeBundle(false),
			ctx({
				resolutions: { "es:900901": { action: "guest", kind: "visitor" } },
			}),
		);
		const dupes = dupesOf(plan);
		expect(dupes).toHaveLength(2);
		expect(dupes.find((d) => d.key === nameOnlyKey)?.outcome).toEqual({
			status: "skipped",
			reason: DEFERRED_ANSWERED_REASON,
		});
		const target = dupes.find((d) => d.key === "es:900901");
		expect(target?.outcome.status).toBe("create");
		expect(target?.outcome).not.toHaveProperty("mergedKeys");
		expect(target?.listOnly).toBe(true);
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain(
			"dupe person: the name matches a person on Easy-Speak's member list who has a saved answer",
		);
	});

	// protects=a saved answer on the NAME-ONLY key keeps its answered outcome and
	// the es: create stays a plain create (nothing to fold, nothing deferred);
	// fails_when=the answered key is overwritten, or merged away;
	// no_claim=the apply.
	it("keeps an answered name-only reference's outcome and folds nothing", () => {
		const plan = buildImportPlan(
			dupeBundle(false),
			ctx({
				resolutions: { [nameOnlyKey]: { action: "skip", reason: "Not them." } },
			}),
		);
		const dupes = dupesOf(plan);
		expect(dupes.find((d) => d.key === nameOnlyKey)?.outcome).toEqual({
			status: "skipped",
			reason: "Not them.",
		});
		expect(dupes.find((d) => d.key === "es:900901")?.outcome).toMatchObject({
			status: "create",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=a name-only key whose saved answer was REJECTED (a member the roster
	// no longer holds) keeps outcome `create` but is an answered key: it is DEFERRED
	// beside the one es: create, never left to make a second Person for one human;
	// fails_when=an answered name-only create is dropped from the group, so it is
	// neither folded nor deferred;
	// no_claim=what the panel shows for the rejected choice.
	it("defers a name-only key with a rejected saved answer, keeping the rejected choice", () => {
		const plan = buildImportPlan(
			dupeBundle(false),
			ctx({
				resolutions: {
					[nameOnlyKey]: { action: "member", memberId: id(999) },
				},
			}),
		);
		const dupes = dupesOf(plan);
		const deferred = dupes.find((d) => d.key === nameOnlyKey);
		expect(deferred?.outcome).toEqual({
			status: "skipped",
			reason: DEFERRED_REJECTED_REASON,
		});
		expect(deferred?.rejectedChoice).toBe(id(999));
		if (!deferred) throw new Error("fixture changed");
		expect(needsDecision(deferred)).toBe(false);
		const target = dupes.find((d) => d.key === "es:900901");
		expect(target?.outcome.status).toBe("create");
		expect(target?.outcome).not.toHaveProperty("mergedKeys");
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain("dupe person");
		expect(plan.notes[0]).toMatch(/saved answer for this name/u);
	});

	// protects=an es: create alone, and a name-only person alone, are plain creates
	// with no note;
	// fails_when=the deferral touches a group with nothing to fold;
	// no_claim=the apply.
	it("makes a plain create of an es: entry alone and of a name-only former member alone", () => {
		const alone = dupeBundle(false);
		const past = alone.meetings.find((m) => m.esMeetingId === "644304");
		if (!past) throw new Error("fixture changed");
		past.roles = [];
		const plan = buildImportPlan(alone, ctx());
		expect(dupesOf(plan).map((d) => d.outcome.status)).toEqual(["create"]);
		expect(plan.notes).toEqual([]);
		const names = dupeBundle(false);
		names.people = [];
		const plan2 = buildImportPlan(names, ctx());
		expect(dupesOf(plan2)).toHaveLength(1);
		expect(dupesOf(plan2)[0]?.outcome).toMatchObject({
			status: "create",
			membership: "former",
		});
		expect(plan2.notes).toEqual([]);
	});

	// protects=a saved "guest" answer uses the live guest a ref names even when the
	// person's member ref still names a live member;
	// fails_when=the guest id is kept only when the automatic outcome is a guest;
	// no_claim=the apply, covered by the integration suite.
	it("a saved guest answer keeps the live guest ref beside a live member ref", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				refs: [
					{ kind: "person", sourceId: "es:900057", targetId: id(1) },
					{ kind: "guest", sourceId: "es:900057", targetId: "guest-1" },
				],
				guestIds: new Set(["guest-1"]),
				resolutions: { "es:900057": { action: "guest", kind: "visitor" } },
			}),
		);
		expect(outcomeOf(plan, "900057")).toEqual({
			status: "guest",
			kind: "visitor",
			via: "chosen",
			guestId: "guest-1",
		});
	});

	// protects=a live member ref plus a DELETED guest ref plus a saved "guest"
	// answer does not re-mint the guest the club deleted;
	// fails_when=the member branch hides the guest tombstone from the saved answer;
	// no_claim=the writer.
	it("honours a deleted guest ref beside a live member ref and a saved guest answer", () => {
		const plan = buildImportPlan(
			load(),
			ctx({
				refs: [
					{ kind: "person", sourceId: "es:900057", targetId: id(1) },
					{ kind: "guest", sourceId: "es:900057", targetId: "gone-guest" },
				],
				resolutions: { "es:900057": { action: "guest", kind: "visitor" } },
			}),
		);
		expect(outcomeOf(plan, "900057")).toEqual({
			status: "member",
			memberId: id(1),
			via: "ref",
		});
		// The set-aside answer is shown, naming the person and nothing else.
		const named = plan.people.find((p) => p.key === "es:900057")?.name;
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain(named as string);
		expect(plan.notes[0]).toContain('the saved answer "guest" is set aside');
	});

	// protects=a LIST-ONLY person with a live member ref, a deleted guest ref and a
	// saved "guest" answer is also told the answer is set aside, once;
	// fails_when=the note sits behind the guard that clears a list-only guest answer;
	// no_claim=the apply.
	it("notes a set-aside guest answer for a list-only person too", () => {
		const roster = [
			...ROSTER,
			{ memberId: id(20), name: "Casey Winterbourne" },
		];
		const plan = buildImportPlan(
			load(),
			ctx({
				roster,
				refs: [
					{ kind: "person", sourceId: "es:900029", targetId: id(20) },
					{ kind: "guest", sourceId: "es:900029", targetId: "gone-guest" },
				],
				resolutions: { "es:900029": { action: "guest", kind: "visitor" } },
			}),
		);
		const person = plan.people.find((p) => p.key === "es:900029");
		expect(person?.listOnly).toBe(true);
		expect(person?.outcome).toEqual({
			status: "member",
			memberId: id(20),
			via: "ref",
		});
		const named = plan.notes.filter((n) => n.startsWith(`${person?.name}:`));
		expect(named).toHaveLength(1);
		expect(named[0]).toContain('the saved answer "guest" is set aside');
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

	// protects=a person only the mentor chart or speech requests name, with no roster match, stays unmatched and never blocks;
	// fails_when=the person is created, made a guest, or asked about;
	// no_claim=a person the member list names, which is created.
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

	// protects=a saved answer for an unmatched chart-only person, and a guest answer for a list-only one, are ignored;
	// fails_when=such a saved answer makes a guest or a member of someone no meeting names;
	// no_claim=the same person when a meeting also names them.
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

describe("a name-only reference beside es: people of the same name (#1240)", () => {
	const ES = (n: number) => `es:90092${n}`;
	/** `esNames` are es: people who hold a role; `nName` holds a role with no profile. */
	const nsBundle = (esNames: string[], nName: string) => {
		const bundle = load();
		bundle.people = [];
		const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
		if (!past) throw new Error("fixture changed");
		past.guests = [];
		past.roles = [
			{
				role: "Timer",
				slot: 1,
				holder: { esUserId: null, name: nName },
			},
			...esNames.map((name, i) => ({
				role: "Ah-Counter",
				slot: 2 + i,
				holder: { esUserId: `90092${i}`, name },
			})),
		];
		return bundle;
	};
	const N_KEY = (name: string) => personKeyOf({ esUserId: null, name });
	const RN = (n: number, name: string): PlanRosterMember => ({
		memberId: id(50 + n),
		name,
	});
	const run = (
		bundle: EasySpeakBundleV1,
		over: Partial<PlanContext> = {},
		roster: PlanRosterMember[] = [],
	) =>
		buildImportPlan(bundle, ctx({ roster: [...ROSTER, ...roster], ...over }));
	const person = (plan: ReturnType<typeof buildImportPlan>, key: string) =>
		plan.people.find((p) => p.key === key);

	// protects=one es: person already on the roster (by a ref after a rename, or by an
	// answer) and a name-only create of the same name: the reference LINKS to that
	// member, so no second Person is made after a deferral and a rename;
	// fails_when=the group counts only creates, so the reference is created apart;
	// no_claim=the apply, the integration suite's.
	it.each([
		[
			"a ref after a rename",
			{
				refs: [{ kind: "person" as const, sourceId: ES(0), targetId: id(50) }],
			},
		],
		[
			"a saved member answer",
			{
				resolutions: {
					[ES(0)]: { action: "member" as const, memberId: id(50) },
				},
			},
		],
	])("links a name-only create to the one es: person on the roster through %s", (_label, over) => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), over, [
			RN(0, "Jonathan Smith"),
		]);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(50),
			via: "folded",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=the link needs no answer rule: a rejected answer on the name-only key
	// does not stop it linking to the member the es: person already is;
	// fails_when=the link is gated on "no saved answer";
	// no_claim=the rejectedChoice display.
	it("links even when the name-only key has a rejected saved answer", () => {
		const plan = run(
			nsBundle(["Jon Smith"], "jon smith"),
			{
				refs: [{ kind: "person", sourceId: ES(0), targetId: id(50) }],
				resolutions: {
					[N_KEY("jon smith")]: { action: "member", memberId: id(999) },
				},
			},
			[RN(0, "Jonathan Smith")],
		);
		const n = person(plan, N_KEY("jon smith"));
		expect(n?.outcome).toMatchObject({ status: "member", memberId: id(50) });
		expect(n?.rejectedChoice).toBe(id(999));
	});

	// protects=an es: person who is skipped, a guest, or a tombstone is not a create to
	// fold into, nor a member to link to: the name-only create is DEFERRED;
	// fails_when=such a person drops out of the group and the reference is created apart;
	// no_claim=the wording of the note.
	it.each([
		[
			"skipped",
			{ resolutions: { [ES(0)]: { action: "skip" as const, reason: "No." } } },
		],
		[
			"a guest",
			{
				resolutions: {
					[ES(0)]: { action: "guest" as const, kind: "visitor" as const },
				},
			},
		],
		[
			"a tombstone",
			{
				refs: [
					{ kind: "guest" as const, sourceId: ES(0), targetId: "gone-guest" },
				],
			},
		],
	])("defers a name-only create beside an es: person who is %s", (_label, over) => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), over);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "skipped",
			reason: DEFERRED_UNAVAILABLE_REASON,
		});
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).toContain("jon smith");
	});

	// protects=two es: namesakes who are both on the roster (by ref after a rename, or by
	// answers) make the name-only reference ambiguous between exactly those members;
	// fails_when=the group counts only creates, so the reference is created or linked to one;
	// no_claim=a human's answer to it.
	it.each([
		[
			"refs after renames",
			{
				refs: [
					{ kind: "person" as const, sourceId: ES(0), targetId: id(50) },
					{ kind: "person" as const, sourceId: ES(1), targetId: id(51) },
				],
			},
		],
		[
			"saved member answers",
			{
				resolutions: {
					[ES(0)]: { action: "member" as const, memberId: id(50) },
					[ES(1)]: { action: "member" as const, memberId: id(51) },
				},
			},
		],
	])("asks which of two es: namesakes on the roster the reference is (%s)", (_label, over) => {
		const plan = run(nsBundle(["Jon Smith", "Jon Smith"], "jon smith"), over, [
			RN(0, "Jonathan Smith"),
			RN(1, "Jonny Smith"),
		]);
		const n = person(plan, N_KEY("jon smith"));
		expect(n?.outcome.status).toBe("ambiguous");
		expect(
			n?.outcome.status === "ambiguous" &&
				n.outcome.candidates.map((c) => c.memberId).sort(),
		).toEqual([id(50), id(51)]);
		expect(plan.unresolved.map((p) => p.key)).toContain(N_KEY("jon smith"));
	});

	// protects=spelling and case variants: the name-only reference's exact spelling
	// matches one roster member, but two es: namesakes of that name are on the roster,
	// so it is ambiguous between them, never silently the exact one;
	// fails_when=the exact pass is trusted beside namesakes;
	// no_claim=a name with one es: person.
	it.each([
		["José Doe", "Jose Doe", "Jose Doe"],
		["Ann Lee", "ANN LEE", "Ann Lee"],
	])("is ambiguous between %s and %s even when one spelling matches exactly", (a, b, holder) => {
		const plan = run(nsBundle([a, b], holder), {}, [RN(0, a), RN(1, b)]);
		const n = person(plan, N_KEY(holder));
		expect(n?.outcome.status).toBe("ambiguous");
		expect(
			n?.outcome.status === "ambiguous" &&
				n.outcome.candidates.map((c) => c.memberId).sort(),
		).toEqual([id(50), id(51)]);
	});

	// protects=two es: keys that resolve to ONE member are one person: the reference
	// keeps its own outcome;
	// fails_when=two keys are counted as two humans;
	// no_claim=what its own outcome is.
	it("links the reference to the one member both es: keys are", () => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{
				refs: [
					{ kind: "person", sourceId: ES(0), targetId: id(50) },
					{ kind: "person", sourceId: ES(1), targetId: id(50) },
				],
			},
			[RN(0, "Jonathan Smith")],
		);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(50),
			via: "folded",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=one namesake on the roster and one still a create (or skipped) is not
	// enough to ask: the reference is DEFERRED, whether it was a create or matched a
	// roster member by name;
	// fails_when=the reference is linked or asked about on partial information;
	// no_claim=the later import.
	it.each([
		["a create", {}, DEFERRED_NAMESAKES_REASON],
		[
			"skipped",
			{ resolutions: { [ES(1)]: { action: "skip" as const, reason: "No." } } },
			DEFERRED_UNAVAILABLE_REASON,
		],
	])("defers a create beside one namesake on the roster and one who is %s", (_label, extra, reason) => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{
				refs: [{ kind: "person", sourceId: ES(0), targetId: id(50) }],
				...extra,
			},
			[RN(0, "Jonathan Smith")],
		);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "skipped",
			reason,
		});
	});

	// protects=a reference that matched a roster member by name keeps that member
	// when a namesake is not a roster member (skipped here): deferring a correct match
	// dropped its history for good;
	// fails_when=rule B defers a name-matched reference;
	// no_claim=the namesake's own outcome.
	it("keeps a reference that matched a roster member by name beside a namesake who is skipped", () => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{
				refs: [{ kind: "person", sourceId: ES(0), targetId: id(50) }],
				resolutions: { [ES(1)]: { action: "skip", reason: "No." } },
			},
			[RN(0, "Jonathan Smith"), RN(2, "Jon Smith")],
		);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(52),
			via: "folded",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=a reference that resolved through its own ref, or whose own saved answer
	// took effect, is never touched by the group;
	// fails_when=the group overrides a ref or a human's answer;
	// no_claim=namesakes themselves.
	it("leaves a reference with its own ref or its own accepted answer alone", () => {
		const base = nsBundle(["Jon Smith", "Jon Smith"], "jon smith");
		const viaRef = run(
			base,
			{
				refs: [
					{ kind: "person", sourceId: N_KEY("jon smith"), targetId: id(52) },
				],
			},
			[RN(2, "Someone Else")],
		);
		expect(person(viaRef, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(52),
			via: "ref",
		});
		const answered = run(base, {
			resolutions: { [N_KEY("jon smith")]: { action: "skip", reason: "No." } },
		});
		expect(person(answered, N_KEY("jon smith"))?.outcome).toEqual({
			status: "skipped",
			reason: "No.",
		});
	});

	// -- Rule A: every es: key is a roster member --------------------------------
	const candIds = (plan: ReturnType<typeof buildImportPlan>, key: string) => {
		const o = person(plan, key)?.outcome;
		return o?.status === "ambiguous"
			? o.candidates.map((c) => c.memberId).sort()
			: null;
	};
	const REF_A = {
		kind: "person" as const,
		sourceId: ES(0),
		targetId: id(50),
	};
	const REF_B = {
		kind: "person" as const,
		sourceId: ES(1),
		targetId: id(51),
	};

	// protects=an es: person renamed on the roster while another member holds the old
	// name: the reference is asked between both, never silently the one by name;
	// fails_when=a single es: member links the reference without looking at N's own match;
	// no_claim=the integration suite's next preview.
	it("asks between a renamed es: member and an unrelated member holding the old name", () => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), { refs: [REF_A] }, [
			RN(0, "Jonathan Smith"),
			RN(1, "Jon Smith"),
		]);
		expect(candIds(plan, N_KEY("jon smith"))).toEqual([id(50), id(51)]);
		expect(plan.notes).toEqual([]);
	});

	// protects=N exactly matching C while the es: keys point at A and B: C stays a
	// candidate;
	// fails_when=the |E| >= 2 branch discards N's own exact match;
	// no_claim=a human's answer.
	it("asks among A, B and the member N matched exactly", () => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{ refs: [REF_A, REF_B] },
			[RN(0, "Jonathan Smith"), RN(1, "Jonny Smith"), RN(2, "Jon Smith")],
		);
		expect(candIds(plan, N_KEY("jon smith"))).toEqual([id(50), id(51), id(52)]);
	});

	// protects=N ambiguous between C and D keeps both beside the es: members;
	// fails_when=N's own candidates are dropped;
	// no_claim=a human's answer.
	it("asks among A, B and both candidates N was already ambiguous between", () => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{ refs: [REF_A, REF_B] },
			[
				RN(0, "Jonathan Smith"),
				RN(1, "Jonny Smith"),
				RN(2, "Jon Smith"),
				RN(3, "Jon Smith"),
			],
		);
		expect(candIds(plan, N_KEY("jon smith"))).toEqual([
			id(50),
			id(51),
			id(52),
			id(53),
		]);
	});

	// protects=N's own candidates join U even when ONE es: member is the whole of E;
	// fails_when=the single-member link ignores N's candidates;
	// no_claim=the two-es: case.
	it("asks between one es: member and the two members N was ambiguous between", () => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), { refs: [REF_A] }, [
			RN(0, "Jonathan Smith"),
			RN(2, "Jon Smith"),
			RN(3, "Jon Smith"),
		]);
		expect(candIds(plan, N_KEY("jon smith"))).toEqual([id(50), id(52), id(53)]);
	});

	// protects=a reference whose spellings collided (José / Jose under one key) is not
	// silently linked to the one es: member: it is asked;
	// fails_when=the collision is ignored by the link;
	// no_claim=what the roster holds under the spelling.
	it("asks, not links, a collided-spelling reference beside one es: member", () => {
		const bundle = nsBundle(["Jose Doe"], "José Doe");
		bundle.meetings
			.find((m) => m.esMeetingId === "644304")
			?.roles.push({
				role: "Grammarian",
				slot: 9,
				holder: { esUserId: null, name: "Jose Doe" },
			});
		const plan = run(bundle, { refs: [REF_A] }, [RN(0, "Joseph Doe")]);
		expect(candIds(plan, N_KEY("jose doe"))).toEqual([id(50)]);
	});

	// protects=a reference that already matched the one member every es: key is keeps
	// its own outcome (via exact), not rewritten to a fold link;
	// fails_when=the single-member branch rewrites a name match;
	// no_claim=none.
	it("leaves a reference alone when it matched the one member the es: key is", () => {
		const plan = run(nsBundle(["Jon Smith"], "Jon Smith"), { refs: [REF_A] }, [
			RN(0, "Jon Smith"),
		]);
		expect(person(plan, N_KEY("Jon Smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(50),
			via: "exact",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=a saved member choice on the ambiguous reference stays chosen: the
	// post-pass does not ask again;
	// fails_when=the group overrides via: chosen;
	// no_claim=none.
	it("leaves a reference alone when its own member choice took effect", () => {
		const plan = run(
			nsBundle(["Jon Smith", "Jon Smith"], "jon smith"),
			{
				refs: [REF_A, REF_B],
				resolutions: {
					[N_KEY("jon smith")]: { action: "member", memberId: id(52) },
				},
			},
			[
				RN(0, "Jonathan Smith"),
				RN(1, "Jonny Smith"),
				RN(2, "Jon Smith"),
				RN(3, "Jon Smith"),
			],
		);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(52),
			via: "chosen",
		});
		expect(plan.notes).toEqual([]);
	});

	// -- Rule B: some es: key is not a roster member ------------------------------
	// protects=a reference that matches a roster member by name is left alone when the
	// namesake is a tombstone or a guest (not only skipped): its history is not dropped;
	// fails_when=rule B defers a name-matched reference;
	// no_claim=the namesake's own outcome.
	it.each([
		[
			"a tombstone",
			{
				refs: [
					{ kind: "guest" as const, sourceId: ES(0), targetId: "gone-guest" },
				],
			},
		],
		[
			"a guest",
			{
				resolutions: {
					[ES(0)]: { action: "guest" as const, kind: "visitor" as const },
				},
			},
		],
	])("keeps a name-matched reference beside a namesake who is %s", (_label, over) => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), over, [
			RN(2, "Jon Smith"),
		]);
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "member",
			memberId: id(52),
			via: "folded",
		});
		expect(plan.notes).toEqual([]);
	});

	// protects=an ambiguous reference beside a non-member namesake is left to its own
	// question;
	// fails_when=rule B touches an ambiguous N;
	// no_claim=none.
	it("leaves an ambiguous reference alone beside a namesake who is skipped", () => {
		const plan = run(
			nsBundle(["Jon Smith"], "jon smith"),
			{ resolutions: { [ES(0)]: { action: "skip", reason: "No." } } },
			[RN(2, "Jon Smith"), RN(3, "Jon Smith")],
		);
		expect(candIds(plan, N_KEY("jon smith"))).toEqual([id(52), id(53)]);
		expect(plan.notes).toEqual([]);
	});

	// protects=an es: person named only by a list (never made a Person) leaves the
	// creatable reference a create: nothing is deferred, no note;
	// fails_when=an unmatched es: person defers the reference;
	// no_claim=the apply.
	it("leaves a creatable reference a create beside one unmatched es: person", () => {
		const bundle = nsBundle([], "jon smith");
		bundle.mentors.push({
			mentee: { esUserId: ES(0).slice(3), name: "Jon Smith" },
			mentor: null,
			wantsMentee: false,
		});
		const plan = run(bundle);
		expect(person(plan, ES(0))?.outcome).toEqual({ status: "unmatched" });
		expect(person(plan, N_KEY("jon smith"))?.outcome.status).toBe("create");
		expect(plan.notes).toEqual([]);
	});

	// protects=one es: create with no answer on it or the reference folds;
	// fails_when=the fold is removed;
	// no_claim=the apply's use of mergedKeys.
	it("folds a creatable reference into the one es: create", () => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"));
		expect(person(plan, ES(0))?.outcome).toMatchObject({
			status: "create",
			mergedKeys: [N_KEY("jon smith")],
		});
		expect(person(plan, N_KEY("jon smith"))).toBeUndefined();
		expect(plan.notes).toEqual([]);
	});

	// protects=an es: create plus a removed es: person is not two humans to promise a
	// later match for: the note says only that the records are left out;
	// fails_when=the namesakes note (which promises a later import) is used;
	// no_claim=the wording beyond the promise.
	it("defers with the unavailable note beside an es: create and a removed es: person", () => {
		const plan = run(nsBundle(["Jon Smith", "Jon Smith"], "jon smith"), {
			refs: [{ kind: "guest", sourceId: ES(1), targetId: "gone-guest" }],
		});
		expect(person(plan, N_KEY("jon smith"))?.outcome).toEqual({
			status: "skipped",
			reason: DEFERRED_UNAVAILABLE_REASON,
		});
		expect(plan.notes).toHaveLength(1);
		expect(plan.notes[0]).not.toMatch(/later import/u);
	});

	// protects=the unavailable note promises nothing, the others that promise do so
	// only where an es: person becomes a member this apply;
	// fails_when=the unavailable note says a later import will match or ask;
	// no_claim=none.
	it("keeps the unavailable note free of any promise", () => {
		const plan = run(nsBundle(["Jon Smith"], "jon smith"), {
			resolutions: { [ES(0)]: { action: "skip", reason: "No." } },
		});
		expect(plan.notes[0]).toMatch(/left out of this import/u);
		expect(plan.notes[0]).not.toMatch(/later import|will match|will ask/u);
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
