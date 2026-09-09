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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, roleDefinitions, user } from "#/db/schema";
import {
	DEFAULT_CLUB_TIMEZONE,
	INVALID_TIMEZONE_MESSAGE,
} from "#/lib/club-timezone";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	createClubSchema,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
		});
		createdClubs.push(a.clubId);
		const b = await createClubWithAdmin({
			clubName: "Sunrise Club",
			clubNumber: uniqueNumber(),
			adminName: "B Admin",
			adminEmail: "b@example.com",
			timezone: DEFAULT_CLUB_TIMEZONE,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
		});
		createdClubs.push(first.clubId);

		await expect(
			createClubWithAdmin({
				clubName: "Second Club",
				clubNumber: number, // duplicate
				adminName: "Second Admin",
				adminEmail: "second@example.com",
				timezone: DEFAULT_CLUB_TIMEZONE,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
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
			timezone: DEFAULT_CLUB_TIMEZONE,
		});
		createdClubs.push(res.clubId);

		const list = await listClubsForConsole();
		const row = list.clubs.find((c) => c.clubId === res.clubId);
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

	// #716/#670. The zone is picked at provisioning rather than left to the
	// column default, because correcting it after the club has meetings re-labels
	// every one of them and can break links already shared (`updateClubTimezone`).
	it("stores the provisioned time zone, and lists it in the console", async () => {
		const res = await createClubWithAdmin({
			clubName: "Pacific Club",
			clubNumber: uniqueNumber(),
			adminName: "Pacific Admin",
			adminEmail: "pacific@example.com",
			timezone: "America/Los_Angeles",
		});
		createdClubs.push(res.clubId);

		const [club] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, res.clubId));
		expect(club.timezone).toBe("America/Los_Angeles");
		// Not the column default — a create that silently ignored the input would
		// still read back a plausible zone.
		expect(club.timezone).not.toBe(DEFAULT_CLUB_TIMEZONE);

		const listed = await listClubsForConsole();
		const row = listed.clubs.find((c) => c.clubId === res.clubId);
		expect(row?.timezone).toBe("America/Los_Angeles");

		// The create form's picker renders THIS list, not one the browser built —
		// see `ConsoleClubList.zones`. A payload that stopped carrying it would
		// send the route back to importing `CLUB_TIMEZONES` client-side.
		expect(listed.zones).toContain("America/Los_Angeles");
		expect(listed.zones).toContain(DEFAULT_CLUB_TIMEZONE);
		expect(listed.zones.length).toBeGreaterThan(100);
		expect(listed.defaultZone).toBe(DEFAULT_CLUB_TIMEZONE);
	});

	/**
	 * AC 1. `createClubWithAdmin` does NOT parse its own input — the guarantee
	 * lives entirely in `provisionClub`'s `.validator(createClubSchema.parse)`,
	 * which runs before the handler. A `createServerFn` cannot be invoked from
	 * vitest, so this composes the two halves exactly as that wrapper does.
	 *
	 * Composing them is what makes the three row assertions able to FAIL: they
	 * follow a call that would have written all three rows had the parse let it
	 * through (a dropped `timezone` field would fall back to the column default
	 * and provision the club happily). Asserting them after a bare
	 * `safeParse` — a pure function — cannot fail on any input.
	 */
	async function provision(input: unknown) {
		return createClubWithAdmin(createClubSchema.parse(input));
	}

	/** Run an attempt to completion and hand back its error, tracking the club for
	 *  teardown if it unexpectedly SUCCEEDED. Deliberately not
	 *  `rejects.toThrow`: that aborts the test on the rejection assertion, so the
	 *  three row assertions — the half AC 1 is actually about — would never run
	 *  on the regression they exist to catch. This way a schema that stops
	 *  rejecting fails on "no club row was written", which is the true finding. */
	async function attempt(input: unknown): Promise<unknown> {
		return provision(input).then(
			(res) => {
				createdClubs.push(res.clubId);
				return null;
			},
			(err: unknown) => err,
		);
	}

	it("rejects an unsupported time zone before any row is written", async () => {
		const clubName = `Mars Club ${randomUUID()}`;
		const adminEmail = `mars-${randomUUID()}@example.com`;
		const base = {
			clubName,
			clubNumber: uniqueNumber(),
			adminName: "Mars Admin",
			adminEmail,
		};

		const unsupported = await attempt({ ...base, timezone: "Mars/Olympus" });
		// A MISSING zone takes the same path: the server fn is addressable with no
		// form and no client, so the console's <select> constrains nobody.
		const missing = await attempt(base);

		// AC 1's three tables. Nothing reached the transaction.
		const club = await testDb
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.name, clubName));
		expect(club, "a clubs row was written").toHaveLength(0);

		const person = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.email, adminEmail));
		expect(person, "a people row was written").toHaveLength(0);

		const member = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.email, adminEmail));
		expect(member, "a members row was written").toHaveLength(0);

		// And both failed for the RIGHT reason, with the message AC 1 names —
		// otherwise a schema that rejected everything would satisfy the rows above.
		expect((unsupported as Error | null)?.message).toContain(
			INVALID_TIMEZONE_MESSAGE,
		);
		expect((missing as Error | null)?.message).toContain(
			INVALID_TIMEZONE_MESSAGE,
		);
	});

	it("accepts a supported zone through the same validator path", async () => {
		// The control for the case above: same composition, valid zone, and the
		// club IS provisioned — so the rejections are the schema's doing and not
		// `provision` being broken in some way that would reject anything.
		const res = await provision({
			clubName: `Valid Club ${randomUUID()}`,
			clubNumber: uniqueNumber(),
			adminName: "Valid Admin",
			adminEmail: `valid-${randomUUID()}@example.com`,
			timezone: "Europe/London",
		});
		createdClubs.push(res.clubId);

		const [club] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, res.clubId));
		expect(club.timezone).toBe("Europe/London");
	});
});

describe.skipIf(!hasTestDb)("createClubWithAdmin dedupe (Rule B)", () => {
	const clubIds: string[] = [];
	const personIds: string[] = [];

	beforeEach(() => {
		clubIds.length = 0;
		personIds.length = 0;
	});
	afterEach(async () => {
		for (const id of clubIds) await cleanup(id, []);
		for (const id of personIds)
			await testDb.delete(people).where(eq(people.id, id));
	});

	function input(
		over: Partial<import("#/server/onboarding-logic").CreateClubInput> = {},
	) {
		return {
			clubName: `C ${randomUUID()}`,
			clubNumber: randomUUID().slice(0, 8),
			adminName: "Rasheed",
			adminEmail: `r-${randomUUID()}@x.io`,
			timezone: DEFAULT_CLUB_TIMEZONE,
			...over,
		};
	}

	it("creates a fresh Person when no email match exists", async () => {
		const res = await createClubWithAdmin(input());
		clubIds.push(res.clubId);
		personIds.push(res.personId);
		const [p] = await testDb
			.select()
			.from(people)
			.where(eq(people.id, res.personId));
		expect(p).toBeTruthy();
	});

	it("reuses an existing Person (one human, two memberships) on an email match", async () => {
		const email = `share-${randomUUID()}@x.io`;
		const first = await createClubWithAdmin(input({ adminEmail: email }));
		clubIds.push(first.clubId);
		personIds.push(first.personId);

		const second = await createClubWithAdmin(input({ adminEmail: email }));
		clubIds.push(second.clubId);

		expect(second.personId).toBe(first.personId);
		const rosterRows = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.personId, first.personId));
		expect(rosterRows).toHaveLength(2);
	});
});
