/**
 * DB-backed tests for the ONE Ballot Counter capability that needs a session
 * (#752): ruling a candidate out of an award, and undoing that ruling.
 *
 * ## What this file is about, and what it is deliberately not about
 *
 * #747 bound every SIGNED-IN self-assert caller to their own identity. What it
 * could not touch is the caller with no session at all — there is nothing to
 * bind against — so for that caller the only lever left is WHAT may be written.
 * #752 pulls exactly one capability out of the anonymous set and leaves the rest
 * alone, and the cut falls INSIDE the Ballot Counter arm rather than between the
 * four self-assert arms.
 *
 * So the pair of claims below is the whole point, and neither half means
 * anything without the other:
 *
 *  1. `requireSignedInVoteCounter` — the gate `disqualifyCandidateFn` and
 *     `undoDisqualificationFn` call — refuses the anonymous caller holding the
 *     correct `vote_counter` slot, and admits a signed-in Ballot Counter, a
 *     signed-in club admin, and a signed-in elected officer with an open term.
 *  2. `requireVoteCounterCapability` — the gate the FIVE #510 capabilities call
 *     (open, close, tally, Table Topics add/remove/move, award set/clear) —
 *     still admits that SAME anonymous caller, unchanged.
 *
 * (2) is the regression this change could ship: narrowing the arm rather than
 * the capability would take the whole console away from the account-less Ballot
 * Counter ADR-0010 was written for. It is asserted against the same seeded
 * caller as (1) so the two cannot drift apart.
 *
 * Which server fn calls which gate is a SOURCE fact, not a runtime one — a
 * `createServerFn` cannot be invoked from vitest — so that half lives in
 * `voting-authz.guard.test.ts` (voting.ts's five) and `minutes-authz.guard.test.ts`
 * (minutes.ts's five). This file pins the DECISION those calls get, the same
 * split `vote-counter-capability.integration.test.ts` beside it describes.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/disqualify-session-gate.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	members,
	officerTerms,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { RULING_NEEDS_SESSION_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The signed-in arms read the SESSION off the current request, which vitest has
 * none of — `getSessionUser` catches the missing context and returns null, so
 * without these two mocks every case here would silently be an anonymous one
 * and the three "still succeeds" cases would prove nothing at all. Mocked at the
 * LIBRARY boundary, exactly as `timings.integration.test.ts` does: the gate,
 * `requireClubRole` and `resolveVoteCounterAuthz` all stay real and run against
 * real rows, and what is faked is only the cookie → session lookup a test
 * process cannot have.
 */
let sessionUserId: string | null = null;
/**
 * How many times `auth.api.getSession` has been asked THIS test, and an optional
 * cap after which it starts answering null.
 *
 * Both exist for one case: the gate must resolve the session ONCE. A second read
 * is not a performance detail — it can disagree with the first, and the
 * disagreement grants. See "evaporates between reads" below.
 */
let sessionReads = 0;
let sessionDiesAfterReads: number | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () => {
				sessionReads += 1;
				if (
					sessionDiesAfterReads !== null &&
					sessionReads > sessionDiesAfterReads
				) {
					return null;
				}
				return sessionUserId ? { user: { id: sessionUserId } } : null;
			},
		},
	},
}));

const {
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireSignedInVoteCounter,
	requireVoteCounterCapability,
} = await import("./guards");

/** Give the meeting a `vote_counter` slot held by `assignedMemberId`.
 *  Keyless, which is the shape `createClubRole` actually writes, so the
 *  canonical-name fallback is what resolves it — same helper shape as
 *  `vote-counter-capability.integration.test.ts`. */
async function addVoteCounterSlot(club: SeededClub, assignedMemberId: string) {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: "Vote Counter",
			key: null,
			category: "functionary",
			isSpeakerRole: false,
			sortOrder: 50,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleSlots).values({
		meetingId: club.meetingId,
		roleDefinitionId: def.id,
		status: "claimed",
		assignedMemberId,
	});
}

/**
 * An extra roster member with a SIGN-IN identity behind it — user → Person →
 * membership, the chain `resolveAdminGrant` walks. `addRosterMember` in the
 * neighbouring file stops at the Person, which is enough for an anonymous
 * self-assert and not enough for any case here.
 */
