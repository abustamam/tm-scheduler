/**
 * DB-backed parity between the offline projection and the real writes (#1638).
 *
 * protects=`projectSlots` shows what the server will show once the queued op
 *   drains: for claim, reassign and release, every field the projection writes
 *   (holder name / ids, guest flags, status, `claimedAt`, the speech block)
 *   equals what `claimSlotCore`, `reassignSlotCore` and `releaseSlotCore` leave
 *   behind, read back through `loadMeetingSlots`;
 * fails_when=the projection writes a status, id, name or null block the real
 *   write does not (or the reverse), e.g. a reassign stamping `claimedAt` or a
 *   release leaving the speech;
 * Release is compared with a speech on the slot (the real release clears it,
 * so a projection that kept it differs), and a guest-held slot is compared for
 * reassign and release.
 *
 * no_claim=fields the projection leaves alone (it must not touch them, and the
 *   comparison is on the ones it writes), and the holder contact block, which
 *   `loadMeetingSlots` does not carry.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guests, members, roleSlots, speeches } from "#/db/schema";
import type { RoleSlotOp } from "#/lib/offline-minutes-queue";
import { projectSlots } from "#/lib/project-slots";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { claimSlotCore, reassignSlotCore, releaseSlotCore } = await import(
	"#/server/slots-logic"
);
const { loadMeetingSlots } = await import("#/server/meeting-slots-logic");

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

/** What the projection writes, compared field by field. */
const WRITTEN = [
	"assigneeName",
	"assigneeId",
	"assigneeGuestId",
	"assigneeIsGuest",
	"assigneeIsVisitingToastmaster",
	"status",
	"claimedAt",
	"speechTitle",
	"pathwayPath",
	"projectName",
	"projectLevel",
	"projectId",
	"minMinutes",
	"maxMinutes",
	"presentationUrl",
] as const;

async function slotOf(s: SeededClub) {
	const all = await loadMeetingSlots(s.meetingId);
	const slot = all.find((x) => x.id === s.slotId);
	if (!slot) throw new Error("seeded slot not found");
	return slot;
}
const pick = (slot: Record<string, unknown>) =>
	Object.fromEntries(WRITTEN.map((k) => [k, slot[k] ?? null]));

const nameOf = async (id: string) =>
	(
		await testDb
			.select({ n: members.name })
			.from(members)
			.where(eq(members.id, id))
	)[0]?.n ?? "";

async function hold(s: SeededClub, memberId: string) {
	await testDb
		.update(roleSlots)
		.set({
			assignedMemberId: memberId,
			status: "claimed",
			claimedAt: new Date("2026-01-01T00:00:00Z"),
		})
		.where(eq(roleSlots.id, s.slotId));
}

const op = (s: SeededClub, over: Partial<RoleSlotOp>): RoleSlotOp =>
	({
		opId: "o1",
		queuedAt: Date.now(),
		slotId: s.slotId,
		roleName: "Timer",
		expectedHolder: null,
		expectedHolderName: null,
		...over,
	}) as RoleSlotOp;

