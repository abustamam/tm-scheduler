/**
 * Migration 0109 (#907): `people.email` becomes the only address column.
 *
 * `bun run db:generate` writes the two CREATE TABLEs and the `DROP COLUMN`; the
 * lock, the two captures and the backfill between them are hand-written and
 * nothing regenerates them. This test runs the file's OWN statements — read out
 * of the SQL file, never re-typed — against seeded rows, so a regenerated
 * migration that lost them fails here rather than in production.
 *
 * It runs against a database of its own, for the reason
 * `person-phone-migration.integration.test.ts` gives: the backfill is an
 * unscoped UPDATE over every Person. The scratch database is migrated only up
 * to 0108 first, with the REAL drizzle runner over a copy of the journal
 * truncated there — so `members.email` still exists and rows can be seeded with
 * it. Each case runs 0109's statements inside a transaction it rolls back; the
 * last case runs the real runner over the real `drizzle/` folder.
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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { hasTestDb } from "#/test/db";

const DRIZZLE = resolve(process.cwd(), "drizzle");
const IDX = 109;
const TAG = "0109_small_reaper";
const MIGRATION = join(DRIZZLE, `${TAG}.sql`);

/** 0109's statements, split on drizzle's marker, leading comments stripped. */
function statements(): string[] {
	return readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0);
}

/** The hand-written data statements: both captures, then the backfill. */
function dataStatements(): string[] {
	const all = statements();
	const membersCapture = all.filter((s) =>
		/^INSERT INTO "members_email_backup"/.test(s),
	);
	const capture = all.filter((s) =>
		/^INSERT INTO "people_email_backup_2"/.test(s),
	);
	const backfill = all.filter((s) => /^UPDATE "people"/.test(s));
	// Zero statements would pass every assertion below for the wrong reason —
	// the seeded rows would simply keep what they were given.
	expect(membersCapture, "0109 must capture membership addresses").toHaveLength(
		1,
	);
	expect(capture, "0109 must capture the Persons it changes").toHaveLength(1);
	expect(backfill, "0109 must carry its backfill").toHaveLength(1);
	return [
		membersCapture[0] as string,
		capture[0] as string,
		backfill[0] as string,
	];
}

function fileOrder(): string[] {
	return statements().map((s) => {
		if (/^LOCK TABLE "members" IN ACCESS EXCLUSIVE MODE;?$/.test(s))
			return "lock";
		if (/^CREATE TABLE/.test(s)) return "create";
		if (/^INSERT INTO "members_email_backup"/.test(s)) return "capture members";
		if (/^INSERT INTO "people_email_backup_2"/.test(s)) return "capture people";
		if (/^UPDATE "people"/.test(s)) return "backfill";
		if (/^ALTER TABLE "members" DROP COLUMN "email"/.test(s)) return "drop";
		return `other: ${s.slice(0, 40)}`;
	});
}

