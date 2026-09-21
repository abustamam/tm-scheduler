/**
 * DB-backed tests for the `activity_log` actor resolution introduced by #396.
 *
 * The bug: officer-only server fns took `actorMemberId` from the client and
 * validated it only as a uuid, so an authenticated admin of club A could file a
 * row into club A's feed crediting a member of club B — and `loadActivity`
 * resolved member names unscoped, so it rendered that person to A's officers.
 *
 * The server fns themselves can't be invoked here (a `createServerFn` handler
 * needs a request context), so this covers the two pieces they now delegate to:
 * `resolveWriteActor` (the decision) and `loadActivity` (the render). The
 * wrapper wiring — that every fn actually calls one of them — is enforced by
 * `actor-provenance.guard.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/write-actor.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, impersonationSessions, members, user } from "#/db/schema";
import {
	NOT_ON_ROSTER_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
} from "#/lib/write-proof";
import { logActivity } from "#/server/activity";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** `rejects.toThrow` takes a SUBSTRING, so a test for one of two refusals that
 *  share a prefix would pass on the wrong one. Anchor both ends. */
const exactly = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

// The request-scoped impersonation marker is keyed on the object `getRequest()`
// returns (see impersonation-actor.ts), and outside a real request that throws
// and the marker silently no-ops. Stand in a plain object so the marker is live
// here — otherwise these tests would "pass" while proving nothing.
let requestRef: object | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		if (!requestRef) throw new Error("No request context");
		return requestRef;
	},
}));

const { resolveSessionActor, resolveWriteActor, resolveWriteActorWithProof } =
	await import("./write-actor-logic");
const { loadActivity } = await import("./activity-feed-logic");
const { getImpersonatedWriteActor } = await import("./impersonation-actor");
const { startImpersonation } = await import("./impersonation-logic");

describe.skipIf(!hasTestDb)("resolveWriteActor (#396)", () => {
	let clubA: SeededClub;
	let clubB: SeededClub;

	beforeEach(async () => {
		clubA = await seedClub();
		clubB = await seedClub();
	});
	afterEach(async () => {
		await cleanup(clubA.clubId, [clubA.adminUserId, clubA.memberUserId]);
		await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
	});

	it("credits the session's own membership and ignores the asserted actor", async () => {
		// The whole point: an admin of club A acting on club A cannot claim to be
		// somebody else, even a real member of the same club.
		const actor = await resolveWriteActor({
			clubId: clubA.clubId,
			sessionUserId: clubA.adminUserId,
			claimedActorMemberId: clubA.memberId,
		});
		expect(actor).toBe(clubA.adminMemberId);
		expect(actor).not.toBe(clubA.memberId);
	});

	it("rejects an actor from another club (the #396 forgery)", async () => {
		await expect(
			resolveWriteActor({
				clubId: clubA.clubId,
				sessionUserId: null,
				claimedActorMemberId: clubB.memberId,
			}),
		).rejects.toThrow(/not found in this club/i);
	});

	it("rejects a cross-club actor even when the caller has a real session elsewhere", async () => {
		// Signed in as an admin of B, writing to A: no membership in A, so the
		// asserted id still has to survive A's club scoping.
		await expect(
			resolveWriteActor({
				clubId: clubA.clubId,
				sessionUserId: clubB.adminUserId,
				claimedActorMemberId: clubB.adminMemberId,
			}),
		).rejects.toThrow(/not found in this club/i);
	});

	it("honours an anonymous caller's name-pick — the public sheet still works", async () => {
		const actor = await resolveWriteActor({
			clubId: clubA.clubId,
			sessionUserId: null,
			claimedActorMemberId: clubA.memberId,
		});
		expect(actor).toBe(clubA.memberId);
	});

	it("rejects an inactive member as the asserted actor", async () => {
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, clubA.memberId));
		await expect(
			resolveWriteActor({
				clubId: clubA.clubId,
				sessionUserId: null,
				claimedActorMemberId: clubA.memberId,
			}),
		).rejects.toThrow(/inactive/i);
	});

	it("falls back to the name-pick when the signed-in user isn't a member here", async () => {
		// A signed-in visitor on another club's public sheet is, for that club,
		// exactly an anonymous visitor — no worse, and the sheet keeps working.
		const actor = await resolveWriteActor({
			clubId: clubA.clubId,
			sessionUserId: clubB.memberUserId,
			claimedActorMemberId: clubA.memberId,
		});
		expect(actor).toBe(clubA.memberId);
	});

	it("resolves to null when there is neither a session membership nor a name-pick", async () => {
		const actor = await resolveWriteActor({
			clubId: clubA.clubId,
			sessionUserId: null,
			claimedActorMemberId: null,
		});
		expect(actor).toBeNull();
	});
});

