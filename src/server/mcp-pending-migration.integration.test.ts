/**
 * Migration 0085 carries in-flight pending plans (#812 AC7).
 *
 * `drizzle-kit generate` emitted `CREATE TABLE mcp_pending_plans` +
 * `DROP TABLE guest_book_pending_plans`, which is correct about the SHAPE and
 * loses every row. That is not an acceptable default here: a confirm link lives
 * for up to 48 hours, migrations apply at container startup with no drain
 * (`CMD` runs `migrate.mjs && server`), and a deploy landing mid-window would
 * break every link a member had already been handed — silently, as a
 * not-found on a URL they were told to open.
 *
 * So the migration was hand-edited to `INSERT … SELECT` before the drop, and
 * this is the gate on that edit. It reads the REAL `drizzle/0085_*.sql` off
 * disk: a test that restated the transform could not have caught a mistake in
 * it, which is the whole failure mode.
 *
 * ## Why a scratch database and not `tm_test`
 *
 * `tm_test` is push-synced — the table it holds is the one `schema.ts`
 * declares, which is the table AFTER this migration. There is nowhere in it to
 * put a pre-migration row. So each case builds the old table in a database of
 * its own, with minimal `clubs` / `user` stand-ins for the two foreign keys the
 * migration adds, and runs 0085's statements against it. Per-run suffixed and
 * dropped afterwards, like `scripts/migrate.test.ts` — vitest runs test FILES
 * in parallel against one Postgres.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp-pending-migration.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGuestBookPayload } from "#/server/guest-book-pending-schemas";
import { hasTestDb } from "#/test/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE = resolve(HERE, "..", "..", "drizzle");
const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
/** Per-run so two suites (or two agents) never collide on a database name. */
const SUFFIX = randomBytes(4).toString("hex");

/**
 * The migration under test, found by its number rather than its full name.
 *
 * `drizzle-kit` names files `NNNN_<two random words>.sql`, so pinning the whole
 * name here would make this suite fail the day the file is regenerated — for a
 * reason that is not a bug. Resolved rather than hard-coded, and the resolution
 * itself is asserted below so a rename cannot leave this silently reading
 * nothing.
 */
function migrationSql(): string {
	const file = readdirSync(DRIZZLE).find(
		(f) => f.startsWith("0085_") && f.endsWith(".sql"),
	);
	if (!file) {
		throw new Error(
			"no drizzle/0085_*.sql — the pending-plan migration was renumbered. Re-point this suite rather than deleting it.",
		);
	}
	return readFileSync(join(DRIZZLE, file), "utf8");
}

