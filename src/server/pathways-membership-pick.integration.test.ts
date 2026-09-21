/**
 * Regression (#822): the two remaining Pathways membership picks resolved
 * `people.user_id` → `members` with no ordering, and one of them checked no
 * `status` at all.
 *
 * `viewerMaySeeProgress` (`project-picker-logic.ts`), `selfMemberIdInClub`
 * (`progress-marks-logic.ts`) and `getMembership` (`guards.ts`) resolve the SAME
 * signed-in-user → Person → membership relationship for the same club. #471 gave
 * the third a five-key total order precisely so an arbitrary pick could not flip
 * an authorization answer, #804/#821 copied it into `resolveAdminGrant`, and
 * these two were written without it. `people.user_id` carries only a plain
 * non-unique index (`people_user_idx`), so one human reachable through two
 * Person rows in one club is representable.
 *
 * **Two defects, and only one of them needs a duplicate.** The missing `status`
 * filter in `viewerMaySeeProgress` is reachable with a SINGLE membership: a
 * lapsed admin kept the capability to read another member's completion marks.
 * That case is first below, and it is the only one here that reproduces against
 * live data as it stands rather than against a precondition nobody constructed.
 *
 * **The two functions observe different amounts of the order, and the split is
 * deliberate.** `viewerMaySeeProgress` returns a BOOLEAN, so only keys 1 and 2
 * can move it — rows tied on status and role carry the same status and role, and
 * keys 3-5 then choose between answers that are equal. `selfMemberIdInClub`
 * returns an ID, so it is where the ladder is walked all the way down. Asserting
 * keys 3-5 through the boolean would be a test that cannot fail; asserting keys
 * 1-2 only through the id would leave the grant itself ungated. Both are here,
 * each on the function that can see it.
 *
 * **Agreement is the property, not stability.** A wrong-but-consistent pick is
 * stable. Every case that can name a membership also asserts `getMembership`
 * names the same one, and every boolean case asserts the boolean equals what
 * `getMembership`'s own chosen row implies — which is what fails if only one of
 * the now-four copies of the order is ever changed.
 *
 * Where a fixture has a contested pick it writes the row that must LOSE first,
 * so an unordered scan returns it and the case fails without the ordering. Two
 * cases are outside that rule and say so where they sit: the no-membership case
 * seeds nothing, and the primary-key case writes three rows whose ids, not their
 * insert order, decide.
 *
 * The ordinary single-membership behaviour of both surfaces is
 * `project-picker.integration.test.ts` and `progress-marks.integration.test.ts`;
 * this file adds only the duplicate-Person precondition they do not construct,
 * plus the two cases that need no duplicate at all: the lapsed admin the
 * `status` check must refuse, and the lapsed membership `selfMemberIdInClub`
 * must still name.
 *
 * What each mutation costs, measured on this suite rather than asserted:
 *
 *  · drop the `status` check → 1 case (the lapsed admin with no duplicate).
 *  · drop `viewerMaySeeProgress`'s ORDER BY → 2 (the admin duplicate, and
 *    repeated calls), and the second failed on 3 of 3 runs.
 *  · revert `selfMemberIdInClub` to its pre-fix query → 8 of its 10, on 3 of 3
 *    runs. The two that survive are the ones the ordering does not reach: the
 *    null case, and the lapsed-ONLY case, which is about a filter that is not
 *    there rather than about which row wins.
 *  · ADD a `status` filter to `selfMemberIdInClub` — the "symmetry with
 *    `viewerMaySeeProgress`" change — → 1, the lapsed-only case, and nothing
 *    else. That is the whole reason it exists: every other fixture here pairs
 *    a lapsed row with a live one, and over those a filter and key 1 return
 *    the same membership, so all 15 without it stayed green.
 *  · swap keys 1 and 2 in `viewerMaySeeProgress` → 0. In `selfMemberIdInClub`
 *    → 1. The polarity is only observable where no status check stands in
 *    front of it, which is why the note sits on that case and not on the
 *    boolean one that reads like it.
 *  · flip `getMembership`'s terminator to `desc(members.id)` → 1 (the
 *    primary-key case). That is the gate on "the copies move together"; the
 *    terminator itself is not uniquely gated, because `GROUP BY members.id`
 *    already sorts the group on that column under the plan Postgres picks.
 *
 * `tm_test` is shared with other agents. A run that fails cases no mutation
 * could reach — the zero-row refusals, both functions at once — is that, not
 * this suite: re-run before believing it.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/pathways-membership-pick.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { viewerMaySeeProgress } = await import("./project-picker-logic");
const { selfMemberIdInClub, resolveMarkAuthz } = await import(
	"./progress-marks-logic"
);
// The reference ordering. Imported so agreement is ASSERTED rather than assumed
// from the queries looking alike — they are separate copies by design, and
// `guards.ts` is deliberately NOT mocked here for the same reason.
const { getMembership } = await import("./guards");

describe.skipIf(!hasTestDb)("Pathways membership picks (#822)", () => {
	let club: SeededClub;
	let userId: string;
	const madePeople: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
		userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Dup Human",
			email: `${userId}@test.example`,
		});
		madePeople.length = 0;
	});

	afterEach(async () => {
		// `members.person_id` cascades from `people`, so this takes the memberships
		// (and their officer terms) with it. Scoped to the ids THIS run created —
		// `tm_test` is shared and vitest runs files in parallel.
		if (madePeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, madePeople));
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId, userId]);
	});

	/** One more Person on the SAME account, holding its own membership here. */
	async function addMembership(opts: {
		clubRole: "admin" | "member";
		status: "active" | "inactive";
		/** Explicit id, for pinning the final tiebreaker. */
		id?: string;
		/** Explicit timestamp, so several rows can share one instant. */
		createdAt?: Date;
		/** Give the membership this many OPEN officer terms. */
		openTerms?: number;
		/** ...and this many ENDED ones, which must not count. */
		closedTerms?: number;
	}): Promise<string> {
		const [personRow] = await testDb
			.insert(people)
			.values({
				name: "Dup Human",
				email: `${randomUUID()}@test.example`,
				userId,
			})
			.returning({ id: people.id });
		if (!personRow) throw new Error("Failed to insert person");
		madePeople.push(personRow.id);

		const [memberRow] = await testDb
			.insert(members)
			.values({
				...(opts.id ? { id: opts.id } : {}),
				...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
				clubId: club.clubId,
				personId: personRow.id,
				name: "Dup Human",
				clubRole: opts.clubRole,
				status: opts.status,
			})
			.returning({ id: members.id });
		if (!memberRow) throw new Error("Failed to insert membership");

		const positions = ["president", "vp_education", "secretary"] as const;
		for (let i = 0; i < (opts.openTerms ?? 0); i++) {
			await testDb.insert(officerTerms).values({
				membershipId: memberRow.id,
				position: positions[i] ?? "treasurer",
				termStart: new Date("2026-01-01"),
			});
		}
		for (let i = 0; i < (opts.closedTerms ?? 0); i++) {
			await testDb.insert(officerTerms).values({
				membershipId: memberRow.id,
				position: positions[i] ?? "treasurer",
				termStart: new Date("2025-01-01"),
				termEnd: new Date("2025-12-31"),
			});
		}
		return memberRow.id;
	}

	/**
	 * The gate's answer for the seeded user, looking at ANOTHER member's record.
	 * `club.personId` belongs to the seeded member-role Person, never to the
	 * duplicate human — the self arm (`userPersonIds`) short-circuits before the
	 * membership query and would hide every case in this file.
	 */
	async function maySeeProgress(): Promise<boolean> {
		return viewerMaySeeProgress({
			userId,
			clubId: club.clubId,
			personId: club.personId,
		});
	}

	/**
	 * The acceptance property for the BOOLEAN surface: the answer equals what
	 * `getMembership`'s own chosen row implies. Stability alone would pass on a
	 * wrong-but-consistent pick, and an expected-value assertion alone cannot see
	 * the two orderings drifting apart.
	 */
	async function expectBooleanAgreesWithGuardPath(expected: boolean) {
		const answer = await maySeeProgress();
		const reference = await getMembership(userId, club.clubId);
		const impliedByReference =
			reference?.status === "active" && reference.clubRole === "admin";
		expect(answer).toBe(expected);
		expect(answer).toBe(impliedByReference);
	}

	/** Same property for the ID surface: the two resolvers name the SAME row. */
	async function expectIdAgreesWithGuardPath(expected: string) {
		const picked = await selfMemberIdInClub(userId, club.clubId);
		const reference = await getMembership(userId, club.clubId);
		expect(picked).toBe(expected);
		expect(reference?.id).toBe(expected);
		expect(picked).toBe(reference?.id);
	}

	// ── viewerMaySeeProgress: the missing status filter ───────────────────
	describe("viewerMaySeeProgress", () => {
		// The half of #822 that needs NO duplicate rows. One membership, one
		// Person, nothing exotic: a member who did not renew but whose row still
		// says `admin`. `requireClubRole` and every other gate in the app refuse
		// that row; this one read `clubRole` and checked no status at all, so a
		// lapsed officer kept reading other members' Pathways completion marks —
		// a personal educational record that feeds award eligibility.
		it("refuses a LAPSED admin, with no duplicate membership at all", async () => {
			await addMembership({ clubRole: "admin", status: "inactive" });

			await expectBooleanAgreesWithGuardPath(false);
		});

		// The control beside it. Without this the case above passes just as well
		// on a function that returns `false` unconditionally, which is the way a
		// status check gets over-tightened into a capability nobody has.
		it("still grants an ACTIVE admin with the same single membership", async () => {
			await addMembership({ clubRole: "admin", status: "active" });

			await expectBooleanAgreesWithGuardPath(true);
		});

		// ── Key 2: ADMIN outranks plain member ────────────────────────────
		// The ordering half. The human IS an admin of this club, and whether the
		// picker came back with progress on it depended on which duplicate the
		// database happened to return. The plain row is written FIRST, so an
		// unordered scan returns it and this fails without the ordering.
		it("grants off the ADMIN duplicate, not whichever row arrived first", async () => {
			await addMembership({ clubRole: "member", status: "active" });
			await addMembership({ clubRole: "admin", status: "active" });

			await expectBooleanAgreesWithGuardPath(true);
		});

		// The flip itself, stated directly: repeated requests, no data change
		// between them, one answer. This is what a member saw — progress on the
		// picker one moment and gone the next.
		it("answers the same way on repeated calls", async () => {
			await addMembership({ clubRole: "member", status: "active" });
			await addMembership({ clubRole: "admin", status: "active" });

			const answers = [
				await maySeeProgress(),
				await maySeeProgress(),
				await maySeeProgress(),
				await maySeeProgress(),
			];

			expect(new Set(answers).size).toBe(1);
			expect(answers[0]).toBe(true);
		});

		// ── Key 1 and the status check, jointly ───────────────────────────
		// Pins the direction the fix must not move: a lapsed admin badge must not
		// unlock another member's record for someone whose live membership here is a
		// plain member.
		//
		// It is NOT a unique gate on either half, and measuring said so rather than
		// the comment guessing. Removing the `status` check leaves it green (the
		// ordering picks the active plain row, whose `clubRole` is not admin);
		// removing the ordering leaves it green (the check refuses the lapsed row);
		// swapping keys 1 and 2 leaves it green for the same reason. Two independent
		// refusals over one fixture, which is what makes it a direction pin and not a
		// mutation gate. The gates are the two cases above it.
		it("does not grant off an INACTIVE admin duplicate beside an active member", async () => {
			await addMembership({ clubRole: "admin", status: "inactive" });
			await addMembership({ clubRole: "member", status: "active" });

			await expectBooleanAgreesWithGuardPath(false);
		});

		// The zero-row end of the query — a signed-in account with no Person linked
		// into this club at all. Seeds no duplicate, deliberately: every other case
		// here seeds at least one, so nothing else reaches it.
		it("refuses a caller with no membership in the club", async () => {
			expect(await maySeeProgress()).toBe(false);
			expect(await getMembership(userId, club.clubId)).toBeNull();
		});
	});

	// ── selfMemberIdInClub: the attribution ladder ────────────────────────
	// Not a grant — nothing branches on it. What moves is which membership a
	// written progress mark is CREDITED to, which is invisible until someone asks
	// who ticked the box. Same family as #396.
	describe("selfMemberIdInClub", () => {
		// The NO-status-filter decision, and the only case here that holds it.
		// This function names attribution, not a grant, so it deliberately filters
		// nothing — but every other fixture in this describe pairs a lapsed row
		// against a live one, and wherever both rows exist a filter and key 1 are
		// indistinguishable: both return the active membership. So a `status`
		// filter added for symmetry with `viewerMaySeeProgress` beside it would
		// leave all of them green.
		//
		// One membership, lapsed, no duplicate — the shape a filter changes. It
		// would hand back `null`, which `markMyProject` writes as "marked by
		// nobody", losing attribution for a member whose roster row lapsed between
		// the mark and the read. The ordering carries the preference instead: an
		// active row out-ranks a lapsed one, and the lapsed row is still named when
		// it is all there is.
		it("still names a LAPSED membership when it is the only one", async () => {
			const lapsed = await addMembership({
				clubRole: "member",
				status: "inactive",
			});

			await expectIdAgreesWithGuardPath(lapsed);
		});

		// Key 1, and this is where its POLARITY is load-bearing — the boolean
		// surface above cannot see it, because a status check refuses the lapsed row
		// there whichever way the two keys are ordered. Here there is no such check
		// by design, so key 1 alone decides: a lapsed row must not out-rank the live
		// one the human actually holds, or the mark is credited to a membership that
		// is no longer theirs. Swapping keys 1 and 2 fails THIS case and nothing
		// else in the file (measured).
		it("credits the ACTIVE membership over a lapsed admin one", async () => {
			await addMembership({ clubRole: "admin", status: "inactive" });
			const active = await addMembership({
				clubRole: "member",
				status: "active",
			});

			await expectIdAgreesWithGuardPath(active);
		});

		// Key 2, with key 1 tied.
		it("credits the ADMIN membership when both are active", async () => {
			const plain = await addMembership({
				clubRole: "member",
				status: "active",
			});
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			await expectIdAgreesWithGuardPath(admin);
			expect(await selfMemberIdInClub(userId, club.clubId)).not.toBe(plain);
		});

		// Key 3, with keys 1 and 2 tied — the criterion the cases above cannot
		// reach, because each is decided before the term count is compared.
		it("breaks a status+role tie on the open officer term", async () => {
			await addMembership({ clubRole: "admin", status: "active" });
			const officer = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
			});

			await expectIdAgreesWithGuardPath(officer);
		});

		// The key is a COUNT, and a fixture whose maximum is one open term never
		// says so — `desc(count(...))` and a bare "has any open term" are the same
		// function over {0, 1}, so the `GROUP BY` could collapse to an EXISTS with
		// the case above still green. Holding two offices at once (President and
		// VPE) is ordinary, and it is also what makes the left join fan a
		// membership out to two rows, so this is where the grouping does work
		// rather than merely being syntactically required.
		it("compares the COUNT of open terms, not merely whether there is one", async () => {
			const oneOffice = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
			});
			const twoOffices = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 2,
			});

			await expectIdAgreesWithGuardPath(twoOffices);
			expect(await selfMemberIdInClub(userId, club.clubId)).not.toBe(oneOffice);
		});

		// A CLOSED term grants nothing, so it must not pull the pick either — the
		// join's `isNull(termEnd)` predicate is what says so, and nothing else in
		// this file exercises it. The closed-term row is written FIRST and ties on
		// every key above: drop the predicate and both count 1, the tie falls to
		// `created_at`, and the closed-term row wins.
		it("ignores a CLOSED officer term when ranking", async () => {
			const closedTerm = await addMembership({
				clubRole: "admin",
				status: "active",
				closedTerms: 1,
			});
			const openTerm = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
			});

			await expectIdAgreesWithGuardPath(openTerm);
			expect(await selfMemberIdInClub(userId, club.clubId)).not.toBe(
				closedTerm,
			);
		});

		// Key 4. Ties on status, club role AND open-term count. The NEWER row is
		// written first, so an unordered scan returns it.
		//
		// What it does NOT do, and #821 measured this on the same fixture shape:
		// deterministically gate keys 4 and 5 in ISOLATION. Deleting just those two
		// leaves the rows tied on every remaining key and which one Postgres
		// returns is its own choice. The shipped suite is not flaky; that MUTATION
		// is, and a fixture cannot fix it because the tie is the thing under test.
		it("breaks a full tie on created_at, oldest first", async () => {
			await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
				createdAt: new Date("2026-06-01T00:00:00.000Z"),
			});
			const older = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
				createdAt: new Date("2026-02-01T00:00:00.000Z"),
			});

			await expectIdAgreesWithGuardPath(older);
		});

		// Key 5, the terminator. Three rows sharing ONE instant, carrying explicit
		// DESCENDING ids written in that order, so nothing above `members.id` can
		// separate them.
		//
		// What this pins, measured the same way #821 measured its twin: NOT the
		// terminator in isolation — deleting `members.id` from the ORDER BY leaves
		// it green, because the `GROUP BY members.id` beneath already sorts the
		// group on that column under the plan Postgres picks. What it DOES pin is
		// the cost of the copy: flip `getMembership`'s terminator to
		// `desc(members.id)` — the orderings drifting apart on one key — and this
		// case fails and nothing else in the file does.
		it("is total: a created_at tie still resolves, on the primary key", async () => {
			const sameInstant = new Date("2026-03-01T00:00:00.000Z");
			// PER-RUN, like every other key this suite seeds. These were three FIXED
			// uuids, which is a primary-key collision the moment two runs of this
			// file overlap — vitest runs files in parallel against one shared
			// `tm_test`, and `tm_test` is shared with other agents besides. Only the
			// last three hex digits vary: a uuid orders by its bytes, so descending
			// suffixes are descending ids whatever the random prefix is, which is
			// the property this case needs.
			const runPrefix = randomUUID().slice(0, 33);
			const descendingIds = ["823", "822", "821"].map(
				(suffix) => `${runPrefix}${suffix}`,
			);
			for (const memberId of descendingIds) {
				await addMembership({
					clubRole: "admin",
					status: "active",
					openTerms: 1,
					id: memberId,
					createdAt: sameInstant,
				});
			}

			const answers = new Set([
				await selfMemberIdInClub(userId, club.clubId),
				await selfMemberIdInClub(userId, club.clubId),
				await selfMemberIdInClub(userId, club.clubId),
			]);
			// Two marks a second apart credited to two memberships is the bug.
			expect(answers.size).toBe(1);
			// ...and it is the LOWEST id, not whichever the scan reached first.
			await expectIdAgreesWithGuardPath(descendingIds[2] as string);
		});

		// The null end. `markMyProject` passes this straight through as
		// `markedByMemberId`, which the column allows — a superadmin acting under
		// impersonation has no membership to credit.
		it("returns null when the user has no membership in the club", async () => {
			expect(await selfMemberIdInClub(userId, club.clubId)).toBeNull();
		});

		// Through the real caller rather than the seam, so the ordering is pinned
		// where the value is actually consumed: `resolveMarkAuthz`'s admin arm
		// hands `actorMemberId` to `markProjectComplete`, and this is the path an
		// admin ticking a box on someone else's record takes. `requireClubRole` is
		// the REAL guard here (this suite does not mock `./guards`), so the fixture
		// has to be a genuine active admin.
		it("supplies resolveMarkAuthz's actorMemberId from the same ordered pick", async () => {
			await addMembership({ clubRole: "member", status: "active" });
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			const authz = await resolveMarkAuthz({
				userId,
				clubId: club.clubId,
				memberId: club.memberId,
			});
			expect(authz.personId).toBe(club.personId);
			expect(authz.actorMemberId).toBe(admin);
			expect(authz.actorMemberId).toBe(
				(await getMembership(userId, club.clubId))?.id,
			);
		});
	});
});
