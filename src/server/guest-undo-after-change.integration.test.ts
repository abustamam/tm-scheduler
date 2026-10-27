/**
 * DB-backed tests for #1322: `applyUndoGuestConversion` assumed the membership
 * is exactly as convert left it. Every test here starts from the state a later
 * flow leaves behind, then undoes the conversion:
 *
 *   1. a member merge into the membership (both directions, and a chain of
 *      Person merges that moves it to another Person),
 *   2. a second guest linked to it,
 *   3. a row of its own on a SET NULL key the delete would blank, one test per key,
 *   4. a status the admin changed after convert woke the member, or another
 *      guest that now depends on it,
 *   5. a status or role the admin changed after convert CREATED the membership.
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
	JOIN_DATE_MARGIN_MS,
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_MEMBERSHIP_EDITED_MESSAGE,
	UNDO_MEMBERSHIP_MERGED_MESSAGE,
	UNDO_NO_RECORD_MESSAGE,
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
	buildUndoKeyPlan,
	captureGuestVisit,
	UNDO_DEFERRED_KEYS,
	UNDO_HANDLED_KEYS,
	undoKeyPlan,
} = await import("#/server/guest-pipeline-logic");
const {
	applyMemberEdit,
	applyMemberMerge,
	applySetMemberRole,
	applySetMemberStatus,
} = await import("#/server/members-logic");
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

		async function seedGuest(
			name: string,
			extra: { introducedBy?: string } = {},
		) {
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

		/**
		 * An older roster row (a person who joined in 2019) for a merge. `joinedAt:
		 * null` is a row with no join date, which a merge folds in without moving the
		 * keeper's, so only the audit log can say it happened.
		 */
		async function olderMember(
			name: string,
			joinedAt: Date | null = new Date("2019-03-01T00:00:00Z"),
		) {
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
					joinedAt,
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to seed older member");
			return { personId: p.id, membershipId: m.id };
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

		function setRole(membershipId: string, clubRole: "admin" | "member") {
			return applySetMemberRole({
				clubId: seed.clubId,
				memberId: membershipId,
				clubRole,
				actorMemberId: seed.adminMemberId,
			});
		}

		/**
		 * Moves the membership `personId` holds up `depth` Person merges, each into a
		 * fresh Person that holds nothing here: the membership follows, nothing
		 * collapses, and every merge logs `collapsed: 0` on the Person it ends
		 * with. Returns the Person the membership names at the end.
		 */
		async function moveMembershipUp(personId: string, depth: number) {
			let current = personId;
			for (let i = 0; i < depth; i++) {
				const [next] = await testDb
					.insert(people)
					.values({ name: `Chain Elsewhere ${i} ${randomUUID()}` })
					.returning({ id: people.id });
				if (!next) throw new Error("Failed to seed person");
				strayPeople.push(next.id);
				const merged = await mergePeople({
					keeperPersonId: next.id,
					absorbedPersonId: current,
				});
				expect(merged.movedCounts.collapsed).toBe(0);
				current = next.id;
			}
			return current;
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
				const { guestId, membershipId, personId } = await converted(
					"Person Merge Keeper",
				);
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

			// protects=the audit-log witness on its own: a member with NO join date
			// merged into the converted membership leaves the keeper's join date where
			// convert put it (the merge keeps the earliest known), so the join-date
			// check sees nothing and the `member_merge` row is the only evidence, for
			// the within-club merge and for the Person merge alike;
			// fails_when=the created path stops reading the audit log and trusts the
			// join date (the other refusals in this block all merge a 2019 row, which
			// the join-date check also catches);
			// no_claim=that this member's history is worth keeping beyond the roster row
			it.each([
				[
					"a within-club merge",
					async (ids: { membershipId: string; personId: string }) => {
						const dup = await olderMember("No Date Dup", null);
						await applyMemberMerge({
							clubId: seed.clubId,
							keeperId: ids.membershipId,
							absorbedId: dup.membershipId,
							actorMemberId: seed.adminMemberId,
						});
					},
				],
				[
					"a Person merge",
					async (ids: { membershipId: string; personId: string }) => {
						const dup = await olderMember("No Date Person Dup", null);
						await mergePeople({
							keeperPersonId: ids.personId,
							absorbedPersonId: dup.personId,
						});
					},
				],
			])("refuses after %s that left the join date alone", async (label, merge) => {
				const { guestId, membershipId, personId } = await converted(
					`No Date ${label}`,
				);
				const before = (await memberRow(membershipId))?.joinedAt;

				await merge({ membershipId, personId });

				expect((await memberRow(membershipId))?.joinedAt).toEqual(before);
				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);
				await expectUntouched(guestId, membershipId);
			});

			// protects=the Person-merge "away" direction: the converted Person is
			// ABSORBED, its membership collapses into the older keeper's, the
			// conversion's record goes with it, and the undo refuses naming the merge
			// (the no-record branch) and deletes nothing, the keeper included;
			// fails_when=that branch stops looking at the keeper Person's merge row, or
			// falls back to the roster-removal advice that would delete the keeper;
			// no_claim=the within-club away direction (the test above)
			it("refuses when a Person merge absorbed the converted Person into an older one", async () => {
				const { guestId, membershipId, personId } =
					await converted("Person Merged Away");
				const older = await olderMember("Older Person Keeper");
				const merged = await mergePeople({
					keeperPersonId: older.personId,
					absorbedPersonId: personId,
				});
				expect(merged.movedCounts.collapsed).toBe(1);
				// The conversion's membership is gone into the older keeper's, which the
				// guest now points at.
				expect(await memberRow(membershipId)).toBeUndefined();
				expect((await guestRow(guestId))?.convertedMembershipId).toBe(
					older.membershipId,
				);

				const refusal = await refusalOf(guestId);

				expect(refusal).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);
				expect(refusal).not.toBe(UNDO_NO_RECORD_MESSAGE);
				await expectUntouched(guestId, older.membershipId);
			});

			// protects=a chain of two Person merges (the first folds an older member
			// into the converted membership, the second moves the membership to a
			// third Person) is read through the Person lineage: the row that says
			// "collapsed" targets the Person the membership no longer names, and the
			// row on the Person it ends with says `collapsed: 0`; the undo refuses
			// and the member stays. The absorbed row's join date shows nothing the
			// join-date check can use (no date, or six hours before the conversion,
			// inside its one-day margin), so only the lineage walk can say so;
			// fails_when=the walk reads only the membership's CURRENT Person (it
			// returned membershipDeleted: true and the older admin left the roster);
			// no_claim=the join-date witness (the set-back test below)
			it.each([
				["no join date", null],
				["a join date six hours before the conversion", 6 * 3_600_000],
			])("refuses after two Person merges in a row when the older member had %s", async (_label, hoursAgoMs) => {
				const { guestId, membershipId, personId } = await converted(
					`Chain Keeper ${hoursAgoMs}`,
				);
				const before = (await memberRow(membershipId))?.joinedAt;
				const older = await olderMember(
					`Chain Older ${hoursAgoMs}`,
					hoursAgoMs === null ? null : new Date(Date.now() - hoursAgoMs),
				);
				const first = await mergePeople({
					keeperPersonId: personId,
					absorbedPersonId: older.personId,
				});
				expect(first.movedCounts.collapsed).toBe(1);
				const elsewhere = await moveMembershipUp(personId, 1);
				const moved = await testDb
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, membershipId));
				expect(moved[0]?.personId).toBe(elsewhere);
				// The join date is within the margin the join-date check allows.
				const joinedAt = (await memberRow(membershipId))?.joinedAt;
				if (hoursAgoMs === null) expect(joinedAt).toEqual(before);
				else
					expect(joinedAt?.getTime()).toBeGreaterThan(
						Date.now() - JOIN_DATE_MARGIN_MS,
					);

				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);

				await expectUntouched(guestId, membershipId);
			});

			// protects=the walk goes further than one hop: three Person merges in a
			// row, the collapse only in the first, the two after it moving the
			// membership on without collapsing anything, still refuse;
			// fails_when=the walk stops after the first level of absorbed Persons;
			// no_claim=that a chain this long is common
			it("refuses after three Person merges in a row, the collapse in the first", async () => {
				const { guestId, membershipId, personId } =
					await converted("Chain Of Three");
				const older = await olderMember("Chain Of Three Older", null);
				const first = await mergePeople({
					keeperPersonId: personId,
					absorbedPersonId: older.personId,
				});
				expect(first.movedCounts.collapsed).toBe(1);
				await moveMembershipUp(personId, 2);

				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_MERGED_MESSAGE);

				await expectUntouched(guestId, membershipId);
			});

			// protects=the walk is not a blanket refusal: a lineage whose every row
			// says `collapsed: 0` (the membership only moved between Persons) is
			// undone as usual;
			// fails_when=any person-targeted merge row in the lineage refuses;
			// no_claim=that a merge into another Person is harmless for a reused row
			it("does not refuse after Person merges that collapsed nothing", async () => {
				const { guestId, membershipId, personId } =
					await converted("Chain Of Nothing");
				await moveMembershipUp(personId, 2);

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await memberRow(membershipId)).toBeUndefined();
			});

			// protects=the join-date check does not refuse an ordinary conversion: a
			// membership stamped at the conversion, or an hour off it (app clock
			// against database clock), is undone;
			// fails_when=the margin is dropped so any join date before the record's
			// timestamp refuses;
			// no_claim=the refusal side (the chain test above)
			it.each([
				["just converted", 0],
				["an hour before the conversion record", 3_600_000],
				["an hour after it", -3_600_000],
			])("does not refuse a membership joined %s", async (_label, offsetMs) => {
				const { guestId, membershipId } = await converted(
					`Join Margin ${offsetMs}`,
				);
				const [made] = await testDb
					.select({ joinedAt: members.joinedAt })
					.from(members)
					.where(eq(members.id, membershipId));
				expect(made?.joinedAt).toBeTruthy();
				if (offsetMs !== 0 && made?.joinedAt) {
					await testDb
						.update(members)
						.set({ joinedAt: new Date(made.joinedAt.getTime() - offsetMs) })
						.where(eq(members.id, membershipId));
				}

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await memberRow(membershipId)).toBeUndefined();
			});

			// protects=a join date set back by days refuses even when no merge is
			// logged: the safe side, as the comment on the check says (an admin who
			// edited the date backwards looks the same as a merge);
			// fails_when=the check is limited to rows the log also names;
			// no_claim=that this is always a merge
			it("refuses a membership whose join date was set back days before the conversion", async () => {
				const { guestId, membershipId } = await converted("Join Set Back");
				await testDb
					.update(members)
					.set({ joinedAt: new Date(Date.now() - 3 * 24 * 3_600_000) })
					.where(eq(members.id, membershipId));

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

			// protects=the lineage walk reads a person-targeted row that lacks the
			// fields it looks for (no `movedCounts`, no absorbed Person, or no detail
			// at all) as "nothing collapsed, nobody absorbed" and neither throws nor
			// refuses;
			// fails_when=the reader trusts the shape (a missing `movedCounts` throws
			// out of the undo, or counts as a collapse);
			// no_claim=that any writer produces such a row today
			it.each([
				["no movedCounts", { keeperPersonId: "k", absorbedPersonId: "a" }],
				["no detail", null],
			])("is not refused, and does not throw, on a person-targeted row with %s", async (_label, detail) => {
				const { guestId, membershipId, personId } = await converted(
					`Odd Person Row ${_label}`,
				);
				await testDb.insert(activityLog).values({
					clubId: seed.clubId,
					action: "member_merge",
					targetType: "person",
					targetId: personId,
					detail,
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

				expect(refusal).toMatch(
					/^Linked Second is linked to this member too, .*Unlink them, or undo their conversion, first\.$/,
				);
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

				// Sorted by name, whatever order they were linked in.
				expect(await refusalOf(guestId)).toMatch(
					/^Amy Linked and Zed Linked are linked to this member too, /,
				);
				await expectUntouched(guestId, membershipId);
			});

			it("undoes once the other guest is unlinked", async () => {
				const { guestId, membershipId } = await converted(
					"Converted Then Free",
				);
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
				return { membershipId: m.id, personId: p.id, email };
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

			/** The undo wrote nothing to the member: the guest is detached, the record says why. */
			async function expectLeftAlone(
				guestId: string,
				membershipId: string,
				because: "not_active" | "other_guest" | "changed_since",
				leftAs: "active" | "inactive" | "former",
			) {
				const g = await guestRow(guestId);
				expect(g?.stage).toBe("following_up");
				expect(g?.convertedMembershipId).toBeNull();
				const detail = await undoDetail(membershipId);
				expect(detail?.membershipDeleted).toBe(false);
				expect(detail).not.toHaveProperty("statusRestoredTo");
				expect(detail).not.toHaveProperty("clubRoleRestoredTo");
				expect(detail?.statusLeftAs).toBe(leftAs);
				expect(detail?.leftBecause).toBe(because);
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
				await expectLeftAlone(guestId, membershipId, "not_active", "former");
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
				await expectLeftAlone(guestId, membershipId, "not_active", "former");
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
				await expectLeftAlone(guestId, membershipId, "not_active", "inactive");
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
				expect(detail?.clubRoleRestoredTo).toBe("admin");
				expect(detail).not.toHaveProperty("statusLeftAs");
				expect(detail).not.toHaveProperty("leftBecause");
			});

			// protects=an edit that touches none of status, role or end date (a rename)
			// does not stop the undo putting the lapse back, so the gate is not "any
			// member_edit";
			// fails_when=the filter on the member_edit detail is dropped and every
			// edit counts;
			// no_claim=the edits that do count (the tests below)
			it("still puts the lapse back after an edit that changes neither status, role nor end date", async () => {
				const { membershipId, email } = await lapsed("Renamed After Wake", {
					status: "inactive",
					clubRole: "admin",
				});
				const guestId = await wake("Renamed After Wake", email);
				await applyMemberEdit({
					clubId: seed.clubId,
					memberId: membershipId,
					name: "Renamed After Wake Two",
					actorMemberId: seed.adminMemberId,
				});

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("inactive");
				expect(after?.clubRole).toBe("admin");
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail).not.toHaveProperty("leftBecause");
			});

			// protects=an admin who ended the woken membership and then re-activated
			// it made a newer decision that happens to read `active`, like the convert
			// left it; the undo leaves it active and does not write the stale prior
			// status and end date over it (it wrote `former` and the 2020 date);
			// fails_when=the status-edit clause of the changed-since gate is dropped
			// and `active` alone counts as untouched;
			// no_claim=the merge clauses (next tests)
			it("leaves a membership alone that was ended and then re-activated", async () => {
				const { membershipId, email } = await lapsed("Ended Reactivated", {
					status: "former",
					endedAt: "2020-01-15",
				});
				const guestId = await wake("Ended Reactivated", email);
				await setStatus(membershipId, "former");
				await setStatus(membershipId, "active");
				expect((await memberRow(membershipId))?.status).toBe("active");

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(false);
				const after = await memberRow(membershipId);
				expect(after?.status).toBe("active");
				expect(after?.endedAt).toBeNull();
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=the same for the role: an admin who promoted the woken member
			// and then deliberately demoted them again keeps that decision, and the
			// recorded prior role (admin) is not written back;
			// fails_when=the role edit is not among the edits the gate counts;
			// no_claim=what happens to a role nobody touched (the lapse test above)
			it("leaves a role alone that an admin promoted and then demoted", async () => {
				const { membershipId, email } = await lapsed("Role Flip", {
					status: "inactive",
					clubRole: "admin",
				});
				const guestId = await wake("Role Flip", email);
				expect((await memberRow(membershipId))?.clubRole).toBe("member");
				await setRole(membershipId, "admin");
				await setRole(membershipId, "member");

				await undo(guestId);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("active");
				expect(after?.clubRole).toBe("member");
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=the status clause on its own: an inactive-then-active flip logs
			// `after.status` and no end date (only an edit that ends or reopens a
			// membership logs one), so it is the case the other clauses cannot catch;
			// fails_when=the status clause is dropped from the gate;
			// no_claim=an end-date edit (the next test)
			it("leaves a membership alone that was set inactive and then active again", async () => {
				const { membershipId, email } = await lapsed("Inactive Flip", {
					status: "inactive",
				});
				const guestId = await wake("Inactive Flip", email);
				await setStatus(membershipId, "inactive");
				await setStatus(membershipId, "active");

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("active");
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=an edit that writes only the end date counts, whatever else it
			// does: today `applySetMemberStatus` always logs `after.status` beside
			// `endedAt`, so the row is written by hand in the shape its detail has;
			// fails_when=the end-date clause is dropped from the gate (a future writer
			// that corrects an end date without a status change would slip past it);
			// no_claim=that any writer logs this today
			it("counts an edit that wrote only the end date", async () => {
				const { membershipId, email } = await lapsed("End Date Only", {
					status: "inactive",
				});
				const guestId = await wake("End Date Only", email);
				await testDb.insert(activityLog).values({
					clubId: seed.clubId,
					action: "member_edit",
					targetType: "member",
					targetId: membershipId,
					detail: { endedAt: { before: null, after: "2024-06-01" } },
				});

				await undo(guestId);

				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=an admin's status edit from BEFORE the convert does not stop the
			// restore: the edit clause is bounded by the conversion record's date;
			// fails_when=the gate loses its lower bound and any status edit ever
			// logged on the membership counts;
			// no_claim=an edit after the convert (the tests above)
			it("still puts the lapse back when the status edit was before the convert", async () => {
				const { membershipId, email } = await lapsed("Edited Before Wake", {
					status: "inactive",
				});
				await setStatus(membershipId, "former");
				await setStatus(membershipId, "inactive");
				const guestId = await wake("Edited Before Wake", email);

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("inactive");
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail).not.toHaveProperty("leftBecause");
			});

			// protects=an active duplicate merged into the woken membership brings its
			// own status; the undo does not set the merged member inactive (it did);
			// fails_when=the within-club merge arm is dropped from the changed-since
			// gate on the reuse path;
			// no_claim=the Person-level merge (next test)
			it("leaves a membership alone that an active duplicate was merged into", async () => {
				const { membershipId, email } = await lapsed("Merged Into Woken", {
					status: "inactive",
				});
				const guestId = await wake("Merged Into Woken", email);
				const dup = await olderMember("Merged Dup");
				await applyMemberMerge({
					clubId: seed.clubId,
					keeperId: membershipId,
					absorbedId: dup.membershipId,
					actorMemberId: seed.adminMemberId,
				});
				expect((await memberRow(membershipId))?.status).toBe("active");

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(false);
				expect((await memberRow(membershipId))?.status).toBe("active");
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			it("leaves a membership alone that a Person merge collapsed a duplicate into", async () => {
				const { membershipId, personId, email } = await lapsed(
					"Person Merged Woken",
					{ status: "inactive" },
				);
				const guestId = await wake("Person Merged Woken", email);
				const dup = await olderMember("Person Merged Dup");
				const merged = await mergePeople({
					keeperPersonId: personId,
					absorbedPersonId: dup.personId,
				});
				expect(merged.movedCounts.collapsed).toBe(1);

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("active");
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=a merge that happened BEFORE the convert does not stop the
			// restore: the gate is bounded by the conversion record's date;
			// fails_when=the changed-since gate loses its lower bound and any merge
			// ever logged on the membership counts;
			// no_claim=a merge after the convert (the tests above)
			it("still puts the lapse back when the merge was before the convert", async () => {
				const { membershipId, email } = await lapsed("Merged Before Wake", {
					status: "inactive",
				});
				const dup = await olderMember("Merged Before Dup");
				await applyMemberMerge({
					clubId: seed.clubId,
					keeperId: membershipId,
					absorbedId: dup.membershipId,
					actorMemberId: seed.adminMemberId,
				});
				// The merge folded the active duplicate in; put the lapse back by hand,
				// as it would have been when the convert ran.
				await testDb
					.update(members)
					.set({ status: "inactive" })
					.where(eq(members.id, membershipId));
				const guestId = await wake("Merged Before Wake", email);

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("inactive");
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail).not.toHaveProperty("leftBecause");
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

			// protects=a chain of two Person merges (the first collapses an active
			// duplicate into the woken membership, the second moves the membership to
			// another Person) still stops the restore: the row that says "collapsed"
			// targets a Person the membership no longer names, and the reuse path has
			// no join-date fallback, so the lineage walk is the only witness;
			// fails_when=the walk reads only the membership's CURRENT Person (the
			// undo wrote `inactive` over the merged, active member);
			// no_claim=the created path (the item 1 chain tests)
			it("leaves a membership alone after two Person merges, the first collapsing a duplicate", async () => {
				const { membershipId, personId, email } = await lapsed("Chain Woken", {
					status: "inactive",
				});
				const guestId = await wake("Chain Woken", email);
				const dup = await olderMember("Chain Woken Dup");
				const first = await mergePeople({
					keeperPersonId: personId,
					absorbedPersonId: dup.personId,
				});
				expect(first.movedCounts.collapsed).toBe(1);
				const elsewhere = await moveMembershipUp(personId, 1);
				const [moved] = await testDb
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, membershipId));
				expect(moved?.personId).toBe(elsewhere);

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("active");
				await expectLeftAlone(guestId, membershipId, "changed_since", "active");
			});

			// protects=the lineage walk does not skip a legitimate restore: Person
			// merges that only moved the woken membership (nothing collapsed) leave
			// the lapse to be put back;
			// fails_when=any person-targeted merge row in the lineage stops the restore;
			// no_claim=a merge that collapsed something (the test above)
			it("still puts the lapse back after Person merges that collapsed nothing", async () => {
				const { membershipId, personId, email } = await lapsed("Moved Woken", {
					status: "inactive",
				});
				const guestId = await wake("Moved Woken", email);
				await moveMembershipUp(personId, 2);

				await undo(guestId);

				expect((await memberRow(membershipId))?.status).toBe("inactive");
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail).not.toHaveProperty("leftBecause");
			});

			/**
			 * A second guest converted onto the same membership: its Person carries the
			 * member's address, so convert dedupes onto the existing row (the reuse
			 * branch) and, the membership already being active, writes no status.
			 */
			async function convertedOnto(name: string, email: string) {
				const [g] = await testDb
					.insert(guests)
					.values(
						await withGuestPerson({ clubId: seed.clubId, name, email }, testDb),
					)
					.returning({ id: guests.id });
				if (!g) throw new Error("Failed to seed guest");
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: g.id,
					actorMemberId: seed.adminMemberId,
					confirmedEmail: email,
				});
				return g.id;
			}

			/** What undoing the first guest left: the member exactly as the second guest needs it. */
			async function expectKeptForOtherGuest(
				firstGuestId: string,
				otherGuestId: string,
				membershipId: string,
			) {
				const after = await memberRow(membershipId);
				expect(after?.status).toBe("active");
				expect(after?.endedAt).toBeNull();
				// Convert wrote the role down; the undo does not put it back either.
				expect(after?.clubRole).toBe("member");
				const other = await guestRow(otherGuestId);
				expect(other?.stage).toBe("joined");
				expect(other?.convertedMembershipId).toBe(membershipId);
				await expectLeftAlone(
					firstGuestId,
					membershipId,
					"other_guest",
					"active",
				);
			}

			// protects=convert wakes a former admin for guest one, guest two is then
			// converted onto the now-active member (which writes no status of its
			// own), and undoing guest one detaches it without putting `former` and
			// the stale end date back: guest two is `joined` against that member;
			// fails_when=the other-guest gate is dropped from the reuse path (the
			// undo restored `former` while guest two still pointed at the member);
			// no_claim=a guest LINKED to the member (next test)
			it("leaves the member active when another guest was converted onto it", async () => {
				const { membershipId, email } = await lapsed("Shared Convert", {
					status: "former",
					endedAt: "2020-01-15",
					clubRole: "admin",
				});
				const first = await wake("Shared Convert", email);
				const second = await convertedOnto("Shared Convert Two", email);
				expect((await guestRow(second))?.convertedMembershipId).toBe(
					membershipId,
				);

				const res = await undo(first);

				expect(res.membershipDeleted).toBe(false);
				await expectKeptForOtherGuest(first, second, membershipId);
			});

			// protects=the same for a guest LINKED to the woken member (linking to a
			// former member is prohibited, so the lapse must not come back under it);
			// fails_when=the other-guest gate looks only at converted guests, or at
			// the audit log (a link logs `member_merge` without `absorbedId`, which
			// the merge gate rightly ignores);
			// no_claim=what unlinking does afterwards
			it("leaves the member active when another guest was linked to it", async () => {
				const { membershipId, email } = await lapsed("Shared Link", {
					status: "former",
					endedAt: "2020-01-15",
					clubRole: "admin",
				});
				const first = await wake("Shared Link", email);
				const second = await seedGuest("Shared Link Two");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: second,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});

				const res = await undo(first);

				expect(res.membershipDeleted).toBe(false);
				await expectKeptForOtherGuest(first, second, membershipId);
			});

			// protects=the gate reads who points at the member NOW, not who once did:
			// a guest linked and then unlinked leaves the restore to happen;
			// fails_when=the gate counts a past link, or holds the undone guest
			// itself against the member;
			// no_claim=the refusals on the created path
			it("still puts the lapse back once the other guest is unlinked", async () => {
				const { membershipId, email } = await lapsed("Shared Then Free", {
					status: "former",
					endedAt: "2020-01-15",
				});
				const first = await wake("Shared Then Free", email);
				const second = await seedGuest("Shared Then Free Two");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: second,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: second,
					actorMemberId: seed.adminMemberId,
				});

				await undo(first);

				const after = await memberRow(membershipId);
				expect(after?.status).toBe("former");
				expect(after?.endedAt).toBe("2020-01-15");
				const detail = await undoDetail(membershipId);
				expect(detail?.statusRestoredTo).toBe("former");
				expect(detail).not.toHaveProperty("leftBecause");
			});
		});

		// ------------------------------------------------------------------
		// 5. A status or role set after the convert CREATED the membership
		// ------------------------------------------------------------------

		describe("a status or role an admin set after the convert created the membership (item 5)", () => {
			// protects=an admin's promotion, end date or inactive flag on a membership
			// the conversion created is not deleted with it: the undo refuses and the
			// membership, with the decision, is still there;
			// fails_when=the created path stops asking whether an admin edited the
			// membership (it deleted the promoted admin and the ended member);
			// no_claim=an edit that changes none of the three (next test)
			it.each([
				[
					"promoted to admin",
					(id: string) => setRole(id, "admin"),
					{ clubRole: "admin", status: "active" },
				],
				[
					"ended",
					(id: string) => setStatus(id, "former"),
					{ clubRole: "member", status: "former" },
				],
				[
					"set inactive",
					(id: string) => setStatus(id, "inactive"),
					{ clubRole: "member", status: "inactive" },
				],
			])("refuses when the member was %s", async (label, edit, expected) => {
				const { guestId, membershipId } = await converted(`Edited ${label}`);
				await edit(membershipId);

				expect(await refusalOf(guestId)).toBe(UNDO_MEMBERSHIP_EDITED_MESSAGE);

				await expectUntouched(guestId, membershipId);
				const after = await memberRow(membershipId);
				expect(after?.clubRole).toBe(expected.clubRole);
				expect(after?.status).toBe(expected.status);
			});

			// protects=the refusal is about the three columns, not any edit: a rename
			// of the converted member does not stop the undo;
			// fails_when=the filter on the member_edit detail is dropped and every
			// edit refuses (the same filter the reuse path reads);
			// no_claim=the edits that do refuse (the test above)
			it("does not refuse after an edit that changes neither status nor role", async () => {
				const { guestId, membershipId } = await converted("Renamed Created");
				await applyMemberEdit({
					clubId: seed.clubId,
					memberId: membershipId,
					name: "Renamed Created Two",
					actorMemberId: seed.adminMemberId,
				});

				const res = await undo(guestId);

				expect(res.membershipDeleted).toBe(true);
				expect(await memberRow(membershipId)).toBeUndefined();
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

		// protects=a name in the handled or deferred list that is no foreign key to
		// `members` (a column renamed or dropped, a typo) fails the build of the
		// table instead of sitting there claiming a key the undo no longer has;
		// fails_when=the build checks only the refusal list, as it once did;
		// no_claim=that the real lists are right (the tests above compare them with
		// the live constraints)
		it.each([
			["handled", "guests.no_such_member_id"],
			["deferred", "meeting_votes.no_such_member_id"],
		])("throws when the %s list names a column that is no key to members", (list, key) => {
			expect(() =>
				buildUndoKeyPlan(
					{
						...UNDO_HANDLED_KEYS,
						...(list === "handled" ? { [key]: "stale" } : {}),
					},
					{
						...UNDO_DEFERRED_KEYS,
						...(list === "deferred"
							? { [key]: { issue: 1, reason: "stale" } }
							: {}),
					},
				),
			).toThrow(`${key} is ${list} but is no foreign key to members`);
		});

		it("builds from the real lists", () => {
			expect(() => buildUndoKeyPlan()).not.toThrow();
		});

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
						expect(
							cls.check.label.length,
							`${key} refusal label`,
						).toBeGreaterThan(0);
						expect(cls.check.columns, key).toContain(key);
						break;
					case "blank":
						expect(cls.fk.key, key).toBe(key);
						expect(cls.fk.column, key).toBeDefined();
						break;
					case "handled":
						expect(
							cls.by.trim().length,
							`${key} needs a reason`,
						).toBeGreaterThan(0);
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
				[...classes.values()].flatMap((c) =>
					c.kind === "refuse" ? [c.check] : [],
				),
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
