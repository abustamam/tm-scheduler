/**
 * The 0114 migration's backfill (#1110): an existing preference on a Person
 * with an account counts as the member's; on one without, the officer's; no
 * preference stays NULL. The statement is read verbatim from the migration
 * file, so editing the SQL there is what this test judges.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { people, user } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

function backfillStatement(): string {
	const file = readdirSync("drizzle").find((f) => /^0114_.*\.sql$/.test(f));
	if (!file) throw new Error("migration 0114 not found");
	const text = readFileSync(`drizzle/${file}`, "utf8");
	const found = text
		.split("--> statement-breakpoint")
		.map((part) => part.trim())
		.find((part) => part.startsWith('UPDATE "people"'));
	if (!found) throw new Error("backfill UPDATE not found in the migration");
	return found;
}

describe.skipIf(!hasTestDb)("contact_preference_by backfill (#1110)", () => {
	const personIds: string[] = [];
	const userIds: string[] = [];

	afterEach(async () => {
		if (personIds.length)
			await testDb.delete(people).where(inArray(people.id, personIds));
		if (userIds.length)
			await testDb.delete(user).where(inArray(user.id, userIds));
		personIds.length = 0;
		userIds.length = 0;
	});

	it("maps value+user to member, value+no user to officer, no value to NULL", async () => {
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Linked",
			email: `bf-${userId}@test.example`,
			emailVerified: true,
		});
		userIds.push(userId);
		const mk = async (values: Partial<typeof people.$inferInsert>) => {
			const [row] = await testDb
				.insert(people)
				.values({ name: "BF", ...values })
				.returning({ id: people.id });
			if (!row) throw new Error("insert failed");
			personIds.push(row.id);
			return row.id;
		};
		const withUser = await mk({
			userId,
			phone: "+14155552671",
			preferredContact: "sms",
		});
		const noUser = await mk({
			phone: "+14155552672",
			preferredContact: "call",
		});
		const noValue = await mk({ phone: "+14155552673" });
		// Rows seeded as the pre-migration state: provenance NULL.
		await testDb
			.update(people)
			.set({ contactPreferenceBy: null })
			.where(inArray(people.id, personIds));

		// The statement updates every Person with a value, in this DB too; that
		// is the migration's own behaviour, and only the three rows are asserted.
		await testDb.execute(sql.raw(backfillStatement()));

		const by = async (id: string) =>
			(
				await testDb
					.select({ by: people.contactPreferenceBy })
					.from(people)
					.where(eq(people.id, id))
			)[0]?.by;
		expect(await by(withUser)).toBe("member");
		expect(await by(noUser)).toBe("officer");
		expect(await by(noValue)).toBeNull();
	});
});
