/**
 * DB-backed tests for `find_people` (#773 D4, #776 item 4).
 *
 * The tool declared `preferredName` and returned a hardcoded `null` for every
 * member, while the guests in the SAME list carried theirs — one result
 * answering the same field two ways depending on `kind`, which reads to a
 * caller as "nobody on the roster has a preferred name". Nothing could see it:
 * `loadPublicClubRoster` simply did not select the column, and the only
 * assertion anywhere near this payload checked that no RAW contact leaked.
 *
 * So the case that matters is one call returning both kinds with a preferred
 * name populated, and a member without one still answering `null` — the
 * distinction the field is for.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/find-people.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, guests, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { findPeopleTool } = await import("#/server/mcp/tools/find-people");
const { hashApiToken } = await import("#/server/api-tokens-logic");

interface Person {
	id: string;
	kind: "member" | "guest";
	name: string;
	preferredName: string | null;
	emailMasked?: string | null;
	phoneMasked?: string | null;
}

interface Result {
	clubId: string;
	truncated: boolean;
	people: Person[];
}

describe.skipIf(!hasTestDb)("find_people (#773 D4)", () => {
	let seed: SeededClub;
	let token: string;

	function call(args: Record<string, unknown>) {
		return findPeopleTool.handler(args, { rawToken: token }) as Promise<Result>;
	}

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;

		// The seeded admin goes by something shorter; the seeded member does not.
		await testDb
			.update(members)
			.set({ preferredName: "Rash" })
			.where(eq(members.id, seed.adminMemberId));

		await testDb.insert(guests).values({
			clubId: seed.clubId,
			name: "Jonathan Vance",
			preferredName: "Jono",
			email: "jonathan@example.com",
			stage: "prospect",
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns a member's preferred name, and null only where none is set", async () => {
		const res = await call({ clubId: seed.clubId });

		const admin = res.people.find((p) => p.id === seed.adminMemberId);
		expect(admin).toMatchObject({ kind: "member", name: "Admin User" });
		expect(admin?.preferredName).toBe("Rash");

		// The distinction the field exists to make: absent is null, not "".
		const member = res.people.find((p) => p.id === seed.memberId);
		expect(member).toMatchObject({ kind: "member", name: "Member User" });
		expect(member?.preferredName).toBeNull();
	});

	it("answers members and guests the SAME way in one call", async () => {
		// The bug was not a missing value, it was an inconsistent one: guests
		// carried a preferred name and members never did, in the same list.
		const res = await call({ clubId: seed.clubId });

		const byKind = (kind: "member" | "guest") =>
			res.people.filter((p) => p.kind === kind && p.preferredName !== null);

		expect(byKind("guest").map((p) => p.preferredName)).toEqual(["Jono"]);
		expect(byKind("member").map((p) => p.preferredName)).toEqual(["Rash"]);
	});

	it("matches a query against the preferred name, not just the full name", async () => {
		// Already implemented; it was dead for members because the field was
		// always null, so searching a roster by what someone goes by found
		// nothing.
		const res = await call({ clubId: seed.clubId, query: "rash" });
		expect(res.people.map((p) => p.name)).toEqual(["Admin User"]);

		const guest = await call({ clubId: seed.clubId, query: "jono" });
		expect(guest.people.map((p) => p.name)).toEqual(["Jonathan Vance"]);
	});

	it("still returns no raw member contact", async () => {
		// #37's rule is about phone and email, and item 4 does not touch it: a
		// member row carries identity only.
		const res = await call({ clubId: seed.clubId });
		const member = res.people.find((p) => p.id === seed.adminMemberId);
		expect(Object.keys(member ?? {}).sort()).toEqual([
			"id",
			"kind",
			"name",
			"officerPositions",
			"preferredName",
		]);
		expect(JSON.stringify(res)).not.toContain(
			`admin-${seed.adminUserId}@test.example`,
		);
	});
});
