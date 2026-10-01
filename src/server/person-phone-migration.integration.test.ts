/**
 * Migration 0107 (#906): `people.phone` becomes the only phone column.
 *
 * `bun run db:generate` writes the CREATE TABLE for `people_phone_backup` and
 * the `DROP COLUMN`; the capture and the backfill between them are hand-written
 * and nothing regenerates them. This test runs the file's OWN statements — read
 * out of the SQL file, never re-typed — against seeded rows, so a regenerated
 * migration that lost them fails here rather than in production.
 *
 * It runs against a database of its own, for the reason
 * `person-email-clear-migration.integration.test.ts` gives: the backfill is an
 * unscoped UPDATE over every Person, and running it against a database ~400
 * parallel files are mutating would take row locks on their fixtures.
 *
 * The scratch database is migrated only up to 0106 first, with the REAL drizzle
 * runner over a copy of the journal truncated there — so `members.phone` still
 * exists and rows can be seeded with it. Each case then runs 0107's statements
 * inside a transaction it rolls back. The last case runs the real runner over
 * the real `drizzle/` folder, which applies 0107 exactly as a deploy would.
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
const TAG = "0107_peaceful_kid_colt";
const MIGRATION = join(DRIZZLE, `${TAG}.sql`);

/** 0107's statements, split on drizzle's marker, leading comments stripped. */
function statements(): string[] {
	return readFileSync(MIGRATION, "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0);
}

/** The two hand-written data statements: the capture, then the backfill. */
function dataStatements(): {
	membersCapture: string;
	capture: string;
	backfill: string;
} {
	const all = statements();
	const membersCapture = all.filter((s) =>
		/^INSERT INTO "members_phone_backup"/.test(s),
	);
	const capture = all.filter((s) =>
		/^INSERT INTO "people_phone_backup"/.test(s),
	);
	const backfill = all.filter((s) => /^UPDATE "people"/.test(s));
	// Zero statements would pass every assertion below for the wrong reason —
	// the seeded rows would simply keep what they were given.
	expect(
		membersCapture,
		"0107 must carry its membership-phone capture",
	).toHaveLength(1);
	expect(capture, "0107 must carry its capture statement").toHaveLength(1);
	expect(backfill, "0107 must carry its backfill statement").toHaveLength(1);
	return {
		membersCapture: membersCapture[0] as string,
		capture: capture[0] as string,
		backfill: backfill[0] as string,
	};
}

/** The order the file runs them in matters: the lock BEFORE anything reads
 *  `members`, both captures BEFORE the overwrite, and all of it BEFORE the
 *  drop. */
function fileOrder(): string[] {
	return statements().map((s) => {
		if (/^LOCK TABLE "members" IN ACCESS EXCLUSIVE MODE;?$/.test(s))
			return "lock";
		if (/^CREATE TABLE/.test(s)) return "create";
		if (/^INSERT INTO "members_phone_backup"/.test(s)) return "capture members";
		if (/^INSERT INTO "people_phone_backup"/.test(s)) return "capture people";
		if (/^UPDATE "people"/.test(s)) return "backfill";
		if (/^ALTER TABLE "members" DROP COLUMN "phone"/.test(s)) return "drop";
		return `other: ${s.slice(0, 40)}`;
	});
}

const SCRATCH_DB = `tm_0107_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

let pool: pg.Pool;
let scratchDb: ReturnType<typeof drizzle<typeof schema>>;
let upTo0106: string;

class Rollback extends Error {}
type Tx = Parameters<Parameters<(typeof scratchDb)["transaction"]>[0]>[0];

/** A copy of `drizzle/` whose journal stops at 0106. */
function migrationsBefore0107(): string {
	const dir = mkdtempSync(join(tmpdir(), "tm-0107-"));
	mkdirSync(join(dir, "meta"));
	const journal = JSON.parse(
		readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8"),
	) as { entries: Array<{ idx: number; tag: string }> };
	const entries = journal.entries.filter((e) => e.idx < 107);
	expect(entries.at(-1)?.idx, "the journal must run up to 0106").toBe(106);
	for (const e of entries) {
		copyFileSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
	}
	writeFileSync(
		join(dir, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries }),
	);
	return dir;
}

describe.skipIf(!hasTestDb)("0107 moves the phone onto the Person", () => {
	let clubId: string;

	beforeAll(async () => {
		const admin = new pg.Client({
			connectionString: process.env.TEST_DATABASE_URL,
		});
		await admin.connect();
		try {
			// Reap what a killed earlier run left — only databases nobody is using,
			// and never WITH (FORCE): a parallel run of this file is normal here.
			const stale = await admin.query<{ datname: string }>(
				`select d.datname from pg_database d
				  where d.datname like 'tm_0107_%'
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
		upTo0106 = migrationsBefore0107();
		await migrate(scratchDb, { migrationsFolder: upTo0106 });

		clubId = randomUUID();
		await scratchDb.execute(
			sql`insert into clubs (id, name, slug) values (${clubId}, '0107 Club', ${`club-0107-${clubId}`})`,
		);
	}, 60_000);

	afterAll(async () => {
		await pool?.end();
		if (upTo0106) rmSync(upTo0106, { recursive: true, force: true });
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

	/** Every 0107 statement, in file order, on `tx` — the drop included. */
	async function runMigration(tx: Tx): Promise<void> {
		for (const statement of statements()) {
			await tx.execute(sql.raw(statement));
		}
	}

	/** Just the capture and the backfill, so they can be run twice. */
	async function runData(tx: Tx): Promise<void> {
		const { membersCapture, capture, backfill } = dataStatements();
		await tx.execute(sql.raw(membersCapture));
		await tx.execute(sql.raw(capture));
		await tx.execute(sql.raw(backfill));
	}

	async function createBackupTables(tx: Tx): Promise<void> {
		for (const create of statements().filter((s) => /^CREATE TABLE/.test(s))) {
			await tx.execute(sql.raw(create));
		}
	}

	async function seedPerson(tx: Tx, phone: string | null): Promise<string> {
		const id = randomUUID();
		await tx.execute(
			sql`insert into people (id, name, phone) values (${id}, 'Migration Person', ${phone})`,
		);
		return id;
	}

	/** A membership, in its own club so a Person can hold several. */
	async function seedMembership(
		tx: Tx,
		personId: string,
		phone: string | null,
		createdAt: string,
		id: string = randomUUID(),
	): Promise<string> {
		const club = randomUUID();
		await tx.execute(
			sql`insert into clubs (id, name, slug) values (${club}, 'Other', ${`club-0107-${club}`})`,
		);
		await tx.execute(
			sql`insert into members (id, club_id, person_id, name, phone, created_at)
			    values (${id}, ${club}, ${personId}, 'Migration Person', ${phone}, ${createdAt}::timestamp)`,
		);
		return id;
	}

	async function personPhone(tx: Tx, personId: string) {
		const r = await tx.execute<{ phone: string | null }>(
			sql`select phone from people where id = ${personId}`,
		);
		return r.rows[0]?.phone ?? null;
	}

	async function backup(tx: Tx, personId: string) {
		const r = await tx.execute<{ phone: string | null }>(
			sql`select phone from people_phone_backup where person_id = ${personId}`,
		);
		return r.rows;
	}

	it("locks members first, then captures, backfills and drops — in that order", () => {
		// The lock must be the FIRST statement: drizzle runs the file in one READ
		// COMMITTED transaction while the old container still serves, so an edit
		// between the capture and the DROP would otherwise escape the backup or
		// be lost outright.
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

	it("backs up exactly the memberships whose phone has a digit, as stored", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			const newer = await seedMembership(
				tx,
				personId,
				"+14155550201",
				"2025-01-01",
			);
			// The older, losing membership: its number is NOT the one the Person
			// keeps, which is exactly why it has to survive somewhere.
			const older = await seedMembership(
				tx,
				personId,
				"(415) 555-0202",
				"2020-01-01",
			);
			const blank = await seedMembership(tx, personId, "   ", "2021-01-01");
			const none = await seedMembership(tx, personId, null, "2022-01-01");
			const words = await seedMembership(
				tx,
				personId,
				"call the office",
				"2023-01-01",
			);

			await runMigration(tx);

			const r = await tx.execute<{
				member_id: string;
				person_id: string;
				phone: string | null;
			}>(
				sql`select member_id, person_id, phone from members_phone_backup
				    where member_id in (${newer}, ${older}, ${blank}, ${none}, ${words})`,
			);
			const byMember = (x: { member_id: string }, y: { member_id: string }) =>
				x.member_id.localeCompare(y.member_id);
			expect([...r.rows].sort(byMember)).toEqual(
				[
					{ member_id: older, person_id: personId, phone: "(415) 555-0202" },
					{ member_id: newer, person_id: personId, phone: "+14155550201" },
				].sort(byMember),
			);
			expect(await personPhone(tx, personId)).toBe("+14155550201");
		});
	});

	it("documents current behaviour: a national number vs its E.164 form is overwritten", async () => {
		// Not a formatting-only difference by this migration's rule: "4155550210"
		// and "14155550210" are different digit strings, so the membership's
		// value replaces the Person's and the old value is backed up. The PR's
		// prod check counts these as `format_only` so the maintainer can decide
		// from real numbers whether this case needs different handling.
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "(415) 555-0210");
			await seedMembership(tx, personId, "+14155550210", "2024-01-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550210");
			expect(await backup(tx, personId)).toEqual([{ phone: "(415) 555-0210" }]);
		});
	});

	it("takes the membership's phone over a disagreeing Person phone, and backs the old one up", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "+14155550001");
			await seedMembership(tx, personId, "+14155550099", "2024-01-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550099");
			expect(await backup(tx, personId)).toEqual([{ phone: "+14155550001" }]);
		});
	});

	it("picks the NEWEST membership with a phone when two disagree", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			await seedMembership(tx, personId, "+14155550011", "2024-01-01");
			await seedMembership(tx, personId, "+14155550022", "2025-06-01");
			await seedMembership(tx, personId, "+14155550033", "2023-03-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550022");
		});
	});

	it("breaks a created_at tie on the higher membership id", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			await seedMembership(
				tx,
				personId,
				"+14155550044",
				"2024-01-01",
				"00000000-0000-4000-8000-000000000001",
			);
			await seedMembership(
				tx,
				personId,
				"+14155550055",
				"2024-01-01",
				"ffffffff-0000-4000-8000-000000000001",
			);

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550055");
		});
	});

	it("skips a newer membership whose phone is null, empty or digit-free", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			await seedMembership(tx, personId, "+14155550066", "2020-01-01");
			await seedMembership(tx, personId, null, "2024-01-01");
			await seedMembership(tx, personId, "", "2024-02-01");
			await seedMembership(tx, personId, "call the office", "2024-03-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550066");
		});
	});

	it("fills a Person with no phone, and backs up the null", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, null);
			await seedMembership(tx, personId, "+14155550077", "2024-01-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550077");
			expect(await backup(tx, personId)).toEqual([{ phone: null }]);
		});
	});

	it("treats a digit-free Person phone as absent and fills it", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "n/a");
			await seedMembership(tx, personId, "+14155550078", "2024-01-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550078");
			expect(await backup(tx, personId)).toEqual([{ phone: "n/a" }]);
		});
	});

	it("never writes null over a value: no present membership phone leaves the Person alone", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "+14155550088");
			await seedMembership(tx, personId, null, "2024-01-01");
			await seedMembership(tx, personId, "   ", "2025-01-01");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550088");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("leaves a Person with no membership at all alone", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "+14155550089");

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550089");
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("a formatting-only difference is not a change: no write, no backup row", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "(415) 555-0090");
			await seedMembership(tx, personId, "415.555.0090", "2024-01-01");
			// Not E.164 on either side, and the digits agree — so it stays as typed.
			const formatted = "(415) 555-0090";

			await runMigration(tx);

			expect(await personPhone(tx, personId)).toBe(formatted);
			expect(await backup(tx, personId)).toEqual([]);
		});
	});

	it("is idempotent: a second run changes nothing and keeps the first snapshot", async () => {
		await inRolledBackTx(async (tx) => {
			const personId = await seedPerson(tx, "+14155550101");
			await seedMembership(tx, personId, "+14155550102", "2024-01-01");

			await createBackupTables(tx);
			await runData(tx);
			// A re-run sees the digits agree: no second write, and the capture's
			// ON CONFLICT keeps the PRE-migration snapshot rather than the new value.
			await runData(tx);

			expect(await personPhone(tx, personId)).toBe("+14155550102");
			expect(await backup(tx, personId)).toEqual([{ phone: "+14155550101" }]);
			const n = await tx.execute<{ n: number }>(
				sql`select count(*)::int as n from people_phone_backup where person_id = ${personId}`,
			);
			expect(n.rows[0]?.n).toBe(1);
		});
	});

	it("records every changed Person and only those", async () => {
		await inRolledBackTx(async (tx) => {
			const changedA = await seedPerson(tx, "+14155550111");
			await seedMembership(tx, changedA, "+14155550112", "2024-01-01");
			const changedB = await seedPerson(tx, null);
			await seedMembership(tx, changedB, "+14155550113", "2024-01-01");
			const same = await seedPerson(tx, "+14155550114");
			await seedMembership(tx, same, "+14155550114", "2024-01-01");

			await runMigration(tx);

			const r = await tx.execute<{ person_id: string }>(
				sql`select person_id from people_phone_backup
				    where person_id in (${changedA}, ${changedB}, ${same})`,
			);
			expect(r.rows.map((x) => x.person_id).sort()).toEqual(
				[changedA, changedB].sort(),
			);
		});
	});

	it("drops members.phone", async () => {
		await inRolledBackTx(async (tx) => {
			await runMigration(tx);
			const r = await tx.execute<{ n: number }>(
				sql`select count(*)::int as n from information_schema.columns
				    where table_name = 'members' and column_name = 'phone'`,
			);
			expect(r.rows[0]?.n).toBe(0);
		});
	});

	// Last, because it COMMITS: the real runner applies 0107 to this database.
	it("applies through the real drizzle runner, backfilling committed rows", async () => {
		const personId = randomUUID();
		await scratchDb.execute(
			sql`insert into people (id, name, phone) values (${personId}, 'Runner', null)`,
		);
		await scratchDb.execute(
			sql`insert into members (club_id, person_id, name, phone)
			    values (${clubId}, ${personId}, 'Runner', '+14155550120')`,
		);

		await migrate(scratchDb, { migrationsFolder: DRIZZLE });

		const p = await scratchDb.execute<{ phone: string | null }>(
			sql`select phone from people where id = ${personId}`,
		);
		expect(p.rows[0]?.phone).toBe("+14155550120");
		const col = await scratchDb.execute<{ n: number }>(
			sql`select count(*)::int as n from information_schema.columns
			    where table_name = 'members' and column_name = 'phone'`,
		);
		expect(col.rows[0]?.n).toBe(0);
	}, 60_000);
});
