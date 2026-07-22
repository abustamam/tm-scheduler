# Date-based Meeting URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every meeting reachable and linkable by its club-local date — `/club/<slug>/meeting/2026-07-21` — as an additive alias, without breaking existing UUID links.

**Architecture:** A pure helper (`src/lib/meeting-url.ts`) parses/formats URL keys; a db resolver (`src/server/meeting-resolve-logic.ts`) maps a key (`date` / `date-HHmm` / `uuid`) to a meeting id scoped to a club; the three public route loaders resolve inbound keys via new `*ByKey` server fns; and every place that *emits* a link to the public meeting view is switched to a computed `urlKey`. No schema change. The internal `/_authed/meetings/$id` view keeps its own UUID address but still emits date-form links to public surfaces.

**Tech Stack:** TanStack Start (file routes, `createServerFn`), Drizzle ORM (`pg`), Vitest, TypeScript strict, Biome (tabs + double quotes).

**Design spec:** `docs/superpowers/specs/2026-07-21-date-meeting-urls-design.md`

**The invariant that drives every emit change:** links whose `to` is `/club/$clubId/meeting/$meetingId…` (the PUBLIC view, present, print) carry `urlKey`; links to `/meetings/$id` (the internal view) keep the raw UUID.

---

## Worktree setup (executor, once)

This plan is already on the `feat/date-meeting-urls` worktree at
`/media/rasheed-bustamam/Extra/coding/tm-scheduler-date-urls`. Before running any
command:

- [ ] Install deps + env in the worktree (fresh worktrees have neither):

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-date-urls
bun install
cp /media/rasheed-bustamam/Extra/coding/tm-scheduler/.env.local .env.local
```

- [ ] Confirm the test DB is reachable (no schema change here, so `tm_test` is already current — do NOT `db:push`):

```bash
docker ps --format '{{.Names}}' | grep -q dev-postgres && echo "dev-postgres up"
```

`TEST_DATABASE_URL` for integration tests is `postgresql://dev:dev@localhost:5432/tm_test`.

---

## Task 1: Pure URL-key helper

**Files:**
- Create: `src/lib/meeting-url.ts`
- Test: `src/lib/meeting-url.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/meeting-url.test.ts
import { describe, expect, it } from "vitest";
import {
	localDateKey,
	localDayRange,
	meetingUrlKey,
	nextCalendarDate,
	parseMeetingKey,
	urlKeysForMeetings,
} from "./meeting-url";

const CHICAGO = "America/Chicago";

describe("parseMeetingKey", () => {
	it("parses a bare date", () => {
		expect(parseMeetingKey("2026-07-21")).toEqual({
			kind: "date",
			date: "2026-07-21",
		});
	});
	it("parses a date + HHmm instant", () => {
		expect(parseMeetingKey("2026-07-21-1845")).toEqual({
			kind: "instant",
			date: "2026-07-21",
			hh: "18",
			mm: "45",
		});
	});
	it("parses a uuid", () => {
		const id = "9f3c1a2b-0000-4000-8000-000000000000";
		expect(parseMeetingKey(id)).toEqual({ kind: "uuid", id });
	});
	it("rejects anything else", () => {
		expect(parseMeetingKey("guest-book").kind).toBe("invalid");
		expect(parseMeetingKey("").kind).toBe("invalid");
		expect(parseMeetingKey("2026-13-99").kind).toBe("invalid"); // not uuid, not date-shaped enough → invalid or date? see note
	});
});

describe("localDateKey", () => {
	it("uses the club-local calendar date, not the UTC date", () => {
		// 02:30Z on the 22nd is 21:30 on the 21st in Chicago (UTC-5 in July).
		expect(localDateKey(new Date("2026-07-22T02:30:00Z"), CHICAGO)).toBe(
			"2026-07-21",
		);
	});
});

describe("meetingUrlKey", () => {
	// 23:45Z → 18:45 local on 2026-07-21 in Chicago.
	const at = new Date("2026-07-21T23:45:00Z");
	it("is the bare local date when it does not collide", () => {
		expect(meetingUrlKey(at, CHICAGO, false)).toBe("2026-07-21");
	});
	it("appends -HHmm local time when it collides", () => {
		expect(meetingUrlKey(at, CHICAGO, true)).toBe("2026-07-21-1845");
	});
});

describe("nextCalendarDate", () => {
	it("increments a day", () => {
		expect(nextCalendarDate("2026-07-21")).toBe("2026-07-22");
	});
	it("rolls over month and year", () => {
		expect(nextCalendarDate("2026-12-31")).toBe("2027-01-01");
		expect(nextCalendarDate("2026-02-28")).toBe("2026-03-01"); // 2026 not leap
	});
});

describe("localDayRange", () => {
	it("returns the club-local midnight-to-midnight UTC window", () => {
		const { start, end } = localDayRange("2026-07-21", CHICAGO);
		// Midnight CDT (UTC-5) on 07-21 → 05:00Z; next midnight → 05:00Z on 07-22.
		expect(start.toISOString()).toBe("2026-07-21T05:00:00.000Z");
		expect(end.toISOString()).toBe("2026-07-22T05:00:00.000Z");
	});
});

describe("urlKeysForMeetings", () => {
	it("suffixes only the meetings that share a local date", () => {
		const items = [
			{ id: "a", scheduledAt: new Date("2026-07-21T23:45:00Z") }, // 18:45 local
			{ id: "b", scheduledAt: new Date("2026-07-22T01:00:00Z") }, // 20:00 local, SAME local day
			{ id: "c", scheduledAt: new Date("2026-07-28T23:45:00Z") }, // different day
		];
		const keys = urlKeysForMeetings(items, CHICAGO);
		expect(keys.get("a")).toBe("2026-07-21-1845");
		expect(keys.get("b")).toBe("2026-07-21-2000");
		expect(keys.get("c")).toBe("2026-07-28");
	});
});
```

