/**
 * "Confirm your club details" and the charter status (#944), DB-backed: a
 * CHARTERING club completes the item without a club number, a CHARTERED club
 * still needs one. Read through `getOnboardingChecklistStatus`, so a call site
 * that stopped selecting `charter_status` fails here, not only the pure rule.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs } from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { getOnboardingChecklistStatus } = await import(
	"./onboarding-checklist-logic"
);

const created: { clubId: string; users: string[] }[] = [];
afterEach(async () => {
	for (const c of created) await cleanup(c.clubId, c.users);
	created.length = 0;
});

/** A club whose name and meeting schedule are set, so the club number and the
 *  charter status are the only things left deciding the item. */
async function clubWith(charterStatus: "chartering" | "chartered") {
	const seed = await seedClub();
	created.push({
		clubId: seed.clubId,
		users: [seed.adminUserId, seed.memberUserId],
	});
	await testDb
		.update(clubs)
		.set({ charterStatus, clubNumber: null, meetingSchedule: "Thursdays" })
		.where(eq(clubs.id, seed.clubId));
	return seed.clubId;
}

describe.skipIf(!hasTestDb)(
	"club details item and charter status (#944)",
	() => {
		it("a chartering club with no number has confirmed its details", async () => {
			const clubId = await clubWith("chartering");
			const status = await getOnboardingChecklistStatus(clubId);
			expect(status.clubDetailsComplete).toBe(true);
		});

		it("a chartered club with no number has not, until it has one", async () => {
			const clubId = await clubWith("chartered");
			expect(
				(await getOnboardingChecklistStatus(clubId)).clubDetailsComplete,
			).toBe(false);
			await testDb
				.update(clubs)
				.set({ clubNumber: `C-${clubId.slice(0, 8)}` })
				.where(eq(clubs.id, clubId));
			expect(
				(await getOnboardingChecklistStatus(clubId)).clubDetailsComplete,
			).toBe(true);
		});

		it("a chartering club still needs its meeting schedule", async () => {
			const clubId = await clubWith("chartering");
			await testDb
				.update(clubs)
				.set({ meetingSchedule: null })
				.where(eq(clubs.id, clubId));
			expect(
				(await getOnboardingChecklistStatus(clubId)).clubDetailsComplete,
			).toBe(false);
		});
	},
);
