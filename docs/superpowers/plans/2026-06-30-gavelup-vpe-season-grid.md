# VPE Season Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the VPE a desktop, signed-in season grid (members×meetings and roles×meetings behind a toggle) that shows assignment coverage and gaps at a glance, read-only, built so inline-assign can drop in next.

**Architecture:** One read aggregation (`loadSeasonGrid`) returns a normalized payload (windowed meetings, a union row axis of expanded role slots, members, cells, availability). Pure projection helpers turn that payload into either orientation. Thin presentational components render it under the existing `_authed` desktop shell at a repurposed `/_authed/schedule` route. Orientation + count live in URL search params.

**Tech Stack:** TanStack Start (React 19, file routes), Drizzle ORM on Postgres (`pg`), Vitest (node + jsdom), Tailwind v4 + shadcn, Biome. Package manager: Bun.

---

## Background the implementer needs

- **Server convention (important):** server modules export a plain, db-using function (directly unit-testable) **and** a `createServerFn` wrapper in the **same file**. Integration tests import the plain function, mock `#/db` → the test DB, and gate on `hasTestDb`. See `src/server/members.ts` (`applyMemberEdit` + `editMember`) and `src/server/roster-mgmt.integration.test.ts`.
- **Import alias:** `#/*` → `src/*` (e.g. `import { db } from "#/db"`).
- **Role model:** a role like "Speaker" is ONE `role_definitions` row with `defaultCount: 3`; `createMeeting` expands it into 3 `role_slots` with `slot_index` 0/1/2. So the Roles-view rows are **per slot**, not per definition.
- **Openness:** a slot is open iff `assigned_member_id IS NULL` (kept in sync with `status = 'open'`).
- **Existing label helpers** live in `src/lib/agenda.ts` (`buildRoleCounts`, `slotLabel`). Reuse them; do NOT create a new codes module.
- **Meetings** have a `status` column; exclude `'cancelled'` (see `listUpcomingMeetings` in `src/server/meetings.ts`).
- **Past vs upcoming is an absolute-instant comparison** (`scheduledAt >= now`), which is timezone-independent; the club `timezone` is used only to *format* date labels (`formatMeetingDate(value, timeZone)` in `src/lib/format.ts`).
- **Test DB:** `tm_test` in the running `dev-postgres` container. Integration tests run with `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test`.
- **Commands:** `bunx vitest run <path>` (single file), `bun run check` (Biome gate), `bun run build` (typecheck + build). Biome formats with **tabs** and **double quotes**.

## File structure

- **Create** `src/lib/season-grid-view.ts` — pure projection: payload → `ViewRow[]` for an orientation. No React, no db.
- **Create** `src/lib/season-grid-view.test.ts` — unit tests for the projection (node env).
- **Modify** `src/lib/agenda.ts` — add `roleAbbrev` + `buildShortCodes` short-code helpers.
- **Modify** `src/lib/agenda.test.ts` — add short-code tests.
- **Create** `src/server/season-grid.ts` — `loadSeasonGrid` (plain) + `getSeasonGrid` (`createServerFn`) + exported payload types.
- **Create** `src/server/season-grid.integration.test.ts` — db-backed test of `loadSeasonGrid`.
- **Create** `src/components/club/grid-cell.tsx` — one presentational cell (variant + meeting link).
- **Create** `src/components/club/season-grid.tsx` — table: toolbar pieces + projected rows/cells, sticky layout.
- **Modify** `src/routes/_authed/schedule.tsx` — replace the thin list with the grid route (loader + search params + toolbar).
- **Modify** `src/routes/_authed.tsx` — add the "Season grid" nav item + `crumbFor` entry.

---

## Task 1: Short-code helpers in `agenda.ts`

**Files:**
- Modify: `src/lib/agenda.ts`
- Test: `src/lib/agenda.test.ts`

Heuristic (deterministic, accepts "clunky but unique"): drop stopwords (`of the and a an to`); if ≥2 significant words → uppercase initials capped at 4 chars (`General Evaluator`→`GE`, `Table Topics Master`→`TTM`); if 1 word → first 4 letters title-cased (`Speaker`→`Spea`, `Timer`→`Time`, `Grammarian`→`Gram`). `buildShortCodes` numbers repeated roles (`Spea1/Spea2/Spea3`) and disambiguates two different names that collapse to the same base by appending `#2`, `#3`… in input order.

- [ ] **Step 1: Write the failing tests**

First extend the existing import at the top of `src/lib/agenda.test.ts` to add the two new names (do NOT add a second import statement — Biome organizes imports and will fail on a duplicate):

