/**
 * DB-backed tests for the agenda-template schema (#agenda-templates).
 *
 * The point of this file is the TWO PARTIAL INDEXES on `role_definitions`
 * (spec D3). Splitting one index into two is the kind of change that looks
 * obviously right and silently isn't: Postgres treats NULLs as distinct, so a
 * single index widened to include `template_id` would leave every standard role
 * unconstrained, and nothing would fail until a club held two Timers.
 *
 * NOTE ON THE FIXTURE: `seedClub()` inserts exactly ONE role definition, named
 * "Timer", with `key` UNSET — i.e. NULL (`src/test/db.ts:149`). Both partial
 * indexes are `WHERE key IS NOT NULL`, so the seeded row is invisible to them.
 * Every test below that needs a keyed standard role therefore creates it, and
 * an assertion that relies on the seed providing one can only ever pass.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/db/template-schema.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("agenda template schema", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		// GLOBAL templates (club_id NULL) survive `cleanup`, which cascades from
		// the club. Without this every suite that seeds one leaks it into the next
		// and the second run dies on `meeting_templates_global_key_unique`.
		// Materialized role_definitions reference templates with ON DELETE
		// RESTRICT, so the club must go first — which `cleanup` does.
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		await testDb.delete(meetingTemplates);
	});

	async function makeTemplate(key: string, clubId: string | null = null) {
		const [row] = await testDb
			.insert(meetingTemplates)
			.values({ clubId, key, name: `Template ${key}` })
			.returning({ id: meetingTemplates.id });
		if (!row) throw new Error("Failed to insert template");
		return row.id;
	}

	/** THIS club's role definitions. Never assert over an unscoped select:
	 *  `tm_test` is shared, so a global count is order-dependent and a leaked
	 *  row from any other suite turns a real assertion into a coin flip. */
	async function clubRoles() {
		return testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
	}

	/** A standard (template-less) role definition carrying a real key. The seed's
	 *  own role has a NULL key, so tests that need one make it here. */
	async function standardRole(key: string, name = key) {
		return testDb.insert(roleDefinitions).values({
			clubId: club.clubId,
			name,
			category: "functionary",
			key,
			templateId: null,
		});
	}

	describe("role_definitions unique indexes", () => {
		it("still rejects two standard role definitions sharing a key", async () => {
			await standardRole("timer", "Timer");
			await expect(standardRole("timer", "Second Timer")).rejects.toThrow();
		});

		it("still allows many standard roles with a NULL key", async () => {
			// The seeded "Timer" already has one; two more must not collide.
			await testDb.insert(roleDefinitions).values([
				{ clubId: club.clubId, name: "Custom A", category: "functionary" },
				{ clubId: club.clubId, name: "Custom B", category: "functionary" },
			]);
			const rows = await clubRoles();
			expect(rows.filter((r) => r.key === null)).toHaveLength(3);
		});

		it("allows a template role to reuse a standard key", async () => {
			const templateId = await makeTemplate("speech_contest");
			await standardRole("timer", "Timer");
			await testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				name: "Contest Timer",
				category: "functionary",
				key: "timer",
				templateId,
			});
			const rows = await clubRoles();
			expect(rows.filter((r) => r.key === "timer")).toHaveLength(2);
		});

		it("rejects two roles sharing a key within ONE template", async () => {
			const templateId = await makeTemplate("speech_contest");
			await testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				name: "Contest Timer",
				category: "functionary",
				key: "timer",
				templateId,
			});
			await expect(
				testDb.insert(roleDefinitions).values({
					clubId: club.clubId,
					name: "Another Contest Timer",
					category: "functionary",
					key: "timer",
					templateId,
				}),
			).rejects.toThrow();
		});

		it("allows the same key in TWO different templates", async () => {
			const a = await makeTemplate("speech_contest");
			const b = await makeTemplate("business_meeting");
			await testDb.insert(roleDefinitions).values([
				{
					clubId: club.clubId,
					name: "Contest Timer",
					category: "functionary",
					key: "timer",
					templateId: a,
				},
				{
					clubId: club.clubId,
					name: "Business Timer",
					category: "functionary",
					key: "timer",
					templateId: b,
				},
			]);
			const rows = await clubRoles();
			expect(rows.filter((r) => r.key === "timer")).toHaveLength(2);
		});
	});

	describe("meeting_templates unique indexes", () => {
		it("rejects two GLOBAL templates sharing a key", async () => {
			await makeTemplate("speech_contest");
			await expect(makeTemplate("speech_contest")).rejects.toThrow();
		});

		it("allows a club template to reuse a global template's key", async () => {
			await makeTemplate("speech_contest");
			const id = await makeTemplate("speech_contest", club.clubId);
			expect(id).toBeTruthy();
		});

		it("rejects two templates sharing a key within ONE club", async () => {
			await makeTemplate("speech_contest", club.clubId);
			await expect(
				makeTemplate("speech_contest", club.clubId),
			).rejects.toThrow();
		});
	});

	describe("cascades and restricts", () => {
		it("cascades roles and beats when a template is deleted", async () => {
			const templateId = await makeTemplate("throwaway");
			await testDb.insert(meetingTemplateRoles).values({
				templateId,
				key: "chair",
				name: "Chair",
				category: "leadership",
			});
			await testDb.insert(meetingTemplateBeats).values({
				templateId,
				sortOrder: 0,
				kind: "event",
				label: "Call to order",
				minutes: 2,
			});

			await testDb.delete(meetingTemplates);

			expect(
				await testDb
					.select()
					.from(meetingTemplateRoles)
					.where(eq(meetingTemplateRoles.templateId, templateId)),
			).toHaveLength(0);
			expect(
				await testDb
					.select()
					.from(meetingTemplateBeats)
					.where(eq(meetingTemplateBeats.templateId, templateId)),
			).toHaveLength(0);
		});

		it("RESTRICTS deleting a template whose roles are materialized", async () => {
			const templateId = await makeTemplate("speech_contest");
			await testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				name: "Chief Judge",
				category: "leadership",
				key: "chief_judge",
				templateId,
			});
			// Disable, never delete — this is why `meeting_templates.enabled` exists.
			await expect(testDb.delete(meetingTemplates)).rejects.toThrow();
		});
	});

	describe("meeting_template_beats", () => {
		it("stores fractional timer marks as numbers, not strings", async () => {
			const templateId = await makeTemplate("speech_contest");
			await testDb.insert(meetingTemplateBeats).values({
				templateId,
				sortOrder: 0,
				kind: "role",
				label: "Evaluation",
				minutes: 3,
				roleKey: "contestant",
				markGreen: 2,
				markYellow: 2.5,
				markRed: 3,
			});
			const [row] = await testDb
				.select()
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, templateId));
			// `real`, not `numeric` — numeric round-trips as a STRING and would
			// flow into TimingMarks (typed number) as "2.5".
			expect(row?.markYellow).toBe(2.5);
			expect(typeof row?.markYellow).toBe("number");
		});

		it("rejects two beats sharing a sortOrder within one template", async () => {
			const templateId = await makeTemplate("speech_contest");
			await testDb.insert(meetingTemplateBeats).values({
				templateId,
				sortOrder: 0,
				kind: "event",
				label: "A",
			});
			await expect(
				testDb.insert(meetingTemplateBeats).values({
					templateId,
					sortOrder: 0,
					kind: "event",
					label: "B",
				}),
			).rejects.toThrow();
		});
	});
});
