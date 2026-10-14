/**
 * DB-backed tests for #1202: undoing a guest conversion deletes the membership
 * the conversion created, and every table whose foreign key to `members` is
 * ON DELETE CASCADE loses its rows in the same statement. `applyUndoGuestConversion`
 * therefore refuses when any of them holds a row for the membership.
 *
 * Beside `guest-pipeline.integration.test.ts` (which covers the older refusals:
 * roles, dues, officer terms, speech requests, speeches, enrolments) rather than
 * in it, to keep this issue to one cited source file.
 *
 * The refusals added by #1202 run only when the undo will delete a membership
 * the conversion created. On the reuse/reactivate path nothing is deleted, so
 * nothing cascades and they must not refuse (a test below pins that).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips when unset.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendancePlan,
	meetingCandidateDisqualifications,
	members,
	mentorshipRequests,
	mentorships,
	officerTrainingRecords,
	people,
	roleFeedbackNotes,
} from "#/db/schema";
import {
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_NOT_CONVERTED_MESSAGE,
} from "#/lib/guest-convert";
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
	UNDO_CASCADE_CHECKS,
	applyConvertGuestToMember,
	applyUndoGuestConversion,
} = await import("#/server/guest-pipeline-logic");

describe.skipIf(!hasTestDb)(
	"undo guest conversion: cascading history (#1202)",
	() => {
		let seed: SeededClub;
		let strayPeople: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			strayPeople = [];
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			if (strayPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, strayPeople));
			}
		});

		/** Through the real convert: the undo replays the record convert writes. */
		async function converted(name: string) {
			const [g] = await testDb
				.insert(guests)
				.values(await withGuestPerson({ clubId: seed.clubId, name }, testDb))
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId: g.id,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);
			return { guestId: g.id, ...res };
		}

		function undo(guestId: string) {
			return applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
		}

		/** Nothing was deleted: the membership is there and the guest is still converted. */
		async function expectMembershipSurvives(
			guestId: string,
			membershipId: string,
		) {
			const [member] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(member?.id).toBe(membershipId);
			const [guest] = await testDb
				.select({ convertedMembershipId: guests.convertedMembershipId })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(guest?.convertedMembershipId).toBe(membershipId);
		}

		it("undoes cleanly when the membership has none of that history", async () => {
			const { guestId, membershipId } = await converted("Clean Undo");
			const res = await undo(guestId);
			expect(res.membershipDeleted).toBe(true);
			const [gone] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, membershipId));
			expect(gone).toBeUndefined();
		});

		it.each([
			"mentor",
			"mentee",
		] as const)("refuses when the member is a %s in a pairing, and keeps the pairing", async (side) => {
			const { guestId, membershipId } = await converted(`Paired ${side}`);
			const [pairing] = await testDb
				.insert(mentorships)
				.values({
					clubId: seed.clubId,
					mentorMemberId: side === "mentor" ? membershipId : seed.memberId,
					menteeMemberId: side === "mentor" ? seed.memberId : membershipId,
				})
				.returning({ id: mentorships.id });
			if (!pairing) throw new Error("Failed to seed mentorship");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("a mentorship"),
			);

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: mentorships.id })
				.from(mentorships)
				.where(eq(mentorships.id, pairing.id));
			expect(stillThere?.id).toBe(pairing.id);
		});

		// protects=a mentor request, either side and any status, refuses the undo
		// with its OWN label ("a mentor request", not "a mentorship") and keeps
		// the request, because the membership delete would cascade it away;
		// fails_when=the request lookup is dropped from the undo's checks (the
		// membership and its requests are deleted), or the refusal reuses the
		// pairing's label;
		// no_claim=the reuse path (the test below), where nothing is deleted
		it.each([
			["mentor", "pending"],
			["mentee", "declined"],
		] as const)("refuses when the member is the %s of a %s mentor request, naming the request", async (side, status) => {
			const { guestId, membershipId } = await converted(`Asked ${side}`);
			const [request] = await testDb
				.insert(mentorshipRequests)
				.values({
					clubId: seed.clubId,
					mentorMemberId: side === "mentor" ? membershipId : seed.memberId,
					menteeMemberId: side === "mentor" ? seed.memberId : membershipId,
					status,
				})
				.returning({ id: mentorshipRequests.id });
			if (!request) throw new Error("Failed to seed mentor request");

			const refusal = await undo(guestId).then(
				() => "",
				(e: Error) => e.message,
			);
			expect(refusal).toBe(UNDO_MEMBER_HAS_HISTORY_MESSAGE("a mentor request"));
			expect(refusal).not.toBe(UNDO_MEMBER_HAS_HISTORY_MESSAGE("a mentorship"));

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: mentorshipRequests.id })
				.from(mentorshipRequests)
				.where(eq(mentorshipRequests.id, request.id));
			expect(stillThere?.id).toBe(request.id);
		});

		it("refuses when the member has an officer training record, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Trained Undo");
			const [record] = await testDb
				.insert(officerTrainingRecords)
				.values({
					membershipId,
					position: "president",
					programYear: 2026,
					period: 1,
				})
				.returning({ id: officerTrainingRecords.id });
			if (!record) throw new Error("Failed to seed training record");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("officer training"),
			);

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: officerTrainingRecords.id })
				.from(officerTrainingRecords)
				.where(eq(officerTrainingRecords.id, record.id));
			expect(stillThere?.id).toBe(record.id);
		});

		it("refuses when the member has received a feedback note, and keeps it", async () => {
			const { guestId, membershipId } = await converted("Noted Undo");
			const [note] = await testDb
				.insert(roleFeedbackNotes)
				.values({
					clubId: seed.clubId,
					meetingId: seed.meetingId,
					recipientMemberId: membershipId,
					roleLabel: "Speaker",
					wentWell: "A clear opening.",
				})
				.returning({ id: roleFeedbackNotes.id });
			if (!note) throw new Error("Failed to seed feedback note");

			// Role feedback notes are readable only by their recipient, so the refusal
			// the admin reads must not reveal that any exist.
			const refusal = await undo(guestId).then(
				() => "",
				(e: Error) => e.message,
			);
			expect(refusal).toBe(UNDO_MEMBER_HAS_HISTORY_MESSAGE("other records"));
			expect(refusal).not.toMatch(/feedback|note/i);

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: roleFeedbackNotes.id })
				.from(roleFeedbackNotes)
				.where(eq(roleFeedbackNotes.id, note.id));
			expect(stillThere?.id).toBe(note.id);
		});

		it.each([
			"coming",
			"reached_out",
		] as const)("refuses when the member has a %s RSVP row (convert writes none), and keeps it", async (status) => {
			const { guestId, membershipId } = await converted(`RSVP ${status} Undo`);
			const [rsvp] = await testDb
				.insert(meetingAttendancePlan)
				.values({
					memberId: membershipId,
					meetingId: seed.meetingId,
					status,
				})
				.returning({ id: meetingAttendancePlan.id });
			if (!rsvp) throw new Error("Failed to seed RSVP");

			// Every status counts, `reached_out` (an officer's outreach) included, so the
			// label says so.
			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("RSVPs or outreach"),
			);

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: meetingAttendancePlan.id })
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.id, rsvp.id));
			expect(stillThere?.id).toBe(rsvp.id);
		});

		it("refuses when the member was ruled out as a candidate, and keeps the record", async () => {
			// Not one of the four the brief named: the drift guard below found it.
			const { guestId, membershipId } = await converted("Disqualified Undo");
			const [dq] = await testDb
				.insert(meetingCandidateDisqualifications)
				.values({
					meetingId: seed.meetingId,
					category: "best_speaker",
					candidateMemberId: membershipId,
					reason: "Was not in the room.",
				})
				.returning({ id: meetingCandidateDisqualifications.id });
			if (!dq) throw new Error("Failed to seed disqualification");

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_HISTORY_MESSAGE("a candidate disqualification"),
			);

			await expectMembershipSurvives(guestId, membershipId);
			const [stillThere] = await testDb
				.select({ id: meetingCandidateDisqualifications.id })
				.from(meetingCandidateDisqualifications)
				.where(eq(meetingCandidateDisqualifications.id, dq.id));
			expect(stillThere?.id).toBe(dq.id);
		});

		it("a conversion onto a REUSED lapsed membership undoes with an RSVP and a mentorship on it, and they survive", async () => {
			// Option A (#1202): the refusals guard the delete, and on the reuse path the
			// undo deletes nothing, so nothing cascades. A lapsed member's old history
			// is not at risk and must not block the undo.
			const email = `lapsed-${randomUUID()}@example.com`;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Lapsed Reuse", email })
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to seed person");
			strayPeople.push(person.id);
			const [lapsed] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: person.id,
					name: "Lapsed Reuse",
					status: "inactive",
				})
				.returning({ id: members.id });
			if (!lapsed) throw new Error("Failed to seed lapsed membership");
			const [rsvp] = await testDb
				.insert(meetingAttendancePlan)
				.values({
					memberId: lapsed.id,
					meetingId: seed.meetingId,
					status: "coming",
				})
				.returning({ id: meetingAttendancePlan.id });
			const [pairing] = await testDb
				.insert(mentorships)
				.values({
					clubId: seed.clubId,
					mentorMemberId: seed.memberId,
					menteeMemberId: lapsed.id,
				})
				.returning({ id: mentorships.id });
			if (!rsvp || !pairing) throw new Error("Failed to seed history");

			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: seed.clubId, name: "Lapsed Reuse Guest" },
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			const guestId = g.id;
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
				confirmedEmail: email,
			});

			const res = await undo(guestId);

			// The reused row was never this conversion's to delete; the undo put the lapse back.
			expect(res.membershipDeleted).toBe(false);
			const [member] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, lapsed.id));
			expect(member?.status).toBe("inactive");
			const [rsvpLeft] = await testDb
				.select({ id: meetingAttendancePlan.id })
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.id, rsvp.id));
			expect(rsvpLeft?.id).toBe(rsvp.id);
			const [pairingLeft] = await testDb
				.select({ id: mentorships.id })
				.from(mentorships)
				.where(eq(mentorships.id, pairing.id));
			expect(pairingLeft?.id).toBe(pairing.id);
		});

		it("still refuses a guest that was never converted", async () => {
			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: seed.clubId, name: `Never ${randomUUID()}` },
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			await expect(undo(g.id)).rejects.toThrow(UNDO_NOT_CONVERTED_MESSAGE);
		});

		it("FK drift guard: every ON DELETE CASCADE foreign key to `members` has a refusal in UNDO_CASCADE_CHECKS, or a written waiver", async () => {
			// The undo's final `delete(members)` silently removes the rows of every
			// table in this set. The list compared here is the one the undo LOOPS OVER,
			// so a key cannot pass on paper without a refusal behind it. A new cascading
			// key to `members` fails this test until an entry lands in
			// `UNDO_CASCADE_CHECKS`, or the key is listed in WAIVED with the reason it
			// needs no refusal. `confdeltype = 'c'` is CASCADE; SET NULL keys keep
			// their rows, so they are not data loss here.
			const WAIVED: Record<string, string> = {
				// "table.column": "one-line reason a delete of the member loses nothing of value",
			};

			for (const [key, reason] of Object.entries(WAIVED)) {
				expect(
					reason.trim().length,
					`waiver ${key} needs a reason`,
				).toBeGreaterThan(0);
			}
			const checked = UNDO_CASCADE_CHECKS.flatMap((c) => c.columns);
			expect(
				checked.filter((k) => k in WAIVED),
				"a key is both checked and waived",
			).toEqual([]);
			expect(new Set(checked).size, "a key is checked twice").toBe(
				checked.length,
			);

			const result = await testDb.execute(sql`
			SELECT con.conrelid::regclass::text AS tbl, a.attname AS col
			FROM pg_constraint con
			CROSS JOIN LATERAL unnest(con.conkey) AS ck(attnum)
			JOIN pg_attribute a
				ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
			WHERE con.contype = 'f'
				AND con.confrelid = 'members'::regclass
				AND con.confdeltype = 'c'`);
			const actual = new Set(
				(result.rows as { tbl: string; col: string }[]).map(
					(r) => `${r.tbl}.${r.col}`,
				),
			);

			expect([...actual].sort()).toEqual(
				[...checked, ...Object.keys(WAIVED)].sort(),
			);
		});
	},
);
