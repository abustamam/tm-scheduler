/**
 * The DATA half of migration 0076 (#756).
 *
 * `bun run db:generate` writes the CREATE TABLE for `people_email_backup`; the
 * capture, the abort and the clear are hand-appended and nothing regenerates
 * them. This test runs the file's OWN statements against seeded rows, so a
 * regenerated migration that lost them fails here rather than in production —
 * the same arrangement as `unordered-role-slots-backfill.integration.test.ts`
 * for 0072.
 *
 * **It runs against a database of its own, unlike every other suite here, and
 * that is not fussiness.** 0072's backfill is an unscoped UPDATE that only ever
 * SETS a flag, so a neighbour's rows are collateral it can tolerate inside a
 * rolled-back transaction. 0076 is different in both directions:
 *   - it READS globally and fails closed. Its abort counts un-claimed people
 *     with no roster address anywhere, and sibling suites seed exactly that
 *     shape on purpose — so against `tm_test` the migration correctly aborts on
 *     somebody else's fixture and every assertion here fails for a reason that
 *     has nothing to do with the migration.
 *   - it WRITES globally. `UPDATE people SET email = NULL WHERE user_id IS NULL`
 *     takes a row lock on every un-claimed Person in the database and holds it
 *     until the transaction ends. Run beside 400 parallel files that is not a
 *     flaky test, it is a suite-wide stall — it took six unrelated tests down in
 *     `onboarding-checklist-logic` the first time this file existed.
 * A migration is global by nature; testing one against a database other tests
 * are concurrently mutating is a category error. So this file creates a
 * database, migrates it with the REAL drizzle runner (which also proves 0076's
 * `DO $$ … $$` block survives statement splitting), and drops it after.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/person-email-clear-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { clubs, members, people, peopleEmailBackup, user } from "#/db/schema";
import { hasTestDb } from "#/test/db";

const MIGRATION = resolve(process.cwd(), "drizzle/0076_bored_meltdown.sql");

/** The migration's hand-written data statements, split on drizzle's marker. */
function dataStatements(): string[] {
	const text = readFileSync(MIGRATION, "utf8");
	const statements = text
		.split("--> statement-breakpoint")
		// A segment may open with the comment block that explains it. Strips BLANK
		// lines as well as comment lines, unlike 0072's version of this helper: the
		// reasoning below is long enough to be paragraphed, and a blank line between
		// two comment blocks otherwise ends the strip and hides the statement.
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => /^(INSERT|UPDATE|DO)\b/i.test(s));
	// A test that runs zero statements passes every assertion below for the wrong
	// reason — the seeded rows simply keep what they were given.
	expect(
		statements.length,
		"the migration must carry its capture, abort and clear statements",
	).toBe(3);
	return statements;
}

const ROLLBACK_SCRIPT = resolve(process.cwd(), "scripts/rollback-0076.ts");

/**
 * The rollback statement, READ OUT OF `scripts/rollback-0076.ts` rather than
 * copied here.
 *
 * An earlier cut hand-typed it and claimed in this very comment to be "keeping
 * the script in step" — nothing read the script, so editing a predicate there
 * left every test below green while the only artifact that runs during an
 * incident quietly changed meaning. All three predicates matter; the
 * `email IS NULL` one is the least obvious and has its own test.
 */
function restoreStatement(): string {
	const text = readFileSync(ROLLBACK_SCRIPT, "utf8");
	// The apply-path statement: the UPDATE inside the `sql` template, not the one
	// quoted in the header comment (which is psql-escaped).
	const stmt = /sql`(\s*UPDATE "people" p SET[\s\S]*?)`/.exec(text)?.[1];
	expect(
		stmt,
		"scripts/rollback-0076.ts no longer carries a readable UPDATE statement",
	).toBeTruthy();
	const sqlText = stmt as string;
	// Cheap belt: the three predicates, named, so a drift that still parses fails
	// with a message rather than a mystery.
	for (const predicate of [
		/b\."person_id"/,
		/p\."user_id" IS NULL/i,
		/p\."email" IS NULL/i,
	]) {
		expect(sqlText, `the rollback lost ${predicate}`).toMatch(predicate);
	}
	return sqlText;
}

