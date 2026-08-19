/**
 * DB-backed tests for template reads, materialization and slot-source scoping.
 *
 * TWO HARNESS FACTS this file learned the hard way, both of which silently
 * break any suite that seeds a template:
 *
 *  1. `cleanup(clubId, userIds)` takes ARGUMENTS. `afterEach(cleanup)` hands it
 *     vitest's context as the club id, so nothing is deleted and the run leaks
 *     a club per test into the shared database.
 *  2. GLOBAL templates (`club_id IS NULL`) survive `cleanup` entirely, because
 *     it cascades from the club. Without an explicit delete the second run dies
 *     on `meeting_templates_global_key_unique`.
 *
 * And every assertion is SCOPED to this test's club: `tm_test` is shared, so a
 * global count is order-dependent by construction.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-templates-logic.integration.test.ts
 */
import { and, eq, isNull } from "drizzle-orm";
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

const {
	listAvailableTemplates,
	loadTemplateContent,
	materializeTemplateRoles,
	resolveMeetingRoleDefs,
} = await import("./meeting-templates-logic");

describe.skipIf(!hasTestDb)("meeting template logic", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		// Globals are club-less, so the cascade above cannot reach them.
		await testDb.delete(meetingTemplates);
	});

	async function makeContestTemplate(clubId: string | null = null) {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				key: "speech_contest",
				name: "Speech Contest",
				description: "A club contest",
				defaultLengthMinutes: 150,
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("Failed to insert template");
		await testDb.insert(meetingTemplateRoles).values([
			{
				templateId: tpl.id,
				key: "contest_chair",
				name: "Contest Chair",
				category: "leadership",
				defaultCount: 1,
				sortOrder: 10,
			},
			{
				templateId: tpl.id,
				key: "contestant_prepared",
				name: "Contestant",
				category: "speaker",
				defaultCount: 4,
				sortOrder: 20,
				isSpeakerRole: true,
			},
		]);
		await testDb.insert(meetingTemplateBeats).values([
			{
				templateId: tpl.id,
				sortOrder: 0,
				kind: "event",
				label: "Call to order",
				minutes: 2,
			},
			{
				templateId: tpl.id,
				sortOrder: 1,
				kind: "role",
				label: "Prepared speech",
				minutes: 7,
				roleKey: "contestant_prepared",
				repeatsRoleKey: "contestant_prepared",
			},
		]);
		return tpl.id;
	}

	/** Role definitions belonging to THIS club, optionally to one template. */
	async function clubRoleDefs(templateId?: string) {
		return testDb
			.select()
			.from(roleDefinitions)
			.where(
				templateId === undefined
					? eq(roleDefinitions.clubId, club.clubId)
					: and(
							eq(roleDefinitions.clubId, club.clubId),
							eq(roleDefinitions.templateId, templateId),
						),
			);
	}

	describe("listAvailableTemplates", () => {
		it("lists global templates for any club", async () => {
			await makeContestTemplate();
			const rows = await listAvailableTemplates(club.clubId);
			expect(rows.map((r) => r.key)).toEqual(["speech_contest"]);
			expect(rows[0]?.defaultLengthMinutes).toBe(150);
		});

		it("omits disabled templates", async () => {
			const id = await makeContestTemplate();
			await testDb
				.update(meetingTemplates)
				.set({ enabled: false })
				.where(eq(meetingTemplates.id, id));
			expect(await listAvailableTemplates(club.clubId)).toHaveLength(0);
		});

		/**
		 * Guards the tenant boundary. Without this the SQL `or(isNull, eq)` could
		 * be reduced to a bare `eq(enabled, true)` and every other test here would
		 * stay green while one club listed another club's templates.
		 */
		it("never lists ANOTHER club's template", async () => {
			const other = await seedClub();
			try {
				await testDb.insert(meetingTemplates).values({
					clubId: other.clubId,
					key: "their_private_template",
					name: "Theirs",
				});
				const keys = (await listAvailableTemplates(club.clubId)).map(
					(r) => r.key,
				);
				expect(keys).not.toContain("their_private_template");
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("lists this club's OWN template alongside the globals", async () => {
			await makeContestTemplate();
			await testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				key: "our_template",
				name: "Ours",
			});
			const keys = (await listAvailableTemplates(club.clubId)).map((r) => r.key);
			expect(keys).toContain("speech_contest");
			expect(keys).toContain("our_template");
		});
	});

	describe("loadTemplateContent", () => {
		it("loads beats and roles, ordered", async () => {
			const id = await makeContestTemplate();
			const content = await loadTemplateContent(id);
			expect(content?.beats.map((b) => b.sortOrder)).toEqual([0, 1]);
			expect(content?.roles.map((r) => r.key)).toEqual([
				"contest_chair",
				"contestant_prepared",
			]);
		});

		it("returns fractional marks as numbers", async () => {
			const id = await makeContestTemplate();
			await testDb.insert(meetingTemplateBeats).values({
				templateId: id,
				sortOrder: 2,
				kind: "role",
				label: "Evaluation",
				minutes: 3,
				roleKey: "contest_chair",
				markGreen: 2,
				markYellow: 2.5,
				markRed: 3,
			});
			const content = await loadTemplateContent(id);
			const beat = content?.beats.find((b) => b.sortOrder === 2);
			expect(beat?.markYellow).toBe(2.5);
		});

		it("returns null for an unknown template", async () => {
			expect(await loadTemplateContent(crypto.randomUUID())).toBeNull();
		});
	});

	describe("materializeTemplateRoles", () => {
		it("copies template roles into role_definitions, scoped to the template", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const rows = await clubRoleDefs(id);
			expect(rows.map((r) => r.key).sort()).toEqual([
				"contest_chair",
				"contestant_prepared",
			]);
			const contestant = rows.find((r) => r.key === "contestant_prepared");
			expect(contestant?.defaultCount).toBe(4);
			expect(contestant?.isSpeakerRole).toBe(true);
		});

		it("is idempotent — a second materialize adds nothing", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			await materializeTemplateRoles(testDb, club.clubId, id);
			expect(await clubRoleDefs(id)).toHaveLength(2);
		});

		it("does NOT overwrite a club's rename on re-materialize", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			await testDb
				.update(roleDefinitions)
				.set({ name: "Contest Chairman", defaultCount: 6 })
				.where(
					and(
						eq(roleDefinitions.templateId, id),
						eq(roleDefinitions.key, "contest_chair"),
					),
				);
			await materializeTemplateRoles(testDb, club.clubId, id);
			const row = (await clubRoleDefs(id)).find(
				(r) => r.key === "contest_chair",
			);
			// Copy-once: the club owns these rows after first use, exactly as it
			// owns the rows ROLE_TEMPLATE seeded at club creation.
			expect(row?.name).toBe("Contest Chairman");
			expect(row?.defaultCount).toBe(6);
		});
	});

	describe("resolveMeetingRoleDefs", () => {
		it("resolves the club's ENABLED standard defs when the template is null", async () => {
			const defs = await resolveMeetingRoleDefs(testDb, club.clubId, null);
			const standard = await testDb
				.select()
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						isNull(roleDefinitions.templateId),
						eq(roleDefinitions.enabled, true),
					),
				);
			expect(defs).toHaveLength(standard.length);
			expect(defs.length).toBeGreaterThan(0);
		});

		it("omits DISABLED standard defs", async () => {
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(eq(roleDefinitions.clubId, club.clubId));
			expect(await resolveMeetingRoleDefs(testDb, club.clubId, null)).toEqual(
				[],
			);
		});

		/**
		 * Pins the pure-read contract. If materialization creeps back inside this
		 * function, this test fails — which is the point: the conversion preview
		 * depends on being able to ask the question without taking the action.
		 */
		it("resolves EMPTY for a template whose roles are not materialized", async () => {
			const id = await makeContestTemplate();
			expect(await resolveMeetingRoleDefs(testDb, club.clubId, id)).toEqual([]);
			// And it wrote nothing while answering.
			expect(await clubRoleDefs(id)).toHaveLength(0);
		});

		it("resolves only the template's defs once materialized", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			expect(await resolveMeetingRoleDefs(testDb, club.clubId, id)).toHaveLength(
				2,
			);
		});

		/**
		 * The defect that would put a Chief Judge on every standard meeting a club
		 * creates after running one contest.
		 */
		it("excludes template roles from the STANDARD resolution", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const defs = await resolveMeetingRoleDefs(testDb, club.clubId, null);
			const ids = new Set(defs.map((d) => d.id));
			for (const row of await clubRoleDefs(id)) {
				expect(ids.has(row.id)).toBe(false);
			}
		});

		it("ignores the `enabled` flag for template roles", async () => {
			// `enabled` is the club's skeleton-crew switch for its OWN roles. A
			// template's roles are the contest's shape, not a menu — a disabled one
			// would silently drop a required contest position.
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(eq(roleDefinitions.templateId, id));
			expect(await resolveMeetingRoleDefs(testDb, club.clubId, id)).toHaveLength(
				2,
			);
		});
	});
});
