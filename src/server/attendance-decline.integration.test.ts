/**
 * DB-backed integration tests for `declinePlannedAttendance` (#663) — the seam
 * `setPlannedAttendance` reaches when the rung it is asked to write is
 * `not_coming`.
 *
 * The behaviour under test is a BRANCH ON THE ACTOR'S ARM, and it is worth being
 * precise about why that branch has to be exercised rather than read: the
 * officer and self arms free every role the member holds, the honour-system TMOD
 * arm records the rung and frees nothing, and the two outcomes differ ONLY in
 * `role_slots` — the plan row is identical, the `plan_set` activity row is
 * identical apart from `grantedVia`. So a suite that asserted the rung would
 * pass with the gate inverted, with the gate deleted, and with the release
 * dropped entirely, which is the state the rail shipped in.
 *
 * A `createServerFn` handler cannot be invoked in vitest, which is why the
 * branch lives in this seam and not in the handler
 * (CODING_STANDARDS.md, "WRITES are closed too"). What the handler contributes —
 * that it reaches this seam for `not_coming` and NOT for the other two rungs,
 * behind the archive gate and the meeting lock — is pinned by
 * `attendance-decline-wiring.guard.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-decline.integration.test.ts
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
	speeches,
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
 * The officer arm reads the SESSION off the current request, which vitest has
 * none of — `getSessionUser` catches the missing context and returns null, so
 * without these two mocks every case here would silently be an anonymous one and
 * the officer test would prove nothing. Mocked at the LIBRARY boundary, so
 * `requireClubRole` / `requireMembership` stay real and run against real rows;
 * what is faked is only the cookie → session lookup a test process cannot have.
 * Copied in shape from `availability.integration.test.ts`, which gates the seam
 * this one composes.
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

const { declinePlannedAttendance } = await import("./attendance-decline-logic");
const { SELF_ONLY_MESSAGE } = await import("./attendance-actor-logic");

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

async function releaseLogs(slotIds: string[]) {
	const rows = await testDb
		.select({ targetId: activityLog.targetId, detail: activityLog.detail })
		.from(activityLog)
		.where(eq(activityLog.action, "release"));
	// SCOPED to the slots this run created: `activity_log` is shared and vitest
	// runs test files in parallel against one `tm_test`, so an unscoped count is
	// order-dependent by construction.
	return rows.filter((r) => r.targetId && slotIds.includes(r.targetId));
}

/** An extra ACTIVE roster member. Every membership needs a Person (ADR-0008 /
 *  #64); `cleanup` cascades both from the club. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");
	return m.id;
}

/** A second slot on the seeded meeting, held by `memberId`. Returns its id. */
async function addHeldSlot(
	club: SeededClub,
	memberId: string,
	roleName: string,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: roleName,
			key: null,
			category: "leadership",
			isSpeakerRole: false,
			sortOrder: 2,
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
			claimedAt: new Date(),
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("Failed to insert role slot");
	return slot.id;
}

/** Give the meeting a canonically-named Toastmaster of the Day slot held by
 *  `memberId` — the shape `findTmodSlot`'s name fallback has to keep resolving. */
async function addTmodSlot(
	club: SeededClub,
	memberId: string,
): Promise<string> {
	return addHeldSlot(club, memberId, "Toastmaster of the Day");
}

