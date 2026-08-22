/**
 * DB-backed tests for the per-meeting agenda editor's read side.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadAgendaDraft } = await import("./meeting-agenda-edit-logic");

const RUN = Math.random().toString(36).slice(2, 8);

describe.skipIf(!hasTestDb)("loadAgendaDraft", () => {
	let club: SeededClub;
	const madeTemplates: string[] = [];
	// `SeededClub` carries `adminUserId` / `memberUserId` / `memberId` (all
	// singular) and ONE meeting, ONE role definition and ONE slot — not a
	// nine-role club. Assertions written against a full roster can only fail.

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		// Club first: `meetings.template_id` is ON DELETE RESTRICT against
		// `meeting_templates`, so the template row can't be deleted while the
		// meeting still points at it. Deleting the club cascades the meeting
		// (clearing that reference) and, since this template is club-scoped,
		// the template row itself. Templates can also be CLUB-LESS, and cleanup
		// cascading from the club does not reach those — the loop below deletes
		// only what this run created and is a no-op for anything the cascade
		// already removed.
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		for (const id of madeTemplates.splice(0)) {
			await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
		}
	});

	async function givePrivateTemplate() {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: club.meetingId,
				key: `draft_${RUN}`,
				name: `Draft ${RUN}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		madeTemplates.push(t.id);
		await testDb.insert(meetingTemplateRoles).values({
			templateId: t.id,
			key: "chair",
			name: "Chair",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 10,
			isSpeakerRole: false,
		});
		await testDb.insert(meetingTemplateBeats).values([
			{
				templateId: t.id,
				sortOrder: 0,
				kind: "section",
				label: "OPENING",
				minutes: 0,
			},
			{
				templateId: t.id,
				sortOrder: 1,
				kind: "role",
				label: "Welcome",
				roleKey: "chair",
				minutes: 5,
			},
		]);
		await testDb
			.update(meetings)
			.set({ templateId: t.id })
			.where(eq(meetings.id, club.meetingId));
		return t.id;
	}

	it("returns the meeting's own rows in sort order", async () => {
		const id = await givePrivateTemplate();
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.templateId).toBe(id);
		expect(draft?.rows.map((r) => r.label)).toEqual(["OPENING", "Welcome"]);
		expect(draft?.roles.map((r) => r.key)).toEqual(["chair"]);
		expect(draft?.editable).toBe(true);
	});

	it("returns null for a standard meeting", async () => {
		// A meeting with no template reads the code-derived RUN_OF_SHOW and is
		// out of scope for this editor by design.
		expect(await loadAgendaDraft(club.meetingId)).toBeNull();
	});

	it("returns null when template_id points at a template that is not this meeting's own private copy", async () => {
		// A meeting converted before this feature landed points straight at a
		// SHARED template (`meeting_id IS NULL`) rather than a private copy —
		// editing that would rewrite the shared row for every club running it.
		// `ensureAgendaDraft` (Task 7) is what upgrades this to a private copy on
		// first write; this seam must not treat the shared row as editable.
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({ key: `shared_${RUN}`, name: `Shared ${RUN}` })
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("template insert failed");
		madeTemplates.push(shared.id);
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, club.meetingId));
		expect(await loadAgendaDraft(club.meetingId)).toBeNull();
	});

	it("marks a completed meeting NOT editable rather than hiding it", async () => {
		// The agenda is still worth reading after the night; it just stops being
		// writable, the same lock every other mutator honours.
		await givePrivateTemplate();
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.editable).toBe(false);
		expect(draft?.rows.length).toBeGreaterThan(0);
	});
});
