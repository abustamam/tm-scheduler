/**
 * DB-backed tests for the /admin/club-settings logic: the club profile
 * (district / mission / meeting schedule) and the agenda run-of-show variant
 * (#367). `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-profile.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, hasTestDb, type SeededClub, seedClub } from "#/test/db";
import {
	applyClubAgendaSettingsUpdate,
	applyClubProfileUpdate,
	clubProfileSchema,
	getClubAgendaSettings,
	getClubProfile,
	getPublicClubProfile,
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
		expect((await getClubProfile(seed.clubId))?.defaultCountryCode).toBeNull();
	});
});

describe.skipIf(!hasTestDb)("club agenda settings logic (#367)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("defaults a new club to the standard flow", async () => {
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
	});

	it("stores a club's Table Topics window, and clears it again (#443)", async () => {
		// MCF's rule: "1 min min, 2.3 min max" — 60s and 150s.
		await applyClubAgendaSettingsUpdate({
			clubId: seed.clubId,
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: 60,
			tableTopicsMaxSeconds: 150,
		});
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: 60,
			tableTopicsMaxSeconds: 150,
		});

		// Clearing BACK to null is the half that fails if the update coalesces a
		// null into "leave unchanged" — a club that set a rule by mistake must be
		// able to take it off.
		await applyClubAgendaSettingsUpdate({
			clubId: seed.clubId,
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
	});

	it("flips to MCF's variant and back", async () => {
		await applyClubAgendaSettingsUpdate({
			clubId: seed.clubId,
			geIntroducesFunctionaries: true,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: true,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});

		await applyClubAgendaSettingsUpdate({
			clubId: seed.clubId,
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
		expect(await getClubAgendaSettings(seed.clubId)).toEqual({
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
	});

	it("does not disturb the profile fields", async () => {
		await applyClubProfileUpdate({
			clubId: seed.clubId,
			district: "District 39",
			mission: null,
			meetingSchedule: null,
		});
		await applyClubAgendaSettingsUpdate({
			clubId: seed.clubId,
			geIntroducesFunctionaries: true,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
		expect((await getClubProfile(seed.clubId))?.district).toBe("District 39");
	});

	it("reads the standard flow for a club that does not exist", async () => {
		expect(
			await getClubAgendaSettings("00000000-0000-0000-0000-000000000000"),
		).toEqual({
			geIntroducesFunctionaries: false,
			tableTopicsMinSeconds: null,
			tableTopicsMaxSeconds: null,
		});
	});

	it("throws when updating a club that does not exist", async () => {
		await expect(
			applyClubAgendaSettingsUpdate({
				clubId: "00000000-0000-0000-0000-000000000000",
				geIntroducesFunctionaries: true,
				tableTopicsMinSeconds: null,
				tableTopicsMaxSeconds: null,
			}),
		).rejects.toThrow("Club not found.");
	});
});

/**
 * The PUBLIC reader (#318). `getPublicClubProfile` exists only to be narrower
 * than `getClubProfile`: it feeds the "About this club" block on the
 * unauthenticated club page, and `getClubProfile` also returns
 * `defaultCountryCode` — internal dialing config for the WhatsApp nudge links
 * (#295) with no business on an anonymous payload.
 *
 * That narrowness is invisible to TypeScript. `row` is assigned to a declared
 * return type rather than passed as a fresh object literal, so excess-property
 * checking never fires: adding `defaultCountryCode` to the select — or
 * collapsing the body to `return getClubProfile(clubId)` — compiles clean and
 * ships the column to every anonymous visitor. So the assertion is an ABSOLUTE
 * key list, not `toMatchObject`, which would pass on a widened row.
 */
describe.skipIf(!hasTestDb)(
	"getPublicClubProfile (PUBLIC payload, #318)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});
		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("returns EXACTLY the three public columns, never defaultCountryCode", async () => {
			await applyClubProfileUpdate(
				clubProfileSchema.parse({
					clubId: seed.clubId,
					district: "District 206",
					mission: "Building leaders.",
					meetingSchedule: "2nd & 4th Thursday, 6:45 PM",
					defaultCountryCode: "1",
				}),
			);

			const pub = await getPublicClubProfile(seed.clubId);
			expect(Object.keys(pub ?? {}).sort()).toEqual([
				"district",
				"meetingSchedule",
				"mission",
			]);
			expect(pub).not.toHaveProperty("defaultCountryCode");
			expect(pub).not.toHaveProperty("name");

			// Positive control: the column really is set on this club, so the
			// assertion above is about THIS query's projection and not about the
			// value happening to be absent.
			const priv = await getClubProfile(seed.clubId);
			expect(priv?.defaultCountryCode).toBeTruthy();
		});

		it("returns the values a guest needs", async () => {
			await applyClubProfileUpdate(
				clubProfileSchema.parse({
					clubId: seed.clubId,
					district: "District 206",
					mission: "Building leaders.",
					meetingSchedule: "Thursdays",
				}),
			);
			expect(await getPublicClubProfile(seed.clubId)).toEqual({
				district: "District 206",
				mission: "Building leaders.",
				meetingSchedule: "Thursdays",
			});
		});

		it("returns nulls for an unset profile, not a missing row", async () => {
			expect(await getPublicClubProfile(seed.clubId)).toEqual({
				district: null,
				mission: null,
				meetingSchedule: null,
			});
		});

		it("returns null for a club that does not exist", async () => {
			expect(
				await getPublicClubProfile("00000000-0000-4000-8000-000000000000"),
			).toBeNull();
		});
	},
);
