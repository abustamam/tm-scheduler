# Pathways Sync Backend (Plan 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Base Camp's `/api/bcm/progress` JSON into a count-based Pathways progress model (paths + per-level completed/total/approved per person), so progress can be queried before any UI exists.

**Architecture:** A pure parser (`src/lib/basecamp-progress.ts`) turns the raw JSON into structured rows; a DB-touching logic module (`src/server/pathways-sync-logic.ts`) upserts paths, resolves people (email → durable Base Camp id), and mirrors per-level counts; a thin admin-guarded `createServerFn` (`src/server/pathways-sync.ts`) wraps them. Base Camp is the source of truth; this is a mirror. Names/celebration UI are later plans (1b, Phase 2).

**Tech Stack:** Drizzle ORM (node-postgres), TanStack Start `createServerFn`, Zod, Vitest, Biome (tabs + double quotes). Package manager: Bun.

**Prerequisites (both satisfied):** #64 (`people`) and #79 (`speeches`, PR #109) are both on `main`. This plan (1a) needs only `people`; the `speeches` table means Phase 2 (named specificity) can follow immediately.

**Spec:** `docs/superpowers/specs/2026-07-06-pathways-progression-model-design.md`

> **Execution note:** This branch (`spec/pathways-progression-model`) has been **rebased onto current `main`** (it now has `people`, `speeches`, `officer_terms`), so it's a valid execution base as-is. Before running Task 1, into this worktree run `bun install` and copy `.env.local` from the main checkout (fresh worktrees need deps + env). The `dev-postgres` container serves both `tm_scheduler` (dev) and `tm_test` (integration).

---

## File Structure

- **Create** `src/lib/basecamp-progress.ts` — pure parser: raw BCM JSON → `ParsedMemberPath[]`. No `#/db` import; unit-tested.
- **Create** `src/lib/basecamp-progress.test.ts` — unit tests against `samples/_api_bcm_progress_{1,2}` fixtures.
- **Modify** `src/db/schema.ts` — add `pathwayStatusEnum`, `pathwaysPaths`, `pathEnrollments`, `pathLevelProgress`; add `people.basecampUserId`.
- **Create** `src/server/pathways-sync-logic.ts` — `syncClubProgress()` upsert/match logic. Imports `#/db`; **never** imported by client code (guard test enforces).
- **Create** `src/server/pathways-sync.integration.test.ts` — DB-backed tests against `tm_test`.
- **Create** `src/server/pathways-sync.ts` — admin-guarded `createServerFn` wrapper. Exports **only** createServerFns + types (server-modules guard).
- **Generated** `drizzle/NNNN_*.sql` — migration from `db:generate`.

---

## Task 1: Schema — catalog + progress tables + `people.basecampUserId`

**Files:**
- Modify: `src/db/schema.ts`
- Generated: `drizzle/NNNN_*.sql`

- [ ] **Step 1: Add the enum and tables to `src/db/schema.ts`**

Add near the other `pgEnum` declarations:

```ts
export const pathwayStatusEnum = pgEnum("pathway_status", ["current", "legacy"]);
```

Add a `basecampUserId` column to the existing `people` table (inside its column object, after `customerId`):

```ts
	// Durable Base Camp/edX user id (from /api/bcm/progress `user.id`), captured on
	// first email match and used as the join key for Pathways sync thereafter.
	// Nullable + unique-when-present (Postgres treats NULLs as distinct).
	basecampUserId: text("basecamp_user_id").unique(),
```

Add these tables at the end of the file (before any trailing `relations` block, or after the last table):

