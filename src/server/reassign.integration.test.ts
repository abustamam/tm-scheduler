/**
 * DB-backed integration tests for `reassignSlotCore` (ADR-0005 / #125).
 *
 * Exercises the REAL slots-logic reassign path against a live Postgres
 * identified by TEST_DATABASE_URL. `#/db` is mocked to the test client so
 * importing slots-logic doesn't require a DATABASE_URL; the helper takes an
 * explicit connection, so we pass a `testDb` transaction (it MUST run inside one
 * — the FOR UPDATE row lock is what makes the read+write atomic).
 *
 * When TEST_DATABASE_URL is unset the whole suite is skipped.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("reassignSlotCore atomicity (ADR-0005)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;
	// A second active member (different Person) in the same club.
	let memberB: string;
	let personB: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		speakerRoleId = def!.id;

		personB = await seedPerson({ name: "Member B" });
		const [mb] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId: personB, name: "Member B" })
			.returning({ id: members.id });
		memberB = mb!.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function slotState(slotId: string) {
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
			.limit(1);
		return row;
	}

	/** Insert a speaker slot (claimed by `assignedMemberId` when given). */
	async function seedSpeakerSlot(
		slotIndex: number,
		assignedMemberId: string | null,
	): Promise<string> {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex,
				status: assignedMemberId ? "claimed" : "open",
				assignedMemberId,
			})
			.returning({ id: roleSlots.id });
		return row!.id;
	}

	async function seedSpeechOnSlot(
		slotId: string,
		personId: string,
	): Promise<string> {
		const [sp] = await testDb
			.insert(speeches)
			.values({ personId, title: "Talk" })
			.returning({ id: speeches.id });
		await testDb
			.update(roleSlots)
			.set({ speechId: sp!.id })
			.where(eq(roleSlots.id, slotId));
		return sp!.id;
	}

	it("plain reassign of an OPEN slot assigns the member and sets status=claimed", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		// seed.slotId is an OPEN non-speaker (Timer) slot — the admin assign flow.
		const res = await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}),
		);
		expect(res.clubId).toBe(seed.clubId);

		const row = await slotState(seed.slotId);
		expect(row?.status).toBe("claimed");
		expect(row?.assignedMemberId).toBe(seed.memberId);
	});

	it("reassign to a DIFFERENT person unlinks the speech; SAME person keeps it", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		const slotId = await seedSpeakerSlot(20, seed.memberId);
		const speechId = await seedSpeechOnSlot(slotId, seed.personId);

		// → different Person: speech unlinked, but not destroyed.
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId,
				memberId: memberB,
				actorMemberId: seed.adminMemberId,
			}),
		);
		let row = await slotState(slotId);
		expect(row?.assignedMemberId).toBe(memberB);
		expect(row?.speechId).toBeNull();
		const [persisted] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, speechId));
		expect(persisted?.personId).toBe(seed.personId);

		// Re-link a speech for the new holder, then reassign to the SAME member.
		const speechB = await seedSpeechOnSlot(slotId, personB);
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId,
				memberId: memberB,
				actorMemberId: seed.adminMemberId,
			}),
		);
		row = await slotState(slotId);
		expect(row?.assignedMemberId).toBe(memberB);
		expect(row?.speechId).toBe(speechB);
	});

	it("two concurrent reassigns serialize under the row lock — one target wins, no torn state", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		const slotId = await seedSpeakerSlot(21, seed.memberId);
		await seedSpeechOnSlot(slotId, seed.personId);

		// Both targets differ from the current holder's Person → each unlinks.
		const results = await Promise.allSettled([
			testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId,
					memberId: memberB,
					actorMemberId: seed.adminMemberId,
				}),
			),
			testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId,
					memberId: seed.adminMemberId,
					actorMemberId: seed.adminMemberId,
				}),
			),
		]);

		// Both complete (last-writer-wins is acceptable for admin-trust reassign).
		expect(results.every((r) => r.status === "fulfilled")).toBe(true);

		const row = await slotState(slotId);
		expect(row?.status).toBe("claimed");
		// Final assignee is exactly one of the two targets — never a torn mix.
		expect([memberB, seed.adminMemberId]).toContain(row?.assignedMemberId);
		// Both targets are a different Person from the original, so the lock-
		// serialized decisions both unlink: the speech ends detached.
		expect(row?.speechId).toBeNull();
	});
});
