/**
 * Undo migration 0076's data clear (#756), from `people_email_backup`.
 *
 * **Why this is a script and not a line in the migration's header.** Reverting
 * the PR is not by itself a valid rollback: the old `linkPersonToUser` matched
 * `lower(people.email)`, so old code against a migrated database leaves every
 * cleared member unable to auto-link — a state neither release produces. The
 * compensating UPDATE therefore has to be run, and `git revert` of the PR
 * deletes `drizzle/0076_bored_meltdown.sql`, which is where the instructions
 * would otherwise live. During an incident nobody should be reconstructing this
 * from `git log`.
 *
 * Run AFTER reverting the application code:
 *   bun run scripts/rollback-0076.ts          # dry run, prints what it would do
 *   bun run scripts/rollback-0076.ts --apply  # performs the restore
 *
 * Uses `DATABASE_URL` from the environment (`.env.local` locally; on Railway,
 * `railway run bun run scripts/rollback-0076.ts --apply`).
 *
 * Safe to run more than once: the `email IS NULL` predicate means an already
 * restored row is not matched a second time.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const APPLY = process.argv.includes("--apply");

async function main() {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error("DATABASE_URL is not set.");
		process.exit(1);
	}

	const pool = new pg.Pool({ connectionString: url });
	const db = drizzle(pool);
	try {
		const present = await db.execute<{ exists: boolean }>(
			sql`select to_regclass('public.people_email_backup') is not null as exists`,
		);
		if (!present.rows[0]?.exists) {
			console.error(
				"people_email_backup does not exist — either 0076 never ran here, or the table has already been dropped. Nothing to restore.",
			);
			process.exit(1);
		}

		// The three predicates are all load-bearing:
		//   - joined on the snapshot  → only rows 0076 actually captured;
		//   - `user_id IS NULL`       → never touch an address a bind proved;
		//   - `email IS NULL`         → never clobber an address one of the two
		//     sanctioned non-bind writers (`updateUnclaimedAdminEmail`,
		//     `mergePeople`'s keeper fill) set AFTER the migration. Without this
		//     arm the restore undoes an operator's repair during the very incident
		//     that triggered the rollback.
		const restorable = await db.execute<{ count: number }>(sql`
			select count(*)::int as count
			  from "people" p
			  join "people_email_backup" b on b."person_id" = p."id"
			 where p."user_id" is null and p."email" is null
		`);
		const count = restorable.rows[0]?.count ?? 0;

		if (!APPLY) {
			console.log(
				`DRY RUN: ${count} row(s) would have their people.email restored. Re-run with --apply.`,
			);
			return;
		}

		const restored = await db.execute(sql`
			UPDATE "people" p SET "email" = b."email"
			  FROM "people_email_backup" b
			 WHERE p."id" = b."person_id"
			   AND p."user_id" IS NULL
			   AND p."email" IS NULL
		`);
		console.log(`Restored ${restored.rowCount ?? count} row(s).`);
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
