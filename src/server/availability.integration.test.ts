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
 * `markUnavailableReleasing`'s handler body, and why #762's went in beside it:
 * the third block below CALLS both, so a deleted subject check or a deleted
 * proof check fails here instead of only in a source grep.
 * `availability-authz.guard.test.ts` covers the one half a behavioural test
 * cannot reach — that the handler hands the seam the client's RAW assertion
 * rather than defaulting it to the subject, which would make the gate vacuous
 * while every assertion below still passed.
 *
 * #762 (ADR-0026) is why so many cases here now set `sessionUserId`. The seam
 * releases unconditionally, so it admits only a caller whose identity came from
 * a session bound to a member of this club; the ARM cases still exist and still
 * differ from one another, and each needed a signed-in caller or it would have
 * become a test of the new gate rather than of the arm.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/availability.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetingAttendancePlan,
	members,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { SIGN_IN_REQUIRED_MESSAGE, type WriteProof } from "#/lib/write-proof";
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

/**
 * What `setAvailability`'s handler now does, reproduced (see the HONEST
 * LIMITATION above — a `createServerFn` body cannot be invoked here).
 *
 * `proof` defaults to `"asserted"` because that is what the handler resolves
 * for the caller this endpoint exists for: a season-grid visitor with no
 * session who picked a name off the roster. #762 gave that caller the
 * `onlyIfAbsent` mode — fill a blank, re-affirm the same answer, and refuse to
 * change one — and a helper that kept passing the unrestricted write would
 * model an endpoint the product no longer has.
 */
async function setAvailabilityPublic(
	memberId: string,
	meetingId: string,
	clubId: string,
	proof: WriteProof = "asserted",
) {
	const answer = {
		memberId,
		meetingId,
		clubId,
		status: "not_coming" as const,
		actorMemberId: memberId,
		proof,
	};
	if (proof === "asserted") {
		await setPlanStatus(testDb, { ...answer, onlyIfAbsent: true });
	} else {
		await setPlanStatus(testDb, answer);
	}
	return { ok: true as const };
}

/**
 * What `clearAvailability`'s handler does to the SEAM. Its own session gate —
 * `requireSessionActor`, added by #762 because a clear destroys an answer a
 * person put there — lives in the handler body and so is invisible here; the
 * default-`session` sweep in `write-proof.guard.test.ts` is what holds it,
 * which is the same division of labour this file's header describes.
 */
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

	it("setAvailability is idempotent — re-sending the same answer is a no-op", async () => {
		await setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId);
		// Second call should not throw. Since #762 that is a claim about the
		// `onlyIfAbsent` mode rather than about the upsert: a row already saying
		// `not_coming` is left alone and nothing is logged, and only a row saying
		// something ELSE raises. A member double-tapping "can't make it", or a
		// request retried off a flaky connection, must not read as a permission
		// failure.
		await expect(
			setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).resolves.toEqual({ ok: true });

		const rows = await planRows(seed.memberId, seed.meetingId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("not_coming");
		expect(await planSetLogs(seed.meetingId)).toHaveLength(1);
	});

	it("setAvailability REFUSES to overwrite a different answer when the caller is only asserted (#762)", async () => {
		// The bug ADR-0026 closes on this endpoint. A member who said `coming` is
		// flipped to `not_coming` by anyone who can read their member id off the
		// public season grid; they drop out of the assign picker and off the
		// programme, and getting it back needs them to notice.
		await testDb.insert(meetingAttendancePlan).values({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			status: "coming",
		});
		await expect(
			setAvailabilityPublic(seed.memberId, seed.meetingId, seed.clubId),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
		expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
			"coming",
		);
		expect(await planSetLogs(seed.meetingId)).toHaveLength(0);
	});

	it("setAvailability still overwrites for a SESSION-proven caller", async () => {
		// The control. Without it the refusal above passes just as well with the
		// endpoint broken for everyone, and the member correcting their own answer
		// from their own signed-in device is the case the product is for.
		await testDb.insert(meetingAttendancePlan).values({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			status: "coming",
		});
		await setAvailabilityPublic(
			seed.memberId,
			seed.meetingId,
			seed.clubId,
			"session",
		);
		expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
			"not_coming",
		);
		expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
			status: "not_coming",
			proof: "session",
		});
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
		// SIGNED IN as the subject for this whole block since #762: this seam
		// releases UNCONDITIONALLY, so ADR-0026 puts every call behind a session
		// bound to a member of this club. The block is about WHAT the release
		// does — slots opened, speech kept, rung written, one transaction — and
		// those are unchanged; the authorization cases live in the block below.
		sessionUserId = seed.memberUserId;
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

/**
 * A roster member who can also SIGN IN — a Person carrying `user_id`, plus the
 * `user` row behind it.
 *
 * `addRosterMember` above deliberately makes neither, and since #762 that is
 * the difference between a caller who may free roles and one who may not. A
 * case that wants to prove an ARM still behaves as it did needs a member with a
 * user behind them, or it proves only that the new gate fires.
 *
 * The returned `userId` must reach `cleanup`: `user` rows are referenced across
 * clubs, so the club cascade does not take them.
 */
