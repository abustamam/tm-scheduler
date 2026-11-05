/**
 * Migration 0129 backfills `meetings.slot_date` (#1521).
 *
 * Runs the REAL `drizzle/0129_*.sql` off disk against a pre-migration row in a
 * scratch database (`tm_test` is push-synced, so it has no pre-migration
 * shape). Same pattern as `mcp-pending-migration.integration.test.ts`. Per-run
 * suffixed and dropped afterwards.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasTestDb } from "#/test/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE = resolve(HERE, "..", "..", "drizzle");
const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
const SUFFIX = randomBytes(4).toString("hex");

function migrationStatements(): string[] {
	const file = readdirSync(DRIZZLE).find(
		(f) => f.startsWith("0129_") && f.endsWith(".sql"),
	);
	if (!file) {
		throw new Error(
			"no drizzle/0129_*.sql — the slot_date migration was renumbered. Re-point this suite rather than deleting it.",
		);
	}
	return readFileSync(join(DRIZZLE, file), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function urlForDatabase(name: string): string {
	const parsed = new URL(TEST_URL);
	parsed.pathname = `/${name}`;
	return parsed.toString();
}

const OLD_WORLD = `
	CREATE TABLE "clubs" ("id" uuid PRIMARY KEY, "timezone" text NOT NULL);
	CREATE TABLE "meetings" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"club_id" uuid NOT NULL,
		"scheduled_at" timestamp with time zone NOT NULL
	);
`;

const CHICAGO = "00000000-0000-0000-0000-0000000000c1";
const TOKYO = "00000000-0000-0000-0000-0000000000c2";

describe.skipIf(!hasTestDb)(
	"migration 0129 backfills slot_date (#1521)",
	() => {
		let admin: Client;
		let client: Client;
		let dbName = "";

		beforeAll(async () => {
			admin = new Client({ connectionString: urlForDatabase("postgres") });
			await admin.connect();
			dbName = `tm_slotdate1521_${SUFFIX}`;
			await admin.query(`create database "${dbName}"`);
			client = new Client({ connectionString: urlForDatabase(dbName) });
			await client.connect();
			await client.query(OLD_WORLD);
			await client.query(
				`insert into clubs (id, timezone) values ($1, 'America/Chicago'), ($2, 'Asia/Tokyo')`,
				[CHICAGO, TOKYO],
			);
			// 2026-07-03T03:30Z is Jul 2 22:30 in Chicago (UTC-5) but Jul 3 in UTC;
			// 2026-07-02T16:00Z is Jul 3 01:00 in Tokyo (UTC+9) but Jul 2 in UTC.
			await client.query(
				`insert into meetings (id, club_id, scheduled_at) values
			 ('00000000-0000-0000-0000-000000000001', $1, '2026-07-03T03:30:00Z'),
			 ('00000000-0000-0000-0000-000000000002', $2, '2026-07-02T16:00:00Z'),
			 ('00000000-0000-0000-0000-000000000003', $1, '2026-07-10T23:30:00Z')`,
				[CHICAGO, TOKYO],
			);
		});

		afterAll(async () => {
			await client?.end();
			await admin?.query(`drop database if exists "${dbName}" with (force)`);
			await admin?.end();
		});

		const dates = async () =>
			(
				await client.query<{ id: string; d: string | null }>(
					`select right(id::text, 1) as id, slot_date::text as d from meetings order by id`,
				)
			).rows.map((r) => r.d);

		it("reads the real migration", () => {
			const parts = migrationStatements();
			expect(parts.length).toBeGreaterThanOrEqual(2);
			expect(parts.join("\n")).toContain('ADD COLUMN "slot_date"');
			expect(parts.join("\n")).toContain('UPDATE "meetings"');
		});

		it("backfills the club-local date, including near midnight, and a re-run keeps a moved meeting's date", async () => {
			for (const statement of migrationStatements()) {
				await client.query(statement);
			}
			expect(await dates()).toEqual(["2026-07-02", "2026-07-03", "2026-07-10"]);

			// A meeting moved after the backfill keeps the date it was created on; a
			// manual re-run of the UPDATE must not overwrite it.
			await client.query(
				`update meetings set scheduled_at = '2026-07-20T23:30:00Z'
			 where id = '00000000-0000-0000-0000-000000000003'`,
			);
			const update = migrationStatements().find((s) => s.includes("UPDATE"));
			await client.query(update as string);
			expect(await dates()).toEqual(["2026-07-02", "2026-07-03", "2026-07-10"]);
		});
	},
);
