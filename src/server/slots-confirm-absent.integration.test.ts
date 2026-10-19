/**
 * DB-backed tests that the asserted self-confirm gate reads the roll record as
 * well as the plan (#1257), matching the claim gate. Split from
 * `slots-confirm.integration.test.ts`, which is not in this issue's files.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendance,
	meetingAttendancePlan,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { confirmSlotCore } = await import("./slots-logic");
const { SIGN_IN_REQUIRED_MESSAGE } = await import("#/lib/write-proof");

describe.skipIf(!hasTestDb)(
	"confirmSlotCore: asserted holder vs the roll (#1257)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
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
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function slotStatus() {
			const [row] = await testDb
				.select({ status: roleSlots.status })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			return row?.status;
		}

		it("refuses an asserted confirm by a holder recorded Absent, writing nothing", async () => {
			// protects=an unverified confirm cannot put an Absent member on a role; fails_when=the confirm gate reads only the plan; no_claim=the asserted proof is derived from a null session, not a real link
			await testDb.insert(meetingAttendance).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "absent",
			});
			await expect(
				confirmSlotCore({
					slotId: seed.slotId,
					sessionUserId: null,
					selfMemberId: seed.memberId,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect(await slotStatus()).toBe("claimed");
		});

		it("accepts an asserted confirm by a Not-coming holder recorded Present", async () => {
			// protects=the roll record wins over the plan on the confirm gate too; fails_when=the confirm gate still reads the plan and refuses a Present member; no_claim=the Present row is inserted directly, not through roll mode
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "not_coming",
			});
			await testDb.insert(meetingAttendance).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "present",
			});
			await confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: seed.memberId,
			});
			expect(await slotStatus()).toBe("confirmed");
		});
	},
);
