/**
 * DB-backed tests for adding/removing arbitrary roles on a meeting and syncing
 * the template onto upcoming meetings (#143). Tests the plain logic fns directly
 * (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyRemoveRoleSlot,
	applyTemplateSyncToUpcomingMeetings,
	syncSlotsForRoleEnabledChange,
} = await import("./slots-logic");

/** Insert a role definition on the seeded club; return its id. */
async function addRole(
	clubId: string,
	o: {
		name: string;
		category?: "leadership" | "speaker" | "evaluator" | "functionary";
		defaultCount?: number;
		sortOrder?: number;
		isSpeakerRole?: boolean;
		enabled?: boolean;
	},
): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: o.name,
			category: o.category ?? "functionary",
			defaultCount: o.defaultCount ?? 1,
			sortOrder: o.sortOrder ?? 50,
			isSpeakerRole: o.isSpeakerRole ?? false,
			enabled: o.enabled ?? true,
		})
		.returning({ id: roleDefinitions.id });
	return row.id;
}

async function slotsFor(meetingId: string, roleId: string) {
	return testDb
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
}

describe.skipIf(!hasTestDb)("meeting role management (#143)", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("applyAddRoleSlot adds an open slot", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, roleId)).toHaveLength(1);
	});

	it("applyAddRoleSlot allows a duplicate at the next slotIndex", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await slotsFor(club.meetingId, roleId);
		expect(rows.map((r) => r.slotIndex)).toEqual([0, 1]);
	});

	it("applyAddRoleSlot rejects a role from a different club", async () => {
		const other = await seedClub();
		try {
			await expect(
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: other.roleDefinitionId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(/not found for this club/i);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("applyAddRoleSlot rejects the speaker role", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: spk,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker controls/i);
	});

	// #369 review item 3: the "+ Add role" picker already excludes disabled
	// roles from its data, but a stale tab (the picker payload is baked into
	// the meeting page at load) could still post one — the server must reject
	// it independently, like it already does for cross-club and paired roles.
	it("applyAddRoleSlot rejects a disabled role", async () => {
		const disabled = await addRole(club.clubId, {
			name: "Ah-Counter",
			sortOrder: 12,
			enabled: false,
		});
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: disabled,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/disabled/i);
		expect(await slotsFor(club.meetingId, disabled)).toHaveLength(0);
	});

	it("applyRemoveRoleSlot deletes an unclaimed slot", async () => {
		// The seeded club already has one open Timer slot on the meeting.
		await applyRemoveRoleSlot({
			slotId: club.slotId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, club.roleDefinitionId)).toHaveLength(
			0,
		);
	});

	it("applyRemoveRoleSlot rejects a claimed slot", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, club.slotId));
		await expect(
			applyRemoveRoleSlot({
				slotId: club.slotId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/release the role/i);
	});

	it("applyRemoveRoleSlot rejects the paired evaluator", async () => {
		await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		const evId = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
		});
		const [evSlot] = await testDb
			.insert(roleSlots)
			.values({ meetingId: club.meetingId, roleDefinitionId: evId })
			.returning({ id: roleSlots.id });
		await expect(
			applyRemoveRoleSlot({
				slotId: evSlot.id,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker controls/i);
	});

	// #369 review item 2: `addSpeakerSlot` is reachable from a PUBLIC, no-session
	// path (a self-asserted TMOD — see `requireMeetingAgendaEditor`), so it's
	// the one place a disabled role could otherwise get a fresh, claimable slot
	// even after the roles-admin toggle already cleared its old ones.
	it("applyAddSpeakerSlot rejects when the club's Speaker role is disabled", async () => {
		await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
			enabled: false,
		});
		await expect(
			applyAddSpeakerSlot({
				meetingId: club.meetingId,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker role is currently disabled/i);
	});

	it("applyAddSpeakerSlot adds only the speaker slot when the paired evaluator is disabled", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		const ev = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
			enabled: false,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, spk)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, ev)).toHaveLength(0);
	});

	it("applyAddSpeakerSlot adds both when speaker and evaluator are enabled", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		const ev = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
		});
		await applyAddSpeakerSlot({
			meetingId: club.meetingId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, spk)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, ev)).toHaveLength(1);
	});

	it("sync adds a missing standard role to upcoming meetings", async () => {
		const vc = await addRole(club.clubId, {
			name: "Vote Counter",
			sortOrder: 60,
		});
		const res = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.meetingsChanged).toBe(1);
		expect(res.rolesAdded).toEqual(["Vote Counter"]);
		expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
	});

	it("sync skips roles already present (idempotent)", async () => {
		// Timer (the seeded role) is already on the meeting.
		const first = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(first.meetingsChanged).toBe(0);
		// Adding then re-running adds it once, and a second run is a no-op.
		await addRole(club.clubId, { name: "Vote Counter", sortOrder: 60 });
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		const again = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(again.meetingsChanged).toBe(0);
	});

	it("sync skips defaultCount 0 roles", async () => {
		const joke = await addRole(club.clubId, {
			name: "Jokemaster",
			defaultCount: 0,
			sortOrder: 61,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, joke)).toHaveLength(0);
	});

	it("sync never adds speakers or the paired evaluator", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			defaultCount: 2,
			sortOrder: 10,
		});
		const ev = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 2,
			sortOrder: 11,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, spk)).toHaveLength(0);
		expect(await slotsFor(club.meetingId, ev)).toHaveLength(0);
	});

	it("sync leaves past meetings untouched", async () => {
		const [past] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const vc = await addRole(club.clubId, {
			name: "Vote Counter",
			sortOrder: 60,
		});
		await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(past.id, vc)).toHaveLength(0);
		// sanity: the upcoming meeting DID get it
		expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
	});

	it("sync never tops up an existing role toward defaultCount", async () => {
		// A standard role that wants 2 but the meeting already has 1 → presence-
		// based sync leaves it at 1 (a naive count-based top-up would add a 2nd).
		const greeter = await addRole(club.clubId, {
			name: "Greeter",
			defaultCount: 2,
			sortOrder: 62,
		});
		await testDb
			.insert(roleSlots)
			.values({ meetingId: club.meetingId, roleDefinitionId: greeter });
		const res = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.meetingsChanged).toBe(0);
		expect(await slotsFor(club.meetingId, greeter)).toHaveLength(1);
	});

	// Regression (#369): `applyTemplateSyncToUpcomingMeetings` didn't know about
	// `enabled` — a club that disabled Ah-Counter and then clicked "Update
	// upcoming meetings to match" would get Ah-Counter re-added everywhere.
	it("sync never re-adds a role that's been disabled", async () => {
		const ahCounter = await addRole(club.clubId, {
			name: "Ah-Counter",
			sortOrder: 63,
			enabled: false,
		});
		const res = await applyTemplateSyncToUpcomingMeetings({
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
		});
		expect(res.meetingsChanged).toBe(0);
		expect(res.rolesAdded).toEqual([]);
		expect(await slotsFor(club.meetingId, ahCounter)).toHaveLength(0);
	});
});

