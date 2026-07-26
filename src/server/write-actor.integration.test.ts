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
import { logActivity } from "#/server/activity";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

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

const { resolveWriteActor } = await import("./write-actor-logic");
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
