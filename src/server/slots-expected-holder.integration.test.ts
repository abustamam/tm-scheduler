/**
 * DB-backed tests for `applyRoleOpExpectingHolder` (#1638): the decision a
 * queued role write meets when it drains against whoever holds the slot NOW.
 *
 * protects=the drain table (expected holder vs real holder) and the gate order:
 *   archive, meeting status and the claim actor gates all run BEFORE the
 *   already-applied shortcut;
 * fails_when=a gate is moved after the comparison, the comparison drops a
 *   guest holder, or slot-gone is thrown instead of answered;
 * no_claim=the plain claim / reassign / release cores (their own suites).
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, guests, meetings, roleSlots } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	MEETING_CANCELLED_MESSAGE,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyRoleOpExpectingHolder } = await import("#/server/slots-logic");

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

async function seedLiveClub(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	return s;
}

type Args = Parameters<typeof applyRoleOpExpectingHolder>[1];
const run = (args: Args) =>
	testDb.transaction((tx) => applyRoleOpExpectingHolder(tx, args));

const holder = async (slotId: string) =>
	(
		await testDb
			.select({
				m: roleSlots.assignedMemberId,
				g: roleSlots.assignedGuestId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
	)[0];

const setHolder = (slotId: string, memberId: string | null) =>
	testDb
		.update(roleSlots)
		.set({
			assignedMemberId: memberId,
			status: memberId ? "claimed" : "open",
		})
		.where(eq(roleSlots.id, slotId));

describe.skipIf(!hasTestDb)("applyRoleOpExpectingHolder (#1638)", () => {
	it("claim, expected open, slot open: applies", async () => {
		const s = await seedLiveClub();
		const r = await run({
			kind: "claim",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: null,
		});
		expect(r).toEqual({ ok: true });
		expect((await holder(s.slotId))?.m).toBe(s.memberId);
	});

	it("claim, expected open, but someone else took it: skipped, names the holder, writes nothing", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.adminMemberId);
		const r = await run({
			kind: "claim",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: null,
		});
		expect(r).toMatchObject({
			ok: false,
			reason: "holder-changed",
			currentHolderName: expect.any(String),
		});
		expect((await holder(s.slotId))?.m).toBe(s.adminMemberId);
	});

	it("claim replayed after its first attempt committed: ok, already applied", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.memberId);
		const r = await run({
			kind: "claim",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: null,
		});
		expect(r).toEqual({ ok: true });
		expect((await holder(s.slotId))?.m).toBe(s.memberId);
	});

	it("reassign off the holder the officer saw: applies", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.adminMemberId);
		const r = await run({
			kind: "reassign",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: `m:${s.adminMemberId}`,
		});
		expect(r).toEqual({ ok: true });
		expect((await holder(s.slotId))?.m).toBe(s.memberId);
	});

	it("reassign when the holder is no longer the one seen: skipped", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, null);
		const r = await run({
			kind: "reassign",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: `m:${s.adminMemberId}`,
		});
		expect(r).toEqual({
			ok: false,
			reason: "holder-changed",
			currentHolderName: null,
		});
		expect((await holder(s.slotId))?.m).toBeNull();
	});

	it("release of the seen holder applies; of an already-open slot is ok", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.memberId);
		expect(
			await run({
				kind: "release",
				slotId: s.slotId,
				actorMemberId: s.adminMemberId,
				expectedHolder: `m:${s.memberId}`,
			}),
		).toEqual({ ok: true });
		expect((await holder(s.slotId))?.status).toBe("open");
		expect(
			await run({
				kind: "release",
				slotId: s.slotId,
				actorMemberId: s.adminMemberId,
				expectedHolder: `m:${s.memberId}`,
			}),
		).toEqual({ ok: true });
	});

	it("release when someone else now holds the slot: skipped, they keep it", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.adminMemberId);
		const r = await run({
			kind: "release",
			slotId: s.slotId,
			actorMemberId: s.adminMemberId,
			expectedHolder: `m:${s.memberId}`,
		});
		expect(r).toMatchObject({ ok: false, reason: "holder-changed" });
		expect((await holder(s.slotId))?.m).toBe(s.adminMemberId);
	});

	it("a guest holder compares as g:<id>, and a release of it applies", async () => {
		const s = await seedLiveClub();
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: s.clubId, name: "Offline Guest" },
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
			})
			.where(eq(roleSlots.id, s.slotId));

		// A member key does not match the guest holder.
		const wrong = await run({
			kind: "release",
			slotId: s.slotId,
			actorMemberId: s.adminMemberId,
			expectedHolder: `m:${s.memberId}`,
		});
		expect(wrong).toEqual({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Offline Guest",
		});
		const right = await run({
			kind: "release",
			slotId: s.slotId,
			actorMemberId: s.adminMemberId,
			expectedHolder: `g:${g!.id}`,
		});
		expect(right).toEqual({ ok: true });
		expect((await holder(s.slotId))?.g).toBeNull();
	});

	it("a missing slot answers slot-gone and does not throw", async () => {
		await seedLiveClub();
		const r = await run({
			kind: "release",
			slotId: "00000000-0000-4000-8000-000000000000",
			actorMemberId: null,
			expectedHolder: null,
		});
		expect(r).toEqual({
			ok: false,
			reason: "slot-gone",
			currentHolderName: null,
		});
	});

	it("an archived club refuses BEFORE the comparison, even for an already-applied op", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.memberId);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		await expect(
			run({
				kind: "claim",
				slotId: s.slotId,
				memberId: s.memberId,
				actorMemberId: s.adminMemberId,
				expectedHolder: null,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("a completed meeting refuses BEFORE the comparison, even for an already-applied op", async () => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, s.memberId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, s.meetingId));
		await expect(
			run({
				kind: "release",
				slotId: s.slotId,
				actorMemberId: s.adminMemberId,
				expectedHolder: `m:${s.memberId}`,
			}),
		).rejects.toThrow(MEETING_LOCKED_MESSAGE);
	});

	it("the claim actor gate runs BEFORE already-applied", async () => {
		const s = await seedLiveClub();
		// The asserted arm: a non-TMOD actor claiming for someone else is refused,
		// even though the target already holds the slot.
		await setHolder(s.slotId, s.adminMemberId);
		await expect(
			run({
				kind: "claim",
				slotId: s.slotId,
				memberId: s.adminMemberId,
				actorMemberId: s.memberId,
				proof: "asserted",
				expectedHolder: null,
			}),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
	});
	// protects=a refused actor never learns who holds the slot: the refusal is
	//   thrown, no holder name is returned, and nothing is written;
	// fails_when=the comparison (and its name lookup) runs before the actor gates;
	// no_claim=the gates' own cases (the guard test and the claim suite).
	it("an actor refusal beats a changed holder: it throws and names nobody", async () => {
		const s = await seedLiveClub();
		// Held by someone who is neither the target nor the expected (open) holder.
		await setHolder(s.slotId, s.memberId);
		await expect(
			run({
				kind: "claim",
				slotId: s.slotId,
				memberId: s.adminMemberId,
				// Not the TMOD, claiming for someone else, asserted: refused.
				actorMemberId: s.memberId,
				proof: "asserted",
				expectedHolder: null,
			}),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
		expect((await holder(s.slotId))?.m).toBe(s.memberId);
	});

	// protects=a GUEST holder is named in a holder-changed answer for a claim
	//   (the member lookup would return null for it);
	// fails_when=the name lookup is member-only;
	// no_claim=release against a guest (its own case above).
	it("holder-changed on a claim names a GUEST holder", async () => {
		const s = await seedLiveClub();
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson({ clubId: s.clubId, name: "Walk In" }, testDb),
			)
			.returning({ id: guests.id });
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: null,
				assignedGuestId: g!.id,
				status: "claimed",
			})
			.where(eq(roleSlots.id, s.slotId));
		const r = await run({
			kind: "claim",
			slotId: s.slotId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
			expectedHolder: null,
		});
		expect(r).toEqual({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Walk In",
		});
		expect((await holder(s.slotId))?.g).toBe(g!.id);
	});

	// protects=a cancelled meeting is refused for every kind, before an
	//   already-applied success, and (claim) AFTER the asserted gates (#1135);
	// fails_when=the status check is skipped for a claim, or runs before the
	//   actor gates;
	// no_claim=a meeting cancelled between this check and the write (the core's
	//   UPDATE guards that).
	it.each([
		["claim", "already applied"],
		["release", "already applied"],
	] as const)("a cancelled meeting refuses a %s even when %s", async (kind) => {
		const s = await seedLiveClub();
		await setHolder(s.slotId, kind === "claim" ? s.memberId : null);
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		await expect(
			run(
				kind === "claim"
					? {
							kind,
							slotId: s.slotId,
							memberId: s.memberId,
							actorMemberId: s.adminMemberId,
							expectedHolder: null,
						}
					: {
							kind,
							slotId: s.slotId,
							actorMemberId: s.adminMemberId,
							expectedHolder: null,
						},
			),
		).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
	});

	it("on a cancelled meeting an ineligible asserted claimer hears the sign-in refusal first (#1135)", async () => {
		const s = await seedLiveClub();
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		await expect(
			run({
				kind: "claim",
				slotId: s.slotId,
				memberId: s.adminMemberId,
				actorMemberId: s.memberId,
				proof: "asserted",
				expectedHolder: null,
			}),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
	});
});
