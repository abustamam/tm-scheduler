/**
 * Tests for the speaker_details → speeches data migration (ADR-0009 / #79).
 *
 * Two parts:
 *  1. A guard (always runs) that asserts the drizzle migration file embeds the
 *     canonical `SPEECH_BACKFILL_SQL`, so the tested SQL and the shipped SQL can
 *     never silently drift.
 *  2. DB-backed behavior tests (skipped without TEST_DATABASE_URL): reconstruct
 *     the pre-migration `speaker_details` table, seed representative rows, run the
 *     exact backfill SQL, and assert content rows → speeches, empty TBA → null,
 *     and unassigned content rows are skipped (no orphan speeches).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roleDefinitions, roleSlots, speeches } from "#/db/schema";
import { SPEECH_BACKFILL_SQL } from "#/db/speech-backfill";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

describe("speech backfill SQL guard", () => {
	it("is embedded verbatim in a drizzle migration file", () => {
		const dir = path.join(process.cwd(), "drizzle");
		const embedded = readdirSync(dir)
			.filter((f) => f.endsWith(".sql"))
			.map((f) => readFileSync(path.join(dir, f), "utf8"))
			.some((content) => content.includes(SPEECH_BACKFILL_SQL));
		expect(embedded).toBe(true);
	});
});

describe.skipIf(!hasTestDb)("speaker_details → speeches migration", () => {
	let seed: SeededClub;
	let speakerRoleId: string;

	async function newSpeakerSlot(
		assignedMemberId: string | null,
	): Promise<string> {
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				status: assignedMemberId ? "claimed" : "open",
				assignedMemberId,
			})
			.returning({ id: roleSlots.id });
		return slot!.id;
	}

	async function insertSpeakerDetails(
		slotId: string,
		d: {
			speechTitle?: string | null;
			pathwayPath?: string | null;
			projectName?: string | null;
			projectLevel?: string | null;
			minMinutes?: number | null;
			maxMinutes?: number | null;
		},
	) {
		await testDb.execute(
			sql`INSERT INTO speaker_details (slot_id, speech_title, pathway_path, project_name, project_level, min_minutes, max_minutes)
				VALUES (${slotId}, ${d.speechTitle ?? null}, ${d.pathwayPath ?? null}, ${d.projectName ?? null}, ${d.projectLevel ?? null}, ${d.minMinutes ?? null}, ${d.maxMinutes ?? null})`,
		);
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		speakerRoleId = def!.id;
		// Recreate the legacy table (dropped by the real migration) so we can seed
		// the pre-migration state and run the real backfill against it. NOTE: no FK
		// to role_slots here on purpose — an FK would make CREATE/DROP TABLE take an
		// exclusive lock on the shared role_slots table and deadlock with other test
		// files running in parallel against the same DB. The backfill joins by
		// slot_id, so the FK is irrelevant to what we're testing.
		await testDb.execute(
			sql.raw(`CREATE TABLE IF NOT EXISTS speaker_details (
				slot_id uuid PRIMARY KEY,
				speech_title text,
				pathway_path text,
				project_name text,
				project_level text,
				min_minutes integer,
				max_minutes integer
			)`),
		);
	});

	afterEach(async () => {
		await testDb.execute(sql.raw("DROP TABLE IF EXISTS speaker_details"));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("creates one Person-owned speech per content row and links the slot", async () => {
		const contentSlot = await newSpeakerSlot(seed.memberId);
		await insertSpeakerDetails(contentSlot, {
			speechTitle: "Finding My Voice",
			pathwayPath: "Dynamic Leadership",
			projectName: "Ice Breaker",
			projectLevel: "Level 1",
			minMinutes: 4,
			maxMinutes: 6,
		});

		await testDb.execute(sql.raw(SPEECH_BACKFILL_SQL));

		const [slotRow] = await testDb
			.select({ speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(eq(roleSlots.id, contentSlot))
			.limit(1);
		expect(slotRow?.speechId).not.toBeNull();

		const [sp] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, slotRow!.speechId!));
		expect(sp?.title).toBe("Finding My Voice");
		expect(sp?.pathwayPath).toBe("Dynamic Leadership");
		expect(sp?.projectName).toBe("Ice Breaker");
		expect(sp?.minMinutes).toBe(4);
		expect(sp?.maxMinutes).toBe(6);
		// Owned by the assignee's Person.
		expect(sp?.personId).toBe(seed.personId);
	});

	it("leaves empty/TBA placeholder rows unmigrated (no blank speech, null link)", async () => {
		const tbaSlot = await newSpeakerSlot(seed.memberId);
		await insertSpeakerDetails(tbaSlot, { speechTitle: "TBA" });
		const blankSlot = await newSpeakerSlot(seed.memberId);
		await insertSpeakerDetails(blankSlot, { speechTitle: "" });

		await testDb.execute(sql.raw(SPEECH_BACKFILL_SQL));

		const rows = await testDb
			.select({ id: roleSlots.id, speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(inArray(roleSlots.id, [tbaSlot, blankSlot]));
		for (const r of rows) expect(r.speechId).toBeNull();

		// No speeches were created for this club's people.
		const created = await testDb
			.select({ id: speeches.id })
			.from(speeches)
			.where(eq(speeches.personId, seed.personId));
		expect(created.length).toBe(0);
	});

	it("skips content rows whose slot has no assignee (no orphan speeches)", async () => {
		const orphanSlot = await newSpeakerSlot(null);
		await insertSpeakerDetails(orphanSlot, {
			speechTitle: "Unassigned Speech",
			pathwayPath: "Presentation Mastery",
		});

		await testDb.execute(sql.raw(SPEECH_BACKFILL_SQL));

		const [slotRow] = await testDb
			.select({ speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(eq(roleSlots.id, orphanSlot))
			.limit(1);
		expect(slotRow?.speechId).toBeNull();

		// Nothing was inserted — no orphan speech with that title anywhere.
		const orphans = await testDb
			.select({ id: speeches.id })
			.from(speeches)
			.where(eq(speeches.title, "Unassigned Speech"));
		expect(orphans.length).toBe(0);
	});
});
