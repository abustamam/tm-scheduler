# GavelUp Activity Log View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps, TDD where it pays (write-side enrichment + `listActivity` get integration tests; the sentence formatter gets unit tests; the route is verified by build).

**Goal:** Give the VPE a read-only **activity feed** (`_authed/activity.tsx`) — reverse-chronological "actor · what changed · meeting", filterable by meeting and by member — over the `activity_log` that's already being written.

**Architecture:** A new authed (VPE-only) server fn `listActivity(clubId, { meetingId?, actorMemberId?, limit? })` reads `activity_log`, batch-resolves the ids it references (actor member, slot→role+meeting, target member, the assignee stored in `detail`) into display fields, and returns enriched rows. A pure `lib/activity-format.ts` turns one enriched row into a sentence (unit-tested). The route renders the feed + two filter dropdowns. A small write-side enrichment first captures the *displaced* assignee on reassign/release so the feed can show before→after.

**Tech Stack:** TanStack Start server fns + file routes, Drizzle (`node-postgres`), Zod, TanStack Query, shadcn/ui, Bun, Vitest (`describe.skipIf(!hasTestDb)` integration tests), Biome.

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-self-serve-mvp-design.md` §6 (VPE overview) + §8 (activity log: VPE-only, reverse-chron, filterable by meeting/member, **read-only in v1**).

**Scope guard — IN:** the write-side displaced-assignee enrichment (reassign/release only), `listActivity`, the formatter, the `_authed/activity.tsx` route. **OUT:** one-tap undo (deferred), roster merge/dedupe (separate step), any member-facing/public change, editing log entries.

## Data already logged (confirmed — `grep logActivity src/server`)
| action | targetType | targetId | detail |
|---|---|---|---|
| `claim` | slot | slotId | `{ memberId }` (claimer); from `confirmSlot`: `{ confirmed: true }` |
| `release` | slot | slotId | none; from `unconfirmSlot`: `{ unconfirmed: true }` — **Task 1 adds `{ fromMemberId }`** |
| `reassign` | slot | slotId | `{ memberId }` (new assignee) — **Task 1 adds `{ fromMemberId }`** |
| `availability_set` / `availability_clear` | meeting | meetingId | none; actor = the member |
| `member_add` | member | newMemberId | `{ name }`; actor = the new member |

`actorMemberId` may be `null` (system); always resolve defensively.

## Commands
Typecheck `bunx tsc --noEmit` · lint `bun run check` · tests no-DB `bunx vitest run` · tests with-DB `TEST_DATABASE_URL=… bunx vitest run` (local DB per `src/server/claim.integration.test.ts` + `src/test/db.ts`) · build `bun run build` (authoritative route-tree generator — NOT `generate-routes`, which strips the TanStack-Start `Register` block) · routes appear in `src/routeTree.gen.ts` after build.

## File structure
- Modify `src/server/slots.ts` — add `fromMemberId` to the reassign + release `detail` (Task 1).
- Create `src/server/activity-feed.ts` — `listActivity` (authed, VPE-only) (Task 2). Kept separate from `src/server/activity.ts` (the writer, which is imported inside transactions).
- Create `src/lib/activity-format.ts` (+ test) — pure row→sentence helper (Task 3).
- Create `src/routes/_authed/activity.tsx` — the feed UI (Task 4).
- Tests: extend `src/server/claim.integration.test.ts` (Task 1); create `src/server/activity-feed.integration.test.ts` (Task 2); `src/lib/activity-format.test.ts` (Task 3).

---

### Task 1: Capture the displaced assignee on reassign & release

**Files:** Modify `src/server/slots.ts`; Test: `src/server/claim.integration.test.ts`

Both `reassignSlot` and `releaseSlot` already `select` the slot row (including `assignedMemberId`) inside the transaction before updating. Record that prior assignee in the log `detail` so the feed can show "X → Y" / "X → empty".

- [ ] **Step 1 (failing test):** in `claim.integration.test.ts`, after seeding a slot assigned to member A, call `reassignSlot` to member B, then read the latest `activity_log` row and assert `detail` contains `fromMemberId === A` and `memberId === B`. Add a second case: after a slot assigned to A, `releaseSlot`, assert the latest `release` row's `detail.fromMemberId === A`.

```ts
it("reassign logs the displaced assignee (fromMemberId)", async () => {
	const { claimSlot, reassignSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, memberId: seed.memberId, actorMemberId: seed.memberId } });
	await reassignSlot({ data: { slotId: seed.slotId, memberId: seed.member2Id, actorMemberId: seed.member2Id } });
	const [row] = await db.select().from(activityLog)
		.where(and(eq(activityLog.targetId, seed.slotId), eq(activityLog.action, "reassign")))
		.orderBy(desc(activityLog.createdAt)).limit(1);
	expect((row.detail as { fromMemberId?: string }).fromMemberId).toBe(seed.memberId);
	expect((row.detail as { memberId?: string }).memberId).toBe(seed.member2Id);
});
```

(If the test seed (`src/test/db.ts` / `SeededClub`) has no second member, add a `member2Id` to it following the existing seed shape. Check first; reuse if present.)

- [ ] **Step 2:** Run with DB → fails (`fromMemberId` undefined).
- [ ] **Step 3:** In `reassignSlot`'s `logActivity` call, change `detail: { memberId: data.memberId }` → `detail: { fromMemberId: slot.assignedMemberId, memberId: data.memberId }`. In `releaseSlot`'s `logActivity` call, change to `detail: { fromMemberId: slot.assignedMemberId }`. Use whatever the in-scope fetched slot variable is named (read the surrounding code; it's the row selected at the top of the `tx`). Do NOT change any guard, the conditional update, or `claim`/`confirm`/`unconfirm`.
- [ ] **Step 4:** Run → pass; existing claim/release/reassign/race tests still pass; `bunx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(server): log displaced assignee on reassign/release`.

---

### Task 2: `listActivity` — the enriched, filterable feed query

**Files:** Create `src/server/activity-feed.ts`; Test: `src/server/activity-feed.integration.test.ts`

- [ ] **Step 1 (failing test):** Authed fns **cannot** obtain a valid session in this integration setup (no HTTP request → `getSessionUser()` returns null → `requireUser()` throws). So stub the auth guards with `vi.mock` and exercise the **real DB enrichment/filtering** (the valuable part). Seed a club; perform a claim + an availability_set + a member_add **via the real public server fns**; then assert the enriched feed:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, hasTestDb, seedClub, type SeededClub } from "#/test/db";

// Stub auth so the VPE-only gate passes; the real DB queries still run.
vi.mock("#/server/guards", () => ({
	requireUser: vi.fn().mockResolvedValue({ id: "admin-test" }),
	requireClubRole: vi.fn().mockResolvedValue({ clubRole: "admin" }),
}));

describe.skipIf(!hasTestDb)("listActivity", () => {
	let seed: SeededClub;
	beforeEach(async () => { seed = await seedClub(); });
	afterEach(async () => { await cleanup(seed.clubId, [seed.adminUserId, /* memberUserId */]); });

	it("returns enriched rows newest-first with resolved names + role + meeting", async () => {
		const { claimSlot } = await import("#/server/slots");
		const { setAvailability } = await import("#/server/availability");
		const { addMember } = await import("#/server/members");
		await claimSlot({ data: { slotId: seed.slotId, memberId: seed.memberId, actorMemberId: seed.memberId } });
		await setAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } });
		await addMember({ data: { clubId: seed.clubId, name: "Mike" } });

		const { listActivity } = await import("#/server/activity-feed");
		const rows = await listActivity({ data: { clubId: seed.clubId } });
		expect(rows.length).toBeGreaterThanOrEqual(3);
		expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(rows[rows.length - 1].createdAt.getTime());
		const claim = rows.find((r) => r.action === "claim");
		expect(claim?.roleName).toBeTruthy();
		expect(claim?.meetingId).toBe(seed.meetingId);
		expect(claim?.subjectName).toBeTruthy();
	});

	it("meeting filter excludes member_add (no meeting), keeps slot/availability rows", async () => {
		const { addMember } = await import("#/server/members");
		const { setAvailability } = await import("#/server/availability");
		await addMember({ data: { clubId: seed.clubId, name: "Mike" } });
		await setAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } });
		const { listActivity } = await import("#/server/activity-feed");
		const rows = await listActivity({ data: { clubId: seed.clubId, meetingId: seed.meetingId } });
		expect(rows.some((r) => r.action === "member_add")).toBe(false);
		expect(rows.some((r) => r.action === "availability_set")).toBe(true);
	});
});
```

