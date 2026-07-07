/**
 * DB-backed tests for the extension ingest logic (#107).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-ingest-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathwaysProjects, syncTokens } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// One Base Camp page whose single member matches the seeded "Member User" by email.
function pageForEmail(email: string) {
	return {
		results: [
			{
				user: { id: 122747, name: "Member User", email },
				path_name: "Presentation Mastery",
				course_id: "course-v1:Toastmasters+8701+8_15_2023",
				progression: {
					"Level 1": { completed: 5, total: 5, approved: true },
					"Level 2": { completed: 1, total: 3, approved: false },
					"Path Completion": { completed: 0, total: 1 },
				},
			},
		],
	};
}

// A /detail payload for the same member (122747) + path (8701) the summary
// fixture ingests — so the enrollment it joins to is created by the same POST.
function detailFor122747() {
	return {
		basecampUserId: "122747",
		courseId: "course-v1:Toastmasters+8701+8_15_2023",
		blocks: {
			type: "course",
			display_name: "Presentation Mastery",
			children: [
				{
					type: "chapter",
					display_name: "Level 1",
					complete: true,
					min_req_electives: 0,
					children: [
						{
							block_id: "ib-8701",
							type: "sequential",
							display_name: "Ice Breaker",
							complete: true,
							block_lib_type: "imported",
						},
					],
				},
			],
		},
		speeches: {},
	};
}

describe.skipIf(!hasTestDb)("pathways ingest logic", () => {
	let seed: SeededClub;
	let memberEmail: string;
	beforeEach(async () => {
		seed = await seedClub();
		memberEmail = `member-${seed.memberUserId}@test.example`;
	});
	afterEach(async () => {
		await testDb.delete(syncTokens).where(eq(syncTokens.clubId, seed.clubId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		// The 8701 catalog path is shared across every test in this file (via
		// pageForEmail's fixed course id) and outlives any single test, so it's
		// never deleted here. But "ingests details…" derives a fresh "ib-8701"
		// project into that shared path — remove it so a re-run doesn't find it
		// already stamped and report projectsDerived: 0 instead of 1.
		await testDb
			.delete(pathwaysProjects)
			.where(eq(pathwaysProjects.bcmBlockId, "ib-8701"));
	});

	async function mkToken() {
		const { createSyncToken } = await import("#/server/sync-tokens-logic");
		return createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: null,
		});
	}

	it("401s on a missing or unknown token", async () => {
		const { ingestForToken, IngestError } = await import(
			"#/server/pathways-ingest-logic"
		);
		await expect(
			ingestForToken(null, { basecampClubGuid: "g", pages: [] }),
		).rejects.toMatchObject({ status: 401 });
		await expect(
			ingestForToken("gup_nope", {
				basecampClubGuid: "g",
				pages: [pageForEmail(memberEmail)],
			}),
		).rejects.toBeInstanceOf(IngestError);
	});

	it("400s on a body that isn't a Base Camp payload", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		await expect(
			ingestForToken(token, { basecampClubGuid: "g", pages: "nope" }),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			ingestForToken(token, {
				basecampClubGuid: "g",
				pages: [{ notResults: 1 }],
			}),
		).rejects.toMatchObject({ status: 400 });
	});

	it("ingests a matching member and returns a SyncResult", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		const result = await ingestForToken(token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
		});
		expect(result.matched).toBe(1);
		expect(result.pathsUpserted).toBe(1);
		expect(result.warning).toBeUndefined();
	});

	it("stores the GUID on first sync, then soft-warns on a different GUID", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const created = await mkToken();
		await ingestForToken(created.token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
		});
		const [afterFirst] = await testDb
			.select()
			.from(syncTokens)
			.where(eq(syncTokens.id, created.id));
		expect(afterFirst.basecampClubGuid).toBe("club-guid-1");
		expect(afterFirst.lastUsedAt).not.toBeNull();

		const second = await ingestForToken(created.token, {
			basecampClubGuid: "club-guid-2",
			pages: [pageForEmail(memberEmail)],
		});
		expect(second.warning).toMatch(/different Base Camp club/i);
	});

	it("ingests details and returns a detail block", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		const res = await ingestForToken(token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
			details: [detailFor122747()],
		});
		expect(res.detail?.membersWithDetail).toBe(1);
		// "Ice Breaker" wasn't seeded → derived as a required project.
		expect(res.detail?.projectsDerived).toBe(1);
	});

	it("still works with no details (backward compatible)", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		const res = await ingestForToken(token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
		});
		expect(res.detail).toBeUndefined();
		expect(res.matched).toBe(1);
	});
});
