/**
 * DB-backed tests for the public self-add throttle (#326). Exercises
 * `applySelfAdd` directly against the test database; `#/db` is redirected to it.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/members-selfadd.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

import {
	applySelfAdd,
	SELF_ADD_MAX_PER_WINDOW,
	SELF_ADD_THROTTLED_MESSAGE,
	SELF_ADD_WINDOW_MS,
} from "./members-logic";

describe.skipIf(!hasTestDb)("public self-add throttle (#326)", () => {
	let club: SeededClub;
	const extraClubs: SeededClub[] = [];

	beforeEach(async () => {
		club = await seedClub();
		extraClubs.length = 0;
	});
	afterEach(async () => {
		for (const c of extraClubs) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/** Insert a filler (person, membership) directly with an explicit createdAt,
	 *  so a test can position rows inside or outside the throttle window without
	 *  going through `applySelfAdd`. */
	async function fillMember(clubId: string, createdAt: Date) {
		const [p] = await testDb
			.insert(people)
			.values({ name: "Filler" })
			.returning({ id: people.id });
		if (!p) throw new Error("filler person insert failed");
		await testDb
			.insert(members)
			.values({ clubId, personId: p.id, name: "Filler", createdAt });
	}

	it("allows a self-add on a club under the cap", async () => {
		const res = await applySelfAdd({ clubId: club.clubId, name: "Ada Guest" });
		expect(res.id).toBeTruthy();
		const rows = await testDb
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(eq(members.id, res.id));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("Ada Guest");
	});

	it("throttles once the club hits the cap within the window", async () => {
		const now = new Date();
		for (let i = 0; i < SELF_ADD_MAX_PER_WINDOW; i++) {
			await fillMember(club.clubId, now);
		}
		await expect(
			applySelfAdd({ clubId: club.clubId, name: "One Too Many" }),
		).rejects.toThrow(SELF_ADD_THROTTLED_MESSAGE);
	});

	it("does not count members created outside the window", async () => {
		const old = new Date(Date.now() - SELF_ADD_WINDOW_MS - 60_000);
		for (let i = 0; i < SELF_ADD_MAX_PER_WINDOW; i++) {
			await fillMember(club.clubId, old);
		}
		// The cap-worth of rows are all outside the window, so a self-add is fine.
		const res = await applySelfAdd({
			clubId: club.clubId,
			name: "Still Welcome",
		});
		expect(res.id).toBeTruthy();
	});

	it("throttle is per-club: filling club A doesn't block club B", async () => {
		const now = new Date();
		for (let i = 0; i < SELF_ADD_MAX_PER_WINDOW; i++) {
			await fillMember(club.clubId, now);
		}
		await expect(
			applySelfAdd({ clubId: club.clubId, name: "Blocked" }),
		).rejects.toThrow(SELF_ADD_THROTTLED_MESSAGE);

		const clubB = await seedClub();
		extraClubs.push(clubB);
		const res = await applySelfAdd({
			clubId: clubB.clubId,
			name: "Fresh Club",
		});
		expect(res.id).toBeTruthy();
	});
});