Check the exact `SeededClub` field names (`slotId`, `meetingId`, `memberId`, `adminUserId`, the memberUserId for `cleanup`) in `src/test/db.ts` and match them. **VPE-only gate is verified separately** by Task 5's grep (the `requireClubRole(admin|vpe)` call is identical to `confirmSlot`'s, already boundary-tested in Phase B's `public-reads.integration.test.ts`) — no need for a rejection test here, which would require unmocked guards in the same file.

- [ ] **Step 2:** Run with DB → fail (module missing). **Step 3:** Implement:

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { activityLog, meetings, members, roleDefinitions, roleSlots } from "#/db/schema";
import { requireClubRole, requireUser } from "./guards"; // match the actual exported names/signatures used by confirmSlot

const listActivitySchema = z.object({
	clubId: z.string().uuid(),
	meetingId: z.string().uuid().optional(),
	actorMemberId: z.string().uuid().optional(),
	limit: z.number().int().positive().max(500).optional(),
});

export interface ActivityEntry {
	id: string;
	action: string;
	createdAt: Date;
	actorName: string | null;
	targetType: "slot" | "meeting" | "member";
	roleName: string | null;
	meetingId: string | null;
	meetingScheduledAt: Date | null;
	subjectName: string | null; // claim/reassign → new assignee; member_add → added name
	fromName: string | null; // reassign/release → displaced assignee (Task 1)
}

