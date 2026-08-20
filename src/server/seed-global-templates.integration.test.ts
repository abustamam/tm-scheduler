/**
 * `scripts/seed-global-templates.ts` (#agenda-templates PR 2).
 *
 * The module shipped at 0% coverage, and its doc comment makes a load-bearing
 * SAFETY claim that nothing checked: that re-running the seed is safe while a
 * club already holds materialized `role_definitions` rows pointing at the
 * template. It is safe for a specific structural reason — the update path
 * DELETES the template's roles and beats and re-inserts them, and slots
 * reference the club's materialized `role_definitions` rows rather than the
 * template's own roles, so the delete cannot cascade into a club's agenda.
 *
 * That reasoning is correct and entirely invisible. If a future edit pointed
 * `role_slots` at `meeting_template_roles`, or changed the FK to CASCADE, this
 * script would silently delete a club's claimed contest roles the next time
 * anyone ran `bun run seed:templates` — the failure being both silent and
 * destructive is exactly why this file exists.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/seed-global-templates.integration.test.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import type { TemplateSeed } from "#/lib/contest-template";
import { CONTEST_TEMPLATE } from "#/lib/contest-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { seedTemplate } = await import("#/../scripts/seed-global-templates");
const { materializeTemplateRoles } = await import("./meeting-templates-logic");

/** Per-run key: globals are visible to every club and vitest runs files in
 *  parallel against one shared database, so a fixed key collides. */
const RUN = crypto.randomUUID().slice(0, 8);

describe.skipIf(!hasTestDb)("seedTemplate", () => {
	const created: string[] = [];

	/** The real contest seed under a per-run key. */
	function seed(over: Partial<TemplateSeed> = {}): TemplateSeed {
		return { ...CONTEST_TEMPLATE, key: `seed_test-${RUN}`, ...over };
	}

	afterEach(async () => {
		for (const id of created.splice(0)) {
			await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
		}
	});

	async function contentOf(templateId: string) {
		const [beats, roles] = await Promise.all([
			testDb
				.select({ label: meetingTemplateBeats.label })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, templateId)),
			testDb
				.select({ key: meetingTemplateRoles.key })
				.from(meetingTemplateRoles)
				.where(eq(meetingTemplateRoles.templateId, templateId)),
		]);
		return { beats: beats.length, roles: roles.length };
	}

	it("inserts a global template with all of its beats and roles", async () => {
		const s = seed();
		const id = await seedTemplate(s);
		created.push(id);

		const [row] = await testDb
			.select()
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, id));
		expect(row?.clubId).toBeNull();
		expect(row?.key).toBe(s.key);
		expect(row?.name).toBe(s.name);
		expect(row?.defaultLengthMinutes).toBe(s.defaultLengthMinutes);
		// ABSOLUTE counts against the seed, not `toBeGreaterThan`: a partial insert
		// is the failure mode, and "more than zero" cannot see it.
		expect(await contentOf(id)).toEqual({
			beats: s.beats.length,
			roles: s.roles.length,
		});
	});

	it("re-running returns the SAME template rather than a second one", async () => {
		const s = seed();
		const first = await seedTemplate(s);
		created.push(first);
		const second = await seedTemplate(s);
		expect(second).toBe(first);

		const rows = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(eq(meetingTemplates.key, s.key), isNull(meetingTemplates.clubId)),
			);
		expect(rows).toHaveLength(1);
	});

	it("REPLACES beats and roles rather than appending them", async () => {
		const s = seed();
		const id = await seedTemplate(s);
		created.push(id);
		await seedTemplate(s);
		await seedTemplate(s);
		// Three runs, one copy. Appending would give 3x, which is the bug the
		// delete-then-insert exists to prevent and which no count-free assertion
		// would notice until a club printed a contest with 78 beats.
		expect(await contentOf(id)).toEqual({
			beats: s.beats.length,
			roles: s.roles.length,
		});
	});

	it("pushes an edited seed into an already-seeded database", async () => {
		const s = seed();
		const id = await seedTemplate(s);
		created.push(id);
		// The whole reason the update path replaces rather than skips: editing
		// `contest-template.ts` must reach a database that already has the row.
		const edited = seed({
			name: `Renamed ${RUN}`,
			defaultLengthMinutes: 195,
			beats: s.beats.slice(0, 4),
			roles: s.roles.slice(0, 3),
		});
		expect(await seedTemplate(edited)).toBe(id);

		const [row] = await testDb
			.select()
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, id));
		expect(row?.name).toBe(`Renamed ${RUN}`);
		expect(row?.defaultLengthMinutes).toBe(195);
		expect(await contentOf(id)).toEqual({ beats: 4, roles: 3 });
	});
});

