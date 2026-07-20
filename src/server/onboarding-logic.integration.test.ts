/**
 * DB-backed tests for the superadmin onboarding console logic (#182): the atomic
 * create-club transaction (club + standard role template + first admin), the
 * duplicate-club-number rejection/rollback, and the unclaimed-admin-email edit
 * (allowed while unlinked, refused once linked). Tests the plain `createX` /
 * `updateX` fns directly (the createServerFn wrappers need the Start runtime);
 * `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/onboarding-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, roleDefinitions, user } from "#/db/schema";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	createClubWithAdmin,
	updateUnclaimedAdminEmail,
	listClubsForConsole,
	getClubConsoleDetail,
} = await import("./onboarding-logic");

describe.skipIf(!hasTestDb)("onboarding console (#182)", () => {
	// Track for teardown: cleanup(clubId, userIds) cascades the club and removes
	// the people its members belonged to + any explicitly-created users.
	const createdClubs: string[] = [];
	const createdUsers: string[] = [];

	afterEach(async () => {
		for (const clubId of createdClubs) {
			await cleanup(clubId, createdUsers);
		}
		createdClubs.length = 0;
		createdUsers.length = 0;
	});

	function uniqueNumber() {
		return `TM-${randomUUID().slice(0, 8)}`;
	}

	it("creates the club, the standard roles, and an unlinked admin membership atomically", async () => {
		const number = uniqueNumber();
		const res = await createClubWithAdmin({
			clubName: "Downtown Speakers",
			clubNumber: number,
			adminName: "Jamie Rivera",
			adminEmail: "jamie@example.com",
		});
		createdClubs.push(res.clubId);

		// Club row
		const [club] = await testDb
			.select()
			.from(clubs)
			.where(eq(clubs.id, res.clubId));
		expect(club.name).toBe("Downtown Speakers");
		expect(club.clubNumber).toBe(number);
		expect(club.slug.length).toBeGreaterThan(0);
		expect(club.slug).toBe(res.slug);

		// The standard role definitions (reused from ROLE_TEMPLATE)
		const defs = await testDb
			.select({ name: roleDefinitions.name })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, res.clubId))
			.orderBy(asc(roleDefinitions.sortOrder));
		expect(defs.length).toBe(ROLE_TEMPLATE.length);
		expect(defs.map((d) => d.name)).toEqual(ROLE_TEMPLATE.map((r) => r.name));

		// First admin: a Person with user_id NULL + an admin/active membership
		const [person] = await testDb
			.select()
			.from(people)
			.where(eq(people.id, res.personId));
		expect(person.name).toBe("Jamie Rivera");
		expect(person.email).toBe("jamie@example.com");
		expect(person.userId).toBeNull();

		const memberRows = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, res.clubId));
		expect(memberRows.length).toBe(1);
		expect(memberRows[0].id).toBe(res.memberId);
		expect(memberRows[0].personId).toBe(res.personId);
		expect(memberRows[0].clubRole).toBe("admin");
		expect(memberRows[0].status).toBe("active");
	});

	it("derives a unique slug, suffixing on collision", async () => {
		const a = await createClubWithAdmin({
			clubName: "Sunrise Club",
			clubNumber: uniqueNumber(),
			adminName: "A Admin",
			adminEmail: "a@example.com",
		});
		createdClubs.push(a.clubId);
		const b = await createClubWithAdmin({
			clubName: "Sunrise Club",
			clubNumber: uniqueNumber(),
			adminName: "B Admin",
			adminEmail: "b@example.com",
		});
		createdClubs.push(b.clubId);

		expect(a.slug).toBe("sunrise-club");
		expect(b.slug).toBe("sunrise-club-2");
	});

	it("rejects a duplicate club number and writes nothing (transaction rolls back)", async () => {
		const number = uniqueNumber();
		const first = await createClubWithAdmin({
			clubName: "First Club",
			clubNumber: number,
			adminName: "First Admin",
			adminEmail: "first@example.com",
		});
		createdClubs.push(first.clubId);

		await expect(
			createClubWithAdmin({
				clubName: "Second Club",
				clubNumber: number, // duplicate
				adminName: "Second Admin",
				adminEmail: "second@example.com",
			}),
		).rejects.toThrow(/already exists/i);

		// No partial writes: neither the second club nor its admin person exist.
		const secondClub = await testDb
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.name, "Second Club"));
		expect(secondClub.length).toBe(0);
		const orphanPerson = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.email, "second@example.com"));
		expect(orphanPerson.length).toBe(0);
	});

	it("allows editing the admin email while the Person is unlinked", async () => {
		const res = await createClubWithAdmin({
			clubName: "Editable Club",
			clubNumber: uniqueNumber(),
			adminName: "Edit Me",
			adminEmail: "old@example.com",
		});
		createdClubs.push(res.clubId);

		const out = await updateUnclaimedAdminEmail({
			clubId: res.clubId,
			email: "new@example.com",
		});
		expect(out.ok).toBe(true);
		expect(out.personId).toBe(res.personId);

		const [person] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, res.personId));
		expect(person.email).toBe("new@example.com");
	});

	it("refuses editing the admin email once the Person is linked", async () => {
		const res = await createClubWithAdmin({
			clubName: "Claimed Club",
			clubNumber: uniqueNumber(),
			adminName: "Claimed Admin",
			adminEmail: "claimed@example.com",
		});
		createdClubs.push(res.clubId);

		// Link the admin Person to a real sign-in account (#188 does this on sign-in).
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Claimed Admin",
			email: `claimed-${userId}@test.example`,
			emailVerified: true,
		});
		createdUsers.push(userId);
		await testDb
			.update(people)
			.set({ userId })
			.where(eq(people.id, res.personId));

		await expect(
			updateUnclaimedAdminEmail({
				clubId: res.clubId,
				email: "hijack@example.com",
			}),
		).rejects.toThrow(/claimed/i);

		// Email is unchanged.
		const [person] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, res.personId));
		expect(person.email).toBe("claimed@example.com");
	});

	it("lists clubs with member count + first-admin link status", async () => {
		const res = await createClubWithAdmin({
			clubName: "Listed Club",
			clubNumber: uniqueNumber(),
			adminName: "Listed Admin",
			adminEmail: "listed@example.com",
		});
		createdClubs.push(res.clubId);

		const list = await listClubsForConsole();
		const row = list.find((c) => c.clubId === res.clubId);
		expect(row).toBeTruthy();
		expect(row?.memberCount).toBe(1);
		expect(row?.firstAdmin?.name).toBe("Listed Admin");
		expect(row?.firstAdmin?.email).toBe("listed@example.com");
		expect(row?.firstAdmin?.linked).toBe(false);

		// Detail view exposes the Person id + claim status for the email edit.
		const detail = await getClubConsoleDetail(res.clubId);
		expect(detail.firstAdmin?.personId).toBe(res.personId);
		expect(detail.firstAdmin?.linked).toBe(false);
		expect(detail.memberCount).toBe(1);
	});
});
