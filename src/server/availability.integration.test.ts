/**
 * DB-backed integration tests for setAvailability + clearAvailability, and for
 * `releaseSlotsAndMarkUnavailable` (#204) — including, since #675, the
 * authorization ladder that seam now runs.
 *
 * "Not available" is now the `not_coming` rung of `meeting_attendance_plan`
 * (D6, 2026-08-11), not the presence of a `member_availability` row, so every
 * assertion here checks the STATUS: a row-exists assertion would pass for
 * `coming` too.
 *
 * HONEST LIMITATION on the first block. A `createServerFn` handler cannot be
 * invoked in vitest, so the two helpers below reproduce what the (now delegating)
 * handlers do rather than calling them. They exercise the real seam, but they
 * cannot see a delegate that passes the WRONG rung — the two writers whose
 * mapping is load-bearing and testable are `releaseSlotsAndMarkUnavailable`
 * below and `markComingOnSelfClaim` (claim-availability.integration.test.ts),
 * which are called directly. PR 2 deletes the delegates entirely.
 *
 * That limitation is exactly why #675's gate went into the SEAM and not into
 * `markUnavailableReleasing`'s handler body: the third block below CALLS the
 * gate, so a deleted subject check fails here instead of only in a source grep.
 * `availability-authz.guard.test.ts` covers the one half a behavioural test
 * cannot reach — that the handler hands the seam the client's RAW assertion
 * rather than defaulting it to the subject, which would make the gate vacuous
 * while every assertion below still passed.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetingAttendancePlan,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The officer arm of the D6 ladder reads the SESSION off the current request,
 * which vitest has none of — `getSessionUser` catches the missing context and
 * returns null, so without these two mocks every case here would silently be an
 * anonymous one and the officer test would prove nothing (it would pass by
 * being rejected-then-not-asserted, the shape CODING_STANDARDS.md calls a guard
 * that cannot fail).
 *
 * Mocked at the LIBRARY boundary rather than at `./guards`: `getSessionUser`,
 * `requireClubRole`, `requireMembership` and the officer-term fallback all stay
 * real and all run against the real seeded rows. What is faked is only the
 * cookie → session lookup better-auth would do, which is the one piece a test
 * process genuinely cannot have.
 */
let sessionUserId: string | null = null;
/** One stable object, because the impersonation marker is keyed on identity. */
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { clearPlanStatus, SELF_SERVICE_RUNGS, setPlanStatus } = await import(
	"./attendance-plan-logic"
);
const { releaseSlotsAndMarkUnavailable } = await import("./availability-logic");
const { SELF_ONLY_MESSAGE } = await import("./attendance-actor-logic");

// ---------------------------------------------------------------------------
// Helpers — mirror the delegating handler bodies against testDb
// ---------------------------------------------------------------------------

async function setAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await setPlanStatus(testDb, {
		memberId,
		meetingId,
		clubId,
		status: "not_coming",
		actorMemberId: memberId,
	});
	return { ok: true as const };
}

async function clearAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
) {
	await clearPlanStatus(testDb, {
		memberId,
		meetingId,
		clubId,
		actorMemberId: memberId,
		// Mirrors what `clearAvailability` actually passes. This helper omitted it
		// while `onlyFrom` was optional, so it modelled an UNFLOORED delete that the
		// production fn has never performed — every assertion made through it about
		// officer state was proving the wrong thing (#573).
		onlyFrom: SELF_SERVICE_RUNGS,
	});
	return { ok: true as const };
}

async function planRows(memberId: string, meetingId: string) {
	return testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		);
}

