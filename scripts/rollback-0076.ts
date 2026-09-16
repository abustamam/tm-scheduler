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
 *   bun run rollback:0076          # dry run, prints what it would do
 *   bun run rollback:0076 --apply  # performs the restore
 *
 * **Against PRODUCTION, do not reach for `railway run`.** It executes locally
 * with the service's variables injected, and Railway's `DATABASE_URL` is the
 * private `*.railway.internal` host, which does not resolve off-platform; this
 * project has no TCP proxy on the Postgres service. This file is also NOT
 * bundled into `.output/`, and the runtime image (`node:22-slim`) carries no
 * Bun and no `node_modules`, so it cannot run in the app container either.
 *
 * The verified production path is psql inside the database service, with the
 * statement this script runs — which is why the statement is also written
 * verbatim in `drizzle/0076_bored_meltdown.sql`'s header:
 *
 *   railway ssh --service Postgres -- psql -X -c "UPDATE \"people\" p \
 *     SET \"email\" = b.\"email\" FROM \"people_email_backup\" b \
 *     WHERE p.\"id\" = b.\"person_id\" AND p.\"user_id\" IS NULL \
 *     AND p.\"email\" IS NULL;"
 *
 * This script is for a local or staging database, and for reading the accounting
 * (`--apply` omitted) before running the psql form above.
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
		// Full accounting, in BOTH modes. A bare "restorable" count hides the rows
		// the join drops: `mergePeople` DELETEs an absorbed Person, and the snapshot
		// carries no FK (deliberately — the reference would have let the merge
		// cascade the undo away), so those ids dangle and their addresses reach
		// nobody. An operator seeing "12 rows" needs to know the snapshot holds 15.
		const audit = await db.execute<{
			total: number;
			restorable: number;
			gone: number;
			linked: number;
			has_email: number;
		}>(sql`
			select
				count(*)::int as total,
				count(*) filter (
					where p."id" is not null and p."user_id" is null and p."email" is null
				)::int as restorable,
				count(*) filter (where p."id" is null)::int as gone,
				count(*) filter (where p."user_id" is not null)::int as linked,
				count(*) filter (
					where p."id" is not null and p."email" is not null
				)::int as has_email
			  from "people_email_backup" b
			  left join "people" p on p."id" = b."person_id"
		`);
		const a = audit.rows[0];
		const count = a?.restorable ?? 0;
		console.log(
			`snapshot: ${a?.total ?? 0} row(s) — ${count} restorable, ` +
				`${a?.gone ?? 0} whose Person no longer exists (merged or deleted), ` +
				`${a?.linked ?? 0} already signed in, ` +
				`${a?.has_email ?? 0} repaired since the migration.`,
		);

		if (!APPLY) {
			console.log("DRY RUN — re-run with --apply to restore.");
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
