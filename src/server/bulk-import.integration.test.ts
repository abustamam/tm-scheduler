/**
 * DB-backed tests for the VPE bulk roster import. Tests the plain
 * `applyBulkImport` fn directly (the createServerFn wrapper needs the Start
 * runtime); `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/bulk-import.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("bulk roster import", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("inserts N valid rows and logs one member_add per inserted member", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: seed.memberId,
			rows: [
				{
					name: "Alice Apple",
					email: "alice@club.org",
					phone: "19165968820",
					office: "President",
				},
				{ name: "Bob Banana", email: "bob@club.org", phone: "", office: "" },
			],
		});

		expect(result.inserted).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.insertedIds).toHaveLength(2);

		const [alice] = await testDb
			.select()
			.from(members)
			.where(
				and(eq(members.clubId, seed.clubId), eq(members.name, "Alice Apple")),
			);
		expect(alice.email).toBe("alice@club.org");
		// Phone stored as raw digits, not reformatted.
		expect(alice.phone).toBe("19165968820");
		// Pasted free-text office parsed into the structured enum.
		expect(alice.officerPosition).toBe("president");

		const [bob] = await testDb
			.select()
			.from(members)
			.where(
				and(eq(members.clubId, seed.clubId), eq(members.name, "Bob Banana")),
			);
		expect(bob.email).toBe("bob@club.org");
		// Empty cells stored as NULL, not "".
		expect(bob.phone).toBeNull();
		expect(bob.officerPosition).toBeNull();

		// One member_add activity row per inserted member.
		for (const id of result.insertedIds) {
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "member_add"),
						eq(activityLog.targetId, id),
					),
				);
			expect(log).toHaveLength(1);
			expect(log[0].targetType).toBe("member");
			expect((log[0].detail as { name?: string }).name).toBeTruthy();
		}
	});

	it("skips blank-name rows", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: null,
			rows: [
				{ name: "Real Person", email: "real@club.org", phone: "", office: "" },
				{ name: "   ", email: "ghost@club.org", phone: "", office: "" },
			],
		});
		expect(result.inserted).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("skips invalid-email rows", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: null,
			rows: [
				{ name: "Good Email", email: "good@club.org", phone: "", office: "" },
				{ name: "Bad Email", email: "not-an-email", phone: "", office: "" },
			],
		});
		expect(result.inserted).toBe(1);
		expect(result.skipped).toBe(1);
		const bad = await testDb
			.select()
			.from(members)
			.where(
				and(eq(members.clubId, seed.clubId), eq(members.name, "Bad Email")),
			);
		expect(bad).toHaveLength(0);
	});

	it("skips duplicates against the existing roster (name or email)", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		// seed.memberId is "Member User" with email member-<id>@test.example.
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: null,
			rows: [
				// Duplicate name (case-insensitive) of the seeded member.
				{ name: "member user", email: "fresh@club.org", phone: "", office: "" },
				{ name: "Brand New", email: "new@club.org", phone: "", office: "" },
			],
		});
		expect(result.inserted).toBe(1);
		expect(result.skipped).toBe(1);
		const dupes = await testDb
			.select()
			.from(members)
			.where(
				and(eq(members.clubId, seed.clubId), eq(members.name, "member user")),
			);
		expect(dupes).toHaveLength(0);
	});

	it("dedupes within the pasted batch", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: null,
			rows: [
				{ name: "Twin", email: "twin@club.org", phone: "", office: "" },
				{ name: "Twin", email: "twin2@club.org", phone: "", office: "" },
			],
		});
		expect(result.inserted).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("returns zero inserted when no rows are valid", async () => {
		const { applyBulkImport } = await import("#/server/members-logic");
		const result = await applyBulkImport({
			clubId: seed.clubId,
			actorMemberId: null,
			rows: [{ name: "", email: "bad", phone: "", office: "" }],
		});
		expect(result.inserted).toBe(0);
		expect(result.insertedIds).toEqual([]);
	});
});