> Note on `"2026-13-99"`: it matches the date-shaped regex but is not a valid uuid;
> `parseMeetingKey` returns `{ kind: "date", date: "2026-13-99" }` (shape-only parse).
> Resolution then finds no meeting → `notFound()`. If you prefer strict validation,
> the `date` branch is harmless either way. Adjust the assertion to
> `expect(parseMeetingKey("2026-13-99")).toEqual({ kind: "date", date: "2026-13-99" })`
> when you write the implementation below (which is shape-only). Keep the test honest
> to the implementation you ship.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-date-urls && bunx vitest run src/lib/meeting-url.test.ts`
Expected: FAIL — `Cannot find module './meeting-url'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/meeting-url.ts
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_KEY_RE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/;

export type ParsedMeetingKey =
	| { kind: "date"; date: string }
	| { kind: "instant"; date: string; hh: string; mm: string }
	| { kind: "uuid"; id: string }
	| { kind: "invalid" };

/** Classify a `$meetingId` URL segment: a club-local date, a date+HHmm instant,
 *  a raw uuid, or invalid. Shape-only — validity is decided by resolution. */
export function parseMeetingKey(key: string): ParsedMeetingKey {
	const m = key.match(DATE_KEY_RE);
	if (m) {
		const [, date, hh, mm] = m;
		return hh && mm
			? { kind: "instant", date, hh, mm }
			: { kind: "date", date };
	}
	if (UUID_RE.test(key)) return { kind: "uuid", id: key };
	return { kind: "invalid" };
}

/** The club-local calendar date (YYYY-MM-DD) of a UTC instant. */
export function localDateKey(instant: Date, timeZone: string): string {
	return utcToZonedWallTime(instant, timeZone).slice(0, 10);
}

/** Canonical URL key: the club-local date, suffixed with -HHmm (local 24h) only
 *  when another meeting shares that local date. */
export function meetingUrlKey(
	scheduledAt: Date,
	timeZone: string,
	collides: boolean,
): string {
	const wall = utcToZonedWallTime(scheduledAt, timeZone); // YYYY-MM-DDTHH:mm
	const date = wall.slice(0, 10);
	if (!collides) return date;
	return `${date}-${wall.slice(11, 13)}${wall.slice(14, 16)}`;
}

/** Next calendar-date label (YYYY-MM-DD). tz-independent — operates on the label. */
export function nextCalendarDate(date: string): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The UTC [start, end) window for a club-local calendar date. */
export function localDayRange(
	date: string,
	timeZone: string,
): { start: Date; end: Date } {
	return {
		start: zonedWallTimeToUtc(`${date}T00:00`, timeZone),
		end: zonedWallTimeToUtc(`${nextCalendarDate(date)}T00:00`, timeZone),
	};
}

/** Assign canonical urlKeys to a list, detecting collisions WITHIN the list
 *  (same club-local date ⇒ all suffixed). Returns id → urlKey. */
