/**
 * Migration 0119 (#1157, ADR-0029): add `guests.book_email` and move the address
 * of every GUEST-ONLY Person (never signed in, no membership, named by a guest
 * row) off `people.email` and onto the guest rows that name it.
 *
 * Like `guest-contact-drop-migration.integration.test.ts` for 0118 this runs the
 * REAL drizzle runner on a scratch database of its own: every migration through
 * 0118, Persons seeded in the four shapes the issue names, then the folder
 * through 0119, which applies 0119 alone. A worktree or CI test database is
 * `db:push`-synced from `schema.ts`, which already has the column, so the
 * migration's data statements cannot be exercised there, and they are NEVER run
 * against the shared test database.
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
const PREVIOUS_TAG = "0118_drop_guest_contact";
const FILE = readdirSync(MIGRATIONS).find((f) => /^0119_.*\.sql$/.test(f));
const THIS_TAG = (FILE ?? "").replace(/\.sql$/, "");
const SCRATCH_DB = `tm_0119_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

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
	const dir = mkdtempSync(join(tmpdir(), "tm-0119-"));
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
	if (!FILE) throw new Error("drizzle/0119_*.sql is missing");
	return readFileSync(join(MIGRATIONS, FILE), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0);
}

let pool: pg.Pool;
let partialDir: string;
let throughDir: string;

describe.skipIf(!hasTestDb)(
	"migration 0119: guests.book_email and the guest-only Person move",
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
				  where d.datname like 'tm_0119_%'
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

		// protects=the data statements move ONLY a guest-only Person's address (to every guest row naming it) and leave a member's, a signed-in non-member's, and a guest-less Person's untouched;
		// fails_when=a WHERE arm is dropped (the membership or user_id exclusion, or the guest-row requirement), so a vouched or guest-less address is wiped or copied;
		// no_claim=the app code (separate tests); the statements run on a scratch database seeded by raw SQL, and a second run of them is shown to change nothing.
		it("moves only the guest-only Person's address, and a re-run changes nothing (AC 13)", async () => {
			const clubA = randomUUID();
			const clubB = randomUUID();
			for (const id of [clubA, clubB]) {
				await pool.query(
					`insert into clubs (id, name, slug) values ($1, '0119 Club', $2)`,
					[id, `club-0119-${id}`],
				);
			}
			const person = async (
				name: string,
				over: { email?: string; userId?: string } = {},
			) =>
				(
					await one<{ id: string }>(
						`insert into people (name, email, user_id) values ($1, $2, $3) returning id`,
						[name, over.email ?? null, over.userId ?? null],
					)
				).id;
			const guest = async (club: string, personId: string) =>
				(
					await one<{ id: string }>(
						`insert into guests (club_id, name, person_id) values ($1, 'G', $2) returning id`,
						[club, personId],
					)
				).id;

			// Shape 1: guest-only with an email, named by two guest rows (two clubs).
			const guestOnly = await person("Guest Only", { email: "g@x.test" });
			const g1a = await guest(clubA, guestOnly);
			const g1b = await guest(clubB, guestOnly);
			// A guest-only Person with no email: nothing to move.
			const noEmail = await person("No Email");
			const gNoEmail = await guest(clubA, noEmail);
			// Shape 2: a member's Person, which also has a guest row.
			const member = await person("Member", { email: "m@x.test" });
			await pool.query(
				`insert into members (club_id, person_id, name) values ($1, $2, 'Member')`,
				[clubB, member],
			);
			const gMember = await guest(clubA, member);
			// Shape 3: a signed-in Person who holds no membership, with a guest row.
			const userId = `user-${randomUUID()}`;
			await pool.query(
				`insert into "user" (id, name, email) values ($1, 'Signed In', $2)`,
				[userId, `${userId}@x.test`],
			);
			const signedIn = await person("Signed In", {
				email: "s@x.test",
				userId,
			});
			const gSignedIn = await guest(clubA, signedIn);
			// Shape 4: no guest row and no membership, with an email: no card to carry it.
			const lone = await person("Lone", { email: "l@x.test" });

			const dataStatements = statements().filter((s) => /^UPDATE /.test(s));
			expect(dataStatements).toHaveLength(2);

			// The real files, the folder ending at 0119: applies 0119 alone.
			await migrate(drizzle(pool), { migrationsFolder: throughDir });

			const emailOf = async (id: string) =>
				(
					await one<{ email: string | null }>(
						`select email from people where id = $1`,
						[id],
					)
				).email;
			const noteOf = async (id: string) =>
				(
					await one<{ book_email: string | null }>(
						`select book_email from guests where id = $1`,
						[id],
					)
				).book_email;
			const snapshot = async () => ({
				people: (await pool.query(`select id, email from people order by id`))
					.rows,
				guests: (
					await pool.query(`select id, book_email from guests order by id`)
				).rows,
			});

			// Shape 1: moved, onto every guest row naming the Person.
			expect(await emailOf(guestOnly)).toBeNull();
			expect(await noteOf(g1a)).toBe("g@x.test");
			expect(await noteOf(g1b)).toBe("g@x.test");
			// Nothing to move.
			expect(await emailOf(noEmail)).toBeNull();
			expect(await noteOf(gNoEmail)).toBeNull();
			// Shapes 2-4: unchanged.
			expect(await emailOf(member)).toBe("m@x.test");
			expect(await noteOf(gMember)).toBeNull();
			expect(await emailOf(signedIn)).toBe("s@x.test");
			expect(await noteOf(gSignedIn)).toBeNull();
			expect(await emailOf(lone)).toBe("l@x.test");

			// Idempotent: running both data statements again changes nothing.
			const after = await snapshot();
			for (const s of dataStatements) await pool.query(s);
			expect(await snapshot()).toEqual(after);
		}, 120_000);
	},
);
