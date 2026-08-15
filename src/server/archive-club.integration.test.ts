/**
 * DB-backed tests for club soft-archive (ADR-0016 / #186):
 *   - `requireMembership` rejects in an archived club (the choke point for authed
 *     WRITES, which `requireClubRole` builds on),
 *   - the authed READ gates `requireClubViewAccess` / `requireClubAdminView`
 *     reject too (#560) — they do NOT route through `requireMembership`, which is
 *     why they served an archived club's roster contact details until then,
 *   - a public club loader returns not-found for an archived club
 *     (`resolveClubByIdentifier` surfaces `archived_at`, and the shared helper
 *     `resolveClubOrRedirect` throws `notFound()` on it),
 *   - the archive → unarchive round-trip restores authed + public access, and
 *   - the `requireSuperadmin` gate the archive/unarchive server fns are wrapped
 *     in rejects a non-superadmin.
 *
 * `#/db` is redirected to the test database; `#/server/clubs` (the createServerFn
 * wrapper the public-loader helper calls) is mocked so the helper can be driven
 * without the Start runtime.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_186 \
 *     bunx vitest run src/server/archive-club.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { isNotFound } from "@tanstack/react-router";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, officerTerms, user } from "#/db/schema";
import { isClubArchived } from "#/lib/club-archive";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

const getClubByIdentifierMock = vi.hoisted(() => vi.fn());

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/server/clubs", () => ({
	getClubByIdentifier: getClubByIdentifierMock,
}));

const {
	requireClubAdminView,
	requireClubViewAccess,
	requireMembership,
	requireSuperadmin,
} = await import("#/server/guards");
const { archiveClub, unarchiveClub } = await import(
	"#/server/onboarding-logic"
);
const { resolveClubByIdentifier } = await import("#/server/clubs-logic");
const { resolveClubOrRedirect } = await import("#/lib/club-route");

const LOC = { pathname: "/club/x", searchStr: "" };

// ---------------------------------------------------------------------------
// The public-loader not-found decision — pure, driven via the mocked resolver.
// ---------------------------------------------------------------------------

describe("public club loaders treat an archived club as not-found (#186)", () => {
	function fakeClub(archivedAt: Date | null) {
		return {
			id: randomUUID(),
			slug: "acme",
			name: "Acme",
			timezone: "America/Chicago",
			clubNumber: null,
			archivedAt,
		};
	}

	it("resolveClubOrRedirect throws notFound when the club is archived", async () => {
		getClubByIdentifierMock.mockResolvedValueOnce(fakeClub(new Date()));
		const err = await resolveClubOrRedirect("acme", LOC).then(
			() => null,
			(e) => e,
		);
		expect(err).not.toBeNull();
		expect(isNotFound(err)).toBe(true);
	});

	it("resolveClubOrRedirect resolves an active club", async () => {
		const club = fakeClub(null);
		getClubByIdentifierMock.mockResolvedValueOnce(club);
		await expect(resolveClubOrRedirect("acme", LOC)).resolves.toMatchObject({
			id: club.id,
		});
	});
});

// ---------------------------------------------------------------------------
// DB-backed: guard rejection, data-layer contract, round-trip, superadmin gate.
// ---------------------------------------------------------------------------

describe.skipIf(!hasTestDb)("club soft-archive (#186)", () => {
	const createdClubs: string[] = [];
	const createdUsers: string[] = [];

	afterEach(async () => {
		for (const clubId of createdClubs) {
			await cleanup(clubId, createdUsers);
		}
		// Remove any users not swept by a club cleanup (e.g. gate-only seeds).
		if (createdUsers.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUsers));
		}
		createdClubs.length = 0;
		createdUsers.length = 0;
	});

	async function seedUser(isSuperadmin: boolean): Promise<string> {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "Gate Test",
			email: `${isSuperadmin ? "super" : "normal"}-${id}@test.example`,
			emailVerified: true,
			isSuperadmin,
		});
		createdUsers.push(id);
		return id;
	}

	it("requireMembership rejects an active member once the club is archived, and lets them back in after unarchive", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);

		// Active club: the member passes.
		await expect(
			requireMembership(seed.memberUserId, seed.clubId),
		).resolves.toMatchObject({ status: "active" });

		// Archive it: the same member is now rejected with the "archived" message.
		await archiveClub(seed.clubId);
		await expect(
			requireMembership(seed.memberUserId, seed.clubId),
		).rejects.toThrow(/archived/i);
		// The admin is rejected too — archive blocks every authed role.
		await expect(
			requireMembership(seed.adminUserId, seed.clubId),
		).rejects.toThrow(/archived/i);

		// Unarchive: full access is restored, membership row untouched.
		await unarchiveClub(seed.clubId);
		await expect(
			requireMembership(seed.memberUserId, seed.clubId),
		).resolves.toMatchObject({ status: "active" });
	});

	it("the authed READ gates reject an archived club for its own members, and restore on unarchive (#560)", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);

		// Controls first, so the rejections below can actually fail. A gate that
		// rejected everything would satisfy the archived assertions on its own.
		await expect(
			requireClubViewAccess(seed.memberUserId, seed.clubId),
		).resolves.toMatchObject({ via: "member" });
		await expect(
			requireClubAdminView(seed.adminUserId, seed.clubId),
		).resolves.toMatchObject({ via: "member" });

		await archiveClub(seed.clubId);

		// The member read gate: 24 GET server fns sit behind it (grep `requireClubViewAccess|requireClubAdminView`), including the
		// roster loaders that carry member email (#266) and phone (#559). Which of
		// those fns call it is held separately by `club-contact-gate.guard.test.ts`;
		// this is the gate itself.
		await expect(
			requireClubViewAccess(seed.memberUserId, seed.clubId),
		).rejects.toThrow(/archived/i);
		// The admin read gate — the club's own admin is no exception.
		await expect(
			requireClubAdminView(seed.adminUserId, seed.clubId),
		).rejects.toThrow(/archived/i);

		// Ordering is load-bearing: the check runs AFTER the membership resolves, so
		// a stranger still gets the membership answer and cannot use the archive
		// message to probe whether a club exists.
		const strangerId = await seedUser(false);
		await expect(
			requireClubViewAccess(strangerId, seed.clubId),
		).rejects.toThrow(/not a member/i);

		// Unarchive restores both gates; no membership row was touched.
		await unarchiveClub(seed.clubId);
		await expect(
			requireClubViewAccess(seed.memberUserId, seed.clubId),
		).resolves.toMatchObject({ via: "member" });
		await expect(
			requireClubAdminView(seed.adminUserId, seed.clubId),
		).resolves.toMatchObject({ via: "member" });
	});

	it("the admin read gate rejects an archived club for an EFFECTIVE admin too (#202/#560)", async () => {
		// `requireClubAdminView` has TWO member arms: a stored `club_role = admin`,
		// and any membership holding an open officer term (effective-admin, #202).
		// The case above drives only the first. `seedClub()` inserts no officer_terms
		// row at all — nothing in the repo did — so this arm had never been exercised
		// against an archived club, or indeed on this gate at all.
		const seed = await seedClub();
		createdClubs.push(seed.clubId);
		await testDb.insert(officerTerms).values({
			membershipId: seed.memberId,
			position: "vp_education",
			termStart: new Date(),
			termEnd: null, // open term = currently held
		});

		// Control: the plain member now reads as an effective admin.
		await expect(
			requireClubAdminView(seed.memberUserId, seed.clubId),
		).resolves.toMatchObject({ via: "member" });

		await archiveClub(seed.clubId);
		await expect(
			requireClubAdminView(seed.memberUserId, seed.clubId),
		).rejects.toThrow(/archived/i);
	});

	it("public resolution surfaces archived_at so the loader returns not-found, and clears it on unarchive", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);
		const slug = `test-club-${seed.clubId}`;

		// Active: resolves and is publicly visible.
		const active = await resolveClubByIdentifier(slug);
		expect(active?.id).toBe(seed.clubId);
		expect(active && isClubArchived(active)).toBe(false);

		// Archived: the row still resolves, but isClubArchived is true — exactly the
		// condition resolveClubOrRedirect throws notFound on. No data is deleted.
		const { archivedAt } = await archiveClub(seed.clubId);
		expect(archivedAt).toBeInstanceOf(Date);
		const archived = await resolveClubByIdentifier(slug);
		expect(archived?.archivedAt).not.toBeNull();
		expect(archived && isClubArchived(archived)).toBe(true);

		// Unarchive clears the flag; the club is publicly visible again.
		await unarchiveClub(seed.clubId);
		const restored = await resolveClubByIdentifier(slug);
		expect(restored?.archivedAt).toBeNull();
		expect(restored && isClubArchived(restored)).toBe(false);
	});

	it("archiveClub is idempotent — re-archiving keeps the original timestamp", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);

		const first = await archiveClub(seed.clubId);
		const second = await archiveClub(seed.clubId);
		expect(second.archivedAt.getTime()).toBe(first.archivedAt.getTime());

		const [row] = await testDb
			.select({ archivedAt: clubs.archivedAt })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		expect(row.archivedAt?.getTime()).toBe(first.archivedAt.getTime());
	});

	it("archiveClub / unarchiveClub throw when the club does not exist", async () => {
		await expect(archiveClub(randomUUID())).rejects.toThrow(/not found/i);
		await expect(unarchiveClub(randomUUID())).rejects.toThrow(/not found/i);
	});

	it("the superadmin gate the archive/unarchive server fns use rejects a non-superadmin and admits a superadmin", async () => {
		const seed = await seedClub();
		createdClubs.push(seed.clubId);
		const normalId = await seedUser(false);
		const superId = await seedUser(true);

		// archiveConsoleClub / unarchiveConsoleClub run requireSuperadmin before the
		// db logic — a non-superadmin is rejected there.
		await expect(requireSuperadmin(normalId)).rejects.toThrow(/permission/i);

		// A superadmin passes the gate; the archive then succeeds.
		await expect(requireSuperadmin(superId)).resolves.toBeUndefined();
		const { archivedAt } = await archiveClub(seed.clubId);
		expect(archivedAt).toBeInstanceOf(Date);
	});
});
