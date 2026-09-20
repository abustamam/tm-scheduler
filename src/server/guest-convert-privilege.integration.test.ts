/**
 * What converting a guest onto a LAPSED membership does to that human's WRITE
 * ACCESS — executed against a real database (#501 review).
 *
 * The rest of the convert suite asserts columns, which is the right level for
 * "is the member visible". It is the wrong level for this: the claim here is
 * about authorization, and authorization is a function, not a column. So this
 * file runs the GATE — `requireClubRole(userId, clubId, ["admin"])`, the one
 * every admin-only server fn calls — against seeded rows, before and after the
 * conversion. A `createServerFn` cannot be invoked under vitest (the reason
 * `member-write-authz.guard.test.ts` exists), so the gate itself is the
 * closest thing to the real thing that runs here.
 *
 * The mechanism it measures, in order:
 *
 *  1. `requireMembership` refuses any membership whose `status` is not
 *     `active` — so while a membership is lapsed, its `club_role` is never
 *     consulted and a stale `admin` there is invisible.
 *  2. `applySetMemberStatus` writes `{ status }` and nothing else, so a
 *     membership that lapsed while it said `admin` KEEPS saying `admin`.
 *  3. #501 made convert set `status: "active"` on the reuse branch.
 *
 * (1) + (2) + (3) is a privilege restoration reached by pressing Convert on a
 * guest card that displays no role at all, on a membership chosen by Person
 * dedup, which can match the wrong human (#561). Convert now writes the role
 * down in the same statement; the first two cases below are that claim stated
 * where it actually matters.
 *
 * The last case is the one to read before changing anything here. It pins a
 * residual hole ON PURPOSE.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, officerTerms, people, user } from "#/db/schema";
import { UNDO_MEMBER_HAS_ACCOUNT_MESSAGE } from "#/lib/guest-convert";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { NO_PERMISSION_MESSAGE, requireClubRole } = await import(
	"#/server/guards"
);
const { applyConvertGuestToMember, applyUndoGuestConversion } = await import(
	"#/server/guest-pipeline-logic"
);

describe.skipIf(!hasTestDb)("convert onto a lapsed membership: access", () => {
	let seed: SeededClub;
	/** The returning human: a real sign-in account, a Person, and a lapsed
	 *  membership in the seeded club. */
	let returneeUserId: string;
	let returneePersonId: string;
	let returneeEmail: string;

	beforeEach(async () => {
		seed = await seedClub();
		returneeUserId = randomUUID();
		returneeEmail = `returnee-${returneeUserId}@test.example`;
		await testDb.insert(user).values({
			id: returneeUserId,
			name: "Returning Member",
			email: returneeEmail,
			emailVerified: true,
		});
		const [p] = await testDb
			.insert(people)
			.values({
				name: "Returning Member",
				email: returneeEmail,
				userId: returneeUserId,
			})
			.returning({ id: people.id });
		if (!p) throw new Error("Failed to seed person");
		returneePersonId = p.id;
	});

	afterEach(async () => {
		// By id, and before the cascade: `cleanup` deletes the people reachable
		// from this club's members, and this Person's membership is one of them,
		// but the `user` row is not — so it is named in the list below. Vitest
		// runs files in parallel against one shared `tm_test`, so nothing here
		// may delete unscoped.
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			returneeUserId,
		]);
		await testDb.delete(people).where(eq(people.id, returneePersonId));
	});

	/** A lapsed membership for the returnee, at the given stored role. */
	async function lapsedMembership(clubRole: "admin" | "member") {
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId: returneePersonId,
				name: "Returning Member",
				email: returneeEmail,
				status: "inactive",
				clubRole,
			})
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to seed lapsed membership");
		return m.id;
	}

	/** The guest row the VP-Membership board converts — deduped onto the
	 *  returnee by email, which is the first arm of convert's Person dedup. */
	async function guestForReturnee() {
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Returning Member",
				email: returneeEmail,
				stage: "prospect",
			})
			.returning({ id: guests.id });
		if (!g) throw new Error("Failed to seed guest");
		return g.id;
	}

	function convert(guestId: string) {
		return applyConvertGuestToMember({
			clubId: seed.clubId,
			guestId,
			actorMemberId: seed.adminMemberId,
		});
	}

	it("a lapsed ADMIN cannot write — the state convert starts from", async () => {
		// The control, and the half that makes every assertion below mean
		// something. Without it, "refused after the convert" would also pass on a
		// gate that refuses everyone, and the whole file would be a broken
		// feature wearing a secure-looking suite.
		//
		// Note WHICH refusal: `requireMembership` sends a non-active membership to
		// `requireReadWriteImpersonation`, so the stored `club_role: admin` is
		// never reached. The row says admin the entire time.
		await lapsedMembership("admin");

		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["admin"]),
		).rejects.toThrow();
	});

	it("converting a guest onto it does NOT hand the admin access back", async () => {
		// The claim, in the gate's own terms. Before the demotion this resolved:
		// the wake-up flipped `status` to `active`, `requireMembership` then let
		// the row through, and the untouched `club_role: admin` did the rest —
		// full club-admin write access granted by a VP-Membership button whose
		// toast said "(was inactive)".
		const membershipId = await lapsedMembership("admin");
		const guestId = await guestForReturnee();

		const res = await convert(guestId);
		expect(res.membershipId).toBe(membershipId);
		expect(res.reactivated).toBe(true);
		expect(res.demotedFrom).toBe("admin");

		// The member IS back — that is #501's whole point, and asserting the
		// refusal without it would pass on a convert that never reactivated.
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["member"]),
		).resolves.toBeTruthy();
		// …and is not an admin.
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
	});

	it("undo's role restore can never reach anyone who can sign in", async () => {
		// Undo writes `club_role: admin` back — the convert suite asserts that
		// column — and this is why that restore cannot be a privilege grant, in
		// two independent ways.
		//
		// First, undo REFUSES outright for a membership whose Person holds a
		// sign-in account, which is every person this file can even ask the gate
		// about. So the restore only ever runs on a row nobody can authenticate
		// as. Second, even then it is inert: the same statement returns the row
		// to `inactive`, and `requireMembership` refuses a non-active membership
		// before `club_role` is read at all — the control at the top of this file
		// is that same fact.
		//
		// Pinned because the restore otherwise looks like something to "fix" out
		// of the undo path, and removing it would make convert-then-undo a silent
		// demotion of whoever the dedup landed on.
		const guestId = await guestForReturnee();
		await lapsedMembership("admin");
		await convert(guestId);

		await expect(
			applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			}),
		).rejects.toThrow(UNDO_MEMBER_HAS_ACCOUNT_MESSAGE);

		// Refused whole, so the convert's own writes stand — including the
		// demotion. A failed undo must not be a back door to the access the
		// convert declined to restore.
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["member"]),
		).resolves.toBeTruthy();
	});

	it("an OPEN OFFICER TERM still confers admin after the convert — known, disclosed", async () => {
		// READ THIS BEFORE "FIXING" IT. This case pins behaviour the review
		// deliberately did not change, and it is a real residual hole:
		//
		// Effective-admin (#202) grants `admin` to any membership holding an open
		// `officer_terms` row, whatever `club_role` says. `applySetMemberStatus`
		// does not close officer terms on deactivation any more than it clears
		// `club_role`, so a lapsed row can carry one — and the wake-up makes it
		// live again. The demotion above therefore does NOT remove admin access
		// for a member who lapsed while holding office.
		//
		// Convert does not close the term, for three reasons, none of them
		// oversight: an office is a governance fact about who the club's
		// President IS (read by the printed agenda's officer grid, the officer
		// home, the COT seats behind DCP goal 9, the onboarding checklist), and
		// vacating one as a side effect of a guest-card button is not a
		// VP-Membership decision; `applyUndoGuestConversion` refuses outright for
		// a membership carrying ANY officer_terms row, so a close written by
		// convert could never be undone by the control that undoes the rest of
		// the conversion; and the club would silently lose an officer from every
		// one of those surfaces at the same moment.
		//
		// What convert owes the admin instead is the truth, so
		// `retainedOfficerPositions` carries it to the toast. If the decision
		// changes, this test is where it changes — and the notice copy with it.
		const membershipId = await lapsedMembership("member");
		await testDb.insert(officerTerms).values({
			membershipId,
			position: "president",
			termStart: new Date(),
			termEnd: null,
		});
		const guestId = await guestForReturnee();

		// Refused while lapsed: `requireMembership` rejects before effective-admin
		// is ever consulted, so the open term grants nothing today.
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["admin"]),
		).rejects.toThrow();

		const res = await convert(guestId);
		// Nothing to demote — the stored role was already `member`, which is
		// exactly why the demotion cannot be what closes this hole.
		expect(res.demotedFrom).toBeUndefined();
		expect(res.retainedOfficerPositions).toEqual(["president"]);

		// And now they are a full club admin again.
		await expect(
			requireClubRole(returneeUserId, seed.clubId, ["admin"]),
		).resolves.toBeTruthy();
	});
});