describe.skipIf(!hasTestDb)(
	"projectSlots matches the real writes (#1638)",
	() => {
		it("claim of an open slot", async () => {
			const s = await seedClub();
			seeded = s;
			const before = await slotOf(s);
			const projected = projectSlots(
				[before],
				[
					op(s, {
						type: "assignSlot",
						memberId: s.memberId,
						memberDisplayName: await nameOf(s.memberId),
						actorMemberId: s.adminMemberId,
					}),
				],
			)[0];
			await testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: s.slotId,
					memberId: s.memberId,
					actorMemberId: s.adminMemberId,
				}),
			);
			const real = await slotOf(s);
			const { claimedAt: pc, ...p } = pick(projected);
			const { claimedAt: rc, ...r } = pick(real);
			expect(p).toEqual(r);
			// The stamp is the write's own clock: both are set, neither is the old null.
			expect(rc).toBeInstanceOf(Date);
			expect(pc).toBeInstanceOf(Date);
		});

		it("reassign of a held slot", async () => {
			const s = await seedClub();
			seeded = s;
			await hold(s, s.adminMemberId);
			const before = await slotOf(s);
			const projected = projectSlots(
				[before],
				[
					op(s, {
						type: "assignSlot",
						memberId: s.memberId,
						memberDisplayName: await nameOf(s.memberId),
						actorMemberId: null,
						expectedHolder: `m:${s.adminMemberId}`,
						expectedHolderName: before.assigneeName,
					}),
				],
			)[0];
			await testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: s.slotId,
					memberId: s.memberId,
					actorMemberId: s.adminMemberId,
				}),
			);
			expect(pick(projected)).toEqual(pick(await slotOf(s)));
		});

		it("release of a held slot that carries a speech", async () => {
			const s = await seedClub();
			seeded = s;
			await hold(s, s.memberId);
			const [speech] = await testDb
				.insert(speeches)
				.values({
					personId: s.personId,
					title: "Parity speech",
					pathwayPath: "Presentation Mastery",
					projectName: "Ice Breaker",
					projectLevel: "1",
					minMinutes: 4,
					maxMinutes: 6,
					presentationUrl: "https://example.com/deck",
				})
				.returning({ id: speeches.id });
			await testDb
				.update(roleSlots)
				.set({ speechId: speech!.id })
				.where(eq(roleSlots.id, s.slotId));
			const before = await slotOf(s);
			// The speech is really on the slot, so the comparison below can fail.
			expect(before.speechTitle).toBe("Parity speech");
			const projected = projectSlots(
				[before],
				[
					op(s, {
						type: "releaseSlot",
						expectedHolder: `m:${s.memberId}`,
						expectedHolderName: before.assigneeName,
					}),
				],
			)[0];
			await testDb.transaction((tx) =>
				releaseSlotCore(tx, {
					slotId: s.slotId,
					actorMemberId: s.adminMemberId,
				}),
			);
			expect(pick(projected)).toEqual(pick(await slotOf(s)));
		});

		async function holdByGuest(s: SeededClub) {
			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: s.clubId, name: "Parity Guest" },
						testDb,
					),
				)
				.returning({ id: guests.id });
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: g!.id,
					status: "claimed",
					claimedAt: new Date("2026-01-01T00:00:00Z"),
				})
				.where(eq(roleSlots.id, s.slotId));
			return g!.id;
		}

		it("reassign of a guest-held slot", async () => {
			const s = await seedClub();
			seeded = s;
			const guestId = await holdByGuest(s);
			const before = await slotOf(s);
			expect(before.assigneeGuestId).toBe(guestId);
			const projected = projectSlots(
				[before],
				[
					op(s, {
						type: "assignSlot",
						memberId: s.memberId,
						memberDisplayName: await nameOf(s.memberId),
						actorMemberId: null,
						expectedHolder: `g:${guestId}`,
						expectedHolderName: before.assigneeName,
					}),
				],
			)[0];
			await testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: s.slotId,
					memberId: s.memberId,
					actorMemberId: s.adminMemberId,
				}),
			);
			expect(pick(projected)).toEqual(pick(await slotOf(s)));
		});

		it("release of a guest-held slot", async () => {
			const s = await seedClub();
			seeded = s;
			const guestId = await holdByGuest(s);
			const before = await slotOf(s);
			const projected = projectSlots(
				[before],
				[
					op(s, {
						type: "releaseSlot",
						expectedHolder: `g:${guestId}`,
						expectedHolderName: before.assigneeName,
					}),
				],
			)[0];
			await testDb.transaction((tx) =>
				releaseSlotCore(tx, {
					slotId: s.slotId,
					actorMemberId: s.adminMemberId,
				}),
			);
			expect(pick(projected)).toEqual(pick(await slotOf(s)));
		});
	},
);
