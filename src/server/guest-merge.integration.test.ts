/**
 * DB-backed tests for the guest merge (#1609): a club admin folds one guest
 * record of the club into another. `#/db` is mocked to the TEST_DATABASE_URL
 * client; the whole suite skips when that env is unset (a skip is not green).
 *
 * Every test states its card: protects=…; fails_when=…; no_claim=….
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guestInvites,
	guests,
	importRefs,
	meetingAttendance,
	meetingAwards,
	meetingBallotGuests,
	meetingCandidateDisqualifications,
	meetingGuestRsvps,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	people,
	roleSlots,
	slotCoverRequests,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyMergeGuests,
	previewMergeGuests,
	GUEST_MERGE_CONVERTED_MESSAGE,
	GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
	GUEST_MERGE_SAME_MESSAGE,
} = await import("#/server/guest-merge-logic");
const { NO_PERMISSION_MESSAGE } = await import("#/server/guards");

describe.skipIf(!hasTestDb)("guest merge (#1609)", () => {
	let seed: SeededClub;
	let other: SeededClub | null = null;
	const extraPeople: string[] = [];

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		if (other) {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			other = null;
		}
		if (extraPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPeople));
			extraPeople.length = 0;
		}
	});

	async function mkGuest(
		name: string,
		extra: Partial<typeof guests.$inferInsert> & {
			email?: string | null;
			phone?: string | null;
			personId?: string;
		} = {},
		clubId = seed.clubId,
	): Promise<{ id: string; personId: string }> {
		const [g] = await testDb
			.insert(guests)
			.values(await withGuestPerson({ clubId, name, ...extra }, testDb))
			.returning({ id: guests.id, personId: guests.personId });
		if (!g) throw new Error("seed guest failed");
		return g;
	}

	async function mkMeeting(daysAgo: number): Promise<string> {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() - daysAgo * 86_400_000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("seed meeting failed");
		return m.id;
	}

	async function mkSession(
		meetingId: string,
		category: "best_speaker" | "best_evaluator" | "best_table_topics",
	): Promise<string> {
		const [s] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId, category })
			.returning({ id: meetingVoteSessions.id });
		if (!s) throw new Error("seed session failed");
		return s.id;
	}

	const input = (keep: string, absorb: string) => ({
		clubId: seed.clubId,
		keepGuestId: keep,
		absorbGuestId: absorb,
		actorUserId: seed.adminUserId,
	});

	async function guestRowExists(id: string): Promise<boolean> {
		const rows = await testDb.select().from(guests).where(eq(guests.id, id));
		return rows.length > 0;
	}

	async function snapshot(guestIds: string[]) {
		const personIds = (
			await testDb
				.select({ id: guests.personId })
				.from(guests)
				.where(inArray(guests.id, guestIds))
		).map((r) => r.id);
		const count = async (q: PromiseLike<unknown[]>) => (await q).length;
		return {
			guests: await count(
				testDb.select().from(guests).where(inArray(guests.id, guestIds)),
			),
			people: await count(
				testDb.select().from(people).where(inArray(people.id, personIds)),
			),
			attendance: await count(
				testDb
					.select()
					.from(meetingAttendance)
					.where(inArray(meetingAttendance.guestId, guestIds)),
			),
			activity: await count(
				testDb
					.select()
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "guest_merge"),
						),
					),
			),
		};
	}

	/** Every table in the enumeration, for the absorbed guest id. */
	async function rowsNaming(guestId: string): Promise<Record<string, number>> {
		const n = async (q: PromiseLike<unknown[]>) => (await q).length;
		return {
			guest_invites: await n(
				testDb
					.select()
					.from(guestInvites)
					.where(eq(guestInvites.guestId, guestId)),
			),
			role_slots: await n(
				testDb
					.select()
					.from(roleSlots)
					.where(eq(roleSlots.assignedGuestId, guestId)),
			),
			slot_cover_requests: await n(
				testDb
					.select()
					.from(slotCoverRequests)
					.where(eq(slotCoverRequests.coveredGuestId, guestId)),
			),
			meeting_guest_rsvps: await n(
				testDb
					.select()
					.from(meetingGuestRsvps)
					.where(eq(meetingGuestRsvps.guestId, guestId)),
			),
			meeting_attendance: await n(
				testDb
					.select()
					.from(meetingAttendance)
					.where(eq(meetingAttendance.guestId, guestId)),
			),
			table_topics_speakers: await n(
				testDb
					.select()
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.guestId, guestId)),
			),
			meeting_awards: await n(
				testDb
					.select()
					.from(meetingAwards)
					.where(eq(meetingAwards.guestId, guestId)),
			),
			meeting_votes_voter: await n(
				testDb
					.select()
					.from(meetingVotes)
					.where(eq(meetingVotes.voterGuestId, guestId)),
			),
			meeting_votes_candidate: await n(
				testDb
					.select()
					.from(meetingVotes)
					.where(eq(meetingVotes.candidateGuestId, guestId)),
			),
			meeting_ballot_guests: await n(
				testDb
					.select()
					.from(meetingBallotGuests)
					.where(eq(meetingBallotGuests.guestId, guestId)),
			),
			meeting_candidate_disqualifications: await n(
				testDb
					.select()
					.from(meetingCandidateDisqualifications)
					.where(
						eq(meetingCandidateDisqualifications.candidateGuestId, guestId),
					),
			),
			speeches: await n(
				testDb.select().from(speeches).where(eq(speeches.guestId, guestId)),
			),
			import_refs: await n(
				testDb
					.select()
					.from(importRefs)
					.where(
						and(eq(importRefs.kind, "guest"), eq(importRefs.targetId, guestId)),
					),
			),
		};
	}

	it("re-points every row the absorbed guest held onto the keeper and drops same-key duplicates in the keeper's favour", async () => {
		// protects=every table naming the absorbed guest ends up naming the keeper (none dangling, none cascaded away); the keeper's row wins a same-meeting duplicate; the counts match what moved;
		// fails_when=any re-point, any duplicate-drop or the delete order is wrong (a cascade would delete the row instead of moving it);
		// no_claim=the activity row, the Person rule or the import_refs re-point (own tests)
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const m1 = await mkMeeting(1);
		const m2 = await mkMeeting(2);

		await testDb.insert(meetingAttendance).values([
			{ meetingId: m1, guestId: B.id, status: "present" },
			{ meetingId: m2, guestId: A.id, status: "present" },
			{ meetingId: m2, guestId: B.id, status: "present" },
		]);
		await testDb.insert(guestInvites).values([
			{ clubId: seed.clubId, guestId: B.id, meetingId: m1 },
			{ clubId: seed.clubId, guestId: A.id, meetingId: m2 },
			{ clubId: seed.clubId, guestId: B.id, meetingId: m2 },
		]);
		await testDb.insert(meetingGuestRsvps).values([
			{
				clubId: seed.clubId,
				meetingId: m1,
				guestId: B.id,
				clientKey: randomUUID(),
			},
			{
				clubId: seed.clubId,
				meetingId: m2,
				guestId: A.id,
				clientKey: randomUUID(),
			},
			{
				clubId: seed.clubId,
				meetingId: m2,
				guestId: B.id,
				clientKey: randomUUID(),
			},
		]);
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: B.id, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
		await testDb.insert(slotCoverRequests).values({
			clubId: seed.clubId,
			meetingId: seed.meetingId,
			slotId: seed.slotId,
			kind: "dropped",
			priorStatus: "claimed",
			coveredGuestId: B.id,
		});
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: m1, guestId: B.id });
		await testDb
			.insert(meetingAwards)
			.values({ meetingId: m1, category: "best_speaker", guestId: B.id });
		await testDb
			.insert(speeches)
			.values({ guestId: B.id, title: "Ice Breaker" });
		await testDb.insert(meetingBallotGuests).values([
			{ meetingId: m1, guestId: B.id },
			{ meetingId: m2, guestId: A.id },
			{ meetingId: m2, guestId: B.id },
		]);

		const res = await applyMergeGuests(input(A.id, B.id));

		expect(res.refusal).toBeNull();
		expect(await guestRowExists(B.id)).toBe(false);
		expect(await guestRowExists(A.id)).toBe(true);
		const left = await rowsNaming(B.id);
		expect(left).toEqual(
			Object.fromEntries(Object.keys(left).map((k) => [k, 0])),
		);
		// A holds the union: m1 and m2 attendance, once each.
		const att = await testDb
			.select({ meetingId: meetingAttendance.meetingId })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.guestId, A.id));
		expect(att.map((r) => r.meetingId).sort()).toEqual([m1, m2].sort());
		expect(await rowsNaming(A.id)).toMatchObject({
			guest_invites: 2,
			meeting_guest_rsvps: 2,
			role_slots: 1,
			slot_cover_requests: 1,
			table_topics_speakers: 1,
			meeting_awards: 1,
			speeches: 1,
			meeting_ballot_guests: 2,
		});
		expect(res.moved).toMatchObject({
			meeting_attendance: 1,
			guest_invites: 1,
			meeting_guest_rsvps: 1,
			role_slots: 1,
			slot_cover_requests: 1,
			table_topics_speakers: 1,
			meeting_awards: 1,
			speeches: 1,
			meeting_ballot_guests: 1,
		});
		expect(res.droppedAsDuplicate).toMatchObject({
			meeting_attendance: 1,
			guest_invites: 1,
			meeting_guest_rsvps: 1,
			meeting_ballot_guests: 1,
		});
	});

	it("keeps the keeper's ballot on a collision, and turns a vote FOR the absorbed guest into a vote for the keeper", async () => {
		// protects=one ballot per (session, voter): the keeper's survives, the absorbed's is dropped; a vote whose CANDIDATE is the absorbed guest follows to the keeper; a ballot only the absorbed cast moves;
		// fails_when=collision is keyed on the meeting alone, the absorbed ballot is kept (unique violation) or deleted by the cascade, or candidate votes are left to cascade away;
		// no_claim=tallying or the ballot UI
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const m1 = await mkMeeting(1);
		const m2 = await mkMeeting(2);
		const m3 = await mkMeeting(3);
		const s1 = await mkSession(m1, "best_speaker");
		const s2 = await mkSession(m2, "best_speaker");
		const s3 = await mkSession(m3, "best_speaker");
		const [aBallot] = await testDb
			.insert(meetingVotes)
			.values({
				sessionId: s2,
				voterGuestId: A.id,
				candidateWriteIn: "Keeper pick",
			})
			.returning({ id: meetingVotes.id });
		await testDb.insert(meetingVotes).values({
			sessionId: s2,
			voterGuestId: B.id,
			candidateWriteIn: "Absorbed pick",
		});
		const [onlyB] = await testDb
			.insert(meetingVotes)
			.values({ sessionId: s1, voterGuestId: B.id, candidateWriteIn: "x" })
			.returning({ id: meetingVotes.id });
		const [forB] = await testDb
			.insert(meetingVotes)
			.values({
				sessionId: s3,
				voterMemberId: seed.memberId,
				candidateGuestId: B.id,
			})
			.returning({ id: meetingVotes.id });

		const res = await applyMergeGuests(input(A.id, B.id));

		const votes = await testDb
			.select({
				id: meetingVotes.id,
				voter: meetingVotes.voterGuestId,
				candidate: meetingVotes.candidateGuestId,
				write: meetingVotes.candidateWriteIn,
				sessionId: meetingVotes.sessionId,
			})
			.from(meetingVotes)
			.where(inArray(meetingVotes.sessionId, [s1, s2, s3]));
		const s2Rows = votes.filter((v) => v.sessionId === s2);
		expect(s2Rows).toHaveLength(1);
		expect(s2Rows[0]).toMatchObject({ id: aBallot?.id, write: "Keeper pick" });
		expect(votes.find((v) => v.id === onlyB?.id)?.voter).toBe(A.id);
		expect(votes.find((v) => v.id === forB?.id)?.candidate).toBe(A.id);
		expect(res.droppedAsDuplicate.meeting_votes).toBe(1);
		// The ballot only B cast, and the vote for B: two re-points.
		expect(res.moved.meeting_votes).toBe(2);
	});

	it("moves a disqualification of the absorbed guest onto the keeper instead of letting the FK cascade delete it, and keeps the keeper's on a collision", async () => {
		// protects=meeting_candidate_disqualifications.candidate_guest_id (a composite-table FK with ON DELETE CASCADE) is re-pointed before the guest row goes; the keeper's own row for the same (meeting, category) wins;
		// fails_when=the DQ re-point is skipped (the row silently disappears with the absorbed guest) or collides on the meeting alone;
		// no_claim=how the Vote Counter renders a disqualification
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const m1 = await mkMeeting(1);
		const m2 = await mkMeeting(2);
		await testDb.insert(meetingCandidateDisqualifications).values([
			{
				meetingId: m1,
				category: "best_speaker",
				candidateGuestId: B.id,
				reason: "absorbed only",
			},
			{
				meetingId: m2,
				category: "best_speaker",
				candidateGuestId: A.id,
				reason: "keeper's own",
			},
			{
				meetingId: m2,
				category: "best_speaker",
				candidateGuestId: B.id,
				reason: "absorbed duplicate",
			},
			{
				meetingId: m2,
				category: "best_evaluator",
				candidateGuestId: B.id,
				reason: "other category",
			},
		]);

		const res = await applyMergeGuests(input(A.id, B.id));

		const dq = await testDb
			.select({
				meetingId: meetingCandidateDisqualifications.meetingId,
				category: meetingCandidateDisqualifications.category,
				reason: meetingCandidateDisqualifications.reason,
				guest: meetingCandidateDisqualifications.candidateGuestId,
			})
			.from(meetingCandidateDisqualifications)
			.where(inArray(meetingCandidateDisqualifications.meetingId, [m1, m2]));
		expect(dq).toHaveLength(3);
		expect(dq.every((r) => r.guest === A.id)).toBe(true);
		expect(
			dq.find((r) => r.meetingId === m2 && r.category === "best_speaker")
				?.reason,
		).toBe("keeper's own");
		expect(dq.map((r) => r.reason)).toContain("absorbed only");
		expect(dq.map((r) => r.reason)).toContain("other category");
		expect(res.moved.meeting_candidate_disqualifications).toBe(2);
		expect(res.droppedAsDuplicate.meeting_candidate_disqualifications).toBe(1);
	});

	it("re-points import_refs: a guest ref to the keeper, and an attendance ref to the keeper's row when the absorbed row was dropped", async () => {
		// protects=a re-import still resolves the source ids the absorbed guest carried (no dangling target); an attendance ref survives the drop of its row by naming the keeper's attendance row for that meeting;
		// fails_when=either import_refs re-point is missing, or the attendance ref is re-pointed after its row is already gone (stays dangling);
		// no_claim=that the importer behaves on a re-run
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const m2 = await mkMeeting(2);
		const [aAtt] = await testDb
			.insert(meetingAttendance)
			.values({ meetingId: m2, guestId: A.id, status: "present" })
			.returning({ id: meetingAttendance.id });
		const [bAtt] = await testDb
			.insert(meetingAttendance)
			.values({ meetingId: m2, guestId: B.id, status: "present" })
			.returning({ id: meetingAttendance.id });
		await testDb.insert(importRefs).values([
			{
				clubId: seed.clubId,
				source: "easy_speak",
				kind: "guest",
				sourceId: "es-guest-b",
				targetId: B.id,
			},
			{
				clubId: seed.clubId,
				source: "easy_speak",
				kind: "attendance",
				sourceId: "es-att-b",
				targetId: bAtt?.id as string,
			},
		]);

		await applyMergeGuests(input(A.id, B.id));

		const refs = await testDb
			.select({ sourceId: importRefs.sourceId, target: importRefs.targetId })
			.from(importRefs)
			.where(eq(importRefs.clubId, seed.clubId));
		expect(refs.find((r) => r.sourceId === "es-guest-b")?.target).toBe(A.id);
		expect(refs.find((r) => r.sourceId === "es-att-b")?.target).toBe(aAtt?.id);
	});

	it("fills the keeper Person's blank email and phone from a guest-only absorbed Person, leaves a non-blank value alone, and deletes the absorbed Person", async () => {
		// protects=the contact survives on the keeper Person when it had none, a stored value is never overwritten, and the absorbed Person no longer exists afterwards;
		// fails_when=the fill overwrites a non-blank value, is skipped, or the absorbed Person is left behind;
		// no_claim=the keeper being a member's Person (own test) or the activity row
		const tag = randomUUID().slice(0, 8);
		const A = await mkGuest("Keeper Kay", { phone: "555-000-1111" });
		const B = await mkGuest("Absorbed Abe", {
			email: `abe-${tag}@example.test`,
			phone: "555-999-2222",
		});

		const res = await applyMergeGuests(input(A.id, B.id));

		expect(res.absorbedPersonDeleted).toBe(true);
		const [keeperPerson] = await testDb
			.select({ email: people.email, phone: people.phone })
			.from(people)
			.where(eq(people.id, A.personId));
		expect(keeperPerson).toEqual({
			email: `abe-${tag}@example.test`,
			phone: "555-000-1111",
		});
		expect(
			await testDb.select().from(people).where(eq(people.id, B.personId)),
		).toHaveLength(0);
	});

	it("never overwrites a keeper Person's stored email, filling only the phone it lacks", async () => {
		// protects=a stored address on the keeper Person is not replaced by the absorbed one (the UPDATE's own isNull(people.email)), while a blank phone on the same Person is still filled;
		// fails_when=the email UPDATE loses isNull(people.email) (the keeper's address changes) or the phone fill is skipped;
		// no_claim=blank-email fill (the test above)
		const tag = randomUUID().slice(0, 8);
		const A = await mkGuest("Keeper Kay", { email: `kay-${tag}@example.test` });
		const B = await mkGuest("Absorbed Abe", {
			email: `abe-${tag}@example.test`,
			phone: "555-444-1212",
		});

		await applyMergeGuests(input(A.id, B.id));

		const [p] = await testDb
			.select({ email: people.email, phone: people.phone })
			.from(people)
			.where(eq(people.id, A.personId));
		expect(p).toEqual({
			email: `kay-${tag}@example.test`,
			phone: "555-444-1212",
		});
	});

	it("leaves a keeper Person that is not guest-writable untouched (a member's Person) while still merging the guest rows", async () => {
		// protects=a keeper Person that holds a membership keeps its contact: the fill rides `guestContactWritable` in the UPDATE's own WHERE;
		// fails_when=the fill writes a member's Person from a guest card;
		// no_claim=that the absorbed contact is preserved anywhere (it goes with the absorbed Person, by design)
		const tag = randomUUID().slice(0, 8);
		const A = await mkGuest("Keeper Kay", { personId: seed.personId });
		const B = await mkGuest("Absorbed Abe", {
			email: `abe-${tag}@example.test`,
			phone: "555-999-3333",
		});
		// Blank on both, so only the predicate (not isNull) stands between the
		// absorbed contact and this member's Person.
		await testDb
			.update(people)
			.set({ email: null, phone: null })
			.where(eq(people.id, seed.personId));
		const [before] = await testDb
			.select({ email: people.email, phone: people.phone })
			.from(people)
			.where(eq(people.id, seed.personId));

		await applyMergeGuests(input(A.id, B.id));

		const [after] = await testDb
			.select({ email: people.email, phone: people.phone })
			.from(people)
			.where(eq(people.id, seed.personId));
		expect(after).toEqual(before);
		expect(await guestRowExists(B.id)).toBe(false);
	});

	it("fills the keeper's blank profile fields (goes-by, home club, introducer, book email) from the absorbed guest and keeps the keeper's own", async () => {
		// protects=the keeper keeps its own preferred name / home club / introducer / book email and takes the absorbed value only where its own is null;
		// fails_when=a keeper value is overwritten, or a null is not filled;
		// no_claim=name, kind and stage, which are never copied
		const A = await mkGuest("Keeper Kay", {
			preferredName: "Kay",
			homeClub: null,
			introducedByMemberId: null,
			bookEmail: null,
		});
		const B = await mkGuest("Absorbed Abe", {
			preferredName: "Abe",
			homeClub: "Laguna #1",
			introducedByMemberId: seed.memberId,
			bookEmail: "abe@book.test",
		});

		await applyMergeGuests(input(A.id, B.id));

		const [row] = await testDb.select().from(guests).where(eq(guests.id, A.id));
		expect(row).toMatchObject({
			name: "Keeper Kay",
			preferredName: "Kay",
			homeClub: "Laguna #1",
			introducedByMemberId: seed.memberId,
			bookEmail: "abe@book.test",
		});
	});

	it("merges two guest rows on the SAME Person without touching the Person", async () => {
		// protects=same-Person duplicates (two rows, one human) merge, and the shared Person is neither deleted nor rewritten;
		// fails_when=the same-Person case tries to delete the shared Person or refuses;
		// no_claim=two rows on one Person in two clubs
		const A = await mkGuest("Keeper Kay", { phone: "555-123-0000" });
		const B = await mkGuest("Absorbed Abe", { personId: A.personId });

		const res = await applyMergeGuests(input(A.id, B.id));

		expect(res.absorbedPersonDeleted).toBe(false);
		expect(await guestRowExists(B.id)).toBe(false);
		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.id, A.personId));
		expect(p?.phone).toBe("555-123-0000");
	});

	it("refuses, writing nothing, when the absorbed Person holds a membership", async () => {
		// protects=a club admin never fuses a Person that exists outside the guest world: the absorbed Person has a membership;
		// fails_when=the unboundGuestOnlyPerson check is removed, so a member's Person is deleted or its guest row merged;
		// no_claim=the signed-in and other-club arms (own tests)
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe", { personId: seed.personId });
		const m1 = await mkMeeting(1);
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: m1, guestId: B.id, status: "present" });
		const before = await snapshot([A.id, B.id]);

		await expect(applyMergeGuests(input(A.id, B.id))).rejects.toThrow(
			GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
		);
		expect(await snapshot([A.id, B.id])).toEqual(before);
		expect(await guestRowExists(B.id)).toBe(true);
	});

	it("refuses, writing nothing, when the absorbed Person has signed in (a user)", async () => {
		// protects=a Person bound to a sign-in is never deleted by a club admin;
		// fails_when=the `user_id` arm of the guest-only check is lost;
		// no_claim=membership or other-club arms
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		await testDb
			.update(people)
			.set({ userId: seed.memberUserId })
			.where(eq(people.id, B.personId));
		// The seeded member's own Person already holds that user: free it.
		await testDb
			.update(people)
			.set({ userId: null })
			.where(eq(people.id, seed.personId));
		const before = await snapshot([A.id, B.id]);

		await expect(applyMergeGuests(input(A.id, B.id))).rejects.toThrow(
			GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
		);
		expect(await snapshot([A.id, B.id])).toEqual(before);
		await testDb
			.update(people)
			.set({ userId: null })
			.where(eq(people.id, B.personId));
	});

	it("refuses, writing nothing, when the absorbed Person has a guest row in another club", async () => {
		// protects=the absorbed Person is not THIS guest row's alone, so deleting it would take another club's guest;
		// fails_when=the only-guest-row check is removed;
		// no_claim=membership or sign-in arms
		other = await seedClub();
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		await mkGuest("Abe elsewhere", { personId: B.personId }, other.clubId);
		const m1 = await mkMeeting(1);
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: m1, guestId: B.id, status: "present" });
		const before = await snapshot([A.id, B.id]);

		await expect(applyMergeGuests(input(A.id, B.id))).rejects.toThrow(
			GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
		);
		expect(await snapshot([A.id, B.id])).toEqual(before);
	});

	it("refuses, rolling back every re-point, when the absorbed Person owns a speech (person-linked history)", async () => {
		// protects=the late arm: a Person the early check cannot see (a speech owned by the Person) makes the Person delete refuse, and the whole merge rolls back, attendance re-point included;
		// fails_when=the delete's false return is ignored (the guest row would be gone and the Person left behind) or the apply does not throw;
		// no_claim=the early membership/user/other-guest checks
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		await testDb
			.insert(speeches)
			.values({ personId: B.personId, title: "Person-owned" });
		const m1 = await mkMeeting(1);
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: m1, guestId: B.id, status: "present" });
		const before = await snapshot([A.id, B.id]);

		await expect(applyMergeGuests(input(A.id, B.id))).rejects.toThrow(
			GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
		);
		expect(await snapshot([A.id, B.id])).toEqual(before);
		expect(
			await testDb
				.select()
				.from(meetingAttendance)
				.where(eq(meetingAttendance.guestId, B.id)),
		).toHaveLength(1);
		await testDb.delete(speeches).where(eq(speeches.personId, B.personId));
	});

	it("refuses a joined or converted guest on either side, writing nothing", async () => {
		// protects=a record at stage joined, or carrying converted_membership_id, is never merged (either as keeper or absorbed);
		// fails_when=either the stage arm or the converted_membership_id arm, on either side, is dropped;
		// no_claim=undoing a conversion
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const C = await mkGuest("Converted Cy");
		await testDb
			.update(guests)
			.set({ convertedMembershipId: seed.memberId })
			.where(eq(guests.id, C.id));
		const D = await mkGuest("Joined Di");
		await testDb
			.update(guests)
			.set({ stage: "joined" })
			.where(eq(guests.id, D.id));
		const before = await snapshot([A.id, B.id, C.id, D.id]);

		for (const [keep, absorb] of [
			[A.id, C.id],
			[C.id, A.id],
			[A.id, D.id],
			[D.id, A.id],
		] as const) {
			await expect(applyMergeGuests(input(keep, absorb))).rejects.toThrow(
				GUEST_MERGE_CONVERTED_MESSAGE,
			);
		}
		expect(await snapshot([A.id, B.id, C.id, D.id])).toEqual(before);
	});

	it("refuses merging a guest with itself, and a guest of another club, writing nothing", async () => {
		// protects=self-merge and cross-club merge are refused (the other club's guest reads as not found in this club);
		// fails_when=the self check is removed (the guest row would delete itself) or the club scope on the reads is dropped;
		// no_claim=a Person merge across clubs, which stays the superadmin's
		other = await seedClub();
		const A = await mkGuest("Keeper Kay");
		const X = await mkGuest("Elsewhere Eve", {}, other.clubId);
		const before = await snapshot([A.id, X.id]);

		await expect(applyMergeGuests(input(A.id, A.id))).rejects.toThrow(
			GUEST_MERGE_SAME_MESSAGE,
		);
		await expect(applyMergeGuests(input(A.id, X.id))).rejects.toThrow(
			/not found in this club/i,
		);
		await expect(applyMergeGuests(input(X.id, A.id))).rejects.toThrow(
			/not found in this club/i,
		);
		expect(await snapshot([A.id, X.id])).toEqual(before);
	});

	it("refuses a member who is not an admin, and an archived club, writing nothing", async () => {
		// protects=the admin standing and the archive gate are re-asked INSIDE the club lock, so a caller who is not an effective admin, or a club taken down, writes nothing;
		// fails_when=assertStillClubAdmin is removed from the transaction (a plain member or a takedown would merge);
		// no_claim=that the server fn calls requireClubRole first (the guard test pins that)
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		const before = await snapshot([A.id, B.id]);

		await expect(
			applyMergeGuests({
				...input(A.id, B.id),
				actorUserId: seed.memberUserId,
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expect(applyMergeGuests(input(A.id, B.id))).rejects.toThrow(
			CLUB_ARCHIVED_MESSAGE,
		);
		expect(await snapshot([A.id, B.id])).toEqual(before);
	});

	it("writes exactly one guest_merge activity row carrying the two ids and no name, email or phone", async () => {
		// protects=the club-readable feed learns that a merge happened and nothing about the people;
		// fails_when=the row is missing, duplicated, or `detail` gains a name, email or phone;
		// no_claim=how the feed renders it (activity-format.test.ts)
		const tag = randomUUID().slice(0, 8);
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe", {
			email: `abe-${tag}@example.test`,
			phone: "555-777-8888",
		});

		await applyMergeGuests(input(A.id, B.id));

		const rows = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "guest_merge"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.targetType).toBe("club");
		expect(rows[0]?.actorMemberId).toBe(seed.adminMemberId);
		expect(rows[0]?.detail).toEqual({
			keptGuestId: A.id,
			absorbedGuestId: B.id,
		});
		const text = JSON.stringify(rows[0]);
		expect(text).not.toMatch(/Keeper Kay|Absorbed Abe|example\.test|555-/);
	});

	it("previews the same numbers the apply then writes, and the preview changes nothing", async () => {
		// protects=preview and apply run one body, so the numbers cannot diverge; the preview rolls back (guest, Person, attendance, activity row untouched);
		// fails_when=the preview commits, or its counts are computed by a second code path;
		// no_claim=the dialog's wording
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe", {
			email: `p-${randomUUID()}@x.test`,
		});
		const m1 = await mkMeeting(1);
		const m2 = await mkMeeting(2);
		await testDb.insert(meetingAttendance).values([
			{ meetingId: m1, guestId: B.id, status: "present" },
			{ meetingId: m2, guestId: A.id, status: "present" },
			{ meetingId: m2, guestId: B.id, status: "present" },
		]);
		const before = await snapshot([A.id, B.id]);

		const preview = await previewMergeGuests(input(A.id, B.id));

		expect(await snapshot([A.id, B.id])).toEqual(before);
		expect(preview.refusal).toBeNull();
		expect(preview.absorbedPersonDeleted).toBe(true);
		const applied = await applyMergeGuests(input(A.id, B.id));
		expect(applied).toEqual(preview);
		expect(applied.moved.meeting_attendance).toBe(1);
		expect(applied.droppedAsDuplicate.meeting_attendance).toBe(1);
	});

	it("previews a refusal as data, not a throw, and writes nothing", async () => {
		// protects=the dialog can show the refusal text before the admin confirms;
		// fails_when=the preview throws on a refusal or reports refusal: null for a self-merge;
		// no_claim=authorization failures, which do throw
		const A = await mkGuest("Keeper Kay");
		const preview = await previewMergeGuests(input(A.id, A.id));
		expect(preview.refusal).toBe(GUEST_MERGE_SAME_MESSAGE);
		expect(preview.absorbedPersonDeleted).toBe(false);
		expect(await guestRowExists(A.id)).toBe(true);
	});

	it("counts a re-pointed role the keeper's Person can see: the absorbed guest's slot is the keeper's after the merge", async () => {
		// protects=the role slot's assigned guest follows the merge so the meeting still shows the person in their role;
		// fails_when=role_slots.assigned_guest_id is left on the absorbed id (FK violation / nulled slot);
		// no_claim=other tables (first test)
		const A = await mkGuest("Keeper Kay");
		const B = await mkGuest("Absorbed Abe");
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: B.id, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		await applyMergeGuests(input(A.id, B.id));

		const [slot] = await testDb
			.select({ g: roleSlots.assignedGuestId, s: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		expect(slot).toEqual({ g: A.id, s: "claimed" });
	});
});
