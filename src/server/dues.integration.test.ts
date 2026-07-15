/**
 * DB-backed integration tests for the Treasurer membership-dues tracker (#206):
 * period create, record/waive/undo, the derived per-period status + totals, and
 * the overdue query — all over the new `dues_periods` / `member_dues` tables.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; the suite is
 * skipped when it's unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_206 \
 *     bunx vitest run src/server/dues.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberDues, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	createDuesPeriod,
	getDuesForPeriod,
	getOverdueDues,
	recordDuesPayment,
	undoDues,
	waiveDues,
} from "./dues-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const DAY = 24 * 60 * 60 * 1000;

async function addMember(
	clubId: string,
	name: string,
	status: "active" | "inactive" = "active",
): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, clubRole: "member", status })
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

async function makePeriod(
	clubId: string,
	label: string,
	dueDate: Date,
	defaultAmountCents: number | null = null,
): Promise<string> {
	const { id } = await createDuesPeriod({
		clubId,
		label,
		dueDate,
		defaultAmountCents,
	});
	return id;
}

function duesRowsFor(membershipId: string) {
	return testDb
		.select()
		.from(memberDues)
		.where(eq(memberDues.membershipId, membershipId));
}

describe.skipIf(!hasTestDb)("dues tracker (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		// Club cascade removes members, dues_periods and member_dues.
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("treats unpaid as the absence of a row; a single payment writes one paid row", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));

		// Nothing recorded yet → both seeded active members are unpaid.
		const before = await getDuesForPeriod(seeded.clubId, p1);
		expect(before.rows).toHaveLength(2);
		expect(before.rows.every((r) => r.status === null)).toBe(true);
		expect(before.totals).toMatchObject({ paid: 0, waived: 0, unpaid: 2 });

		const res = await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
			amountCents: 4500,
		});
		expect(res).toMatchObject({ rowsWritten: 1 });

		// Exactly one row exists (unpaid members have no row).
		const rows = await duesRowsFor(seeded.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: "paid",
			amountCents: 4500,
			duesPeriodId: p1,
		});
		expect(rows[0]?.paidAt).toBeInstanceOf(Date);

		const after = await getDuesForPeriod(seeded.clubId, p1);
		expect(after.totals).toMatchObject({
			paid: 1,
			waived: 0,
			unpaid: 1,
			collectedCents: 4500,
		});
	});

	it("records a full-year payment as two paid rows (current + next) sharing paid_at", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));
		const p2 = await makePeriod(seeded.clubId, "P2", new Date("2026-10-01"));

		const res = await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
			amountCents: 4500,
			fullYear: true,
			nextAmountCents: 4500,
		});
		expect(res).toMatchObject({ rowsWritten: 2, nextPeriodId: p2 });

		const rows = await duesRowsFor(seeded.memberId);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.status === "paid")).toBe(true);
		expect(new Set(rows.map((r) => r.duesPeriodId))).toEqual(new Set([p1, p2]));
		// Both rows share one paid_at.
		const times = rows.map((r) => r.paidAt?.getTime());
		expect(times[0]).toBe(times[1]);

		// Both periods now show the member as paid.
		expect(
			(await getDuesForPeriod(seeded.clubId, p1)).rows.find(
				(r) => r.membershipId === seeded.memberId,
			)?.status,
		).toBe("paid");
		expect(
			(await getDuesForPeriod(seeded.clubId, p2)).rows.find(
				(r) => r.membershipId === seeded.memberId,
			)?.status,
		).toBe("paid");
	});

	it("full-year with no following period is rejected", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));
		await expect(
			recordDuesPayment({
				clubId: seeded.clubId,
				periodId: p1,
				membershipId: seeded.memberId,
				fullYear: true,
			}),
		).rejects.toThrow(/no next dues period/i);
	});

	it("waive writes a waived row; undo removes it and reverts to unpaid", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));

		await waiveDues({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
		});
		let rows = await duesRowsFor(seeded.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "waived", amountCents: null });
		expect((await getDuesForPeriod(seeded.clubId, p1)).totals).toMatchObject({
			paid: 0,
			waived: 1,
			unpaid: 1,
		});

		await undoDues({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
		});
		rows = await duesRowsFor(seeded.memberId);
		expect(rows).toHaveLength(0);
		expect(
			(await getDuesForPeriod(seeded.clubId, p1)).rows.find(
				(r) => r.membershipId === seeded.memberId,
			)?.status,
		).toBeNull();
	});

	it("totals sum only collected paid amounts (waived collects nothing, blank amounts count as 0)", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));
		const extra = await addMember(seeded.clubId, "Zed Payer");

		// admin: paid 4500; member: paid with no amount; extra: waived.
		await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.adminMemberId,
			amountCents: 4500,
		});
		await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
		});
		await waiveDues({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: extra,
		});

		const { totals } = await getDuesForPeriod(seeded.clubId, p1);
		expect(totals).toMatchObject({
			paid: 2,
			waived: 1,
			unpaid: 0,
			collectedCents: 4500,
		});
	});

	it("overdue = active members owing a past-due period, excluding full-year payers", async () => {
		// Two past-due periods and one still-upcoming.
		const now = new Date();
		const p1 = await makePeriod(
			seeded.clubId,
			"Past-1",
			new Date(now.getTime() - 60 * DAY),
		);
		const p2 = await makePeriod(
			seeded.clubId,
			"Past-2",
			new Date(now.getTime() - 10 * DAY),
		);
		await makePeriod(
			seeded.clubId,
			"Upcoming",
			new Date(now.getTime() + 30 * DAY),
		);

		const fullYearPayer = seeded.memberId; // full year at p1 → covers p1 + p2
		const singlePayer = seeded.adminMemberId; // only p1 → still owes p2
		const nonPayer = await addMember(seeded.clubId, "Nell NonPayer"); // owes both
		const inactive = await addMember(seeded.clubId, "Ida Inactive", "inactive");

		await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: fullYearPayer,
			fullYear: true,
		});
		await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: singlePayer,
		});

		const overdue = await getOverdueDues(seeded.clubId, now);
		const byMember = new Map(overdue.map((o) => [o.membershipId, o]));

		// Full-year payer is covered for both past-due periods → not overdue.
		expect(byMember.has(fullYearPayer)).toBe(false);
		// Inactive members are out of scope.
		expect(byMember.has(inactive)).toBe(false);

		// Single-period payer owes only the second past-due period.
		expect(
			byMember.get(singlePayer)?.owedPeriods.map((p) => p.periodId),
		).toEqual([p2]);
		// Non-payer owes both past-due periods (upcoming is excluded).
		expect(
			byMember
				.get(nonPayer)
				?.owedPeriods.map((p) => p.periodId)
				.sort(),
		).toEqual([p1, p2].sort());
	});

	it("no dues action ever mutates memberships.status", async () => {
		const p1 = await makePeriod(seeded.clubId, "P1", new Date("2026-04-01"));
		const p2 = await makePeriod(seeded.clubId, "P2", new Date("2026-10-01"));
		await addMember(seeded.clubId, "Stan Static", "inactive");

		const before = await testDb
			.select({ id: members.id, status: members.status })
			.from(members)
			.where(eq(members.clubId, seeded.clubId));

		// Exercise every write path.
		await recordDuesPayment({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.memberId,
			amountCents: 4500,
			fullYear: true,
			nextAmountCents: 4500,
		});
		await waiveDues({
			clubId: seeded.clubId,
			periodId: p1,
			membershipId: seeded.adminMemberId,
		});
		await undoDues({
			clubId: seeded.clubId,
			periodId: p2,
			membershipId: seeded.memberId,
		});

		const after = await testDb
			.select({ id: members.id, status: members.status })
			.from(members)
			.where(eq(members.clubId, seeded.clubId));

		const beforeMap = new Map(before.map((m) => [m.id, m.status]));
		for (const m of after) {
			expect(m.status).toBe(beforeMap.get(m.id));
		}
	});

	it("scopes reads and writes to the club (a cross-club period is rejected)", async () => {
		const other = await seedClub();
		try {
			const foreignPeriod = await makePeriod(
				other.clubId,
				"Other",
				new Date("2026-04-01"),
			);
			await expect(
				getDuesForPeriod(seeded.clubId, foreignPeriod),
			).rejects.toThrow(/not found in this club/i);
			await expect(
				recordDuesPayment({
					clubId: seeded.clubId,
					periodId: foreignPeriod,
					membershipId: seeded.memberId,
				}),
			).rejects.toThrow(/not found in this club/i);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});
