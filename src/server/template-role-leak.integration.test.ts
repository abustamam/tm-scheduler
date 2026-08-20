/**
 * The regression the whole agenda-templates change is written around
 * (#agenda-templates): once a club has run ONE speech contest, its
 * `role_definitions` table permanently holds that contest's Chief Judge, Judges
 * and Contestants — materialized rows carrying a non-null `template_id`. Six
 * modules select role definitions by club, and each one is choosing a slot
 * source. Any of them left unscoped puts the contest's roles on every ORDINARY
 * meeting the club creates afterwards.
 *
 * Three of those six are meeting-CREATION paths, and each spells the predicate
 * out separately rather than sharing a helper — `applyCreateMeeting`,
 * `applyBatchCreateMeetings` and `ensureScheduleToppedUp` all carry their own
 * `isNull(roleDefinitions.templateId)`. Three copies is three chances to drop
 * one, and no existing fixture in this repo has a template row, so EVERY
 * existing test in every one of those suites passes with or without the
 * predicate. That is what makes this file necessary rather than redundant:
 * without a materialized template role in the fixture the guard is
 * unfalsifiable, and the shipped defect looks exactly like a green suite.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/template-role-leak.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubMeetingRecurrence,
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyCreateMeeting } = await import("./meetings-logic");
const { applyBatchCreateMeetings } = await import("./batch-meetings-logic");
const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");
const { materializeTemplateRoles } = await import("./meeting-templates-logic");

const NOW = new Date("2026-06-01T12:00:00Z");
/** Globals are visible to every club and vitest runs files in parallel. */
const RUN = crypto.randomUUID().slice(0, 8);

/** The two contest role keys the fixture materializes. */
const CONTEST_KEYS = ["chief_judge", "contestant_prepared"];

describe.skipIf(!hasTestDb)(
	"template roles never leak into a new meeting",
	() => {
		let club: SeededClub;
		let templateId: string;
		const createdTemplateIds: string[] = [];

		/**
		 * Put the club in the state a club is in the day AFTER its first contest:
		 * contest role definitions materialized against a template, sitting in the
		 * same `role_definitions` table as its standard roles.
		 */
		beforeEach(async () => {
			club = await seedClub();
			const [tpl] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: null,
					key: `leak_contest-${RUN}`,
					name: `Leak Contest ${RUN}`,
				})
				.returning({ id: meetingTemplates.id });
			if (!tpl) throw new Error("Failed to insert template");
			templateId = tpl.id;
			createdTemplateIds.push(tpl.id);
			await testDb.insert(meetingTemplateRoles).values([
				{
					templateId,
					key: "chief_judge",
					name: "Chief Judge",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 10,
				},
				{
					templateId,
					key: "contestant_prepared",
					name: "Contestant",
					category: "speaker",
					defaultCount: 4,
					sortOrder: 20,
					isSpeakerRole: true,
				},
			]);
			await materializeTemplateRoles(testDb, club.clubId, templateId);

			// The fixture is only meaningful if the rows are actually there — a
			// materialize that silently no-opped would make every assertion below
			// pass for the wrong reason.
			const materialized = await testDb
				.select({ key: roleDefinitions.key })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
					),
				);
			expect(materialized.map((r) => r.key).sort()).toEqual(
				[...CONTEST_KEYS].sort(),
			);
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			// Global templates carry a null `club_id`, so `cleanup` does not cascade
			// to them — delete only the ids this run created.
			for (const id of createdTemplateIds.splice(0)) {
				await testDb
					.delete(meetingTemplates)
					.where(eq(meetingTemplates.id, id));
			}
		});

		/**
		 * The role definitions this meeting's generated slots actually draw on.
		 * Keyed on `template_id` rather than on the role KEY: a club's standard
		 * definitions may carry a null key (the unique index is partial on
		 * `key is not null`), so a key-based assertion would silently compare
		 * nothing. `template_id` is the column the three predicates filter on, so it
		 * is also the column that fails when one of them is dropped.
		 */
		async function slotSources(
			meetingId: string,
		): Promise<{ name: string; templateId: string | null }[]> {
			return testDb
				.select({
					name: roleDefinitions.name,
					templateId: roleDefinitions.templateId,
				})
				.from(roleSlots)
				.innerJoin(
					roleDefinitions,
					eq(roleSlots.roleDefinitionId, roleDefinitions.id),
				)
				.where(eq(roleSlots.meetingId, meetingId));
		}

		async function expectStandardShape(meetingId: string) {
			const sources = await slotSources(meetingId);
			// Non-empty first: a meeting with no slots at all would satisfy every
			// assertion below and read as a pass.
			expect(sources.length).toBeGreaterThan(0);
			expect(sources.filter((s) => s.templateId !== null)).toEqual([]);
			expect(sources.map((s) => s.name)).not.toContain("Chief Judge");
			expect(sources.map((s) => s.name)).not.toContain("Contestant");
		}

		it("applyCreateMeeting builds a standard meeting from standard roles only", async () => {
			const { meetingId } = await applyCreateMeeting({
				clubId: club.clubId,
				scheduledAt: "2026-07-02T18:45",
				location: `Leak single ${RUN}`,
			});
			await expectStandardShape(meetingId);
		});

		it("applyBatchCreateMeetings builds every meeting in the batch from standard roles only", async () => {
			await applyBatchCreateMeetings({
				clubId: club.clubId,
				wallTimes: ["2026-07-09T18:45", "2026-07-16T18:45"],
				location: `Leak batch ${RUN}`,
			});
			const created = await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(
					and(
						eq(meetings.clubId, club.clubId),
						eq(meetings.location, `Leak batch ${RUN}`),
					),
				);
			expect(created).toHaveLength(2);
			for (const m of created) await expectStandardShape(m.id);
		});

		it("ensureScheduleToppedUp builds auto-materialized meetings from standard roles only", async () => {
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: club.clubId,
				mode: "interval",
				weekday: 4,
				intervalWeeks: 1,
				anchorDate: "2026-01-01",
				timeOfDay: "18:45",
				keepAhead: 2,
				enabled: true,
				location: `Leak topup ${RUN}`,
			});
			const { created } = await ensureScheduleToppedUp(club.clubId, NOW);
			expect(created).toBeGreaterThan(0);
			const rows = await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.clubId, club.clubId));
			for (const m of rows) await expectStandardShape(m.id);
		});
	},
);
