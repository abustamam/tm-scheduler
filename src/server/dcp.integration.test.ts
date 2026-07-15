/**
 * DB-backed integration tests for the Distinguished Club Program scoreboard
 * (#207): start (snapshot + seed + g7/g8 pre-fill), the derived read view,
 * per-goal edits (count vs composite clamp), base-count correction, and the year
 * list — over the new `dcp_scoreboards` / `dcp_goal_progress` tables.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; skipped when
 * unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_207 \
 *     bunx vitest run src/server/dcp.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	getScoreboard,
	listScoreboardYears,
	startScoreboard,
	updateBaseMemberCount,
	updateGoal,
} from "./dcp-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const PY = 2026;
/** A join date inside the 2026 program year window (Jul 1 2026 – Jul 1 2027). */
const IN_WINDOW = new Date(2026, 8, 1); // Sep 1 2026
/** A join date OUTSIDE it (belongs to program year 2025). */
const OUT_OF_WINDOW = new Date(2026, 0, 1); // Jan 1 2026

async function addMember(
	clubId: string,
	name: string,
	opts: { status?: "active" | "inactive"; joinedAt?: Date | null } = {},
): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			clubRole: "member",
			status: opts.status ?? "active",
			joinedAt: opts.joinedAt ?? null,
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("DCP scoreboard (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		// seedClub creates 2 active members (admin + member), both joinedAt null.
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("reads exists:false with zeroed progress before a scoreboard is started", async () => {
		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.exists).toBe(false);
		expect(view.currentActive).toBe(2);
		expect(Object.values(view.progress).every((v) => v === 0)).toBe(true);
		expect(view.summary.goalsMet).toBe(0);
		expect(view.summary.tier).toBeNull();
	});

	it("start snapshots the base, seeds 10 goals, and pre-fills g7/g8 from join dates", async () => {
		// 6 new members inside the window; 1 outside (must NOT count toward g7/g8).
		for (let i = 0; i < 6; i++) {
			await addMember(seeded.clubId, `New ${i}`, { joinedAt: IN_WINDOW });
		}
		await addMember(seeded.clubId, "Old joiner", { joinedAt: OUT_OF_WINDOW });

		const view = await startScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});

		expect(view.exists).toBe(true);
		expect(view.currentActive).toBe(9); // 2 seeded + 7 added
		expect(view.newMemberCount).toBe(6); // only the in-window joiners
		expect(view.baseMemberCount).toBe(9); // snapshot of current active
		expect(view.progress.g7).toBe(4); // first four new members
		expect(view.progress.g8).toBe(2); // the next two
		expect(view.progress.g1).toBe(0);
		// g7 met (4≥4), g8 not (2<4).
		expect(view.summary.goalsMet).toBe(1);
	});

	it("counts a since-departed in-window new member (status not filtered)", async () => {
		await addMember(seeded.clubId, "Left already", {
			status: "inactive",
			joinedAt: IN_WINDOW,
		});
		const view = await startScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.newMemberCount).toBe(1);
		expect(view.progress.g7).toBe(1);
	});

	it("edits a count goal and persists the achieved value", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY });
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g1", achieved: 4 },
			seeded.adminUserId,
		);
		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.progress.g1).toBe(4);
		expect(view.summary.goalsMet).toBe(1);
	});

	it("clamps a composite goal (g9) to a 0/1 toggle", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY });
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 5 },
			seeded.adminUserId,
		);
		let view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.progress.g9).toBe(1);

		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 0 },
			seeded.adminUserId,
		);
		view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.progress.g9).toBe(0);
	});

	it("rejects an unknown goal key and edits before start", async () => {
		await expect(
			updateGoal(
				{ clubId: seeded.clubId, programYear: PY, goalKey: "g99", achieved: 1 },
				null,
			),
		).rejects.toThrow(/unknown dcp goal/i);

		await expect(
			updateGoal(
				{ clubId: seeded.clubId, programYear: PY, goalKey: "g1", achieved: 1 },
				null,
			),
		).rejects.toThrow(/no dcp scoreboard/i);
	});

	it("corrects the base count so net +5 satisfies the membership base", async () => {
		// 13 extra active members with null join dates → 15 active, 0 new.
		for (let i = 0; i < 13; i++) {
			await addMember(seeded.clubId, `Member ${i}`);
		}
		await startScoreboard({ clubId: seeded.clubId, programYear: PY });

		let view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.currentActive).toBe(15);
		expect(view.baseMemberCount).toBe(15); // net growth 0 → base not met
		expect(view.summary.baseMet).toBe(false);

		await updateBaseMemberCount({
			clubId: seeded.clubId,
			programYear: PY,
			baseMemberCount: 10, // 15 − 10 = +5
		});
		view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.baseMemberCount).toBe(10);
		expect(view.summary.baseMet).toBe(true);
	});

	it("is idempotent — a second start does not reseed or overwrite edits", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY });
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g1", achieved: 4 },
			seeded.adminUserId,
		);
		// Add a member after the fact — must not change the frozen snapshot/pre-fill.
		await addMember(seeded.clubId, "Latecomer", { joinedAt: IN_WINDOW });

		const view = await startScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.progress.g1).toBe(4); // edit preserved
		expect(view.progress.g7).toBe(0); // no new-member pre-fill (was 0 at start)
		expect(view.baseMemberCount).toBe(2); // snapshot unchanged
	});

	it("lists started program years, newest first", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: 2025 });
		await startScoreboard({ clubId: seeded.clubId, programYear: 2026 });
		const years = await listScoreboardYears(seeded.clubId);
		expect(years).toEqual([2026, 2025]);
	});
});
