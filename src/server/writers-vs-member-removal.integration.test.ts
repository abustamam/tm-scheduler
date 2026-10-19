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
 * asks for one of them, and Postgres aborts one of the two.
 *
 * Once the blocker lets go the removal commits and the writer, which woke up to
 * a member that is gone, is refused cleanly: no deadlock on either side.
 */
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, mentorships, people } from "#/db/schema";
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
	 * Remove `leaver`, parked inside its DELETE: it holds the merge lock and the
	 * member row, and waits on a mentorship row `blocker` holds.
	 */
	async function removalParked(leaver: string) {
		const [pairing] = await testDb
			.insert(mentorships)
			.values({
				clubId: club.clubId,
				mentorMemberId: club.adminMemberId,
				menteeMemberId: leaver,
				focus: "other",
			})
			.returning({ id: mentorships.id });
		const blocker = await openBlockingTx(async (tx) => {
			await tx
				.select({ id: mentorships.id })
				.from(mentorships)
				.where(eq(mentorships.id, pairing.id))
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
			removalPid = await waitForLockWait('delete from "members"', blocker.pid);
		} catch (e) {
			await blocker.commit();
			await outcome;
			throw e;
		}
		return { blocker, outcome, removalPid };
	}

	/**
	 * Run `startWriter` while the removal is parked; return both outcomes after
	 * proving the writer waited on an advisory lock held by the removal.
	 */
	async function interleave(
		leaver: string,
		startWriter: () => Promise<unknown>,
	) {
		const { blocker, outcome, removalPid } = await removalParked(leaver);
		const writer = settle(startWriter());
		try {
			await waitForLockWait("pg_advisory_xact_lock", removalPid);
		} finally {
			await blocker.commit();
		}
		const removalErr = await outcome;
		const writerErr = await writer;
		expect(isDeadlock(removalErr)).toBe(false);
		expect(isDeadlock(writerErr)).toBe(false);
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
		const { releaseSlotsAndMarkUnavailable } = await import(
			"#/server/availability-logic"
		);
		const err = await interleave(leaver, () =>
			releaseSlotsAndMarkUnavailable(testDb, {
				memberId: leaver,
				claimedActorMemberId: club.adminMemberId,
				meetingId: club.meetingId,
				clubId: club.clubId,
			}),
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
});
