/**
 * DB-backed integration tests for `collapseMemberships` — the membership-merge
 * primitive that re-points all ten membership-scoped FKs onto a keeper and
 * deletes the absorbed `members` row.
 *
 * Covers the three required cases plus the officer-term open-term dedup:
 *   1. Data-loss fix: an OPEN officer_term + a member_dues row on the absorbed
 *      membership are RE-POINTED (not cascade-deleted) to the keeper.
 *   2. Reconcile: club_role/status/joined_at/email are folded correctly.
 *   3. Collision: keeper AND absorbed both have a same-meeting availability row
 *      and a same-period dues row → collapse succeeds, exactly one survives.
 *   4. Officer-term dedup: two OPEN terms for one position collapse to the
 *      earliest-started one.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/membership-collapse-logic.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	duesPeriods,
	memberAvailability,
	memberDues,
	members,
	officerTerms,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Import after the mock so the logic module's `#/db` import resolves to testDb
// (it only needs it for the Tx type, but the mock also avoids the import-time
// "DATABASE_URL is not set" throw when TEST_DATABASE_URL is the only URL set).
const { collapseMemberships } = await import("./membership-collapse-logic");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("collapseMemberships", () => {
	let seed: SeededClub;
	// Person ids created here so afterEach can remove them: the absorbed
	// membership is deleted during collapse, so `cleanup` (which reads the club's
	// surviving members) never sees its person — track + delete explicitly.
	let extraPersonIds: string[];

	beforeEach(async () => {
		seed = await seedClub();
		extraPersonIds = [];
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const personId of extraPersonIds) {
			await testDb.delete(members).where(eq(members.personId, personId));
			const { people } = await import("#/db/schema");
			await testDb.delete(people).where(eq(people.id, personId));
		}
	});

	/** Insert a membership (with its own tracked person) in the seeded club. */
	async function addMembership(opts: {
		name: string;
		clubRole?: "admin" | "member";
		status?: "active" | "inactive";
		email?: string | null;
		joinedAt?: Date | null;
	}): Promise<string> {
		const personId = await seedPerson({ name: opts.name });
		extraPersonIds.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: opts.name,
				clubRole: opts.clubRole ?? "member",
				status: opts.status ?? "active",
				email: opts.email ?? null,
				joinedAt: opts.joinedAt ?? null,
			})
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to insert membership");
		return m.id;
	}

	async function makePeriod(label: string): Promise<string> {
		const [p] = await testDb
			.insert(duesPeriods)
			.values({ clubId: seed.clubId, label, dueDate: new Date() })
			.returning({ id: duesPeriods.id });
		if (!p) throw new Error("Failed to insert dues period");
		return p.id;
	}

	const collapse = (keeperId: string, absorbedId: string) =>
		testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

	it("re-points an OPEN officer term + dues row to the keeper (not cascade-deleted)", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Absorbed holds an OPEN office and a paid dues record — both have
		// ON DELETE CASCADE on members, so the old merge silently destroyed them.
		await testDb.insert(officerTerms).values({
			membershipId: absorbedId,
			position: "treasurer",
			termStart: new Date(),
			termEnd: null,
		});
		const periodId = await makePeriod("2026 renewal");
		await testDb.insert(memberDues).values({
			membershipId: absorbedId,
			duesPeriodId: periodId,
			status: "paid",
			amountCents: 5000,
		});

		await collapse(keeperId, absorbedId);

		// Absorbed membership is gone.
		const absorbedRows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, absorbedId));
		expect(absorbedRows).toHaveLength(0);

		// The office survived and now references the keeper.
		const terms = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.position, "treasurer"));
		expect(terms).toHaveLength(1);
		expect(terms[0]?.membershipId).toBe(keeperId);
		expect(terms[0]?.termEnd).toBeNull();

		// The dues row survived and now references the keeper.
		const dues = await testDb
			.select()
			.from(memberDues)
			.where(eq(memberDues.duesPeriodId, periodId));
		expect(dues).toHaveLength(1);
		expect(dues[0]?.membershipId).toBe(keeperId);
		expect(dues[0]?.amountCents).toBe(5000);
	});

	it("reconciles club_role, status, joined_at, and fills a null email", async () => {
		const older = new Date(Date.now() - 400 * DAY);
		const newer = new Date(Date.now() - 100 * DAY);
		// Keeper: member / active / null email / later join.
		const keeperId = await addMembership({
			name: "Keeper",
			clubRole: "member",
			status: "active",
			email: null,
			joinedAt: newer,
		});
		// Absorbed: admin / inactive / has email / earlier join.
		const absorbedId = await addMembership({
			name: "Absorbed",
			clubRole: "admin",
			status: "inactive",
			email: "absorbed@example.com",
			joinedAt: older,
		});

		await collapse(keeperId, absorbedId);

		const [keeper] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, keeperId));
		expect(keeper?.clubRole).toBe("admin"); // higher of the two wins
		expect(keeper?.status).toBe("active"); // active if either is active
		expect(keeper?.email).toBe("absorbed@example.com"); // null filled from absorbed
		expect(keeper?.joinedAt?.getTime()).toBe(older.getTime()); // earliest known
	});

	it("survives a same-meeting availability + same-period dues collision", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Both are NOT available for the SAME meeting (unique member,meeting).
		await testDb.insert(memberAvailability).values([
			{ memberId: keeperId, meetingId: seed.meetingId },
			{ memberId: absorbedId, meetingId: seed.meetingId },
		]);
		// Both have a dues row for the SAME period (unique membership,period).
		const periodId = await makePeriod("shared period");
		await testDb.insert(memberDues).values([
			{ membershipId: keeperId, duesPeriodId: periodId, status: "paid" },
			{ membershipId: absorbedId, duesPeriodId: periodId, status: "waived" },
		]);

		// Must NOT throw a unique-violation.
		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

		// Exactly one availability row remains for (keeper, meeting); none for absorbed.
		const keeperAvail = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, keeperId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);
		expect(keeperAvail).toHaveLength(1);
		const absorbedAvail = await testDb
			.select()
			.from(memberAvailability)
			.where(eq(memberAvailability.memberId, absorbedId));
		expect(absorbedAvail).toHaveLength(0);

		// Exactly one dues row remains for (keeper, period) — the keeper's own,
		// which was recorded `paid` (the absorbed `waived` dup was dropped).
		const keeperDues = await testDb
			.select()
			.from(memberDues)
			.where(
				and(
					eq(memberDues.membershipId, keeperId),
					eq(memberDues.duesPeriodId, periodId),
				),
			);
		expect(keeperDues).toHaveLength(1);
		expect(keeperDues[0]?.status).toBe("paid");
		const absorbedDues = await testDb
			.select()
			.from(memberDues)
			.where(eq(memberDues.membershipId, absorbedId));
		expect(absorbedDues).toHaveLength(0);
	});

	it("dedupes two OPEN terms for one position down to the earliest-started", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		const earlyStart = new Date(Date.now() - 300 * DAY);
		const lateStart = new Date(Date.now() - 50 * DAY);
		// Keeper already holds an OPEN president term (later start); absorbed holds
		// an OPEN president term (earlier start). After collapse only the earliest
		// survives.
		await testDb.insert(officerTerms).values([
			{ membershipId: keeperId, position: "president", termStart: lateStart },
			{
				membershipId: absorbedId,
				position: "president",
				termStart: earlyStart,
			},
		]);

		await collapse(keeperId, absorbedId);

		const openPresident = await testDb
			.select()
			.from(officerTerms)
			.where(
				and(
					eq(officerTerms.membershipId, keeperId),
					eq(officerTerms.position, "president"),
				),
			);
		expect(openPresident).toHaveLength(1);
		expect(openPresident[0]?.termStart?.getTime()).toBe(earlyStart.getTime());
	});

	it("is a no-op when keeper === absorbed", async () => {
		const keeperId = await addMembership({ name: "Solo" });
		await expect(collapse(keeperId, keeperId)).resolves.toBeUndefined();
		const rows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, keeperId));
		expect(rows).toHaveLength(1);
	});
});