export const listActivity = createServerFn({ method: "GET" })
	.validator((i: unknown) => listActivitySchema.parse(i))
	.handler(async ({ data }): Promise<ActivityEntry[]> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]); // VPE-only — match confirmSlot's guard call exactly

		// Meeting filter → the set of targetIds that belong to that meeting:
		// the meeting itself (availability actions) + its slots (slot actions).
		const where = [eq(activityLog.clubId, data.clubId)];
		if (data.actorMemberId) where.push(eq(activityLog.actorMemberId, data.actorMemberId));
		if (data.meetingId) {
			const slotIds = (
				await db.select({ id: roleSlots.id }).from(roleSlots).where(eq(roleSlots.meetingId, data.meetingId))
			).map((s) => s.id);
			where.push(inArray(activityLog.targetId, [data.meetingId, ...slotIds]));
		}

		const rows = await db.select().from(activityLog).where(and(...where))
			.orderBy(desc(activityLog.createdAt)).limit(data.limit ?? 200);

		// Batch-resolve every id the rows reference.
		const memberIds = new Set<string>();
		const slotIds = new Set<string>();
		const meetingIds = new Set<string>();
		for (const r of rows) {
			if (r.actorMemberId) memberIds.add(r.actorMemberId);
			const d = (r.detail ?? {}) as { memberId?: string; fromMemberId?: string };
			if (d.memberId) memberIds.add(d.memberId);
			if (d.fromMemberId) memberIds.add(d.fromMemberId);
			if (r.targetType === "slot" && r.targetId) slotIds.add(r.targetId);
			if (r.targetType === "member" && r.targetId) memberIds.add(r.targetId);
			if (r.targetType === "meeting" && r.targetId) meetingIds.add(r.targetId);
		}

		const slotRows = slotIds.size
			? await db.select({ id: roleSlots.id, meetingId: roleSlots.meetingId, roleName: roleDefinitions.name })
				.from(roleSlots).innerJoin(roleDefinitions, eq(roleDefinitions.id, roleSlots.roleDefinitionId))
				.where(inArray(roleSlots.id, [...slotIds]))
			: [];
		for (const s of slotRows) meetingIds.add(s.meetingId);

		const memberRows = memberIds.size
			? await db.select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, [...memberIds]))
			: [];
		const meetingRows = meetingIds.size
			? await db.select({ id: meetings.id, scheduledAt: meetings.scheduledAt }).from(meetings).where(inArray(meetings.id, [...meetingIds]))
			: [];

		const memberName = new Map(memberRows.map((m) => [m.id, m.name]));
		const slotInfo = new Map(slotRows.map((s) => [s.id, s]));
		const meetingAt = new Map(meetingRows.map((m) => [m.id, m.scheduledAt]));

		return rows.map((r): ActivityEntry => {
			const d = (r.detail ?? {}) as { memberId?: string; fromMemberId?: string; name?: string };
			const slot = r.targetType === "slot" && r.targetId ? slotInfo.get(r.targetId) : undefined;
			const meetingId = slot?.meetingId ?? (r.targetType === "meeting" ? r.targetId : null);
			return {
				id: r.id,
				action: r.action,
				createdAt: r.createdAt,
				actorName: r.actorMemberId ? (memberName.get(r.actorMemberId) ?? null) : null,
				targetType: r.targetType,
				roleName: slot?.roleName ?? null,
				meetingId: meetingId ?? null,
				meetingScheduledAt: meetingId ? (meetingAt.get(meetingId) ?? null) : null,
				subjectName: d.memberId ? (memberName.get(d.memberId) ?? null) : (d.name ?? null),
				fromName: d.fromMemberId ? (memberName.get(d.fromMemberId) ?? null) : null,
			};
		});
	});
