/**
 * DB-backed tests for the VPE/admin role-template management logic
 * (create / edit / reorder / delete). Tests the plain `applyX` / `listX` fns
 * directly (the createServerFn wrappers need the Start runtime); `#/db` is
 * redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/role-definitions.integration.test.ts
 */
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, roleDefinitions, roleSlots } from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyRoleDefinitionCreate,
	applyRoleDefinitionUpdate,
	applyRoleDefinitionReorder,
	applyRoleDefinitionDelete,
	applyRoleDefinitionSetEnabled,
	listRoleDefinitions,
} = await import("./role-definitions-logic");

/** Slot rows for a role, across every meeting. */
async function roleSlotRows(roleDefinitionId: string) {
	return testDb
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(eq(roleSlots.roleDefinitionId, roleDefinitionId));
}

/** Activity-log rows for a club — the seed writes none, so any row here came
 *  from the action under test. */
async function activityRows(clubId: string) {
	return testDb
		.select({ id: activityLog.id })
		.from(activityLog)
		.where(eq(activityLog.clubId, clubId));
}

async function orderedRoles(clubId: string) {
	return testDb
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			sortOrder: roleDefinitions.sortOrder,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId))
		.orderBy(asc(roleDefinitions.sortOrder));
}

describe.skipIf(!hasTestDb)("role-definition management", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("createRole appends a custom role after the seeded one (sortOrder = max+1)", async () => {
		const before = await orderedRoles(seed.clubId);
		const maxBefore = Math.max(...before.map((r) => r.sortOrder));

		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Ah-Counter",
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
			description: "Tracks filler words.",
		});

		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(row.name).toBe("Ah-Counter");
		expect(row.description).toBe("Tracks filler words.");
		expect(row.sortOrder).toBe(maxBefore + 1);
	});

	it("createRole collapses an empty description to null", async () => {
		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Grammarian",
			category: "functionary",
			defaultCount: 1,
			description: "   ",
		});
		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(row.description).toBeNull();
		// defaults to non-speaker when the flag is omitted
		expect(row.isSpeakerRole).toBe(false);
	});

	it("updateRole edits description + fields; new defaultCount only affects future meetings", async () => {
		// Seeded role "Timer" already has one existing slot (seed.slotId).
		await applyRoleDefinitionUpdate({
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			name: "Timer",
			category: "functionary",
			defaultCount: 3,
			isSpeakerRole: false,
			description: "Times each speaker and signals with lights.",
		});

		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(row.description).toBe("Times each speaker and signals with lights.");
		expect(row.defaultCount).toBe(3);

		// Existing meeting's slots are unchanged (still the single seeded slot).
		const existingSlots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(existingSlots.length).toBe(1);

		// A FUTURE meeting generated from the template would now get 3 Timer slots.
		const defs = await testDb
			.select({
				id: roleDefinitions.id,
				defaultCount: roleDefinitions.defaultCount,
				enabled: roleDefinitions.enabled,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		const rows = generateSlotRows(defs, "00000000-0000-0000-0000-000000000000");
		expect(rows.length).toBe(3);
	});

	it("listRoleDefinitions returns roles ordered by sortOrder with a slotCount", async () => {
		await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 2,
			isSpeakerRole: true,
		});
		const list = await listRoleDefinitions(seed.clubId);
		expect(list.length).toBe(2);
		// Seeded Timer (with a slot) first, then the new Speaker (no slots).
		expect(list[0].name).toBe("Timer");
		expect(list[0].slotCount).toBe(1);
		const speaker = list.find((r) => r.name === "Speaker");
		expect(speaker?.slotCount).toBe(0);
		expect(speaker?.isSpeakerRole).toBe(true);
		// Ordered ascending by sortOrder.
		expect(list[0].sortOrder).toBeLessThan(list[1].sortOrder);
	});

	/**
	 * Speaker and its paired Evaluator cannot be disabled (#512).
	 *
	 * Not a preference — disabling Speaker sends `removeOpenRoleSlots` to delete
	 * every open speaker slot for that one role, touching no other, so each
	 * evaluator linked to one has its `evaluates_slot_id` nulled by the FK and is
	 * left evaluating nobody. That is the orphaning `applyRemoveSpeakerSlot` was
	 * just fixed for, reached by a different path. The rest of the app already
	 * fences this pair off from generic controls (`applyAddRoleSlot` /
	 * `applyRemoveRoleSlot` both refuse them); this toggle was the last way in.
	 */
	describe("the Speaker/Evaluator pair cannot be disabled (#512)", () => {
		async function seedPair() {
			const speaker = await applyRoleDefinitionCreate({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				defaultCount: 2,
				isSpeakerRole: true,
			});
			const evaluator = await applyRoleDefinitionCreate({
				clubId: seed.clubId,
				name: "Evaluator",
				category: "evaluator",
				defaultCount: 2,
			});
			return { speaker, evaluator };
		}

		it("refuses to disable the Speaker role", async () => {
			const { speaker } = await seedPair();
			await expect(
				applyRoleDefinitionSetEnabled({
					actorMemberId: null,
					clubId: seed.clubId,
					roleId: speaker.id,
					enabled: false,
				}),
			).rejects.toThrow(/can't be disabled/);
			// And the flag really is untouched — a thrown error that still wrote
			// would be the worst outcome.
			const [row] = await testDb
				.select({ enabled: roleDefinitions.enabled })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, speaker.id));
			expect(row.enabled).toBe(true);
		});

		it("refuses to disable the paired Evaluator role", async () => {
			const { evaluator } = await seedPair();
			await expect(
				applyRoleDefinitionSetEnabled({
					actorMemberId: null,
					clubId: seed.clubId,
					roleId: evaluator.id,
					enabled: false,
				}),
			).rejects.toThrow(/can't be disabled/);
		});

		it("still allows disabling an ordinary role", async () => {
			await seedPair();
			const other = await applyRoleDefinitionCreate({
				clubId: seed.clubId,
				name: "Ah-Counter",
				category: "functionary",
				defaultCount: 1,
			});
			await applyRoleDefinitionSetEnabled({
				actorMemberId: null,
				clubId: seed.clubId,
				roleId: other.id,
				enabled: false,
			});
			const [row] = await testDb
				.select({ enabled: roleDefinitions.enabled })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, other.id));
			expect(row.enabled).toBe(false);
		});

		/**
		 * The guard is DISABLE-only. A club that turned one of these off before
		 * this existed must be able to put it back, or the protection becomes a
		 * trap rather than a guard.
		 */
		it("still allows RE-enabling a paired role that is already off", async () => {
			const { speaker } = await seedPair();
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(eq(roleDefinitions.id, speaker.id));

			await applyRoleDefinitionSetEnabled({
				actorMemberId: null,
				clubId: seed.clubId,
				roleId: speaker.id,
				enabled: true,
			});
			const [row] = await testDb
				.select({ enabled: roleDefinitions.enabled })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.id, speaker.id));
			expect(row.enabled).toBe(true);
		});
	});

	it("reorderRoles rewrites sortOrder to match the given order", async () => {
		const a = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Alpha",
			category: "functionary",
			defaultCount: 1,
		});
		const b = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Beta",
			category: "functionary",
			defaultCount: 1,
		});

		// Reverse order: Beta, Alpha, Timer.
		await applyRoleDefinitionReorder({
			clubId: seed.clubId,
			orderedIds: [b.id, a.id, seed.roleDefinitionId],
		});

		const ordered = await orderedRoles(seed.clubId);
		expect(ordered.map((r) => r.id)).toEqual([
			b.id,
			a.id,
			seed.roleDefinitionId,
		]);
		expect(ordered.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
	});

	it("reorderRoles rejects a stale id set (missing/extra ids)", async () => {
		await expect(
			applyRoleDefinitionReorder({
				clubId: seed.clubId,
				// Missing the seeded role; wrong set.
				orderedIds: ["00000000-0000-0000-0000-000000000001"],
			}),
		).rejects.toThrow();
	});

	it("deleteRole removes an unreferenced custom role", async () => {
		const { id } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Disposable",
			category: "functionary",
			defaultCount: 1,
		});
		await applyRoleDefinitionDelete({ clubId: seed.clubId, roleId: id });
		const rows = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, id));
		expect(rows.length).toBe(0);
	});

	it("deleteRole blocks a role referenced by existing slots (no cascade)", async () => {
		// Seeded Timer role is referenced by seed.slotId.
		await expect(
			applyRoleDefinitionDelete({
				clubId: seed.clubId,
				roleId: seed.roleDefinitionId,
			}),
		).rejects.toThrow(/existing meetings/);
		// The message points admins at disabling instead of the old
		// "set default count to 0" workaround the toggle now replaces (#368).
		await expect(
			applyRoleDefinitionDelete({
				clubId: seed.clubId,
				roleId: seed.roleDefinitionId,
			}),
		).rejects.toThrow(/disable/i);

		// The role and its slot are both still present (history preserved).
		const [role] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(role).toBeTruthy();
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot).toBeTruthy();
	});

	it("listRoleDefinitions includes the enabled flag", async () => {
		const list = await listRoleDefinitions(seed.clubId);
		expect(list[0].enabled).toBe(true);
	});

	it("listRoleDefinitions({ onlyEnabled: true }) excludes a disabled role", async () => {
		const { id: disabledId } = await applyRoleDefinitionCreate({
			clubId: seed.clubId,
			name: "Ah-Counter",
			category: "functionary",
			defaultCount: 1,
		});
		await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: disabledId,
			enabled: false,
		});

		const all = await listRoleDefinitions(seed.clubId);
		expect(all.map((r) => r.id)).toContain(disabledId);

		const onlyEnabled = await listRoleDefinitions(seed.clubId, {
			onlyEnabled: true,
		});
		expect(onlyEnabled.map((r) => r.id)).not.toContain(disabledId);
		// The seeded (enabled) Timer role still shows up.
		expect(onlyEnabled.map((r) => r.id)).toContain(seed.roleDefinitionId);
	});

	// `applyRoleDefinitionUpdate` (the plain field-edit "Save" path) never
	// accepts `enabled` at all — enforced by `UpdateRoleInput` not having the
	// field, so this is now a compile-time guarantee, not just a runtime one.
	// Toggling goes through the narrow `applyRoleDefinitionSetEnabled` instead
	// (#368 review: a whole-row toggle risked discarding unsaved edits in the
	// same card / last-write-wins against a concurrent admin).
	it("updateRole never touches enabled, even across repeated saves", async () => {
		await applyRoleDefinitionUpdate({
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			name: "Timer",
			category: "functionary",
			defaultCount: 1,
			description: "Updated description only.",
		});
		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(row.enabled).toBe(true);
		// No slot side effects — the seeded (open, unclaimed) slot is untouched.
		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(slots).toHaveLength(1);
	});

	it("setRoleEnabled(false) removes the role's open future slots and reports 0 kept", async () => {
		// Seeded Timer role has one open, unclaimed slot on a future meeting.
		const result = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		expect(result.keptClaimedMeetings).toBe(0);
		expect(result.meetingsChanged).toBe(1);

		const [row] = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(row.enabled).toBe(false);

		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(slots).toHaveLength(0);
	});

	it("setRoleEnabled(false) keeps a claimed slot and reports it", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: seed.memberId })
			.where(eq(roleSlots.id, seed.slotId));

		const result = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		expect(result.keptClaimedMeetings).toBe(1);

		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(slots).toHaveLength(1);
		expect(slots[0].id).toBe(seed.slotId);
	});

	it("setRoleEnabled(true) backfills an open slot on future meetings with none", async () => {
		// Disable first (removes the seeded open slot), then re-enable.
		await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		const result = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: true,
		});
		expect(result.keptClaimedMeetings).toBe(0);
		expect(result.meetingsChanged).toBe(1);

		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(slots).toHaveLength(1);
	});

	// Setting the flag to the value it already holds is a RECONCILE, not an
	// early-returning no-op (#368): when the slots already agree with the flag it
	// changes nothing and logs nothing, which is what this pins. What it must
	// NOT do is short-circuit — see the convergence test below.
	it("setRoleEnabled to its current value changes no slots and logs nothing", async () => {
		const result = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: true,
		});
		expect(result.keptClaimedMeetings).toBe(0);
		expect(result.meetingsChanged).toBe(0);
		const slots = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.roleDefinitionId, seed.roleDefinitionId));
		expect(slots).toHaveLength(1);
		expect(await activityRows(seed.clubId)).toHaveLength(0);
	});

	// Regression (#368): the flag UPDATE and the slot sync are separate
	// statements. If the sync throws (a deadlock against the public, no-auth
	// `claimSlot`, a connection blip, a large `meetingIds` set) the flag is
	// persisted and the slots are not. The old `current.enabled === input.enabled`
	// early return then made retrying the same disable do NOTHING, so the admin
	// UI showed the role Disabled while every future meeting still carried its
	// open slot — still printed on the agenda, still claimable on the public
	// sign-up sheet. The only escape was Enable → Disable.
	it("re-running the same disable after a failed slot sync converges", async () => {
		// Exactly the state a half-applied disable leaves behind: flag written
		// straight to the db (as the committed UPDATE would have), slot untouched
		// (as the sync that threw would have left it).
		await testDb
			.update(roleDefinitions)
			.set({ enabled: false })
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(1);

		// Retrying the identical action repairs it, and says so.
		const repair = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		expect(repair.meetingsChanged).toBe(1);
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(0);

		// …and it has converged: a third run is a clean no-op.
		const again = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		expect(again.meetingsChanged).toBe(0);
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(0);
	});

	// The mirror case: a half-applied ENABLE leaves the flag on with no slots
	// backfilled, and the same retry has to fill them in.
	it("re-running the same enable after a failed slot sync converges", async () => {
		// Disable cleanly first (removes the seeded open slot), then simulate the
		// enable whose flag committed but whose backfill never ran.
		await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: false,
		});
		await testDb
			.update(roleDefinitions)
			.set({ enabled: true })
			.where(eq(roleDefinitions.id, seed.roleDefinitionId));
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(0);

		const repair = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: true,
		});
		expect(repair.meetingsChanged).toBe(1);
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(1);

		const again = await applyRoleDefinitionSetEnabled({
			actorMemberId: null,
			clubId: seed.clubId,
			roleId: seed.roleDefinitionId,
			enabled: true,
		});
		expect(again.meetingsChanged).toBe(0);
		expect(await roleSlotRows(seed.roleDefinitionId)).toHaveLength(1);
	});

	it("setRoleEnabled rejects a role from a different club", async () => {
		const other = await seedClub();
		try {
			await expect(
				applyRoleDefinitionSetEnabled({
					actorMemberId: null,
					clubId: seed.clubId,
					roleId: other.roleDefinitionId,
					enabled: false,
				}),
			).rejects.toThrow(/not found/i);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});