```ts
import {
	buildRoleCounts,
	buildShortCodes,
	generateSlotRows,
	resolveEvaluatorLinks,
	roleAbbrev,
	slotLabel,
} from "./agenda";
```

Then append these `describe` blocks to the bottom of `src/lib/agenda.test.ts`:

```ts
describe("roleAbbrev", () => {
	it("uses initials for multi-word names", () => {
		expect(roleAbbrev("General Evaluator")).toBe("GE");
		expect(roleAbbrev("Table Topics Master")).toBe("TTM");
	});
	it("drops stopwords", () => {
		expect(roleAbbrev("Toastmaster of the Day")).toBe("TD");
	});
	it("uses first four letters for single-word names", () => {
		expect(roleAbbrev("Speaker")).toBe("Spea");
		expect(roleAbbrev("Timer")).toBe("Time");
		expect(roleAbbrev("Grammarian")).toBe("Gram");
	});
});

describe("buildShortCodes", () => {
	it("numbers repeated roles and keeps singletons unnumbered", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "s", slotIndex: 0, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 1, name: "Speaker" },
			{ roleDefinitionId: "s", slotIndex: 2, name: "Speaker" },
			{ roleDefinitionId: "t", slotIndex: 0, name: "Timer" },
		]);
		expect(codes.get("s:0")).toBe("Spea1");
		expect(codes.get("s:2")).toBe("Spea3");
		expect(codes.get("t:0")).toBe("Time");
	});
	it("disambiguates two different names that share a base code", () => {
		const codes = buildShortCodes([
			{ roleDefinitionId: "a", slotIndex: 0, name: "Tall Tales" },
			{ roleDefinitionId: "b", slotIndex: 0, name: "Topic Time" },
		]);
		expect(codes.get("a:0")).toBe("TT");
		expect(codes.get("b:0")).toBe("TT#2");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: FAIL — `roleAbbrev`/`buildShortCodes` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/agenda.ts`:

```ts
const STOPWORDS = new Set(["of", "the", "and", "a", "an", "to"]);

/** Deterministic base abbreviation for a role name. */
export function roleAbbrev(name: string): string {
	const words = name
		.split(/[^A-Za-z]+/)
		.filter((w) => w.length > 0 && !STOPWORDS.has(w.toLowerCase()));
	if (words.length === 0) return name.slice(0, 4) || "?";
	if (words.length >= 2) {
		return words
			.map((w) => w[0]!.toUpperCase())
			.join("")
			.slice(0, 4);
	}
	const w = words[0]!;
	return w[0]!.toUpperCase() + w.slice(1, 4).toLowerCase();
}

export type ShortCodeInput = {
	roleDefinitionId: string;
	slotIndex: number;
	name: string;
};

/**
 * Build unique short codes keyed `${roleDefinitionId}:${slotIndex}`.
 * Repeated roles get a 1-based number; different names that collapse to the
 * same base get a `#2`, `#3` … suffix in input order.
 */