export function urlKeysForMeetings(
	items: { id: string; scheduledAt: Date | string }[],
	timeZone: string,
): Map<string, string> {
	const dateOf = (i: { scheduledAt: Date | string }) =>
		localDateKey(new Date(i.scheduledAt), timeZone);
	const counts = new Map<string, number>();
	for (const i of items) {
		const d = dateOf(i);
		counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	const out = new Map<string, string>();
	for (const i of items) {
		out.set(
			i.id,
			meetingUrlKey(new Date(i.scheduledAt), timeZone, (counts.get(dateOf(i)) ?? 0) >= 2),
		);
	}
	return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/meeting-url.test.ts`
Expected: PASS (all cases). If the `"2026-13-99"` case fails, update the assertion per the note above to match shape-only parsing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-url.ts src/lib/meeting-url.test.ts
git commit -m "feat(meeting-url): pure club-local date URL-key helpers"
```

---

## Task 2: DB resolver — key → meeting id

**Files:**
- Create: `src/server/meeting-resolve-logic.ts`
- Test: `src/server/meeting-resolve.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// src/server/meeting-resolve.integration.test.ts
/**
 * DB-backed tests for resolveMeetingKey. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-resolve.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("resolveMeetingKey", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// Pin the club tz + move the seeded meeting far away so it never collides
		// with the 2026-07-21 fixtures below.
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago" })
			.where(eq(clubs.id, seed.clubId));
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date("2020-01-01T19:00:00Z") })
			.where(eq(meetings.id, seed.meetingId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("resolves a bare date, its -HHmm form, and its uuid", async () => {
		const { resolveMeetingKey } = await import("#/server/meeting-resolve-logic");
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:45:00Z"), // 18:45 local
				status: "scheduled",
			})
			.returning({ id: meetings.id });

		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(m.id);
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21-1845")).toBe(m.id);
		expect(await resolveMeetingKey(seed.clubId, m.id)).toBe(m.id);
	});

	it("resolves by the club-LOCAL date (not the UTC date)", async () => {
		const { resolveMeetingKey } = await import("#/server/meeting-resolve-logic");
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T02:30:00Z"), // 21:30 local on the 21st
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(m.id);
	});

	it("returns the earliest for a bare-date double-header, exact for -HHmm", async () => {
		const { resolveMeetingKey } = await import("#/server/meeting-resolve-logic");
		const [early] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-21T23:45:00Z"), // 18:45 local
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const [late] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2026-07-22T01:00:00Z"), // 20:00 local, same day
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21")).toBe(early.id);
		expect(await resolveMeetingKey(seed.clubId, "2026-07-21-2000")).toBe(late.id);
	});

	it("returns null for an unknown key or a uuid from another club", async () => {
		const { resolveMeetingKey } = await import("#/server/meeting-resolve-logic");
		expect(await resolveMeetingKey(seed.clubId, "2026-07-20")).toBeNull();
		expect(await resolveMeetingKey(seed.clubId, "not-a-key")).toBeNull();
		expect(
			await resolveMeetingKey(seed.clubId, "9f3c1a2b-0000-4000-8000-000000000000"),
		).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-resolve.integration.test.ts`
Expected: FAIL — `Cannot find module '#/server/meeting-resolve-logic'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/server/meeting-resolve-logic.ts
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { localDayRange, parseMeetingKey } from "#/lib/meeting-url";

/**
 * Resolve a `$meetingId` URL segment (club-local date / date-HHmm / uuid) to a
 * meeting id, scoped to `clubId`. Returns null when nothing matches — including a
 * uuid that belongs to a different club (so callers get not-found, not a leak).
 * A bare-date double-header resolves to the earliest meeting that local day.
 */
export async function resolveMeetingKey(
	clubId: string,
	key: string,
): Promise<string | null> {
	const parsed = parseMeetingKey(key);
	if (parsed.kind === "invalid") return null;

	if (parsed.kind === "uuid") {
		const row = await db.query.meetings.findFirst({
			where: and(eq(meetings.id, parsed.id), eq(meetings.clubId, clubId)),
			columns: { id: true },
		});
		return row?.id ?? null;
	}

	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, clubId),
		columns: { timezone: true },
	});
	const tz = club?.timezone ?? "UTC";

	if (parsed.kind === "instant") {
		const at = zonedWallTimeToUtc(`${parsed.date}T${parsed.hh}:${parsed.mm}`, tz);
		const row = await db.query.meetings.findFirst({
			where: and(eq(meetings.clubId, clubId), eq(meetings.scheduledAt, at)),
			columns: { id: true },
		});
		return row?.id ?? null;
	}

	// date kind → earliest meeting within the club-local day.
	const { start, end } = localDayRange(parsed.date, tz);
	const [row] = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, start),
				lt(meetings.scheduledAt, end),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);
	return row?.id ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-resolve.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the server-module guard is satisfied** (this is a `*-logic.ts` importing `#/db` — allowed):

Run: `bunx vitest run src/routes/server-modules.guard.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/meeting-resolve-logic.ts src/server/meeting-resolve.integration.test.ts
git commit -m "feat(meetings): resolve meeting URL key (date/instant/uuid) to id"
```

---

## Task 3: `loadMeetingDetail` returns `urlKey` + `*ByKey` server fns

**Files:**
- Modify: `src/server/meetings.ts`

- [ ] **Step 1: Add imports** at the top of `src/server/meetings.ts`.

Change the drizzle import (line 2) to add `lt`:

```ts
import { and, asc, eq, gte, lt, ne, sql } from "drizzle-orm";
```

Add two new imports below the existing `./meetings-logic` import block:

```ts
import { resolveMeetingKey } from "./meeting-resolve-logic";
import { localDateKey, localDayRange, meetingUrlKey } from "#/lib/meeting-url";
```

- [ ] **Step 2: Compute `urlKey` inside `loadMeetingDetail`.**

In `loadMeetingDetail`, immediately after the `club` lookup (the `const club = await db.query.clubs.findFirst({...})` block ending near line 165), insert:

```ts
	// Canonical date URL key for THIS meeting: club-local date, suffixed with
	// -HHmm only when the club has 2+ meetings that local day (#date-urls).
	const tz = club?.timezone ?? "UTC";
	const { start: dayStart, end: dayEnd } = localDayRange(
		localDateKey(meeting.scheduledAt, tz),
		tz,
	);
	const [{ count: sameDayCount } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, meeting.clubId),
				gte(meetings.scheduledAt, dayStart),
				lt(meetings.scheduledAt, dayEnd),
			),
		);
	const urlKey = meetingUrlKey(meeting.scheduledAt, tz, sameDayCount >= 2);
```

Then add `urlKey` to the returned object (the `return { meeting, slots: slotsWithContact, ... }` block near line 271). Add it right after `clubSlug: club?.slug ?? "",`:

```ts
		urlKey,
```

- [ ] **Step 3: Add the two `*ByKey` server fns.**

Directly below `getPublicMeeting` (ends near line 314), add:

```ts
const meetingKeyInput = z.object({ clubId: uuid, key: z.string().min(1) });

/**
 * Public meeting detail resolved by URL key (club-local date / date-HHmm / uuid),
 * session-aware `canManage`. Mirrors `getMeeting` but keyed by the pretty URL
 * segment. Throws "Meeting not found." (recognized by `isMeetingNotFoundError`)
 * when the key resolves to nothing, so route loaders render `notFound()`.
 */
export const getMeetingByKey = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingKeyInput.parse(input))
	.handler(async ({ data }) => {
		const meetingId = await resolveMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		const sessionUser = await getSessionUser();
		return loadMeetingDetail(meetingId, sessionUser?.id ?? null);
	});

/**
 * Public meeting detail resolved by URL key — forces `canManage = false` (no PII),
 * exactly like `getPublicMeeting`. For the present/print/anonymous surfaces.
 */
export const getPublicMeetingByKey = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingKeyInput.parse(input))
	.handler(async ({ data }) => {
		const meetingId = await resolveMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		return loadMeetingDetail(meetingId, null);
	});
```

- [ ] **Step 4: Typecheck** (this is the only real check for the loader wiring):

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-date-urls && bun run typecheck`
Expected: no errors. (`urlKey` is now on every `loadMeetingDetail` payload; consumers come in later tasks.)

- [ ] **Step 5: Re-run the resolver + guard tests** to confirm nothing regressed:

Run: `bunx vitest run src/routes/server-modules.guard.test.ts && TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-resolve.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/meetings.ts
git commit -m "feat(meetings): loadMeetingDetail returns urlKey; add getMeetingByKey/getPublicMeetingByKey"
```

---

## Task 4: Wire the three public route loaders (date URLs now RESOLVE)

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx:74-75`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.present.tsx:6,13`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx:19,43`

- [ ] **Step 1: Public meeting view loader.**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, update the import (lines 48-52) to swap in the byKey fns:

```ts
import {
	getMeetingByKey,
	getPublicMeetingByKey,
	listUpcomingMeetings,
} from "#/server/meetings";
```

Then change the loader's fork (lines 74-75) from:

```ts
		const load = context.shell ? getMeeting : getPublicMeeting;
		const meetingPromise = load({ data: params.meetingId }).catch((err) => {
```

to:

```ts
		const load = context.shell ? getMeetingByKey : getPublicMeetingByKey;
		const meetingPromise = load({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch((err) => {
```

(The existing `if (data.meeting.clubId !== context.clubUuid) throw notFound();` guard on line 85 stays — harmless defense; the resolver already scopes by club.)

- [ ] **Step 2: Present route loader.**

In `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`, change the import (line 6):

```ts
import { getPublicMeetingByKey } from "#/server/meetings";
```

and the loader (line 13):

```ts
		const data = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		});
```

- [ ] **Step 3: Print route loader.**

In `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`, change the import (line 19):

```ts
import { getPublicMeetingByKey } from "#/server/meetings";
```

and the loader (line 43):

```ts
			const data = await getPublicMeetingByKey({
				data: { clubId: club.id, key: params.meetingId },
			});
```

- [ ] **Step 4: Typecheck.**

Run: `bun run typecheck`
Expected: no errors. (`getMeeting`/`getPublicMeeting` may now be unused in these files — the imports were replaced, so there's nothing dangling here. `getPublicMeeting`'s export is handled in Task 9.)

- [ ] **Step 5: Manual smoke — date URLs resolve.**

Start the dev server and hit a real meeting by date. First find a club slug + a meeting's local date:

```bash
docker exec dev-postgres psql -U dev -d tm_scheduler -c \
  "select c.slug, m.scheduled_at, c.timezone from meetings m join clubs c on c.id=m.club_id order by m.scheduled_at desc limit 3;"
```

Run `bun run dev`, then in a browser (via the /browse skill or manually) open
`/club/<slug>/meeting/<YYYY-MM-DD>` for that meeting's club-local date. Expected: the
agenda renders (same page as the UUID URL). Also confirm the old
`/club/<slug>/meeting/<uuid>` still renders.

- [ ] **Step 6: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx \
        src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx \
        src/routes/club.\$clubId_.meeting.\$meetingId.print.tsx
git commit -m "feat(meetings): resolve public meeting routes by date URL key"
```

---

## Task 5: Emit `urlKey` on the meeting-detail surfaces

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (share button + MeetingViewActions)
- Modify: `src/routes/_authed/meetings.$id.tsx` (share paths + MeetingViewActions)

Recall `MeetingViewActions` already takes `clubSlug` + `meetingId` and uses `meetingId`
as the `$meetingId` param — so we only change the *value* callers pass (raw id → `urlKey`).
No change to the component itself.

- [ ] **Step 1: Public meeting view — use `urlKey` from loader data.**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, the component reads loader data.
Find where it destructures loader data (search for `Route.useLoaderData()`), and pull
`urlKey` out of it. Then:

- Share button (line ~368): change
  ```tsx
  path={`/club/${clubId}/meeting/${meeting.id}`}
  ```
  to
  ```tsx
  path={`/club/${clubId}/meeting/${urlKey}`}
  ```
- MeetingViewActions (line ~371-373): change `meetingId={meetingId}` to `meetingId={urlKey}`:
  ```tsx
  <MeetingViewActions
  	clubSlug={clubId}
  	meetingId={urlKey}
  ```

(`meetingId` — the raw URL param from `Route.useParams()` — is still used for write
calls like `claimSlot`/`setAvailability`; leave those untouched. Only the two
link-emitting spots switch to `urlKey`.)

- [ ] **Step 2: Authed meeting view — use `urlKey` for the public links it emits.**

In `src/routes/_authed/meetings.$id.tsx`, the component destructures loader data (from
`getMeeting`, which now returns `urlKey`). Pull `urlKey` from that data.

- Share path (lines ~188-189):
  ```tsx
  ? `/club/${clubSlug}/meeting/${urlKey}`
  : `${window.location.origin}/club/${clubSlug}/meeting/${urlKey}`;
  ```
- ShareLinkButton path (line ~389): `path={`/club/${clubSlug}/meeting/${urlKey}`}`
- MeetingViewActions (line ~392-394): `meetingId={urlKey}`

Leave everything targeting `/meetings/$id` and all write-call `meeting.id` usages as
raw UUID (the nav strip's `getLinkProps` is handled in Task 6).

- [ ] **Step 3: Typecheck.**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke.** With `bun run dev` running, open a meeting on the public
view and click **Copy share link** — the copied URL is `/club/<slug>/meeting/<date>`.
Click **Present** / **Print agenda** — both open at the date URL. Repeat on the authed
`/meetings/<uuid>` view: the page URL stays UUID, but Present/Print/Share emit the date form.

- [ ] **Step 5: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(meetings): emit date URLs from meeting-detail share/present/print"
```

---

## Task 6: Nav strip emits `urlKey` (public) while authed paging stays UUID

**Files:**
- Modify: `src/lib/meeting-nav.ts`
- Modify: `src/lib/meeting-nav.test.ts`
- Modify: `src/components/club/meeting-nav-strip.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx` (its custom `getLinkProps`)

`MeetingNavItem` must carry BOTH the raw `meetingId` (for `/meetings/$id`) and the
`urlKey` (for the public view). The strip's link callback receives the whole item so
each caller picks the right one.

- [ ] **Step 1: Update the nav test first (red).**

In `src/lib/meeting-nav.test.ts`, the existing `buildMeetingNavItems`/`deriveMeetingNavItems`
tests assert on `meetingId`. Add/extend assertions so items carry a `urlKey`. Add this
test (adjust `timezone`/inputs to match the file's existing fixtures):

```ts
it("emits a club-local-date urlKey per item and keeps meetingId as the raw id", () => {
	const items = buildMeetingNavItems(
		{ id: "cur", scheduledAt: new Date("2026-07-21T23:45:00Z"), openSlots: 0 },
		[{ id: "up", scheduledAt: new Date("2026-07-28T23:45:00Z"), openSlots: 2 }],
		"America/Chicago",
	);
	const cur = items.find((i) => i.meetingId === "cur");
	const up = items.find((i) => i.meetingId === "up");
	expect(cur?.urlKey).toBe("2026-07-21");
	expect(up?.urlKey).toBe("2026-07-28");
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: FAIL — `urlKey` does not exist on `MeetingNavItem`.

- [ ] **Step 3: Update `src/lib/meeting-nav.ts`.**

Add the import at the top:

```ts
import { urlKeysForMeetings } from "./meeting-url";
```

Add `urlKey` to the type:

```ts
export type MeetingNavItem = {
	meetingId: string;
	urlKey: string;
	label: string;
	isCurrent: boolean;
	hasOpenRoles: boolean;
};
```

In `buildMeetingNavItems`, compute the keys over the deduped set and populate both
fields. Replace the `return [...byId.values()]...map(...)` block with:

```ts
	const ordered = [...byId.values()].sort(
		(a, b) => toMillis(a.scheduledAt) - toMillis(b.scheduledAt),
	);
	const keys = urlKeysForMeetings(ordered, timezone);
	return ordered.map((m) => ({
		meetingId: m.id,
		urlKey: keys.get(m.id) ?? m.id,
		label: formatShortDate(m.scheduledAt, timezone),
		isCurrent: m.id === current.id,
		hasOpenRoles: m.openSlots > 0,
	}));
```

Change `defaultMeetingNavLinkProps` to build the public link from `urlKey`:

```ts
/**
 * Default destination for a nav-strip item: the public club meeting page, keyed
 * by the item's club-local-date `urlKey`. Signed-in views pass their own builder
 * (targeting `/meetings/$id` by raw id) so paging stays in the workspace.
 */
export function defaultMeetingNavLinkProps(
	clubId: string,
	item: MeetingNavItem,
): LinkProps {
	return {
		to: "/club/$clubId/meeting/$meetingId",
		params: { clubId, meetingId: item.urlKey },
	};
}
```

- [ ] **Step 4: Update the strip component `src/components/club/meeting-nav-strip.tsx`.**

Change the `getLinkProps` prop type and the call to pass the whole item:

```ts
	getLinkProps?: (item: MeetingNavItem) => LinkProps;
}) {
	const linkPropsFor =
		getLinkProps ?? ((item: MeetingNavItem) => defaultMeetingNavLinkProps(clubId, item));
```

and the render call (line ~51):

```tsx
							{...linkPropsFor(item)}
```

(`key={item.meetingId}` and `activeId = items.find((i) => i.isCurrent)?.meetingId`
stay on the raw id — a stable React key.)

- [ ] **Step 5: Update the authed custom builder in `src/routes/_authed/meetings.$id.tsx`.**

Find the `getLinkProps` passed to `MeetingNavStrip` (line ~375):

```tsx
getLinkProps={(meetingId) => ({
	to: "/meetings/$id",
	params: { id: meetingId },
})}
```

Change it to take the item and use the raw id:

```tsx
getLinkProps={(item) => ({
	to: "/meetings/$id",
	params: { id: item.meetingId },
})}
```

- [ ] **Step 6: Run the nav test + typecheck.**

Run: `bunx vitest run src/lib/meeting-nav.test.ts && bun run typecheck`
Expected: PASS + no type errors. (If any other existing nav test constructed a
`MeetingNavItem` literal without `urlKey`, add `urlKey` to that literal.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/meeting-nav.ts src/lib/meeting-nav.test.ts \
        src/components/club/meeting-nav-strip.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(meetings): nav strip emits date URLs; authed paging stays UUID"
```

---

## Task 7: Club-index "your upcoming roles" links emit `urlKey`

**Files:**
- Modify: `src/server/meetings.ts` (`listMemberCommitments`)
- Modify: `src/routes/club.$clubId.index.tsx` (the commitment link)

`listMemberCommitments` returns rows with `meetingId`, `scheduledAt`, `timezone` (all
for one club — a member belongs to one club). Add a `urlKey` per row.

- [ ] **Step 1: Add `urlKey` to `listMemberCommitments`.**

In `src/server/meetings.ts`, `listMemberCommitments` currently returns the query result
directly. Wrap it to attach `urlKey`. Replace `return db.select({...})...;` with a
`const rows = await db.select({...})...;` (keep the exact select/where/orderBy), then:

```ts
		const timezone = rows[0]?.timezone ?? "UTC";
		const keys = urlKeysForMeetings(
			rows.map((r) => ({ id: r.meetingId, scheduledAt: r.scheduledAt })),
			timezone,
		);
		return rows.map((r) => ({ ...r, urlKey: keys.get(r.meetingId) ?? r.meetingId }));
```

(`urlKeysForMeetings` is already imported into `meetings.ts` from Task 3. The single
`timezone` is safe here because all rows are one club.)

- [ ] **Step 2: Use `c.urlKey` in the club index link.**

In `src/routes/club.$clubId.index.tsx`, the commitment link (line ~173) is:

```tsx
params={{ clubId, meetingId: c.meetingId }}
```

Change to:

```tsx
params={{ clubId, meetingId: c.urlKey }}
```

- [ ] **Step 3: Typecheck.**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Manual smoke.** On `/club/<slug>` as a member with an upcoming role, the
"your upcoming roles" links point at `/club/<slug>/meeting/<date>`.

- [ ] **Step 5: Commit**

```bash
git add src/server/meetings.ts src/routes/club.\$clubId.index.tsx
git commit -m "feat(meetings): club-index commitment links use date URLs"
```

---

## Task 8: Season-grid cells emit `urlKey` in public mode

**Files:**
- Modify: `src/server/season-grid-logic.ts` (`SeasonGridMeeting` + `loadSeasonGrid`)
- Modify: `src/components/club/season-grid.tsx` (pass the column meeting's key to the cell)
- Modify: `src/components/club/grid-cell.tsx` (accept + forward the key)
- Modify: `src/components/club/meeting-link.tsx` (accept a separate `meetingKey`)

The grid renders in public mode (`clubSlug` set) on `/club/<slug>`, so its cells link to
the public meeting view and must use the date key. In authed mode (no `clubSlug`) the
cell links to `/meetings/$id` and must keep the raw UUID.

- [ ] **Step 1: `MeetingLink` accepts a separate public-view key.**

In `src/components/club/meeting-link.tsx`, add a `meetingKey` prop and use it for the
public branch only (default to `meetingId` for back-compat):

```tsx
export function MeetingLink({
	clubSlug,
	meetingId,
	meetingKey,
	className,
	"aria-label": ariaLabel,
	children,
}: {
	clubSlug?: string;
	meetingId: string;
	/** Club-local-date key for the PUBLIC view (`$meetingId` param). Defaults to
	 *  `meetingId`. Ignored by the authed `/meetings/$id` branch, which always
	 *  uses the raw uuid. */
	meetingKey?: string;
	className?: string;
	"aria-label"?: string;
	children: ReactNode;
}) {
	if (clubSlug) {
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId: meetingKey ?? meetingId }}
				className={className}
				aria-label={ariaLabel}
			>
				{children}
			</Link>
		);
	}
	return (
		<Link
			to="/meetings/$id"
			params={{ id: meetingId }}
			className={className}
			aria-label={ariaLabel}
		>
			{children}
		</Link>
	);
}
```

- [ ] **Step 2: Add `urlKey` to `SeasonGridMeeting` and compute it in `loadSeasonGrid`.**

In `src/server/season-grid-logic.ts`, add the field to the interface (near line 18):

```ts
export interface SeasonGridMeeting {
	id: string;
	scheduledAt: string;
	timezone: string;
	urlKey: string;
	// ...existing fields stay...
}
```

Add the import at the top:

```ts
import { urlKeysForMeetings } from "#/lib/meeting-url";
```

Where the meetings are mapped to `SeasonGridMeeting` (the `ordered.map((m) => ({ id: m.id, scheduledAt: m.scheduledAt.toISOString(), timezone, ... }))` block near line 230), first compute the keys over `ordered`, then add `urlKey`:

```ts
	const gridKeys = urlKeysForMeetings(ordered, timezone);
```

(place this just before the `.map`), and inside the object literal add:

```ts
		urlKey: gridKeys.get(m.id) ?? m.id,
```

- [ ] **Step 3: Thread the key from the column meeting to the cell in `season-grid.tsx`.**

In `src/components/club/season-grid.tsx`, the grid iterates its `meetings` (columns) and
renders a `GridCell` per (member, meeting). Where `<GridCell ... />` is rendered, pass the
column meeting's `urlKey` as a new prop `meetingKey={meeting.urlKey}`. (The loop variable
holding the column `SeasonGridMeeting` — often named `meeting` or `m` — carries `urlKey`
after Step 2.)

- [ ] **Step 4: Forward the key in `grid-cell.tsx`.**

In `src/components/club/grid-cell.tsx`, add `meetingKey?: string` to the props type
(alongside `clubSlug`), and pass it to `MeetingLink` (line ~176-178):

```tsx
		<MeetingLink
			clubSlug={clubSlug}
			meetingId={cell.meetingId}
			meetingKey={meetingKey}
```

- [ ] **Step 5: Typecheck.**

Run: `bun run typecheck`
Expected: no errors. (If any other renderer of `SeasonGrid`/`GridCell` exists, TS will
flag the new required/optional props — `meetingKey` is optional, so existing authed
callers compile unchanged and keep UUID links.)

- [ ] **Step 6: Re-run the season-grid integration test** (it constructs grid data; make
sure the added `urlKey` field didn't break its assertions):

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: PASS. (If an assertion does a strict `toEqual` on a meeting object, add `urlKey`
to the expected shape.)

- [ ] **Step 7: Manual smoke.** On `/club/<slug>` (grid view), click a meeting header/cell
link — it navigates to `/club/<slug>/meeting/<date>`.

- [ ] **Step 8: Commit**

```bash
git add src/server/season-grid-logic.ts src/components/club/season-grid.tsx \
        src/components/club/grid-cell.tsx src/components/club/meeting-link.tsx
git commit -m "feat(meetings): season-grid cells emit date URLs in public mode"
```

---

## Task 9: Cleanup + full verification

**Files:**
- Modify (maybe): `src/server/meetings.ts` (remove now-unused `getPublicMeeting`)

- [ ] **Step 1: Check whether `getPublicMeeting` is still used.**

Run:
```bash
grep -rn "getPublicMeeting\b" src | grep -v "getPublicMeetingByKey" | grep -v "meetings.ts:"
```
Expected: no matches (all three routes now use `getPublicMeetingByKey`). If there are
matches (e.g. a test), leave `getPublicMeeting` in place. Otherwise remove the
`getPublicMeeting` export from `src/server/meetings.ts` (the whole `createServerFn` block
near line 312) to avoid dead code. Leave `getMeeting` — it's still used by
`/_authed/meetings/$id`.

- [ ] **Step 2: Full typecheck.**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Full test suite (with the DB URL so integration suites run).**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: all pass. Investigate any failure before proceeding — a strict `toEqual` on a
meeting payload elsewhere may need `urlKey` added to its expected shape.

- [ ] **Step 4: Lint/format gate.**

Run: `bun run check`
Expected: clean. If Biome reports formatting, run `bun run format` and re-run `bun run check`.

- [ ] **Step 5: Full manual smoke via the app (use the /browse skill).** Verify end-to-end:
  - `/club/<slug>/meeting/<date>` renders; `/club/<slug>/meeting/<uuid>` still renders (no redirect).
  - A double-header club: bare date → earliest; `<date>-<HHmm>` → the exact one.
  - Copy-share, Present, Print all produce/open date URLs.
  - Authed `/meetings/<uuid>` page URL stays UUID; its emitted public links are date-form.

- [ ] **Step 6: Final commit (if Step 1 removed code or Step 4 reformatted).**

```bash
git add -A
git commit -m "chore(meetings): drop unused getPublicMeeting; format"
```

---

## Self-review notes (already reconciled)

- **Spec coverage:** helper (§Components 1 → Task 1), resolver (§2 → Task 2), loaders +
  byKey fns (§3 → Tasks 3-4), central emit (§4 → Tasks 5-8), collision `-HHmm`
  (Tasks 1/2/3), UUID stays working (Task 4 uuid branch), no redirect (Task 4 leaves UUID
  as-is), internal view keeps UUID address (Task 6 authed getLinkProps).
- **Known limitations** (spec): date-URL instability across reschedule and the DST
  fall-back repeated hour are accepted — no task, by design.
- **Type consistency:** `urlKey` is the single field name everywhere; `meetingUrlKey`,
  `resolveMeetingKey`, `urlKeysForMeetings`, `parseMeetingKey`, `localDayRange`,
  `nextCalendarDate`, `localDateKey` names match across tasks; `MeetingNavItem` gains
  `urlKey` (Task 6) and every consumer is updated in the same task.
