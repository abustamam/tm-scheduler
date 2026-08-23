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
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
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

// Per-run suffix so parallel vitest files (and reruns) sharing `tm_test`
// never collide on a fixed key.
const RUN = Math.random().toString(36).slice(2, 8);

describe.skipIf(!hasTestDb)("agenda template schema", () => {
	let club: SeededClub;

	/**
	 * Templates THIS file created. `tm_test` is shared and vitest runs test FILES
	 * in parallel, so two unscoped operations break each other:
	 *   - a fixed global key collides on `meeting_templates_global_key_unique`;
	 *   - `delete(meetingTemplates)` with no WHERE deletes the OTHER file's rows,
	 *     which then fails the FK from its materialized role_definitions.
	 * So keys are unique per template and teardown deletes only what we made.
	 */
	const createdTemplateIds: string[] = [];

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
		if (createdTemplateIds.length > 0) {
			await testDb
				.delete(meetingTemplates)
				.where(inArray(meetingTemplates.id, createdTemplateIds));
			createdTemplateIds.length = 0;
		}
	});

	/** `exactKey` opts out of the per-run uniquifier — the duplicate-key tests
	 *  need two inserts to genuinely collide, which a unique suffix prevents. */
	async function makeTemplate(
		key: string,
		clubId: string | null = null,
		exactKey = false,
	) {
		const [row] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				key: exactKey ? key : `${key}-${crypto.randomUUID().slice(0, 8)}`,
				name: `Template ${key}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!row) throw new Error("Failed to insert template");
		createdTemplateIds.push(row.id);
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
			await makeTemplate("dup_global", null, true);
			await expect(makeTemplate("dup_global", null, true)).rejects.toThrow();
		});

		it("allows a club template to reuse a global template's key", async () => {
			await makeTemplate("speech_contest");
			const id = await makeTemplate("speech_contest", club.clubId);
			expect(id).toBeTruthy();
		});

		it("rejects two templates sharing a key within ONE club", async () => {
			await makeTemplate("dup_club", club.clubId, true);
			await expect(
				makeTemplate("dup_club", club.clubId, true),
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

			// Delete THIS template only. An unscoped delete would take the rows a
			// parallel suite is mid-way through using.
			await testDb
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, templateId));

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
			await expect(
				testDb
					.delete(meetingTemplates)
					.where(eq(meetingTemplates.id, templateId)),
			).rejects.toThrow();
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

	it("lets two meetings in one club each hold a private copy of the same key", async () => {
		// The shared-template unique index is on (club_id, key). Two contest
		// meetings both copying `speech_contest` would collide on it, so its
		// predicate must exempt private rows.
		const [a, b] = await testDb
			.insert(meetings)
			.values([
				{ clubId: club.clubId, scheduledAt: new Date("2027-01-07T02:00:00Z") },
				{ clubId: club.clubId, scheduledAt: new Date("2027-01-21T02:00:00Z") },
			])
			.returning({ id: meetings.id });
		if (!a || !b) throw new Error("meeting insert failed");

		const rows = await testDb
			.insert(meetingTemplates)
			.values([
				{ clubId: club.clubId, meetingId: a.id, key: `copy_${RUN}`, name: "A" },
				{ clubId: club.clubId, meetingId: b.id, key: `copy_${RUN}`, name: "B" },
			])
			.returning({ id: meetingTemplates.id });
		expect(rows).toHaveLength(2);
	});

	it("allows at most ONE private template per meeting", async () => {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date("2027-02-04T02:00:00Z"),
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");

		await testDb.insert(meetingTemplates).values({
			clubId: club.clubId,
			meetingId: m.id,
			key: `one_${RUN}`,
			name: "First",
		});
		await expect(
			testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `two_${RUN}`,
				name: "Second",
			}),
		).rejects.toThrow();
	});

	/**
	 * Ship review C5. The version of this test that shipped inserted a private
	 * template with NO materialized `role_definitions` and asserted the cascade
	 * fired — which is the ONE shape the cascade can actually delete, and NOT
	 * the shape a conversion normally produces. It therefore proved nothing
	 * about the deleter its own comment cited.
	 *
	 * Kept, relabelled for what it is: the empty case. It is reachable — a
	 * conversion to a template that declares no roles at all leaves exactly
	 * this, which is why the sibling test below has to seed a role by hand to
	 * reach the other one — and the cascade genuinely handles it.
	 */
	it("cascade-deletes a private template that has NO materialized roles", async () => {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date("2027-03-04T02:00:00Z"),
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `cascade_${RUN}`,
				name: "Doomed",
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");

		await testDb.delete(meetings).where(eq(meetings.id, m.id));
		const left = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, t.id));
		expect(left).toEqual([]);
	});

	/**
	 * The shape a conversion to a template that declares ANY role produces —
	 * which is every seeded one — and the one the cascade CANNOT reach:
	 * `role_definitions.template_id` is ON DELETE RESTRICT, and
	 * `materializeTemplateRoles` writes one row per declared role against the
	 * private copy. So deleting the meeting aborts.
	 *
	 * This is the behaviour, not a bug being asserted as correct — nothing in
	 * production hits it because the only deleter (`recurrence-rule-logic.ts`)
	 * refuses any meeting with a `template_id`. Pinning it here means a future
	 * deleter that forgets that guard fails a test instead of failing a club's
	 * database, and it means the `meetingId` docblock in `schema.ts` (which now
	 * says exactly this) has something holding it true.
	 */
	it("REFUSES to delete a meeting whose private template has materialized roles", async () => {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date("2027-03-11T02:00:00Z"),
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("meeting insert failed");
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `restrict_${RUN}`,
				name: "Converted",
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		// What `materializeTemplateRoles` writes on every conversion.
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				templateId: t.id,
				key: `contest_chair_${RUN}`,
				name: "Contest Chair",
				category: "leadership",
				defaultCount: 1,
				sortOrder: 10,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role definition insert failed");

		// The SQLSTATE and the constraint NAME, not a bare "threw something": an
		// unrelated failure would satisfy `.rejects.toThrow()` and this test
		// exists to say WHICH foreign key blocks the delete. Drizzle's own
		// message is only "Failed query: delete from …"; both live on `.cause`,
		// the underlying `pg` error — the same shape
		// `attendance-plan-logic.integration.test.ts` asserts against.
		await expect(
			testDb.delete(meetings).where(eq(meetings.id, m.id)),
		).rejects.toMatchObject({
			cause: {
				code: "23503",
				constraint: "role_definitions_template_id_meeting_templates_id_fk",
			},
		});

		// Nothing partially applied: the meeting and its copy both survive.
		expect(
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.id, m.id)),
		).toHaveLength(1);
		expect(
			await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, t.id)),
		).toHaveLength(1);

		// Retiring the definitions first is what makes the delete possible —
		// the order `applyTemplateConversion` already uses.
		await testDb.delete(roleDefinitions).where(eq(roleDefinitions.id, def.id));
		await testDb.delete(meetings).where(eq(meetings.id, m.id));
		expect(
			await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, t.id)),
		).toEqual([]);
	});
});
