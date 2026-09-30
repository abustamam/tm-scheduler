/**
 * A NEW club gets the role guide (#933): onboarding through the real
 * `createClubWithAdmin` seeds every standard role's Before/During text from
 * `ROLE_TEMPLATE`, so a club created after the migration never depends on
 * the backfill.
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roleDefinitions } from "#/db/schema";
import { DEFAULT_CLUB_TIMEZONE } from "#/lib/club-timezone";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createClubWithAdmin } = await import("./onboarding-logic");

describe.skipIf(!hasTestDb)("role guide seeding for a new club (#933)", () => {
	const created: string[] = [];
	afterEach(async () => {
		for (const id of created.splice(0)) await cleanup(id, []);
	});

	it("gives every standard role the template's Before/During text", async () => {
		const res = await createClubWithAdmin({
			clubName: `Guide Seed Club ${Math.random().toString(36).slice(2, 8)}`,
			clubNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
			charteredAt: "2020-01-01",
			adminName: "Guide Admin",
			adminEmail: `guide-${Math.random().toString(36).slice(2, 8)}@example.com`,
			timezone: DEFAULT_CLUB_TIMEZONE,
		});
		created.push(res.clubId);

		const rows = await testDb
			.select({
				key: roleDefinitions.key,
				beforeNotes: roleDefinitions.beforeNotes,
				duringNotes: roleDefinitions.duringNotes,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, res.clubId))
			.orderBy(asc(roleDefinitions.sortOrder));

		expect(rows).toEqual(
			ROLE_TEMPLATE.map((r) => ({
				key: r.key,
				beforeNotes: r.beforeNotes,
				duringNotes: r.duringNotes,
			})),
		);
	});
});