async function addSignedInMember(
	clubId: string,
	name: string,
): Promise<{ memberId: string; userId: string }> {
	const userId = randomUUID();
	const email = `${userId}@test.example`;
	await testDb
		.insert(user)
		.values({ id: userId, name, email, emailVerified: true });
	const personId = await seedPerson({ name, email, userId });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name, email })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");
	return { memberId: m.id, userId };
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
		/** `user` rows a case created itself — referenced across clubs, so the
		 *  club cascade does not take them and `cleanup` needs them by id. */
		let extraUserIds: string[];

		beforeEach(async () => {
			seed = await seedClub();
			sessionUserId = null;
			extraUserIds = [];
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
			await cleanup(seed.clubId, [
				seed.adminUserId,
				seed.memberUserId,
				...extraUserIds,
			]);
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

		it("lets the SUBJECT release their own roles, signed in", async () => {
			// SIGNED IN since #762: the self arm still releases, and what changed is
			// that reaching it now takes a session bound to this member.
			sessionUserId = seed.memberUserId;
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
			// WHICH arm admitted it and HOW the identity behind it was established.
			// They answer different questions — two of the three arms admit both
			// kinds of caller — so the feed carries both.
			expect(log?.detail).toMatchObject({
				grantedVia: "self",
				proof: "session",
			});
		});

		it("REFUSES an anonymous caller who asserts NOTHING — the closed residual (#699)", async () => {
			// This case used to assert the opposite, and it was right to: #675 could
			// not close the hole, so it executed it instead of describing it. With
			// no session and no assertion the ladder resolves the caller TO the
			// subject, so one request per member — with no id to guess, and credited
			// to the victim — emptied a meeting's whole programme, `speech_id` and
			// all, with no undo.
			//
			// #762 closes it on the PROOF (ADR-0026): asserting nothing resolves as
			// `proof: "asserted"`, exactly like asserting the victim's own id, and
			// this seam releases unconditionally so it admits only `"session"`.
			//
			// The live personal-meeting-page path goes through here with no
			// `actorMemberId`, so a member declining their own meeting now signs in
			// first; `personal-meeting-body.tsx` already renders the refusal as a
			// toast carrying a one-tap sign-in link (#761).
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

			// Refused, not partially applied — and the RUNG matters as much as the
			// slot: a refusal that still recorded "not coming" would drop the member
			// out of the assign picker while leaving them on the programme.
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
			expect(await planSetLogs(seed.meetingId)).toHaveLength(0);
		});

		it("REFUSES a caller who asserts the SUBJECT's own id", async () => {
			// The shape an attacker reaches for first, because the id is public —
			// `loadMeetingDetail` ships it as `assigneeId`. It resolves to the same
			// place as asserting nothing, so both have to be executed or a
			// half-applied fix looks complete.
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});

		it("REFUSES an asserted Toastmaster of THIS meeting", async () => {
			// The widest asserted shape on this seam: the Toastmaster's member id is
			// published on the public agenda payload, so before #762 any visitor who
			// read the agenda could release any member's roles through this arm.
			// Left out, a fix that only handled the self arm would look complete.
			await addTmodSlot(seed, otherMemberId);
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			const [slot] = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
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

		it("lets THIS meeting's SIGNED-IN Toastmaster release another member's roles", async () => {
			// The middle arm (#576), scoped to the meeting being written. It is what
			// keeps the season grid's act-on-behalf-of path working for the member
			// actually running the meeting, and it survives #762 — with a session
			// behind it, which is the half that changed. The refusal case above is
			// its asserted twin; this is the control that keeps the arm from being
			// deleted rather than narrowed.
			const tmod = await addSignedInMember(seed.clubId, "Signed-in TMOD");
			extraUserIds.push(tmod.userId);
			await addTmodSlot(seed, tmod.memberId);
			sessionUserId = tmod.userId;
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: tmod.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);
			const [setLog] = await planSetLogs(seed.meetingId);
			expect(setLog?.actorMemberId).toBe(tmod.memberId);
			expect(setLog?.detail).toMatchObject({
				grantedVia: "tmod",
				proof: "session",
			});
			// The release rows carry the proof too — they are the only record that
			// survives the write they describe.
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
			expect(relLog?.detail).toMatchObject({ proof: "session" });
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

		it("refuses the write once the club is archived — on the self arm", async () => {
			// The arm that needs its OWN assert. It is a plain member, so
			// `requireClubRole` denies and `requireMembership`'s archive check
			// (#186) never answers for this path; the seam's
			// `assertClubNotArchived` runs BEFORE the ladder, so it is what refuses
			// here rather than any check further down. Takedown outranks every other
			// reason to refuse (ADR-0016) — including, since #762, the sign-in one.
			sessionUserId = seed.memberUserId;
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
