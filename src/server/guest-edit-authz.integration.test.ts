/**
 * Who may write a guest's record — executed against a real database (#727).
 *
 * `updateGuest` became reachable from the MEETING page at #727, and that page
 * is not under `_authed`: it renders behind `useRequireIdentity`, which is an
 * identity gate, not authentication. A hidden button is not a permission, so
 * the claim that matters is what the SERVER does to a caller who does not
 * qualify — not what the rail chooses to render.
 *
 * The handler itself cannot be invoked here: a `createServerFn` has no session
 * and no RPC layer under vitest (the reason `member-write-authz.guard.test.ts`
 * exists at all). So this file executes the GATE the handler runs, against
 * seeded rows, and `guest-edit-authz.guard.test.ts` beside it pins that
 * `updateGuest` is still the thing that runs it. Neither half is the claim on
 * its own: one proves the gate refuses, the other proves the write is behind
 * it.
 *
 * The last case is the one to read before "fixing" anything here. The UI's gate
 * and the server's gate deliberately DISAGREE, and the disagreement is
 * one-directional — the server is more permissive than the rail.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, officerTerms, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	canManageClub,
	NO_PERMISSION_MESSAGE,
	NOT_A_MEMBER_MESSAGE,
	requireClubRole,
} = await import("#/server/guards");
const { applyUpdateGuest } = await import("#/server/guest-pipeline-logic");

describe.skipIf(!hasTestDb)("guest-edit authorization (#727)", () => {
	let seed: SeededClub;
	let guestId: string;
	/** A REAL signed-in user — row in `user`, row in `people` — who simply has no
	 *  membership in this club. A bare `randomUUID()` would exercise a nonexistent
	 *  ACCOUNT instead, which is a different rejection on a different branch and
	 *  says nothing about the cross-club case the payload's `clubId` makes
	 *  reachable. */
	let outsiderUserId: string;
	/** Tracked so `afterEach` can delete it BY ID. `cleanup` cascades from the
	 *  club and then deletes the people who had memberships in it — this person
	 *  has none, so it survives and leaks into the next run (CLAUDE.md's
	 *  club-less-row trap). */
	let outsiderPersonId: string;

	beforeEach(async () => {
		seed = await seedClub();
		outsiderUserId = randomUUID();
		await testDb.insert(user).values({
			id: outsiderUserId,
			name: "Outsider User",
			email: `outsider-${outsiderUserId}@test.example`,
			emailVerified: true,
		});
		outsiderPersonId = await seedPerson({
			name: "Outsider User",
			email: `outsider-${outsiderUserId}@test.example`,
			userId: outsiderUserId,
		});
		const [row] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Nadia Farouk",
				email: `nadia-${randomUUID()}@example.test`,
				phone: null,
				stage: "prospect",
			})
			.returning({ id: guests.id });
		if (!row) throw new Error("failed to seed guest");
		guestId = row.id;
	});

	afterEach(async () => {
		// Only the id this run created — an unscoped delete would take another
		// suite's in-flight rows, since vitest runs files in parallel against one
		// shared `tm_test`.
		await testDb.delete(people).where(eq(people.id, outsiderPersonId));
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			outsiderUserId,
		]);
	});

	it("REJECTS a plain member — the rung the meeting rail's viewers mostly sit on", async () => {
		// `seedClub`'s member is `club_role = member` with no officer term, which
		// is what an ordinary attendee identifying themselves on the meeting page
		// resolves to. This is criterion 5: the refusal is the server's, reached
		// without going anywhere near the UI that decides whether to draw a button.
		await expect(
			requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
	});

	it("REJECTS a signed-in user who is not in this club", async () => {
		// The cross-club case, and the one a `clubId` in the request payload makes
		// reachable: the meeting page hands `clubId` to the dialog, so a caller can
		// name any club they like. `requireMembership` is what refuses, and it
		// refuses before the guest id is ever looked at.
		//
		// The MESSAGE, not a bare `.rejects.toThrow()`. Unpatterned, this passes on
		// any throw at all — including the connection error a mis-seeded fixture
		// produces, which is how a rejection test comes to pass for a reason that
		// has nothing to do with authorization.
		await expect(
			requireClubRole(outsiderUserId, seed.clubId, ["admin"]),
		).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
	});

	it("ACCEPTS a real admin, and the write lands", async () => {
		// The positive control. Without it every rejection above would still pass
		// on a gate that refuses EVERYONE, which is a broken feature wearing a
		// secure-looking test suite.
		await expect(
			requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
		).resolves.toBeTruthy();

		await applyUpdateGuest({
			clubId: seed.clubId,
			guestId,
			name: "Nadia Farouq",
			preferredName: "Nadi",
			email: "nadia.new@example.test",
			phone: null,
		});
		const [after] = await testDb
			.select({
				name: guests.name,
				preferredName: guests.preferredName,
				email: guests.email,
			})
			.from(guests)
			.where(eq(guests.id, guestId));
		expect(after?.name).toBe("Nadia Farouq");
		expect(after?.preferredName).toBe("Nadi");
		expect(after?.email).toBe("nadia.new@example.test");
	});

	it("an ELECTED officer may write, and still sees plain text — the gap is deliberate", async () => {
		// The amendment of 2026-09-17, pinned so the next reader does not "fix" it.
		//
		// The two gates are NOT the same function and do not answer the same way:
		//
		//  · `canManageClub` (what the meeting page's `canManage` is) is
		//    `clubRole === "admin"` and nothing else.
		//  · `requireClubRole(…, ["admin"])` (what `updateGuest` runs) ALSO grants
		//    to any membership holding an open `officer_terms` row — effective
		//    admin, #202.
		//
		// So an officer who holds their seat by ELECTION rather than by stored
		// `club_role` is refused the control and would have been allowed the write.
		// That asymmetry is pre-existing — it already decides whether this panel
		// shows roster contact at all — and #727 deliberately did not widen
		// `canManage` or invent a second capability to close it. What it must not
		// do is drift silently, which is what this case is for: the server being
		// MORE permissive than the UI is the safe direction, and a change that
		// reversed it would be a real hole.
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
			termEnd: null, // open term = currently held
		});

		// The write side says yes…
		await expect(
			requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
		).resolves.toBeTruthy();
		// …and the UI's capability still says no, so the rail renders the guest
		// name as plain text and offers no dialog.
		expect(await canManageClub(seed.memberUserId, seed.clubId)).toBe(false);
		// The admin's own answer is unchanged, so this is a statement about the
		// officer row and not about `canManageClub` being broken outright.
		expect(await canManageClub(seed.adminUserId, seed.clubId)).toBe(true);
	});
});
