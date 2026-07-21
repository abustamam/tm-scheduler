/**
 * DB-backed tests for the club-profile (district / mission / meeting schedule)
 * read + update logic. `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-profile.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, hasTestDb, type SeededClub, seedClub } from "#/test/db";
import {
	applyClubProfileUpdate,
	clubProfileSchema,
	getClubProfile,
} from "./clubs-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("club profile logic", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns nulls for an unset club profile", async () => {
		const profile = await getClubProfile(seed.clubId);
		expect(profile).toMatchObject({
			district: null,
			mission: null,
			meetingSchedule: null,
		});
	});

	it("sets all three fields", async () => {
		await applyClubProfileUpdate({
			clubId: seed.clubId,
			district: "District 39",
			mission: "Building leaders.",
			meetingSchedule: "2nd & 4th Thursday, 6:45–7:45 PM",
		});
		const profile = await getClubProfile(seed.clubId);
		expect(profile).toMatchObject({
			district: "District 39",
			mission: "Building leaders.",
			meetingSchedule: "2nd & 4th Thursday, 6:45–7:45 PM",
		});
	});

	it("clears fields when passed empty/blank values (schema → null)", async () => {
		await applyClubProfileUpdate({
			clubId: seed.clubId,
			district: "District 39",
			mission: "Building leaders.",
			meetingSchedule: "Thursdays",
		});
		// Re-parse through the schema the server fn uses: blanks collapse to null.
		const cleared = clubProfileSchema.parse({
			clubId: seed.clubId,
			district: "",
			mission: "   ",
			meetingSchedule: "",
		});
		await applyClubProfileUpdate(cleared);
		const profile = await getClubProfile(seed.clubId);
		expect(profile).toMatchObject({
			district: null,
			mission: null,
			meetingSchedule: null,
		});
	});

	it("trims surrounding whitespace via the schema", async () => {
		const parsed = clubProfileSchema.parse({
			clubId: seed.clubId,
			district: "  District 7  ",
			mission: undefined,
			meetingSchedule: undefined,
		});
		expect(parsed.district).toBe("District 7");
		await applyClubProfileUpdate(parsed);
		const profile = await getClubProfile(seed.clubId);
		expect(profile?.district).toBe("District 7");
	});

	it("throws when the club does not exist", async () => {
		await expect(
			applyClubProfileUpdate({
				clubId: "00000000-0000-0000-0000-000000000000",
				district: "District 1",
				mission: null,
				meetingSchedule: null,
			}),
		).rejects.toThrow("Club not found.");
	});

	it("saves and normalizes the default country code, and clears on blank (#295)", async () => {
		// Entered without a `+` → normalized to `+1` by the schema.
		const input = clubProfileSchema.parse({
			clubId: seed.clubId,
			defaultCountryCode: "1",
		});
		expect(input.defaultCountryCode).toBe("+1");
		await applyClubProfileUpdate(input);
		expect((await getClubProfile(seed.clubId))?.defaultCountryCode).toBe("+1");

		// Blank clears it back to null.
		await applyClubProfileUpdate(
			clubProfileSchema.parse({ clubId: seed.clubId, defaultCountryCode: "" }),
		);
		expect(
			(await getClubProfile(seed.clubId))?.defaultCountryCode,
		).toBeNull();
	});
});
