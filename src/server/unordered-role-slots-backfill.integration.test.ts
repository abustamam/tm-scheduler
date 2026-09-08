/**
 * The DATA half of migration 0072 (#624).
 *
 * Materialization is copy-once, so adding `slots_unordered` to the seed reaches
 * no club that has already run a contest — and a club with a contest on the
 * calendar is exactly who this fix is for. The migration therefore backfills
 * the flag onto every `contestant_prepared` row that already exists: the
 * global template's own role, every private per-meeting copy of it, and every
 * club's materialized definition.
 *
 * `bun run db:generate` writes the two ALTER TABLE statements; the UPDATEs are
 * hand-appended and nothing regenerates them. This test runs the file's OWN
 * UPDATE statements against seeded rows so a regenerated migration that lost
 * them fails here rather than on a contest night. Inside a transaction that is
 * rolled back: the UPDATEs are unscoped by design (they must reach every club),
 * and `tm_test` is shared with the other files vitest runs in parallel.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

const MIGRATION = resolve(
	process.cwd(),
	"drizzle/0072_unordered_role_slots.sql",
);

/** The migration's UPDATE statements, split on drizzle's breakpoint marker. */
function backfillStatements(): string[] {
	const text = readFileSync(MIGRATION, "utf8");
	const statements = text
		.split("--> statement-breakpoint")
		// A segment may open with the comment block that explains it.
		.map((s) => s.replace(/^\s*(--[^\n]*\n)+/, "").trim())
		.filter((s) => /^UPDATE\b/i.test(s));
	// A guard that runs zero statements passes every assertion below for the
	// wrong reason — the seeded rows simply keep their defaults.
	expect(
		statements.length,
		"the migration must carry its UPDATE statements",
	).toBe(2);
	return statements;
}

class Rollback extends Error {}

/** The transaction handle `testDb.transaction` hands its callback. */
type Tx = Parameters<Parameters<typeof testDb.transaction>[0]>[0];

describe.skipIf(!hasTestDb)(
	"0072 backfills slots_unordered onto existing contestant rows",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		/** Seed the pre-migration world inside `tx`: a private template copy with a
		 *  contestant role and a judge role, both unflagged; the club's materialized
		 *  definitions of both; and one standard-scope row that happens to share the
		 *  contestant key. Returns the ids the assertions read back. */
		async function seedPreMigration(tx: Tx) {
			const [tpl] = await tx
				.insert(meetingTemplates)
				.values({
					clubId: club.clubId,
					meetingId: club.meetingId,
					key: `speech_contest-${crypto.randomUUID().slice(0, 8)}`,
					name: "Speech Contest",
				})
				.returning({ id: meetingTemplates.id });
			if (!tpl) throw new Error("template insert failed");
			await tx.insert(meetingTemplateRoles).values([
				{
					templateId: tpl.id,
					key: "contestant_prepared",
					name: "Contestant",
					category: "speaker",
					defaultCount: 3,
					sortOrder: 70,
					isSpeakerRole: true,
				},
				{
					templateId: tpl.id,
					key: "judge",
					name: "Judge",
					category: "functionary",
					defaultCount: 5,
					sortOrder: 40,
				},
			]);
			await tx.insert(roleDefinitions).values([
				{
					clubId: club.clubId,
					templateId: tpl.id,
					key: "contestant_prepared",
					name: "Contestant",
					category: "speaker",
					defaultCount: 3,
					sortOrder: 70,
					isSpeakerRole: true,
				},
				{
					clubId: club.clubId,
					templateId: tpl.id,
					key: "judge",
					name: "Judge",
					category: "functionary",
					defaultCount: 5,
					sortOrder: 40,
				},
				// Standard scope (no template). No seed writes this key there, so the
				// backfill must leave it alone: the flag is a fact about the CONTEST's
				// contestant role, not about any row that borrowed its key.
				{
					clubId: club.clubId,
					templateId: null,
					key: "contestant_prepared",
					name: "Contestant (club-defined)",
					category: "speaker",
					defaultCount: 2,
					sortOrder: 900,
					isSpeakerRole: true,
				},
			]);
			return tpl.id;
		}

		async function flagsAfterBackfill() {
			let result:
				| {
						templateRoles: Record<string, boolean>;
						definitions: Record<string, boolean>;
						clubFlagged: number;
				  }
				| undefined;
			try {
				await testDb.transaction(async (tx) => {
					const templateId = await seedPreMigration(tx);
					for (const statement of backfillStatements()) {
						await tx.execute(sql.raw(statement));
					}
					const templateRoles = await tx
						.select({
							key: meetingTemplateRoles.key,
							slotsUnordered: meetingTemplateRoles.slotsUnordered,
						})
						.from(meetingTemplateRoles)
						.where(eq(meetingTemplateRoles.templateId, templateId));
					const definitions = await tx
						.select({
							name: roleDefinitions.name,
							slotsUnordered: roleDefinitions.slotsUnordered,
						})
						.from(roleDefinitions)
						.where(eq(roleDefinitions.clubId, club.clubId));
					result = {
						templateRoles: Object.fromEntries(
							templateRoles.map((r) => [r.key, r.slotsUnordered]),
						),
						definitions: Object.fromEntries(
							definitions.map((r) => [r.name, r.slotsUnordered]),
						),
						clubFlagged: definitions.filter((r) => r.slotsUnordered).length,
					};
					throw new Rollback();
				});
			} catch (e) {
				if (!(e instanceof Rollback)) throw e;
			}
			if (!result) throw new Error("transaction body did not run");
			return result;
		}

		it("flags the contestant role on an existing private template copy, and nothing else there", async () => {
			const { templateRoles } = await flagsAfterBackfill();
			expect(templateRoles).toEqual({
				contestant_prepared: true,
				judge: false,
			});
		});

		it("flags a club's MATERIALIZED contestant definition, and no other definition", async () => {
			const { definitions, clubFlagged } = await flagsAfterBackfill();
			expect(definitions.Contestant).toBe(true);
			expect(definitions.Judge).toBe(false);
			// The seeded club's whole standard role set rides along in `definitions`:
			// every one of those must stay false too.
			expect(clubFlagged).toBe(1);
		});

		it("leaves a standard-scope row with the same key alone", async () => {
			const { definitions } = await flagsAfterBackfill();
			expect(definitions["Contestant (club-defined)"]).toBe(false);
		});

		it("is a no-op on a database with no contestant rows", async () => {
			// Nothing seeded beyond the club: the statements must run without error
			// and flag none of the club's standard roles.
			let flagged = -1;
			try {
				await testDb.transaction(async (tx) => {
					for (const statement of backfillStatements()) {
						await tx.execute(sql.raw(statement));
					}
					const rows = await tx
						.select({ slotsUnordered: roleDefinitions.slotsUnordered })
						.from(roleDefinitions)
						.where(
							and(
								eq(roleDefinitions.clubId, club.clubId),
								eq(roleDefinitions.slotsUnordered, true),
							),
						);
					flagged = rows.length;
					throw new Rollback();
				});
			} catch (e) {
				if (!(e instanceof Rollback)) throw e;
			}
			expect(flagged).toBe(0);
		});
	},
);
