/**
 * DB-backed integration tests for the agenda backfill writer: idempotent
 * upsert of meetings/role_slots/speeches, ensuring the Vote Counter role
 * definition, and evaluator↔speaker pairing.
 *
 * #/db is redirected to the test database via the module mock below, the same
 * pattern every integration suite in this repo uses (see
 * src/server/import-members.integration.test.ts / src/test/db.ts).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run scripts/import-agendas.integration.test.ts
 */
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	members,
	meetings,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import { applyMeetingPlan, ensureRoleDefs, type WriterContext } from "./import-agendas";
import type { AgendaRecord, RoleDef, RosterMember } from "./import-agendas-logic";
import { planMeetingImport } from "./import-agendas-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const record: AgendaRecord = {
	meetingNumber: 1,
	date: "2025-01-09",
	theme: "Fresh Start",
	wordOfTheDay: "Momentum",
	sourceFileId: "f",
	sourceTitle: "t",
	roles: [
		{
			label: "Speaker #1",
			name: "Jagpal Singh",
			speech: { title: "AI Talk", projectLevel: "Level 2" },
		},
		{ label: "Evaluator #1", name: "Saiful Haque", evaluates: "Speaker #1" },
		{ label: "Vote Counter", name: "Mahbuba Khan" },
	],
};

describe.skipIf(!hasTestDb)("import-agendas writer", () => {
	let seed: SeededClub;
	let ctx: WriterContext;

	beforeAll(async () => {
		seed = await seedClub();

		// seedClub already gives the club a "Timer" role definition
		// (seed.roleDefinitionId). Add Speaker + Evaluator — deliberately NOT
		// Vote Counter, so the writer's ensureRoleDefs creation path is exercised.
		const [speakerDef, evaluatorDef] = await testDb
			.insert(roleDefinitions)
			.values([
				{
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				},
				{
					clubId: seed.clubId,
					name: "Evaluator",
					category: "evaluator",
					isSpeakerRole: false,
				},
			])
			.returning({ id: roleDefinitions.id, name: roleDefinitions.name });
		if (!speakerDef || !evaluatorDef) {
			throw new Error("Failed to seed role definitions");
		}
		const roleDefs: RoleDef[] = [
			{ id: seed.roleDefinitionId, name: "Timer" },
			speakerDef,
			evaluatorDef,
		];

		async function seedRosterMember(name: string): Promise<RosterMember> {
			const personId = await seedPerson({ name });
			const [row] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name })
				.returning({ id: members.id });
			if (!row) throw new Error(`Failed to seed member ${name}`);
			return { memberId: row.id, personId, name };
		}

		const roster = await Promise.all(
			["Jagpal Singh", "Saiful Haque", "Mahbuba Khan"].map(seedRosterMember),
		);

		ctx = { clubId: seed.clubId, roster, roleDefs };
	});

	afterAll(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/**
	 * Mirrors the CLI's per-run order (see import-agendas.ts): ensure Vote
	 * Counter exists BEFORE planMeetingImport maps rows to role definitions,
	 * so a Vote Counter row on the very first run becomes a real slot instead
	 * of landing in `unmatched` as "missing-definition".
	 */
	async function importOnce() {
		ctx.roleDefs = await ensureRoleDefs(ctx);
		const plan = planMeetingImport(record, ctx.roster, ctx.roleDefs, {});
		await applyMeetingPlan(plan, ctx);
	}

	/**
	 * The meeting the writer created/updated for `record`, excluding the
	 * unrelated scaffold meeting `seedClub()` itself inserts for this club.
	 */
	async function importedMeeting() {
		const rows = await testDb
			.select()
			.from(meetings)
			.where(and(eq(meetings.clubId, seed.clubId), ne(meetings.id, seed.meetingId)));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error("meeting not found");
		return row;
	}

	it("creates the Vote Counter role definition, meeting, slots, and speech", async () => {
		await importOnce();

		expect(ctx.roleDefs.some((d) => d.name === "Vote Counter")).toBe(true);

		const m = await importedMeeting();
		expect(m.status).toBe("completed");
		expect(m.lengthMinutes).toBe(60);

		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, m.id));
		expect(slots).toHaveLength(3);

		const sp = await testDb.select().from(speeches);
		expect(sp.some((s) => s.title === "AI Talk")).toBe(true);
	});

	it("is idempotent: a second run does not duplicate meetings, slots, role defs, or speeches", async () => {
		await importOnce();

		const m = await importedMeeting();
		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, m.id));
		expect(slots).toHaveLength(3);

		const allDefs = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, seed.clubId));
		expect(allDefs.filter((d) => d.name === "Vote Counter")).toHaveLength(1);

		const aiSpeeches = (await testDb.select().from(speeches)).filter(
			(s) => s.title === "AI Talk",
		);
		expect(aiSpeeches).toHaveLength(1);
	});

	it("links the evaluator slot to its speaker slot", async () => {
		const m = await importedMeeting();
		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, m.id));
		const speaker = slots.find((s) => s.slotIndex === 0 && s.speechId != null);
		const evaluator = slots.find((s) => s.evaluatesSlotId != null);
		expect(speaker).toBeDefined();
		expect(evaluator?.evaluatesSlotId).toBe(speaker?.id);
	});
});