```ts
// ---------------------------------------------------------------------------
// Pathways progress (count-based mirror of Base Camp — spec 2026-07-06).
// Paths are upserted from sync data (course_code + name); per-person per-level
// counts + `approved` mirror Base Camp's /api/bcm/progress. Base Camp is the
// system of record; this is a mirror. Project NAMES are a Phase 2 concern.
// ---------------------------------------------------------------------------

export const pathwaysPaths = pgTable("pathways_paths", {
	id: uuid("id").defaultRandom().primaryKey(),
	// Stable path code parsed from course_id (e.g. "8701" = Presentation Mastery).
	// The durable catalog key — not the display name.
	courseCode: text("course_code").notNull().unique(),
	name: text("name").notNull(),
	status: pathwayStatusEnum("status").notNull().default("current"),
	sortOrder: integer("sort_order").notNull().default(0),
});

export const pathEnrollments = pgTable(
	"path_enrollments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		pathId: uuid("path_id")
			.notNull()
			.references(() => pathwaysPaths.id, { onDelete: "cascade" }),
		lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
		archivedAt: timestamp("archived_at"),
	},
	(t) => [
		uniqueIndex("path_enrollments_person_path_idx").on(t.personId, t.pathId),
	],
);

export const pathLevelProgress = pgTable(
	"path_level_progress",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		enrollmentId: uuid("enrollment_id")
			.notNull()
			.references(() => pathEnrollments.id, { onDelete: "cascade" }),
		level: integer("level").notNull(),
		// Raw Base Camp counts — `completed` MAY exceed `total` (extra/repeated
		// electives); store as-is. `approved` is the authoritative "level done".
		completed: integer("completed").notNull(),
		total: integer("total").notNull(),
		approved: boolean("approved").notNull(),
	},
	(t) => [
		uniqueIndex("path_level_progress_enrollment_level_idx").on(
			t.enrollmentId,
			t.level,
		),
	],
);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/NNNN_*.sql` is created adding `pathway_status` enum, `pathways_paths`, `path_enrollments`, `path_level_progress`, and `people.basecamp_user_id`. No unrelated diff.

- [ ] **Step 3: Apply to dev + test databases**

Run: `bun run db:migrate`
Then apply to the integration DB:
`DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:migrate`
Expected: both apply cleanly (the `dev-postgres` container serves both).

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors (new tables typecheck; nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(pathways): count-based progress schema (paths, enrollments, level progress)"
```

---

## Task 2: Pure parser — BCM JSON → `ParsedMemberPath[]`

**Files:**
- Create: `src/lib/basecamp-progress.ts`
- Test: `src/lib/basecamp-progress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractCourseCode,
	type BcmProgressPage,
	parseProgressPages,
} from "./basecamp-progress";

function loadPage(n: 1 | 2): BcmProgressPage {
	const raw = readFileSync(
		resolve(process.cwd(), `samples/_api_bcm_progress_${n}`),
		"utf8",
	);
	return JSON.parse(raw) as BcmProgressPage;
}

describe("extractCourseCode", () => {
	it("pulls the numeric code from a course_id", () => {
		expect(
			extractCourseCode("course-v1:Toastmasters+8701+8_15_2023"),
		).toBe("8701");
		expect(extractCourseCode("course-v1:pathways+8705+8_31_2023")).toBe("8705");
	});
	it("throws on a malformed course_id", () => {
		expect(() => extractCourseCode("garbage")).toThrow();
	});
});

