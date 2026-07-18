/**
 * DB-backed tests for the VPE membership-CSV upload (#62): the preview dry-run
 * and the commit writer, against the test database. Verifies the PaidMember
 * filter, insert-vs-update classification, fill-only overwrite policy, that the
 * preview performs NO writes, and — critically — that the preview counts equal
 * the commit stats (the two share `members-import-plan.ts`, and this locks them
 * together).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/upload-members.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people } from "#/db/schema";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const HEADER =
	"Customer ID,Name,Email,Mobile Phone,Member of Club Since,Original Join Date,Status (*),Current Position";

/** Build a Toastmasters-shaped CSV from partial row records. */
function csv(rows: Record<string, string>[]): string {
	const cols = HEADER.split(",");
	const body = rows
		.map((r) => cols.map((c) => r[c] ?? "").join(","))
		.join("\n");
	return `${HEADER}\n${body}\n`;
}

async function makeClub(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(clubs)
		.values({ id, name: "Upload Test", slug: `upload-${id}` });
	return id;
}

async function clubMemberCount(clubId: string): Promise<number> {
	const rows = await testDb
		.select({ id: members.id })
		.from(members)
		.where(eq(members.clubId, clubId));
	return rows.length;
}

describe.skipIf(!hasTestDb)("membership CSV upload (#62)", () => {
	let logic: typeof import("#/server/upload-members-logic");
	const clubIds: string[] = [];

	beforeEach(async () => {
		logic = await import("#/server/upload-members-logic");
		clubIds.length = 0;
	});

	afterEach(async () => {
		for (const id of clubIds) await cleanup(id, []);
	});

	async function club(): Promise<string> {
		const id = await makeClub();
		clubIds.push(id);
		return id;
	}

	it("rejects a file that isn't a membership export", async () => {
		const clubId = await club();
		await expect(
			logic.previewMemberImport(clubId, "foo,bar\n1,2\n"),
		).rejects.toThrow(/Toastmasters membership export/);
	});

	it("filters to PaidMember rows and previews inserts WITHOUT writing", async () => {
		const clubId = await club();
		const text = csv([
			{
				"Customer ID": "PN-1",
				Name: "Ada",
				Email: "ada@x.io",
				"Status (*)": "PaidMember",
			},
			{
				"Customer ID": "PN-2",
				Name: "Bob",
				Email: "bob@x.io",
				"Status (*)": "PaidMember",
			},
			{
				"Customer ID": "PN-3",
				Name: "Cy",
				Email: "cy@x.io",
				"Status (*)": "UnpaidMember",
			},
		]);
		const preview = await logic.previewMemberImport(clubId, text);
		expect(preview.totalRows).toBe(3);
		expect(preview.paidRows).toBe(2);
		expect(preview.unpaidSkipped).toBe(1);
		expect(preview.summary.toInsert).toBe(2);
		expect(preview.summary.toUpdate).toBe(0);
		expect(preview.rows).toHaveLength(2); // only the paid rows appear
		// Preview must not touch the DB.
		expect(await clubMemberCount(clubId)).toBe(0);
	});

	it("commits the paid rows and re-preview is all updates (idempotent)", async () => {
		const clubId = await club();
		const text = csv([
			{
				"Customer ID": "PN-1",
				Name: "Ada",
				Email: "ada@x.io",
				"Status (*)": "PaidMember",
				"Member of Club Since": "5/1/2024",
			},
			{
				"Customer ID": "PN-2",
				Name: "Bob",
				Email: "bob@x.io",
				"Status (*)": "PaidMember",
			},
			{
				"Customer ID": "PN-3",
				Name: "Cy",
				Email: "cy@x.io",
				"Status (*)": "UnpaidMember",
			},
		]);

		const commit = await logic.commitMemberImport(clubId, text);
		expect(commit.stats.membersCreated).toBe(2);
		expect(commit.stats.membersUpdated).toBe(0);
		expect(commit.unpaidSkipped).toBe(1);
		expect(await clubMemberCount(clubId)).toBe(2);

		const preview2 = await logic.previewMemberImport(clubId, text);
		expect(preview2.summary.toInsert).toBe(0);
		expect(preview2.summary.toUpdate).toBe(2);

		const commit2 = await logic.commitMemberImport(clubId, text);
		expect(commit2.stats.membersCreated).toBe(0);
		expect(commit2.stats.membersUpdated).toBe(2);
		expect(await clubMemberCount(clubId)).toBe(2); // no duplicates
	});

	it("preview counts equal the commit stats (shared decision path)", async () => {
		const clubId = await club();
		const text = csv([
			{
				"Customer ID": "PN-1",
				Name: "Ada",
				Email: "ada@x.io",
				"Status (*)": "PaidMember",
			},
			{ Name: "Pat", Email: "fam@x.io", "Status (*)": "PaidMember" },
			{ Name: "Sam", Email: "fam@x.io", "Status (*)": "PaidMember" }, // shared email
			{ Name: "", "Status (*)": "PaidMember" }, // blank name → skip
		]);
		const preview = await logic.previewMemberImport(clubId, text);
		const commit = await logic.commitMemberImport(clubId, text);
		expect(preview.summary.toInsert).toBe(commit.stats.membersCreated);
		expect(preview.summary.toUpdate).toBe(commit.stats.membersUpdated);
		expect(preview.summary.toSkip).toBe(commit.stats.skippedBlankName);
		expect(preview.summary.ambiguous).toBe(commit.stats.ambiguous);
		// Pat + Sam share an email → two distinct members; Ada inserts; blank skipped.
		expect(commit.stats.membersCreated).toBe(3);
		expect(commit.stats.skippedBlankName).toBe(1);
	});

	it("fill-only: never overwrites a stored email, always sets the join date", async () => {
		const clubId = await club();
		// Seed a person + membership that already has an (edited) email.
		const [person] = await testDb
			.insert(people)
			.values({ customerId: "PN-9", name: "Original", email: "stored@x.io" })
			.returning({ id: people.id });
		if (!person) throw new Error("seed person failed");
		await testDb.insert(members).values({
			clubId,
			personId: person.id,
			name: "Original",
			email: "stored@x.io",
			phone: null,
		});

		const text = csv([
			{
				"Customer ID": "PN-9",
				Name: "CSV Name",
				Email: "csv@x.io",
				"Mobile Phone": "+15551234",
				"Member of Club Since": "5/1/2024",
				"Status (*)": "PaidMember",
			},
		]);

		const preview = await logic.previewMemberImport(clubId, text);
		expect(preview.summary.toUpdate).toBe(1);
		// Email already stored → NOT in the fill note; phone was empty → filled.
		expect(preview.rows[0].note).toContain("Fills phone");
		expect(preview.rows[0].note).not.toContain("email");
		expect(preview.rows[0].note).toContain("Sets join date");

		await logic.commitMemberImport(clubId, text);
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(m.email).toBe("stored@x.io"); // fill-only preserved the edit
		expect(m.phone).toBe("+15551234"); // empty field filled
		expect(m.joinedAt).not.toBeNull(); // dates always win
		expect(m.name).toBe("Original"); // fill-only kept the stored name
	});
});
