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
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { people, peopleEmailBackup, user } from "#/db/schema";
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

/** This suite's own database name, on the same server as `TEST_DATABASE_URL`. */
const SCRATCH_DB = `tm_0076_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

let pool: pg.Pool;
let scratchDb: ReturnType<typeof drizzle<typeof schema>>;
let upTo0108: string;

/**
 * A copy of `drizzle/` whose journal stops at 0108, so `members.email` — which
 * 0076 reads and 0109 (#907) drops — still exists in the scratch database.
 */
function migrationsBefore0109(): string {
	const dir = mkdtempSync(join(tmpdir(), "tm-0076-"));
	mkdirSync(join(dir, "meta"));
	const journal = JSON.parse(
		readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
	) as { entries: Array<{ idx: number; tag: string }> };
	const entries = journal.entries.filter((e) => e.idx < 109);
	for (const e of entries) {
		copyFileSync(
			resolve(process.cwd(), `drizzle/${e.tag}.sql`),
			join(dir, `${e.tag}.sql`),
		);
	}
	writeFileSync(
		join(dir, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries }),
	);
	return dir;
}

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
		// The real runner, on the real files up to 0108 — so a migration that
		// cannot apply fails here and not on a Railway deploy. Not past it: 0109
		// (#907) drops the `members.email` this migration reads.
		upTo0108 = migrationsBefore0109();
		await migrate(scratchDb, { migrationsFolder: upTo0108 });

		clubId = randomUUID();
		// Raw SQL, not the Drizzle insert: the schema names columns added after
		// 0108 (e.g. `clubs.default_location`), which this scratch DB lacks.
		await scratchDb.execute(
			sql`insert into clubs (id, name, slug) values (${clubId}, ${"0076 Club"}, ${`club-0076-${clubId}`})`,
		);
	}, 60_000);

	afterAll(async () => {
		await pool?.end();
		if (upTo0108) rmSync(upTo0108, { recursive: true, force: true });
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

	/**
	 * Insert a `people` row naming its columns, in raw SQL.
	 *
	 * Not `tx.insert(people)`: Drizzle emits EVERY column of the CURRENT schema
	 * (as `default` when unset), and this database is migrated only to 0108. So
	 * any `people` column added after 0108 failed every case here with "column
	 * … does not exist", for a reason unrelated to 0076 (#1093 hit it with
	 * `preferred_contact`). Naming the columns keeps the replay pinned to the
	 * shape 0076 actually ran against.
	 */
	async function insertPerson(
		tx: Tx,
		values: { name: string; email: string | null; userId?: string | null },
	): Promise<string> {
		const result = await tx.execute<{ id: string }>(
			sql`insert into people (name, email, user_id)
			    values (${values.name}, ${values.email}, ${values.userId ?? null})
			    returning id`,
		);
		const id = result.rows[0]?.id;
		if (!id) throw new Error("person insert failed");
		return id;
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
		const personId = await insertPerson(tx, {
			name: "Migration Person",
			email: opts.personEmail,
			userId,
		});
		// Raw SQL: `members.email` is gone from the schema since #907, but it
		// exists in this scratch database (migrated to 0108).
		await tx.execute(
			sql`insert into members (club_id, person_id, name, email)
			    values (${clubId}, ${personId}, 'Migration Person', ${opts.memberEmail})`,
		);
		return personId;
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
			const personId = await insertPerson(tx, {
				name: "Club-less Person",
				email: `orphan-${randomUUID()}@test.example`,
			});

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBeNull();
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
