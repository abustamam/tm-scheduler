/**
 * Migration 0118 (#1126, ADR-0031): catch up whatever the old container wrote to
 * `guests.email` / `guests.phone` after 0117's copy, then drop both columns.
 *
 * Like `guest-contact-migration.integration.test.ts` for 0117 this runs the REAL
 * drizzle runner on a scratch database of its own: every migration through 0117,
 * guests seeded with contact in the dead columns as the old container left them,
 * then the folder through 0118, which applies 0118 alone. A worktree or CI test
 * database is `db:push`-synced from `schema.ts`, which no longer has the columns,
 * so the migration cannot be exercised there. The migration takes `ACCESS
 * EXCLUSIVE` on `guests`, which is the other reason for a database of its own.
 */
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const PREVIOUS_TAG = "0117_superb_nova";
const FILE = readdirSync(MIGRATIONS).find((f) => /^0118_.*\.sql$/.test(f));
const THIS_TAG = (FILE ?? "").replace(/\.sql$/, "");
const SCRATCH_DB = `tm_0118_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

interface JournalEntry {
	idx: number;
	tag: string;
}

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

/** A copy of `drizzle/` whose journal stops after the entry tagged `tag`. */
function migrationsThrough(tag: string): string {
	const journal = JSON.parse(
		readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };
	const at = journal.entries.findIndex((e) => e.tag === tag);
	expect(at, `${tag} is not in the journal`).toBeGreaterThan(0);
	const through = journal.entries.slice(0, at + 1);
	const dir = mkdtempSync(join(tmpdir(), "tm-0118-"));
	mkdirSync(join(dir, "meta"));
	for (const e of through) {
		copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
	}
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ ...journal, entries: through }),
	);
	return dir;
}

/** The migration's statements, comments stripped, in order. */
function statements(): string[] {
	if (!FILE) throw new Error("drizzle/0118_*.sql is missing");
	return readFileSync(join(MIGRATIONS, FILE), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0);
}

describe("the migration file's shape", () => {
	it("is the lock, the two catch-up copies, then the two drops, in that order", () => {
		const all = statements();
		const kind = (s: string) => s.split(/\s+/).slice(0, 2).join(" ");
		expect(all.map(kind)).toEqual([
			"LOCK TABLE",
			'UPDATE "people"',
			'UPDATE "people"',
			"ALTER TABLE",
			"ALTER TABLE",
		]);
		expect(all[0]).toMatch(/"guests" IN ACCESS EXCLUSIVE MODE/);
		expect(all[3]).toBe('ALTER TABLE "guests" DROP COLUMN "email";');
		expect(all[4]).toBe('ALTER TABLE "guests" DROP COLUMN "phone";');
		// Never touches the forensic copy 0117 made.
		expect(all.join("\n")).not.toMatch(/guests_contact_backup/);
	});
});

let pool: pg.Pool;
let partialDir: string;
let throughDir: string;

describe.skipIf(!hasTestDb)(
	"migration 0118: drop guests.email and guests.phone",
	() => {
		beforeAll(async () => {
			const admin = new pg.Client({
				connectionString: process.env.TEST_DATABASE_URL,
			});
			await admin.connect();
			try {
				// Reap abandoned scratch databases with no live backend (never FORCE:
				// another run of this file may be using its own).
				const stale = await admin.query<{ datname: string }>(
					`select d.datname from pg_database d
				  where d.datname like 'tm_0118_%'
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
			partialDir = migrationsThrough(PREVIOUS_TAG);
			throughDir = migrationsThrough(THIS_TAG);
			await migrate(drizzle(pool), { migrationsFolder: partialDir });
		}, 120_000);

		afterAll(async () => {
			await pool?.end();
			if (partialDir) rmSync(partialDir, { recursive: true, force: true });
			if (throughDir) rmSync(throughDir, { recursive: true, force: true });
			const admin = new pg.Client({
				connectionString: process.env.TEST_DATABASE_URL,
			});
			await admin.connect();
			try {
				await admin.query(
					`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`,
				);
			} finally {
				await admin.end();
			}
		}, 60_000);

		const one = async <T extends pg.QueryResultRow>(
			sql: string,
			params: unknown[] = [],
		): Promise<T> => {
			const res = await pool.query<T>(sql, params);
			const row = res.rows[0];
			if (!row) throw new Error(`no row: ${sql}`);
			return row;
		};

		it("catches up a guest the old container wrote during the swap, respects the same arms as 0117, and drops both columns", async () => {
			const clubId = randomUUID();
			const clubB = randomUUID();
			for (const id of [clubId, clubB]) {
				await pool.query(
					`insert into clubs (id, name, slug) values ($1, '0118 Club', $2)`,
					[id, `club-0118-${id}`],
				);
			}
			const person = async (
				name: string,
				over: { email?: string; phone?: string; userId?: string } = {},
			) =>
				(
					await one<{ id: string }>(
						`insert into people (name, email, phone, user_id) values ($1, $2, $3, $4) returning id`,
						[name, over.email ?? null, over.phone ?? null, over.userId ?? null],
					)
				).id;
			// `person_id` is NOT NULL since 0117, so every guest has a Person; the
			// contact goes into the dead columns, as the old container wrote it.
			const guest = async (
				club: string,
				personId: string,
				o: { email?: string; phone?: string; createdAt?: string } = {},
			) =>
				(
					await one<{ id: string }>(
						`insert into guests (club_id, name, email, phone, person_id, created_at)
						 values ($1, 'G', $2, $3, $4, coalesce($5::timestamp, now())) returning id`,
						[
							club,
							o.email ?? null,
							o.phone ?? null,
							personId,
							o.createdAt ?? null,
						],
					)
				).id;
			const read = (id: string) =>
				one<{ email: string | null; phone: string | null }>(
					`select email, phone from people where id = $1`,
					[id],
				);

			// AC1: a guest created with only `guests.email` set (A's code during B's
			// swap) on a name-only guest-only Person.
			const swapEmail = await person("Swap Email");
			await guest(clubId, swapEmail, { email: "swap@x.test" });
			const swapPhone = await person("Swap Phone");
			await guest(clubId, swapPhone, { phone: "+15550000002" });
			// Both fields, each judged on its own: the Person's phone is kept, its
			// blank email is filled.
			const hasPhone = await person("Has Phone", { phone: "+15550000099" });
			await guest(clubId, hasPhone, {
				email: "fills@x.test",
				phone: "+15550000014",
			});
			// An existing value is never overwritten (the accepted residual).
			const hasEmail = await person("Has Email", { email: "keeps@x.test" });
			await guest(clubId, hasEmail, { email: "typed@x.test" });
			// A member's Person and a signed-in Person: a guest row never writes them.
			const memberPerson = await person("Member Blank");
			await pool.query(
				`insert into members (club_id, person_id, name) values ($1, $2, 'Member Blank')`,
				[clubB, memberPerson],
			);
			await guest(clubId, memberPerson, {
				email: "for-member@x.test",
				phone: "+15550000012",
			});
			const userId = `user-${randomUUID()}`;
			await pool.query(
				`insert into "user" (id, name, email) values ($1, 'Bound', $2)`,
				[userId, `${userId}@x.test`],
			);
			const bound = await person("Bound", { userId });
			await guest(clubId, bound, {
				email: "for-bound@x.test",
				phone: "+15550000013",
			});
			// A removed member's Person reads guest-only but its contact is the member's.
			const removed = await person("Removed Member");
			await guest(clubId, removed, {
				email: "removed@x.test",
				phone: "+15550000015",
			});
			await pool.query(
				`insert into activity_log (club_id, action, target_type, target_id, detail)
				 values ($1, 'member_remove', 'member', $2, $3::jsonb)`,
				[clubId, randomUUID(), JSON.stringify({ personId: removed })],
			);
			// Roster-identity columns disqualify a Person too.
			const roster = await person("Roster");
			await pool.query(
				`update people set customer_id = 'PN-0118' where id = $1`,
				[roster],
			);
			await guest(clubId, roster, { email: "roster@x.test" });
			// Two guest rows on one guest-only Person: the OLDEST row with the field wins.
			const shared = await person("Shared Human");
			await guest(clubId, shared, {
				email: "older@x.test",
				createdAt: "2024-01-01T00:00:00",
			});
			await guest(clubB, shared, {
				email: "newer@x.test",
				phone: "+15550000021",
				createdAt: "2025-01-01T00:00:00",
			});

			const backupBefore = await one<{ n: number }>(
				`select count(*)::int as n from guests_contact_backup`,
			);

			// The real files, the folder ending at 0118: applies 0118 and nothing else.
			await migrate(drizzle(pool), { migrationsFolder: throughDir });

			expect(await read(swapEmail)).toEqual({
				email: "swap@x.test",
				phone: null,
			});
			expect(await read(swapPhone)).toEqual({
				email: null,
				phone: "+15550000002",
			});
			expect(await read(hasPhone)).toEqual({
				email: "fills@x.test",
				phone: "+15550000099",
			});
			expect(await read(hasEmail)).toEqual({
				email: "keeps@x.test",
				phone: null,
			});
			expect(await read(memberPerson)).toEqual({ email: null, phone: null });
			expect(await read(bound)).toEqual({ email: null, phone: null });
			expect(await read(removed)).toEqual({ email: null, phone: null });
			expect(await read(roster)).toEqual({ email: null, phone: null });
			expect(await read(shared)).toEqual({
				email: "older@x.test",
				phone: "+15550000021",
			});

			// Both columns are gone; the rest of `guests` and 0117's backup are intact.
			const cols = await pool.query<{ column_name: string }>(
				`select column_name from information_schema.columns
				  where table_name = 'guests' and column_name in ('email', 'phone')`,
			);
			expect(cols.rows).toEqual([]);
			const guestCols = await pool.query<{ column_name: string }>(
				`select column_name from information_schema.columns
				  where table_name = 'guests' and column_name in ('name', 'person_id')`,
			);
			expect(guestCols.rows).toHaveLength(2);
			const backupAfter = await one<{ n: number }>(
				`select count(*)::int as n from guests_contact_backup`,
			);
			expect(backupAfter.n).toBe(backupBefore.n);
		}, 120_000);
	},
);
