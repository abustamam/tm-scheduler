/**
 * DB-backed tests for the role guide (#933): the migration's backfill, the
 * admin edit path, and what the public reader serves.
 *
 * The backfill is exercised by running the MIGRATION'S OWN statements (read
 * out of `drizzle/`), scoped to this suite's club so a parallel suite's rows
 * are never touched — not a re-statement of them, which would agree with
 * whatever the author had in mind rather than with what production runs.
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, roleDefinitions } from "#/db/schema";
import { ROLE_TEMPLATE, roleSeed } from "#/lib/role-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { readSource } from "#/test/guard-source";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyRoleDefinitionUpdate,
	loadPublicClubRoles,
	listRoleDefinitions,
	updateRoleSchema,
} = await import("./role-definitions-logic");

/** The one migration that adds the guide columns. */
function guideMigrationPath(): string {
	const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql"));
	const hits = files.filter((f) =>
		readSource(`drizzle/${f}`).includes('ADD COLUMN "before_notes"'),
	);
	expect(hits, "exactly one migration adds before_notes").toHaveLength(1);
	return `drizzle/${hits[0]}`;
}

/** The migration's backfill UPDATEs, comment lines dropped. */
function backfillStatements(): string[] {
	return readSource(guideMigrationPath())
		.split("--> statement-breakpoint")
		.map((chunk) =>
			chunk
				.split("\n")
				.filter((line) => !line.startsWith("--"))
				.join("\n")
				.trim(),
		)
		.filter((stmt) => stmt.startsWith('UPDATE "role_definitions"'));
}

/** Run the backfill against ONE club only. */
async function runBackfill(clubId: string) {
	const statements = backfillStatements();
	expect(statements.length).toBeGreaterThan(0);
	for (const stmt of statements) {
		expect(stmt.endsWith(" IS NULL;")).toBe(true);
		const scoped = `${stmt.slice(0, -1)} AND "club_id" = '${clubId}';`;
		await testDb.execute(sql.raw(scoped));
	}
}

async function insertRole(
	clubId: string,
	values: Partial<typeof roleDefinitions.$inferInsert> & { name: string },
) {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({ clubId, category: "functionary", ...values })
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("insert failed");
	return row.id;
}

async function readRole(id: string) {
	const [row] = await testDb
		.select({
			beforeNotes: roleDefinitions.beforeNotes,
			duringNotes: roleDefinitions.duringNotes,
			description: roleDefinitions.description,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.id, id));
	return row;
}

const seeds: SeededClub[] = [];
async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeds.push(s);
	return s;
}

