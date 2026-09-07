/**
 * DB-backed audit tests for the five DCP scoreboard writes (#690).
 *
 * The scoreboard is the club's official Distinguished Club Program record — the
 * numbers it reports to Toastmasters International — and until this change not
 * one of its five writers appended to `activity_log`. Each write was
 * individually well-gated (ADR-0019 §4), which is exactly why the gap survived:
 * authorization and auditability are different properties and only the first was
 * built. `dcp_goal_progress.updated_by` looked like the trail and is not one — it
 * is last-writer-wins with no history, no before value, a USER id where the feed
 * needs a MEMBERSHIP id, and `dcp_scoreboards` (the membership base) has no such
 * column at all.
 *
 * What is asserted here, and why each assertion exists rather than trusting the
 * one above it:
 *
 *  - **Every one of the five writes** appends exactly one entry. A per-writer
 *    case, because the five reach the log by four different routes and a shared
 *    "the module logs" assertion would pass while one of them silently did not.
 *  - **The acting member** is recorded, so the feed can render a name. Passing
 *    null (the impersonation shape) must NOT be an error.
 *  - **Before AND after** on the direct edits. An entry carrying only the new
 *    number tells a reader nothing they could not already see on the scoreboard.
 *  - **One entry per apply, naming the goals it moved** — not one per goal, and
 *    not a list of every goal it re-wrote.
 *  - **The action split holds**: an accepted suggestion must never file as
 *    `dcp_scoreboard_edit`. `applyTrainingSuggestion` used to call `updateGoal`,
 *    so this is the regression that refactor can reintroduce for free.
 *  - **The feed renders both new actions.** `formatActivity`'s outer switch has
 *    a `default: summary = entry.action` fallback by design, so a missing case
 *    is not a type error — it is the raw string `dcp_scoreboard_edit` appearing
 *    on a club's Activity page. `activity-format.test.ts` sweeps the enum for
 *    the bare action; this pins the `detail.change` variants, which that sweep
 *    (which passes no `change`) only ever exercises through the default arm.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; skipped when
 * unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/dcp-audit.integration.test.ts
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	members,
	officerTrainingRecords,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
} from "#/db/schema";
import { formatActivity } from "#/lib/activity-format";
import type { ActivityEntry } from "#/server/activity-feed-logic";
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
	applyTrainingSuggestion,
	startScoreboard,
	updateBaseMemberCount,
	updateGoal,
} from "./dcp-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const PY = 2026;
/** A completion timestamp inside the PY 2026 window (Jul 1 2026 – Jul 1 2027). */
const DONE_IN_WINDOW = new Date(2026, 9, 15); // Oct 15 2026

/** The `detail` payload shape these five writes produce. */
type DcpDetail = {
	change?: string;
	programYear?: number;
	goalKey?: string;
	goals?: string[];
	before?: unknown;
	after?: unknown;
};

