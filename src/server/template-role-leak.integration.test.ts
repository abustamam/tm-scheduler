/**
 * The regression the whole agenda-templates change is written around: once a
 * club has run ONE speech contest, its `role_definitions` table permanently
 * holds that contest's Chief Judge, Judges and Contestants. Any reader that
 * treats those as a slot SOURCE puts them on every ORDINARY meeting the club
 * creates afterwards.
 *
 * THE MECHANISM CHANGED IN #801, AND THE GUARD HAD TO CHANGE WITH IT. What held
 * those roles out used to be `role_definitions.template_id IS NOT NULL` — they
 * were separate rows, tagged to the template that minted them. That tagging was
 * itself the bug #801 fixed (a second Timer per template, carrying none of the
 * club's history), so a contest role is now an ordinary BANK row with
 * `template_id` NULL like every other, and the ONE column separating it from
 * the club's Ah-Counter is:
 *
 *     role_definitions.standing
 *
 * Spelled out literally there so a grep for the column lands on the gate that
 * enforces it — a gate a grep cannot find reads to the next reviewer as no gate
 * at all. `generateSlotRows` (src/lib/agenda.ts) filters `standing AND enabled`
 * unconditionally, and the three meeting-CREATION paths each `select()` the
 * whole `role_definitions` row, so they carry the real column and the gate is
 * closed by DATA rather than by a default.
 *
 * Those three paths — `applyCreateMeeting`, `applyBatchCreateMeetings` and
 * `ensureScheduleToppedUp` — still each spell their own scope out rather than
 * sharing a helper, and no OTHER fixture in this repo carries a non-standing
 * role, so every existing test in every one of those suites passes with or
 * without the gate. That is what makes this file necessary rather than
 * redundant: without a non-standing role in the fixture the guard is
 * unfalsifiable, and the shipped defect looks exactly like a green suite.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/template-role-leak.integration.test.ts
 */
import { and, eq, inArray } from "drizzle-orm";
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
const { applyTemplateSyncToUpcomingMeetings } = await import("./slots-logic");
const { applyRoleDefinitionSetEnabled } = await import(
	"./role-definitions-logic"
);

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
		 * contest roles resolved into its own bank, sitting in the same
		 * `role_definitions` table as its standard roles and distinguishable from
		 * them by `standing` alone.
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

			// The fixture is only meaningful if the rows are actually there AND are
			// non-standing — a materialize that silently no-opped, or one that
			// minted them standing, would make every assertion below pass for the
			// wrong reason. Both halves asserted, because the second is the gate.
			const resolved = await testDb
				.select({
					key: roleDefinitions.key,
					standing: roleDefinitions.standing,
					templateId: roleDefinitions.templateId,
				})
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						inArray(roleDefinitions.key, CONTEST_KEYS),
					),
				);
			expect(resolved.map((r) => r.key).sort()).toEqual(
				[...CONTEST_KEYS].sort(),
			);
			expect(resolved.every((r) => r.standing === false)).toBe(true);
			// And they are ordinary bank rows: nothing about them is template-tagged
			// any more, which is exactly why `standing` has to do the work.
			expect(resolved.every((r) => r.templateId === null)).toBe(true);
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
		 * The role definitions this meeting's generated slots actually draw on,
		 * carrying the one column that decides whether they belong there.
		 *
		 * `standing` rather than the role KEY, for the same reason this used to
		 * read `template_id`: a club's standard definitions may carry a null key
		 * (the unique index is partial on `key is not null`), so a key-based
		 * assertion could silently compare nothing. `standing` is the column the
		 * gate filters on, so it is also the column that fails when the gate is
		 * dropped.
		 */
		async function slotSources(
			meetingId: string,
		): Promise<{ name: string; standing: boolean }[]> {
			return testDb
				.select({
					name: roleDefinitions.name,
					standing: roleDefinitions.standing,
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
			expect(sources.filter((s) => !s.standing)).toEqual([]);
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

		/**
		 * The two BACKFILLS, which is where `standing` is closest to being wrong.
		 *
		 * Before #801 a contest role could not reach an ordinary meeting through
		 * either of them, because `roleDefScope`'s template axis excluded it three
		 * layers up. Now the bank holds every role and `standing` is the only thing
		 * between a promoted Chief Judge and an open slot on every upcoming
		 * meeting — so these run against `seedClub`'s own upcoming meeting, which
		 * both backfills consider in scope.
		 *
		 * The `enabled` toggle is included deliberately: it is the path an officer
		 * would actually take. A non-standing role lists in /admin/roles like any
		 * other, so switching one on is one click, and `syncSlotsForRoleEnabledChange`
		 * is what turns that click into slots.
		 */
		describe("regression: the two backfills and `standing`", () => {
			async function contestRoleId(key: string): Promise<string> {
				const [row] = await testDb
					.select({ id: roleDefinitions.id })
					.from(roleDefinitions)
					.where(
						and(
							eq(roleDefinitions.clubId, club.clubId),
							eq(roleDefinitions.key, key),
						),
					);
				if (!row) throw new Error(`no bank role for ${key}`);
				return row.id;
			}

			it("applyTemplateSyncToUpcomingMeetings never adds a non-standing role", async () => {
				await applyTemplateSyncToUpcomingMeetings({
					clubId: club.clubId,
					actorMemberId: null,
				});
				await expectStandardShape(club.meetingId);
			});

			it("toggling `enabled` on a non-standing role still adds nothing", async () => {
				const roleId = await contestRoleId("chief_judge");
				// Off and back on — the reconcile runs either way (it is idempotent
				// by design, not flip-detecting), so both directions are exercised.
				await applyRoleDefinitionSetEnabled({
					clubId: club.clubId,
					roleId,
					enabled: false,
					actorMemberId: null,
				});
				await applyRoleDefinitionSetEnabled({
					clubId: club.clubId,
					roleId,
					enabled: true,
					actorMemberId: null,
				});
				await expectStandardShape(club.meetingId);
			});

			it("but a STANDING role still backfills when re-enabled, exactly as before", async () => {
				// The other direction, and the one that makes the two tests above
				// falsifiable: a gate that blocked everything would satisfy them.
				// `seedClub`'s Timer is standing, non-paired, and already holds this
				// meeting's only slot — so disabling clears it and enabling puts it
				// back.
				const roleId = club.roleDefinitionId;
				await applyRoleDefinitionSetEnabled({
					clubId: club.clubId,
					roleId,
					enabled: false,
					actorMemberId: null,
				});
				expect(await slotSources(club.meetingId)).toEqual([]);

				await applyRoleDefinitionSetEnabled({
					clubId: club.clubId,
					roleId,
					enabled: true,
					actorMemberId: null,
				});
				const after = await slotSources(club.meetingId);
				expect(after.map((s) => s.name)).toEqual(["Timer"]);
				expect(after.every((s) => s.standing)).toBe(true);
			});
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