```

Verify the actual `guards.ts` exports/signatures (`requireUser`, `requireClubRole`) against how `confirmSlot` in `slots.ts` calls them, and match exactly. Verify column names (`meetings.scheduledAt`, `roleDefinitions.name`, `members.name`, `roleSlots.meetingId`/`roleDefinitionId`) against `src/db/schema.ts`.

- [ ] **Step 4:** Run with DB → pass; `bunx tsc --noEmit` → 0. **Step 5:** Commit `feat(server): listActivity enriched VPE feed`.

---

### Task 3: `activity-format.ts` — row → sentence (pure)

**Files:** Create `src/lib/activity-format.ts`; Test: `src/lib/activity-format.test.ts`

- [ ] **Step 1 (failing test):** unit-test the formatter for each action. It takes an `ActivityEntry` and returns `{ actor: string; summary: string }` (actor name + a human phrase). No DB, no React.

```ts
import { describe, expect, it } from "vitest";
import { formatActivity } from "./activity-format";
import type { ActivityEntry } from "#/server/activity-feed";

const base = { id: "1", createdAt: new Date(), targetType: "slot", roleName: "Timer", meetingId: "m", meetingScheduledAt: new Date(), fromName: null, subjectName: null } as const;

describe("formatActivity", () => {
	it("claim", () => {
		const e = { ...base, action: "claim", actorName: "Faisal", subjectName: "Faisal" } as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/claimed Timer/i);
	});
	it("reassign shows from → to", () => {
		const e = { ...base, action: "reassign", actorName: "Rasheed", fromName: "Schinthia", subjectName: "Mahbuba" } as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/Schinthia.*→.*Mahbuba/);
	});
	it("release shows displaced person", () => {
		const e = { ...base, action: "release", actorName: "Mahbuba", fromName: "Mahbuba" } as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/released Timer/i);
	});
	it("member_add", () => {
		const e = { ...base, action: "member_add", targetType: "member", roleName: null, actorName: "Mike", subjectName: "Mike" } as unknown as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/added.*Mike/i);
	});
	it("availability_set", () => {
		const e = { ...base, action: "availability_set", targetType: "meeting", roleName: null, actorName: "Faisal" } as unknown as ActivityEntry;
		expect(formatActivity(e).summary).toMatch(/can't make|unavailable/i);
	});
});
```

- [ ] **Step 2:** fail. **Step 3:** Implement `formatActivity(entry): { actor: string; summary: string }` with a `switch (entry.action)`:
  - `claim` → `claimed ${roleName}` (append ` (confirmed)` only if you choose to read detail; not required).
  - `release` → `released ${roleName}`.
  - `reassign` → `reassigned ${roleName}: ${fromName ?? "someone"} → ${subjectName ?? "someone"}`.
  - `availability_set` → `marked themselves unavailable`.
  - `availability_clear` → `marked themselves available`.
  - `member_add` → `added member "${subjectName}"`.
  - default → the raw action string (forward-compatible with future enum values).
  `actor` = `entry.actorName ?? "Someone"`. Keep it pure; no date formatting here (the route formats `createdAt`/`meetingScheduledAt` with `src/lib/format.ts`).
- [ ] **Step 4:** pass; tsc 0. **Step 5:** Commit `feat(lib): activity entry sentence formatter`.

---

### Task 4: `_authed/activity.tsx` — the feed UI

**Files:** Create `src/routes/_authed/activity.tsx`

- [ ] **Step 1:** Implement. Read an existing `_authed/*` route (e.g. `_authed/me.tsx` or `_authed/dashboard.tsx`) for the workspace shell/layout conventions, how `clubId` is obtained (auth context / route context), and the card/list styling.
  - **Route:** `createFileRoute("/_authed/activity")`. Loader: resolve the current club id the same way sibling authed routes do, then `listActivity({ data: { clubId } })`. (If sibling routes get `clubId` from a shared context/loader, reuse that; do not invent a new mechanism.)
  - **Filters:** two dropdowns — **meeting** (options from `listUpcomingMeetings` or the club's meetings; include an "All" option) and **member** (options from `listClubMembers`/`listMembers`; "All"). Selecting re-runs `listActivity` with `meetingId`/`actorMemberId` (use TanStack Query keyed on the filters, or `router.invalidate` with search params — match how other authed routes do filtering; simplest is `useQuery` with the filter state in the key).
  - **Feed:** reverse-chron list. Each entry: actor (bold) + `formatActivity(entry).summary`, a relative/explicit timestamp (`createdAt` via `src/lib/format.ts`), and the meeting context (`meetingScheduledAt` formatted) when present. Group-by-day headers are optional polish — only if cheap. Empty state ("No activity yet.").
  - VPE-only is enforced server-side by `listActivity`; the route already lives under `_authed`.
  - **Navigation:** add an entry point to this route from the workspace nav if there's an obvious nav list (check `_authed/index.tsx`/dashboard). If adding a nav item is non-trivial or unclear, leave it and report — the route is reachable by URL regardless.
- [ ] **Step 2:** `bun run build` (registers the route + typechecks SSR) → succeeds; confirm `/_authed/activity` in `routeTree.gen.ts`. `bunx tsc --noEmit` → 0. `bun run check` → 0 in new files.
- [ ] **Step 3:** Commit `feat(workspace): VPE activity log view`.

---

### Task 5: Full green + boundary checks

- [ ] **Step 1:** `bunx vitest run` (no DB) → unit tests (formatter) pass, integration skipped. `TEST_DATABASE_URL=… bunx vitest run` → all pass. `bun run check` → 0. `bun run build` → 0.
- [ ] **Step 2:** `grep -n "requireUser\|requireClubRole" src/server/activity-feed.ts` → both present (authed VPE-only). Confirm `listActivity` is NOT imported by any public/member route (`grep -rn listActivity src/routes` → only under `_authed/`).
- [ ] **Step 3:** Commit any fixups.

---

## Self-review (against the spec)

- **§8 read-only feed, reverse-chron, filterable by meeting/member:** Task 2 (`listActivity` + filters) + Task 4 (UI). ✓ No write/undo path added (read-only honored). ✓
- **"actor · what changed":** Task 3 formatter resolves actor + a human summary; Task 2 resolves the ids. ✓
- **before→after ("Schinthia → empty"):** Task 1 captures the displaced assignee; Task 3 renders `from → to` for reassign and the displaced person for release. ✓ (Pre-Task-1 historical rows simply have `fromName: null` → "someone"/omitted — acceptable, the log is forward-looking.)
- **VPE-only:** `listActivity` is authed + `requireClubRole(admin|vpe)` (Task 2, grep in Task 5). ✓
- **Placeholder scan:** every fn/test has real code or a precise read-this-sibling instruction; no TODOs.
- **Type consistency:** `ActivityEntry` defined in Task 2 is the exact shape consumed by Task 3's formatter and Task 4's UI. `detail` shapes (`{ memberId, fromMemberId, name }`) match the Task-1 writes and the confirmed existing writes.

## STOP conditions
- (Resolved) Authed fns can't get a real session in integration tests — Task 2 uses `vi.mock("#/server/guards")` to stub auth and exercise the real DB enrichment. If that mock somehow doesn't isolate (e.g. the real guard still runs), STOP and report.
- If `requireClubRole`'s real signature differs from the assumed `(userId, clubId, roles[])`, adapt to the real one (match `confirmSlot`) — if it can't express "admin or vpe", STOP and report.
- If obtaining `clubId` in an `_authed` route requires a mechanism that doesn't exist in sibling routes, STOP and report rather than inventing one.

## Maintenance notes
- New `activity_action` enum values render via the formatter's `default` branch (raw action) until a case is added — safe, not pretty.
- Meeting filtering resolves slot→meeting at query time; fine at club scale (hundreds of rows). If the log grows huge, add a denormalized `meeting_id` column to `activity_log` and index it.
- When roster merge/dedupe lands (next step), it will emit `member_merge`/`member_edit`/`member_remove` — add formatter cases then.