async function planSetLogs(meetingId: string) {
	return testDb
		.select({
			actorMemberId: activityLog.actorMemberId,
			detail: activityLog.detail,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.targetId, meetingId),
				eq(activityLog.action, "plan_set"),
			),
		)
		.orderBy(activityLog.createdAt);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("availability (set + clear)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("setAvailability records not_coming and logs plan_set carrying that rung", async () => {
		const result = await setAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");

		const log = await planSetLogs(seed.meetingId);
		expect(log).toHaveLength(1);
		// The rung lives in the detail, not the action name — an assertion on the
		// action alone cannot tell "not coming" from "coming".
		expect(log[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: "not_coming",
		});
	});

	it("setAvailability is idempotent (the seam upserts)", async () => {
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);
		// Second call should not throw
		await expect(
			setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");
	});

	it("clearAvailability removes the row (back to no answer) and logs a null rung", async () => {
		// Set first
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);

		// Clear
		const result = await clearAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
		);
		expect(result).toEqual({ ok: true });

		expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);

		// A clear is a plan_set with a NULL rung — matched on the detail rather
		// than on position, so the assertion does not depend on row order.
		const log = await planSetLogs(seed.meetingId);
		expect(log).toHaveLength(2);
		const cleared = log.filter(
			(l) => (l.detail as { status?: unknown } | null)?.status === null,
		);
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.detail).toMatchObject({
			memberId: seed.memberId,
			status: null,
		});
	});

	it("clearAvailability on non-existent row is a no-op (no error)", async () => {
		await expect(
			clearAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });
	});
});

describe.skipIf(!hasTestDb)("releaseSlotsAndMarkUnavailable (#204)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		sessionUserId = null;
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("releases the member's held slots AND records not_coming, atomically", async () => {
		// Assign the seeded (open) slot to the member.
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));

		const result = await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(result.released).toBe(1);

		// Slot is back to open and unassigned.
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		expect(slot?.assignedMemberId).toBeNull();
		expect(slot?.status).toBe("open");

		// The answer is "not coming" — NOT merely "a plan row exists", which a
		// `coming` row would satisfy while meaning the opposite.
		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");

		// Logged both a release (for the slot) and plan_set (for the meeting).
		const relLogs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.slotId),
					eq(activityLog.action, "release"),
				),
			);
		expect(relLogs.length).toBeGreaterThan(0);
		const setLogs = await planSetLogs(seed.meetingId);
		expect(setLogs).toHaveLength(1);
		expect(setLogs[0]?.detail).toMatchObject({ status: "not_coming" });
	});

	it("records not_coming even when the member holds no roles (released = 0)", async () => {
		const result = await releaseSlotsAndMarkUnavailable(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
		});
		expect(result.released).toBe(0);

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");
	});
});

// ---------------------------------------------------------------------------
// #675 — the subject check the seam had none of
// ---------------------------------------------------------------------------

/** Insert an extra active roster member; return its id. Every membership needs
 *  a Person (ADR-0008 / #64) — seed one first. `cleanup` cascades both from the
 *  club, and takes the Person with them. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");
	return m.id;
}

/** Give the meeting a Toastmaster of the Day slot held by `memberId`. Keyless
 *  and canonically named — the shape `createClubRole` actually writes, and the
 *  one `findTmodSlot`'s name fallback has to keep resolving. */
async function addTmodSlot(
	club: SeededClub,
	memberId: string,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: "Toastmaster of the Day",
			key: null,
			category: "leadership",
			isSpeakerRole: false,
			sortOrder: 1,
		})
		.returning({ id: roleDefinitions.id });
	if (!def) throw new Error("Failed to insert role definition");
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: "claimed",
			assignedMemberId: memberId,
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("Failed to insert role slot");
	return slot.id;
}

/**
 * The gate #675 added, exercised through the seam that runs it.
 *
 * The bug: `markUnavailableReleasing` ended its ladder at `requireMemberInClub`
 * (the SUBJECT is on the roster) plus `requestWriteActor` (who to CREDIT — it
 * authorizes nothing), so any caller could name any member and have every role
 * they held set back to `open` with `speech_id = null`, with no undo. Its less
 * destructive sibling `setPlannedAttendance` already ended its own ladder with
 * `if (actor !== args.memberId) throw`.
 *
 * The NEGATIVE case is the load-bearing one and it is written first below: an
 * "officer succeeds / subject succeeds" pair passes just as well with the gate
 * deleted. Verified by mutation — replacing `resolveActor`'s result in
 * `availability-logic.ts` with `{ actorMemberId: claimed ?? memberId, via:
 * "self" }` leaves the rest of this file green and fails exactly the rejection
 * case and the archived-club case.
 */