/**
 * The safety claim in the script's own doc comment, made observable.
 */
describe.skipIf(!hasTestDb)(
	"re-seeding a template a club is already using",
	() => {
		let club: SeededClub;
		const created: string[] = [];

		beforeEach(async () => {
			club = await seedClub();
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			for (const id of created.splice(0)) {
				await testDb
					.delete(meetingTemplates)
					.where(eq(meetingTemplates.id, id));
			}
		});

		it("leaves the club's materialized role definitions and their slots intact", async () => {
			const s = { ...CONTEST_TEMPLATE, key: `seed_live-${RUN}` };
			const templateId = await seedTemplate(s);
			created.push(templateId);

			// The club runs a contest: its role definitions are materialized from the
			// template, and a slot points at one of them.
			await materializeTemplateRoles(testDb, club.clubId, templateId);
			const defs = await testDb
				.select({ id: roleDefinitions.id, key: roleDefinitions.key })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
					),
				);
			expect(defs.length).toBe(s.roles.length);

			// A claimed contest role: a slot on the club's materialized definition, on
			// the meeting `seedClub` created. Unconditional — an earlier cut guarded
			// this on finding a meeting, which would have let the whole safety
			// assertion below pass by never running.
			const targetDef = defs[0];
			if (!targetDef) throw new Error("no materialized role definition");
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: club.meetingId,
					roleDefinitionId: targetDef.id,
					slotIndex: 99,
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("failed to insert the contest slot");

			// Now re-seed, which DELETES the template's own roles and beats.
			await seedTemplate(s);

			// The club's materialized definitions are untouched — same ids, same count.
			const after = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
					),
				);
			expect(after.map((r) => r.id).sort()).toEqual(
				defs.map((r) => r.id).sort(),
			);

			// And the claimed slot survived — by ID, so this cannot be satisfied by
			// some other slot on the same definition. This is the assertion that would
			// fail if `role_slots` were ever pointed at `meeting_template_roles`, or
			// the FK changed to CASCADE: a club losing its contest line-up to a
			// routine `bun run seed:templates`.
			const surviving = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, slot.id));
			expect(surviving.map((r) => r.id)).toEqual([slot.id]);
		});

		it("does not rename a role the club renamed after materializing", async () => {
			const s = { ...CONTEST_TEMPLATE, key: `seed_rename-${RUN}` };
			const templateId = await seedTemplate(s);
			created.push(templateId);
			await materializeTemplateRoles(testDb, club.clubId, templateId);

			await testDb
				.update(roleDefinitions)
				.set({ name: "Our Own Words" })
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
						eq(roleDefinitions.key, "chief_judge"),
					),
				);

			await seedTemplate(s);

			// #445 makes the club's own name authoritative on every surface, so a
			// re-seed must not undo it. `resync-template-roles.ts` is the deliberate
			// escape hatch for pushing a seed rename through, and it does not exist yet.
			const [renamed] = await testDb
				.select({ name: roleDefinitions.name })
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.templateId, templateId),
						eq(roleDefinitions.key, "chief_judge"),
					),
				);
			expect(renamed?.name).toBe("Our Own Words");
		});
	},
);
