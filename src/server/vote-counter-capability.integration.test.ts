/**
 * DB-backed tests for the narrow Ballot Counter minutes-editing capability
 * (#510): a club admin, OR the meeting's self-asserted Vote Counter, may
 * add/remove/move a Table Topics speaker and set/clear an award — and NOTHING
 * else. `setAttendance` / `addMinutesGuest` / `removeMinutesGuest` stay
 * admin-only.
 *
 * The boundary is proved in TWO layers, matching how every other authz suite
 * in this repo (`meeting-authz.integration.test.ts`,
 * `word-of-the-day.integration.test.ts`) splits it, because a `createServerFn`
 * cannot be invoked directly outside a real request:
 *
 *  1. `minutes-authz.guard.test.ts` (source-level) proves WHICH gate each of
 *     the eight `minutes.ts` exports calls — the five Table-Topics/award fns
 *     call `requireVoteCounterCapability`, the three roster/guest fns call
 *     ONLY the unrelated, narrower `gateAdmin`.
 *  2. THIS file proves the DECISION that gate makes is correct — this is the
 *     exact `resolveVoteCounterAuthz` / `requireVoteCounterCapability` pair
 *     the five gated exports call, so exercising it here IS exercising their
 *     real authorization path.
 *
 * Together: a non-admin Vote Counter can reach exactly the five capabilities,
 * an admin still reaches all five (unchanged), and a plain member reaches
 * none — without needing to fake a signed-in session, `requireVoteCounterCapability`
 * calling `getSessionUser()` here just resolves to "no session" (the same
 * fallback it uses for a real anonymous self-assert caller in production).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/vote-counter-capability.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, officerTerms, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveVoteCounterAuthz } = await import("./meeting-authz-logic");
const { requireVoteCounterCapability } = await import("./guards");

/** Add a named role def + slot to the meeting; optionally assign a member.
 *  Returns the slot id. Mirrors `word-of-the-day.integration.test.ts`'s
 *  identical helper for the Grammarian slot. */
async function addRoleSlot(
	club: SeededClub,
	name: string,
	assignedMemberId: string | null,
	/** `role_definitions.key`. Defaults to NULL — the shape `createClubRole`
	 *  actually writes — so these tests exercise the canonical-name fallback
	 *  unless a test explicitly wants the keyed (possibly renamed) shape. */
	key: string | null = null,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name,
			key,
			category: "functionary",
			isSpeakerRole: false,
			sortOrder: 50,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: assignedMemberId ? "claimed" : "open",
			assignedMemberId,
		})
		.returning({ id: roleSlots.id });
	return slot.id;
}

/** Insert an extra active roster member; return its id. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

describe.skipIf(!hasTestDb)("resolveVoteCounterAuthz (#510)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("allows a club admin (session) — via admin", async () => {
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows the meeting's self-asserted Vote Counter — via vote-counter-self-assert", async () => {
		await addRoleSlot(club, "Vote Counter", club.memberId);
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("vote-counter-self-assert");
		expect(authz.voteCounterMemberId).toBe(club.memberId);
	});

	// Mirrors #464's Grammarian/TMOD coverage: identity is the role KEY, not the
	// display label, so a club that renames "Vote Counter" to "Ballot Counter"
	// keeps the grant.
	it("allows a RENAMED Vote Counter self-assert — the key is identity, not the label", async () => {
		await addRoleSlot(club, "Ballot Counter", club.memberId, "vote_counter");
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("vote-counter-self-assert");
	});

	it("rejects a roster member who holds no vote_counter slot", async () => {
		await addRoleSlot(club, "Vote Counter", null);
		const other = await addRosterMember(club.clubId, "Someone Else");
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			selfMemberId: other,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
	});

	it("rejects a plain member SESSION with no self-assert", async () => {
		await addRoleSlot(club, "Vote Counter", club.memberId);
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.memberUserId,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
	});

	it("rejects self-assert when the Vote Counter slot is unassigned", async () => {
		await addRoleSlot(club, "Vote Counter", null);
		const someone = await addRosterMember(club.clubId, "Wannabe");
		const authz = await resolveVoteCounterAuthz({
			meetingId: club.meetingId,
			selfMemberId: someone,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.voteCounterMemberId).toBe(null);
	});
});

describe.skipIf(!hasTestDb)(
	"requireVoteCounterCapability — the gate all five minutes.ts Ballot Counter fns call (#510)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		// THE most important case: a member who is a Vote Counter but NOT an
		// admin reaches the capability `addTableTopics` / `removeTableTopics` /
		// `moveTableTopics` / `setMinutesAward` / `clearMinutesAward` all gate on.
		// club.memberId is `clubRole: "member"` (seedClub's default) — this is
		// deliberately the non-admin case, not the admin one.
		it("resolves (does not throw) for a NON-ADMIN member holding the vote_counter slot", async () => {
			await addRoleSlot(club, "Vote Counter", club.memberId);
			await expect(
				requireVoteCounterCapability({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).resolves.toMatchObject({
				allowed: true,
				via: "vote-counter-self-assert",
			});
		});

		// THE boundary: the SAME non-admin member, asserting a memberId that is
		// NOT the vote_counter slot's holder, is rejected — this is the decision
		// `setMinutesAward` etc. rely on to keep a plain member out.
		it("REJECTS a plain member holding no vote_counter slot", async () => {
			await addRoleSlot(club, "Vote Counter", null);
			const other = await addRosterMember(club.clubId, "Someone Else");
			await expect(
				requireVoteCounterCapability({
					meetingId: club.meetingId,
					selfMemberId: other,
				}),
			).rejects.toThrow(/ballot counter|club admin/i);
		});

		it("REJECTS no self-assert and no session at all", async () => {
			await addRoleSlot(club, "Vote Counter", club.memberId);
			await expect(
				requireVoteCounterCapability({ meetingId: club.meetingId }),
			).rejects.toThrow();
		});

		// Why `requireVoteCounterCapability` retries `requireClubRole` instead of
		// just trusting `resolveVoteCounterAuthz`.
		//
		// The five minutes.ts fns used to gate on `requireClubRole(..., ["admin"])`,
		// which ALSO grants to an elected officer holding an open term (#202
		// effective-admin). `resolveVoteCounterAuthz` reads `clubRole` only. Without
		// the retry, swapping the gates would have silently REVOKED award-setting
		// and Table Topics capture from officers who hold their seat that way.
		//
		// This asserts the resolver genuinely does NOT cover that member, which is
		// what makes the fallback load-bearing rather than dead code. Delete the
		// fallback and officers lose a capability they have today.
		it("resolver alone does NOT grant to an elected officer — hence the requireClubRole retry", async () => {
			const officerId = await addRosterMember(club.clubId, "Elected Officer");
			await testDb.insert(officerTerms).values({
				membershipId: officerId,
				position: "vp_education",
				termStart: new Date("2026-07-01"),
			});
			const authz = await resolveVoteCounterAuthz({
				meetingId: club.meetingId,
				selfMemberId: officerId,
			});
			expect(authz.allowed).toBe(false);
			// ...and the open term that `requireClubRole` keys off really is there,
			// so the two gates genuinely disagree about this member.
			const terms = await testDb
				.select()
				.from(officerTerms)
				.where(eq(officerTerms.membershipId, officerId));
			expect(terms).toHaveLength(1);
			expect(terms[0].termEnd).toBeNull();
		});
	},
);