describe.skipIf(!hasTestDb)(
	"releaseSlotsAndMarkUnavailable authorization (#675)",
	() => {
		let seed: SeededClub;
		/** A second ACTIVE roster member of the same club, holding no office. */
		let otherMemberId: string;

		beforeEach(async () => {
			seed = await seedClub();
			sessionUserId = null;
			otherMemberId = await addRosterMember(seed.clubId, "Someone Else");
			// The subject holds the seeded slot in every case below, so a write that
			// is wrongly admitted is VISIBLE as a released slot rather than only as a
			// plan row.
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.memberId,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, seed.slotId));
		});

		afterEach(async () => {
			sessionUserId = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("REJECTS a different, non-officer member who asserts themselves as the actor", async () => {
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SELF_ONLY_MESSAGE);

			// Refused, not partially applied: the slot is still theirs and no answer
			// was recorded on their behalf. Asserting only the throw would pass for a
			// fixture that broke for some unrelated reason.
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});

		it("REJECTS a signed-in member of the club who is not an officer", async () => {
			// The magic link makes anyone a session, so "has a session" is not the
			// property that grants — the officer arm needs `requireClubRole(admin)`
			// and falls through to the self-only arm when it denies. Without this
			// case a fix that admitted any authenticated caller would look correct.
			sessionUserId = seed.memberUserId;
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: otherMemberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SELF_ONLY_MESSAGE);
			expect(await planRows(otherMemberId, seed.meetingId)).toHaveLength(0);
		});

		it("lets the SUBJECT release their own roles", async () => {
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);

			const rows = await planRows(seed.memberId, seed.meetingId);
			expect(rows[0]?.status).toBe("not_coming");
			const [log] = await planSetLogs(seed.meetingId);
			expect(log?.actorMemberId).toBe(seed.memberId);
			// WHICH arm admitted it is persisted, so an honour-system grant and a
			// session-authenticated one are distinguishable in the feed afterwards.
			expect(log?.detail).toMatchObject({ grantedVia: "self" });
		});

		it("admits an anonymous caller who asserts NOTHING as the subject", async () => {
			// Stated as a test rather than left implied, because it is the residual
			// this fix deliberately does not close and the docblock's claim about it
			// should be executable. With no session and no assertion the ladder
			// resolves the caller TO the subject — the product's identity model
			// (#317), the same honour system `claimSlot` and `releaseSlot` run on.
			// It is also the live personal-meeting-page path: that call site sends no
			// `actorMemberId` at all, so breaking this breaks a member declining
			// their own meeting.
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
		});

		it("lets a club OFFICER release another member's roles, credited to the officer", async () => {
			sessionUserId = seed.adminUserId;
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);

			// Actor = the officer; subject (detail.memberId) = the target member.
			const [setLog] = await planSetLogs(seed.meetingId);
			expect(setLog?.actorMemberId).toBe(seed.adminMemberId);
			expect(setLog?.detail).toMatchObject({
				memberId: seed.memberId,
				grantedVia: "officer",
			});

			// The released-slot log is likewise attributed to the officer.
			const [relLog] = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				)
				.limit(1);
			expect(relLog?.actorMemberId).toBe(seed.adminMemberId);
		});

		it("lets THIS meeting's Toastmaster release another member's roles with no session", async () => {
			// The middle arm (#576): an honour-system claim, scoped to the meeting
			// being written. It is what keeps the season grid's act-on-behalf-of path
			// working for the member actually running the meeting.
			await addTmodSlot(seed, otherMemberId);
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: otherMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);
			const [setLog] = await planSetLogs(seed.meetingId);
			expect(setLog?.actorMemberId).toBe(otherMemberId);
			expect(setLog?.detail).toMatchObject({ grantedVia: "tmod" });
		});

		// A BEFORE/AFTER pair, per `public-writers-archive-gate.integration.test.ts`:
		// a write that throws for an archived club proves nothing on its own, since
		// any broken fixture also throws. The "before" half is what fails if the
		// gate is deleted.
		it("refuses the write once the club is archived — on the officer arm", async () => {
			sessionUserId = seed.adminUserId;
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.adminMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).resolves.toMatchObject({ released: 1 });

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.adminMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});

		it("refuses the write once the club is archived — on the session-less self arm", async () => {
			// The arm that needs its OWN assert: no session means `requireMembership`
			// (#186) and `requireClubRole` never run, so nothing else in this path
			// reads `clubs.archived_at`.
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).resolves.toMatchObject({ released: 1 });

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});
	},
);
