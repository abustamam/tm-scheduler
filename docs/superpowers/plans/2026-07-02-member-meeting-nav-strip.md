# Member Meeting Nav Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a horizontal, swipeable date strip to the public member meeting page (`/club/$clubId/meeting/$meetingId`) so members can jump directly between upcoming meetings.

**Architecture:** A pure helper (`buildMeetingNavItems`) turns the current meeting + the existing `listUpcomingMeetings` result into sorted, labeled nav items; a presentational `MeetingNavStrip` renders them as `<Link>` tabs and auto-centers the active one; the meeting-page loader fetches the upcoming list in parallel with `getMeeting` but non-fatally (a strip-data failure degrades to no strip, never breaks the agenda).

**Tech Stack:** TanStack Start/Router, React 19, Tailwind v4 + shadcn (`cn` from `#/lib/utils`), Vitest. Package manager: Bun. Import alias `#/*` → `src/*`.

**Reference spec:** `docs/superpowers/specs/2026-07-02-member-meeting-nav-strip-design.md`

---

## File Structure

- **Create** `src/lib/meeting-nav.ts` — `MeetingNavItem` type + `buildMeetingNavItems` pure helper (all the logic).
- **Create** `src/lib/meeting-nav.test.ts` — unit tests for the helper.
- **Create** `src/components/club/meeting-nav-strip.tsx` — presentational strip component.
- **Modify** `src/lib/format.ts` — add `formatShortDate` (compact, locale-safe `Aug 13`).
- **Create** `src/lib/format.test.ts` — unit test for `formatShortDate`.
- **Modify** `src/routes/club.$clubId.meeting.$meetingId.tsx` — loader fetches upcoming list non-fatally, builds nav items; view renders `<MeetingNavStrip>`.

**Conventions to match:** lib tests import `{ describe, expect, it } from "vitest"` and use the `#/` or `./` alias (see `src/lib/season-grid-view.test.ts`). Biome formats with **tabs** and **double quotes**. Strict TS: no unused symbols.

---

## Task 1: `formatShortDate` helper

**Files:**
- Modify: `src/lib/format.ts` (append a new export after `formatMeetingTime`)
- Test: `src/lib/format.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatShortDate } from "./format";

describe("formatShortDate", () => {
	it("formats a date as compact month + day in the given timezone", () => {
		expect(formatShortDate("2026-08-13T19:00:00Z", "UTC")).toBe("Aug 13");
	});

	it("respects the timezone when it shifts the calendar day", () => {
		// 03:00 UTC on Aug 14 is still Aug 13 in Los Angeles.
		expect(formatShortDate("2026-08-14T03:00:00Z", "America/Los_Angeles")).toBe(
			"Aug 13",
		);
	});

	it("accepts a Date instance", () => {
		expect(formatShortDate(new Date("2026-01-05T12:00:00Z"), "UTC")).toBe(
			"Jan 5",
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/format.test.ts`
Expected: FAIL — `formatShortDate` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/format.ts`:

```ts
export function formatShortDate(value: Date | string, timeZone?: string) {
	const d = typeof value === "string" ? new Date(value) : value;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		timeZone,
	}).format(d);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/format.test.ts`
Expected: PASS (3 tests). (Node 22 bundles full ICU; default locale renders `Aug 13`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(format): add compact formatShortDate helper"
```

---

## Task 2: `buildMeetingNavItems` pure helper

**Files:**
- Create: `src/lib/meeting-nav.ts`
- Test: `src/lib/meeting-nav.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/meeting-nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMeetingNavItems } from "./meeting-nav";

const TZ = "UTC";

describe("buildMeetingNavItems", () => {
	it("sorts by date, flags the current meeting, and maps open-role dots", () => {
		const items = buildMeetingNavItems(
			{ id: "b", scheduledAt: "2026-07-23T19:00:00Z" },
			[
				{ id: "b", scheduledAt: "2026-07-23T19:00:00Z", openSlots: 0 },
				{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 3 },
				{ id: "c", scheduledAt: "2026-08-13T19:00:00Z", openSlots: 1 },
			],
			TZ,
		);

		expect(items.map((i) => i.meetingId)).toEqual(["a", "b", "c"]);
		expect(items.map((i) => i.isCurrent)).toEqual([false, true, false]);
		expect(items.map((i) => i.hasOpenRoles)).toEqual([true, false, true]);
		expect(items.map((i) => i.label)).toEqual(["Jul 9", "Jul 23", "Aug 13"]);
	});

	it("unions the current meeting in when it is not in the upcoming set (past meeting)", () => {
		// The current meeting already happened, so listUpcomingMeetings excluded it.
		const items = buildMeetingNavItems(
			{ id: "past", scheduledAt: "2026-07-01T19:00:00Z" },
			[
				{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 2 },
				{ id: "c", scheduledAt: "2026-08-13T19:00:00Z", openSlots: 0 },
			],
			TZ,
		);

		expect(items.map((i) => i.meetingId)).toEqual(["past", "a", "c"]);
		const current = items.find((i) => i.isCurrent);
		expect(current?.meetingId).toBe("past");
		expect(current?.hasOpenRoles).toBe(false); // no openSlots data for a unioned past meeting
	});

	it("does not duplicate the current meeting when it is already in the upcoming set", () => {
		const items = buildMeetingNavItems(
			{ id: "a", scheduledAt: "2026-07-09T19:00:00Z" },
			[{ id: "a", scheduledAt: "2026-07-09T19:00:00Z", openSlots: 1 }],
			TZ,
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ meetingId: "a", isCurrent: true, hasOpenRoles: true });
	});

	it("returns just the current meeting when upcoming is empty", () => {
		const items = buildMeetingNavItems(
			{ id: "only", scheduledAt: "2026-07-09T19:00:00Z" },
			[],
			TZ,
		);
		expect(items).toEqual([
			{ meetingId: "only", label: "Jul 9", isCurrent: true, hasOpenRoles: false },
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: FAIL — cannot find module `./meeting-nav` / `buildMeetingNavItems` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/meeting-nav.ts`:

