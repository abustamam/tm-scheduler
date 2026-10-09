/**
 * Migration 0117 (#1125, ADR-0031): a guest's email and phone move onto their
 * Person, and `guests.person_id` becomes NOT NULL.
 *
 * The data statements are hand-written SQL that `db:generate` never reproduces (it
 * emits only the NOT NULL), and worktree and CI test databases are not built by
 * running them (a worktree is `db:push`-synced from `schema.ts`). So this runs the
 * REAL drizzle runner against a scratch database of its own, the way
 * `guest-person-migration.integration.test.ts` does for 0116: every migration up
 * to and including 0116 (from a copy of `drizzle/` whose journal stops there),
 * then rows inserted the way they existed then (`person_id` still nullable), then
 * the real folder, which applies 0117 alone.
 *
 * A database of its own because the migration takes `ACCESS EXCLUSIVE` on
 * `guests`, which would stall every other suite running in parallel against the
 * shared one, and because the real `guests` table is already NOT NULL on
 * `person_id` (that is the schema this very change ships), so a guest with no
 * Person cannot be seeded there.
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
const PREVIOUS_TAG = "0116_parched_sheva_callister";
const FILE = readdirSync(MIGRATIONS).find((f) => /^0117_.*\.sql$/.test(f));
const THIS_TAG = (FILE ?? "").replace(/\.sql$/, "");
const SCRATCH_DB = `tm_0117_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

interface JournalEntry {
	idx: number;
	tag: string;
}

function urlFor(database: string): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid");
	url.pathname = `/${database}`;
	return url.toString();
}

/**
 * A copy of `drizzle/` whose journal stops after the entry tagged `tag`. Used
 * twice: through 0116 (the state the rows are inserted in) and through 0117 (so
 * #1126, and whatever lands after it, never runs here: its DROP COLUMN would
 * take away the very columns this test seeds and reads).
 */
function migrationsThrough(tag: string): string {
	const journal = JSON.parse(
		readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
	) as { entries: JournalEntry[] };
	const at = journal.entries.findIndex((e) => e.tag === tag);
	expect(at, `${tag} is not in the journal`).toBeGreaterThan(0);
	const through = journal.entries.slice(0, at + 1);
	const dir = mkdtempSync(join(tmpdir(), "tm-0117-"));
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
	if (!FILE) throw new Error("drizzle/0117_*.sql is missing");
	return readFileSync(join(MIGRATIONS, FILE), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0);
}

describe("the migration file's shape", () => {
	it("is the lock, the re-backfill, the backup, the two copies and NOT NULL, in that order, and never drops a column", () => {
		const all = statements();
		const kind = (s: string) => s.split(/\s+/).slice(0, 2).join(" ");
		expect(all.map(kind)).toEqual([
			"LOCK TABLE",
			'UPDATE "guests"',
			"CREATE TEMP",
			"INSERT INTO",
			'UPDATE "guests"',
			"DROP TABLE",
			"CREATE TABLE",
			"INSERT INTO",
			'UPDATE "people"',
			'UPDATE "people"',
			"ALTER TABLE",
		]);
		expect(all[0]).toMatch(/"guests" IN ACCESS EXCLUSIVE MODE/);
		expect(all.at(-1)).toBe(
			'ALTER TABLE "guests" ALTER COLUMN "person_id" SET NOT NULL;',
		);
		// Never a DROP of the guest columns: #1126 does that, one deploy later.
		expect(all.join("\n")).not.toMatch(/DROP COLUMN/i);
	});
});

let pool: pg.Pool;
let partialDir: string;
let throughDir: string;