/** This suite's own database name, on the same server as `TEST_DATABASE_URL`. */
const SCRATCH_DB = `tm_0076_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

let pool: pg.Pool;
let scratchDb: ReturnType<typeof drizzle<typeof schema>>;

class Rollback extends Error {}

/** The transaction handle the scratch client hands its callback. */
type Tx = Parameters<Parameters<(typeof scratchDb)["transaction"]>[0]>[0];

describe.skipIf(!hasTestDb)("0076 clears un-verified people.email", () => {
	let clubId: string;

	beforeAll(async () => {
		// CREATE/DROP DATABASE cannot run inside a transaction, so this uses a bare
		// client — against the CONFIGURED database, not a hardcoded `postgres`.
		// CI's `tm_migrate_runner` step creates a database the same way
		// (`psql -d tm_test -c 'CREATE DATABASE …'`), and a `postgres` maintenance
		// database is not guaranteed to be reachable on a developer's box.
		const admin = new pg.Client({
			connectionString: process.env.TEST_DATABASE_URL,
		});
		await admin.connect();
		try {
			// Reap anything a previous run left behind. The scratch name is random
			// and the drop lives in `afterAll`, so a Ctrl-C, an OOM or a killed
			// vitest worker orphans a database with nothing to collect it; on a
			// shared dev container they accumulate silently.
			//
			// **Only databases with no live backends, and never WITH (FORCE).** This
			// repo runs parallel agents against one server by design, so another run
			// of THIS file is the normal case rather than a corner — and a forced
			// drop would terminate its connections and fail it with errors pointing
			// nowhere near the cause. An in-use database simply refuses to drop here,
			// which is the correct outcome; `afterAll` still forces its own.
			const stale = await admin.query<{ datname: string }>(
				`select d.datname from pg_database d
				  where d.datname like 'tm_0076_%'
				    and not exists (
				      select 1 from pg_stat_activity a where a.datname = d.datname
				    )`,
			);
			for (const row of stale.rows) {
				await admin
					.query(`DROP DATABASE IF EXISTS "${row.datname}"`)
					.catch(() => {
						// Raced with another run that just connected. Leave it; that run
						// owns it and will drop it itself.
					});
			}
			await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
		} finally {
			await admin.end();
		}

		pool = new pg.Pool({ connectionString: urlFor(SCRATCH_DB) });
		scratchDb = drizzle(pool, { schema });
		// The real runner, on the real files — so a migration that cannot apply
		// fails here and not on a Railway deploy.
		await migrate(scratchDb, { migrationsFolder: "drizzle" });

		clubId = randomUUID();
		await scratchDb
			.insert(clubs)
			.values({ id: clubId, name: "0076 Club", slug: `club-0076-${clubId}` });
	}, 60_000);

	afterAll(async () => {
		await pool?.end();
		const admin = new pg.Client({
			connectionString: process.env.TEST_DATABASE_URL,
		});
		await admin.connect();
		try {
			await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
		} finally {
			await admin.end();
		}
	}, 60_000);

	/** Run `body` inside a transaction, then roll it back unconditionally. */
	async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
		let out: T | undefined;
		try {
			await scratchDb.transaction(async (tx) => {
				out = await body(tx);
				throw new Rollback();
			});
		} catch (err) {
			if (!(err instanceof Rollback)) throw err;
		}
		return out as T;
	}

	/** Apply the migration's data statements on `tx`, in file order. */
	async function runMigration(tx: Tx): Promise<void> {
		for (const statement of dataStatements()) {
			await tx.execute(sql.raw(statement));
		}
	}

	/** A Person plus a membership in the scratch club, created INSIDE `tx`. */
	async function seedInTx(
		tx: Tx,
		opts: {
			personEmail: string | null;
			memberEmail: string | null;
			linked?: boolean;
		},
	): Promise<string> {
		let userId: string | null = null;
		if (opts.linked) {
			userId = randomUUID();
			await tx.insert(user).values({
				id: userId,
				name: "Linked",
				email: `linked-${userId}@test.example`,
				emailVerified: true,
			});
		}
		const [person] = await tx
			.insert(people)
			.values({ name: "Migration Person", email: opts.personEmail, userId })
			.returning({ id: people.id });
		if (!person) throw new Error("person insert failed");
		await tx.insert(members).values({
			clubId,
			personId: person.id,
			name: "Migration Person",
			email: opts.memberEmail,
		});
		return person.id;
	}

	async function personEmail(tx: Tx, personId: string) {
		const [row] = await tx
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		return row?.email ?? null;
	}

	it("clears an UN-CLAIMED Person's address", async () => {
		await inRolledBackTx(async (tx) => {
			const addr = `unclaimed-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
			});

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBeNull();
		});
	});

	it("leaves an ACCOUNT HOLDER's verified address alone", async () => {
		// The one value in the column that anybody proved they own. Clearing it
		// would sign every existing member out of their own identity.
		await inRolledBackTx(async (tx) => {
			const addr = `claimed-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
				linked: true,
			});

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe(addr);
		});
	});

	it("captures what it cleared, so the clear is reversible", async () => {
		await inRolledBackTx(async (tx) => {
			const addr = `backup-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
			});

			await runMigration(tx);

			const [saved] = await tx
				.select({ email: peopleEmailBackup.email })
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, personId));
			expect(saved?.email).toBe(addr);
		});
	});

	it("restores exactly what it cleared, from the backup table", async () => {
		// The rollback is `scripts/rollback-0076.ts`, and this is its statement. An
		// untested restore is a restore you find out about during the incident.
		await inRolledBackTx(async (tx) => {
			const addr = `restore-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
			});

			await runMigration(tx);
			await tx.execute(sql.raw(restoreStatement()));

			expect(await personEmail(tx, personId)).toBe(addr);
		});
	});

	it("the restore does not clobber a repair made after the migration", async () => {
		// `updateUnclaimedAdminEmail` and `mergePeople`'s keeper fill both write
		// `people.email` on an UNCLAIMED Person, so `user_id IS NULL` does not
		// protect their work — only `email IS NULL` does. Without that arm the
		// rollback undoes an operator's repair during the very incident that
		// triggered it.
		await inRolledBackTx(async (tx) => {
			const cleared = `cleared-${randomUUID()}@test.example`;
			const repaired = `repaired-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: cleared,
				memberEmail: cleared,
			});

			await runMigration(tx);
			// The superadmin fixes them up post-deploy.
			await tx
				.update(people)
				.set({ email: repaired })
				.where(eq(people.id, personId));
			await tx.execute(sql.raw(restoreStatement()));

			expect(await personEmail(tx, personId)).toBe(repaired);
		});
	});

	it("does not capture a row that had nothing to clear", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedInTx(tx, {
				personEmail: null,
				memberEmail: `only-roster-${randomUUID()}@test.example`,
			});

			await runMigration(tx);

			const saved = await tx
				.select({ email: peopleEmailBackup.email })
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, personId));
			expect(saved).toHaveLength(0);
		});
	});

	it("ABORTS rather than stranding a member with no address anywhere", async () => {
		// Measured at 0 rows against production on 2026-09-14, and re-checked at
		// runtime anyway: a deploy is not the moment to discover that the reading
		// was taken a week ago. Failing closed exits the migration runner non-zero
		// and the Railway deploy never serves traffic, which is the right way round
		// — a member whose only address is the one being deleted cannot be invited,
		// cannot claim, and cannot be repaired by any club surface.
		await expect(
			inRolledBackTx(async (tx) => {
				await seedInTx(tx, {
					personEmail: `stranded-${randomUUID()}@test.example`,
					memberEmail: null,
				});
				await runMigration(tx);
			}),
		).rejects.toThrow(/0076/);
	});

	it("does not count a BLANK roster address as a fallback", async () => {
		// An empty string is not an address. `prepareMemberInvite` trims it to null
		// and returns `no_email`, so a row carrying one is stranded just as surely.
		await expect(
			inRolledBackTx(async (tx) => {
				await seedInTx(tx, {
					personEmail: `blank-${randomUUID()}@test.example`,
					memberEmail: "   ",
				});
				await runMigration(tx);
			}),
		).rejects.toThrow(/0076/);
	});

	it("clears a CLUB-LESS Person without aborting", async () => {
		// A Person with no membership at all is nobody's member: they cannot be
		// invited or claimed today and could not be before this migration either,
		// so clearing their address strands no one. They exist in numbers —
		// `mergePeople` leaves absorbed rows behind and the guest pipeline can mint
		// one ahead of a conversion — and failing a production deploy over an
		// orphan row would be a worse outcome than the one the abort protects.
		await inRolledBackTx(async (tx) => {
			const [person] = await tx
				.insert(people)
				.values({
					name: "Club-less Person",
					email: `orphan-${randomUUID()}@test.example`,
				})
				.returning({ id: people.id });
			if (!person) throw new Error("person insert failed");

			await runMigration(tx);

			expect(await personEmail(tx, person.id)).toBeNull();
		});
	});

	it("a re-run would clear a Person created AFTER the migration", async () => {
		// The file is SINGLE-USE, and this is why. An earlier draft of the header
		// invited a hand re-run during an incident and called it a no-op; the test
		// that "proved" it re-ran against a row the first pass had already emptied,
		// so it passed for the wrong reason. Statement 3 is unscoped in time and
		// Person CREATION still writes `people.email` (the CSV importer, the
		// guest-book conversion, the bulk paste, the create-club form) — so a
		// second pass takes the dedupe key off everyone provisioned since.
		//
		// Pinned as a HAZARD rather than fixed: scoping the statement to a deploy
		// timestamp would make the migration unreadable for a re-run nobody should
		// perform. The assertion exists so that anyone who later decides the file
		// IS re-runnable has to delete a test that says otherwise.
		await inRolledBackTx(async (tx) => {
			const addr = `after-${randomUUID()}@test.example`;
			await runMigration(tx);
			const laterPerson = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
			});

			expect(await personEmail(tx, laterPerson)).toBe(addr);
			await runMigration(tx);
			expect(
				await personEmail(tx, laterPerson),
				"a second pass is destructive — the header must keep saying SINGLE-USE",
			).toBeNull();
		});

		// …and the warning that stands between an operator and that data loss is
		// itself a gate, not prose. Without this line, deleting the SINGLE-USE
		// paragraph — the only thing telling anyone not to do what the assertions
		// above just demonstrated — left every test green.
		expect(
			readFileSync(MIGRATION, "utf8"),
			"0076's header must keep its SINGLE-USE warning — the assertions above prove a re-run destroys data",
		).toMatch(/SINGLE-USE/);
	});

	it("the capture is write-once, so a second pass cannot spoil the snapshot", async () => {
		await inRolledBackTx(async (tx) => {
			const addr = `already-${randomUUID()}@test.example`;
			const personId = await seedInTx(tx, {
				personEmail: addr,
				memberEmail: addr,
			});

			await runMigration(tx);
			await runMigration(tx);

			// Still the ORIGINAL value: `ON CONFLICT DO NOTHING` keeps the second
			// pass from overwriting the snapshot with the NULL the first pass wrote.
			const [saved] = await tx
				.select({ email: peopleEmailBackup.email })
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, personId));
			expect(saved?.email).toBe(addr);
		});
	});
});
