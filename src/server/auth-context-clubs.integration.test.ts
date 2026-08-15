/**
 * DB-backed tests for the club switcher's archive filter (#560).
 *
 * `getAuthContext` is a `createServerFn`, so nothing inside its handler is
 * reachable from vitest — the memberships query was lifted into
 * `auth-context-logic.ts` for exactly that reason (CLAUDE.md: a query living only
 * inside a handler can be neither integration-tested nor guarded). Left in place,
 * an archived club kept its NAME and club number in every member's shell payload,
 * offered a switcher entry the `/club/$clubId` shell 404s on, and could still
 * become `activeClubId` — which drives `ensureScheduleToppedUp`, a read-triggered
 * WRITE into a club that had been taken down.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/auth-context-clubs.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { clubs, members } from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { countArchivedClubMemberships, loadUserClubMemberships } = await import(
	"#/server/auth-context-logic"
);

async function archive(clubId: string, at: Date | null): Promise<void> {
	await testDb
		.update(clubs)
		.set({ archivedAt: at })
		.where(eq(clubs.id, clubId));
}

describe.skipIf(!hasTestDb)(
	"club switcher excludes archived clubs (#560)",
	() => {
		it("drops a soft-archived club for member and admin alike, and restores it on unarchive", async () => {
			const seed = await seedClub();
			try {
				// Control: the live club is listed, carrying the name and club number
				// that archiving is supposed to take down (ADR-0024).
				const live = await loadUserClubMemberships(seed.memberUserId);
				expect(live.map((c) => c.clubId)).toContain(seed.clubId);
				expect(live.find((c) => c.clubId === seed.clubId)?.name).toBe(
					"Test Club",
				);

				await archive(seed.clubId, new Date());

				const archived = await loadUserClubMemberships(seed.memberUserId);
				expect(archived.map((c) => c.clubId)).not.toContain(seed.clubId);

				// Not role-dependent: the club's own admin loses it too.
				const asAdmin = await loadUserClubMemberships(seed.adminUserId);
				expect(asAdmin.map((c) => c.clubId)).not.toContain(seed.clubId);

				await archive(seed.clubId, null);
				const restored = await loadUserClubMemberships(seed.memberUserId);
				expect(restored.map((c) => c.clubId)).toContain(seed.clubId);
			} finally {
				await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			}
		});

		it("counts the archived memberships that the filter hid, without naming them", async () => {
			// This is what lets the club-less shell say "your club was removed" instead
			// of "you're not in a club yet … check the email your club has on file",
			// which is an account-problem message no email can fix.
			const seed = await seedClub();
			try {
				// Control: nothing archived, so the shell keeps its original copy.
				expect(await countArchivedClubMemberships(seed.memberUserId)).toBe(0);

				await archive(seed.clubId, new Date());

				expect(await countArchivedClubMemberships(seed.memberUserId)).toBe(1);
				expect(await countArchivedClubMemberships(seed.adminUserId)).toBe(1);
				// And the switcher is empty for them, which is the pair of facts the
				// shell branches on.
				expect(await loadUserClubMemberships(seed.memberUserId)).toEqual([]);

				await archive(seed.clubId, null);
				expect(await countArchivedClubMemberships(seed.memberUserId)).toBe(0);
			} finally {
				await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			}
		});

		it("filters per club, not per user — a member of two clubs keeps the live one", async () => {
			const a = await seedClub();
			const b = await seedClub();
			try {
				// One Person, memberships in both clubs (the cross-club case a
				// single-club fixture cannot see: a WHERE that scoped to the user
				// rather than the row would empty this list).
				await testDb.insert(members).values({
					clubId: b.clubId,
					personId: a.personId,
					name: "Member User",
					email: `member-${a.memberUserId}@test.example`,
					clubRole: "member",
					status: "active",
				});

				const both = await loadUserClubMemberships(a.memberUserId);
				expect(both.map((c) => c.clubId).sort()).toEqual(
					[a.clubId, b.clubId].sort(),
				);

				await archive(a.clubId, new Date());

				const remaining = await loadUserClubMemberships(a.memberUserId);
				expect(remaining.map((c) => c.clubId)).toEqual([b.clubId]);
			} finally {
				await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
				await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
			}
		});
	},
);