/** Statements, split the way the startup runner splits them. */
function statements(sql: string): string[] {
	return sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * One statement with its `--` comments blanked, for the ORDER assertion below.
 *
 * Comment-blind, and it had to be: 0085's `INSERT` chunk carries a prose block
 * explaining how to reverse the move, which names `DROP TABLE` — so a raw
 * `findIndex` for that phrase found the INSERT's own comment and reported the
 * drop as running first. The statements are RUN raw; only the search is
 * stripped. (No `--` appears inside a string literal in this file, which is
 * what would make a naive strip unsafe.)
 */
function codeOf(statement: string): string {
	return statement.replace(/--[^\n]*/g, "");
}

function urlForDatabase(name: string): string {
	const parsed = new URL(TEST_URL);
	parsed.pathname = `/${name}`;
	return parsed.toString();
}

/**
 * The table as migrations 0081 + 0082 left it, plus stand-ins for the two
 * tables the new foreign keys point at.
 *
 * Copied from `drizzle/0081_little_major_mapleleaf.sql` deliberately: this is a
 * FIXTURE of a shape that no longer exists in `schema.ts`, and reading it from
 * the live schema would defeat the point — the row under test is one the
 * current release can no longer write.
 */
const OLD_WORLD = `
	CREATE TABLE "clubs" ("id" uuid PRIMARY KEY);
	CREATE TABLE "user" ("id" text PRIMARY KEY);
	CREATE TABLE "guest_book_pending_plans" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"club_id" uuid NOT NULL,
		"meeting_date" date NOT NULL,
		"created_by_user_id" text NOT NULL,
		"entries" jsonb,
		"created_at" timestamp DEFAULT now() NOT NULL,
		"expires_at" timestamp NOT NULL,
		"applied_at" timestamp
	);
	CREATE INDEX "guest_book_pending_plans_sweep_idx" ON "guest_book_pending_plans" ("expires_at");
	CREATE INDEX "guest_book_pending_plans_club_idx" ON "guest_book_pending_plans" ("club_id");
`;

describe.skipIf(!hasTestDb)(
	"migration 0085 carries pending plans (#812)",
	() => {
		let admin: Client;
		const scratch: string[] = [];

		async function freshDatabase(label: string): Promise<Client> {
			const name = `tm_pending812_${label}_${SUFFIX}`;
			// An identifier, so it cannot be a bind parameter. Built from a literal
			// label and a hex suffix, never from anything external.
			await admin.query(`create database "${name}"`);
			scratch.push(name);
			const client = new Client({ connectionString: urlForDatabase(name) });
			await client.connect();
			await client.query(OLD_WORLD);
			return client;
		}

		/** Run the real migration's statements in order, as the runner would. */
		async function migrate(client: Client): Promise<void> {
			for (const statement of statements(migrationSql())) {
				await client.query(statement);
			}
		}

		beforeAll(async () => {
			admin = new Client({ connectionString: urlForDatabase("postgres") });
			await admin.connect();
			// Reap orphans before creating this run's: the suffix is fresh every run,
			// so a run killed mid-flight leaves databases behind with nothing that
			// would ever name them again. Skipping any with a live backend keeps this
			// from taking a concurrent run's databases out from under it.
			const stale = await admin.query<{ datname: string }>(
				`select d.datname from pg_database d
			 where d.datname like 'tm_pending812_%'
			   and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
			);
			for (const row of stale.rows) {
				try {
					await admin.query(
						`drop database if exists "${row.datname}" with (force)`,
					);
				} catch {
					// Raced with another run that just connected. Leave it.
				}
			}
		});

		afterAll(async () => {
			for (const name of scratch) {
				await admin.query(`drop database if exists "${name}" with (force)`);
			}
			await admin.end();
		});

		it("reads the real migration, and it really moves the rows", () => {
			// Vacuity floor. A resolution that found the wrong file, or a split that
			// returned nothing, would make every case below pass by doing nothing —
			// which is the failure shape this whole suite exists to prevent one level
			// up.
			const sql = migrationSql();
			const parts = statements(sql);
			expect(parts.length).toBeGreaterThanOrEqual(6);
			expect(sql).toContain('CREATE TABLE "mcp_pending_plans"');
			expect(sql).toContain('INSERT INTO "mcp_pending_plans"');
			expect(sql).toContain('FROM "guest_book_pending_plans"');
			expect(sql).toContain('DROP TABLE "guest_book_pending_plans"');
			// ORDER is the whole edit: the generated migration dropped the source
			// table BEFORE anything could read it. Asserted as an index comparison
			// rather than by eye, because the two statements being present says
			// nothing about which ran first.
			const code = parts.map(codeOf);
			const insertAt = code.findIndex((p) => p.includes("INSERT INTO"));
			const dropAt = code.findIndex((p) => p.includes("DROP TABLE"));
			expect(insertAt).toBeGreaterThanOrEqual(0);
			expect(dropAt).toBeGreaterThan(insertAt);
		});

		it("carries an in-flight row, and the confirm page can still read it", async () => {
			const client = await freshDatabase("inflight");
			try {
				const clubId = randomUUID();
				const userId = `user_${SUFFIX}`;
				const pendingId = randomUUID();
				await client.query(`insert into "clubs" ("id") values ($1)`, [clubId]);
				await client.query(`insert into "user" ("id") values ($1)`, [userId]);

				const entries = [
					{ id: "e1", name: "Vera Real", email: "vera@example.com" },
					{ id: "e2", name: "Dropped Line", dropped: true },
					{ id: "e3", name: "Answered", resolve: { kind: "new" } },
				];
				const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
				await client.query(
					`insert into "guest_book_pending_plans"
				   ("id","club_id","meeting_date","created_by_user_id","entries","expires_at")
				 values ($1,$2,$3,$4,$5,$6)`,
					[
						pendingId,
						clubId,
						"2026-03-14",
						userId,
						JSON.stringify(entries),
						expiresAt,
					],
				);

				await migrate(client);

				const after = await client.query<{
					id: string;
					tool: string;
					payload: unknown;
					club_id: string;
					created_by_user_id: string;
					expires_at: Date;
					applied_at: Date | null;
				}>(`select * from "mcp_pending_plans"`);
				expect(after.rowCount).toBe(1);
				const row = after.rows[0];
				// The ID is what the link in someone's chat client points at. If this
				// changed, the row survived and the link did not, which is the same
				// outage with extra steps.
				expect(row?.id).toBe(pendingId);
				expect(row?.tool).toBe("record_guest_book");
				expect(row?.club_id).toBe(clubId);
				expect(row?.created_by_user_id).toBe(userId);
				expect(row?.applied_at).toBeNull();
				expect(row?.expires_at?.getTime()).toBe(expiresAt.getTime());

				// THE claim, stated through the boundary every render actually passes
				// through rather than against the raw jsonb: what comes back has to be
				// something `loadPendingPlan` can plan, not merely something that is
				// shaped like it.
				const parsed = parseGuestBookPayload(row?.payload);
				expect(parsed?.meetingDate).toBe("2026-03-14");
				expect(parsed?.entriesUnreadable).toBe(false);
				expect(parsed?.entries).toEqual(entries);
			} finally {
				await client.end();
			}
		});

		it("carries an applied tombstone as a tombstone, not as corruption", async () => {
			// The case a naive transform gets wrong, and it is the difference between
			// two page states: `entries: null` means "already recorded" and an
			// unreadable payload means "transcribe the page again". A row whose
			// `entries` column was NULL must arrive as JSON `null` inside the
			// payload, with its meeting date intact — the applied page still says
			// which meeting the visitors ended up on.
			const client = await freshDatabase("tombstone");
			try {
				const clubId = randomUUID();
				const userId = `user_t_${SUFFIX}`;
				const appliedAt = new Date(Date.now() - 60 * 60 * 1000);
				await client.query(`insert into "clubs" ("id") values ($1)`, [clubId]);
				await client.query(`insert into "user" ("id") values ($1)`, [userId]);
				await client.query(
					`insert into "guest_book_pending_plans"
				   ("club_id","meeting_date","created_by_user_id","entries","expires_at","applied_at")
				 values ($1,$2,$3,null,$4,$5)`,
					[
						clubId,
						"2026-01-09",
						userId,
						new Date(Date.now() + 60 * 60 * 1000),
						appliedAt,
					],
				);

				await migrate(client);

				const after = await client.query<{
					payload: unknown;
					applied_at: Date | null;
				}>(`select "payload", "applied_at" from "mcp_pending_plans"`);
				expect(after.rowCount).toBe(1);
				expect(after.rows[0]?.applied_at?.getTime()).toBe(appliedAt.getTime());
				const parsed = parseGuestBookPayload(after.rows[0]?.payload);
				expect(parsed?.meetingDate).toBe("2026-01-09");
				expect(parsed?.entries).toBeNull();
				// NOT unreadable. That distinction is the whole reason the payload
				// parse has two steps.
				expect(parsed?.entriesUnreadable).toBe(false);
			} finally {
				await client.end();
			}
		});

		it("leaves nothing behind that still holds visitor contact details", async () => {
			// Reverting the application code removes everything that deletes these
			// rows, so a leftover populated copy of the old table would be an
			// unbounded retention of visitors' names, emails and phone numbers with
			// nothing in the system that would ever sweep it.
			const client = await freshDatabase("noleftover");
			try {
				const clubId = randomUUID();
				const userId = `user_n_${SUFFIX}`;
				await client.query(`insert into "clubs" ("id") values ($1)`, [clubId]);
				await client.query(`insert into "user" ("id") values ($1)`, [userId]);
				await client.query(
					`insert into "guest_book_pending_plans"
				   ("club_id","meeting_date","created_by_user_id","entries","expires_at")
				 values ($1,$2,$3,$4,$5)`,
					[
						clubId,
						"2026-02-02",
						userId,
						JSON.stringify([{ id: "e1", name: "Leftover", email: "l@x.com" }]),
						new Date(Date.now() + 60 * 60 * 1000),
					],
				);

				await migrate(client);

				const left = await client.query<{ reg: string | null }>(
					`select to_regclass('guest_book_pending_plans')::text as reg`,
				);
				expect(left.rows[0]?.reg).toBeNull();
			} finally {
				await client.end();
			}
		});
	},
);