describe.skipIf(!hasTestDb)("loadActivity is club-scoped (#396)", () => {
	let clubA: SeededClub;
	let clubB: SeededClub;

	beforeEach(async () => {
		clubA = await seedClub();
		clubB = await seedClub();
	});
	afterEach(async () => {
		await cleanup(clubA.clubId, [clubA.adminUserId, clubA.memberUserId]);
		await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
	});

	it("never renders another club's member name, even from a legacy forged row", async () => {
		// Simulates a row written before the fix (or by a direct insert): club A's
		// feed carrying club B's member id as actor AND as the detail subject.
		await logActivity(testDb, {
			clubId: clubA.clubId,
			actorMemberId: clubB.memberId,
			action: "release",
			targetType: "slot",
			targetId: clubA.slotId,
			detail: { fromMemberId: clubB.memberId },
		});

		const [row] = await loadActivity({ clubId: clubA.clubId });
		expect(row.actorName).toBeNull();
		expect(row.fromName).toBeNull();
	});

	it("still resolves this club's own members", async () => {
		await logActivity(testDb, {
			clubId: clubA.clubId,
			actorMemberId: clubA.adminMemberId,
			action: "release",
			targetType: "slot",
			targetId: clubA.slotId,
			detail: { fromMemberId: clubA.memberId },
		});

		const [row] = await loadActivity({ clubId: clubA.clubId });
		expect(row.actorName).toBe("Admin User");
		expect(row.fromName).toBe("Member User");
	});
});

/**
 * The impersonation hole (#396 review): a superadmin acting under an active
 * impersonation session has no membership in the club, so before this they fell
 * straight through to the asserted-actor arm — `claimSlot {memberId: X,
 * actorMemberId: Y}` on the public sheet wrote `actor_member_id = Y,
 * impersonated_by = NULL`, and the officers' feed read "Y claimed Timer". Member
 * ids ship in the public sheet payload, so Y is any active member they like.
 * That is the forged row this issue exists to close, aimed at the one principal
 * ADR-0016/#246 is built to keep attributable.
 */
