/**
 * Regression (#437): the signed-in user's own cross-club views resolved the
 * user by taking whatever single roster member a `where(eq(people.userId, …))`
 * join returned first.
 *
 * `people.user_id` is not unique (ADR-0008 / #329 — duplicates predate
 * dedupe-on-write and the merge is a manual superadmin step), so that pick was
 * arbitrary AND single-club, while both callers documented themselves as
 * covering every club the user belongs to.
 *
 * The fixture below is the real shape: ONE account, TWO Persons, one roster
 * membership each in two different clubs. Before the fix both surfaces returned
 * exactly one club's rows, and which club was down to Postgres row order.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/my-activity.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMyCommitments, loadMySpeechLog, loadSpeechLog } = await import(
	"./my-activity-logic"
);

const DAY = 24 * 60 * 60 * 1000;

interface Attached {
	personId: string;
	memberId: string;
	/** Title of the past speech seeded for this club. */
	speechTitle: string;
	/** Name of the upcoming role seeded for this club. */
	roleName: string;
}

/**
 * Link `userId` to `club` via a NEW Person + roster member, then give that
 * member one past speech and one upcoming role. Called twice with the same
 * userId to build the duplicate-Person, two-club shape.
 */
async function attachToClub(
	club: SeededClub,
	userId: string,
	label: string,
): Promise<Attached> {
	const [personRow] = await testDb
		.insert(people)
		.values({
			name: `Dup Human (${label})`,
			email: `${randomUUID()}@test.example`,
			userId,
		})
		.returning({ id: people.id });

	const [memberRow] = await testDb
		.insert(members)
		.values({
			clubId: club.clubId,
			personId: personRow.id,
			name: `Dup Human (${label})`,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });

	// Speaker role — loadSpeechLog filters on isSpeakerRole.
	const [speakerRole] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: `Speaker ${label}`,
			category: "speaker",
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });

	// --- past: one delivered speech ---
	const [pastMeeting] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: new Date(Date.now() - 7 * DAY),
			status: "completed",
		})
		.returning({ id: meetings.id });

	const speechTitle = `Speech in ${label}`;
	const [speech] = await testDb
		.insert(speeches)
		.values({ personId: personRow.id, title: speechTitle })
		.returning({ id: speeches.id });

	await testDb.insert(roleSlots).values({
		meetingId: pastMeeting.id,
		roleDefinitionId: speakerRole.id,
		assignedMemberId: memberRow.id,
		speechId: speech.id,
		status: "confirmed",
	});

	// --- upcoming: one claimed role, on the club's seeded future meeting ---
	const roleName = `Timer ${label}`;
	const [upcomingRole] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: roleName,
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });

	await testDb.insert(roleSlots).values({
		meetingId: club.meetingId,
		roleDefinitionId: upcomingRole.id,
		assignedMemberId: memberRow.id,
		status: "confirmed",
	});

	return {
		personId: personRow.id,
		memberId: memberRow.id,
		speechTitle,
		roleName,
	};
}

describe.skipIf(!hasTestDb)("my cross-club activity (#437)", () => {
	let clubA: SeededClub;
	let clubB: SeededClub;
	let userId: string;
	let inA: Attached;
	let inB: Attached;

	beforeEach(async () => {
		clubA = await seedClub();
		clubB = await seedClub();
		userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Dup Human",
			email: `${userId}@test.example`,
		});
		inA = await attachToClub(clubA, userId, "A");
		inB = await attachToClub(clubB, userId, "B");
	});

	afterEach(async () => {
		await cleanup(clubA.clubId, [clubA.adminUserId, clubA.memberUserId]);
		// userId last: its Person in club A is gone by now, and its Person in
		// club B goes with this cascade, so the user row is unreferenced.
		await cleanup(clubB.clubId, [
			clubB.adminUserId,
			clubB.memberUserId,
			userId,
		]);
	});

	// The fixture is only meaningful if the two Persons really are distinct rows
	// on one account — otherwise every assertion below passes trivially.
	it("seeds two distinct Persons on one account, one per club", () => {
		expect(inA.personId).not.toBe(inB.personId);
		expect(inA.memberId).not.toBe(inB.memberId);
	});

	it("speech log covers every club, not one arbitrary membership", async () => {
		const log = await loadMySpeechLog(userId, 6);
		const titles = log.map((r) => r.speechTitle);
		expect(titles).toContain(inA.speechTitle);
		expect(titles).toContain(inB.speechTitle);
		expect(log).toHaveLength(2);
	});

	it("commitments cover every club, not one arbitrary membership", async () => {
		const commitments = await loadMyCommitments(userId);
		const roles = commitments.map((r) => r.roleName);
		expect(roles).toContain(inA.roleName);
		expect(roles).toContain(inB.roleName);
		expect(commitments).toHaveLength(2);
	});

	// The defect was not only "too few rows" — it was that WHICH rows you got
	// was down to Postgres row order, so two calls in one request could disagree.
	it("returns the same answer on repeated calls", async () => {
		const runs = await Promise.all([
			loadMySpeechLog(userId, 6),
			loadMySpeechLog(userId, 6),
			loadMySpeechLog(userId, 6),
		]);
		const shapes = new Set(
			runs.map((r) => JSON.stringify(r.map((x) => x.slotId).sort())),
		);
		expect(shapes.size).toBe(1);
	});

	it("an account with no linked membership gets empty results", async () => {
		const strangerId = randomUUID();
		await testDb.insert(user).values({
			id: strangerId,
			name: "No Roster",
			email: `${strangerId}@test.example`,
		});
		try {
			expect(await loadMySpeechLog(strangerId, 6)).toEqual([]);
			expect(await loadMyCommitments(strangerId)).toEqual([]);
		} finally {
			await testDb.delete(user).where(eq(user.id, strangerId));
		}
	});

	// The club-scoped caller (getMemberProfile) must keep its old behavior: one
	// member, one club. Widening the resolver must not widen that surface, or a
	// member's club profile would start showing another club's speeches.
	it("club-scoped speech log still shows only that club's speeches", async () => {
		const scoped = await loadSpeechLog([inA.memberId], clubA.clubId, 6);
		expect(scoped.map((r) => r.speechTitle)).toEqual([inA.speechTitle]);

		// ...and passing the other club's id yields nothing for that member.
		expect(await loadSpeechLog([inA.memberId], clubB.clubId, 6)).toEqual([]);
	});

	it("empty member list short-circuits without hitting the db", async () => {
		expect(await loadSpeechLog([], null, 6)).toEqual([]);
	});
});
