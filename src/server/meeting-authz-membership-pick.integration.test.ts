/**
 * Regression (#804): the per-meeting agenda authz resolved its own membership
 * with an unordered `.limit(1)`.
 *
 * `resolveAdminGrant` (`meeting-authz-logic.ts`) and `getMembership`
 * (`guards.ts`) resolve the SAME signed-in-user → Person → membership
 * relationship for the same club. #471 gave the second a five-key total order
 * precisely so an arbitrary pick could not flip an authorization answer; the
 * first selected whatever row the database happened to return first.
 * `people.user_id` carries only a plain non-unique index (`people_user_idx`),
 * so one human reachable through two Person rows in one club is representable.
 *
 * **Agreement is the property, not stability.** A wrong-but-consistent pick is
 * stable, and every case here that can name a specific membership also asserts
 * `getMembership` names the same one. Since #838 both order by the one shared
 * `membershipPickOrder()` (`membership-pick-order.ts`), so there are no longer
 * two orderings to drift apart; agreement is still asserted, because the two
 * QUERIES remain separate (different joins, grouping and shape), and a join or
 * grouping change in one could still make them disagree.
 *
 * Two observables. `allowed`/`via` is the authorization answer, and
 * `actorMemberId` is the membership `logActivity` credits the write to (#396),
 * so an arbitrary pick also mis-attributes the audit trail on a request it DID
 * grant — where an `allowed`-only assertion can never see it.
 *
 * The order is FIVE keys, and a fixture that differs on status or role never
 * reaches the last three. So the cases below walk down the ladder: role, then
 * open-term count, then `created_at`, then the primary key — each tying on
 * every key above it, which is the only way a key gets exercised at all.
 *
 * Where a fixture has a contested pick it writes the row that must LOSE first,
 * so an unordered scan returns it and the case fails without the ordering.
 * Insert order is load-bearing — with the winner written first these pass
 * either way. Two cases are outside that rule and say so where they sit: the
 * refusal case seeds no duplicate at all, and the primary-key case writes three
 * rows whose ids, not their insert order, decide.
 *
 * The ordinary single-membership case (the admin arm, the TMOD self-assert
 * fallback, the refusal path) is `meeting-authz.integration.test.ts`; this file
 * adds only the duplicate-Person precondition it does not construct.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-authz-membership-pick.integration.test.ts
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

const {
	resolveMeetingAgendaAuthz,
	resolveVoteCounterAuthz,
	resolveWordOfTheDayAuthz,
} = await import("./meeting-authz-logic");
// The reference ordering. Imported so agreement is ASSERTED rather than assumed
// from the two queries looking alike — they share an ORDER (#838), not a query.
const { getMembership } = await import("./guards");

describe.skipIf(!hasTestDb)(
	"meeting agenda authz with duplicate Persons (#804)",
	() => {
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
			// `members.person_id` cascades from `people`, so this takes the
			// memberships (and their officer terms) with it. Scoped to the ids THIS
			// run created — `tm_test` is shared and vitest runs files in parallel.
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

		/** The agenda resolver's answer for the seeded user on the seeded meeting. */
		async function agendaAuthz() {
			return resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				sessionUserId: userId,
			});
		}

		/**
		 * The acceptance property, applied to whatever fixture is in place: the two
		 * resolvers name the SAME membership. Stability alone would pass on a
		 * wrong-but-consistent pick, so this is asserted alongside every expected id.
		 */
		async function expectAgreesWithGuardPath(expected: string) {
			const authz = await agendaAuthz();
			const reference = await getMembership(userId, club.clubId);
			expect(authz.actorMemberId).toBe(expected);
			expect(reference?.id).toBe(expected);
			expect(authz.actorMemberId).toBe(reference?.id);
		}

		// ── Key 2: ADMIN outranks plain member ────────────────────────────────
		// The reported bug. The human IS an admin of this club, and whether the
		// agenda editor opened for them depended on which duplicate came back.
		it("grants the admin arm, and credits the admin membership", async () => {
			const plain = await addMembership({
				clubRole: "member",
				status: "active",
			});
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			const authz = await agendaAuthz();
			expect(authz.allowed).toBe(true);
			expect(authz.via).toBe("admin");
			// `actorMemberId` is the second observable — what `logActivity` stamps.
			expect(authz.actorMemberId).toBe(admin);
			expect(authz.actorMemberId).not.toBe(plain);
			await expectAgreesWithGuardPath(admin);
		});

		// The flip itself, stated directly: repeated requests, no data change
		// between them, one answer.
		it("answers the same way on repeated calls", async () => {
			await addMembership({ clubRole: "member", status: "active" });
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			const answers = [];
			for (let i = 0; i < 4; i++) {
				const authz = await agendaAuthz();
				answers.push(`${authz.via}:${authz.actorMemberId}`);
			}

			expect(new Set(answers).size).toBe(1);
			expect(answers[0]).toBe(`admin:${admin}`);
		});

		// The whole agenda-authz family shares this one arm, which is why the flip
		// was not confined to a single route. One fixture, three entry points.
		it.each([
			["agenda", resolveMeetingAgendaAuthz],
			["word of the day", resolveWordOfTheDayAuthz],
			["vote counter", resolveVoteCounterAuthz],
		] as const)("the %s resolver grants off the same pick", async (_n, fn) => {
			await addMembership({ clubRole: "member", status: "active" });
			const admin = await addMembership({
				clubRole: "admin",
				status: "active",
			});

			const authz = await fn({
				meetingId: club.meetingId,
				sessionUserId: userId,
			});
			expect(authz.allowed).toBe(true);
			expect(authz.via).toBe("admin");
			expect(authz.actorMemberId).toBe(admin);
		});

		// A caller with no membership in this club at all — the zero-row end of the
		// query, which no other case here reaches now that every fixture seeds at
		// least one duplicate.
		//
		// It was suggested this is what gates the `GROUP BY`: that without the
		// grouping an aggregate `ORDER BY` returns ONE row of NULLs with
		// `count = 0`, making `membership` truthy and routing the refusal through a
		// branch it was never meant to reach. MEASURED, that is not what happens —
		// the select carries bare `members` columns, so Postgres rejects the
		// statement outright (`column "m.id" must appear in the GROUP BY clause`),
		// and dropping the grouping fails all twelve cases rather than this one.
		// The grouping is gated; this case is not its unique gate. What it does
		// hold on its own is the refusal a caller with no row here actually gets.
		it("refuses a caller with no membership in the club", async () => {
			// Deliberately seeds nothing: `userId` is a real signed-in account with
			// no Person linked into this club.
			const authz = await agendaAuthz();
			expect(authz.allowed).toBe(false);
			expect(authz.via).toBeNull();
			expect(authz.actorMemberId).toBeNull();
			expect(await getMembership(userId, club.clubId)).toBeNull();
		});

		// ── Key 3: more OPEN officer terms ────────────────────────────────────
		// Both rows are active admins, so the grant happens either way and
		// `actorMemberId` is the only thing that moves. It has to move the same way
		// `getMembership` moves: effective-admin (#202) reads ONE membership's
		// terms, so the two resolvers disagreeing here hands two parts of the app
		// different rows for the same human.
		it("breaks a status+role tie on the open officer term", async () => {
			await addMembership({ clubRole: "admin", status: "active" });
			const officer = await addMembership({
				clubRole: "admin",
				status: "active",
				openTerms: 1,
			});

			await expectAgreesWithGuardPath(officer);
		});

		// The key is a COUNT, and a fixture whose maximum is one open term never
		// says so — `desc(count(...))` and a bare "has any open term" are the same
		// function over {0, 1}, so the whole `GROUP BY` could collapse to an EXISTS
		// with the case above still green. Holding two offices at once (President
		// and VPE) is ordinary, and it is also what makes the left join fan a
		// membership out to two rows, so this is the case where the grouping does
		// work rather than merely being syntactically required.
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

			await expectAgreesWithGuardPath(twoOffices);
			expect((await agendaAuthz()).actorMemberId).not.toBe(oneOffice);
		});

		// A CLOSED term grants nothing, so it must not pull the pick either — the
		// join's `isNull(termEnd)` predicate is what says so, and nothing else in
		// this file exercised it (`termEnd` appeared zero times). The closed-term
		// row is written FIRST and ties on every key above: drop the predicate and
		// both count 1, the tie falls to `created_at`, and the closed-term row wins.
		// The same case exists in `membership-resolution.integration.test.ts`
		// through `getMembership`; both read the shared join condition (#838), and
		// this one gates it through the resolver that grants.
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

			await expectAgreesWithGuardPath(openTerm);
			expect((await agendaAuthz()).actorMemberId).not.toBe(closedTerm);
		});

		// ── Key 4: oldest first ───────────────────────────────────────────────
		// Ties on status, club role AND open-term count — the criterion the cases
		// above cannot reach, because each is decided before `created_at` is ever
		// compared. The NEWER row is written first, so an unordered scan returns it
		// and this fails with the ordering removed.
		//
		// What it does NOT do, measured: deterministically gate keys 4 and 5 in
		// ISOLATION. Deleting just those two leaves the two rows tied on every
		// remaining key, and which one Postgres then returns is its choice — 3
		// failures in 12 runs of that mutation. The shipped suite is not flaky (12
		// of 12 across 5 consecutive runs); the MUTATION is. A fixture cannot fix
		// that, because the tie is the thing being tested and nothing below it is
		// under this suite's control.
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

			await expectAgreesWithGuardPath(older);
		});

		// ── Key 5: the primary key, the terminator ────────────────────────────
		// Three rows sharing ONE instant, carrying explicit DESCENDING ids written
		// in that order, so nothing above `members.id` can separate them.
		//
		// What this case gates, MEASURED by mutation rather than assumed. Deleting
		// `members.id` from the resolver's own ORDER BY leaves it GREEN: the
		// `GROUP BY members.id` beneath already sorts the group on that column, so
		// the last key is redundant under the plan Postgres picks here. That is a
		// property of the plan, not a guarantee, which is why the key stays — but
		// a comment claiming this case pins it would have been false.
		//
		// Before #838 it pinned what the COPY cost: flipping only `getMembership`'s
		// terminator to `desc(members.id)` failed this case and nothing else. There
		// is one terminator now, so that drift is unrepresentable; the key itself
		// is pinned as rendered SQL by `membership-pick-order.test.ts`, which does
		// not depend on the plan Postgres picks.
		it("is total: a created_at tie still resolves, on the primary key", async () => {
			const sameInstant = new Date("2026-03-01T00:00:00.000Z");
			const descendingIds = [
				"00000000-0000-4000-8000-000000000323",
				"00000000-0000-4000-8000-000000000322",
				"00000000-0000-4000-8000-000000000321",
			];
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
				(await agendaAuthz()).actorMemberId,
				(await agendaAuthz()).actorMemberId,
				(await agendaAuthz()).actorMemberId,
			]);
			// Two requests disagreeing is what flips an authorization answer.
			expect(answers.size).toBe(1);
			// ...and it is the LOWEST id, not whichever the scan reached first.
			await expectAgreesWithGuardPath(descendingIds[2] as string);
		});

		// ── Key 1: ACTIVE outranks ADMIN ──────────────────────────────────────
		// Polarity, not just presence. Ordering ACTIVE ahead of ADMIN is what keeps
		// this fix from WIDENING the grant: a lapsed admin badge must not unlock the
		// agenda for someone whose live membership here is a plain member. This
		// passes before the fix too — that is the point, it pins the direction the
		// fix must not move.
		it("does not grant off an INACTIVE admin duplicate", async () => {
			await addMembership({ clubRole: "admin", status: "inactive" });
			const active = await addMembership({
				clubRole: "member",
				status: "active",
			});

			const authz = await agendaAuthz();
			expect(authz.allowed).toBe(false);
			expect(authz.via).toBeNull();
			expect(authz.actorMemberId).toBeNull();
			// Denied, so `actorMemberId` names nothing — but the resolvers must still
			// agree on WHICH row they refused off, or the two would drift apart on
			// the one key that decides whether a grant happens at all.
			expect((await getMembership(userId, club.clubId))?.id).toBe(active);
		});
	},
);