afterEach(async () => {
	for (const s of seeds.splice(0)) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

describe.skipIf(!hasTestDb)("role guide backfill (#933 migration)", () => {
	it("fills a standard role's NULL fields with the template defaults", async () => {
		const s = await club();
		const timer = roleSeed("Timer");
		const id = await insertRole(s.clubId, {
			name: "Timer",
			key: timer.key,
		});
		expect(await readRole(id)).toMatchObject({
			beforeNotes: null,
			duringNotes: null,
		});

		await runBackfill(s.clubId);

		expect(await readRole(id)).toMatchObject({
			beforeNotes: timer.beforeNotes,
			duringNotes: timer.duringNotes,
		});
	});

	it("never overwrites a field the club has edited, and fills its NULL sibling", async () => {
		const s = await club();
		const tmod = roleSeed("Toastmaster of the Day");
		const id = await insertRole(s.clubId, {
			name: "Toastmaster",
			key: tmod.key,
			category: "leadership",
			beforeNotes: "Our own prep notes.",
		});

		await runBackfill(s.clubId);
		expect(await readRole(id)).toMatchObject({
			beforeNotes: "Our own prep notes.",
			duringNotes: tmod.duringNotes,
		});

		// Edit the filled one too, then re-run: both stay as the club left them.
		await testDb
			.update(roleDefinitions)
			.set({ duringNotes: "Edited during." })
			.where(eq(roleDefinitions.id, id));
		await runBackfill(s.clubId);
		expect(await readRole(id)).toMatchObject({
			beforeNotes: "Our own prep notes.",
			duringNotes: "Edited during.",
		});
	});

	it("leaves a custom role (no standard key) blank", async () => {
		const s = await club();
		const custom = await insertRole(s.clubId, {
			name: `Zoom Host ${randomUUID().slice(0, 6)}`,
			key: `zoom_host_${randomUUID().slice(0, 6).replace(/-/g, "")}`,
		});
		// The seeded club's own "Timer" has key NULL — a pre-#368 row.
		await runBackfill(s.clubId);
		expect(await readRole(custom)).toMatchObject({
			beforeNotes: null,
			duringNotes: null,
		});
		expect(await readRole(s.roleDefinitionId)).toMatchObject({
			beforeNotes: null,
			duringNotes: null,
		});
	});

	it("covers every standard role and nothing else", () => {
		const keys = new Set(
			backfillStatements().map(
				(stmt) => /WHERE "key" = '([a-z_]+)'/.exec(stmt)?.[1],
			),
		);
		expect([...keys].sort()).toEqual(ROLE_TEMPLATE.map((r) => r.key).sort());
	});
});

describe.skipIf(!hasTestDb)(
	"editing the guide (applyRoleDefinitionUpdate)",
	() => {
		async function update(
			s: SeededClub,
			roleId: string,
			patch: { beforeNotes?: string | null; duringNotes?: string | null },
		) {
			await applyRoleDefinitionUpdate({
				clubId: s.clubId,
				roleId,
				name: "Timer",
				category: "functionary",
				defaultCount: 1,
				description: "Keeps time.",
				...patch,
			});
		}

		it("writes both halves, and a blank clears to NULL", async () => {
			const s = await club();
			await update(s, s.roleDefinitionId, {
				beforeNotes: "  Bring the lights.  ",
				duringNotes: "Time everyone.",
			});
			expect(await readRole(s.roleDefinitionId)).toMatchObject({
				beforeNotes: "Bring the lights.",
				duringNotes: "Time everyone.",
			});

			await update(s, s.roleDefinitionId, {
				beforeNotes: "   ",
				duringNotes: "",
			});
			expect(await readRole(s.roleDefinitionId)).toMatchObject({
				beforeNotes: null,
				duringNotes: null,
			});
		});

		it("leaves an OMITTED half untouched (a tab opened before the deploy)", async () => {
			const s = await club();
			await update(s, s.roleDefinitionId, {
				beforeNotes: "Keep me.",
				duringNotes: "Keep me too.",
			});
			// The pre-#933 payload: no guide fields at all.
			await update(s, s.roleDefinitionId, {});
			expect(await readRole(s.roleDefinitionId)).toMatchObject({
				beforeNotes: "Keep me.",
				duringNotes: "Keep me too.",
				description: "Keeps time.",
			});
		});

		it("edits a custom role's guide the same way", async () => {
			const s = await club();
			const custom = await insertRole(s.clubId, {
				name: "Sergeant-at-Arms",
				key: `sergeant_${randomUUID().slice(0, 6).replace(/-/g, "")}`,
			});
			await applyRoleDefinitionUpdate({
				clubId: s.clubId,
				roleId: custom,
				name: "Sergeant-at-Arms",
				category: "leadership",
				defaultCount: 1,
				beforeNotes: "Set up the room.",
				duringNotes: "Call the meeting to order.",
			});
			expect(await readRole(custom)).toMatchObject({
				beforeNotes: "Set up the room.",
				duringNotes: "Call the meeting to order.",
			});
		});

		it("cannot reach another club's role", async () => {
			const mine = await club();
			const theirs = await club();
			await expect(
				update(mine, theirs.roleDefinitionId, { beforeNotes: "Hijack." }),
			).rejects.toThrow("Role not found.");
			expect((await readRole(theirs.roleDefinitionId))?.beforeNotes).toBeNull();
		});
	},
);

describe.skipIf(!hasTestDb)(
	"what the roles guide reads (loadPublicClubRoles)",
	() => {
		it("serves key and both halves; empty for an archived club; only this club's", async () => {
			const s = await club();
			const other = await club();
			const tmod = roleSeed("Toastmaster of the Day");
			await insertRole(s.clubId, {
				name: tmod.name,
				key: tmod.key,
				category: "leadership",
				beforeNotes: tmod.beforeNotes,
				duringNotes: tmod.duringNotes,
			});
			await insertRole(other.clubId, {
				name: "Other club's secret role",
				key: "other_secret",
				beforeNotes: "Not yours.",
			});

			// Signed out, or anyone: the reader takes no session at all.
			const rows = await loadPublicClubRoles(s.clubId);
			const row = rows.find((r) => r.key === tmod.key);
			expect(row).toMatchObject({
				key: tmod.key,
				beforeNotes: tmod.beforeNotes,
				duringNotes: tmod.duringNotes,
			});
			expect(rows.some((r) => r.key === "other_secret")).toBe(false);
			// The EXACT public shape: the pre-#933 fields plus `key` (the anchor)
			// and the two guide halves, and nothing else — no counts, no people.
			expect(Object.keys(row ?? {}).sort()).toEqual(
				[
					"id",
					"name",
					"category",
					"defaultCount",
					"sortOrder",
					"isSpeakerRole",
					"description",
					"enabled",
					"standing",
					// new in #933:
					"key",
					"beforeNotes",
					"duringNotes",
				].sort(),
			);

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, s.clubId));
			expect(await loadPublicClubRoles(s.clubId)).toEqual([]);
		});

		it("the admin listing carries the guide fields too", async () => {
			const s = await club();
			await testDb
				.update(roleDefinitions)
				.set({ beforeNotes: "B", duringNotes: "D" })
				.where(
					and(
						eq(roleDefinitions.id, s.roleDefinitionId),
						eq(roleDefinitions.clubId, s.clubId),
					),
				);
			const rows = await listRoleDefinitions(s.clubId, {
				withSlotCounts: true,
				withAgendaCounts: true,
			});
			expect(rows.find((r) => r.id === s.roleDefinitionId)).toMatchObject({
				beforeNotes: "B",
				duringNotes: "D",
			});
		});
	},
);

describe("the guide cap in the update schema", () => {
	const base = {
		clubId: randomUUID(),
		roleId: randomUUID(),
		name: "Timer",
		category: "functionary",
		defaultCount: 1,
	};

	it("accepts exactly 4000 characters and rejects 4001, for both halves", () => {
		for (const field of ["beforeNotes", "duringNotes"] as const) {
			expect(
				updateRoleSchema.safeParse({ ...base, [field]: "x".repeat(4000) })
					.success,
			).toBe(true);
			expect(
				updateRoleSchema.safeParse({ ...base, [field]: "x".repeat(4001) })
					.success,
			).toBe(false);
		}
	});
});