export function buildShortCodes(rows: ShortCodeInput[]): Map<string, string> {
	const countByDef = buildRoleCounts(
		rows.map((r) => ({ roleName: r.roleDefinitionId })),
	);
	const baseByName = new Map<string, string>();
	const seenBases = new Map<string, string>(); // base -> first roleDefinitionId
	const result = new Map<string, string>();

	for (const r of rows) {
		let base = baseByName.get(r.name);
		if (base === undefined) {
			base = roleAbbrev(r.name);
			const owner = seenBases.get(base);
			if (owner !== undefined && owner !== r.roleDefinitionId) {
				let n = 2;
				while (seenBases.has(`${base}#${n}`)) n += 1;
				base = `${base}#${n}`;
			}
			seenBases.set(base, r.roleDefinitionId);
			baseByName.set(r.name, base);
		}
		const repeated = (countByDef[r.roleDefinitionId] ?? 0) > 1;
		result.set(
			`${r.roleDefinitionId}:${r.slotIndex}`,
			repeated ? `${base}${r.slotIndex + 1}` : base,
		);
	}
	return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: PASS (all, including the pre-existing agenda tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda.ts src/lib/agenda.test.ts
git commit -m "feat(agenda): role short-code helpers for the season grid"
```

---

## Task 2: `loadSeasonGrid` aggregation + `getSeasonGrid` server fn

**Files:**
- Create: `src/server/season-grid.ts`
- Test: `src/server/season-grid.integration.test.ts`

- [ ] **Step 1: Write the payload types + the loader skeleton (types first so the test can import them)**

Create `src/server/season-grid.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, lt, gte, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	clubs,
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { buildShortCodes, buildRoleCounts, slotLabel } from "#/lib/agenda";

export type SeasonGridCount = 4 | 8 | "all";
export type SlotStatus = "open" | "claimed" | "confirmed";

export interface SeasonGridMeeting {
	id: string;
	scheduledAt: string;
	timezone: string;
	openCount: number;
	totalSlots: number;
	isPast: boolean;
	isAnchor: boolean;
}
export interface SeasonGridRow {
	roleDefinitionId: string;
	slotIndex: number;
	label: string; // "Speaker 2" (hover)
	shortCode: string; // "Spea2"
	sortOrder: number;
}
export interface SeasonGridMember {
	id: string;
	name: string;
}
export interface SeasonGridCell {
	meetingId: string;
	roleDefinitionId: string;
	slotIndex: number;
	memberId: string | null;
	status: SlotStatus;
}
export interface SeasonGridData {
	meetings: SeasonGridMeeting[];
	rows: SeasonGridRow[];
	members: SeasonGridMember[];
	cells: SeasonGridCell[];
	unavailable: { memberId: string; meetingId: string }[];
}

const PAST_LOOKBACK = 2;

export async function loadSeasonGrid(input: {
	clubId: string;
	count: SeasonGridCount;
}): Promise<SeasonGridData> {
	const now = new Date();

	// 1. Columns: up to PAST_LOOKBACK most-recent past meetings + upcoming.
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, input.clubId),
		columns: { timezone: true },
	});
	const timezone = club?.timezone ?? "UTC";

	const past = await db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				ne(meetings.status, "cancelled"),
				lt(meetings.scheduledAt, now),
			),
		)
		.orderBy(desc(meetings.scheduledAt))
		.limit(PAST_LOOKBACK);

	const upcomingQuery = db
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				ne(meetings.status, "cancelled"),
				gte(meetings.scheduledAt, now),
			),
		)
		.orderBy(asc(meetings.scheduledAt));
	const upcoming =
		input.count === "all"
			? await upcomingQuery
			: await upcomingQuery.limit(input.count);

	const ordered = [...past.reverse(), ...upcoming];
	const meetingIds = ordered.map((m) => m.id);
	const anchorId = upcoming[0]?.id ?? null;

	// 2. Slots (+ role defs) for those meetings.
	const slotRows = meetingIds.length
		? await db
				.select({
					meetingId: roleSlots.meetingId,
					roleDefinitionId: roleSlots.roleDefinitionId,
					slotIndex: roleSlots.slotIndex,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					roleName: roleDefinitions.name,
					sortOrder: roleDefinitions.sortOrder,
				})
				.from(roleSlots)
				.innerJoin(
					roleDefinitions,
					eq(roleDefinitions.id, roleSlots.roleDefinitionId),
				)
				.where(inArray(roleSlots.meetingId, meetingIds))
		: [];

	// 3. Union row axis: distinct (roleDefinitionId, slotIndex), ordered.
	const rowMap = new Map<
		string,
		{ roleDefinitionId: string; slotIndex: number; roleName: string; sortOrder: number }
	>();
	for (const s of slotRows) {
		const key = `${s.roleDefinitionId}:${s.slotIndex}`;
		if (!rowMap.has(key))
			rowMap.set(key, {
				roleDefinitionId: s.roleDefinitionId,
				slotIndex: s.slotIndex,
				roleName: s.roleName,
				sortOrder: s.sortOrder,
			});
	}
	const rowDefs = [...rowMap.values()].sort(
		(a, b) => a.sortOrder - b.sortOrder || a.slotIndex - b.slotIndex,
	);
	const roleCounts = buildRoleCounts(
		rowDefs.map((r) => ({ roleName: r.roleName })),
	);
	const shortCodes = buildShortCodes(
		rowDefs.map((r) => ({
			roleDefinitionId: r.roleDefinitionId,
			slotIndex: r.slotIndex,
			name: r.roleName,
		})),
	);
	const rows: SeasonGridRow[] = rowDefs.map((r) => ({
		roleDefinitionId: r.roleDefinitionId,
		slotIndex: r.slotIndex,
		label: slotLabel({ roleName: r.roleName, slotIndex: r.slotIndex }, roleCounts),
		shortCode: shortCodes.get(`${r.roleDefinitionId}:${r.slotIndex}`) ?? "?",
		sortOrder: r.sortOrder,
	}));

	// 4. Cells + per-meeting counts.
	const cells: SeasonGridCell[] = slotRows.map((s) => ({
		meetingId: s.meetingId,
		roleDefinitionId: s.roleDefinitionId,
		slotIndex: s.slotIndex,
		memberId: s.assignedMemberId,
		status: s.status as SlotStatus,
	}));
	const openByMeeting = new Map<string, number>();
	const totalByMeeting = new Map<string, number>();
	for (const c of cells) {
		totalByMeeting.set(c.meetingId, (totalByMeeting.get(c.meetingId) ?? 0) + 1);
		if (c.memberId === null)
			openByMeeting.set(c.meetingId, (openByMeeting.get(c.meetingId) ?? 0) + 1);
	}

	const gridMeetings: SeasonGridMeeting[] = ordered.map((m) => ({
		id: m.id,
		scheduledAt: m.scheduledAt.toISOString(),
		timezone,
		openCount: openByMeeting.get(m.id) ?? 0,
		totalSlots: totalByMeeting.get(m.id) ?? 0,
		isPast: m.scheduledAt < now,
		isAnchor: m.id === anchorId,
	}));

	// 5. Members + availability.
	const memberRows = await db
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(eq(members.clubId, input.clubId))
		.orderBy(asc(members.name));

	const unavailable = meetingIds.length
		? await db
				.select({
					memberId: memberAvailability.memberId,
					meetingId: memberAvailability.meetingId,
				})
				.from(memberAvailability)
				.where(inArray(memberAvailability.meetingId, meetingIds))
		: [];

	return { meetings: gridMeetings, rows, members: memberRows, cells, unavailable };
}