async function addSignedInMember(
	clubId: string,
	name: string,
	clubRole: "admin" | "member" = "member",
): Promise<{ memberId: string; userId: string }> {
	const userId = randomUUID();
	const email = `${userId}@test.example`;
	await testDb
		.insert(user)
		.values({ id: userId, name, email, emailVerified: true });
	const [personRow] = await testDb
		.insert(people)
		.values({ name, email, userId })
		.returning({ id: people.id });
	const [memberRow] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: personRow.id,
			name,
			email,
			clubRole,
			status: "active",
		})
		.returning({ id: members.id });
	return { memberId: memberRow.id, userId };
}

describe.skipIf(!hasTestDb)(
	"requireSignedInVoteCounter — the gate disqualify/undo call (#752)",
	() => {
		let club: SeededClub;
		/** Every user row this test made, so `cleanup` takes them with the club. */
		let extraUserIds: string[];

		beforeEach(async () => {
			club = await seedClub();
			extraUserIds = [];
			sessionUserId = null;
			sessionReads = 0;
			sessionDiesAfterReads = null;
		});
		afterEach(async () => {
			sessionUserId = null;
			sessionReads = 0;
			sessionDiesAfterReads = null;
			await cleanup(club.clubId, [
				club.adminUserId,
				club.memberUserId,
				...extraUserIds,
			]);
		});

		// AC1. The caller this issue exists for: they hold the correct member id
		// — which the public meeting payload publishes, so nothing was guessed —
		// and they have no session. Every OTHER Ballot Counter capability still
		// answers them; this one does not.
		it("REFUSES an anonymous caller holding the correct vote_counter member id", async () => {
			await addVoteCounterSlot(club, club.memberId);
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(RULING_NEEDS_SESSION_MESSAGE);
		});

		// AC8. The refusal is not the generic one. Asserted as the INVERSE too,
		// because "contains the right words" is satisfied by a message that also
		// contains the wrong ones, and the failure this guards is a future edit
		// collapsing this back onto `NO_PERMISSION_MESSAGE` — which is what the
		// caller would otherwise see, mid-meeting, on a console whose other five
		// controls are still working.
		it("names the way out rather than reading as a generic permission error", async () => {
			await addVoteCounterSlot(club, club.memberId);
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(/sign in/i);
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.not.toThrow(/don't have permission/i);
		});

		// AC2. The Ballot Counter themselves, signed in, NOT an admin. This is
		// the case the console's copy sends them to ("or sign in yourself") and
		// the one that keeps the feature usable by the person actually running
		// the vote.
		it("ALLOWS a signed-in NON-ADMIN Ballot Counter asserting their own id", async () => {
			await addVoteCounterSlot(club, club.memberId);
			sessionUserId = club.memberUserId;
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).resolves.toMatchObject({
				allowed: true,
				via: "vote-counter-self-assert",
				actorMemberId: club.memberId,
			});
		});

		// #747's binding is still in force underneath: a session may not assert
		// somebody ELSE's id. Here that somebody else is the actual slot holder,
		// so this is the forgery #752's refusal message is ultimately about — and
		// it must fail for #747's reason, not for the missing-session one.
		it("REFUSES a signed-in member asserting the Ballot Counter's id", async () => {
			await addVoteCounterSlot(club, club.memberId);
			const intruder = await addSignedInMember(club.clubId, "Not The Counter");
			extraUserIds.push(intruder.userId);
			sessionUserId = intruder.userId;
			// `NO_PERMISSION_MESSAGE`, not the gate's own "Only the Ballot Counter
			// or a club admin" line: a caller WITH a session falls into the officer
			// retry and is refused by `requireClubRole` first. Pre-existing and
			// unchanged by #752 — asserted exactly so a later edit that reorders the
			// session check cannot swap which refusal a signed-in forger sees.
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
		});

		// AC3. Unchanged by this issue, and asserted because the admin arm returns
		// BEFORE the self-assert arm — an edit that put the session check in the
		// wrong place could refuse an admin who sent no `selfMemberId` at all,
		// which is exactly how the console calls it for an admin viewer.
		it("ALLOWS a signed-in club admin, with no self-assert at all", async () => {
			await addVoteCounterSlot(club, club.memberId);
			sessionUserId = club.adminUserId;
			await expect(
				requireSignedInVoteCounter({ meetingId: club.meetingId }),
			).resolves.toMatchObject({ allowed: true, via: "admin" });
		});

		// AC4. The fallback the console's copy literally points at ("ask an
		// officer to sign in on this device"), so it is asserted rather than
		// assumed. It runs through `requireVoteCounterCapability`'s existing
		// `requireClubRole` retry — `resolveVoteCounterAuthz` reads `club_role`
		// only and does NOT grant this member (pinned next door) — so deleting
		// that retry makes the refusal message a lie.
		it("ALLOWS a signed-in ELECTED OFFICER with an open term and club_role member", async () => {
			await addVoteCounterSlot(club, club.memberId);
			const officer = await addSignedInMember(club.clubId, "VP Education");
			extraUserIds.push(officer.userId);
			await testDb.insert(officerTerms).values({
				membershipId: officer.memberId,
				position: "vp_education",
				termStart: new Date("2026-07-01"),
			});
			sessionUserId = officer.userId;
			await expect(
				requireSignedInVoteCounter({ meetingId: club.meetingId }),
			).resolves.toMatchObject({
				allowed: true,
				via: "admin",
				actorMemberId: officer.memberId,
			});
		});

		// The ORDERING the gate's own comment claims, which nothing else can see.
		//
		// The session check runs BEFORE the capability, so an anonymous caller
		// gets the same refusal whether or not their guess at the meeting exists.
		// Move it after and this flips to "Meeting not found." — which tells a
		// caller with no session that their id was wrong, i.e. that a different id
		// would have been right. Every other anonymous case here uses a live
		// meeting whose slot resolves, so they would all still be red on a
		// reorder; none of them can tell a refusal from a DISCLOSING refusal.
		it("refuses an anonymous caller the SAME way for a meeting that does not exist", async () => {
			await addVoteCounterSlot(club, club.memberId);
			await expect(
				requireSignedInVoteCounter({
					meetingId: randomUUID(),
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(RULING_NEEDS_SESSION_MESSAGE);
		});

		// The ADMIN arm through THIS gate, for the principal the console predicts
		// with `canManageClub` rather than with the session member id.
		//
		// The client half is pinned in `vote-counter-panel.test.tsx`; without this
		// the two are asserted against different things and the claim that they
		// "agree by construction" holds only for the self-assert arm, where it is
		// true by identity. If they disagreed, the result is a rendered button that
		// refuses — the outage AC6 is about, arriving by the other door.
		it("ALLOWS a read_write impersonating superadmin — ADR-0016 parity", async () => {
			await addVoteCounterSlot(club, club.memberId);
			const superId = randomUUID();
			await testDb.insert(user).values({
				id: superId,
				name: "Platform Admin",
				email: `${superId}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			extraUserIds.push(superId);
			await testDb.insert(impersonationSessions).values({
				superadminUserId: superId,
				clubId: club.clubId,
				mode: "read_write",
				// Required for `read_write` by `startImpersonationSchema` (#246) and
				// surfaced in the club's activity feed. Not enforced by the column, so
				// written here to match what the real start path produces.
				reason: "Support request during the meeting.",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
			sessionUserId = superId;
			await expect(
				requireSignedInVoteCounter({ meetingId: club.meetingId }),
			).resolves.toMatchObject({
				allowed: true,
				via: "admin",
				// NULL, and that is the point: this principal has no membership id
				// at all, which is why the console cannot predict them from one.
				actorMemberId: null,
			});
		});

		// THE RACE, reproduced deterministically. Found by an adversarial review
		// pass on this branch; the first draft of the gate had it.
		//
		// The gate used to read the session, refuse without one, and then call
		// `requireVoteCounterCapability`, which read it AGAIN. If that second read
		// comes back null, `resolveAdminGrant` short-circuits on `!sessionUserId`
		// to an empty membership set, `sessionOf` reports `{ present: false }`, and
		// `resolveSelfAssertGrant` takes its ANONYMOUS arm — granting on
		// `selfMemberId === slotMemberId` alone. So a caller holding any valid
		// session at the first read and none at the second forges a ruling
		// attributed to the innocent slot holder: exactly the hole #752 closes.
		//
		// Reachable two ways, and the second needs no timing at all. A caller can
		// race their own sign-out against their own request and retry until it
		// lands; and `getSessionUser` SWALLOWS exceptions (`catch { return null }`),
		// so a transient auth or pool failure on the second read is
		// indistinguishable from "no session" — which here means "grant".
		//
		// The intruder is deliberately a real signed-in member of this club who is
		// NOT the Ballot Counter, asserting the Ballot Counter's published id. With
		// one session read they are bound by #747 and refused. With two they were
		// granted.
		it("REFUSES a signed-in forger whose session evaporates between reads", async () => {
			await addVoteCounterSlot(club, club.memberId);
			const intruder = await addSignedInMember(club.clubId, "Races The Gate");
			extraUserIds.push(intruder.userId);
			sessionUserId = intruder.userId;
			// Alive for the gate's own read, gone for every read after it.
			sessionDiesAfterReads = 1;
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow();
		});

		// The property underneath that case, stated directly so it cannot be
		// satisfied by the refusal arriving for some other reason: the gate asks
		// for the session EXACTLY ONCE. Two reads of mutable auth state is the bug
		// above, whatever the second read happens to return on the day.
		it("resolves the session exactly once per call", async () => {
			await addVoteCounterSlot(club, club.memberId);
			sessionUserId = club.memberUserId;
			sessionReads = 0;
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).resolves.toMatchObject({ allowed: true });
			expect(sessionReads).toBe(1);
		});

		// A session that resolves to NO membership in this club — an outsider
		// holding an account. #747 refuses them at the seam rather than letting
		// them fall back to the anonymous arm, and that has to survive a gate
		// that now requires a session: "signed in" must not become sufficient.
		it("REFUSES a session with no membership in this club", async () => {
			await addVoteCounterSlot(club, club.memberId);
			const outsiderId = randomUUID();
			await testDb.insert(user).values({
				id: outsiderId,
				name: "Outsider",
				email: `${outsiderId}@test.example`,
				emailVerified: true,
			});
			extraUserIds.push(outsiderId);
			sessionUserId = outsiderId;
			// A DIFFERENT refusal from the case above, and the difference is the
			// point: `requireMembership` throws before the role check, so this
			// caller is told they are not on the roster rather than that they lack
			// permission. Both are refusals; neither is the session message, which
			// is what proves "signed in" did not become sufficient.
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
		});
	},
);

describe.skipIf(!hasTestDb)(
	"the five #510 capabilities stay anonymous (#752 regression set)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
			sessionUserId = null;
			sessionReads = 0;
			sessionDiesAfterReads = null;
		});
		afterEach(async () => {
			sessionUserId = null;
			sessionReads = 0;
			sessionDiesAfterReads = null;
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		// AC5, and the reason this file has two describes instead of one.
		//
		// `requireVoteCounterCapability` is the single gate behind open, close,
		// tally, Table Topics add/remove/move and award set/clear. The SAME
		// anonymous caller the block above refuses must still reach it, because
		// narrowing the ARM rather than the capability would hand the whole
		// console back to nobody — the account-less Ballot Counter is the workflow
		// ADR-0010 exists for and #752 deliberately keeps.
		it("ALLOWS the same anonymous Ballot Counter the ruling gate refuses", async () => {
			await addVoteCounterSlot(club, club.memberId);
			await expect(
				requireVoteCounterCapability({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).resolves.toMatchObject({
				allowed: true,
				via: "vote-counter-self-assert",
			});
			// ...and the pair, in one test, so the two can never be read apart:
			// this is one caller, one meeting, one slot, two different answers.
			await expect(
				requireSignedInVoteCounter({
					meetingId: club.meetingId,
					selfMemberId: club.memberId,
				}),
			).rejects.toThrow(RULING_NEEDS_SESSION_MESSAGE);
		});
	},
);
