/**
 * DB-backed integration tests for the PUBLIC roster read (`listMembers`) and for
 * the roster shape a member add has to leave behind.
 *
 * These never called the server fns: each helper below replicates the query
 * against `testDb`, because a `createServerFn` is unreachable from vitest. The
 * add helper was named after `addMember` when that fn was public; #630 deleted
 * that fn and renamed the helper.
 *
 * BE HONEST ABOUT WHAT THE FIRST TWO SUITES ARE. `insertRosterMember` writes
 * the member row and the `member_add` row itself, and the case below then
 * asserts those same rows exist: it asserts that `testDb.insert` inserts, and
 * would pass with every production seam deleted. That predates #630
 * (`addMemberPublic` on `main` hand-rolled the identical two inserts). Do NOT
 * read the `member_add` assertion as pinning `applyBulkImport`: nothing links
 * them.
 *
 * The LAST suite (#1154, releasing a member's slots) is different: it
 * `vi.mock`s `#/db` onto `testDb` and drives the real `applySetMemberStatus`
 * and `applyMemberRemove` from `members-logic`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/members.integration.test.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	members,
	people,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

// The #1154 suite at the bottom drives the real `members-logic` writers against
// the test database. The earlier suites never touch production code (see the
// header), so the swap is invisible to them.
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// ---------------------------------------------------------------------------
// Helpers — replicate public roster query logic using testDb
// ---------------------------------------------------------------------------

async function listMembersPublic(clubId: string) {
	return testDb
		.select({
			id: members.id,
			name: members.name,
		})
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(members.name);
}

async function insertRosterMember(clubId: string, name: string) {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");

	await testDb.insert(activityLog).values({
		clubId,
		actorMemberId: m.id,
		action: "member_add",
		targetType: "member",
		targetId: m.id,
		detail: { name },
	});

	return { id: m.id };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"public roster (listMembers + a roster add)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("listMembers returns the seeded roster member with no session", async () => {
			const rows = await listMembersPublic(seed.clubId);
			expect(rows.length).toBeGreaterThanOrEqual(1);
			const seeded = rows.find((r) => r.id === seed.memberId);
			expect(seeded).toBeDefined();
			expect(seeded?.name).toBe("Member User");
		});

		it("a roster add inserts the member and logs member_add", async () => {
			const result = await insertRosterMember(seed.clubId, "Alice Newcomer");
			expect(result.id).toBeDefined();

			// Verify roster row exists
			const [row] = await testDb
				.select({ name: members.name, clubId: members.clubId })
				.from(members)
				.where(eq(members.id, result.id))
				.limit(1);

			expect(row?.name).toBe("Alice Newcomer");
			expect(row?.clubId).toBe(seed.clubId);

			// Verify activity log row
			const log = await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.targetId, result.id));
			expect(log.some((r) => r.action === "member_add")).toBe(true);
		});

		// Removed at #630: a case named "addMember with empty name is rejected
		// (validator guard)" that re-declared its own zod schema inline and asserted
		// zod rejects "". It never imported `addMemberSchema`, so it asserted nothing
		// about this repo even while that schema existed — and the schema is now gone.
		// The live min-length rule is `editSchema`/`bulkImportSchema` in
		// `members-logic.ts`, both exported and both reachable from a real test.

		it("listMembers returns a member added to the roster", async () => {
			await insertRosterMember(seed.clubId, "Bob Newbie");
			const rows = await listMembersPublic(seed.clubId);
			const found = rows.find((r) => r.name === "Bob Newbie");
			expect(found).toBeDefined();
		});
	},
);

// ---------------------------------------------------------------------------
// Releasing a member's slots on deactivate / remove (#1154)
//
// `scheduledAt >= now` is an instant; `completeMeeting` closes a meeting by the
// club-local DAY. So a meeting completed this afternoon and scheduled for this
// evening is "upcoming" to the selector. Seeded from that state: status
// `completed`, `scheduledAt` one hour ahead, a slot held by the member.
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"releasing a member's slots on deactivate and remove (#1154)",
	() => {
		let seed: SeededClub;
		let victimId: string;
		let victimPersonId: string;

		beforeEach(async () => {
			seed = await seedClub();
			victimPersonId = await seedPerson({ name: "Leaving Member" });
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: victimPersonId,
					name: "Leaving Member",
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to insert member");
			victimId = m.id;
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			// Club-less, and a removed member no longer names it: clean it ourselves.
			await testDb.delete(people).where(eq(people.id, victimPersonId));
		});

		/** A meeting one hour ahead in `status`, with a slot the victim holds. */
		async function heldSlotOn(status: "scheduled" | "completed" | "cancelled") {
			const [meeting] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
					status,
				})
				.returning({ id: meetings.id });
			if (!meeting) throw new Error("Failed to insert meeting");
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: victimPersonId, title: "Held speech" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to insert speech");
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					speechId: speech.id,
					meetingId: meeting.id,
					roleDefinitionId: seed.roleDefinitionId,
					status: "claimed",
					assignedMemberId: victimId,
					claimedAt: new Date(),
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("Failed to insert slot");
			return slot.id;
		}

		async function slotRow(id: string) {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					claimedAt: roleSlots.claimedAt,
					speechId: roleSlots.speechId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, id));
			if (!row) throw new Error("slot vanished");
			return row;
		}

		async function releasedSlotIds(slotIds: string[]) {
			const rows = await testDb
				.select({ targetId: activityLog.targetId })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "release"),
						inArray(activityLog.targetId, slotIds),
					),
				);
			return rows.map((r) => r.targetId);
		}

		const deactivate = async () => {
			const { applySetMemberStatus } = await import("#/server/members-logic");
			await applySetMemberStatus({
				clubId: seed.clubId,
				memberId: victimId,
				status: "inactive",
				actorMemberId: seed.adminMemberId,
			});
		};
		const remove = async () => {
			const { applyMemberRemove } = await import("#/server/members-logic");
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: victimId,
				actorMemberId: seed.adminMemberId,
			});
		};

		for (const [label, act, keepsTitle] of [
			["deactivating the member", deactivate, "keeps the holder on"],
			["removing the member", remove, "does not release"],
		] as const) {
			describe(label, () => {
				it(`${keepsTitle} a slot on a completed meeting scheduled later today`, async () => {
					const completed = await heldSlotOn("completed");
					await act();
					const row = await slotRow(completed);
					// The writer left it alone: still claimed, claim time and speech
					// intact. On a REMOVE the holder column goes null by the members FK
					// (ON DELETE SET NULL), which is not this writer's doing.
					if (label === "deactivating the member") {
						expect(row.assignedMemberId).toBe(victimId);
					}
					expect(row.status).toBe("claimed");
					expect(row.claimedAt).not.toBeNull();
					expect(row.speechId).not.toBeNull();
					expect(await releasedSlotIds([completed])).toEqual([]);
				});

				it("still releases a cancelled future meeting's slot (#1057)", async () => {
					const cancelled = await heldSlotOn("cancelled");
					await act();
					const row = await slotRow(cancelled);
					expect(row.assignedMemberId).toBeNull();
					expect(row.status).toBe("open");
					expect(row.claimedAt).toBeNull();
					expect(row.speechId).toBeNull();
					expect(await releasedSlotIds([cancelled])).toEqual([cancelled]);
				});

				it("still releases a scheduled future meeting's slot", async () => {
					const scheduled = await heldSlotOn("scheduled");
					await act();
					const row = await slotRow(scheduled);
					expect(row.assignedMemberId).toBeNull();
					expect(row.status).toBe("open");
					expect(await releasedSlotIds([scheduled])).toEqual([scheduled]);
				});

				it("leaves a slot alone that was reassigned to someone else after the writer read it", async () => {
					// The writer SELECTs the victim's slots, then UPDATEs each. An officer
					// reassigning the slot in between must not lose its new holder or
					// speech. Real interleaving: a second transaction holds the slot's
					// row lock with the reassignment uncommitted, the writer reads the
					// old holder and parks on its UPDATE, then the reassignment commits.
					const slotId = await heldSlotOn("scheduled");
					const blocker = await openBlockingTx(async (tx) => {
						await tx
							.update(roleSlots)
							.set({ assignedMemberId: seed.memberId })
							.where(eq(roleSlots.id, slotId));
					});
					const writer = act();
					try {
						await waitForLockWait('update "role_slots"', blocker.pid);
					} finally {
						await blocker.commit();
					}
					await writer;
					const row = await slotRow(slotId);
					expect(row.assignedMemberId).toBe(seed.memberId);
					expect(row.status).toBe("claimed");
					expect(row.claimedAt).not.toBeNull();
					expect(row.speechId).not.toBeNull();
					expect(await releasedSlotIds([slotId])).toEqual([]);
				});

				it("logs a release only for the slots it released, in a mixed set", async () => {
					const completed = await heldSlotOn("completed");
					const cancelled = await heldSlotOn("cancelled");
					const scheduled = await heldSlotOn("scheduled");
					await act();
					expect((await slotRow(completed)).status).toBe("claimed");
					expect(
						(await releasedSlotIds([completed, cancelled, scheduled])).sort(),
					).toEqual([cancelled, scheduled].sort());
				});
			});
		}
	},
);
