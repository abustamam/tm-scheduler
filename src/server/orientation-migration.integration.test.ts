/**
 * Migration 0102 (#940): existing memberships stay OUT of orientation, and
 * memberships inserted afterwards are IN it.
 *
 * The trap this pins: drizzle-kit generated
 * `ADD COLUMN "orientation_started_at" timestamp DEFAULT now()`, and in
 * Postgres that one statement fills EVERY EXISTING row with now(), putting
 * every veteran member in orientation. The committed SQL is hand-edited into
 * two statements (add with no default, then SET DEFAULT). Nothing regenerates
 * that edit and nothing else can see it: worktree and CI test databases are
 * `db:push`-synced from `schema.ts`, which never runs the SQL file.
 *
 * So this runs the REAL drizzle runner against a scratch database of its own:
 * first every migration BEFORE 0102 (from a copy of `drizzle/` whose journal
 * stops at 0101), then a membership row inserted the way it existed then, then
 * the real folder (which applies 0102 alone), then a second membership. The
 * pre-existing row must read null and the later one a timestamp. A regenerated
 * one-statement migration fails the first assertion.
 *
 * Its own database for the reason `person-email-clear-migration` gives: a
 * migration is global, and running one against the database 400 parallel
 * files are mutating is a category error.
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
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";

const MIGRATIONS = resolve(process.cwd(), "drizzle");
const TAG = "0102_chunky_sir_ram";
const SCRATCH_DB = `tm_0102_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

interface JournalEntry {
	idx: number;
	tag: string;
}

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

/** A copy of `drizzle/` whose journal stops just before 0102. */
function migrationsBefore0102(): string {
	const journal = JSON.parse(
		readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };
	const at = journal.entries.findIndex((e) => e.tag === TAG);
	expect(at, `${TAG} is not in the journal`).toBeGreaterThan(0);
	const before = journal.entries.slice(0, at);
	const dir = mkdtempSync(join(tmpdir(), "tm-0102-"));
	mkdirSync(join(dir, "meta"));
	for (const e of before) {
		copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
	}
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ ...journal, entries: before }),
	);
	return dir;
}

let pool: pg.Pool;
let partialDir: string;

describe.skipIf(!hasTestDb)("migration 0102: orientation columns", () => {
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
				  where d.datname like 'tm_0102_%'
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
		partialDir = migrationsBefore0102();
	}, 60_000);

	afterAll(async () => {
		await pool?.end();
		if (partialDir) rmSync(partialDir, { recursive: true, force: true });
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

	it("leaves existing memberships null and defaults new ones to now()", async () => {
		const scratch = drizzle(pool);
		await migrate(scratch, { migrationsFolder: partialDir });

		// The column must not exist yet, or this is not a "before" state.
		const cols = await pool.query(
			`select 1 from information_schema.columns
			  where table_name = 'members' and column_name = 'orientation_started_at'`,
		);
		expect(cols.rowCount).toBe(0);

		const clubId = randomUUID();
		await pool.query(
			`insert into clubs (id, name, slug) values ($1, '0102 Club', $2)`,
			[clubId, `club-0102-${clubId}`],
		);
		const insertMember = async (name: string) => {
			const person = await pool.query<{ id: string }>(
				`insert into people (name) values ($1) returning id`,
				[name],
			);
			const member = await pool.query<{ id: string }>(
				`insert into members (club_id, person_id, name) values ($1, $2, $3) returning id`,
				[clubId, person.rows[0]?.id, name],
			);
			return member.rows[0]?.id as string;
		};
		const veteran = await insertMember("Veteran Member");

		// The real folder: applies 0102 and nothing else.
		await migrate(scratch, { migrationsFolder: MIGRATIONS });

		const newcomer = await insertMember("New Member");
		const rows = await pool.query<{
			id: string;
			orientation_started_at: Date | null;
			orientation_dismissed_at: Date | null;
			basecamp_setup_at: Date | null;
		}>(
			`select id, orientation_started_at, orientation_dismissed_at, basecamp_setup_at
			   from members where club_id = $1`,
			[clubId],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r]));
		expect(byId.get(veteran)?.orientation_started_at).toBeNull();
		expect(byId.get(newcomer)?.orientation_started_at).toBeInstanceOf(Date);
		for (const r of rows.rows) {
			expect(r.orientation_dismissed_at).toBeNull();
			expect(r.basecamp_setup_at).toBeNull();
		}
	}, 120_000);
});