```ts
import { formatShortDate } from "./format";

export type MeetingNavItem = {
	meetingId: string;
	label: string;
	isCurrent: boolean;
	hasOpenRoles: boolean;
};

type CurrentMeeting = { id: string; scheduledAt: Date | string };
type UpcomingMeeting = {
	id: string;
	scheduledAt: Date | string;
	openSlots: number;
};

function toMillis(value: Date | string): number {
	return (typeof value === "string" ? new Date(value) : value).getTime();
}

/**
 * Build the sorted, labeled nav items for the member meeting strip.
 *
 * `listUpcomingMeetings` filters `scheduledAt >= now`, so a meeting being
 * viewed after it has started is absent from `upcoming`. We union `current` in
 * (deduped by id) so the strip always shows and highlights the viewed meeting.
 */
export function buildMeetingNavItems(
	current: CurrentMeeting,
	upcoming: UpcomingMeeting[],
	timezone: string,
): MeetingNavItem[] {
	const byId = new Map<string, UpcomingMeeting>();
	for (const m of upcoming) byId.set(m.id, m);
	if (!byId.has(current.id)) {
		byId.set(current.id, {
			id: current.id,
			scheduledAt: current.scheduledAt,
			openSlots: 0,
		});
	}

	return [...byId.values()]
		.sort((a, b) => toMillis(a.scheduledAt) - toMillis(b.scheduledAt))
		.map((m) => ({
			meetingId: m.id,
			label: formatShortDate(m.scheduledAt, timezone),
			isCurrent: m.id === current.id,
			hasOpenRoles: m.openSlots > 0,
		}));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/meeting-nav.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-nav.ts src/lib/meeting-nav.test.ts
git commit -m "feat(meeting-nav): buildMeetingNavItems helper"
```

---

## Task 3: `MeetingNavStrip` component

**Files:**
- Create: `src/components/club/meeting-nav-strip.tsx`

No new test: the component is presentational with no branching logic beyond the `items.length <= 1` guard and a scroll effect (both exercised in-app). The testable logic lives in Task 2.

- [ ] **Step 1: Write the component**

Create `src/components/club/meeting-nav-strip.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { MeetingNavItem } from "#/lib/meeting-nav";
import { cn } from "#/lib/utils";

/**
 * Horizontal date strip for jumping between a club's meetings on the member
 * view. Presentational: all ordering/labeling is done by `buildMeetingNavItems`.
 */
export function MeetingNavStrip({
	clubId,
	items,
}: {
	clubId: string;
	items: MeetingNavItem[];
}) {
	const activeRef = useRef<HTMLLIElement>(null);
	const activeId = items.find((i) => i.isCurrent)?.meetingId;

	// Re-center on active change (navigating between meetings re-renders rather
	// than remounts this strip). `nearest` avoids a jump when the active tab is
	// already fully visible.
	useEffect(() => {
		activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
	}, [activeId]);

	if (items.length <= 1) return null;

	return (
		<nav aria-label="Meetings" className="-mx-4 overflow-x-auto px-4">
			<ul className="flex gap-2 pb-1">
				{items.map((item) => (
					<li
						key={item.meetingId}
						ref={item.isCurrent ? activeRef : undefined}
						className="shrink-0"
					>
						<Link
							to="/club/$clubId/meeting/$meetingId"
							params={{ clubId, meetingId: item.meetingId }}
							aria-current={item.isCurrent ? "page" : undefined}
							className={cn(
								"flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors",
								item.isCurrent
									? "border-primary bg-primary text-primary-foreground"
									: "border-border bg-card text-muted-foreground hover:bg-accent",
							)}
						>
							{item.label}
							{item.hasOpenRoles ? (
								<span
									aria-label="has open roles"
									className={cn(
										"size-1.5 rounded-full",
										item.isCurrent ? "bg-primary-foreground" : "bg-primary",
									)}
								/>
							) : null}
						</Link>
					</li>
				))}
			</ul>
		</nav>
	);
}
```