describe.skipIf(!hasTestDb)("declinePlannedAttendance (#663)", () => {
	let seed: SeededClub;
	/** A second ACTIVE roster member of the same club, holding no office. */
	let otherMemberId: string;

	beforeEach(async () => {
		seed = await seedClub();
		sessionUserId = null;
		otherMemberId = await addRosterMember(seed.clubId, "Someone Else");
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** Put the subject on the seeded slot, so a write that is wrongly admitted is
	 *  VISIBLE as a released slot rather than only as a plan row. */
	async function holdSeededSlot(memberId = seed.memberId) {
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));
	}

	describe("the officer arm", () => {
		it("frees EVERY role the member holds, and records the decline", async () => {
			await holdSeededSlot();
			const secondSlotId = await addHeldSlot(seed, seed.memberId, "Timer");
			sessionUserId = seed.adminUserId;

			const result = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(result.released).toBe(2);

			// BOTH slots, not just the first: the rail's own role badge shows one
			// role per member, so a release that stopped after one would look right
			// on the surface the officer is reading.
			const slotRows = await testDb
				.select({
					id: roleSlots.id,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					claimedAt: roleSlots.claimedAt,
				})
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, seed.meetingId));
			expect(slotRows).toHaveLength(2);
			for (const slot of slotRows) {
				expect(slot.status).toBe("open");
				expect(slot.assignedMemberId).toBeNull();
				// `claimed_at` too: left set, the slot reads as claimed to anything
				// that sorts or reports on it while being open.
				expect(slot.claimedAt).toBeNull();
			}

			const rows = await planRows(seed.memberId, seed.meetingId);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("not_coming");

			// ONE plan_set and one release PER SLOT, attributed to the officer.
			const setLogs = await planSetLogs(seed.meetingId);
			expect(setLogs).toHaveLength(1);
			expect(setLogs[0]?.actorMemberId).toBe(seed.adminMemberId);
			expect(setLogs[0]?.detail).toMatchObject({
				memberId: seed.memberId,
				status: "not_coming",
				grantedVia: "officer",
			});
			const rels = await releaseLogs([seed.slotId, secondSlotId]);
			expect(rels).toHaveLength(2);
			expect(rels[0]?.detail).toMatchObject({ fromMemberId: seed.memberId });
		});

		it("keeps the SPEECH row, only unlinking it (ADR-0009)", async () => {
			// The speech is the member's own record of a talk they prepared; the
			// slot going back to the open pool must not delete it. Deleting it would
			// pass every assertion above.
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: seed.personId, title: "My Icebreaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to insert speech");
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.memberId,
					status: "claimed",
					claimedAt: new Date(),
					speechId: speech.id,
				})
				.where(eq(roleSlots.id, seed.slotId));
			sessionUserId = seed.adminUserId;

			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});

			const [slot] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.speechId).toBeNull();
			const kept = await testDb
				.select({ title: speeches.title })
				.from(speeches)
				.where(eq(speeches.id, speech.id));
			expect(kept).toHaveLength(1);
			expect(kept[0]?.title).toBe("My Icebreaker");
		});
	});

	describe("the self arm", () => {
		it("frees the member's own roles when they answer for themselves", async () => {
			await holdSeededSlot();
			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(1);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "self",
			});
		});

		it("records the rung with nothing to free when the member holds no role", async () => {
			// The common case, and the one that must not error or log a release.
			const { released, changed } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(0);
			expect(changed).toBe(true);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);
		});

		it("REJECTS another member asserting themselves as the actor", async () => {
			// The self-only rule the shared ladder enforces, exercised through this
			// seam because this is the entry point the rail now uses. Without it a
			// caller could name any member and empty their agenda.
			await holdSeededSlot();
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(SELF_ONLY_MESSAGE);

			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});
	});

	describe("the TMOD arm", () => {
		it("records the rung and releases NOTHING", async () => {
			// THE case this seam exists for. The TMOD claim is honour-system — the id
			// it is compared against ships on the public agenda payload — so one
			// forged request per member would otherwise empty a meeting's whole
			// programme. The rung is still written: they run the meeting, and
			// recording who is not coming is the panel's job.
			await holdSeededSlot();
			await addTmodSlot(seed, otherMemberId);

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: otherMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(0);

			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);

			// The write itself landed, and the feed says which arm admitted it — an
			// honour-system grant and a session-authenticated one must not look the
			// same afterwards.
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			const [log] = await planSetLogs(seed.meetingId);
			expect(log?.actorMemberId).toBe(otherMemberId);
			expect(log?.detail).toMatchObject({ grantedVia: "tmod" });
		});

		it("releases nothing even on the Toastmaster's OWN row", async () => {
			// A consequence of the ladder's arm ORDER (officer → TMOD → self: self
			// last, or it would swallow the TMOD arm), stated as a test because it
			// reads surprising. The TMOD declining for themselves resolves to `tmod`,
			// not `self`, so their slot stays theirs. They still have the agenda's own
			// release control and the personal meeting page's confirmed "Can't make
			// it", which is a single-subject action rather than a ladder.
			const tmodSlotId = await addTmodSlot(seed, seed.memberId);

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBe(0);
			const [slot] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, tmodSlotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "tmod",
			});
		});
	});

	describe("the archive gate", () => {
		// BEFORE/AFTER pairs: a write that throws for an archived club proves
		// nothing on its own, since any broken fixture also throws. The "before"
		// half is what fails if the gate is deleted.
		it("refuses on the RELEASING arm once the club is archived", async () => {
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;
			await expect(
				declinePlannedAttendance(testDb, {
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
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.adminMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});

		it("refuses on the NON-releasing TMOD arm too", async () => {
			// The branch that reaches `setPlanStatus` directly, so it inherits no
			// archive check from the release seam — and takes a self-asserted member
			// id with no session, so `requireMembership`'s check (#186) never runs
			// for it either. Without this seam's own assert, an archived club would
			// still accept the write on exactly one of the two branches.
			await addTmodSlot(seed, otherMemberId);
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).resolves.toMatchObject({ released: 0 });

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});
	});
});
