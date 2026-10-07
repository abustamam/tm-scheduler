/**
 * The 0114 migration's backfill (#1110): an existing preference on a Person
 * with an account counts as the member's; on one without, the officer's; no
 * preference stays NULL. The statement is read verbatim from the migration
 * file, so editing the SQL there is what this test judges.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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

class Rollback extends Error {}

describe.skipIf(!hasTestDb)("contact_preference_by backfill (#1110)", () => {
	// Everything runs in ONE transaction that is rolled back, so the verbatim,
	// unscoped UPDATE never changes a row another suite is using.
	it("maps value+user to member, value+no user to officer, no value to NULL", async () => {
		await expect(
			testDb.transaction(async (tx) => {
				const userId = randomUUID();
				await tx.insert(user).values({
					id: userId,
					name: "Linked",
					email: `bf-${userId}@test.example`,
					emailVerified: true,
				});
				const mk = async (values: Partial<typeof people.$inferInsert>) => {
					const [row] = await tx
						.insert(people)
						.values({ name: "BF", contactPreferenceBy: null, ...values })
						.returning({ id: people.id });
					if (!row) throw new Error("insert failed");
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

				await tx.execute(sql.raw(backfillStatement()));

				const by = async (id: string) =>
					(
						await tx
							.select({ by: people.contactPreferenceBy })
							.from(people)
							.where(eq(people.id, id))
					)[0]?.by;
				expect(await by(withUser)).toBe("member");
				expect(await by(noUser)).toBe("officer");
				expect(await by(noValue)).toBeNull();
				throw new Rollback();
			}),
		).rejects.toBeInstanceOf(Rollback);
	});
});
