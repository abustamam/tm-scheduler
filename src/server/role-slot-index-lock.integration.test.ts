/**
 * DB-backed gate for #803: `applyAddRoleSlot` must decide a new slot's
 * `slot_index` UNDER the meeting lock, the way `applyAddSpeakerSlot` already
 * does (`lockMeetingForSlotEdit`, ADR-0005 — "which slot is the next index" is
 * not a property of one row, so a per-row guard cannot answer it).
 *
 * There is deliberately NO unique index on
 * `(meeting_id, role_definition_id, slot_index)` — see #803's Out of Scope, it
 * is the maintainer's step after an audit, because a create that fails on
 * pre-existing data would block the whole deploy at container startup. So
 * nothing in the database catches a duplicate: the serialization IS the
 * constraint here, which is why every assertion below is on the rows that
 * actually land rather than on a grep for the lock call.
 *
 * The first test is a pre-fix CONTROL: the shape this path had — the next index
 * read on a pre-transaction snapshot — driven through the same harness as the
 * lock assertion below, and asserted to still produce the duplicate. Without it,
 * "two adds produced 0 and 1" is equally satisfied by two calls that merely
 * never overlapped, and the suite would pass against the bug it exists to catch.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/role-slot-index-lock.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyAddRoleSlot, applyAddSpeakerSlot } = await import("./slots-logic");

/** Add a non-paired role def to the seeded club; return its id. */
async function addRole(clubId: string, name: string): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name,
			category: "functionary",
			defaultCount: 1,
			sortOrder: 50,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	return row.id;
}

/** Speaker + paired evaluator role defs, so `applyAddSpeakerSlot` resolves. */
async function addSpeakerAndEvaluatorRoles(clubId: string) {
	const [spk] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 3,
			sortOrder: 10,
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleDefinitions).values({
		clubId,
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 11,
		isSpeakerRole: false,
	});
	return { speakerRoleId: spk.id };
}

/** Every slot index for one (meeting, role), ascending. */
async function indicesFor(meetingId: string, roleId: string) {
	const rows = await testDb
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
	return rows.map((r) => r.slotIndex);
}

/** What `lockMeetingForSlotEdit` takes, so a test can hold it from outside. */
async function lockMeetingRow(
	tx: Parameters<Parameters<(typeof testDb)["transaction"]>[0]>[0],
	meetingId: string,
) {
	await tx
		.select({ id: meetings.id })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update")
		.limit(1);
}

/**
 * The shape `applyAddRoleSlot` had before this fix: the next index is computed
 * from a read taken OUTSIDE the transaction, and only the insert is
 * transactional. Kept here as the control — it is what proves the harness below
 * can actually see the difference the lock makes.
 */