- [ ] **Step 2: Verify it typechecks / lints**

Run: `bun run check`
Expected: PASS (no lint/format/type errors). If Biome reports formatting, run `bun run format` and re-check.

- [ ] **Step 3: Commit**

```bash
git add src/components/club/meeting-nav-strip.tsx
git commit -m "feat(club): MeetingNavStrip presentational component"
```

---

## Task 4: Wire the strip into the meeting route

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
  - imports (top of file)
  - `Route` loader (currently lines ~41-47)
  - `MeetingView` loader-data destructure (currently line ~84-85)
  - header JSX (insert after the date/theme block, before the availability button)

- [ ] **Step 1: Add imports**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, add these imports alongside the existing `#/` imports:

```tsx
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { buildMeetingNavItems } from "#/lib/meeting-nav";
import { getMeeting } from "#/server/meetings";
import { listUpcomingMeetings } from "#/server/meetings";
```

Note: `getMeeting` is already imported — add only `listUpcomingMeetings` to that existing import line, and add the two `#/` lines. Final `#/server/meetings` import line should read:

```tsx
import { getMeeting, listUpcomingMeetings } from "#/server/meetings";
```

- [ ] **Step 2: Update the loader to fetch upcoming non-fatally and build nav items**

Replace the existing `loader` in the `createFileRoute(...)` options:

```tsx
	loader: async ({ params }) => {
		// Fire both in parallel. getMeeting stays fatal (the agenda is the page);
		// the upcoming list is non-fatal — a failure degrades to no strip.
		const meetingPromise = getMeeting({ data: params.meetingId });
		const upcomingPromise = listUpcomingMeetings({
			data: params.clubId,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL
		// (e.g. a stale/mistyped link) rendering one club's agenda under another's.
		if (data.meeting.clubId !== params.clubId) throw notFound();

		const upcoming = await upcomingPromise;
		const navItems = buildMeetingNavItems(
			{ id: data.meeting.id, scheduledAt: data.meeting.scheduledAt },
			upcoming,
			data.timezone,
		);
		return { ...data, navItems };
	},
```

- [ ] **Step 3: Consume `navItems` in the component**

Update the loader-data destructure in `MeetingView` (currently `const { meeting, slots, timezone, unavailableMemberIds } = Route.useLoaderData();`) to include `navItems`:

```tsx
	const { meeting, slots, timezone, unavailableMemberIds, navItems } =
		Route.useLoaderData();
```

- [ ] **Step 4: Render the strip in the header**

In the `<header>` block, insert the strip immediately after the closing `</div>` of the date/theme/location line and before the `{meeting.wordOfTheDay ? ... }` block (i.e. between the meta line and word-of-the-day):

```tsx
				<MeetingNavStrip clubId={clubId} items={navItems} />
```

- [ ] **Step 5: Typecheck, lint, and run the full test suite**

Run: `bun run check`
Expected: PASS.

Run: `bunx vitest run src/lib/meeting-nav.test.ts src/lib/format.test.ts`
Expected: PASS (all nav + format tests).

- [ ] **Step 6: Manually verify in the app (dev server)**

Run: `bun run dev` (port 3000). Open a club with ≥2 upcoming meetings:
`http://localhost:3000/club/78bc6e8c-0031-4eb7-bd36-c3b85c902dc1/meeting/<meetingId>`
(MCF club id from the dev DB; pick a meeting id from `/club/<clubId>`).

Expected:
- A row of date tabs appears under the meeting title; the current meeting's tab is highlighted.
- Tapping another date navigates to that meeting; the highlight and agenda update.
- A tab with open roles shows a small dot.
- With only one meeting scheduled, no strip appears.

(If the MCF club has only 1–2 meetings, create extras via the VPE "New meeting" flow first, or verify with whatever club has several upcoming meetings.)

- [ ] **Step 7: Commit**

```bash
git add src/routes/club.$clubId.meeting.$meetingId.tsx
git commit -m "feat(club): meeting nav strip on the member meeting view"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** date-strip pattern (Task 3), upcoming-only + current union (Task 2), open-roles dot (Tasks 2+3), non-fatal fetch (Task 4 Step 2), auto-scroll-on-active-change `nearest` (Task 3), `Aug 13` locale-safe label (Task 1), single-meeting hide (Task 3 guard), no cap (uncapped `listUpcomingMeetings`, unchanged). All covered.
- **Type consistency:** `MeetingNavItem` fields (`meetingId`, `label`, `isCurrent`, `hasOpenRoles`) are identical across Tasks 2, 3, 4. `buildMeetingNavItems(current, upcoming, timezone)` signature is identical in the helper, its test, and the loader call. The loader passes `data.meeting.scheduledAt` (a `Date`) and `upcoming` items carrying `openSlots` — both accepted by the helper's `Date | string` / `UpcomingMeeting` types.
- **No new server function**, so no `server-modules.guard.test.ts` surface to worry about; nothing db-touching is added to a client-imported module.
