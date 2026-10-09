/**
 * `marketing-screenshot-target.ts` (#1122) against the test database: which
 * meeting `bun run marketing:screenshots` captures for the print and present
 * shots. A cancelled meeting keeps its role claims, so what keeps it out is the
 * status filter, not an empty roster.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run scripts/marketing-screenshot-target.integration.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { guests, meetings, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import {
	findCaptureMeeting,
	findQualifyingMeetings,
	MIN_ASSIGNED_SLOTS,
} from "./marketing-screenshot-target";

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("marketing screenshot target (#1122)", () => {
	let seeded: SeededClub | null = null;

	afterEach(async () => {
		if (seeded) {
			await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
			seeded = null;
		}
	});

	/** A meeting `days` from now (negative = past) with `claimed` assigned slots
	 *  and `open` unassigned ones. `guestId` holds the claimed slots instead of
	 *  the member when given. */
	async function addMeeting(
		club: SeededClub,
		opts: {
			days: number;
			status?: "scheduled" | "cancelled" | "completed";
			claimed: number;
			open?: number;
			guestId?: string;
		},
	): Promise<string> {
		const [meeting] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + opts.days * DAY_MS),
				status: opts.status ?? "scheduled",
			})
			.returning({ id: meetings.id });
		const rows = [
			...Array.from({ length: opts.claimed }, (_, i) => ({
				meetingId: meeting!.id,
				roleDefinitionId: club.roleDefinitionId,
				slotIndex: i,
				status: "claimed" as const,
				assignedMemberId: opts.guestId ? null : club.memberId,
				assignedGuestId: opts.guestId ?? null,
			})),
			...Array.from({ length: opts.open ?? 0 }, (_, i) => ({
				meetingId: meeting!.id,
				roleDefinitionId: club.roleDefinitionId,
				slotIndex: opts.claimed + i,
				status: "open" as const,
			})),
		];
		if (rows.length > 0) await testDb.insert(roleSlots).values(rows);
		return meeting!.id;
	}

	it("skips a cancelled upcoming meeting that still holds its claims", async () => {
		seeded = await seedClub();
		await addMeeting(seeded, {
			days: 2,
			status: "cancelled",
			claimed: MIN_ASSIGNED_SLOTS,
		});
		const held = await addMeeting(seeded, {
			days: 9,
			claimed: MIN_ASSIGNED_SLOTS,
		});

		const picked = await findCaptureMeeting(testDb, seeded.clubId);

		expect(picked?.id).toBe(held);
	});

	it("returns nothing when the only meeting with claims is cancelled", async () => {
		seeded = await seedClub();
		await addMeeting(seeded, {
			days: 2,
			status: "cancelled",
			claimed: MIN_ASSIGNED_SLOTS,
		});

		expect(await findQualifyingMeetings(testDb, seeded.clubId)).toEqual([]);
		expect(await findCaptureMeeting(testDb, seeded.clubId)).toBeNull();
	});

	it("falls back to the latest past meeting that was held, not a newer cancelled one", async () => {
		seeded = await seedClub();
		await addMeeting(seeded, {
			days: -3,
			status: "cancelled",
			claimed: MIN_ASSIGNED_SLOTS,
		});
		const held = await addMeeting(seeded, {
			days: -10,
			status: "completed",
			claimed: MIN_ASSIGNED_SLOTS,
		});
		await addMeeting(seeded, {
			days: -20,
			status: "completed",
			claimed: MIN_ASSIGNED_SLOTS,
		});

		const picked = await findCaptureMeeting(testDb, seeded.clubId);

		expect(picked?.id).toBe(held);
	});

	it("prefers an upcoming meeting over a past one", async () => {
		seeded = await seedClub();
		await addMeeting(seeded, {
			days: -4,
			status: "completed",
			claimed: MIN_ASSIGNED_SLOTS,
		});
		const upcoming = await addMeeting(seeded, {
			days: 5,
			claimed: MIN_ASSIGNED_SLOTS,
		});

		const picked = await findCaptureMeeting(testDb, seeded.clubId);

		expect(picked?.id).toBe(upcoming);
	});

	it("needs MIN_ASSIGNED_SLOTS assigned slots, and open slots do not count", async () => {
		seeded = await seedClub();
		await addMeeting(seeded, {
			days: 4,
			claimed: MIN_ASSIGNED_SLOTS - 1,
			open: 6,
		});

		expect(await findQualifyingMeetings(testDb, seeded.clubId)).toEqual([]);
	});

	it("counts slots a guest holds", async () => {
		seeded = await seedClub();
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: seeded.clubId, name: "Test Guest" })
			.returning({ id: guests.id });
		const held = await addMeeting(seeded, {
			days: 4,
			claimed: MIN_ASSIGNED_SLOTS,
			guestId: guest!.id,
		});

		const qualifying = await findQualifyingMeetings(testDb, seeded.clubId);

		expect(qualifying.map((m) => m.id)).toEqual([held]);
	});
});
