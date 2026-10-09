/**
 * Migration 0116 (#1124, ADR-0031): every guest row gets a Person.
 *
 * The backfill is hand-written SQL that nothing regenerates and nothing else can
 * see: worktree and CI test databases are `db:push`-synced from `schema.ts`,
 * which never runs the SQL file. So this runs the REAL drizzle runner against a
 * scratch database of its own: every migration BEFORE 0116 (from a copy of
 * `drizzle/` whose journal stops there), then guests inserted the way they
 * existed then (no `person_id` column), then the real folder, which applies 0116
 * alone.
 *
 * The three shapes the rule distinguishes:
 *   - converted: the guest takes its membership's Person, and no row is minted;
 *   - unconverted: a fresh Person carrying the guest's name (and goes-by name),
 *     and NO contact, which moves in #1125;
 *   - stranded (`joined`, the membership since removed, pointer null): matches no
 *     member row, so it is handled with the unconverted ones.
 *
 * Its own database for the reason `orientation-migration.integration.test.ts`
 * gives: a migration is global, and running one against the database 400
 * parallel files are mutating is a category error.
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
const TAG = "0116_parched_sheva_callister";
const SCRATCH_DB = `tm_0116_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

interface JournalEntry {
	idx: number;
	tag: string;
}

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

/** A copy of `drizzle/` whose journal stops just before 0116. */
function migrationsBefore0116(): string {
	const journal = JSON.parse(
		readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };
	const at = journal.entries.findIndex((e) => e.tag === TAG);
	expect(at, `${TAG} is not in the journal`).toBeGreaterThan(0);
	const before = journal.entries.slice(0, at);
	const dir = mkdtempSync(join(tmpdir(), "tm-0116-"));
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

describe.skipIf(!hasTestDb)("migration 0116: guests.person_id", () => {
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
				  where d.datname like 'tm_0116_%'
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
		partialDir = migrationsBefore0116();
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

	it("gives every guest a Person: converted ones their member's, the rest a fresh name-only one", async () => {
		await migrate(drizzle(pool), { migrationsFolder: partialDir });

		// The column must not exist yet, or this is not a "before" state.
		const cols = await pool.query(
			`select 1 from information_schema.columns
			  where table_name = 'guests' and column_name = 'person_id'`,
		);
		expect(cols.rowCount).toBe(0);

		const clubId = randomUUID();
		await pool.query(
			`insert into clubs (id, name, slug) values ($1, '0116 Club', $2)`,
			[clubId, `club-0116-${clubId}`],
		);
		const member = await pool.query<{ person_id: string; id: string }>(
			`with p as (insert into people (name) values ('Ravi Anand') returning id)
			 insert into members (club_id, person_id, name)
			 select $1, p.id, 'Ravi Anand' from p returning id, person_id`,
			[clubId],
		);
		const memberRow = member.rows[0];
		if (!memberRow) throw new Error("member fixture");

		const insertGuest = async (
			name: string,
			opts: {
				preferredName?: string;
				email?: string;
				stage?: string;
				convertedMembershipId?: string;
			} = {},
		) => {
			const res = await pool.query<{ id: string; created_at: Date }>(
				`insert into guests
				   (club_id, name, preferred_name, email, stage, converted_membership_id)
				 values ($1, $2, $3, $4, $5, $6) returning id, created_at`,
				[
					clubId,
					name,
					opts.preferredName ?? null,
					opts.email ?? null,
					opts.stage ?? "prospect",
					opts.convertedMembershipId ?? null,
				],
			);
			return res.rows[0] as { id: string; created_at: Date };
		};
		const converted = await insertGuest("Ravi Anand", {
			stage: "joined",
			convertedMembershipId: memberRow.id,
		});
		const unconverted = await insertGuest("Priyanka Rao", {
			preferredName: "Pri",
			email: "priyanka@example.com",
		});
		// Stranded: it joined, then the membership was removed (`SET NULL`).
		const stranded = await insertGuest("Elena Sokolova", { stage: "joined" });

		const peopleBefore = await pool.query<{ n: number }>(
			`select count(*)::int as n from people`,
		);

		// The real folder: applies 0116 and nothing else.
		await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

		const rows = await pool.query<{
			id: string;
			person_id: string | null;
			converted_membership_id: string | null;
		}>(`select id, person_id, converted_membership_id from guests`);
		const byId = new Map(rows.rows.map((r) => [r.id, r]));

		// AC1: every pre-existing guest row has a person_id.
		expect(rows.rows.every((r) => r.person_id !== null)).toBe(true);

		// AC2: a converted guest IS its membership's Person.
		expect(byId.get(converted.id)?.person_id).toBe(memberRow.person_id);

		// AC3: exactly one new Person per unconverted guest (stranded included),
		// each carrying that guest's name, and no contact.
		const peopleAfter = await pool.query<{ n: number }>(
			`select count(*)::int as n from people`,
		);
		expect(peopleAfter.rows[0]?.n).toBe((peopleBefore.rows[0]?.n ?? 0) + 2);
		const fresh = await pool.query<{
			id: string;
			name: string;
			preferred_name: string | null;
			email: string | null;
			phone: string | null;
			user_id: string | null;
			created_at: Date;
		}>(
			`select id, name, preferred_name, email, phone, user_id, created_at
			   from people where id = any($1::uuid[])`,
			[[byId.get(unconverted.id)?.person_id, byId.get(stranded.id)?.person_id]],
		);
		const freshById = new Map(fresh.rows.map((p) => [p.id, p]));
		const forUnconverted = freshById.get(
			byId.get(unconverted.id)?.person_id ?? "",
		);
		const forStranded = freshById.get(byId.get(stranded.id)?.person_id ?? "");
		expect(forUnconverted?.name).toBe("Priyanka Rao");
		expect(forUnconverted?.preferred_name).toBe("Pri");
		expect(forUnconverted?.created_at).toEqual(unconverted.created_at);
		// Name only: the guest's contact moves in #1125, and a guest-book address
		// is not a Person's until a member vouches for it.
		expect(forUnconverted?.email).toBeNull();
		expect(forUnconverted?.phone).toBeNull();
		expect(forUnconverted?.user_id).toBeNull();
		// The stranded guest is not folded into anyone: its own Person.
		expect(forStranded?.name).toBe("Elena Sokolova");
		expect(forStranded?.id).not.toBe(forUnconverted?.id);
		expect(forStranded?.id).not.toBe(memberRow.person_id);

		// The pointer is untouched, and the member's Person was not written.
		expect(byId.get(converted.id)?.converted_membership_id).toBe(memberRow.id);
		expect(byId.get(stranded.id)?.converted_membership_id).toBeNull();

		// The foreign key is RESTRICT (a Person delete that forgot a guest fails
		// loudly instead of cascading its visit, role and speech history away), the
		// column is still nullable until #1125, and the index exists.
		const fk = await pool.query<{ confdeltype: string }>(
			`select confdeltype from pg_constraint
			  where conname = 'guests_person_id_people_id_fk'
			    and conrelid = 'guests'::regclass`,
		);
		expect(fk.rows[0]?.confdeltype).toBe("r");
		const col = await pool.query<{ is_nullable: string }>(
			`select is_nullable from information_schema.columns
			  where table_name = 'guests' and column_name = 'person_id'`,
		);
		expect(col.rows[0]?.is_nullable).toBe("YES");
		const idx = await pool.query(
			`select 1 from pg_indexes
			  where tablename = 'guests' and indexname = 'guests_person_idx'`,
		);
		expect(idx.rowCount).toBe(1);

		// A temp table lives as long as its pooled session, so the migration drops
		// the one it used. Looked up by name across the session's temp schemas.
		const leftover = await pool.query(
			`select 1 from pg_class where relname = 'guest_person_map'`,
		);
		expect(leftover.rowCount).toBe(0);
	}, 120_000);
});
