/**
 * `loadAwardReveal` (#1654): who may read the confirmed winners for the Present
 * deck's drum-roll, and what they get.
 *
 * Every case calls the logic with a user id directly (the server fn only adds
 * `getSessionUser()`, which `award-reveal.guard.test.ts` pins), so the gate is
 * exercised without a request context. The winners are read in
 * `AWARD_CATEGORIES` order whatever order the rows were inserted in.
 *
 * Skipped wholesale when TEST_DATABASE_URL is unset.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	impersonationSessions,
	meetingAwards,
	members,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadAwardReveal } = await import("#/server/award-reveal-logic");

describe.skipIf(!hasTestDb)("loadAwardReveal (#1654)", () => {
	let seed: SeededClub;
	let extraUserIds: string[];

	beforeEach(async () => {
		seed = await seedClub();
		extraUserIds = [];
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			...extraUserIds,
		]);
	});

	const newUser = async (isSuperadmin = false) => {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Someone",
			email: `reveal-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		extraUserIds.push(id);
		return id;
	};

	const writeIn = (
		category: "best_speaker" | "best_evaluator" | "best_table_topics",
		name: string | null,
	) =>
		testDb.insert(meetingAwards).values({
			meetingId: seed.meetingId,
			category,
			writeInName: name,
		});

	it("gives an active member the winners in category order", async () => {
		// protects=member read + order; fails_when=order follows insert order or a member is refused; no_claim=says nothing about the public payload
		await writeIn("best_table_topics", "Tess Topics");
		await writeIn("best_speaker", "Sam Speaker");
		const res = await loadAwardReveal(seed.meetingId, seed.memberUserId);
		expect(res).toEqual({
			winners: [
				{ category: "best_speaker", name: "Sam Speaker" },
				{ category: "best_table_topics", name: "Tess Topics" },
			],
		});
	});

	it("returns a member winner's roster name and a guest winner's guest name", async () => {
		// protects=the shared coalesce for member and guest arms; fails_when=a winner row with member/guest id comes back blank; no_claim=write-in arm (next test)
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: "Gail Guest", email: null },
					testDb,
				),
			)
			.returning({ id: guests.id });
		await testDb.insert(meetingAwards).values([
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				category: "best_evaluator",
				guestId: g.id,
			},
		]);
		const [m] = await testDb
			.select({ name: members.name })
			.from(members)
			.where(eq(members.id, seed.memberId));
		const res = await loadAwardReveal(seed.meetingId, seed.memberUserId);
		expect(res?.winners).toEqual([
			{ category: "best_speaker", name: m.name },
			{ category: "best_evaluator", name: "Gail Guest" },
		]);
	});

	it("returns a write-in winner's typed name", async () => {
		// protects=write_in_name reaches the reveal; fails_when=the write-in arm is dropped from the coalesce; no_claim=length limits (castVote's)
		await writeIn("best_evaluator", "Wanda Writein");
		const res = await loadAwardReveal(seed.meetingId, seed.memberUserId);
		expect(res?.winners).toEqual([
			{ category: "best_evaluator", name: "Wanda Writein" },
		]);
	});

	it("skips a row whose name resolved to nothing", async () => {
		// protects=a deleted member (member_id set null) never reveals a blank; fails_when=a null or blank name is returned; no_claim=the minutes still list the category as unset
		await writeIn("best_speaker", null);
		await writeIn("best_evaluator", "   ");
		await writeIn("best_table_topics", "Tess Topics");
		const res = await loadAwardReveal(seed.meetingId, seed.memberUserId);
		expect(res?.winners).toEqual([
			{ category: "best_table_topics", name: "Tess Topics" },
		]);
	});

	it("returns null with no session", async () => {
		// protects=signed-out projectors never see winners; fails_when=a null user id reads; no_claim=the route's own public payload
		await writeIn("best_speaker", "Sam Speaker");
		expect(await loadAwardReveal(seed.meetingId, null)).toBeNull();
	});

	it("returns null for a signed-in user who is not on this club's roster", async () => {
		// protects=membership of THIS club; fails_when=any session reads; no_claim=a member of another club who is also an impersonator
		await writeIn("best_speaker", "Sam Speaker");
		const outsider = await newUser();
		expect(await loadAwardReveal(seed.meetingId, outsider)).toBeNull();
	});

	it("returns null for a removed (inactive) member", async () => {
		// protects=getActiveMembership, not any member row; fails_when=an inactive roster row reads; no_claim=re-activation
		await writeIn("best_speaker", "Sam Speaker");
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.memberId));
		expect(await loadAwardReveal(seed.meetingId, seed.memberUserId)).toBeNull();
	});

	it("returns null once the club is archived", async () => {
		// protects=the archive takedown (#560); fails_when=an archived club's winners are served; no_claim=the route 404ing
		await writeIn("best_speaker", "Sam Speaker");
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		expect(await loadAwardReveal(seed.meetingId, seed.memberUserId)).toBeNull();
	});

	it.each([
		"read_only",
		"read_write",
	] as const)("gives a %s impersonating superadmin the winners", async (mode) => {
		// protects=both impersonation modes read; fails_when=either mode is refused; no_claim=an impersonation of a DIFFERENT club (next test)
		await writeIn("best_speaker", "Sam Speaker");
		const sa = await newUser(true);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: sa,
			clubId: seed.clubId,
			mode,
			...(mode === "read_write" ? { reason: "test" } : {}),
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		const res = await loadAwardReveal(seed.meetingId, sa);
		expect(res?.winners).toEqual([
			{ category: "best_speaker", name: "Sam Speaker" },
		]);
	});

	it("returns null for a superadmin impersonating a different club", async () => {
		// protects=impersonation is per club; fails_when=any active session reads every club; no_claim=expiry (getActiveImpersonation owns it)
		await writeIn("best_speaker", "Sam Speaker");
		const other = await seedClub();
		try {
			const sa = await newUser(true);
			await testDb.insert(impersonationSessions).values({
				superadminUserId: sa,
				clubId: other.clubId,
				mode: "read_only",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
			expect(await loadAwardReveal(seed.meetingId, sa)).toBeNull();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});
