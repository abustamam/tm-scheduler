import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { members, officerTerms } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	seedClub,
	type SeededClub,
	testDb,
} from "#/test/db";

describe.skipIf(!hasTestDb)("CLI roster import", () => {
	let seed: SeededClub;
	let dir: string;
	beforeEach(async () => {
		seed = await seedClub();
		dir = mkdtempSync(join(tmpdir(), "officer-import-"));
	});
	afterEach(async () => {
		rmSync(dir, { recursive: true, force: true });
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});
	it("reports skipped assignments and never grants offices to new or existing members", async () => {
		const file = join(dir, "roster.csv");
		writeFileSync(
			file,
			`Customer ID,Name,Email,Status (*),Current Position\n,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President\n${randomUUID()},New,${randomUUID()}@test.example,PaidMember,Club Secretary\n`,
		);
		const stdout = execFileSync(
			"bun",
			[
				"run",
				"scripts/import-members.ts",
				"--club",
				seed.clubId,
				"--file",
				file,
			],
			{
				encoding: "utf8",
				env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
				timeout: 15000,
			},
		);
		expect(stdout).toContain("created=1 updated=1");
		expect(stdout).toContain(
			"skipped-officer-assignments=2 (CLI never grants officer access)",
		);

		// Assertions stay scoped to this run's club, including the newly created row.
		const terms = await testDb
			.select()
			.from(officerTerms)
			.innerJoin(members, eq(members.id, officerTerms.membershipId))
			.where(eq(members.clubId, seed.clubId));
		expect(terms).toEqual([]);
	});
});
