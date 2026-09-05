/**
 * DB-backed integration tests for `confirmSlotCore` — the two arms of "confirm"
 * (#661).
 *
 * Until #661 `confirmSlot` was `requireUser()` + `requireClubRole(admin)`, so
 * "confirmed" meant *an officer vouched for this person*, never *the person said
 * yes*: there was no member-facing confirm in the product at all. This suite
 * exists to hold the difference, because the two arms are one status flip apart
 * and the thing that separates them — a real `coming` row, and a `grantedVia`
 * that says which arm wrote it — is invisible from `role_slots` alone.
 *
 * ## Why these assertions and not `status === "confirmed"`
 *
 * Both arms leave the slot `confirmed`, so a suite asserting the slot's status
 * passes identically whichever arm ran, and would keep passing with the whole
 * feature deleted. The observables that can actually fail are:
 *
 *  - the `meeting_attendance_plan` ROW (present with `coming` for the holder,
 *    ABSENT for the officer — `row absent = "no answer"`, so this is asserted as
 *    a status/null, never as row presence: an assertion that a row EXISTS passes
 *    for `not_coming` too, i.e. for the regression it would exist to catch);
 *  - what the rail then RENDERS, through the real `buildPlanPanel` /
 *    `buildPanelRoleMap` derivation rather than a restatement of it — `Coming`
 *    for the holder, `Coming · assumed` for the officer. That is the display
 *    difference the issue is about, and it is two modules away from the write;
 *  - `activity_log.detail.grantedVia`, which is the only thing in the feed that
 *    tells an honour-system self-confirm from a session-authenticated vouch.
 *
 * Every case scopes its reads to its own `clubId` and its own meeting: vitest
 * runs test FILES in parallel against one database, and an unscoped `select()`
 * on `activity_log` or `meeting_attendance_plan` reads another suite's in-flight
 * rows. The extra roster member each case needs carries a per-run suffix for the
 * same reason.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/slots-confirm.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetingAttendancePlan,
	meetings,
	members,
	roleSlots,
} from "#/db/schema";
import { buildPanelRoleMap, buildPlanPanel } from "#/lib/attendance-panel";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	confirmSlotCore,
	CONFIRM_NEEDS_SIGN_IN_MESSAGE,
	NOT_THE_SLOT_HOLDER_MESSAGE,
} = await import("./slots-logic");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

/** Exact-string matchers, so a case cannot pass on an unrelated throw. */
const exact = (message: string) => new RegExp(`^${escapeRe(message)}$`);
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.skipIf(!hasTestDb)("confirmSlotCore — holder and officer arms", () => {
	let seed: SeededClub;
	/** A second active roster member who holds NOTHING on this meeting. */
	let otherMemberId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const suffix = randomUUID().slice(0, 8);
		const personId = await seedPerson({ name: `Bystander ${suffix}` });
		const [row] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: `Bystander ${suffix}`,
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!row) throw new Error("Failed to insert the bystander member");
		otherMemberId = row.id;
	});

	afterEach(async () => {
		// Club cascade takes the bystander's `members` row; `cleanup` collects the
		// person ids off this club's members BEFORE the cascade, so the club-less
		// `people` row goes too. No extra `user` rows are created here.
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// -------------------------------------------------------------------------
	// Fixture helpers
	// -------------------------------------------------------------------------

	/** Put `memberId` on the seeded slot as its claimed holder. */
	async function claim(memberId: string, slotId: string = seed.slotId) {
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, slotId));
	}

	/** A second slot on the same meeting, for the before/after refusal pairs. */
	async function extraSlot(): Promise<string> {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex: 1,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		if (!row) throw new Error("Failed to insert the extra slot");
		return row.id;
	}

	async function slotStatus(slotId: string = seed.slotId) {
		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
			.limit(1);
		return row?.status ?? null;
	}

	/** The member's rung, or null for "no answer" (no row) — never row presence. */
	async function planStatus(memberId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(
				and(
					eq(meetingAttendancePlan.memberId, memberId),
					eq(meetingAttendancePlan.meetingId, seed.meetingId),
				),
			)
			.limit(1);
		return row?.status ?? null;
	}

	async function seedRung(memberId: string, status: "coming" | "not_coming") {
		await testDb
			.insert(meetingAttendancePlan)
			.values({ memberId, meetingId: seed.meetingId, status });
	}

	/** This club's activity rows for one action, scoped to this meeting's slot. */
	async function logRows(action: "claim" | "plan_set") {
		return testDb
			.select({ id: activityLog.id, detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, action),
				),
			);
	}

	/**
	 * What the officer's rail actually renders for `memberId`, through the REAL
	 * derivation the meeting page uses — not a restatement of its precedence rule.
	 * `assumed` is the half the issue turns on: an explicit answer makes
	 * `answered` true, which makes `assumed` false.
	 */
	async function railRow(memberId: string) {
		const slots = await testDb
			.select({
				roleDefinitionId: roleSlots.roleDefinitionId,
				slotIndex: roleSlots.slotIndex,
				status: roleSlots.status,
				assigneeId: roleSlots.assignedMemberId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, seed.meetingId));
		const plan = await testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(eq(meetingAttendancePlan.meetingId, seed.meetingId));
		const roster = await testDb
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(eq(members.clubId, seed.clubId));

		const { rows } = buildPlanPanel({
			roster: roster.map((m) => ({ ...m, phone: null, email: null })),
			plan,
			roleByMemberId: buildPanelRoleMap(
				slots.map((s) => ({ ...s, roleName: "Timer" })),
			),
		});
		const row = rows.find((r) => r.id === memberId);
		if (!row) throw new Error("member missing from the rail");
		return row;
	}

	// -------------------------------------------------------------------------
	// The two arms, and the difference between them
	// -------------------------------------------------------------------------

	it("holder confirms: slot confirmed AND a real `coming` row", async () => {
		await claim(seed.memberId);

		const result = await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null, // the public arm takes no session at all
			selfMemberId: seed.memberId,
		});

		expect(result).toEqual({
			ok: true,
			grantedVia: "self",
			planWritten: true,
		});
		expect(await slotStatus()).toBe("confirmed");
		expect(await planStatus(seed.memberId)).toBe("coming");

		// The rail says Coming, with no assumed qualifier: they answered.
		const row = await railRow(seed.memberId);
		expect(row.status).toBe("coming");
		expect(row.assumed).toBe(false);
	});

	it("officer confirms: slot confirmed, NO plan row, rail still assumed", async () => {
		await claim(seed.memberId);

		const result = await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: seed.adminUserId,
			selfMemberId: null,
		});

		expect(result).toEqual({
			ok: true,
			grantedVia: "officer",
			planWritten: false,
		});
		expect(await slotStatus()).toBe("confirmed");
		// Absent, not "coming": nobody answered, and `assumed` is honest about it.
		expect(await planStatus(seed.memberId)).toBeNull();

		const row = await railRow(seed.memberId);
		expect(row.status).toBe("coming");
		expect(row.assumed).toBe(true);
		// The inference comes from the slot, so there is no stored rung behind it.
		expect(row.storedStatus).toBeNull();
	});

	// -------------------------------------------------------------------------
	// The holder guard. This is the whole authorization surface the public arm
	// adds: a self-asserted member id, checked against `assigned_member_id`.
	// -------------------------------------------------------------------------

	it("rejects a member id that is NOT the slot's holder", async () => {
		await claim(seed.memberId);

		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: otherMemberId,
			}),
		).rejects.toThrow(exact(NOT_THE_SLOT_HOLDER_MESSAGE));

		// Refused, and nothing half-landed: the slot is untouched, the impostor got
		// no row, and — the one that matters — no `coming` was put in the HOLDER's
		// mouth by somebody else.
		expect(await slotStatus()).toBe("claimed");
		expect(await planStatus(otherMemberId)).toBeNull();
		expect(await planStatus(seed.memberId)).toBeNull();
		expect(await logRows("claim")).toHaveLength(0);
	});

	it("a failed self-assertion does not fall back to the officer arm", async () => {
		await claim(seed.memberId);

		// A real club ADMIN, asserting somebody else's id. The arm is chosen by the
		// assertion, so this is a failed assertion rather than an officer confirm —
		// falling back would both mask a mistyped member id and file the write
		// under the wrong `grantedVia`.
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: seed.adminUserId,
				selfMemberId: otherMemberId,
			}),
		).rejects.toThrow(exact(NOT_THE_SLOT_HOLDER_MESSAGE));
		expect(await slotStatus()).toBe("claimed");
	});

	it("an OPEN slot is rejected on both arms", async () => {
		// Officer arm keeps the pre-#661 message.
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			}),
		).rejects.toThrow(exact("Only a claimed role can be confirmed."));

		// Holder arm cannot even reach that check: an open slot has no holder, so
		// there is no id that satisfies the assertion.
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: seed.memberId,
			}),
		).rejects.toThrow(exact(NOT_THE_SLOT_HOLDER_MESSAGE));

		expect(await slotStatus()).toBe("open");
	});

	// -------------------------------------------------------------------------
	// The officer arm's own gates, unchanged by #661.
	// -------------------------------------------------------------------------

	it("officer arm still refuses a caller with no session", async () => {
		await claim(seed.memberId);
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: null,
			}),
		).rejects.toThrow(exact(CONFIRM_NEEDS_SIGN_IN_MESSAGE));
		expect(await slotStatus()).toBe("claimed");
	});

	it("officer arm still refuses a signed-in non-admin", async () => {
		await claim(seed.memberId);
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				// The seeded member holds the slot, but is confirming as an OFFICER
				// (no assertion) — which they are not.
				sessionUserId: seed.memberUserId,
				selfMemberId: null,
			}),
		).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
		expect(await slotStatus()).toBe("claimed");
	});

	// -------------------------------------------------------------------------
	// The floor on what a confirm may overwrite.
	// -------------------------------------------------------------------------

	it("holder who previously said not_coming is demoted to coming", async () => {
		await seedRung(seed.memberId, "not_coming");
		await claim(seed.memberId);

		const result = await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null,
			selfMemberId: seed.memberId,
		});

		// Confirming the role after declining is a real change of mind, by the same
		// person, and it wins — `demoteFrom: ["reached_out", "not_coming"]`.
		expect(result.planWritten).toBe(true);
		expect(await planStatus(seed.memberId)).toBe("coming");
		expect((await railRow(seed.memberId)).assumed).toBe(false);
	});

	it("holder already marked coming is not rewritten and logs no second plan_set", async () => {
		await seedRung(seed.memberId, "coming");
		await claim(seed.memberId);

		const result = await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null,
			selfMemberId: seed.memberId,
		});

		// `coming` is deliberately NOT in `demoteFrom`, so the upsert matches
		// nothing. Asserted as the LOG COUNT rather than the status: the status is
		// "coming" either way, so a status assertion passes with the floor deleted.
		expect(result.planWritten).toBe(false);
		expect(await planStatus(seed.memberId)).toBe("coming");
		expect(await logRows("plan_set")).toHaveLength(0);
		expect(await slotStatus()).toBe("confirmed");
	});

	it("an OFFICER confirm never overwrites the member's own not_coming", async () => {
		await seedRung(seed.memberId, "not_coming");
		await claim(seed.memberId);

		await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: seed.adminUserId,
			selfMemberId: null,
		});

		// The officer arm writes no plan row at all, so the member's own answer
		// survives — and the rail keeps showing the decline rather than an inferred
		// Coming, because an explicit answer outranks a confirmed slot.
		expect(await planStatus(seed.memberId)).toBe("not_coming");
		const row = await railRow(seed.memberId);
		expect(row.status).toBe("not_coming");
		expect(row.assumed).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Provenance: the two arms must not look identical in the feed.
	// -------------------------------------------------------------------------

	it("records grantedVia: self, on the confirm AND on the plan row", async () => {
		await claim(seed.memberId);
		await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null,
			selfMemberId: seed.memberId,
		});

		const confirms = await logRows("claim");
		expect(confirms).toHaveLength(1);
		expect(confirms[0]?.detail).toMatchObject({
			confirmed: true,
			grantedVia: "self",
		});

		const plans = await logRows("plan_set");
		expect(plans).toHaveLength(1);
		expect(plans[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: "coming",
			grantedVia: "self",
		});
	});

	it("records grantedVia: officer, and no plan_set beside it", async () => {
		await claim(seed.memberId);
		await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: seed.adminUserId,
			selfMemberId: null,
		});

		const confirms = await logRows("claim");
		expect(confirms).toHaveLength(1);
		expect(confirms[0]?.detail).toMatchObject({
			confirmed: true,
			grantedVia: "officer",
		});
		expect(await logRows("plan_set")).toHaveLength(0);
	});

	it("credits the arm's own actor", async () => {
		await claim(seed.memberId);
		await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null,
			selfMemberId: seed.memberId,
		});
		const [selfRow] = await testDb
			.select({ actorMemberId: activityLog.actorMemberId })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "claim"),
				),
			);
		// The holder, verified against the slot — not the client's word for it.
		expect(selfRow?.actorMemberId).toBe(seed.memberId);

		const other = await extraSlot();
		await claim(otherMemberId, other);
		await confirmSlotCore({
			slotId: other,
			sessionUserId: seed.adminUserId,
			selfMemberId: null,
		});
		const [officerRow] = await testDb
			.select({ actorMemberId: activityLog.actorMemberId })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "claim"),
					eq(activityLog.targetId, other),
				),
			);
		// The resolved admin membership — never the client (#396).
		expect(officerRow?.actorMemberId).toBe(seed.adminMemberId);
	});

	// -------------------------------------------------------------------------
	// Takedown and lock. A BEFORE/AFTER pair each, for the reason
	// `public-writers-archive-gate.integration.test.ts` gives: a write that throws
	// proves nothing on its own, since any broken fixture also throws.
	// -------------------------------------------------------------------------

	it("archived club refuses the holder arm, which reaches no other gate", async () => {
		await claim(seed.memberId);
		// BEFORE: the same call succeeds against the live club.
		await confirmSlotCore({
			slotId: seed.slotId,
			sessionUserId: null,
			selfMemberId: seed.memberId,
		});

		const second = await extraSlot();
		await claim(otherMemberId, second);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));

		await expect(
			confirmSlotCore({
				slotId: second,
				sessionUserId: null,
				selfMemberId: otherMemberId,
			}),
		).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
		expect(await slotStatus(second)).toBe("claimed");
		expect(await planStatus(otherMemberId)).toBeNull();
	});

	it("archived club refuses the officer arm too", async () => {
		await claim(seed.memberId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));

		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			}),
		).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
		expect(await slotStatus()).toBe("claimed");
	});

	it("takedown outranks the meeting lock", async () => {
		await claim(seed.memberId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));

		// Answering "this meeting is completed" would disclose meeting state the
		// takedown was meant to end, and would answer differently from the same
		// club's scheduled meeting.
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: seed.memberId,
			}),
		).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
	});

	it("completed meeting refuses both arms", async () => {
		await claim(seed.memberId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));

		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: seed.memberId,
			}),
		).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));
		await expect(
			confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: seed.adminUserId,
				selfMemberId: null,
			}),
		).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));

		expect(await slotStatus()).toBe("claimed");
		expect(await planStatus(seed.memberId)).toBeNull();
	});

	it("a missing slot is not found on either arm", async () => {
		const ghost = randomUUID();
		await expect(
			confirmSlotCore({
				slotId: ghost,
				sessionUserId: null,
				selfMemberId: seed.memberId,
			}),
		).rejects.toThrow(exact("Role not found."));
	});
});