describe.skipIf(!hasTestDb)("role enable/disable slot sync (#369)", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("disabling removes an open, unclaimed future slot for that role", async () => {
		// Seeded club already has one open, unclaimed Timer slot on a future meeting.
		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(0);
		expect(await slotsFor(club.meetingId, club.roleDefinitionId)).toHaveLength(
			0,
		);
	});

	it("disabling never deletes a claimed slot, and reports the meeting that kept it", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, club.slotId));

		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(1);
		// The claimed slot survives, untouched.
		const [slot] = await slotsFor(club.meetingId, club.roleDefinitionId);
		expect(slot?.id).toBe(club.slotId);
	});

	it("disabling removes only the unclaimed slots on a meeting that has both", async () => {
		// A second, unclaimed Timer slot alongside the already-seeded (open)
		// one — same meeting, same role.
		const [extra] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: club.roleDefinitionId,
				slotIndex: 1,
			})
			.returning({ id: roleSlots.id });
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, club.slotId));

		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 2,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(1);
		const remaining = await slotsFor(club.meetingId, club.roleDefinitionId);
		expect(remaining.map((s) => s.id)).toEqual([club.slotId]);
		expect(remaining.map((s) => s.id)).not.toContain(extra.id);
	});

	it("disabling never touches a past meeting's slots", async () => {
		const [past] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		await testDb.insert(roleSlots).values({
			meetingId: past.id,
			roleDefinitionId: club.roleDefinitionId,
		});

		await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(past.id, club.roleDefinitionId)).toHaveLength(1);
	});

	it("disabling never touches a cancelled meeting's slots", async () => {
		const [cancelled] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "cancelled",
			})
			.returning({ id: meetings.id });
		await testDb.insert(roleSlots).values({
			meetingId: cancelled.id,
			roleDefinitionId: club.roleDefinitionId,
		});

		await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(cancelled.id, club.roleDefinitionId)).toHaveLength(1);
	});

	it("enabling backfills one open slot onto a future, non-cancelled meeting with none", async () => {
		const grammarian = await addRole(club.clubId, {
			name: "Grammarian",
			sortOrder: 64,
			enabled: false,
		});
		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: grammarian,
			roleName: "Grammarian",
			defaultCount: 1,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(0);
		expect(await slotsFor(club.meetingId, grammarian)).toHaveLength(1);
	});

	it("enabling never touches past or cancelled meetings", async () => {
		const [past] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const [cancelled] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "cancelled",
			})
			.returning({ id: meetings.id });
		const grammarian = await addRole(club.clubId, {
			name: "Grammarian",
			sortOrder: 65,
			enabled: false,
		});

		await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: grammarian,
			roleName: "Grammarian",
			defaultCount: 1,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(past.id, grammarian)).toHaveLength(0);
		expect(await slotsFor(cancelled.id, grammarian)).toHaveLength(0);
		expect(await slotsFor(club.meetingId, grammarian)).toHaveLength(1);
	});

	it("enabling with defaultCount 0 backfills nothing", async () => {
		const joke = await addRole(club.clubId, {
			name: "Jokemaster",
			defaultCount: 0,
			sortOrder: 66,
			enabled: false,
		});
		await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: joke,
			roleName: "Jokemaster",
			defaultCount: 0,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, joke)).toHaveLength(0);
	});

	it("enabling is idempotent — a meeting that already has the role's slot is untouched", async () => {
		// Timer already has its seeded slot on the meeting; "enabling" it (already
		// enabled in practice, but exercising the backfill path directly) must not
		// add a second one.
		await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, club.roleDefinitionId)).toHaveLength(
			1,
		);
	});

	// #369 review item 4: the enable-toggle backfill must never add a bare
	// Speaker slot with no paired Evaluator (or vice versa) — that parity is
	// owned exclusively by the +/- speaker controls. Mirrors
	// `applyTemplateSyncToUpcomingMeetings`'s own paired-role exclusion.
	it("enabling the Speaker role never backfills a bare speaker slot", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
			enabled: false,
		});
		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: spk,
			roleName: "Speaker",
			defaultCount: 1,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(result.meetingsChanged).toBe(0);
		expect(await slotsFor(club.meetingId, spk)).toHaveLength(0);
	});

	it("enabling the paired Evaluator role never backfills it standalone", async () => {
		await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		const ev = await addRole(club.clubId, {
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
			enabled: false,
		});
		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: ev,
			roleName: "Evaluator",
			defaultCount: 3,
			enabled: true,
			actorMemberId: club.adminMemberId,
		});
		expect(result.meetingsChanged).toBe(0);
		expect(await slotsFor(club.meetingId, ev)).toHaveLength(0);
	});

	// #369 review item 10: a second-club fixture, same shape as
	// "applyAddRoleSlot rejects a role from a different club" above — proves
	// the bulk delete is scoped by roleDefinitionId + the club's own meetings,
	// not just by role name (both clubs seed a role called "Timer").
	it("disabling one club's role never touches another club's identically-named role", async () => {
		const other = await seedClub();
		try {
			const result = await syncSlotsForRoleEnabledChange({
				clubId: club.clubId,
				roleDefinitionId: club.roleDefinitionId,
				roleName: "Timer",
				defaultCount: 1,
				enabled: false,
				actorMemberId: club.adminMemberId,
			});
			expect(result.keptClaimedMeetings).toBe(0);
			expect(
				await slotsFor(club.meetingId, club.roleDefinitionId),
			).toHaveLength(0);
			// The other club's own "Timer" slot survives untouched.
			expect(
				await slotsFor(other.meetingId, other.roleDefinitionId),
			).toHaveLength(1);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	// #369 review item 10: distinguishes "count of meetings" from "count of
	// slots" — two separate future meetings each with one claimed slot must
	// report keptClaimedMeetings = 2, not some other tally an implementation
	// that doesn't dedupe by meeting id could produce.
	it("keptClaimedMeetings counts distinct meetings across two separate claimed slots", async () => {
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: club.memberId })
			.where(eq(roleSlots.id, club.slotId));
		const [meeting2] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		await testDb.insert(roleSlots).values({
			meetingId: meeting2.id,
			roleDefinitionId: club.roleDefinitionId,
			status: "claimed",
			assignedMemberId: club.memberId,
		});

		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(2);
	});

	// #369 review item 1 (TOCTOU): the "claimed" predicate is defined by
	// assignedMemberId/assignedGuestId, not the `status` column — a slot that
	// somehow carries an assignee without `status: "claimed"` must still
	// survive, since the atomic DELETE checks the assignee columns directly.
	it("a slot with an assignee but stale status is still treated as claimed", async () => {
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: club.memberId }) // status left at default "open"
			.where(eq(roleSlots.id, club.slotId));

		const result = await syncSlotsForRoleEnabledChange({
			clubId: club.clubId,
			roleDefinitionId: club.roleDefinitionId,
			roleName: "Timer",
			defaultCount: 1,
			enabled: false,
			actorMemberId: club.adminMemberId,
		});
		expect(result.keptClaimedMeetings).toBe(1);
		expect(await slotsFor(club.meetingId, club.roleDefinitionId)).toHaveLength(
			1,
		);
	});
});