describe.skipIf(!hasTestDb)(
	"migration 0117: a guest's contact on their Person",
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
				  where d.datname like 'tm_0117_%'
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

		it("re-backfills, copies onto guest-only Persons only, snapshots, and sets NOT NULL", async () => {
			const clubId = randomUUID();
			const clubB = randomUUID();
			for (const id of [clubId, clubB]) {
				await pool.query(
					`insert into clubs (id, name, slug) values ($1, '0117 Club', $2)`,
					[id, `club-0117-${id}`],
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
			const member = async (club: string, personId: string, name: string) =>
				(
					await one<{ id: string }>(
						`insert into members (club_id, person_id, name) values ($1, $2, $3) returning id`,
						[club, personId, name],
					)
				).id;
			const guest = async (
				club: string,
				name: string,
				o: {
					email?: string;
					phone?: string;
					personId?: string;
					convertedTo?: string;
					createdAt?: string;
					preferredName?: string;
				} = {},
			) =>
				(
					await one<{ id: string }>(
						`insert into guests
					   (club_id, name, preferred_name, email, phone, person_id, converted_membership_id, created_at)
					 values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamp, now())) returning id`,
						[
							club,
							name,
							o.preferredName ?? null,
							o.email ?? null,
							o.phone ?? null,
							o.personId ?? null,
							o.convertedTo ?? null,
							o.createdAt ?? null,
						],
					)
				).id;

			// --- 1. Guests the old container wrote with NO Person during #1124's swap.
			const memberPerson = await person("Ravi", {
				email: "ravi-member@x.test",
			});
			const membership = await member(clubId, memberPerson, "Ravi");
			const converted = await guest(clubId, "Ravi", {
				convertedTo: membership,
			});
			const plain = await guest(clubId, "Plain Guest", {
				preferredName: "Pl",
				email: "plain@x.test",
				phone: "+15550000001",
			});
			const phoneOnly = await guest(clubId, "Phone Only", {
				phone: "+15550000002",
			});
			const neither = await guest(clubId, "Neither");

			// --- 2. Guests that already have a Person, in the shapes the copy must respect.
			// Has its own address: the guest's differing one does not replace it.
			const hasEmail = await person("Has Email", { email: "keeps@x.test" });
			const g1 = await guest(clubId, "Has Email", {
				email: "guest-typed@x.test",
				phone: "+15550000011",
				personId: hasEmail,
			});
			// A member's Person with blank contact: a guest row never fills a member.
			const memberBlank = await person("Member Blank");
			await member(clubB, memberBlank, "Member Blank");
			const g2 = await guest(clubId, "Member Blank", {
				email: "typed-for-member@x.test",
				phone: "+15550000012",
				personId: memberBlank,
			});
			// Signed in: nobody else's to write.
			const userId = `user-${randomUUID()}`;
			await pool.query(
				`insert into "user" (id, name, email) values ($1, 'Bound', $2)`,
				[userId, `${userId}@x.test`],
			);
			const bound = await person("Bound", { userId });
			const g3 = await guest(clubId, "Bound", {
				email: "typed-for-bound@x.test",
				phone: "+15550000013",
				personId: bound,
			});
			// Has its own phone: the guest's differing one does not replace it, and its
			// blank email is filled (each field is judged on its own).
			const hasPhone = await person("Has Phone", { phone: "+15550000099" });
			const g4 = await guest(clubId, "Has Phone", {
				email: "fills-email@x.test",
				phone: "+15550000014",
				personId: hasPhone,
			});
			// A past as a member, one arm at a time (`noMemberHistory`): the Person holds
			// no membership and nobody has signed in, so it reads guest-only, but its
			// contact is the member's. None of these is written.
			const history = async (label: string, set: string) => {
				const id = await person(`History ${label}`);
				if (set)
					await pool.query(`update people set ${set} where id = $1`, [id]);
				return {
					id,
					guestId: await guest(clubId, `History ${label}`, {
						email: `history-${label}@x.test`,
						phone: `+1555000${label.length.toString().padStart(4, "0")}`,
						personId: id,
					}),
				};
			};
			const hCustomer = await history("customer", "customer_id = 'PN-0117'");
			const hBasecamp = await history(
				"basecamp",
				"basecamp_user_id = 'bc-0117'",
			);
			const hJoin = await history("join", "original_join_date = '2015-03-01'");
			const hInvite = await history("invite", "invited_at = now()");
			const hRemoved = await history("removed", "");
			await pool.query(
				`insert into activity_log (club_id, action, target_type, target_id, detail)
				 values ($1, 'member_remove', 'member', $2, $3::jsonb)`,
				[clubId, randomUUID(), JSON.stringify({ personId: hRemoved.id })],
			);
			// A removal that names a DIFFERENT Person does not disqualify.
			const control = await history("control", "");
			await pool.query(
				`insert into activity_log (club_id, action, target_type, target_id, detail)
				 values ($1, 'member_remove', 'member', $2, $3::jsonb)`,
				[clubId, randomUUID(), JSON.stringify({ personId: randomUUID() })],
			);
			// A guest-only Person two guest rows name (a superadmin merge): the OLDEST
			// row that has each field wins, so the result is deterministic.
			const shared = await person("Shared Human");
			const older = await guest(clubId, "Shared Human", {
				email: "older@x.test",
				personId: shared,
				createdAt: "2024-01-01T00:00:00",
			});
			await guest(clubB, "Shared Human B", {
				email: "newer@x.test",
				phone: "+15550000021",
				personId: shared,
				createdAt: "2025-01-01T00:00:00",
			});

			const memberBefore = await one<{ email: string; phone: string | null }>(
				`select email, phone from people where id = $1`,
				[memberPerson],
			);
			const peopleBefore = await one<{ n: number }>(
				`select count(*)::int as n from people`,
			);

			// The real files, the folder ending at 0117: applies 0117 and nothing else.
			await migrate(drizzle(pool), { migrationsFolder: throughDir });

			const personOf = (guestId: string) =>
				one<{
					id: string;
					name: string;
					preferred_name: string | null;
					email: string | null;
					phone: string | null;
				}>(
					`select p.* from guests g join people p on p.id = g.person_id where g.id = $1`,
					[guestId],
				);

			// AC1: nobody has a null person_id, and the column is NOT NULL.
			const nulls = await pool.query(
				`select id from guests where person_id is null`,
			);
			expect(nulls.rows).toEqual([]);
			const col = await one<{ is_nullable: string }>(
				`select is_nullable from information_schema.columns
			  where table_name = 'guests' and column_name = 'person_id'`,
			);
			expect(col.is_nullable).toBe("NO");
			await expect(
				pool.query(
					`insert into guests (club_id, name, person_id) values ($1, 'x', null)`,
					[clubId],
				),
			).rejects.toMatchObject({ code: "23502" });

			// The re-backfill by #1124's rule: a converted guest IS its membership's
			// Person, the rest get their own fresh name-only Person (then the copy).
			expect((await personOf(converted)).id).toBe(memberPerson);
			const plainP = await personOf(plain);
			expect(plainP.name).toBe("Plain Guest");
			expect(plainP.preferred_name).toBe("Pl");
			const own = await Promise.all(
				[plain, phoneOnly, neither].map(async (g) => (await personOf(g)).id),
			);
			expect(new Set(own).size).toBe(3);
			expect(own).not.toContain(memberPerson);
			const peopleAfter = await one<{ n: number }>(
				`select count(*)::int as n from people`,
			);
			expect(peopleAfter.n).toBe(peopleBefore.n + 3);

			// AC3: a guest-only Person whose field was null now holds its guest's value.
			expect(plainP.email).toBe("plain@x.test");
			expect(plainP.phone).toBe("+15550000001");
			expect(await personOf(phoneOnly)).toMatchObject({
				email: null,
				phone: "+15550000002",
			});
			expect(await personOf(neither)).toMatchObject({
				email: null,
				phone: null,
			});
			// ...only into a NULL field: an address it already had is kept.
			expect(await personOf(g1)).toMatchObject({
				email: "keeps@x.test",
				phone: "+15550000011",
			});
			// The oldest guest row with a field wins, field by field.
			expect(await personOf(older)).toMatchObject({
				email: "older@x.test",
				phone: "+15550000021",
			});

			// AC4: no member Person's, and no signed-in Person's, contact changed.
			expect(
				await one(`select email, phone from people where id = $1`, [
					memberPerson,
				]),
			).toEqual(memberBefore);
			expect(await personOf(g2)).toMatchObject({ email: null, phone: null });
			expect(await personOf(g3)).toMatchObject({ email: null, phone: null });
			// Each field on its own: a Person with a phone still gets its blank email.
			expect(await personOf(g4)).toMatchObject({
				email: "fills-email@x.test",
				phone: "+15550000099",
			});
			// The member-history arms, one by one, for BOTH fields.
			for (const h of [hCustomer, hBasecamp, hJoin, hInvite, hRemoved]) {
				expect(await personOf(h.guestId)).toMatchObject({
					email: null,
					phone: null,
				});
			}
			// ...and the control, with only an unrelated removal on record, is written.
			expect((await personOf(control.guestId)).email).toBe(
				"history-control@x.test",
			);
			expect((await personOf(control.guestId)).phone).not.toBeNull();

			// AC3's other half: the backup has one row per guest that had either field,
			// as the guest row held it, written or not. Compared over THIS club's guests
			// (the scratch database is this file's own, so that is every row).
			const backup = await pool.query<{
				guest_id: string;
				club_id: string;
				person_id: string;
				email: string | null;
				phone: string | null;
				snapshot_at: Date;
			}>(
				`select guest_id, club_id, person_id, email, phone, snapshot_at from guests_contact_backup`,
			);
			const had = await pool.query<{ id: string }>(
				`select id from guests where email is not null or phone is not null`,
			);
			expect(backup.rows.map((b) => b.guest_id).sort()).toEqual(
				had.rows.map((g) => g.id).sort(),
			);
			expect(backup.rows.map((b) => b.guest_id)).not.toContain(neither);
			expect(backup.rows.map((b) => b.guest_id)).not.toContain(converted);
			const plainBackup = backup.rows.find((b) => b.guest_id === plain);
			expect(plainBackup).toMatchObject({
				email: "plain@x.test",
				phone: "+15550000001",
				club_id: clubId,
				person_id: plainP.id,
			});
			expect(backup.rows.find((b) => b.guest_id === g2)).toMatchObject({
				email: "typed-for-member@x.test",
				phone: "+15550000012",
			});
			expect(backup.rows.every((b) => b.snapshot_at instanceof Date)).toBe(
				true,
			);

			// The guest columns are KEPT, untouched: #1126 drops them, one deploy later.
			expect(
				await one(`select email, phone from guests where id = $1`, [plain]),
			).toEqual({ email: "plain@x.test", phone: "+15550000001" });
			// And the foreign key is still RESTRICT.
			const fk = await one<{ confdeltype: string }>(
				`select confdeltype from pg_constraint
			  where conname = 'guests_person_id_people_id_fk'
			    and conrelid = 'guests'::regclass`,
			);
			expect(fk.confdeltype).toBe("r");
		}, 60_000);
	},
);