const SCRATCH_DB = `tm_0109_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

let pool: pg.Pool;
let scratchDb: ReturnType<typeof drizzle<typeof schema>>;
let upToPrevious: string;

class Rollback extends Error {}
type Tx = Parameters<Parameters<(typeof scratchDb)["transaction"]>[0]>[0];

/** A copy of `drizzle/` whose journal stops just before 0109. */
function migrationsBefore(): string {
	const dir = mkdtempSync(join(tmpdir(), "tm-0109-"));
	mkdirSync(join(dir, "meta"));
	const journal = JSON.parse(
		readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8"),
	) as { entries: Array<{ idx: number; tag: string }> };
	expect(
		journal.entries.find((e) => e.idx === IDX)?.tag,
		"the journal must carry 0109 under this tag",
	).toBe(TAG);
	const entries = journal.entries.filter((e) => e.idx < IDX);
	expect(entries.at(-1)?.idx).toBe(IDX - 1);
	for (const e of entries) {
		copyFileSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
	}
	writeFileSync(
		join(dir, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries }),
	);
	return dir;
}

describe.skipIf(!hasTestDb)("0109 moves the email onto the Person", () => {
	let clubId: string;

	beforeAll(async () => {
		const admin = new pg.Client({
			connectionString: process.env.TEST_DATABASE_URL,
		});
		await admin.connect();
		try {
			// Reap what a killed earlier run left — only databases nobody is using.
			const stale = await admin.query<{ datname: string }>(
				`select d.datname from pg_database d
				  where d.datname like 'tm_0109_%'
				    and not exists (
				      select 1 from pg_stat_activity a where a.datname = d.datname
				    )`,
			);
			for (const row of stale.rows) {
				await admin
					.query(`DROP DATABASE IF EXISTS "${row.datname}"`)
					.catch(() => {});
			}
			await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
		} finally {
			await admin.end();
		}

		pool = new pg.Pool({ connectionString: urlFor(SCRATCH_DB) });
		scratchDb = drizzle(pool, { schema });
		upToPrevious = migrationsBefore();
		await migrate(scratchDb, { migrationsFolder: upToPrevious });

		clubId = randomUUID();
		await scratchDb.execute(
			sql`insert into clubs (id, name, slug) values (${clubId}, '0109 Club', ${`club-0109-${clubId}`})`,
		);
	}, 60_000);

	afterAll(async () => {
		await pool?.end();
		if (upToPrevious) rmSync(upToPrevious, { recursive: true, force: true });
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

	async function runMigration(tx: Tx): Promise<void> {
		for (const statement of statements()) {
			await tx.execute(sql.raw(statement));
		}
	}

	async function seedPerson(
		tx: Tx,
		email: string | null,
		opts: { bound?: boolean } = {},
	): Promise<string> {
		const id = randomUUID();
		let userId: string | null = null;
		if (opts.bound) {
			userId = randomUUID();
			await tx.execute(
				sql`insert into "user" (id, name, email, email_verified)
				    values (${userId}, 'Bound', ${`bound-${userId}@test.example`}, true)`,
			);
		}
		await tx.execute(
			sql`insert into people (id, name, email, user_id)
			    values (${id}, 'Migration Person', ${email}, ${userId})`,
		);
		return id;
	}

	/** A membership, in its own club so a Person can hold several. */
	async function seedMembership(
		tx: Tx,
		personId: string,
		email: string | null,
		createdAt: string,
		id: string = randomUUID(),
	): Promise<string> {
		const club = randomUUID();
		await tx.execute(
			sql`insert into clubs (id, name, slug) values (${club}, 'Other', ${`club-0109-${club}`})`,
		);
		await tx.execute(
			sql`insert into members (id, club_id, person_id, name, email, created_at)
			    values (${id}, ${club}, ${personId}, 'Migration Person', ${email}, ${createdAt}::timestamp)`,
		);
		return id;
	}

	async function personEmail(tx: Tx, personId: string) {
		const r = await tx.execute<{ email: string | null }>(
			sql`select email from people where id = ${personId}`,
		);
		return r.rows[0]?.email ?? null;
	}

	async function backup(tx: Tx, personId: string) {
		const r = await tx.execute<{ email: string | null }>(
			sql`select email from people_email_backup_2 where person_id = ${personId}`,
		);
		return r.rows;
	}

	it("locks members first, then captures, backfills and drops — in that order", () => {
		expect(fileOrder()).toEqual([
			"lock",
			"create",
			"create",
			"capture members",
			"capture people",
			"backfill",
			"drop",
		]);
	});

	it("a BOUND Person keeps people.email, whatever its memberships say", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "verified@test.example", {
				bound: true,
			});
			await seedMembership(tx, personId, "typed@test.example", "2024-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("verified@test.example");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("an unbound single-club Person takes members.email, and the null is snapshotted", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			await seedMembership(
				tx,
				personId,
				"  Roster@Test.example ",
				"2024-01-01",
			);

			await runMigration(tx);

			// The trimmed text, as typed — not lower-cased.
			expect(await personEmail(tx, personId)).toBe("Roster@Test.example");
			expect(await backup(tx, personId)).toEqual([{ email: null }]);
		});
	});

	it("an unbound Person whose clubs AGREE takes the newest membership's text", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "old@test.example");
			await seedMembership(tx, personId, "agreed@test.example", "2023-01-01");
			await seedMembership(tx, personId, "AGREED@test.example", "2025-01-01");
			await seedMembership(tx, personId, null, "2026-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("AGREED@test.example");
			expect(await backup(tx, personId)).toEqual([
				{ email: "old@test.example" },
			]);
		});
	});

	it("a multi-club Person whose memberships DISAGREE is unchanged", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "kept@test.example");
			await seedMembership(tx, personId, "one@test.example", "2023-01-01");
			await seedMembership(tx, personId, "two@test.example", "2024-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("kept@test.example");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("a case- or whitespace-only difference is not a change: no write, no backup row", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "Same@Test.example");
			await seedMembership(tx, personId, " same@test.example\t", "2024-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("Same@Test.example");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("no address on any membership leaves the Person alone, never writing null", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "mine@test.example");
			await seedMembership(tx, personId, null, "2024-01-01");
			await seedMembership(tx, personId, "   ", "2025-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("mine@test.example");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("treats a blank Person address as absent and fills it", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "  ");
			await seedMembership(tx, personId, "fill@test.example", "2024-01-01");

			await runMigration(tx);

			expect(await personEmail(tx, personId)).toBe("fill@test.example");
			expect(await backup(tx, personId)).toEqual([{ email: "  " }]);
		});
	});

	it("backs up every non-blank membership address, as stored", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			const a = await seedMembership(
				tx,
				personId,
				"a@test.example",
				"2023-01-01",
			);
			const b = await seedMembership(
				tx,
				personId,
				" B@test.example",
				"2024-01-01",
			);
			const blank = await seedMembership(tx, personId, "  ", "2025-01-01");
			const none = await seedMembership(tx, personId, null, "2026-01-01");

			await runMigration(tx);

			const r = await tx.execute<{ member_id: string; email: string | null }>(
				sql`select member_id, email from members_email_backup
				    where member_id in (${a}, ${b}, ${blank}, ${none})`,
			);
			const byId = (x: { member_id: string }, y: { member_id: string }) =>
				x.member_id.localeCompare(y.member_id);
			expect([...r.rows].sort(byId)).toEqual(
				[
					{ member_id: a, email: "a@test.example" },
					{ member_id: b, email: " B@test.example" },
				].sort(byId),
			);
		});
	});

	it("snapshots every changed Person and only those", async () => {
		await inRolledBackTx(async (tx) => {
			const changedA = await seedPerson(tx, "before@test.example");
			await seedMembership(tx, changedA, "after@test.example", "2024-01-01");
			const changedB = await seedPerson(tx, null);
			await seedMembership(tx, changedB, "filled@test.example", "2024-01-01");
			const same = await seedPerson(tx, "same2@test.example");
			await seedMembership(tx, same, "same2@test.example", "2024-01-01");
			const bound = await seedPerson(tx, null, { bound: true });
			await seedMembership(tx, bound, "bound@test.example", "2024-01-01");

			await runMigration(tx);

			const r = await tx.execute<{ person_id: string }>(
				sql`select person_id from people_email_backup_2
				    where person_id in (${changedA}, ${changedB}, ${same}, ${bound})`,
			);
			expect(r.rows.map((x) => x.person_id).sort()).toEqual(
				[changedA, changedB].sort(),
			);
			expect(await personEmail(tx, bound)).toBeNull();
		});
	});

	it("is idempotent: a second run changes nothing and keeps the first snapshot", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "first@test.example");
			await seedMembership(tx, personId, "second@test.example", "2024-01-01");

			for (const create of statements().filter((s) =>
				/^CREATE TABLE/.test(s),
			)) {
				await tx.execute(sql.raw(create));
			}
			for (const s of dataStatements()) await tx.execute(sql.raw(s));
			for (const s of dataStatements()) await tx.execute(sql.raw(s));

			expect(await personEmail(tx, personId)).toBe("second@test.example");
			expect(await backup(tx, personId)).toEqual([
				{ email: "first@test.example" },
			]);
		});
	});

	it("drops members.email", async () => {
		await inRolledBackTx(async (tx) => {
			await runMigration(tx);
			const r = await tx.execute<{ n: number }>(
				sql`select count(*)::int as n from information_schema.columns
				    where table_name = 'members' and column_name = 'email'`,
			);
			expect(r.rows[0]?.n).toBe(0);
		});
	});

	// Last, because it COMMITS: the real runner applies 0109 to this database.
	it("applies through the real drizzle runner, backfilling committed rows", async () => {
		const personId = randomUUID();
		await scratchDb.execute(
			sql`insert into people (id, name, email) values (${personId}, 'Runner', null)`,
		);
		await scratchDb.execute(
			sql`insert into members (club_id, person_id, name, email)
			    values (${clubId}, ${personId}, 'Runner', 'runner@test.example')`,
		);

		await migrate(scratchDb, { migrationsFolder: DRIZZLE });

		const p = await scratchDb.execute<{ email: string | null }>(
			sql`select email from people where id = ${personId}`,
		);
		expect(p.rows[0]?.email).toBe("runner@test.example");
		const col = await scratchDb.execute<{ n: number }>(
			sql`select count(*)::int as n from information_schema.columns
			    where table_name = 'members' and column_name = 'email'`,
		);
		expect(col.rows[0]?.n).toBe(0);
	}, 60_000);
});