describe.skipIf(!hasTestDb)(
	"resolveWriteActor under impersonation (#396)",
	() => {
		let club: SeededClub;
		let superadminId: string;

		async function seedSuperadmin(): Promise<string> {
			const id = randomUUID();
			await testDb.insert(user).values({
				id,
				name: "Super Admin",
				email: `super-${id}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			return id;
		}

		/** The activity row this test wrote, ignoring the `superadmin_acted` /
		 *  `superadmin_viewed` transparency row `startImpersonation` files. */
		async function claimRow() {
			const [row] = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, club.clubId),
						eq(activityLog.action, "claim"),
					),
				);
			return row;
		}

		beforeEach(async () => {
			club = await seedClub();
			superadminId = await seedSuperadmin();
			// A live request object, so `markImpersonatedWrite` has something to key on.
			requestRef = { id: "req" };
		});
		afterEach(async () => {
			requestRef = null;
			await cleanup(club.clubId, [
				club.adminUserId,
				club.memberUserId,
				superadminId,
			]);
		});

		it("credits the impersonating superadmin, never the name the client asserted", async () => {
			await startImpersonation(superadminId, {
				clubId: club.clubId,
				mode: "read_write",
				reason: "fixing a broken agenda",
			});

			// Exactly the forgery: assert a real, active member of THIS club (so club
			// scoping cannot save us) while holding a read_write session.
			const actor = await resolveWriteActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
				claimedActorMemberId: club.memberId,
			});
			expect(actor).toBeNull();
			expect(actor).not.toBe(club.memberId);
			// The request is marked, so every logActivity in it is attributed.
			expect(getImpersonatedWriteActor()).toBe(superadminId);

			await logActivity(testDb, {
				clubId: club.clubId,
				actorMemberId: actor,
				action: "claim",
				targetType: "slot",
				targetId: club.slotId,
				detail: { memberId: club.memberId },
			});

			const row = await claimRow();
			expect(row.actorMemberId).toBeNull();
			expect(row.impersonatedBy).toBe(superadminId);

			// And the feed does not put the asserted member's name on it.
			const entry = (await loadActivity({ clubId: club.clubId })).find(
				(e) => e.action === "claim",
			);
			expect(entry?.actorName).toBeNull();
		});

		it("marks a read_only session's write too — attribution, not authorization", async () => {
			// read_only is write-BLIND at the guards, but this surface is public: it
			// admits anonymous callers, so recognising the session grants nothing. It
			// only stops the write being laundered under a member's name.
			await startImpersonation(superadminId, { clubId: club.clubId });

			const actor = await resolveWriteActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
				claimedActorMemberId: club.memberId,
			});
			expect(actor).toBeNull();
			expect(getImpersonatedWriteActor()).toBe(superadminId);
		});

		it("without a session for THIS club the same superadmin is just a visitor", async () => {
			// The control that proves the two tests above aren't passing for some
			// unrelated reason: with no impersonation session the identical call
			// resolves to the asserted member (the honor-system public sheet, working
			// as designed) and nothing is marked.
			const actor = await resolveWriteActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
				claimedActorMemberId: club.memberId,
			});
			expect(actor).toBe(club.memberId);
			expect(getImpersonatedWriteActor()).toBeNull();
		});

		it("an expired session does not mark the write", async () => {
			await startImpersonation(superadminId, {
				clubId: club.clubId,
				mode: "read_write",
				reason: "fixing a broken agenda",
			});
			await testDb
				.update(impersonationSessions)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(impersonationSessions.superadminUserId, superadminId));

			const actor = await resolveWriteActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
				claimedActorMemberId: club.memberId,
			});
			expect(actor).toBe(club.memberId);
			expect(getImpersonatedWriteActor()).toBeNull();
		});
	},
);

/**
 * The write-proof seam (#761, ADR-0026).
 *
 * `resolveWriteActor` collapsed both arms to a bare member id, so no caller
 * could tell a signed-in member from somebody who picked a name out of "Who
 * are you?". `resolveWriteActorWithProof` is the same resolution with the arm
 * reported, and `resolveWriteActor` is now a projection of it — which is why
 * the suite above still passes unchanged and is the real regression test for
 * "no write changes behaviour".
 */
describe.skipIf(!hasTestDb)("resolveWriteActorWithProof (#761)", () => {
	let clubA: SeededClub;
	let clubB: SeededClub;

	beforeEach(async () => {
		clubA = await seedClub();
		clubB = await seedClub();
	});
	afterEach(async () => {
		await cleanup(clubA.clubId, [clubA.adminUserId, clubA.memberUserId]);
		await cleanup(clubB.clubId, [clubB.adminUserId, clubB.memberUserId]);
	});

	it("reports `session` for a signed-in active member of this club", async () => {
		const resolved = await resolveWriteActorWithProof({
			clubId: clubA.clubId,
			sessionUserId: clubA.adminUserId,
			// Asserted and ignored, exactly as before — the session wins.
			claimedActorMemberId: clubA.memberId,
		});
		expect(resolved).toEqual({
			memberId: clubA.adminMemberId,
			proof: "session",
		});
	});

	it("reports `asserted` for a session-less caller naming a roster member", async () => {
		const resolved = await resolveWriteActorWithProof({
			clubId: clubA.clubId,
			sessionUserId: null,
			claimedActorMemberId: clubA.memberId,
		});
		expect(resolved).toEqual({ memberId: clubA.memberId, proof: "asserted" });
	});

	it("reports `asserted` for a session that is not on THIS club's roster", async () => {
		// The case that makes `proof` worth having: a real magic-link session, and
		// on club A's sheet it buys nothing. A signed-in visitor is, for a club
		// they are not a member of, exactly an anonymous visitor — so this arm is
		// asserted, not session, and #761's children refuse it for anything past
		// filling a blank.
		const resolved = await resolveWriteActorWithProof({
			clubId: clubA.clubId,
			sessionUserId: clubB.memberUserId,
			claimedActorMemberId: clubA.memberId,
		});
		expect(resolved).toEqual({ memberId: clubA.memberId, proof: "asserted" });
	});

	it("returns null with no session and no name-pick", async () => {
		expect(
			await resolveWriteActorWithProof({
				clubId: clubA.clubId,
				sessionUserId: null,
				claimedActorMemberId: null,
			}),
		).toBeNull();
	});

	it("still throws on a cross-club asserted actor", async () => {
		// The #396 forgery. Adding a proof field must not soften the club scoping.
		await expect(
			resolveWriteActorWithProof({
				clubId: clubA.clubId,
				sessionUserId: null,
				claimedActorMemberId: clubB.memberId,
			}),
		).rejects.toThrow(/not found in this club/i);
	});

	it("agrees with resolveWriteActor on every arm", async () => {
		// The projection is the compatibility guarantee, and a guarantee that is
		// asserted rather than argued. If these two ever disagree, ~29 live call
		// sites changed behaviour in a PR whose whole claim is that none did.
		const cases: {
			clubId: string;
			sessionUserId: string | null;
			claimedActorMemberId: string | null;
		}[] = [
			{
				clubId: clubA.clubId,
				sessionUserId: clubA.adminUserId,
				claimedActorMemberId: clubA.memberId,
			},
			{
				clubId: clubA.clubId,
				sessionUserId: null,
				claimedActorMemberId: clubA.memberId,
			},
			{
				clubId: clubA.clubId,
				sessionUserId: clubB.memberUserId,
				claimedActorMemberId: clubA.memberId,
			},
			{ clubId: clubA.clubId, sessionUserId: null, claimedActorMemberId: null },
		];
		for (const input of cases) {
			expect(await resolveWriteActor(input)).toBe(
				(await resolveWriteActorWithProof(input))?.memberId ?? null,
			);
		}
	});
});

/**
 * `requireSessionActor` — the gate for a write that needs a PROVEN actor.
 *
 * Exercised through `resolveSessionActor`, which takes the session id
 * explicitly; `requireSessionActor` is the two-line request wrapper around it
 * (`getSessionUser()` returns null outside a request context, so the wrapper
 * itself is not reachable from vitest — the same split `resolveWriteActor` /
 * `requestWriteActor` already use, and `write-proof.guard.test.ts` pins that
 * the wrapper still reads the session).
 */
describe.skipIf(!hasTestDb)("requireSessionActor (#761)", () => {
	let club: SeededClub;
	let other: SeededClub;
	let superadminId: string;

	async function seedSuperadmin(): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Super Admin",
			email: `super-${id}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		return id;
	}

	beforeEach(async () => {
		club = await seedClub();
		other = await seedClub();
		superadminId = await seedSuperadmin();
		requestRef = { id: "req" };
	});
	afterEach(async () => {
		requestRef = null;
		await cleanup(club.clubId, [
			club.adminUserId,
			club.memberUserId,
			superadminId,
		]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	it("refuses a caller with no session, with the message the toast matches", async () => {
		await expect(
			resolveSessionActor({ clubId: club.clubId, sessionUserId: null }),
		).rejects.toThrow(exactly(SIGN_IN_REQUIRED_MESSAGE));
	});

	it("resolves a signed-in active member to their own membership", async () => {
		expect(
			await resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: club.memberUserId,
			}),
		).toEqual({ memberId: club.memberId });
	});

	it("refuses a signed-in user who is not on THIS club's roster", async () => {
		// A different refusal from the one above, on purpose: signing in again
		// cannot help, so the toast offers no "Sign in" action and the message
		// names the fix. This is also where sign-in binding's three refusals land
		// (#756/#758/#759 — no email, two clubs, a shared address).
		await expect(
			resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: other.memberUserId,
			}),
		).rejects.toThrow(exactly(NOT_ON_ROSTER_MESSAGE));
	});

	it("refuses a member whose membership is inactive", async () => {
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, club.memberId));
		await expect(
			resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: club.memberUserId,
			}),
		).rejects.toThrow(exactly(NOT_ON_ROSTER_MESSAGE));
	});

	it("admits a read_write impersonation and credits the superadmin", async () => {
		await startImpersonation(superadminId, {
			clubId: club.clubId,
			mode: "read_write",
			reason: "fixing a broken agenda",
		});
		expect(
			await resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
			}),
		).toEqual({ memberId: null });
		// Null is not "nobody" here — the request is marked, so `logActivity`
		// stamps `impersonated_by` with the real person (ADR-0016 / #246).
		expect(getImpersonatedWriteActor()).toBe(superadminId);
	});

	it("refuses a read_only impersonation — that mode is write-blind", async () => {
		// The one place this deliberately differs from `resolveWriteActorWithProof`,
		// which marks BOTH modes. There nothing is authorized (the surface already
		// admits anonymous callers, so recognising a read-only session only stops
		// a write being laundered under a member's name). Here a grant IS being
		// made, and ADR-0020's read-only mode must not make one.
		await startImpersonation(superadminId, { clubId: club.clubId });
		await expect(
			resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
			}),
		).rejects.toThrow(exactly(NOT_ON_ROSTER_MESSAGE));
		expect(getImpersonatedWriteActor()).toBeNull();
	});

	it("refuses a superadmin with no session for THIS club", async () => {
		// The control that proves the two above are not passing for some unrelated
		// reason: no impersonation session at all, same call, refused.
		await expect(
			resolveSessionActor({
				clubId: club.clubId,
				sessionUserId: superadminId,
			}),
		).rejects.toThrow(exactly(NOT_ON_ROSTER_MESSAGE));
		expect(getImpersonatedWriteActor()).toBeNull();
	});
});
