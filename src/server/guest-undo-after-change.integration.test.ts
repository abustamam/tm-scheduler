/**
 * DB-backed tests for #1322: `applyUndoGuestConversion` assumed the membership
 * is exactly as convert left it. Every test here starts from the state a later
 * flow leaves behind, then undoes the conversion:
 *
 *   1. a member merge into the membership (both directions),
 *   2. a second guest linked to it,
 *   3. a row of its own on a SET NULL key the delete would blank, one test per key,
 *   4. a status the admin changed after convert woke the member.
 *
 * Plus the guard over `pg_constraint`: every foreign key to `members` is
 * classified once, in the table the undo reads (`undoKeyPlan`).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips when unset.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guestInvites,
	guests,
	meetingCandidateDisqualifications,
	meetingTimings,
	meetingVoteSessions,
	members,
	mentorshipRequests,
	mentorships,
	pathEnrollments,
	pathwaysPaths,
	pathwaysProjects,
	people,
	projectCompletionMarks,
} from "#/db/schema";
import {
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_MEMBERSHIP_MERGED_MESSAGE,
	UNDO_NO_RECORD_MESSAGE,
	UNDO_OTHER_GUEST_LINKED_MESSAGE,
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
	applyConvertGuestToMember,
	applyLinkGuestToMember,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	captureGuestVisit,
	undoKeyPlan,
} = await import("#/server/guest-pipeline-logic");
const { applyMemberMerge, applySetMemberStatus } = await import(
	"#/server/members-logic"
);
const { mergePeople } = await import("#/server/people-merge-logic");

describe.skipIf(!hasTestDb)(
	"undo guest conversion: what was attached after the convert (#1322)",
	() => {
		let seed: SeededClub;
		let strayPeople: string[] = [];
		let strayPaths: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			strayPeople = [];
			strayPaths = [];
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			if (strayPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, strayPeople));
			}
			if (strayPaths.length > 0) {
				await testDb
					.delete(pathwaysPaths)
					.where(inArray(pathwaysPaths.id, strayPaths));
			}
		});

		async function seedGuest(name: string, extra: { introducedBy?: string } = {}) {
			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{
							clubId: seed.clubId,
							name,
							introducedByMemberId: extra.introducedBy ?? null,
						},
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");
			return g.id;
		}

		/** Through the real convert: the undo replays the record convert writes. */
		async function converted(name: string) {
			const guestId = await seedGuest(name);
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);
			return { guestId, ...res };
		}

		function undo(guestId: string) {
			return applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
		}

		async function refusalOf(guestId: string): Promise<string> {
			return undo(guestId).then(
				() => "",
				(e: Error) => e.message,
			);
		}

		async function guestRow(guestId: string) {
			const [g] = await testDb
				.select({
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			return g;
		}

		async function memberRow(membershipId: string) {
			const [m] = await testDb
				.select({
					id: members.id,
					status: members.status,
					clubRole: members.clubRole,
					endedAt: members.endedAt,
					joinedAt: members.joinedAt,
				})
				.from(members)
				.where(eq(members.id, membershipId));
			return m;
		}

		/** Nothing was written: the membership is there and the guest still points at it. */
		async function expectUntouched(guestId: string, membershipId: string) {
			expect((await memberRow(membershipId))?.id).toBe(membershipId);
			expect((await guestRow(guestId))?.convertedMembershipId).toBe(
				membershipId,
			);
			expect(await undoRecords(membershipId)).toEqual([]);
		}

		async function undoRecords(membershipId: string) {
			return testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, membershipId),
					),
				);
		}

		async function undoDetail(membershipId: string) {
			const [row] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, membershipId),
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			return row?.detail as Record<string, unknown> | undefined;
		}

		/** An older roster row (a person who joined in 2019) for a merge. */
		async function olderMember(name: string) {
			const [p] = await testDb
				.insert(people)
				.values({ name })
				.returning({ id: people.id });
			if (!p) throw new Error("Failed to seed person");
			strayPeople.push(p.id);
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: p.id,
					name,
					joinedAt: new Date("2019-03-01T00:00:00Z"),
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to seed older member");
			return { personId: p.id, membershipId: m.id };
		}

		// ------------------------------------------------------------------
		// 1. A merge into the membership
		// ------------------------------------------------------------------

		describe("a member merge since the convert (item 1)", () => {
			// protects=an undo after the older roster row was merged INTO the
			// converted membership refuses and deletes nothing, and says why;
			// fails_when=the undo replays a conversion record that still matches a
			// membership which now carries a 2019 member (it returned
			// membershipDeleted: true and the merged member left the roster);
			// no_claim=the other merge direction (next test)
			it("refuses when an older member was merged into it, and keeps the merged member", async () => {
				const { guestId, membershipId } = await converted("Merge Keeper");
				const older = await olderMember("Older Member");
				await applyMemberMerge({
					clubId: seed.clubId,
					keeperId: membershipId,
					absorbedId: older.membershipId,
					actorMemberId: seed.adminMemberId,
				});
				// What the merge left on the membership: the older join date.
				expect((await memberRow(membershipId))?.joinedAt?.getFullYear()).toBe(
					2019,
				);

				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);

				await expectUntouched(guestId, membershipId);
				expect((await memberRow(membershipId))?.joinedAt?.getFullYear()).toBe(
					2019,
				);
			});

			// protects=an undo after the converted membership was merged AWAY into an
			// older row refuses and keeps that older row, naming the merge: the
			// conversion's own record went with the absorbed row, so without this the
			// refusal read "happened before undo was available" and advised removing
			// the member from the roster, which would delete the OLDER member;
			// fails_when=the no-record refusal stops looking for a merge;
			// no_claim=that the guest can be freed another way
			it("refuses when it was merged into an older member, and keeps that member", async () => {
				const { guestId, membershipId } = await converted("Merged Away");
				const older = await olderMember("Older Keeper");
				await applyMemberMerge({
					clubId: seed.clubId,
					keeperId: older.membershipId,
					absorbedId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				// The guest followed the merge to the keeper.
				expect((await guestRow(guestId))?.convertedMembershipId).toBe(
					older.membershipId,
				);

				const refusal = await refusalOf(guestId);
				expect(refusal).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);
				expect(refusal).not.toBe(UNDO_NO_RECORD_MESSAGE);

				await expectUntouched(guestId, older.membershipId);
			});

			it("refuses when a Person merge collapsed an older member into it", async () => {
				// The cross-club Person merge reaches `collapseMemberships` too, and
				// logs a person-targeted row, not a membership-targeted one.
				const { guestId, membershipId, personId } =
					await converted("Person Merge Keeper");
				const older = await olderMember("Older Person");
				await mergePeople({
					keeperPersonId: personId,
					absorbedPersonId: older.personId,
				});
				expect((await memberRow(membershipId))?.joinedAt?.getFullYear()).toBe(
					2019,
				);

				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);

				await expectUntouched(guestId, membershipId);
			});

			it("is not fooled by a guest LINK, which logs member_merge against the membership too", async () => {
				// `applyLinkGuestToMember` writes `member_merge` with `targetId` the
				// membership and `detail.fromGuestId`; a member-to-member merge writes
				// `detail.absorbedId`. Link then unlink the other guest, and the
				// conversion undoes: the leftover link row is not a merge.
				const { guestId, membershipId } = await converted("Link Residue");
				const other = await seedGuest("Linked And Gone");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: other,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: other,
					actorMemberId: seed.adminMemberId,
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await memberRow(membershipId)).toBeUndefined();
			});

			it.each([
				["a person-level merge that collapsed no membership", 0, 0],
				["a person-level merge from before the conversion", 1, -3_600_000],
			])("is not refused by %s", async (_label, collapsed, offsetMs) => {
				const { guestId, membershipId, personId } = await converted(
					`Old Person Merge ${collapsed}`,
				);
				await testDb.insert(activityLog).values({
					clubId: seed.clubId,
					action: "member_merge",
					targetType: "person",
					targetId: personId,
					detail: {
						keeperPersonId: personId,
						absorbedPersonId: randomUUID(),
						movedCounts: { collapsed },
					},
					createdAt: new Date(Date.now() + offsetMs),
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await memberRow(membershipId)).toBeUndefined();
			});
		});

		// ------------------------------------------------------------------
		// 2. A second guest linked to the membership
		// ------------------------------------------------------------------

		describe("another guest linked to the membership (item 2)", () => {
			it("refuses, naming the linked guest, and unlinks nobody", async () => {
				const { guestId, membershipId } = await converted("Converted First");
				const other = await seedGuest("Linked Second");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: other,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});

				const refusal = await refusalOf(guestId);

				expect(refusal).toBe(UNDO_OTHER_GUEST_LINKED_MESSAGE(["Linked Second"]));
				expect(refusal).toContain("Linked Second");
				await expectUntouched(guestId, membershipId);
				// The link is exactly as it was: still joined, still pointing here.
				const linked = await guestRow(other);
				expect(linked?.stage).toBe("joined");
				expect(linked?.convertedMembershipId).toBe(membershipId);
			});

			it("names every linked guest", async () => {
				const { guestId, membershipId } = await converted("Converted Many");
				for (const name of ["Zed Linked", "Amy Linked"]) {
					await applyLinkGuestToMember({
						clubId: seed.clubId,
						guestId: await seedGuest(name),
						memberId: membershipId,
						actorMemberId: seed.adminMemberId,
					});
				}

				expect(await refusalOf(guestId)).toBe(
					UNDO_OTHER_GUEST_LINKED_MESSAGE(["Amy Linked", "Zed Linked"]),
				);
				await expectUntouched(guestId, membershipId);
			});

			it("undoes once the other guest is unlinked", async () => {
				const { guestId, membershipId } = await converted("Converted Then Free");
				const other = await seedGuest("Linked Then Unlinked");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: other,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: other,
					actorMemberId: seed.adminMemberId,
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
			});

			// protects=the linked-guest refusal is scoped to the path that DELETES
			// the membership; undoing a convert that reused a membership leaves it
			// standing, so the other guest stays linked and nothing is stranded;
			// fails_when=the check runs on the reuse path too (old history would block
			// an undo that deletes nothing, the #1202 rule);
			// no_claim=that the reused membership's status is restored (item 4 tests)
			it("does not refuse on the reuse path, and the other guest stays linked", async () => {
				const email = `reuse-${randomUUID()}@example.com`;
				const [person] = await testDb
					.insert(people)
					.values({ name: "Reused Member", email })
					.returning({ id: people.id });
				if (!person) throw new Error("Failed to seed person");
				strayPeople.push(person.id);
				const [existing] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: person.id,
						name: "Reused Member",
					})
					.returning({ id: members.id });
				if (!existing) throw new Error("Failed to seed membership");
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Reused Member",
					email,
				});
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
					confirmedEmail: email,
				});
				const other = await seedGuest("Linked To Reused");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: other,
					memberId: existing.id,
					actorMemberId: seed.adminMemberId,
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(false);
				expect((await memberRow(existing.id))?.id).toBe(existing.id);
				expect((await guestRow(other))?.convertedMembershipId).toBe(
					existing.id,
				);
				expect((await guestRow(guestId))?.convertedMembershipId).toBeNull();
			});
		});

		// ------------------------------------------------------------------
		// 3. The SET NULL keys
		// ------------------------------------------------------------------

		describe("keys the delete would blank (item 3)", () => {
			// Keys that refuse: the guest-attribution columns. The row they sit on
			// is a guest's, and "who brought this guest" is worth keeping.
			const REFUSING: {
				key: string;
				label: string;
				seed: (membershipId: string) => Promise<() => Promise<string | null>>;
			}[] = [
				{
					key: "guests.introduced_by_member_id",
					label: "guest introductions",
					seed: async (membershipId) => {
						const id = await seedGuest(`Introduced ${randomUUID()}`, {
							introducedBy: membershipId,
						});
						return async () =>
							(
								await testDb
									.select({ v: guests.introducedByMemberId })
									.from(guests)
									.where(eq(guests.id, id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "guest_invites.invited_by_member_id",
					label: "guest invitations",
					seed: async (membershipId) => {
						const guestId = await seedGuest(`Invited ${randomUUID()}`);
						const [invite] = await testDb
							.insert(guestInvites)
							.values({
								clubId: seed.clubId,
								guestId,
								meetingId: seed.meetingId,
								invitedByMemberId: membershipId,
							})
							.returning({ id: guestInvites.id });
						if (!invite) throw new Error("Failed to seed invite");
						return async () =>
							(
								await testDb
									.select({ v: guestInvites.invitedByMemberId })
									.from(guestInvites)
									.where(eq(guestInvites.id, invite.id))
							)[0]?.v ?? null;
					},
				},
			];

			// Keys that are safe to blank, and are NAMED in the member_remove record.
			const BLANKED: {
				key: string;
				seed: (membershipId: string) => Promise<() => Promise<string | null>>;
			}[] = [
				{
					key: "meeting_timings.recorded_by_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(meetingTimings)
							.values({
								meetingId: seed.meetingId,
								slotId: seed.slotId,
								elapsedSeconds: 61,
								grantedVia: "officer",
								recordedByMemberId: membershipId,
							})
							.returning({ id: meetingTimings.id });
						if (!row) throw new Error("Failed to seed timing");
						return async () =>
							(
								await testDb
									.select({ v: meetingTimings.recordedByMemberId })
									.from(meetingTimings)
									.where(eq(meetingTimings.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "project_completion_marks.marked_by_member_id",
					seed: async (membershipId) => {
						const [path] = await testDb
							.insert(pathwaysPaths)
							.values({
								courseCode: `1322-${randomUUID().slice(0, 8)}`,
								name: "Path",
							})
							.returning({ id: pathwaysPaths.id });
						if (!path) throw new Error("Failed to seed path");
						strayPaths.push(path.id);
						const [enrollment] = await testDb
							.insert(pathEnrollments)
							.values({ personId: seed.personId, pathId: path.id })
							.returning({ id: pathEnrollments.id });
						const [project] = await testDb
							.insert(pathwaysProjects)
							.values({ pathId: path.id, level: 1, name: "Ice Breaker" })
							.returning({ id: pathwaysProjects.id });
						if (!enrollment || !project) throw new Error("Failed to seed path");
						const [row] = await testDb
							.insert(projectCompletionMarks)
							.values({
								enrollmentId: enrollment.id,
								projectId: project.id,
								markedByMemberId: membershipId,
							})
							.returning({ id: projectCompletionMarks.id });
						if (!row) throw new Error("Failed to seed mark");
						return async () =>
							(
								await testDb
									.select({ v: projectCompletionMarks.markedByMemberId })
									.from(projectCompletionMarks)
									.where(eq(projectCompletionMarks.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "meeting_vote_sessions.opened_by_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(meetingVoteSessions)
							.values({
								meetingId: seed.meetingId,
								category: "best_speaker",
								openedByMemberId: membershipId,
							})
							.returning({ id: meetingVoteSessions.id });
						if (!row) throw new Error("Failed to seed vote session");
						return async () =>
							(
								await testDb
									.select({ v: meetingVoteSessions.openedByMemberId })
									.from(meetingVoteSessions)
									.where(eq(meetingVoteSessions.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "mentorships.created_by_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(mentorships)
							.values({
								clubId: seed.clubId,
								mentorMemberId: seed.memberId,
								menteeMemberId: seed.adminMemberId,
								createdByMemberId: membershipId,
							})
							.returning({ id: mentorships.id });
						if (!row) throw new Error("Failed to seed mentorship");
						return async () =>
							(
								await testDb
									.select({ v: mentorships.createdByMemberId })
									.from(mentorships)
									.where(eq(mentorships.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "mentorship_requests.decided_by_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(mentorshipRequests)
							.values({
								clubId: seed.clubId,
								mentorMemberId: seed.memberId,
								menteeMemberId: seed.adminMemberId,
								status: "declined",
								decidedByMemberId: membershipId,
							})
							.returning({ id: mentorshipRequests.id });
						if (!row) throw new Error("Failed to seed request");
						return async () =>
							(
								await testDb
									.select({ v: mentorshipRequests.decidedByMemberId })
									.from(mentorshipRequests)
									.where(eq(mentorshipRequests.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "meeting_candidate_disqualifications.disqualified_by_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(meetingCandidateDisqualifications)
							.values({
								meetingId: seed.meetingId,
								category: "best_speaker",
								candidateMemberId: seed.memberId,
								reason: "Was not in the room.",
								disqualifiedByMemberId: membershipId,
							})
							.returning({ id: meetingCandidateDisqualifications.id });
						if (!row) throw new Error("Failed to seed disqualification");
						return async () =>
							(
								await testDb
									.select({
										v: meetingCandidateDisqualifications.disqualifiedByMemberId,
									})
									.from(meetingCandidateDisqualifications)
									.where(eq(meetingCandidateDisqualifications.id, row.id))
							)[0]?.v ?? null;
					},
				},
				{
					key: "activity_log.actor_member_id",
					seed: async (membershipId) => {
						const [row] = await testDb
							.insert(activityLog)
							.values({
								clubId: seed.clubId,
								actorMemberId: membershipId,
								action: "member_edit",
								targetType: "member",
								targetId: seed.memberId,
								detail: { note: "an act of the member's own" },
							})
							.returning({ id: activityLog.id });
						if (!row) throw new Error("Failed to seed activity row");
						return async () =>
							(
								await testDb
									.select({ v: activityLog.actorMemberId })
									.from(activityLog)
									.where(eq(activityLog.id, row.id))
							)[0]?.v ?? null;
					},
				},
			];

			it.each(
				REFUSING,
			)("refuses while $key points at the membership, and keeps the row as it was", async ({
				key,
				label,
				seed: seedRow,
			}) => {
				const { guestId, membershipId } = await converted(`Refused ${key}`);
				const read = await seedRow(membershipId);

				expect(await refusalOf(guestId)).toBe(
					UNDO_MEMBER_HAS_HISTORY_MESSAGE(label),
				);

				await expectUntouched(guestId, membershipId);
				expect(await read()).toBe(membershipId);
			});

			it.each(
				BLANKED,
			)("blanks $key, and names it in the member_remove record", async ({
				key,
				seed: seedRow,
			}) => {
				const { guestId, membershipId } = await converted(`Blanked ${key}`);
				const read = await seedRow(membershipId);

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await read()).toBeNull();
				const detail = await undoDetail(membershipId);
				expect(detail?.blanked).toEqual({ [key]: 1 });
			});

			it("says nothing about keys it did not blank", async () => {
				const { guestId, membershipId } = await converted("Nothing Blanked");

				await undo(guestId);

				expect(await undoDetail(membershipId)).not.toHaveProperty("blanked");
			});

			// protects=the guest-attribution refusals and the blank counts run only
			// when the undo deletes the membership; on the reuse path the row stays,
			// so nothing is blanked and nothing is named;
			// fails_when=the key checks lose their `created` scope (an old introduction
			// would block an undo that deletes nothing);
			// no_claim=the created path (the tests above)
			it("does not look at them on the reuse path, where nothing is deleted", async () => {
				const email = `keys-${randomUUID()}@example.com`;
				const [person] = await testDb
					.insert(people)
					.values({ name: "Keys Reuse", email })
					.returning({ id: people.id });
				if (!person) throw new Error("Failed to seed person");
				strayPeople.push(person.id);
				const [existing] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: person.id,
						name: "Keys Reuse",
					})
					.returning({ id: members.id });
				if (!existing) throw new Error("Failed to seed membership");
				const introduced = await seedGuest("Introduced By Reused", {
					introducedBy: existing.id,
				});
				const read = await BLANKED[0]?.seed(existing.id);
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Keys Reuse",
					email,
				});
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
					confirmedEmail: email,
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(false);
				expect(await read?.()).toBe(existing.id);
				const [stillIntroduced] = await testDb
					.select({ v: guests.introducedByMemberId })
					.from(guests)
					.where(eq(guests.id, introduced));
				expect(stillIntroduced?.v).toBe(existing.id);
				expect(await undoDetail(existing.id)).not.toHaveProperty("blanked");
			});
		});

		// ------------------------------------------------------------------
		// 4. Status written after the convert woke the member
		// ------------------------------------------------------------------

		describe("a status the admin changed after the convert woke the member (item 4)", () => {
			async function lapsed(
				name: string,
				fields: {
					status: "inactive" | "former";
					endedAt?: string;
					clubRole?: "admin" | "member";
				},
			) {
				const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID()}@example.com`;
				const [p] = await testDb
					.insert(people)
					.values({ name, email })
					.returning({ id: people.id });
				if (!p) throw new Error("Failed to seed person");
				strayPeople.push(p.id);
				const [m] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: p.id,
						name,
						status: fields.status,
						endedAt: fields.endedAt ?? null,
						clubRole: fields.clubRole ?? "member",
					})
					.returning({ id: members.id });
				if (!m) throw new Error("Failed to seed lapsed member");
				return { membershipId: m.id, email };
			}

			async function wake(name: string, email: string) {
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name,
					email,
				});
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
					confirmedEmail: email,
				});
				return guestId;
			}

			function setStatus(
				membershipId: string,
				status: "active" | "inactive" | "former",
			) {
				return applySetMemberStatus({
					clubId: seed.clubId,
					memberId: membershipId,
					status,
					actorMemberId: seed.adminMemberId,
				});
			}

			// protects=convert wakes an inactive member, an admin ends the
			// membership, and the undo no longer writes `inactive` over it: the guest
			// is detached and the status the admin chose stands, `ended_at` included;
			// fails_when=the restore is unconditional (it left `status: inactive` with
			// `ended_at` populated, a row applySetMemberStatus never produces);
			// no_claim=what happens when the admin changed it back to active
			it("leaves an ended membership ended, and detaches the guest", async () => {
				const { membershipId, email } = await lapsed("Ended After Wake", {
					status: "inactive",
				});
				const guestId = await wake("Ended After Wake", email);
				expect((await memberRow(membershipId))?.status).toBe("active");
				await setStatus(membershipId, "former");
				const ended = (await memberRow(membershipId))?.endedAt;
				expect(ended).toBeTruthy();

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(false);
				const after = await memberRow(membershipId);
				expect(after?.status).toBe("former");
				expect(after?.endedAt).toBe(ended);
				const g = await guestRow(guestId);
				expect(g?.stage).toBe("following_up");
				expect(g?.convertedMembershipId).toBeNull();
				const detail = await undoDetail(membershipId);
				expect(detail).not.toHaveProperty("statusRestoredTo");
				expect(detail?.statusLeftAs).toBe("former");
			});

			it("does not overwrite a newer ended_at with the stale one", async () => {
				const { membershipId, email } = await lapsed("Ended Twice", {
					status: "former",
					endedAt: "2020-01-15",
				});
				const guestId = await wake("Ended Twice", email);
				expect((await memberRow(membershipId))?.endedAt).toBeNull();
				await setStatus(membershipId, "former");
				const ended = (await memberRow(membershipId))?.endedAt;
				expect(ended).toBeTruthy();
				expect(ended).not.toBe("2020-01-15");

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("former");
				expect(after?.endedAt).toBe(ended);
			});

			it("leaves a membership the admin set inactive alone, and the demoted role with it", async () => {
				const { membershipId, email } = await lapsed("Inactive Again", {
					status: "inactive",
					clubRole: "admin",
				});
				const guestId = await wake("Inactive Again", email);
				expect((await memberRow(membershipId))?.clubRole).toBe("member");
				await setStatus(membershipId, "inactive");

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("inactive");
				// Convert wrote the role down; an undo that restored it onto a row it
				// otherwise leaves alone would be a promotion the admin never made.
				expect(after?.clubRole).toBe("member");
				const detail = await undoDetail(membershipId);
				expect(detail).not.toHaveProperty("clubRoleRestoredTo");
			});

			it("still puts the lapse back while the membership is active", async () => {
				const { membershipId, email } = await lapsed("Still Active", {
					status: "inactive",
					clubRole: "admin",
				});
				const guestId = await wake("Still Active", email);

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("inactive");
				expect(after?.clubRole).toBe("admin");
				expect(after?.endedAt).toBeNull();
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail).not.toHaveProperty("statusLeftAs");
			});

			it("still puts a former membership's end date back while it is active", async () => {
				const { membershipId, email } = await lapsed("Former Active", {
					status: "former",
					endedAt: "2020-01-15",
				});
				const guestId = await wake("Former Active", email);

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("former");
				expect(after?.endedAt).toBe("2020-01-15");
			});

			// protects=an undo that restores `inactive` clears `ended_at`, whatever
			// the row carried: `inactive` with an end date is a state no writer makes;
			// fails_when=the restore writes the status and leaves `ended_at` alone;
			// no_claim=how a row came to carry one while active
			it("clears ended_at whenever the restored status is not former", async () => {
				const { membershipId, email } = await lapsed("Stray End Date", {
					status: "inactive",
				});
				const guestId = await wake("Stray End Date", email);
				await testDb
					.update(members)
					.set({ endedAt: "2024-06-01" })
					.where(eq(members.id, membershipId));

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("inactive");
				expect(after?.endedAt).toBeNull();
			});
		});
	},
);

// ----------------------------------------------------------------------------
// The enumeration guard
// ----------------------------------------------------------------------------

describe.skipIf(!hasTestDb)(
	"undo guest conversion: every foreign key to members is classified (#1322)",
	() => {
		// The keys item 3 classed as safe to blank. A key whose column says who
		// did something (`*_by_member_id`, `actor_member_id`) lands in this class on
		// its own, so a NEW one fails the equality below until it is added here on
		// purpose: the human decision the guard exists to force.
		const EXPECTED_BLANK = [
			"activity_log.actor_member_id",
			"meeting_candidate_disqualifications.disqualified_by_member_id",
			"meeting_timings.recorded_by_member_id",
			"meeting_vote_sessions.opened_by_member_id",
			"mentorship_requests.decided_by_member_id",
			"mentorships.created_by_member_id",
			"project_completion_marks.marked_by_member_id",
		];

		async function liveKeys() {
			const result = await testDb.execute(sql`
				SELECT con.conrelid::regclass::text AS tbl, a.attname AS col
				FROM pg_constraint con
				CROSS JOIN LATERAL unnest(con.conkey) AS ck(attnum)
				JOIN pg_attribute a
					ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
				WHERE con.contype = 'f'
					AND con.confrelid = 'members'::regclass`);
			return (result.rows as { tbl: string; col: string }[]).map(
				(r) => `${r.tbl}.${r.col}`,
			);
		}

		it("classifies exactly the foreign keys `pg_constraint` has, whatever their ON DELETE", async () => {
			// ALL of them, not the CASCADE subset the older drift guard reads: a SET
			// NULL key is blanked by the undo's delete, and was the half nobody
			// listed. `guest-undo-cascade.integration.test.ts` still pins the cascade
			// list against its own refusals.
			const { classes } = undoKeyPlan();
			expect([...classes.keys()].sort()).toEqual((await liveKeys()).sort());
		});

		it("gives every key a class the undo can act on", () => {
			const { classes } = undoKeyPlan();
			for (const [key, cls] of classes) {
				switch (cls.kind) {
					case "refuse":
						expect(cls.check.label.length, `${key} refusal label`).toBeGreaterThan(
							0,
						);
						expect(cls.check.columns, key).toContain(key);
						break;
					case "blank":
						expect(`${cls.table}`, key).toBeTruthy();
						break;
					case "handled":
						expect(cls.by.trim().length, `${key} needs a reason`).toBeGreaterThan(
							0,
						);
						break;
					case "deferred":
						expect(cls.issue, `${key} names its issue`).toBeGreaterThan(0);
						expect(cls.reason.trim().length, key).toBeGreaterThan(0);
						break;
				}
			}
		});

		it("runs every refusal the table names, and only those", () => {
			const { classes, refusals } = undoKeyPlan();
			const named = new Set(
				[...classes.values()].flatMap((c) => (c.kind === "refuse" ? [c.check] : [])),
			);
			expect(new Set(refusals)).toEqual(named);
			expect(refusals.length, "a check runs once").toBe(named.size);
		});

		it("holds the blank class to the keys it was reviewed for", () => {
			const { classes } = undoKeyPlan();
			const blank = [...classes.entries()]
				.filter(([, c]) => c.kind === "blank")
				.map(([k]) => k)
				.sort();
			expect(blank).toEqual(EXPECTED_BLANK);
		});

		it("leaves the ballot keys to #1323, which decides what a vote does", () => {
			const { classes } = undoKeyPlan();
			for (const key of [
				"meeting_votes.candidate_member_id",
				"meeting_votes.voter_member_id",
			]) {
				const cls = classes.get(key);
				expect(cls?.kind, key).toBe("deferred");
				expect(cls?.kind === "deferred" ? cls.issue : 0).toBe(1323);
			}
		});

		// protects=the item 3 keys the issue named are refused or blanked, none
		// left to the old silent blank;
		// fails_when=guests.introduced_by_member_id or guest_invites.invited_by_member_id
		// is dropped from the table (the delete blanks "who brought this guest");
		// no_claim=the per-key behaviour (the item 3 tests above)
		it("refuses the two guest-attribution keys", () => {
			const { classes } = undoKeyPlan();
			for (const key of [
				"guests.introduced_by_member_id",
				"guest_invites.invited_by_member_id",
			]) {
				expect(classes.get(key)?.kind, key).toBe("refuse");
			}
		});
	},
);
