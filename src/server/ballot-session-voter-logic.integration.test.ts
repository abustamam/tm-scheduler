/**
 * DB-backed tests for `loadBallotSessionVoter` (#962): who a signed-in phone
 * votes as on a meeting's ballot. Skips when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadBallotSessionVoter } = await import(
	"#/server/ballot-session-voter-logic"
);

describe.skipIf(!hasTestDb)("loadBallotSessionVoter (#962)", () => {
	let a: SeededClub;
	let b: SeededClub;
	/** A second membership of club A's member, in club B — deleted by hand
	 *  first, because it points at a person each club's cleanup would delete. */
	let crossMemberId: string | null;

	beforeEach(async () => {
		a = await seedClub();
		b = await seedClub();
		crossMemberId = null;
	});

	afterEach(async () => {
		if (crossMemberId) {
			await testDb.delete(members).where(eq(members.id, crossMemberId));
		}
		await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
		await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
	});

	it("is the session user's own member row in the meeting's club", async () => {
		expect(await loadBallotSessionVoter(a.meetingId, a.memberUserId)).toEqual({
			id: a.memberId,
			name: "Member User",
		});
	});

	it("resolves a member of several clubs to their row in the MEETING's club, with no active club involved", async () => {
		// Club A's member also belongs to club B, under a different roster name.
		// Nothing here reads an active-club cookie: the club comes from the meeting.
		const [row] = await testDb
			.insert(members)
			.values({
				clubId: b.clubId,
				personId: a.personId,
				name: "Member In B",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		crossMemberId = row.id;

		expect(await loadBallotSessionVoter(b.meetingId, a.memberUserId)).toEqual({
			id: row.id,
			name: "Member In B",
		});
		// ...and still their club-A row on club A's ballot.
		expect(
			(await loadBallotSessionVoter(a.meetingId, a.memberUserId))?.id,
		).toBe(a.memberId);
	});

	it("is null for a signed-in user who is not a member of the meeting's club", async () => {
		expect(
			await loadBallotSessionVoter(a.meetingId, b.memberUserId),
		).toBeNull();
	});

	it("is null for an inactive membership, which `castVote` would not treat as the member's session either", async () => {
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, a.memberId));

		expect(
			await loadBallotSessionVoter(a.meetingId, a.memberUserId),
		).toBeNull();
	});

	it("is null for an archived club", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, a.clubId));

		expect(
			await loadBallotSessionVoter(a.meetingId, a.memberUserId),
		).toBeNull();
	});

	it("is null for a meeting that does not exist", async () => {
		expect(
			await loadBallotSessionVoter(randomUUID(), a.memberUserId),
		).toBeNull();
	});
});