describe("parseProgressPages", () => {
	const rows = parseProgressPages([loadPage(1), loadPage(2)]);

	it("concatenates both pages (15 member-path rows)", () => {
		expect(rows).toHaveLength(15);
	});

	it("parses a member-path with per-level counts, preserving completed > total", () => {
		const sr = rows.find(
			(r) => r.basecampUserId === "122747" && r.courseCode === "8705",
		);
		expect(sr).toBeDefined();
		expect(sr?.pathName).toBe("Strategic Relationships");
		expect(sr?.email).toBe("rasheed.bustamam@gmail.com");
		const l3 = sr?.levels.find((l) => l.level === 3);
		expect(l3).toEqual({ level: 3, completed: 7, total: 3, approved: true });
	});

	it("keeps multiple paths for the same user as separate rows", () => {
		const mine = rows.filter((r) => r.basecampUserId === "122747");
		expect(mine.map((r) => r.courseCode).sort()).toEqual(["8705", "8711"]);
	});

	it("ignores the non-Level 'Path Completion' key", () => {
		const anyRow = rows[0];
		expect(anyRow.levels.every((l) => Number.isInteger(l.level))).toBe(true);
		expect(anyRow.levels).toHaveLength(5);
	});

	it("lowercases email", () => {
		expect(rows.every((r) => r.email === null || r.email === r.email?.toLowerCase())).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/basecamp-progress.test.ts`
Expected: FAIL — `basecamp-progress` module / exports not found.

- [ ] **Step 3: Write the parser**

```ts
/**
 * Pure parser for Base Camp Manager's progress endpoint
 * (`GET /api/bcm/progress/?club=<guid>&page=N`). Turns the raw paginated JSON
 * into flat per-(member,path) rows with per-level counts. No DB — the sync
 * upsert lives in `src/server/pathways-sync-logic.ts`.
 *
 * Base Camp gives per-LEVEL counts + `approved`, never project identity, and
 * `completed` may exceed `total` (extra/repeated electives) — preserved as-is.
 */
export interface BcmProgressLevel {
	completed: number;
	total: number;
	approved?: boolean;
}

export interface BcmProgressRow {
	user: { id: number; name: string; email: string | null };
	path_name: string;
	course_id: string;
	progression: Record<string, BcmProgressLevel>;
}

export interface BcmProgressPage {
	results: BcmProgressRow[];
}

export interface ParsedLevel {
	level: number;
	completed: number;
	total: number;
	approved: boolean;
}

export interface ParsedMemberPath {
	basecampUserId: string;
	name: string;
	email: string | null;
	courseCode: string;
	pathName: string;
	levels: ParsedLevel[];
}

/** "course-v1:Toastmasters+8701+8_15_2023" → "8701". */
export function extractCourseCode(courseId: string): string {
	const parts = courseId.split("+");
	const code = parts[1];
	if (!code || !/^\d+$/.test(code)) {
		throw new Error(`Unrecognized course_id: ${courseId}`);
	}
	return code;
}

const LEVEL_KEY = /^Level (\d+)$/;

function parseProgression(
	progression: Record<string, BcmProgressLevel>,
): ParsedLevel[] {
	const levels: ParsedLevel[] = [];
	for (const [key, value] of Object.entries(progression)) {
		const match = LEVEL_KEY.exec(key);
		if (!match) continue; // skip "Path Completion"
		levels.push({
			level: Number(match[1]),
			completed: value.completed,
			total: value.total,
			approved: value.approved === true,
		});
	}
	return levels.sort((a, b) => a.level - b.level);
}

/** Accept a single page object or an array; normalize to pages. */
export function normalizePages(
	input: BcmProgressPage | BcmProgressPage[],
): BcmProgressPage[] {
	return Array.isArray(input) ? input : [input];
}

export function parseProgressPages(
	pages: BcmProgressPage[],
): ParsedMemberPath[] {
	return pages.flatMap((page) =>
		page.results.map((row) => ({
			basecampUserId: String(row.user.id),
			name: row.user.name,
			email: row.user.email ? row.user.email.toLowerCase() : null,
			courseCode: extractCourseCode(row.course_id),
			pathName: row.path_name,
			levels: parseProgression(row.progression),
		})),
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/basecamp-progress.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint/format**

Run: `bun run check`
Expected: clean (fix any Biome complaints).

- [ ] **Step 6: Commit**

```bash
git add src/lib/basecamp-progress.ts src/lib/basecamp-progress.test.ts
git commit -m "feat(pathways): pure parser for Base Camp progress JSON"
```

---

## Task 3: Ingest/upsert logic — `syncClubProgress()`

**Files:**
- Create: `src/server/pathways-sync-logic.ts`
- Test: `src/server/pathways-sync.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
/**
 * DB-backed tests for Pathways sync upsert + identity match. Runs the plain
 * `syncClubProgress` against the test DB.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-sync.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";
import type { ParsedMemberPath } from "#/lib/basecamp-progress";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { syncClubProgress } = await import("./pathways-sync-logic");

function mp(over: Partial<ParsedMemberPath>): ParsedMemberPath {
	return {
		basecampUserId: "999",
		name: "Test Member",
		email: "test@example.com",
		courseCode: "8701",
		pathName: "Presentation Mastery",
		levels: [
			{ level: 1, completed: 5, total: 5, approved: true },
			{ level: 2, completed: 2, total: 4, approved: false },
		],
		...over,
	};
}

async function makePerson(over: Partial<typeof people.$inferInsert> = {}) {
	const id = randomUUID();
	await testDb
		.insert(people)
		.values({ id, name: "P", email: "test@example.com", ...over });
	return id;
}

describe.skipIf(!hasTestDb)("syncClubProgress", () => {
	beforeEach(cleanup);
	afterEach(cleanup);

	it("matches by email, upserts path/enrollment/levels, sets basecampUserId", async () => {
		const personId = await makePerson({ email: "match@example.com" });
		const res = await syncClubProgress([
			mp({ email: "match@example.com", basecampUserId: "123" }),
		]);

		expect(res.matched).toBe(1);
		expect(res.unmatched).toEqual([]);

		const [p] = await testDb
			.select({ bc: people.basecampUserId })
			.from(people)
			.where(eq(people.id, personId));
		expect(p.bc).toBe("123");

		const [path] = await testDb
			.select({ id: pathwaysPaths.id })
			.from(pathwaysPaths)
			.where(eq(pathwaysPaths.courseCode, "8701"));
		expect(path).toBeDefined();

		const [enr] = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(
				and(
					eq(pathEnrollments.personId, personId),
					eq(pathEnrollments.pathId, path.id),
				),
			);
		expect(enr).toBeDefined();

		const levels = await testDb
			.select()
			.from(pathLevelProgress)
			.where(eq(pathLevelProgress.enrollmentId, enr.id));
		expect(levels).toHaveLength(2);
	});

	it("prefers a stored basecampUserId over email on re-sync (survives email change)", async () => {
		const personId = await makePerson({
			email: "old@example.com",
			basecampUserId: "555",
		});
		const res = await syncClubProgress([
			mp({ email: "changed@example.com", basecampUserId: "555" }),
		]);
		expect(res.matched).toBe(1);
		const enr = await testDb
			.select()
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, personId));
		expect(enr).toHaveLength(1);
	});

	it("re-sync updates counts idempotently (no duplicate rows)", async () => {
		await makePerson({ email: "idem@example.com" });
		await syncClubProgress([mp({ email: "idem@example.com", basecampUserId: "1" })]);
		await syncClubProgress([
			mp({
				email: "idem@example.com",
				basecampUserId: "1",
				levels: [{ level: 2, completed: 4, total: 4, approved: true }],
			}),
		]);
		const paths = await testDb.select().from(pathwaysPaths);
		expect(paths).toHaveLength(1);
		const enrs = await testDb.select().from(pathEnrollments);
		expect(enrs).toHaveLength(1);
		const [l2] = await testDb
			.select()
			.from(pathLevelProgress)
			.where(eq(pathLevelProgress.level, 2));
		expect(l2.approved).toBe(true);
		expect(l2.completed).toBe(4);
	});

	it("reports an unknown email as unmatched (no person created)", async () => {
		const res = await syncClubProgress([
			mp({ email: "nobody@example.com", basecampUserId: "77" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toEqual([
			{ name: "Test Member", email: "nobody@example.com", basecampUserId: "77" },
		]);
		expect(await testDb.select().from(people)).toHaveLength(0);
	});

	it("reports an email shared by 2+ people as unmatched (ambiguous)", async () => {
		await makePerson({ email: "shared@example.com" });
		await makePerson({ email: "shared@example.com" });
		const res = await syncClubProgress([
			mp({ email: "shared@example.com", basecampUserId: "88" }),
		]);
		expect(res.matched).toBe(0);
		expect(res.unmatched).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-sync.integration.test.ts`
Expected: FAIL — `pathways-sync-logic` / `syncClubProgress` not found.

- [ ] **Step 3: Write the logic**

```ts
/**
 * DB logic for Pathways sync (spec 2026-07-06). Upserts paths (by course_code),
 * resolves each member-path to a Person (stored Base Camp id first, then a
 * unique email — ADR-0008 email fallback), and mirrors per-level counts.
 * Unmatched rows are reported, never auto-created. Kept in a `-logic.ts` so
 * `#/db` never leaks into the client bundle (server-modules guard).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
} from "#/db/schema";
import type { ParsedMemberPath } from "#/lib/basecamp-progress";

export interface SyncResult {
	matched: number;
	pathsUpserted: number;
	unmatched: { name: string; email: string | null; basecampUserId: string }[];
}

/** Resolve a Person id: stored Base Camp id → unique email → null (unmatched). */
async function resolvePersonId(
	row: ParsedMemberPath,
): Promise<string | null> {
	const byBc = await db
		.select({ id: people.id })
		.from(people)
		.where(eq(people.basecampUserId, row.basecampUserId));
	if (byBc.length === 1) return byBc[0].id;

	if (!row.email) return null;
	const byEmail = await db
		.select({ id: people.id })
		.from(people)
		.where(sql`lower(${people.email}) = ${row.email}`);
	if (byEmail.length !== 1) return null; // 0 or ambiguous → unmatched

	// First match: persist the durable Base Camp id.
	await db
		.update(people)
		.set({ basecampUserId: row.basecampUserId })
		.where(eq(people.id, byEmail[0].id));
	return byEmail[0].id;
}

async function upsertPath(row: ParsedMemberPath): Promise<string> {
	const [p] = await db
		.insert(pathwaysPaths)
		.values({ courseCode: row.courseCode, name: row.pathName })
		.onConflictDoUpdate({
			target: pathwaysPaths.courseCode,
			set: { name: row.pathName },
		})
		.returning({ id: pathwaysPaths.id });
	return p.id;
}

async function upsertEnrollment(
	personId: string,
	pathId: string,
): Promise<string> {
	const [e] = await db
		.insert(pathEnrollments)
		.values({ personId, pathId })
		.onConflictDoUpdate({
			target: [pathEnrollments.personId, pathEnrollments.pathId],
			set: { lastSyncedAt: new Date() },
		})
		.returning({ id: pathEnrollments.id });
	return e.id;
}

export async function syncClubProgress(
	rows: ParsedMemberPath[],
): Promise<SyncResult> {
	const result: SyncResult = { matched: 0, pathsUpserted: 0, unmatched: [] };
	const seenPaths = new Set<string>();

	for (const row of rows) {
		const personId = await resolvePersonId(row);
		if (!personId) {
			result.unmatched.push({
				name: row.name,
				email: row.email,
				basecampUserId: row.basecampUserId,
			});
			continue;
		}
		const pathId = await upsertPath(row);
		if (!seenPaths.has(row.courseCode)) {
			seenPaths.add(row.courseCode);
			result.pathsUpserted += 1;
		}
		const enrollmentId = await upsertEnrollment(personId, pathId);
		for (const lvl of row.levels) {
			await db
				.insert(pathLevelProgress)
				.values({
					enrollmentId,
					level: lvl.level,
					completed: lvl.completed,
					total: lvl.total,
					approved: lvl.approved,
				})
				.onConflictDoUpdate({
					target: [pathLevelProgress.enrollmentId, pathLevelProgress.level],
					set: {
						completed: lvl.completed,
						total: lvl.total,
						approved: lvl.approved,
					},
				});
		}
		result.matched += 1;
	}
	return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/pathways-sync.integration.test.ts`
Expected: PASS (all cases). If `hasTestDb` is false the suite skips — ensure `TEST_DATABASE_URL` is set so it actually runs.

- [ ] **Step 5: Commit**

```bash
git add src/server/pathways-sync-logic.ts src/server/pathways-sync.integration.test.ts
git commit -m "feat(pathways): sync upsert + email->basecamp-id identity match"
```

---

## Task 4: Admin server-fn wrapper

**Files:**
- Create: `src/server/pathways-sync.ts`
- Verify: `src/server/server-modules.guard.test.ts` still passes

- [ ] **Step 1: Write the server-fn**

Mirror the existing `createServerFn` + guard pattern (see `src/server/members.ts`, `src/server/guards.ts`). This module exports **only** the createServerFn + types — the DB logic stays in `pathways-sync-logic.ts` (server-modules guard).

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	type BcmProgressPage,
	normalizePages,
	parseProgressPages,
} from "#/lib/basecamp-progress";
import { requireClubRole, requireUser } from "./guards";
import { type SyncResult, syncClubProgress } from "./pathways-sync-logic";

const ingestSchema = z.object({
	clubId: z.string().uuid(),
	// The raw JSON the VPE pastes: a single BCM page object or an array of them.
	json: z.string().min(1),
});

/** Ingest pasted Base Camp `/api/bcm/progress` JSON for a club. Admin/VPE only. */
export const ingestPathwaysProgress = createServerFn({ method: "POST" })
	.validator((i: unknown) => ingestSchema.parse(i))
	.handler(async ({ data }): Promise<SyncResult> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(data.json);
		} catch {
			throw new Error("Pasted content is not valid JSON.");
		}
		const pages = normalizePages(parsedJson as BcmProgressPage | BcmProgressPage[]);
		const rows = parseProgressPages(pages);
		return syncClubProgress(rows);
	});
```

> Verify `requireClubRole`'s real signature in `src/server/guards.ts:66` and match it (args/order). Adjust the guard call if the repo's helper differs.

- [ ] **Step 2: Run the server-modules guard test**

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS — `pathways-sync.ts` exports only createServerFns/types; its `#/db`-touching logic lives in `pathways-sync-logic.ts`.

- [ ] **Step 3: Typecheck + full check**

Run: `bunx tsc --noEmit && bun run check`
Expected: clean.

- [ ] **Step 4: Run the whole suite**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: all green (new tests included; nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add src/server/pathways-sync.ts
git commit -m "feat(pathways): admin server-fn to ingest pasted Base Camp progress JSON"
```

---

## Self-Review

**Spec coverage (Plan 1a scope only):**
- Count-based model (paths + per-level completed/total/approved) → Task 1. ✓
- `people.basecampUserId` durable key → Task 1 + Task 3 match logic. ✓
- Pure parser w/ `course_id`→code, `completed > total`, multi-path, pagination concat, ignore "Path Completion" → Task 2 (all covered by tests). ✓
- Ingest upsert + email→GUID match + unmatched-report + no-auto-create + idempotent re-sync → Task 3. ✓
- Admin-guarded server-fn accepting pasted JSON → Task 4. ✓
- Server-modules bundle-leak discipline (logic in `-logic.ts`) → Tasks 3/4 + guard test. ✓

**Out of this plan (later):** paths `status` current/legacy refinement (defaults to `current`; fine for 1a), catalog project *names*, the paste-box UI + 4 count surfaces (Plan 1b), and speech-attributed "wins"/"up next" (Phase 2, needs #79).

**Placeholder scan:** none — every step has real code/commands.

**Type consistency:** `ParsedMemberPath` fields (`basecampUserId`, `email`, `courseCode`, `pathName`, `levels`) are identical across Task 2 (definition), Task 3 (test builder + logic), and Task 4 (via `parseProgressPages`). `SyncResult` shape matches between logic and server-fn.

---

## Subsequent plans (not this one)

- **Plan 1b — Pathways progress UI (needs Plan 1a):** the admin paste-box ingest screen with step-by-step Base Camp capture instructions + the unmatched-rows report; the count-form member "my progress" view (ring, level chips w/ `approved`, "N of M", multi-path tab switcher), member-detail Pathways tab, roster Pathway/level column, dashboard tile. All read off 1a's tables.
- **Plan 2 — Named specificity (blocked on #79, closes #101):** `pathways_projects` name seed (from the community catalog PDF), `speeches.project_id` FK + free-text migration, "Your wins" (delivered speeches → named projects), and named "Up next" choices.
- **#107 — browser extension:** automates the Task 4 ingest endpoint using the VPE's Base Camp session.