describe.skipIf(!hasTestDb)("DCP scoreboard auditing (integration)", () => {
	let seeded: SeededClub;
	/** Catalog paths are club-less and survive the club cascade — track + drop. */
	let pathIds: string[];

	beforeEach(async () => {
		seeded = await seedClub();
		pathIds = [];
	});

	afterEach(async () => {
		// The club cascade takes `activity_log`, `dcp_scoreboards` and the goal
		// rows with it. Catalog paths are club-less, so they do not go: every id
		// this file created is tracked and deleted by id, never by an unscoped
		// `delete(pathwaysPaths)` that would take a parallel suite's in-flight rows.
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		if (pathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds));
		}
	});

	/**
	 * Every activity row for THIS club, newest first. Scoped to the seeded club
	 * because vitest runs test files in parallel against one shared `tm_test`, so
	 * an unscoped read over `activity_log` is order-dependent by construction.
	 */
	async function entries(action?: string) {
		const where = [eq(activityLog.clubId, seeded.clubId)];
		if (action) {
			where.push(eq(activityLog.action, action as "dcp_scoreboard_edit"));
		}
		return testDb
			.select({
				action: activityLog.action,
				actorMemberId: activityLog.actorMemberId,
				targetType: activityLog.targetType,
				targetId: activityLog.targetId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(and(...where))
			.orderBy(desc(activityLog.createdAt), desc(activityLog.id));
	}

	/** The single entry this club has, asserted to be single. */
	async function onlyEntry() {
		const rows = await entries();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error("unreachable");
		return { ...row, detail: (row.detail ?? {}) as DcpDetail };
	}

	async function scoreboardId(): Promise<string> {
		const rows = await entries();
		const id = rows[0]?.targetId;
		if (!id) throw new Error("no activity row to read a scoreboard id from");
		return id;
	}

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
				courseCode: `${seeded.clubId.slice(0, 8)}-audit-${label}`,
				name: `Path ${label}`,
			})
			.returning({ id: pathwaysPaths.id });
		if (!row) throw new Error("path insert failed");
		pathIds.push(row.id);
		return row.id;
	}

	/** One countable education award: approved, dated in window, club-credited. */
	async function addLevel(
		personId: string,
		pathId: string,
		level: number,
	): Promise<void> {
		const [enrollment] = await testDb
			.insert(pathEnrollments)
			.values({ personId, pathId })
			.returning({ id: pathEnrollments.id });
		if (!enrollment) throw new Error("enrollment insert failed");
		await testDb.insert(pathLevelProgress).values({
			enrollmentId: enrollment.id,
			level,
			completed: 4,
			total: 4,
			approved: true,
			completedAt: DONE_IN_WINDOW,
			creditedClubId: seeded.clubId,
		});
	}

	// -------------------------------------------------------------------------
	// 1. start
	// -------------------------------------------------------------------------

	it("logs the scoreboard start, with the acting member and the snapshot it took", async () => {
		await startScoreboard(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminMemberId,
		);

		const entry = await onlyEntry();
		expect(entry.action).toBe("dcp_scoreboard_edit");
		expect(entry.actorMemberId).toBe(seeded.adminMemberId);
		expect(entry.targetType).toBe("scoreboard");
		expect(entry.targetId).toBeTruthy();
		expect(entry.detail.change).toBe("started");
		expect(entry.detail.programYear).toBe(PY);
		// A create has no before; the after is what the start snapshotted, which a
		// reader could otherwise only reconstruct from the roster as it stood then.
		expect(entry.detail.before).toBeNull();
		// seedClub creates 2 active members, neither with a joinedAt ⇒ g7/g8 zero.
		expect(entry.detail.after).toEqual({ baseMemberCount: 2, g7: 0, g8: 0 });
	});

	it("does not log a second entry when a repeated start finds the scoreboard already there", async () => {
		await startScoreboard(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminMemberId,
		);
		// `startScoreboard` is idempotent (a double-click returns the existing
		// board without reseeding). The audit entry must be idempotent with it —
		// two "started the scoreboard" lines for one scoreboard is a feed that
		// makes the club doubt the rest of it.
		await startScoreboard(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminMemberId,
		);

		expect(await entries()).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// 2. updateGoal
	// -------------------------------------------------------------------------

	it("logs a goal edit with the value it replaced", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);
		const board = await scoreboardId();

		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g1", achieved: 3 },
			seeded.adminUserId,
			seeded.adminMemberId,
		);
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g1", achieved: 5 },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_scoreboard_edit");
		// start + two edits, newest first.
		expect(rows).toHaveLength(3);
		const [second, first] = rows.map((r) => (r.detail ?? {}) as DcpDetail);
		expect(first).toMatchObject({
			change: "goal",
			goalKey: "g1",
			// The seeded row exists at 0, so the first edit's before is 0 — not
			// null, which is reserved for a goal that has no row at all.
			before: 0,
			after: 3,
		});
		expect(second).toMatchObject({ change: "goal", before: 3, after: 5 });
		expect(rows[0]?.actorMemberId).toBe(seeded.adminMemberId);
		expect(rows[0]?.targetId).toBe(board);
	});

	it("logs the CLAMPED value for a composite goal, not the requested one", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);

		// g9 is composite: 7 stores as 1. An entry recording 7 would make the
		// trail disagree with the scoreboard it describes.
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 7 },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_scoreboard_edit");
		expect((rows[0]?.detail as DcpDetail).after).toBe(1);
	});

	// -------------------------------------------------------------------------
	// 3. updateBaseMemberCount
	// -------------------------------------------------------------------------

	it("logs a base-count correction with both ends", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);

		await updateBaseMemberCount(
			{ clubId: seeded.clubId, programYear: PY, baseMemberCount: 24 },
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_scoreboard_edit");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.actorMemberId).toBe(seeded.adminMemberId);
		expect(rows[0]?.detail).toMatchObject({
			change: "base",
			programYear: PY,
			before: 2,
			after: 24,
		});
	});

	it("records a cleared base as null on both ends rather than 0", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);
		await updateBaseMemberCount(
			{ clubId: seeded.clubId, programYear: PY, baseMemberCount: null },
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_scoreboard_edit");
		// null is "not snapshotted", which the ≥20-active rule treats differently
		// from a snapshotted 0 — the distinction has to survive into the trail.
		expect((rows[0]?.detail as DcpDetail).after).toBeNull();
	});

	// -------------------------------------------------------------------------
	// 4. applyEducationSuggestions
	// -------------------------------------------------------------------------

	it("logs ONE entry for an education apply, naming only the goals that moved", async () => {
		const p = await addMemberPerson("Achiever");
		await addLevel(p, await addPath("l1"), 1);
		await addLevel(p, await addPath("l2"), 2);
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);

		await applyEducationSuggestions(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_suggestion_applied");
		// One row, not six — the apply writes all six education goals, and six
		// feed lines for one click would bury everything else the club did.
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBe(seeded.adminMemberId);
		expect(rows[0]?.targetType).toBe("scoreboard");
		expect(rows[0]?.detail).toMatchObject({
			change: "education",
			programYear: PY,
			// g1 and g2 moved 0 → 1; g3–g6 were re-written at 0 and did not move,
			// so they are absent. The LIST is what carries the information.
			goals: ["g1", "g2"],
			before: { g1: 0, g2: 0 },
			after: { g1: 1, g2: 1 },
		});
	});

	it("still logs an education apply that moved nothing, with an empty goal list", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);

		await applyEducationSuggestions(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		const rows = await entries("dcp_suggestion_applied");
		expect(rows).toHaveLength(1);
		expect((rows[0]?.detail as DcpDetail).goals).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// 5. applyTrainingSuggestion
	// -------------------------------------------------------------------------

	it("logs a training apply as an APPLY, never as a typed-in goal edit", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);
		// One trainable position recorded ⇒ hasRecords true (the server-side floor
		// this apply asserts), suggestion 0 (nowhere near the seven-officer bar).
		await testDb.insert(officerTrainingRecords).values({
			membershipId: seeded.adminMemberId,
			position: "president",
			programYear: PY,
			period: 1,
		});
		// A hand-entered Met the apply will clear back to 0 — the destructive
		// direction, and the one a club would most want a trail for.
		await updateGoal(
			{ clubId: seeded.clubId, programYear: PY, goalKey: "g9", achieved: 1 },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		await applyTrainingSuggestion(
			{ clubId: seeded.clubId, programYear: PY },
			seeded.adminUserId,
			seeded.adminMemberId,
		);

		const applies = await entries("dcp_suggestion_applied");
		expect(applies).toHaveLength(1);
		expect(applies[0]?.actorMemberId).toBe(seeded.adminMemberId);
		expect(applies[0]?.detail).toMatchObject({
			change: "training",
			programYear: PY,
			goals: ["g9"],
			before: { g9: 1 },
			after: { g9: 0 },
		});
		// The write goes through the same clamp-owning helper `updateGoal` uses,
		// so the easy regression is it logging `dcp_scoreboard_edit` as well —
		// which is what it did before #690 split the two actions. Exactly the
		// start and the hand edit, and nothing from the apply.
		const edits = await entries("dcp_scoreboard_edit");
		expect(edits).toHaveLength(2);
	});

	it("writes no audit entry when the training apply is refused for want of records", async () => {
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);

		await expect(
			applyTrainingSuggestion(
				{ clubId: seeded.clubId, programYear: PY },
				seeded.adminUserId,
				seeded.adminMemberId,
			),
		).rejects.toThrow(/Record officer training first/);

		// A refused write must leave no trace: an audit row for a change that did
		// not happen is worse than a missing one, because it will be believed.
		expect(await entries("dcp_suggestion_applied")).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// The impersonation shape
	// -------------------------------------------------------------------------

	it("accepts a null actor without failing the write", async () => {
		// `requireClubRole` returns `membership.id === null` for a read-write
		// impersonating superadmin — memberless in the club. `logActivity` records
		// that case via `impersonated_by`; what must NOT happen is the write
		// erroring because the audit row has nobody to credit.
		await startScoreboard({ clubId: seeded.clubId, programYear: PY }, null);
		await updateBaseMemberCount(
			{ clubId: seeded.clubId, programYear: PY, baseMemberCount: 21 },
			null,
		);

		const rows = await entries();
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.actorMemberId === null)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The read side. Pure, so it needs no database — but it belongs beside the
// writes above: the enum value and the sentence the club actually reads are two
// halves of one change, and the half that ships broken renders the raw string
// `dcp_scoreboard_edit` on the Activity page with every other gate green.
// ---------------------------------------------------------------------------

describe("the feed renders both DCP actions", () => {
	function entry(action: string, change: string | null): ActivityEntry {
		return {
			id: "x",
			action,
			createdAt: new Date(),
			actorName: "Rasheed",
			targetType: "member",
			roleName: null,
			meetingId: null,
			meetingScheduledAt: null,
			subjectName: null,
			fromName: null,
			change,
			status: null,
			guestName: null,
			guestLink: false,
			unlinked: false,
		};
	}

	it.each([
		["dcp_scoreboard_edit", "started", "started the DCP scoreboard"],
		["dcp_scoreboard_edit", "base", "corrected the DCP membership base"],
		["dcp_scoreboard_edit", "goal", "updated a DCP goal"],
		[
			"dcp_suggestion_applied",
			"education",
			"applied the Pathways suggestions to the DCP scoreboard",
		],
		[
			"dcp_suggestion_applied",
			"training",
			"applied the officer-training suggestion to DCP goal 9",
		],
	])("%s / %s reads as a sentence", (action, change, expected) => {
		expect(formatActivity(entry(action, change)).summary).toBe(expected);
	});

	it.each([
		"dcp_scoreboard_edit",
		"dcp_suggestion_applied",
	])("%s with an unrecognized change still says something true", (action) => {
		// A future `detail.change` (or a legacy row written without one) must
		// not fall through to the raw enum string. Says less, not something
		// wrong — the same posture `plan_set`'s default arm takes.
		const summary = formatActivity(entry(action, null)).summary;
		expect(summary).not.toBe(action);
		expect(summary).toContain("DCP scoreboard");
	});
});
