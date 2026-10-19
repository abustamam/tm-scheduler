/**
 * #1217: five writers that deadlocked (40P01) with a member removal because
 * each held a row lock and then asked for one the removal already held, without
 * taking the membership merge lock first (`membership-merge-lock.ts`).
 *
 * Every case parks a removal of one member AFTER it holds the merge lock
 * (EXCLUSIVE) and the member row, at its `DELETE FROM members`, where a cascade
 * waits on a mentorship row a transaction we control holds. The writer then
 * starts. The merge lock is what keeps it out: it must be blocked BY THE REMOVAL
 * on an advisory lock (`waitForLockWait`), holding no row the removal needs.
 * Without the lock the writer takes its rows first, the removal's cascade then
 * asks for one of them, and Postgres aborts one of the two: with the lock
 * removed each case fails with a real 40P01 (`isDeadlock`), not a timeout. The
 * helper below waits for the writer to be blocked by the removal on ANY lock,
 * releases the blocker, and then requires (1) no 40P01 on either side and (2)
 * that the wait was an advisory one.
 *
 * Once the blocker lets go the removal commits and the writer, which woke up to
 * a member that is gone, is refused cleanly: no deadlock on either side.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	members,
	mentorships,
	people,
	roleSlots,
} from "#/db/schema";
import { UNDO_NOT_CONVERTED_MESSAGE } from "#/lib/guest-convert";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// The release seam resolves its actor from the session; officer arm only.
let sessionUserId: string | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { CLUB_BUSY_MESSAGE } = await import("#/server/club-write-lock");
const { isDeadlock } = await import("#/server/pg-errors");
const { lockMembershipForMerge } = await import(
	"#/server/membership-merge-lock"
);
const { applyMemberRemove } = await import("#/server/members-logic");

async function settle(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => null,
		(e: unknown) => e,
	);
}

describe.skipIf(!hasTestDb)("writers vs a member removal (#1217)", () => {
	let club: SeededClub;
	let extraPeople: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraPeople = [];
		sessionUserId = club.adminUserId;
	});
	afterEach(async () => {
		sessionUserId = null;
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (extraPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPeople));
		}
	});

	async function seedLeaver(name = "Leaving Lee") {
		const personId = await seedPerson({ name });
		extraPeople.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name })
			.returning({ id: members.id });
		return m.id;
	}

	async function memberExists(id: string) {
		const rows = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.id, id));
		return rows.length === 1;
	}

	/**
	 * Give `memberId` `n` slots in the seeded meeting; returns their ids ascending.
	 * They are INSERTED in descending id order, so a sequential scan (the bulk
	 * UPDATE in `releaseSlotsAndMarkUnavailable`) meets them in the opposite order
	 * to the removal's `ORDER BY id`.
	 */
	async function seedSlots(
		holder: { memberId: string } | { guestId: string },
		n: number,
	) {
		const ids = Array.from({ length: n }, () => randomUUID()).sort();
		for (const id of [...ids].reverse()) {
			await testDb.insert(roleSlots).values({
				id,
				meetingId: club.meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: "claimed",
				assignedMemberId: "memberId" in holder ? holder.memberId : null,
				assignedGuestId: "guestId" in holder ? holder.guestId : null,
				claimedAt: new Date(),
			});
		}
		return ids;
	}

	/**
	 * Remove `leaver`, parked: it holds the merge lock and the member row (and its
	 * slots, in id order), and waits on a row `blocker` holds. By default that is a
	 * `activity_log` row the DELETE cascades into; `onSlot` parks it earlier, on the
	 * member's lowest-id slot.
	 */
	async function removalParked(leaver: string, onSlot?: string) {
		// The FIRST FK the DELETE cascades into (`activity_log`, by constraint
		// order), so the removal is parked BEFORE it reaches the guest, dues and
		// mentorship rows a writer holds: once the blocker lets go it asks for them.
		const [entry] = await testDb
			.insert(activityLog)
			.values({
				clubId: club.clubId,
				actorMemberId: leaver,
				action: "member_remove",
				targetType: "member",
				targetId: leaver,
			})
			.returning({ id: activityLog.id });
		const blocker = await openBlockingTx(async (tx) => {
			if (onSlot) {
				await tx
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.id, onSlot))
					.for("update");
				return;
			}
			await tx
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(eq(activityLog.id, entry.id))
				.for("update");
		});
		const outcome = settle(
			applyMemberRemove({
				clubId: club.clubId,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			}),
		);
		let removalPid: number;
		try {
			removalPid = await waitForLockWait(
				onSlot ? "role_slots" : 'delete from "members"',
				blocker.pid,
			);
		} catch (e) {
			await blocker.commit();
			await outcome;
			throw e;
		}
		return { blocker, outcome, removalPid };
	}

	/** The lock wait of the first session blocked by `holderPid`. */
	async function waitForBlockedBy(holderPid: number): Promise<string> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const res = await testDb.execute(sql`
				select wait_event from pg_stat_activity
				where datname = current_database() and state = 'active'
				  and wait_event_type = 'Lock'
				  and ${holderPid} = any(pg_blocking_pids(pid))
				limit 1`);
			const ev = (res.rows[0] as { wait_event?: string } | undefined)
				?.wait_event;
			if (ev) return ev;
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error(`nothing blocked by pid ${holderPid}`);
	}

	/**
	 * Run `startWriter` while the removal is parked; return the writer's outcome
	 * after proving neither side deadlocked and the writer waited on an advisory
	 * lock held by the removal.
	 */
	async function interleave(
		leaver: string,
		startWriter: () => Promise<unknown>,
		onSlot?: string,
	) {
		const { blocker, outcome, removalPid } = await removalParked(
			leaver,
			onSlot,
		);
		const writer = settle(startWriter());
		let waitEvent: string;
		try {
			waitEvent = await waitForBlockedBy(removalPid);
		} finally {
			await blocker.commit();
		}
		const removalErr = await outcome;
		const writerErr = await writer;
		expect(isDeadlock(removalErr)).toBe(false);
		expect(isDeadlock(writerErr)).toBe(false);
		expect(waitEvent).toBe("advisory");
		expect(removalErr).toBeNull();
		expect(await memberExists(leaver)).toBe(false);
		return writerErr;
	}

	it("setMentorshipFocus queues behind the removal instead of deadlocking on the pairing", async () => {
		const leaver = await seedLeaver();
		const [other] = await testDb
			.insert(mentorships)
			.values({
				clubId: club.clubId,
				mentorMemberId: club.adminMemberId,
				menteeMemberId: leaver,
				focus: "contest",
			})
			.returning({ id: mentorships.id });
		const { setMentorshipFocus } = await import("#/server/mentorship-logic");
		const err = await interleave(leaver, () =>
			setMentorshipFocus({
				clubId: club.clubId,
				mentorshipId: other.id,
				focus: "leadership",
				actorMemberId: club.adminMemberId,
			}),
		);
		// The pairing went with the member (cascade); the writer found it gone.
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
	});

	it("a full-year dues payment queues behind the removal instead of deadlocking on member_dues", async () => {
		const leaver = await seedLeaver();
		const { createDuesPeriod, recordDuesPayment } = await import(
			"#/server/dues-logic"
		);
		const { id: p1 } = await createDuesPeriod({
			clubId: club.clubId,
			label: "P1",
			dueDate: new Date("2026-04-01"),
			defaultAmountCents: null,
		});
		await createDuesPeriod({
			clubId: club.clubId,
			label: "P2",
			dueDate: new Date("2026-10-01"),
			defaultAmountCents: null,
		});
		// An existing row for the first period, so the first upsert LOCKS it.
		await recordDuesPayment({
			clubId: club.clubId,
			periodId: p1,
			membershipId: leaver,
			amountCents: 100,
		});
		const err = await interleave(leaver, () =>
			recordDuesPayment({
				clubId: club.clubId,
				periodId: p1,
				membershipId: leaver,
				amountCents: 4500,
				fullYear: true,
				nextAmountCents: 4500,
			}),
		);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
	});

	it("releasing a member's slots and marking them unavailable queues behind the removal", async () => {
		const leaver = await seedLeaver();
		// Two slots, the removal parked on the lower id: it holds the meeting lock
		// and wants slot[0] then slot[1]; the unordered bulk UPDATE meets slot[1]
		// first, so without the merge lock it holds slot[1] and waits on slot[0].
		const slots = await seedSlots({ memberId: leaver }, 2);
		const { releaseSlotsAndMarkUnavailable } = await import(
			"#/server/availability-logic"
		);
		const err = await interleave(
			leaver,
			() =>
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: leaver,
					claimedActorMemberId: club.adminMemberId,
					meetingId: club.meetingId,
					clubId: club.clubId,
				}),
			slots[0],
		);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
	});

	it("unlinking a guest from the member queues behind the removal instead of deadlocking on the guest row", async () => {
		const leaver = await seedLeaver();
		const { applyLinkGuestToMember, applyUnlinkGuestFromMember } = await import(
			"#/server/guest-pipeline-logic"
		);
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: club.clubId, name: "Linked Guest" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		// The guest holds two slots when linked: the link moves them to the member
		// and records their ids, which is what the unlink's bulk slot UPDATE restores.
		await seedSlots({ guestId: g.id }, 2);
		await applyLinkGuestToMember({
			clubId: club.clubId,
			guestId: g.id,
			memberId: leaver,
			actorMemberId: club.adminMemberId,
		});
		const err = await interleave(leaver, () =>
			applyUnlinkGuestFromMember({
				clubId: club.clubId,
				guestId: g.id,
				actorMemberId: club.adminMemberId,
			}),
		);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
	});

	it("undoing a guest conversion queues behind the removal (exclusive) instead of deadlocking", async () => {
		const { applyConvertGuestToMember, applyUndoGuestConversion } =
			await import("#/server/guest-pipeline-logic");
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: club.clubId, name: "Converted Guest" },
					testDb,
				),
			)
			.returning({ id: guests.id });
		const converted = await applyConvertGuestToMember({
			clubId: club.clubId,
			guestId: g.id,
			actorMemberId: club.adminMemberId,
		});
		extraPeople.push(converted.personId);
		const err = await interleave(converted.membershipId, () =>
			applyUndoGuestConversion({
				clubId: club.clubId,
				guestId: g.id,
				actorMemberId: club.adminMemberId,
			}),
		);
		// The removal took the pointer away (SET NULL); the undo found nothing to undo.
		expect((err as Error).message).toBe(UNDO_NOT_CONVERTED_MESSAGE);
	});

	it.each([
		"mentee",
		"mentor",
	] as const)("setMentorshipFocus refuses a pairing a merge re-pointed on the %s side between its peek and its lock", async (side) => {
		const old = await seedLeaver("Old Member");
		const keeper = await seedLeaver("Keeper");
		const [pairing] = await testDb
			.insert(mentorships)
			.values({
				clubId: club.clubId,
				mentorMemberId: side === "mentor" ? old : club.adminMemberId,
				menteeMemberId: side === "mentee" ? old : club.adminMemberId,
				focus: "contest",
			})
			.returning({ id: mentorships.id });
		const { setMentorshipFocus } = await import("#/server/mentorship-logic");
		// A merge of `mentee` holds the lock EXCLUSIVE; the writer peeks the pairing
		// (old id on one side), then waits on the shared lock. The merge re-points the
		// pairing to the keeper and commits, leaving the old member row in place.
		const merge = await openBlockingTx(async (tx) => {
			await lockMembershipForMerge(tx, old);
			await tx
				.update(mentorships)
				.set(
					side === "mentee"
						? { menteeMemberId: keeper }
						: { mentorMemberId: keeper },
				)
				.where(eq(mentorships.id, pairing.id));
		});
		const writer = settle(
			setMentorshipFocus({
				clubId: club.clubId,
				mentorshipId: pairing.id,
				focus: "leadership",
				actorMemberId: club.adminMemberId,
			}),
		);
		try {
			await waitForLockWait("pg_advisory_xact_lock_shared", merge.pid);
		} finally {
			await merge.commit();
		}
		const err = await writer;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		const [row] = await testDb
			.select({ focus: mentorships.focus })
			.from(mentorships)
			.where(eq(mentorships.id, pairing.id));
		expect(row.focus).toBe("contest");
	});

	it("a removal that arrives after setMentorshipFocus holds its shared lock waits for it and neither deadlocks", async () => {
		const leaver = await seedLeaver();
		const [pairing] = await testDb
			.insert(mentorships)
			.values({
				clubId: club.clubId,
				mentorMemberId: club.adminMemberId,
				menteeMemberId: leaver,
				focus: "contest",
			})
			.returning({ id: mentorships.id });
		const { setMentorshipFocus } = await import("#/server/mentorship-logic");
		// Park the writer AFTER it took the shared lock: it waits on the pairing row.
		const blocker = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: mentorships.id })
				.from(mentorships)
				.where(eq(mentorships.id, pairing.id))
				.for("update");
		});
		const writer = settle(
			setMentorshipFocus({
				clubId: club.clubId,
				mentorshipId: pairing.id,
				focus: "leadership",
				actorMemberId: club.adminMemberId,
			}),
		);
		const writerPid = await waitForLockWait("mentorships", blocker.pid);
		const removal = settle(
			applyMemberRemove({
				clubId: club.clubId,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			}),
		);
		try {
			await waitForLockWait("pg_advisory_xact_lock", writerPid);
		} finally {
			await blocker.commit();
		}
		expect(await writer).toBeNull();
		const removalErr = await removal;
		expect(isDeadlock(removalErr)).toBe(false);
		expect(removalErr).toBeNull();
		expect(await memberExists(leaver)).toBe(false);
	});
});
