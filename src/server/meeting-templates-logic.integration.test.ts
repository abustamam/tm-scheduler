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
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import {
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Per-run marker. Globals are visible to EVERY club and vitest runs test
 *  files in parallel against one shared database, so this suite can only
 *  assert over templates it created itself. */
const RUN = crypto.randomUUID().slice(0, 8);
const mine = (names: string[]) => names.filter((n) => n.includes(RUN));

const { listRoleDefinitions } = await import("./role-definitions-logic");

const {
	copyTemplateForMeeting,
	listAvailableTemplates,
	loadTemplateContent,
	materializeTemplateRoles,
	resolveMeetingRoleDefs,
} = await import("./meeting-templates-logic");

describe.skipIf(!hasTestDb)("meeting template logic", () => {
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
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		// Globals are club-less, so the cascade above cannot reach them.
		if (createdTemplateIds.length > 0) {
			await testDb
				.delete(meetingTemplates)
				.where(inArray(meetingTemplates.id, createdTemplateIds));
			createdTemplateIds.length = 0;
		}
	});

	async function makeContestTemplate(clubId: string | null = null) {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				key: `speech_contest-${crypto.randomUUID().slice(0, 8)}`,
				name: `Speech Contest ${RUN}`,
				description: "A club contest",
				defaultLengthMinutes: 150,
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("Failed to insert template");
		createdTemplateIds.push(tpl.id);
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

	/** Role definitions belonging to THIS club — its whole bank, or just the rows
	 *  a template's declarations RESOLVE to.
	 *
	 *  Narrowed by declared KEY since #801, where it used to filter
	 *  `role_definitions.template_id`. There is no template axis on this table any
	 *  more: a declaration and a bank row meet on (club, key), which is the join
	 *  `loadDeclaredRoleDefs` performs and therefore the one a test of it should
	 *  reproduce. */
	async function clubRoleDefs(templateId?: string) {
		if (templateId === undefined) {
			return testDb
				.select()
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, club.clubId));
		}
		const declared = await testDb
			.select({ key: meetingTemplateRoles.key })
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId));
		if (declared.length === 0) return [];
		return testDb
			.select()
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					inArray(
						roleDefinitions.key,
						declared.map((d) => d.key),
					),
				),
			);
	}

	describe("listAvailableTemplates", () => {
		it("lists global templates for any club", async () => {
			await makeContestTemplate();
			const rows = await listAvailableTemplates(club.clubId);
			// Assert on NAME: the key carries a per-run suffix so parallel suites
			// sharing `tm_test` cannot collide on the global unique index.
			expect(mine(rows.map((r) => r.name))).toEqual([`Speech Contest ${RUN}`]);
			// Scoped to THIS run's row, not `rows[0]`. Global templates are
			// club-less, so `cleanup(clubId)` cannot cascade to them and every real
			// seeded template is visible here too — an index-based assertion on a
			// shared table is order-dependent by construction, and this one started
			// reading the app's own seeded contest the moment production's template
			// was also present in `tm_test`.
			const own = rows.find((r) => r.name === `Speech Contest ${RUN}`);
			expect(own?.defaultLengthMinutes).toBe(150);
		});

		it("omits disabled templates", async () => {
			const id = await makeContestTemplate();
			await testDb
				.update(meetingTemplates)
				.set({ enabled: false })
				.where(eq(meetingTemplates.id, id));
			expect(
				mine((await listAvailableTemplates(club.clubId)).map((r) => r.name)),
			).toEqual([]);
		});

		/**
		 * Guards the tenant boundary. Without this the SQL `or(isNull, eq)` could
		 * be reduced to a bare `eq(enabled, true)` and every other test here would
		 * stay green while one club listed another club's templates.
		 */
		it("never lists ANOTHER club's template", async () => {
			const other = await seedClub();
			try {
				// Assert on the key and name we ACTUALLY inserted. An earlier cut of
				// this test asserted `not.toContain("their_private_template")` — a
				// literal no row ever holds, since keys carry a per-run suffix. That
				// passes with the `or(isNull(clubId), eq(clubId, …))` tenant predicate
				// deleted, i.e. it could not fail on the leak it exists to catch.
				const theirKey = `their_private-${crypto.randomUUID().slice(0, 8)}`;
				const theirName = `Theirs ${RUN}`;
				await testDb.insert(meetingTemplates).values({
					clubId: other.clubId,
					key: theirKey,
					name: theirName,
				});
				const rows = await listAvailableTemplates(club.clubId);
				expect(rows.map((r) => r.key)).not.toContain(theirKey);
				expect(rows.map((r) => r.name)).not.toContain(theirName);
				// And prove the row is actually visible to ITS owner, so the
				// assertions above are not passing because nothing was written.
				const theirs = await listAvailableTemplates(other.clubId);
				expect(theirs.map((r) => r.key)).toContain(theirKey);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("lists this club's OWN template alongside the globals", async () => {
			await makeContestTemplate();
			await testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				key: `our_template-${crypto.randomUUID().slice(0, 8)}`,
				name: `Ours ${RUN}`,
			});
			// Assert on NAME: keys carry a per-run suffix so parallel suites sharing
			// `tm_test` cannot collide on `meeting_templates_global_key_unique`.
			const names = (await listAvailableTemplates(club.clubId)).map(
				(r) => r.name,
			);
			expect(names).toContain(`Speech Contest ${RUN}`);
			expect(names).toContain(`Ours ${RUN}`);
		});

		it("omits a meeting's private copy", async () => {
			// A private copy is a meeting's own agenda, not something another
			// meeting may be converted to. It is an ordinary template in every
			// other respect, which is why the picker has to exclude it explicitly.
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date("2027-04-01T02:00:00Z"),
				})
				.returning({ id: meetings.id });
			if (!m) throw new Error("meeting insert failed");
			await testDb.insert(meetingTemplates).values({
				clubId: club.clubId,
				meetingId: m.id,
				key: `private_${RUN}`,
				name: `Private ${RUN}`,
			});

			const rows = await listAvailableTemplates(club.clubId);
			expect(rows.map((r) => r.name)).not.toContain(`Private ${RUN}`);
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

		it("returns an EMPTY agenda for a template with no rows, not null", async () => {
			// The editor can delete the last row, and building an agenda up from
			// nothing is a legitimate state. Today "no beats and no roles" is read as
			// "no such template", which makes `meetings.ts` throw
			// "references template X, which has no beats or roles" and takes the
			// meeting page down.
			const [t] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: club.clubId,
					key: `empty_${RUN}`,
					name: `Empty ${RUN}`,
				})
				.returning({ id: meetingTemplates.id });
			if (!t) throw new Error("template insert failed");

			const content = await loadTemplateContent(t.id);
			expect(content).toEqual({ beats: [], roles: [] });
		});

		it("returns null for a template id that does not exist", async () => {
			expect(
				await loadTemplateContent("00000000-0000-0000-0000-000000000000"),
			).toBeNull();
		});

		/**
		 * The two size caps live in `lib/meeting-template-limits.ts` so a unit
		 * test can pin their VALUES without a database — but a pinned value
		 * enforced by nothing is decorative, and both were, until this seam got
		 * its `.limit()`. Assert the OBSERVABLE the cap controls (how many rows
		 * reach a renderer), with a fixture that overruns it. Delete either
		 * `.limit()` and this fails with 205/45 instead of 200/40.
		 */
		it("REFUSES to copy an oversized template rather than truncating it", async () => {
			// The load seam truncates, because a renderer must produce something.
			// A COPY must not: silently dropping rows would hand the club a
			// permanently shortened agenda it never authored, and #622 makes an
			// officer-authored template a legal copy source for the first time.
			const id = await makeContestTemplate();
			await testDb.insert(meetingTemplateBeats).values(
				Array.from({ length: MAX_TEMPLATE_BEATS + 3 }, (_, i) => ({
					templateId: id,
					sortOrder: 100 + i,
					kind: "event" as const,
					label: `Filler ${i}`,
					minutes: 1,
				})),
			);
			await expect(
				copyTemplateForMeeting(testDb, {
					sourceTemplateId: id,
					clubId: club.clubId,
					meetingId: club.meetingId,
				}),
			).rejects.toThrow(/too large/i);
		});

		it("truncates an oversized template at the load seam, in sort order", async () => {
			const id = await makeContestTemplate();
			// makeContestTemplate seeds 2 beats / 2 roles; overrun both caps.
			await testDb.insert(meetingTemplateBeats).values(
				Array.from({ length: MAX_TEMPLATE_BEATS + 3 }, (_, i) => ({
					templateId: id,
					sortOrder: 100 + i,
					kind: "event" as const,
					label: `Filler ${i}`,
					minutes: 1,
				})),
			);
			await testDb.insert(meetingTemplateRoles).values(
				Array.from({ length: MAX_TEMPLATE_ROLES + 3 }, (_, i) => ({
					templateId: id,
					key: `filler_${i}`,
					name: `Filler ${i}`,
					category: "leadership" as const,
					defaultCount: 1,
					sortOrder: 100 + i,
				})),
			);
			const content = await loadTemplateContent(id);
			expect(content?.beats).toHaveLength(MAX_TEMPLATE_BEATS);
			expect(content?.roles).toHaveLength(MAX_TEMPLATE_ROLES);
			// Truncated from the TAIL: the earliest sortOrder survives, so the
			// rows a club actually reads are the ones it authored first.
			expect(content?.beats[0]?.sortOrder).toBe(0);
			expect(content?.roles[0]?.key).toBe("contest_chair");
		});
	});

	describe("materializeTemplateRoles", () => {
		it("resolves declared roles into the club's BANK, non-standing (#801)", async () => {
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
			// The two halves of the new model, both asserted: the row is the CLUB's
			// (no template tag, so every history query joins straight through it),
			// and it is NOT part of the club's standard meeting shape.
			expect(rows.every((r) => r.templateId === null)).toBe(true);
			expect(rows.every((r) => r.standing === false)).toBe(true);
		});

		it("resolves an EXISTING bank role instead of minting a second one", async () => {
			// The reported bug, at its source. The club already runs a Timer; a
			// template that declares `timer` must attach to it, not fork it —
			// `role_slots.role_definition_id` is what every history query joins on.
			await testDb
				.update(roleDefinitions)
				.set({ key: "contest_chair" })
				.where(eq(roleDefinitions.id, club.roleDefinitionId));
			const before = await clubRoleDefs();
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const after = await clubRoleDefs();
			// One new row (`contestant_prepared`), not two: `contest_chair` resolved.
			expect(after).toHaveLength(before.length + 1);
			const kept = after.find((r) => r.key === "contest_chair");
			expect(kept?.id).toBe(club.roleDefinitionId);
			// And the club's own row keeps its name and its standing — resolving a
			// declaration onto it says nothing about the club's standard shape.
			expect(kept?.name).toBe("Timer");
			expect(kept?.standing).toBe(true);
		});

		it("is idempotent — a second materialize adds nothing", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			await materializeTemplateRoles(testDb, club.clubId, id);
			expect(await clubRoleDefs(id)).toHaveLength(2);
		});

		it("resolves TWO templates declaring the same key to ONE bank row", async () => {
			// The old model minted a row per (club, template), so a `judge` in two
			// shapes was two identities and a member's history split between them.
			// Identity is per (club, key) now, so the second template's resolve
			// finds the first's row.
			const a = await makeContestTemplate();
			const b = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, a);
			const first = await clubRoleDefs(a);
			await materializeTemplateRoles(testDb, club.clubId, b);
			const second = await clubRoleDefs(b);
			expect(second.map((r) => r.id).sort()).toEqual(
				first.map((r) => r.id).sort(),
			);
		});

		it("does NOT overwrite a club's rename on re-materialize", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			await testDb
				.update(roleDefinitions)
				.set({ name: "Contest Chairman", defaultCount: 6 })
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
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
		it("resolves the club's STANDING, ENABLED defs when the template is null", async () => {
			const defs = await resolveMeetingRoleDefs(testDb, club.clubId, null);
			const standard = await testDb
				.select()
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.standing, true),
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
		 * The inverse of the contract this pinned before #801, and the docblock on
		 * `resolveMeetingRoleDefs` says why the change is safe: it has exactly one
		 * non-test caller, already inside a transaction, and the conversion PREVIEW
		 * does not come here at all (it reads the template's own declarations
		 * through `resolveConversionTargetRoles`, which still writes nothing).
		 *
		 * Resolving to NOTHING was the alternative, and it is worse: a declaration
		 * the club has no bank row for would drop out of the meeting's shape
		 * silently. Minting mirrors what `materialiseForMeeting` already does for
		 * the same question — a row owned by nobody is what an unstaffed role
		 * already looks like.
		 */
		it("MINTS a bank row at standing=false for a declared key the club lacks", async () => {
			const id = await makeContestTemplate();
			expect(await clubRoleDefs(id)).toHaveLength(0);

			const defs = await resolveMeetingRoleDefs(testDb, club.clubId, id);
			expect(defs.map((d) => d.key).sort()).toEqual([
				"contest_chair",
				"contestant_prepared",
			]);
			const minted = await clubRoleDefs(id);
			expect(minted).toHaveLength(2);
			expect(minted.every((r) => r.standing === false)).toBe(true);
			// The declaration is the authority for a TEMPLATED meeting, so the rows
			// it hands back read standing/enabled true however the bank row is
			// flagged — that synthesis is what lets `generateSlotRows` stay a dumb
			// filter and still emit every Contestant slot.
			expect(defs.every((d) => d.standing === true)).toBe(true);
			expect(defs.every((d) => d.enabled === true)).toBe(true);
		});

		it("is idempotent — a second resolve mints nothing further", async () => {
			const id = await makeContestTemplate();
			await resolveMeetingRoleDefs(testDb, club.clubId, id);
			const first = await clubRoleDefs();
			await resolveMeetingRoleDefs(testDb, club.clubId, id);
			const second = await clubRoleDefs();
			expect(second.map((r) => r.id).sort()).toEqual(
				first.map((r) => r.id).sort(),
			);
		});

		it("resolves only the template's defs once materialized", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			expect(
				await resolveMeetingRoleDefs(testDb, club.clubId, id),
			).toHaveLength(2);
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
			const ids = (await clubRoleDefs(id)).map((r) => r.id);
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(inArray(roleDefinitions.id, ids));
			expect(
				await resolveMeetingRoleDefs(testDb, club.clubId, id),
			).toHaveLength(2);
		});
	});
	describe("listRoleDefinitions scoping", () => {
		/**
		 * The SEVENTH reader, and the one #801 turned inside out.
		 *
		 * `listRoleDefinitions` feeds `/admin/roles`, the public role sheet, and
		 * `loadMeetingDetail`'s "+ Add role" picker. It used to take a `templateId`
		 * because role identity was per (club, template): naming a template was the
		 * only way to see a contest's roles — and naming one made the club's own
		 * bank invisible, which is exactly how a meeting on a custom agenda ended
		 * up with no way to attach the club's Timer. There is ONE scope now, the
		 * club, and NO `standing` filter: a non-standing role has to be listable or
		 * it is unmanageable.
		 */
		it("lists the club's own roles AND the ones a contest brought in", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const rows = await listRoleDefinitions(club.clubId);
			const names = rows.map((r) => r.name);
			expect(names).toContain("Timer");
			expect(names).toContain("Contest Chair");
			expect(names).toContain("Contestant");
		});

		it("marks a contest-derived role as NOT standing, rather than hiding it", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const rows = await listRoleDefinitions(club.clubId);
			expect(rows.find((r) => r.name === "Contest Chair")?.standing).toBe(
				false,
			);
			expect(rows.find((r) => r.name === "Timer")?.standing).toBe(true);
		});

		it("still honours onlyEnabled", async () => {
			const id = await makeContestTemplate();
			await materializeTemplateRoles(testDb, club.clubId, id);
			const ids = (await clubRoleDefs(id)).map((r) => r.id);
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(inArray(roleDefinitions.id, ids));
			const names = (
				await listRoleDefinitions(club.clubId, { onlyEnabled: true })
			).map((r) => r.name);
			expect(names).not.toContain("Contest Chair");
			expect(names).toContain("Timer");
		});
	});
});