async function unlockedAddRoleSlot(
	meetingId: string,
	roleDefinitionId: string,
) {
	const existing = await testDb
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleDefinitionId),
			),
		);
	const slotIndex =
		existing.length === 0
			? 0
			: Math.max(...existing.map((s) => s.slotIndex)) + 1;
	await testDb.transaction(async (tx) => {
		await tx
			.insert(roleSlots)
			.values({ meetingId, roleDefinitionId, slotIndex });
	});
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTestDb)(
	"applyAddRoleSlot numbers under the meeting lock (#803)",
	() => {
		let club: SeededClub;
		let roleId: string;

		beforeEach(async () => {
			club = await seedClub();
			// A role the meeting has no slots of yet, so the first index is 0.
			roleId = await addRole(club.clubId, "Vote Counter");
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		/**
		 * Run `add` against a meeting another writer already holds: the writer
		 * takes the meeting row, inserts index 0, lets `add` run for a beat, and
		 * only then commits. The resulting indices say WHEN `add` read.
		 *
		 * The wait is not what discriminates, which is why nothing here asserts on
		 * it: inserting a `role_slots` row takes `FOR KEY SHARE` on the meeting it
		 * references, so even a lock-less add parks behind the writer's
		 * `FOR UPDATE` at its INSERT. It is the numbering READ that either passed
		 * the held row (landing 1) or ran ahead of it on a snapshot that could not
		 * see it (landing a second 0).
		 */
		async function raceAgainstAHeldMeeting(add: () => Promise<unknown>) {
			let started: Promise<unknown> | undefined;
			await testDb.transaction(async (tx) => {
				await lockMeetingRow(tx, club.meetingId);
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					slotIndex: 0,
				});
				started = add();
				// Long enough for an unlocked read to have happened — the control
				// below is what proves it is.
				await sleep(400);
			});
			await started;
			return indicesFor(club.meetingId, roleId);
		}

		/**
		 * CONTROL, through the same harness as the lock assertion below. The
		 * pre-fix shape numbers from a snapshot taken before the writer committed,
		 * so it lands a second 0.
		 *
		 * Deterministic on purpose. A `Promise.all` of two unlocked adds is NOT the
		 * control: whether it duplicates depends on how the two await profiles
		 * happen to line up, and the minimal mirror here serializes and passes on
		 * its own. A control that only sometimes reproduces the bug proves nothing
		 * on the run where it does not.
		 */
		it("CONTROL: numbering read outside the lock duplicates the index", async () => {
			// Two rows, both at 0 — `buildShortCodes` keys on (role, index), so this
			// is two members holding one badge with the second write winning.
			expect(
				await raceAgainstAHeldMeeting(() =>
					unlockedAddRoleSlot(club.meetingId, roleId),
				),
			).toEqual([0, 0]);
		});

		it("two concurrent adds of the same role get consecutive indices", async () => {
			await Promise.all([
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
			]);
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0, 1]);
		});

		/**
		 * The lock is only worth taking if the numbering read is BEHIND it. Same
		 * harness as the control, and the only thing that differs is which function
		 * runs: 1 rather than a second 0 is the read having waited for the writer.
		 */
		it("reads the next index after taking the meeting lock, not before", async () => {
			expect(
				await raceAgainstAHeldMeeting(() =>
					applyAddRoleSlot({
						meetingId: club.meetingId,
						roleDefinitionId: roleId,
						actorMemberId: club.adminMemberId,
					}),
				),
			).toEqual([0, 1]);
		});

		/**
		 * Both paths now take the SAME single meeting row, which is the property
		 * `lockMeetingForSlotEdit`'s docblock says makes it deadlock-free. Worth
		 * asserting rather than assuming: this fix is what puts a second entry
		 * point on that lock.
		 */
		it("an add-role racing an add-speaker on one meeting does not deadlock", async () => {
			const { speakerRoleId } = await addSpeakerAndEvaluatorRoles(club.clubId);
			const results = await Promise.allSettled([
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
				applyAddSpeakerSlot({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			]);
			expect(
				results.map((r) =>
					r.status === "fulfilled"
						? "fulfilled"
						: `rejected: ${(r.reason as Error)?.message}`,
				),
			).toEqual(["fulfilled", "fulfilled"]);
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0]);
			expect(await indicesFor(club.meetingId, speakerRoleId)).toEqual([0]);
		});

		/** Unchanged contract: the append point and the activity-log entry. */
		it("appends after the highest existing index and logs role_added once", async () => {
			await testDb.insert(roleSlots).values([
				{ meetingId: club.meetingId, roleDefinitionId: roleId, slotIndex: 0 },
				{ meetingId: club.meetingId, roleDefinitionId: roleId, slotIndex: 4 },
			]);
			await applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: roleId,
				actorMemberId: club.adminMemberId,
			});
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0, 4, 5]);

			// Scoped to THIS run's club: vitest runs files in parallel against one
			// shared `tm_test` and several suites write `meeting_edit`.
			const entries = await testDb
				.select({
					action: activityLog.action,
					targetType: activityLog.targetType,
					targetId: activityLog.targetId,
					actorMemberId: activityLog.actorMemberId,
					detail: activityLog.detail,
				})
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId));
			expect(entries).toEqual([
				{
					action: "meeting_edit",
					targetType: "meeting",
					targetId: club.meetingId,
					actorMemberId: club.adminMemberId,
					detail: { change: "role_added", roleDefinitionId: roleId },
				},
			]);
		});
	},
);
