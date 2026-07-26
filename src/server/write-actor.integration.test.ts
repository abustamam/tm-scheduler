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
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import { logActivity } from "#/server/activity";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveWriteActor } = await import("./write-actor-logic");
const { loadActivity } = await import("./activity-feed-logic");

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