export const getSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z
			.object({
				clubId: z.string().uuid(),
				count: z.union([z.literal(4), z.literal(8), z.literal("all")]),
			})
			.parse(input),
	)
	.handler(({ data }) => loadSeasonGrid(data));
```

- [ ] **Step 2: Write the failing integration test**

Create `src/server/season-grid.integration.test.ts`:

```ts
/**
 * DB-backed tests for loadSeasonGrid. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/season-grid.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("loadSeasonGrid", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("windows past lookback + upcoming, expands multi-count rows, counts open", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid");

		// seedClub gives: a Timer role def, one upcoming meeting (2026-07-01),
		// one open Timer slot. Add a past meeting + a 3-count Speaker role.
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 5,
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });

		const [pastMeeting] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2020-01-01T19:00:00Z"),
				status: "scheduled",
			})
			.returning({ id: meetings.id });

		// 3 speaker slots on the upcoming meeting; assign the seeded member to slot 0.
		await testDb.insert(roleSlots).values([
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 0,
				status: "claimed",
				assignedMemberId: seed.memberId,
			},
			{ meetingId: seed.meetingId, roleDefinitionId: speaker!.id, slotIndex: 1 },
			{ meetingId: seed.meetingId, roleDefinitionId: speaker!.id, slotIndex: 2 },
		]);

		// member is NA for the past meeting
		await testDb.insert(memberAvailability).values({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
		});

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });

		// columns: the past meeting (lookback) + the upcoming meeting
		expect(data.meetings).toHaveLength(2);
		expect(data.meetings[0]!.id).toBe(pastMeeting!.id);
		expect(data.meetings[0]!.isPast).toBe(true);
		expect(data.meetings[1]!.id).toBe(seed.meetingId);
		expect(data.meetings[1]!.isAnchor).toBe(true);

		// rows: Timer (1) + Speaker expanded (3) = 4, ordered by sortOrder
		const speakerRows = data.rows.filter(
			(r) => r.roleDefinitionId === speaker!.id,
		);
		expect(speakerRows.map((r) => r.label)).toEqual([
			"Speaker 1",
			"Speaker 2",
			"Speaker 3",
		]);
		expect(speakerRows[1]!.shortCode).toBe("Spea2");

		// open count on the upcoming meeting: 1 Timer + 2 unassigned speakers = 3
		const upcoming = data.meetings.find((m) => m.id === seed.meetingId)!;
		expect(upcoming.openCount).toBe(3);

		// the assigned cell + availability surfaced
		const assigned = data.cells.find(
			(c) => c.memberId === seed.memberId && c.meetingId === seed.meetingId,
		);
		expect(assigned?.status).toBe("claimed");
		expect(data.unavailable).toContainEqual({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
		});
	});

	it("count: 4 limits upcoming meetings", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid");
		// seedClub already inserted 1 upcoming meeting; add 5 more upcoming.
		for (let i = 0; i < 5; i++) {
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: new Date(`2026-08-0${i + 1}T19:00:00Z`),
				status: "scheduled",
			});
		}
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 4 });
		const upcomingCols = data.meetings.filter((m) => !m.isPast);
		expect(upcomingCols).toHaveLength(4);
	});
});
```

- [ ] **Step 3: Run the test to verify it passes** (the implementation from Step 1 is complete)

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: PASS (2 tests). If it errors that the DB/tables are missing, ensure migrations are applied to `tm_test` (`TEST_DATABASE_URL=… bun run db:migrate` against that DB), matching how the other integration suites run.

- [ ] **Step 4: Lint**

Run: `bun run check`
Expected: PASS (no Biome errors in the new files).

- [ ] **Step 5: Commit**

```bash
git add src/server/season-grid.ts src/server/season-grid.integration.test.ts
git commit -m "feat(server): loadSeasonGrid aggregation + getSeasonGrid server fn"
```

---

## Task 3: Pure projection `season-grid-view.ts`

Turns the payload into `ViewRow[]` for either orientation. Roles view: row per slot, cell text = member name (assigned) / `OPEN` / blank. Members view: row per member, cell text = role short code(s) / `NA` / `·`. Multiple roles for one member in a meeting → first short code + `+N`, full labels in the title.

**Files:**
- Create: `src/lib/season-grid-view.ts`
- Test: `src/lib/season-grid-view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/season-grid-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectGrid } from "./season-grid-view";
import type { SeasonGridData } from "#/server/season-grid";

const data: SeasonGridData = {
	meetings: [
		{ id: "m1", scheduledAt: "2026-07-01T19:00:00Z", timezone: "UTC", openCount: 1, totalSlots: 2, isPast: false, isAnchor: true },
	],
	rows: [
		{ roleDefinitionId: "tm", slotIndex: 0, label: "Toastmaster", shortCode: "Toas", sortOrder: 0 },
		{ roleDefinitionId: "ti", slotIndex: 0, label: "Timer", shortCode: "Time", sortOrder: 1 },
	],
	members: [
		{ id: "a", name: "Amir" },
		{ id: "b", name: "Bea" },
	],
	cells: [
		{ meetingId: "m1", roleDefinitionId: "tm", slotIndex: 0, memberId: "a", status: "claimed" },
		{ meetingId: "m1", roleDefinitionId: "ti", slotIndex: 0, memberId: null, status: "open" },
	],
	unavailable: [{ memberId: "b", meetingId: "m1" }],
};

describe("projectGrid – roles orientation", () => {
	it("shows member name for assigned and OPEN for empty", () => {
		const rows = projectGrid(data, "roles");
		expect(rows.map((r) => r.label)).toEqual(["Toastmaster", "Timer"]);
		expect(rows[0]!.cells[0]).toMatchObject({ kind: "assigned", text: "Amir" });
		expect(rows[1]!.cells[0]).toMatchObject({ kind: "open", text: "OPEN" });
	});
});

describe("projectGrid – members orientation", () => {
	it("shows role short code, NA, and free", () => {
		const rows = projectGrid(data, "members");
		const amir = rows.find((r) => r.id === "a")!;
		const bea = rows.find((r) => r.id === "b")!;
		expect(amir.cells[0]).toMatchObject({ kind: "assigned", text: "Toas" });
		expect(bea.cells[0]).toMatchObject({ kind: "na", text: "NA" });
	});

	it("blank when the meeting lacks a slot for a roles-view row", () => {
		const sparse: SeasonGridData = {
			...data,
			meetings: [
				...data.meetings,
				{ id: "m2", scheduledAt: "2026-07-08T19:00:00Z", timezone: "UTC", openCount: 0, totalSlots: 0, isPast: false, isAnchor: false },
			],
		};
		const rows = projectGrid(sparse, "roles");
		expect(rows[0]!.cells[1]).toMatchObject({ kind: "blank" });
	});

	it("collapses multiple roles in one meeting to first + +N", () => {
		const dbl: SeasonGridData = {
			...data,
			cells: [
				...data.cells,
				{ meetingId: "m1", roleDefinitionId: "ti", slotIndex: 0, memberId: "a", status: "claimed" },
			],
		};
		// re-open the Timer cell so Amir holds both TM and Timer
		dbl.cells = dbl.cells.filter(
			(c) => !(c.roleDefinitionId === "ti" && c.memberId === null),
		);
		const rows = projectGrid(dbl, "members");
		const amir = rows.find((r) => r.id === "a")!;
		expect(amir.cells[0].text).toBe("Toas +1");
		expect(amir.cells[0].title).toContain("Toastmaster");
		expect(amir.cells[0].title).toContain("Timer");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/season-grid-view.test.ts`
Expected: FAIL — `projectGrid` not found.

- [ ] **Step 3: Implement the projection**

Create `src/lib/season-grid-view.ts`:

```ts
import type { SeasonGridData } from "#/server/season-grid";

export type CellKind = "assigned" | "open" | "free" | "na" | "blank";

export interface ViewCell {
	meetingId: string;
	kind: CellKind;
	text: string;
	title: string;
}

export interface ViewRow {
	id: string; // role row key or member id
	label: string;
	kind: "role" | "member";
	/** member id for member rows (for the profile link); undefined for role rows */
	memberId?: string;
	cells: ViewCell[];
}

