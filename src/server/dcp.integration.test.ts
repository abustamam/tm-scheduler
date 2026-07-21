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
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	applyEducationSuggestions,
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

// ---------------------------------------------------------------------------
// Education-goal derivation from Pathways completions (#245 / ADR-0022)
// ---------------------------------------------------------------------------

/** Completion timestamps inside / outside the PY 2026 window. */
const DONE_IN_WINDOW = new Date(2026, 9, 15); // Oct 15 2026
const DONE_OUT_OF_WINDOW = new Date(2026, 2, 3); // Mar 3 2026 → program year 2025

describe.skipIf(!hasTestDb)("DCP education derivation (integration)", () => {
	let seeded: SeededClub;
	/** Catalog paths are club-less and survive the club cascade — track + drop. */
	let pathIds: string[];
	/** A second club, to prove credit is club-scoped. */
	let otherClubId: string;
	let otherIds: string[];

	beforeEach(async () => {
		seeded = await seedClub();
		pathIds = [];
		const other = await seedClub();
		otherClubId = other.clubId;
		otherIds = [other.clubId, other.adminUserId, other.memberUserId];
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		await cleanup(otherIds[0], [otherIds[1], otherIds[2]]);
		if (pathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds));
		}
	});

	/** A roster member + its person (cleanup collects the person via the club). */
	async function addMemberPerson(name: string): Promise<string> {
		const personId = await seedPerson({ name });
		await testDb.insert(members).values({
			clubId: seeded.clubId,
			personId,
			name,
			clubRole: "member",
			status: "active",
		});
		return personId;
	}

	/** A fresh catalog path with a run-unique course code. */
	async function addPath(label: string): Promise<string> {
		const [row] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: `${seeded.clubId.slice(0, 8)}-${label}`,
				name: `Path ${label}`,
			})
			.returning({ id: pathwaysPaths.id });
		if (!row) throw new Error("path insert failed");
		pathIds.push(row.id);
		return row.id;
	}

	/**
	 * Seed one level row for a person on a path — the atomic "education award"
	 * unit. Defaults are the countable case (approved, dated in window, credited
	 * to the seeded club); each test overrides the one field it is probing.
	 */
	async function addLevel(opts: {
		personId: string;
		pathId: string;
		level: number;
		approved?: boolean;
		completedAt?: Date | null;
		creditedClubId?: string | null;
	}): Promise<void> {
		const [enrollment] = await testDb
			.insert(pathEnrollments)
			.values({ personId: opts.personId, pathId: opts.pathId })
			.onConflictDoNothing({
				target: [pathEnrollments.personId, pathEnrollments.pathId],
			})
			.returning({ id: pathEnrollments.id });
		let enrollmentId = enrollment?.id;
		if (!enrollmentId) {
			const [existing] = await testDb
				.select({ id: pathEnrollments.id })
				.from(pathEnrollments)
				.where(
					and(
						eq(pathEnrollments.personId, opts.personId),
						eq(pathEnrollments.pathId, opts.pathId),
					),
				)
				.limit(1);
			if (!existing) throw new Error("enrollment insert failed");
			enrollmentId = existing.id;
		}
		await testDb.insert(pathLevelProgress).values({
			enrollmentId,
			level: opts.level,
			completed: 4,
			total: 4,
			approved: opts.approved ?? true,
			completedAt:
				opts.completedAt === undefined ? DONE_IN_WINDOW : opts.completedAt,
			creditedClubId:
				opts.creditedClubId === undefined ? seeded.clubId : opts.creditedClubId,
		});
	}

	it("counts only approved, in-window, this-club-credited, dated completions", async () => {
		const p = await addMemberPerson("Deriver");
		// The one countable award: a Level 1 that satisfies every predicate.
		await addLevel({ personId: p, pathId: await addPath("ok"), level: 1 });
		// Each of these violates exactly one predicate and must NOT count.
		await addLevel({
			personId: p,
			pathId: await addPath("unapproved"),
			level: 1,
			approved: false,
		});
		await addLevel({
			personId: p,
			pathId: await addPath("undated"),
			level: 1,
			completedAt: null,
		});
		await addLevel({
			personId: p,
			pathId: await addPath("lastyear"),
			level: 1,
			completedAt: DONE_OUT_OF_WINDOW,
		});
		await addLevel({
			personId: p,
			pathId: await addPath("otherclub"),
			level: 1,
			creditedClubId: otherClubId,
		});
		await addLevel({
			personId: p,
			pathId: await addPath("nocredit"),
			level: 1,
			creditedClubId: null,
		});

		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.derivedEducation.g1).toBe(1);
	});

	it("counts awards per completion, not per member", async () => {
		// Same person, same level, two different paths ⇒ two awards.
		const p = await addMemberPerson("Two-pather");
		await addLevel({ personId: p, pathId: await addPath("a"), level: 2 });
		await addLevel({ personId: p, pathId: await addPath("b"), level: 2 });

		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.derivedEducation.g2).toBe(2);
		expect(view.derivedEducation.g3).toBe(0);
	});

	it("derives the six education goals from a mixed seed", async () => {
		// n1 = 6 → g1 6 (uncapped) · n2 = 3 → g2 2, g3 1 · n3 = 2 → g4 2
		// n45 = one L4 + one L5 → g5 1, g6 1
		for (let i = 0; i < 6; i++) {
			const p = await addMemberPerson(`L1 ${i}`);
			await addLevel({
				personId: p,
				pathId: await addPath(`l1-${i}`),
				level: 1,
			});
		}
		for (let i = 0; i < 3; i++) {
			const p = await addMemberPerson(`L2 ${i}`);
			await addLevel({
				personId: p,
				pathId: await addPath(`l2-${i}`),
				level: 2,
			});
		}
		for (let i = 0; i < 2; i++) {
			const p = await addMemberPerson(`L3 ${i}`);
			await addLevel({
				personId: p,
				pathId: await addPath(`l3-${i}`),
				level: 3,
			});
		}
		const l4 = await addMemberPerson("L4");
		await addLevel({ personId: l4, pathId: await addPath("l4"), level: 4 });
		const l5 = await addMemberPerson("L5");
		await addLevel({ personId: l5, pathId: await addPath("l5"), level: 5 });

		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.derivedEducation).toEqual({
			g1: 6,
			g2: 2,
			g3: 1,
			g4: 2,
			g5: 1,
			g6: 1,
		});
		// Derived values are suggestions only — nothing scores until applied.
		expect(view.progress.g1).toBe(0);
		expect(view.summary.goalsMet).toBe(0);
	});

	it("reports pathwaysSynced false until a dated club-credited completion exists", async () => {
		const p = await addMemberPerson("Unsynced");
		let view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.pathwaysSynced).toBe(false);

		// An undated row (approved before we first synced) still does not count.
		await addLevel({
			personId: p,
			pathId: await addPath("undated"),
			level: 1,
			completedAt: null,
		});
		view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.pathwaysSynced).toBe(false);

		// A dated completion in ANOTHER program year is enough — it proves sync.
		await addLevel({
			personId: p,
			pathId: await addPath("prioryear"),
			level: 1,
			completedAt: DONE_OUT_OF_WINDOW,
		});
		view = await getScoreboard({ clubId: seeded.clubId, programYear: PY });
		expect(view.pathwaysSynced).toBe(true);
		expect(view.derivedEducation.g1).toBe(0); // but not in THIS year's counts
	});

	it("applies the suggestions to goals 1–6 without touching g7–g10 or the base", async () => {
		await addMemberPerson("Roster filler");
		const p = await addMemberPerson("Achiever");
		await addLevel({ personId: p, pathId: await addPath("l1"), level: 1 });
		await addLevel({ personId: p, pathId: await addPath("l2"), level: 2 });

		await startScoreboard({ clubId: seeded.clubId, programYear: PY });
		// Hand-set the non-education goals; apply must leave them alone.
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g7", achieved: 3 },
			seeded.adminUserId,
		);
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 1 },
			seeded.adminUserId,
		);
		const before = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});

		const view = await applyEducationSuggestions(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminUserId,
		);

		expect(view.progress.g1).toBe(1);
		expect(view.progress.g2).toBe(1);
		expect(view.progress.g3).toBe(0);
		expect(view.progress.g7).toBe(3); // untouched
		expect(view.progress.g9).toBe(1); // untouched
		expect(view.baseMemberCount).toBe(before.baseMemberCount);
		// Applied values now score.
		expect(view.summary.goalsMet).toBe(before.summary.goalsMet);
	});

	it("keeps deriving after an apply so later completions resurface", async () => {
		const p = await addMemberPerson("Achiever");
		await addLevel({ personId: p, pathId: await addPath("l1a"), level: 1 });
		await startScoreboard({ clubId: seeded.clubId, programYear: PY });
		await applyEducationSuggestions(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminUserId,
		);

		// A new completion lands after the apply.
		const q = await addMemberPerson("Latecomer");
		await addLevel({ personId: q, pathId: await addPath("l1b"), level: 1 });

		const view = await getScoreboard({
			clubId: seeded.clubId,
			programYear: PY,
		});
		expect(view.progress.g1).toBe(1); // stored: what was applied
		expect(view.derivedEducation.g1).toBe(2); // live: includes the new one
	});

	it("refuses to apply before a scoreboard is started", async () => {
		await expect(
			applyEducationSuggestions(
				{ clubId: seeded.clubId, programYear: PY },
				null,
			),
		).rejects.toThrow(/no dcp scoreboard/i);
	});
});