export type Orientation = "roles" | "members";

export function projectGrid(
	data: SeasonGridData,
	orientation: Orientation,
): ViewRow[] {
	const memberName = new Map(data.members.map((m) => [m.id, m.name]));
	const rowByKey = new Map(
		data.rows.map((r) => [`${r.roleDefinitionId}:${r.slotIndex}`, r]),
	);
	const cellByKey = new Map(
		data.cells.map((c) => [
			`${c.meetingId}:${c.roleDefinitionId}:${c.slotIndex}`,
			c,
		]),
	);
	const naSet = new Set(
		data.unavailable.map((u) => `${u.memberId}:${u.meetingId}`),
	);

	if (orientation === "roles") {
		return data.rows.map((row) => ({
			id: `${row.roleDefinitionId}:${row.slotIndex}`,
			label: row.label,
			kind: "role" as const,
			cells: data.meetings.map((m) => {
				const c = cellByKey.get(
					`${m.id}:${row.roleDefinitionId}:${row.slotIndex}`,
				);
				if (!c) return { meetingId: m.id, kind: "blank" as const, text: "", title: "" };
				if (c.memberId === null)
					return { meetingId: m.id, kind: "open" as const, text: "OPEN", title: `${row.label} — open` };
				const name = memberName.get(c.memberId) ?? "—";
				return { meetingId: m.id, kind: "assigned" as const, text: name, title: `${name} — ${row.label}` };
			}),
		}));
	}

	// members orientation
	const cellsByMemberMeeting = new Map<string, typeof data.cells>();
	for (const c of data.cells) {
		if (c.memberId === null) continue;
		const key = `${c.memberId}:${c.meetingId}`;
		const list = cellsByMemberMeeting.get(key) ?? [];
		list.push(c);
		cellsByMemberMeeting.set(key, list);
	}

	return data.members.map((member) => ({
		id: member.id,
		label: member.name,
		kind: "member" as const,
		memberId: member.id,
		cells: data.meetings.map((m) => {
			const held = cellsByMemberMeeting.get(`${member.id}:${m.id}`) ?? [];
			if (held.length > 0) {
				const labels = held.map(
					(c) => rowByKey.get(`${c.roleDefinitionId}:${c.slotIndex}`)?.label ?? "role",
				);
				const codes = held.map(
					(c) => rowByKey.get(`${c.roleDefinitionId}:${c.slotIndex}`)?.shortCode ?? "?",
				);
				const text = held.length > 1 ? `${codes[0]} +${held.length - 1}` : codes[0]!;
				return { meetingId: m.id, kind: "assigned" as const, text, title: labels.join(", ") };
			}
			if (naSet.has(`${member.id}:${m.id}`))
				return { meetingId: m.id, kind: "na" as const, text: "NA", title: "Not available" };
			return { meetingId: m.id, kind: "free" as const, text: "·", title: "Free" };
		}),
	}));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/season-grid-view.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/season-grid-view.ts src/lib/season-grid-view.test.ts
git commit -m "feat(grid): pure projection from payload to either orientation"
```

---

## Task 4: `GridCell` component

A presentational cell that renders the variant styling and links to the meeting.

**Files:**
- Create: `src/components/club/grid-cell.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/club/grid-cell.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { cn } from "#/lib/utils";
import type { ViewCell } from "#/lib/season-grid-view";

const KIND_CLASS: Record<ViewCell["kind"], string> = {
	assigned: "bg-emerald-600 text-white",
	open: "border border-dashed border-amber-500/60 text-amber-600",
	free: "border border-border text-muted-foreground/60",
	na: "border border-dashed border-rose-500/60 text-rose-600",
	blank: "opacity-0",
};

export function GridCell({ cell }: { cell: ViewCell }) {
	const inner = (
		<span
			title={cell.title || undefined}
			className={cn(
				"flex h-8 min-w-[3rem] items-center justify-center rounded-md px-2 text-xs font-semibold",
				KIND_CLASS[cell.kind],
			)}
		>
			{cell.text}
		</span>
	);
	if (cell.kind === "blank") return inner;
	return (
		<Link
			to="/meetings/$id"
			params={{ id: cell.meetingId }}
			className="block"
			aria-label={cell.title || "meeting"}
		>
			{inner}
		</Link>
	);
}
```

- [ ] **Step 2: Verify it typechecks** (no dedicated test — exercised by the build in Task 6)

Run: `bunx tsc --noEmit`
Expected: no errors referencing `grid-cell.tsx`. (If `cn` is missing, confirm it is exported from `src/lib/utils.ts` — it is used across the repo.)

- [ ] **Step 3: Commit**

```bash
git add src/components/club/grid-cell.tsx
git commit -m "feat(grid): GridCell presentational cell with meeting link"
```

---

## Task 5: `SeasonGrid` table component

Renders the toolbar (orientation toggle + count control as search-param links), sticky header row + sticky label column, and the projected rows.

**Files:**
- Create: `src/components/club/season-grid.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/club/season-grid.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { formatMeetingDate } from "#/lib/format";
import { projectGrid, type Orientation } from "#/lib/season-grid-view";
import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";
import { cn } from "#/lib/utils";
import { GridCell } from "./grid-cell";

const COUNTS: SeasonGridCount[] = [4, 8, "all"];
const VIEWS: { value: Orientation; label: string }[] = [
	{ value: "roles", label: "Roles × Meetings" },
	{ value: "members", label: "Members × Meetings" },
];

export function SeasonGrid({
	data,
	orientation,
	count,
}: {
	data: SeasonGridData;
	orientation: Orientation;
	count: SeasonGridCount;
}) {
	const rows = projectGrid(data, orientation);
	const labelHead = orientation === "roles" ? "Role" : "Member";

	if (data.meetings.length === 0) {
		return (
			<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
				No upcoming meetings yet. Create meetings to start planning the season.
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-4">
				<div className="inline-flex overflow-hidden rounded-lg border">
					{VIEWS.map((v) => (
						<Link
							key={v.value}
							to="/schedule"
							search={(prev) => ({ ...prev, view: v.value })}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								orientation === v.value
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{v.label}
						</Link>
					))}
				</div>
				<div className="inline-flex overflow-hidden rounded-lg border">
					{COUNTS.map((c) => (
						<Link
							key={String(c)}
							to="/schedule"
							search={(prev) => ({ ...prev, count: c })}
							className={cn(
								"px-3 py-1.5 text-xs font-semibold",
								count === c ? "bg-accent" : "text-muted-foreground",
							)}
						>
							{c === "all" ? "All" : c}
						</Link>
					))}
				</div>
			</div>

			<div className="overflow-auto rounded-xl border">
				<table className="border-separate border-spacing-1">
					<thead>
						<tr>
							<th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-semibold">
								{labelHead}
							</th>
							{data.meetings.map((m) => (
								<th
									key={m.id}
									className={cn(
										"min-w-[3.5rem] bg-card px-2 py-2 text-center text-xs font-semibold",
										m.isPast && "opacity-45",
										m.isAnchor && "rounded-md ring-2 ring-primary",
									)}
								>
									<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
									<div className="text-[10px] font-medium text-amber-600">
										{m.isPast
											? "done"
											: m.openCount === 0
												? "full"
												: `${m.openCount} open`}
									</div>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.id}>
								<th className="sticky left-0 z-10 bg-card px-3 py-1 text-right text-xs font-semibold whitespace-nowrap">
									{row.memberId ? (
										<Link
											to="/members/$id"
											params={{ id: row.memberId }}
											className="hover:underline"
										>
											{row.label}
										</Link>
									) : (
										row.label
									)}
								</th>
								{row.cells.map((cell, i) => (
									<td key={`${row.id}:${data.meetings[i]!.id}`} className="p-0">
										<GridCell cell={cell} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `bunx tsc --noEmit`
Expected: no errors in `season-grid.tsx`. (The `to="/schedule"` / `to="/members/$id"` / `to="/meetings/$id"` links require the routes to exist; the route tree regenerates in Task 6. If tsc complains about route literals now, it resolves once Task 6 generates `routeTree.gen.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/club/season-grid.tsx
git commit -m "feat(grid): SeasonGrid table with toggle, count, sticky layout"
```

---

## Task 6: Wire the route + nav

Replace the thin `/_authed/schedule` list with the grid, parse `view`/`count` from search params, and add the nav item.

**Files:**
- Modify: `src/routes/_authed/schedule.tsx` (full replace)
- Modify: `src/routes/_authed.tsx` (nav item + breadcrumb)

- [ ] **Step 1: Replace the schedule route**

Overwrite `src/routes/_authed/schedule.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { SeasonGrid } from "#/components/club/season-grid";
import type { Orientation } from "#/lib/season-grid-view";
import { getSeasonGrid, type SeasonGridCount } from "#/server/season-grid";

type Search = { view: Orientation; count: SeasonGridCount };

export const Route = createFileRoute("/_authed/schedule")({
	validateSearch: (search: Record<string, unknown>): Search => ({
		view: search.view === "roles" ? "roles" : "members",
		count:
			search.count === 4 || search.count === "4"
				? 4
				: search.count === "all"
					? "all"
					: 8,
	}),
	loaderDeps: ({ search }) => ({ count: search.count }),
	loader: async ({ context, deps }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) return { data: null };
		return { data: await getSeasonGrid({ data: { clubId, count: deps.count } }) };
	},
	component: SeasonGridPage,
});

function SeasonGridPage() {
	const { data } = Route.useLoaderData();
	const { view, count } = Route.useSearch();

	return (
		<div className="space-y-4 p-7">
			<h1 className="text-2xl font-bold tracking-tight">Season grid</h1>
			{data ? (
				<SeasonGrid data={data} orientation={view} count={count} />
			) : (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					No club found.
				</p>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Add the nav item + breadcrumb**

In `src/routes/_authed.tsx`:

1. Add an icon import to the existing `lucide-react` import block — add `Grid3x3`:

```tsx
import {
	BookOpen,
	CalendarDays,
	Grid3x3,
	LayoutGrid,
	List,
	LogOut,
	ScrollText,
} from "lucide-react";
```

2. Add the nav item as the first child of the Manage `NavGroup`:

```tsx
<NavGroup label="Manage">
	<NavItem to="/schedule" icon={Grid3x3} label="Season grid" />
	<NavItem to="/" exact icon={List} label="Roster" />
	<NavItem to="/agenda" icon={CalendarDays} label="Agenda & roles" />
	<NavItem to="/activity" icon={ScrollText} label="Activity" />
</NavGroup>
```

3. Add a breadcrumb case in `crumbFor`, before the `/meetings` case:

```tsx
	if (pathname.startsWith("/schedule")) return "Manage · Season grid";
```

- [ ] **Step 3: Regenerate routes + typecheck + build**

Run: `bun run generate-routes && bunx tsc --noEmit`
Expected: no type errors; `to="/schedule"` link literals now resolve.

- [ ] **Step 4: Lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_authed/schedule.tsx src/routes/_authed.tsx src/routeTree.gen.ts
git commit -m "feat(grid): season-grid route + Manage nav item"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole unit suite**

Run: `bun run test`
Expected: PASS (new `agenda`, `season-grid-view` tests included; integration tests skip without `TEST_DATABASE_URL`).

- [ ] **Step 2: Run the integration suite against the test DB**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds (Nitro node-server output), no type errors.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `bun run dev`, sign in, open `/schedule`. Verify: toggle flips Roles/Members; count control changes columns (4/8/All); past column dimmed + "done"; first upcoming column ring-outlined with "N open"/"full"; clicking a cell opens the meeting page; clicking a member name opens the profile.

- [ ] **Step 5: Final commit (if any cleanup was needed)**

```bash
git add -A
git commit -m "chore(grid): verification cleanup" --allow-empty
```

---

## Self-review notes (spec coverage)

- Two orientations + toggle → Tasks 3, 5, 6. ✅
- Union row axis, per-slot expansion, blank≠open → Tasks 2, 3 (tested). ✅
- Binary open/assigned cells, `status` carried in payload → Task 2 (`SeasonGridCell.status`), Task 3 (no claimed/confirmed styling). ✅
- Count window (4/8/All) upcoming-only + 2-meeting past lookback → Task 2 (tested). ✅
- Club-tz date labels; absolute past/upcoming boundary; anchor = first upcoming → Task 2 (`isPast`/`isAnchor`), Task 5 (`formatMeetingDate(.., timezone)`). ✅
- Visual touches (N-open badge, dim past + anchor ring, sticky, short codes) → Task 5 + Task 1. ✅
- Click targets (cell+date→meeting, member→profile, role label inert) → Tasks 4, 5. ✅
- Heuristic short codes + hover → Task 1, surfaced via `title` in Tasks 4/5. ✅
- All members alphabetical, no filtering → Task 2 (`asc(members.name)`). ✅
- Route repurpose + nav placement → Task 6. ✅
- Empty/edge states (no meetings, multi-role +N) → Tasks 3, 5 (tested +N). ✅
- Testing approach (integration + projection unit + agenda unit) → Tasks 1, 2, 3, 7. ✅
```
