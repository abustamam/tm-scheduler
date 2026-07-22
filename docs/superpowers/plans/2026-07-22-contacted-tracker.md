# Contacted Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a VPE/President record who they've reached out to about filling a role at a given meeting — a single per-(member, meeting) "contacted" boolean — surfaced in the meeting-agenda view, the nudge picker (auto-marks on nudge), and the season grid.

**Architecture:** A new `meeting_outreach` table is a near-clone of `member_availability` (presence of a row = "contacted"). Two admin-only server fns (`setContacted`/`clearContacted`) mirror `src/server/availability.ts`. The contacted set is read into two existing loaders (`loadSeasonGrid`, `getMeeting`) **only for admin viewers**, and three existing UI surfaces render/toggle it. Role assignment is the implicit "contacted about a role" signal, so the flag only tracks people who were asked but aren't assigned yet.

**Tech Stack:** TanStack Start (React 19) · Drizzle ORM + PostgreSQL (`pg`) · TanStack Query · shadcn/ui + Tailwind v4 · Biome · Vitest · Bun.

**Spec:** `docs/superpowers/specs/2026-07-22-contacted-tracker-design.md` · **Issue:** [#340](https://github.com/abustamam/tm-scheduler/issues/340)

**Working directory:** the `feat/contacted-tracker` worktree at `/media/rasheed-bustamam/Extra/coding/tm-scheduler-contacted`. All paths below are relative to it.

---

## File Structure

**Create:**
- `src/server/outreach.ts` — `setContacted` / `clearContacted` server fns (module exports ONLY server fns + types, per `server-modules.guard.test.ts`).
- `src/server/outreach.integration.test.ts` — DB-backed tests mirroring `availability.integration.test.ts`.
- `src/components/club/outreach-panel.tsx` — the meeting-view "Outreach" panel (pure props; unit-testable).
- `src/components/club/outreach-panel.test.tsx` — panel derivation/render tests.
- `drizzle/00NN_*.sql` (+ snapshot/journal) — generated migration for the new table + enum values.

**Modify:**
- `src/db/schema.ts` — add `meetingOutreach` table + relations; add `"outreach_set"`/`"outreach_clear"` to `activityActionEnum`.
- `src/lib/activity-format.ts` — render the two new actions.
- `src/lib/activity-format.test.ts` — cover the two new actions.
- `src/server/season-grid-logic.ts` — `includeOutreach` flag → `contacted` on `SeasonGridData`.
- `src/server/season-grid.ts` — pass `includeOutreach: <isAdmin>` in the authed loader.
- `src/lib/season-grid-view.ts` — `contacted` on `ViewCell`; set it on `free` member cells.
- `src/components/club/grid-cell.tsx` — render a contacted dot on `free` cells.
- `src/server/meetings.ts` — `getMeeting` returns `contactedMemberIds` (admin-only).
- `src/components/club/nudge-buttons.tsx` — optional `onContacted` callback fired on nudge tap.
- `src/components/club/nudge-recruit-picker.tsx` — annotate targets with `contacted`; manual toggle + auto-mark wiring.
- `src/routes/_authed/meetings.$id.tsx` — wire `setContacted`/`clearContacted` actions + pass `contactedMemberIds` and render `<OutreachPanel>`.
- `src/components/agenda/meeting-agenda.tsx` — new props (`contactedMemberIds`, `onContacted`, `onUncontacted`), thread into recruit targets, render `<OutreachPanel>` under `canManage`.

---

## Conventions the executor MUST follow

- **Package manager is Bun.** `bun run <script>`. Tests use **Vitest** (`bunx vitest run <path>`), NOT `bun test`.
- **Only `bun run typecheck` type-checks.** `build`/`test` transpile without checking. Run it before claiming green.
- **Biome formats with tabs + double quotes** (`bun run check`).
- **Import alias `#/*` → `src/*`.**
- **Never hand-edit `src/routeTree.gen.ts`.**
- **Integration tests need a DB.** They `describe.skipIf(!hasTestDb)`, so they silently pass (skip) with no DB. To actually run them, sync + point at the test DB:
  ```bash
  # one-time after the schema change lands (Task 1), re-run whenever schema changes:
  DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force
  # then run integration suites with:
  TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run <path>
  ```
  (The dev Postgres is the running `dev-postgres` Docker container; `tm_test` is push-synced — never `db:migrate` it. Confirm the exact `tm_test` URL/creds from `.env.local` / the container before running.)
- **Commit after every task** with a `feat(outreach):` / `test(outreach):` message. End each commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

---

## Task 0: Worktree preflight

**Files:** none (environment only).

- [ ] **Step 1: Install deps + env in the worktree**

A fresh git worktree has no `node_modules` and no `.env.local`. Copy env from the main checkout and install:

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-contacted
cp /media/rasheed-bustamam/Extra/coding/tm-scheduler/.env.local .env.local
bun install
```

- [ ] **Step 2: Establish a green baseline**

Run: `bun run typecheck && bun run check`
Expected: both pass (this is pre-existing `main`; the spec commit added only a markdown file).

Run: `bunx vitest run src/lib/activity-format.test.ts`
Expected: PASS (a fast pure suite — confirms Vitest works in the worktree).

---

## Task 1: Schema — `meeting_outreach` table + enum values

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated): `drizzle/00NN_*.sql` + snapshot + journal

- [ ] **Step 1: Add the two activity-action enum values**

In `src/db/schema.ts`, extend `activityActionEnum` (currently ends `"superadmin_viewed", "superadmin_acted",`). Add two values before the closing `]`:

```ts
export const activityActionEnum = pgEnum("activity_action", [
	"claim",
	"release",
	"reassign",
	"availability_set",
	"availability_clear",
	"member_add",
	"member_edit",
	"member_merge",
	"member_remove",
	"meeting_create",
	"meeting_edit",
	"superadmin_viewed",
	"superadmin_acted",
	// Officer outreach tracking (#340): a member was marked "contacted" for a
	// meeting (or the mark was cleared). `detail = { memberId, via }`.
	"outreach_set",
	"outreach_clear",
]);
```

- [ ] **Step 2: Add the `meetingOutreach` table**

Add immediately AFTER the `memberAvailability` table block (it is the direct analog). Presence of a row = "contacted".

```ts
// ---------------------------------------------------------------------------
// Meeting outreach (#340) — the officer's private "contacted" record. Presence
// of a row = "this member was contacted about filling a role for this meeting".
// A near-clone of member_availability: per-(member, meeting), one row per pair,
// cascade on member/meeting delete. WHO marked it and HOW (nudge vs. manual)
// live in activity_log.detail, not on the row — the row is a pure boolean.
// Admin/VPE-only to read and write (never surfaced to members or the public).
// ---------------------------------------------------------------------------

export const meetingOutreach = pgTable(
	"meeting_outreach",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		// = "contacted at". No separate contactedAt column.
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// Presence of a row = "contacted"; one per (member, meeting). Plain unique
		// index so ON CONFLICT can infer it (idempotent mark).
		uniqueIndex("meeting_outreach_unique").on(t.memberId, t.meetingId),
		index("meeting_outreach_meeting_idx").on(t.meetingId),
	],
);
```

- [ ] **Step 3: Add relations**

After the table, add relations mirroring `memberAvailability` (which has none defined, but add these for symmetry with other join tables — optional but harmless). Place near the other `*Relations` blocks:

```ts
export const meetingOutreachRelations = relations(meetingOutreach, ({ one }) => ({
	member: one(members, {
		fields: [meetingOutreach.memberId],
		references: [members.id],
	}),
	meeting: one(meetings, {
		fields: [meetingOutreach.meetingId],
		references: [meetings.id],
	}),
}));
```

- [ ] **Step 4: Generate the migration**

Run: `bun run db:generate`
Expected: a new `drizzle/00NN_*.sql` creating `meeting_outreach` (with FKs, unique index, meeting index) and `ALTER TYPE "public"."activity_action" ADD VALUE "outreach_set"` / `"outreach_clear"`. Open the generated `.sql` and confirm it contains those statements and nothing unrelated.

- [ ] **Step 5: Apply to the dev DB**

Run: `bun run db:migrate`
Expected: applies cleanly, no error.

- [ ] **Step 6: Sync the test DB (needed for later integration tasks)**

Run: `DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force`
Expected: pushes the new table + enum values to `tm_test`. (Confirm the real `tm_test` URL from `.env.local` first.)

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(outreach): add meeting_outreach table + outreach activity actions (#340)

$(printf 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Server — `setContacted` / `clearContacted`

**Files:**
- Create: `src/server/outreach.ts`
- Create: `src/server/outreach.integration.test.ts`

The write is **admin/VPE-only** — the actor is derived from the guard's returned membership, never trusted from the client. Mirrors `src/server/availability.ts` structurally but swaps the self-serve `requireMemberInClub`-only guard for `requireClubRole(..., ["admin"])`.

- [ ] **Step 1: Write the integration test (failing)**

Create `src/server/outreach.integration.test.ts`. Like `availability.integration.test.ts`, it **replicates the DB logic** against `testDb` (you cannot call a `createServerFn` in a unit test). `seedClub()` from `#/test/db` provides `clubId`, `meetingId`, `memberId`, `adminMemberId`, `adminUserId`, `memberUserId`.

```ts
/**
 * DB-backed integration tests for the meeting_outreach write logic (#340).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/outreach.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog, meetingOutreach } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

// Replicate setContacted's db effect (insert + log), attributed to the officer.
async function setContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
	via: "nudge" | "manual";
}) {
	await testDb
		.insert(meetingOutreach)
		.values({ memberId: args.memberId, meetingId: args.meetingId })
		.onConflictDoNothing();
	await testDb.insert(activityLog).values({
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "outreach_set",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId, via: args.via },
	});
	return { ok: true as const };
}

async function clearContactedDb(args: {
	memberId: string;
	meetingId: string;
	clubId: string;
	actorMemberId: string;
}) {
	await testDb
		.delete(meetingOutreach)
		.where(
			and(
				eq(meetingOutreach.memberId, args.memberId),
				eq(meetingOutreach.meetingId, args.meetingId),
			),
		);
	await testDb.insert(activityLog).values({
		clubId: args.clubId,
		actorMemberId: args.actorMemberId,
		action: "outreach_clear",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { memberId: args.memberId },
	});
	return { ok: true as const };
}

describe.skipIf(!hasTestDb)("meeting outreach (set + clear)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("setContacted inserts a row and logs outreach_set attributed to the officer with the subject + via in detail", async () => {
		await setContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "nudge",
		});

		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(1);

		const [log] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "outreach_set"),
				),
			)
			.limit(1);
		expect(log?.actorMemberId).toBe(seed.adminMemberId);
		expect((log?.detail as { memberId?: string })?.memberId).toBe(seed.memberId);
		expect((log?.detail as { via?: string })?.via).toBe("nudge");
	});

	it("setContacted is idempotent (onConflictDoNothing → one row)", async () => {
		const args = {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "manual" as const,
		};
		await setContactedDb(args);
		await expect(setContactedDb(args)).resolves.toEqual({ ok: true });
		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(1);
	});

	it("clearContacted removes the row and logs outreach_clear", async () => {
		await setContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			via: "manual",
		});
		await clearContactedDb({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
		});
		const rows = await testDb
			.select()
			.from(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, seed.memberId),
					eq(meetingOutreach.meetingId, seed.meetingId),
				),
			);
		expect(rows).toHaveLength(0);
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, seed.meetingId),
					eq(activityLog.action, "outreach_clear"),
				),
			);
		expect(log.length).toBeGreaterThan(0);
	});

	it("clearContacted on a non-existent row is a no-op (no throw)", async () => {
		await expect(
			clearContactedDb({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				actorMemberId: seed.adminMemberId,
			}),
		).resolves.toEqual({ ok: true });
	});
});
```

- [ ] **Step 2: Run it — expect PASS if the test DB is synced, or SKIP otherwise**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/outreach.integration.test.ts`
Expected: PASS (4 tests). If you see "skipped", `hasTestDb` is false — fix `TEST_DATABASE_URL` and that Task 1 Step 6 push ran; do not proceed while skipped.

- [ ] **Step 3: Write `src/server/outreach.ts`**

This module exports ONLY server fns (guard test enforces it). Actor is derived from `requireClubRole`; a `read_write` impersonating superadmin resolves to `membership.id === null` and `logActivity` picks up the impersonation marker automatically.

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetingOutreach, meetings } from "#/db/schema";
import { logActivity } from "./activity";
import { requireClubRole, requireMemberInClub, requireUser } from "./guards";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

/** Load a meeting's status (for the ADR-0012 lock) or throw if missing. */
async function meetingStatus(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.status;
}

const contactedSchema = z.object({
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	clubId: z.string().uuid(),
	/** How the ask happened. Recorded in activity_log.detail only. */
	via: z.enum(["nudge", "manual"]).default("manual"),
});

/**
 * Mark a member "contacted" for a meeting (#340). Admin/VPE-only officer record
 * (unlike the self-serve setAvailability). Presence of the row = contacted;
 * idempotent via onConflictDoNothing. The actor is the resolved officer
 * membership — never trusted from the client.
 */
export const setContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		assertMeetingNotLocked(await meetingStatus(data.meetingId));
		await requireMemberInClub(data.memberId, data.clubId);

		await db
			.insert(meetingOutreach)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();

		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: membership.id,
			action: "outreach_set",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId, via: data.via },
		});

		return { ok: true as const };
	});

/** Clear a member's "contacted" mark for a meeting (#340). Admin/VPE-only. */
export const clearContacted = createServerFn({ method: "POST" })
	.validator((i: unknown) => contactedSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		assertMeetingNotLocked(await meetingStatus(data.meetingId));

		await db
			.delete(meetingOutreach)
			.where(
				and(
					eq(meetingOutreach.memberId, data.memberId),
					eq(meetingOutreach.meetingId, data.meetingId),
				),
			);

		await logActivity(db, {
			clubId: data.clubId,
			actorMemberId: membership.id,
			action: "outreach_clear",
			targetType: "meeting",
			targetId: data.meetingId,
			detail: { memberId: data.memberId },
		});

		return { ok: true as const };
	});
```

- [ ] **Step 4: Confirm the guard test still passes (no `pg` leak)**

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS — `outreach.ts` exports only `createServerFn`s, so it's allowed.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.

```bash
git add src/server/outreach.ts src/server/outreach.integration.test.ts
git commit -m "feat(outreach): setContacted/clearContacted admin-only server fns (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Activity feed rendering

**Files:**
- Modify: `src/lib/activity-format.ts`
- Modify: `src/lib/activity-format.test.ts`

- [ ] **Step 1: Add the failing test cases**

In `src/lib/activity-format.test.ts`, add cases mirroring the `availability_set`/`availability_clear` tests (search that file for `availability_set` to match its `entry` fixture shape). The subject name comes from `entry.subjectName`:

```ts
it("formats outreach_set as contacting the subject", () => {
	const result = formatActivity({
		// ...same base fixture the availability tests use...
		action: "outreach_set",
		actorName: "Val VPE",
		subjectName: "Bob",
	} as never);
	expect(result.summary).toBe("marked Bob contacted");
});

it("formats outreach_clear as un-contacting the subject", () => {
	const result = formatActivity({
		action: "outreach_clear",
		actorName: "Val VPE",
		subjectName: "Bob",
	} as never);
	expect(result.summary).toBe("un-marked Bob as contacted");
});
```

(Match the exact fixture object the neighboring `availability_*` tests build — copy one and change `action`/`subjectName`. Replace the `as never` with the real fixture type if the file uses one.)

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run src/lib/activity-format.test.ts`
Expected: FAIL — the two new summaries fall through to `default: summary = entry.action` (`"outreach_set"`).

- [ ] **Step 3: Add the cases to `formatActivity`**

In `src/lib/activity-format.ts`, add before the `default:` case (these are always officer-on-subject, so no "themselves" branch is needed):

```ts
		case "outreach_set":
			summary = `marked ${entry.subjectName ?? "someone"} contacted`;
			break;
		case "outreach_clear":
			summary = `un-marked ${entry.subjectName ?? "someone"} as contacted`;
			break;
```

- [ ] **Step 4: Run — expect PASS**

Run: `bunx vitest run src/lib/activity-format.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the activity feed passes `subjectName` for these actions**

`detail.memberId` is the subject. Search `src/server/activity-feed-logic.ts` for how `availability_set` resolves `subjectName` from `detail.memberId` and confirm the same path applies to `outreach_set`/`outreach_clear` (they use the identical `detail = { memberId }` shape, so it should already resolve — verify, and if it switches on `action`, add the two actions to that branch). No behavior change if it's action-agnostic.

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` → PASS.

```bash
git add src/lib/activity-format.ts src/lib/activity-format.test.ts src/server/activity-feed-logic.ts
git commit -m "feat(outreach): render outreach_set/clear in the activity feed (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Season-grid read — admin-only `contacted` set

**Files:**
- Modify: `src/server/season-grid-logic.ts`
- Modify: `src/server/season-grid.ts`
- Modify: `src/server/season-grid.integration.test.ts`

- [ ] **Step 1: Extend `SeasonGridData` + `loadSeasonGrid`**

In `src/server/season-grid-logic.ts`:

(a) Import the table — add `meetingOutreach` to the existing `#/db/schema` import list.

(b) Add to the `SeasonGridData` interface, right after the `unavailable` line:

```ts
	/** Members contacted about each meeting (#340). Admin-only: populated only
	 *  when loadSeasonGrid is called with includeOutreach; empty otherwise, so it
	 *  never reaches members or the public sheet. */
	contacted: { memberId: string; meetingId: string }[];
```

(c) Add an `includeOutreach` param to `loadSeasonGrid`'s input (next to `includeContact`):

```ts
	/** Include the per-(member, meeting) "contacted" set. Admin-only; off by
	 *  default so members / the public sheet never receive it. */
	includeOutreach?: boolean;
```

(d) After the `unavailable = …` query block, add (mirrors that query, gated on the flag):

```ts
	const contacted =
		input.includeOutreach && meetingIds.length
			? await db
					.select({
						memberId: meetingOutreach.memberId,
						meetingId: meetingOutreach.meetingId,
					})
					.from(meetingOutreach)
					.where(inArray(meetingOutreach.meetingId, meetingIds))
			: [];
```

(e) Add `contacted` to BOTH returned objects — the main `return { … }` at the end of `loadSeasonGrid`. (`loadPublicSeasonGrid` calls `loadSeasonGrid` without `includeOutreach`, so it returns `[]` automatically — no change needed there beyond the type now requiring the field, which the shared return supplies.)

- [ ] **Step 2: Gate the flag on admin in the authed loader**

In `src/server/season-grid.ts`, the authed `getSeasonGrid` currently does `requireClubViewAccess` then `loadSeasonGrid({ ...data, includeContact: true })`. Add an admin check and pass the flag. Import `canManageClub` from `./guards`:

```ts
export const getSeasonGrid = createServerFn({ method: "GET" })
	.validator((input: unknown) => seasonGridInput.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubViewAccess(user.id, data.clubId);
		const isAdmin = await canManageClub(user.id, data.clubId);
		return loadSeasonGrid({
			...data,
			includeContact: true,
			includeOutreach: isAdmin,
		});
	});
```

Leave `getPublicSeasonGrid` untouched — it must never carry outreach.

- [ ] **Step 3: Add an integration assertion**

In `src/server/season-grid.integration.test.ts`, add a test that `loadSeasonGrid({ …, includeOutreach: true })` returns a `contacted` entry after a row is inserted, and that WITHOUT the flag `contacted` is `[]`. Follow the file's existing seeding pattern (it imports `loadSeasonGrid` from `#/server/season-grid-logic` and uses a seeded club). Insert a `meetingOutreach` row via `testDb`, then:

```ts
it("includes the contacted set only when includeOutreach is set", async () => {
	const { loadSeasonGrid } = await import("#/server/season-grid-logic");
	// ...seed a club + meeting + member (match this file's helpers)...
	await testDb
		.insert(meetingOutreach)
		.values({ memberId: seed.memberId, meetingId: seed.meetingId })
		.onConflictDoNothing();

	const withFlag = await loadSeasonGrid({
		clubId: seed.clubId,
		count: 8,
		includeOutreach: true,
	});
	expect(withFlag.contacted).toContainEqual({
		memberId: seed.memberId,
		meetingId: seed.meetingId,
	});

	const withoutFlag = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
	expect(withoutFlag.contacted).toEqual([]);
});
```

Add `meetingOutreach` to the test file's `#/db/schema` import.

- [ ] **Step 4: Run integration + typecheck**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/season-grid.integration.test.ts`
Expected: PASS.
Run: `bun run typecheck` → PASS. **Note:** adding a required `contacted` field to `SeasonGridData` will surface type errors anywhere a `SeasonGridData` literal is built in test fixtures (e.g. `season-grid-view.test.ts`, `member-role-picker.test.ts`, `grid-cell.test.tsx` fixtures). Fix each by adding `contacted: []` to the fixture. This is expected fallout — resolve it here.

- [ ] **Step 5: Commit**

```bash
git add src/server/season-grid-logic.ts src/server/season-grid.ts src/server/season-grid.integration.test.ts src/lib/season-grid-view.test.ts src/lib/member-role-picker.test.ts src/components/club/grid-cell.test.tsx
git commit -m "feat(outreach): admin-only contacted set on the season grid payload (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Meeting payload — `contactedMemberIds` (admin-only)

**Files:**
- Modify: `src/server/meetings.ts`

- [ ] **Step 1: Query contacted ids under `canManage`**

In `src/server/meetings.ts`, `getMeeting` already computes `canManage` and does `roster = canManage ? await loadRosterWithContact(...) : []`. Near that block (after `unavailableMembers` is built), add a `meetingOutreach` import to the `#/db/schema` import list, then:

```ts
	// Contacted-for-this-meeting member ids (#340). Admin-only — same gate as the
	// roster; empty on the public/member view so it never leaks who was asked.
	const contactedRows = canManage
		? await db
				.select({ memberId: meetingOutreach.memberId })
				.from(meetingOutreach)
				.where(eq(meetingOutreach.meetingId, meetingId))
		: [];
	const contactedMemberIds = contactedRows.map((r) => r.memberId);
```

- [ ] **Step 2: Return it**

Add `contactedMemberIds,` to the main `return { … }` object of `getMeeting` (the one that also returns `unavailableMemberIds`, `roster`, `slots`). Do NOT add it to the early `!canManage` return branches that hardcode `canManage: false` — but if a shared return object is used, `contactedMemberIds` will be `[]` there, which is correct.

- [ ] **Step 3: Typecheck + commit**

Run: `bun run typecheck` → PASS. (`AgendaSlot`/meeting-agenda derive their types from `getMeeting`'s return; a new field is additive.)

```bash
git add src/server/meetings.ts
git commit -m "feat(outreach): getMeeting returns admin-only contactedMemberIds (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Nudge picker — annotate + auto-mark on nudge

**Files:**
- Modify: `src/components/club/nudge-buttons.tsx`
- Modify: `src/components/club/nudge-recruit-picker.tsx`
- Modify: `src/components/club/nudge-recruit-picker.test.tsx`

- [ ] **Step 1: Add an `onContacted` callback to `NudgeButtons`**

In `src/components/club/nudge-buttons.tsx`, add an optional prop and fire it when either channel anchor is tapped (fire-and-forget; do NOT `preventDefault` — the link must still open WhatsApp/mail).

Add to the props type: `onContacted?: () => void;`

Add `onClick={onContacted}` to BOTH anchors, e.g.:

```tsx
	<a
		href={nudge.whatsappUrl}
		target="_blank"
		rel="noopener noreferrer"
		onClick={onContacted}
	>
```
and
```tsx
	<a href={nudge.mailtoUrl} onClick={onContacted}>
```

(`onClick={undefined}` is a no-op when the prop is absent, so the existing `mode="confirm"` usage is unaffected.)

- [ ] **Step 2: Add a failing test for the annotated target + toggle**

In `src/components/club/nudge-recruit-picker.test.tsx`, extend `buildRecruitTargets` coverage. First update `buildRecruitTargets`'s signature expectation: it will take a `contactedIds` set and set `contacted` on each target.

```ts
it("flags contacted members", () => {
	const targets = buildRecruitTargets(
		[{ id: "m1", name: "Alice" }, { id: "m2", name: "Bob" }],
		new Set<string>(), // unavailable
		{}, // roleByMemberId
		new Set(["m1"]), // contactedIds
	);
	expect(targets.find((t) => t.id === "m1")?.contacted).toBe(true);
	expect(targets.find((t) => t.id === "m2")?.contacted).toBe(false);
});
```

- [ ] **Step 3: Run — expect FAIL** (`buildRecruitTargets` takes 3 args, `contacted` undefined)

Run: `bunx vitest run src/components/club/nudge-recruit-picker.test.tsx`
Expected: FAIL (arity / property).

- [ ] **Step 4: Implement annotation + toggle in the picker**

In `src/components/club/nudge-recruit-picker.tsx`:

(a) Add `contacted: boolean;` to the `RecruitTarget` interface.

(b) Add a 4th param to `buildRecruitTargets` and set the flag:

```ts
export function buildRecruitTargets(
	roster: {
		id: string;
		name: string;
		phone?: string | null;
		email?: string | null;
	}[],
	unavailableIds: ReadonlySet<string>,
	roleByMemberId: Readonly<Record<string, string>>,
	contactedIds: ReadonlySet<string>,
): RecruitTarget[] {
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		phone: m.phone ?? null,
		email: m.email ?? null,
		notAvailable: unavailableIds.has(m.id),
		alreadyRole: roleByMemberId[m.id] ?? null,
		contacted: contactedIds.has(m.id),
	}));
}
```

(c) Add two optional callbacks to `NudgeRecruitPicker`'s props: `onContacted?: (memberId: string) => void;` and `onUncontacted?: (memberId: string) => void;`.

(d) In the picked-member detail view (where `<NudgeButtons>` renders), pass `onContacted={() => onContacted?.(picked.id)}` to it, and add a manual toggle row below the buttons:

```tsx
	<NudgeButtons
		name={picked.name}
		phone={picked.phone}
		email={picked.email}
		roleName={roleName}
		meetingDate={meetingDate}
		shareUrl={shareUrl}
		mode="recruit"
		onContacted={() => onContacted?.(picked.id)}
	/>
	<label className="flex items-center gap-2 text-xs">
		<input
			type="checkbox"
			checked={picked.contacted}
			onChange={(e) =>
				e.target.checked ? onContacted?.(picked.id) : onUncontacted?.(picked.id)
			}
		/>
		Contacted
	</label>
```

(e) In the list `CommandItem`, add a "Contacted" annotation next to the existing `notAvailable` / `alreadyRole` chips:

```tsx
	{t.contacted ? (
		<span className="ml-2 text-xs text-[var(--success-strong)]">
			Contacted
		</span>
	) : null}
```

- [ ] **Step 5: Run — expect PASS**

Run: `bunx vitest run src/components/club/nudge-recruit-picker.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` — expect FAILURE at the `meeting-agenda.tsx` call site of `buildRecruitTargets` (still 3 args). That's wired in Task 7; do the commit now (the picker + test are self-consistent, the call-site fix is the next task) OR proceed straight into Task 7 and commit together. Recommended: proceed to Task 7, then commit both.

```bash
# (commit after Task 7 so typecheck is green)
```

---

## Task 7: Meeting-agenda view — Outreach panel + wiring

**Files:**
- Create: `src/components/club/outreach-panel.tsx`
- Create: `src/components/club/outreach-panel.test.tsx`
- Modify: `src/components/agenda/meeting-agenda.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Write the panel derivation test (failing)**

`src/components/club/outreach-panel.test.tsx` — test the pure helper that splits the roster into "still to ask" vs "contacted", excluding assigned members.

```ts
import { describe, expect, it } from "vitest";
import { deriveOutreach } from "./outreach-panel";

describe("deriveOutreach", () => {
	const roster = [
		{ id: "a", name: "Alice" },
		{ id: "b", name: "Bob" },
		{ id: "c", name: "Carol" },
		{ id: "d", name: "Dan" },
	];

	it("buckets members: assigned excluded, contacted vs not", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["b"]),
		});
		expect(r.assignedCount).toBe(1);
		expect(r.contacted.map((m) => m.id)).toEqual(["b"]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["c", "d"]);
	});

	it("an assigned member is never listed even if also contacted", () => {
		const r = deriveOutreach({
			roster,
			assignedIds: new Set(["a"]),
			contactedIds: new Set(["a"]),
		});
		expect(r.contacted).toEqual([]);
		expect(r.notContacted.map((m) => m.id)).toEqual(["b", "c", "d"]);
	});
});
```

- [ ] **Step 2: Run — expect FAIL** (module/function missing)

Run: `bunx vitest run src/components/club/outreach-panel.test.tsx`
Expected: FAIL — "deriveOutreach is not defined".

- [ ] **Step 3: Write `src/components/club/outreach-panel.tsx`**

```tsx
export interface OutreachMember {
	id: string;
	name: string;
}

export interface OutreachBuckets {
	assignedCount: number;
	contacted: OutreachMember[];
	notContacted: OutreachMember[];
}

/**
 * Split the active roster into outreach buckets (#340). Assigned members are
 * implicitly "contacted about a role" and are excluded from both lists — the
 * panel only tracks the gap (asked-but-not-assigned + still-to-ask). Pure.
 */
export function deriveOutreach(input: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
}): OutreachBuckets {
	const contacted: OutreachMember[] = [];
	const notContacted: OutreachMember[] = [];
	let assignedCount = 0;
	for (const m of input.roster) {
		if (input.assignedIds.has(m.id)) {
			assignedCount++;
			continue;
		}
		(input.contactedIds.has(m.id) ? contacted : notContacted).push(m);
	}
	return { assignedCount, contacted, notContacted };
}

/**
 * Officer-only "Outreach" panel on the meeting view (#340). Lists active members
 * who aren't assigned, split into contacted / still-to-ask, each with a toggle.
 * Rendered by <MeetingAgenda> only under `viewer.canManage`.
 */
export function OutreachPanel({
	roster,
	assignedIds,
	contactedIds,
	busy = false,
	onContacted,
	onUncontacted,
}: {
	roster: OutreachMember[];
	assignedIds: ReadonlySet<string>;
	contactedIds: ReadonlySet<string>;
	busy?: boolean;
	onContacted: (memberId: string) => void;
	onUncontacted: (memberId: string) => void;
}) {
	const { assignedCount, contacted, notContacted } = deriveOutreach({
		roster,
		assignedIds,
		contactedIds,
	});

	function Row({ m, isContacted }: { m: OutreachMember; isContacted: boolean }) {
		return (
			<label className="flex items-center gap-2 py-1 text-sm">
				<input
					type="checkbox"
					checked={isContacted}
					disabled={busy}
					onChange={(e) =>
						e.target.checked ? onContacted(m.id) : onUncontacted(m.id)
					}
				/>
				<span className="flex-1 truncate">{m.name}</span>
			</label>
		);
	}

	return (
		<section className="rounded-lg border border-border p-3">
			<div className="mb-2 flex items-baseline justify-between">
				<h3 className="text-sm font-semibold">Outreach</h3>
				<span className="text-xs text-[var(--sea-ink-soft)]">
					{assignedCount} assigned · {contacted.length} contacted ·{" "}
					{notContacted.length} to ask
				</span>
			</div>
			{contacted.map((m) => (
				<Row key={m.id} m={m} isContacted />
			))}
			{notContacted.map((m) => (
				<Row key={m.id} m={m} isContacted={false} />
			))}
			{contacted.length === 0 && notContacted.length === 0 ? (
				<p className="text-xs text-[var(--sea-ink-soft)]">
					Everyone active is assigned.
				</p>
			) : null}
		</section>
	);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bunx vitest run src/components/club/outreach-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add props to `<MeetingAgenda>` and thread them**

In `src/components/agenda/meeting-agenda.tsx`:

(a) Import the panel: `import { OutreachPanel } from "#/components/club/outreach-panel";`

(b) Add to `MeetingAgendaProps`:

```ts
	/** Member ids already contacted for this meeting (#340). Admin-only; empty on
	 *  the public/member view. */
	contactedMemberIds: string[];
	/** Mark/unmark a member contacted (#340). Manager surface only. */
	onContacted?: (memberId: string, via: "nudge" | "manual") => void | Promise<void>;
	onUncontacted?: (memberId: string) => void | Promise<void>;
```

(c) Update the `buildRecruitTargets` call (currently 3 args) to pass the contacted set:

```ts
	const recruitTargets = buildRecruitTargets(
		roster,
		new Set(unavailableMemberIds),
		roleByMemberId,
		new Set(contactedMemberIds),
	);
```

(d) Pass callbacks into `<NudgeRecruitPicker>` (the `viewer.canManage && isOpen` render around line 548):

```tsx
	<NudgeRecruitPicker
		roleName={slot.roleName}
		meetingDate={meetingDate}
		shareUrl={shareUrl}
		targets={recruitTargets}
		onContacted={(id) => onContacted?.(id, "nudge")}
		onUncontacted={(id) => onUncontacted?.(id)}
	/>
```

(e) Render the panel once, under `canManage`, near the existing manager-only "not available this week" section (search for `unavailableMembers` usage in the JSX to find that block, and place `<OutreachPanel>` beside it):

```tsx
	{viewer.canManage ? (
		<OutreachPanel
			roster={roster}
			assignedIds={new Set(Object.keys(roleByMemberId))}
			contactedIds={new Set(contactedMemberIds)}
			onContacted={(id) => onContacted?.(id, "manual")}
			onUncontacted={(id) => onUncontacted?.(id)}
		/>
	) : null}
```

- [ ] **Step 6: Wire the route (`meetings.$id.tsx`)**

In `src/routes/_authed/meetings.$id.tsx`:

(a) Destructure `contactedMemberIds` from the `getMeeting` result (alongside `unavailableMembers`, `roster`, etc.).

(b) Import the server fns and wrap with `useServerFn` (match how `setAvailability` etc. are imported/used in this file):

```ts
import { clearContacted, setContacted } from "#/server/outreach";
// ...inside the component, next to the other useServerFn calls:
const setContactedFn = useServerFn(setContacted);
const clearContactedFn = useServerFn(clearContacted);
```

(c) Pass props to `<MeetingAgenda>` (near `unavailableMemberIds={...}`):

```tsx
	contactedMemberIds={contactedMemberIds}
	onContacted={async (memberId, via) => {
		await setContactedFn({
			data: { memberId, meetingId: meeting.id, clubId: meeting.clubId, via },
		});
		await refetch(); // use this file's existing post-mutation refetch (same one actions.onMutated calls)
	}}
	onUncontacted={async (memberId) => {
		await clearContactedFn({
			data: { memberId, meetingId: meeting.id, clubId: meeting.clubId },
		});
		await refetch();
	}}
```

(Use the exact refetch/invalidate call this route already uses in its `actions.onMutated`; grep for `onMutated` in the file and reuse it. `meeting.clubId` must be present on the payload — confirm; if the field is named differently, use that.)

(d) The **public** meeting route (`src/routes/club.$clubId.meeting.$meetingId.tsx`) renders `<MeetingAgenda>` too. It now must supply the new REQUIRED prop `contactedMemberIds`. Pass `contactedMemberIds={[]}` and omit the optional `onContacted`/`onUncontacted`. (`canManage` is false there, so the panel/toggles never render anyway — this only satisfies the type.)

- [ ] **Step 7: Typecheck + full check + commit (Tasks 6 + 7 together)**

Run: `bun run typecheck` → PASS.
Run: `bun run check` → PASS (Biome).
Run: `bunx vitest run src/components/club/nudge-recruit-picker.test.tsx src/components/club/outreach-panel.test.tsx`
Expected: PASS.

```bash
git add src/components/club/nudge-buttons.tsx src/components/club/nudge-recruit-picker.tsx src/components/club/nudge-recruit-picker.test.tsx src/components/club/outreach-panel.tsx src/components/club/outreach-panel.test.tsx src/components/agenda/meeting-agenda.tsx src/routes/_authed/meetings.\$id.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(outreach): meeting-view outreach panel + nudge auto-mark (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Season-grid marker

**Files:**
- Modify: `src/lib/season-grid-view.ts`
- Modify: `src/lib/season-grid-view.test.ts`
- Modify: `src/components/club/grid-cell.tsx`
- Modify: `src/components/club/season-grid.tsx`

- [ ] **Step 1: Add `contacted` to `ViewCell` + set it on free member cells (failing test first)**

In `src/lib/season-grid-view.test.ts`, add a case: a member with a `contacted` entry and no role for a meeting produces a `free` cell with `contacted: true`. Match the file's existing `SeasonGridData` fixture builder and add a `contacted` array to it.

```ts
it("marks a free member cell as contacted when in the contacted set", () => {
	const data = /* build fixture */ {
		// ...existing minimal fixture fields...
		contacted: [{ memberId: "m1", meetingId: "mt1" }],
	} as never;
	const rows = projectGrid(data, "members");
	const cell = rows.find((r) => r.id === "m1")?.cells.find((c) => c.meetingId === "mt1");
	expect(cell?.kind).toBe("free");
	expect(cell?.contacted).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bunx vitest run src/lib/season-grid-view.test.ts`
Expected: FAIL (`contacted` undefined on the cell / not on the type).

- [ ] **Step 3: Implement in `season-grid-view.ts`**

(a) Add `contacted?: boolean;` to the `ViewCell` interface (after `memberId`).

(b) Build a contacted set near `naSet`:

```ts
	const contactedSet = new Set(
		data.contacted.map((c) => `${c.memberId}:${c.meetingId}`),
	);
```

(c) In the **members** orientation, the `free` return (`kind: "free"`, `text: "·"`) gains the flag:

```ts
			return {
				meetingId: m.id,
				kind: "free" as const,
				text: "·",
				title: contactedSet.has(`${member.id}:${m.id}`)
					? "Free · contacted"
					: "Free",
				slotId: null,
				memberId: null,
				contacted: contactedSet.has(`${member.id}:${m.id}`),
			};
```

(Other cell returns may omit `contacted` since it's optional; only the free member cell needs it.)

- [ ] **Step 4: Render the marker in `grid-cell.tsx`**

In the final read-only `inner` span (the `<span>` that renders `cell.text`), add a small dot when `cell.contacted`. Keep it subtle and non-interactive:

```tsx
	<span
		title={cell.title ? cell.title + dateSuffix : undefined}
		className={cn(CELL_BASE, CELL_KIND_CLASS[cell.kind], /* …existing… */)}
	>
		{cell.text}
		{cell.contacted ? (
			<span
				aria-hidden
				className="ml-1 inline-block size-1.5 rounded-full bg-[var(--success-strong)]"
			/>
		) : null}
	</span>
```

(The `free` cell is read-only in every mode — no interactive branch above matches a `free` cell — so this span is the only render path that needs the dot.)

- [ ] **Step 5: `season-grid.tsx` already passes `data` through**

`projectGrid(data, orientation)` receives the whole `data`, which now includes `contacted`. No change needed unless `season-grid.tsx` constructs `data` literals in a narrowed way — grep it for `projectGrid(` and confirm it passes the loader `data` straight through. If the component builds a `ViewCell` anywhere directly, ensure it compiles (contacted is optional).

- [ ] **Step 6: Run + typecheck + commit**

Run: `bunx vitest run src/lib/season-grid-view.test.ts src/components/club/grid-cell.test.tsx`
Expected: PASS.
Run: `bun run typecheck` → PASS.

```bash
git add src/lib/season-grid-view.ts src/lib/season-grid-view.test.ts src/components/club/grid-cell.tsx src/components/club/season-grid.tsx
git commit -m "feat(outreach): contacted dot on free season-grid cells (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 2: Biome**

Run: `bun run check`
Expected: PASS (or auto-format then re-run; commit any formatting).

- [ ] **Step 3: Full unit suite (no DB)**

Run: `bunx vitest run`
Expected: PASS. Integration suites `skipIf(!hasTestDb)` will show as skipped here — that's fine for this step.

- [ ] **Step 4: Integration suites (with test DB)**

Run:
```bash
TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run \
  src/server/outreach.integration.test.ts \
  src/server/season-grid.integration.test.ts \
  src/server/server-modules.guard.test.ts
```
Expected: PASS (not skipped). If skipped, `TEST_DATABASE_URL` isn't reaching a synced DB — fix and re-run.

- [ ] **Step 5: Confirm no public leak (manual read-through)**

Confirm by reading, not just trusting types:
- `getPublicSeasonGrid` / `loadPublicSeasonGrid` never set `includeOutreach` → `contacted: []`.
- The public meeting route passes `contactedMemberIds={[]}` and no toggle callbacks; `getPublicMeeting` returns `canManage:false` → `contactedMemberIds` empty from the server anyway.
- `OutreachPanel` and the picker toggle render only under `viewer.canManage`.

- [ ] **Step 6: Final commit if anything changed in verification**

```bash
git add -A
git commit -m "chore(outreach): verification fixes (#340)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec coverage:** table (T1) · admin-only server fns + lock + idempotency + activity log (T2) · activity rendering (T3) · admin-only season-grid read (T4) · admin-only meeting read (T5) · nudge annotate + auto-mark (T6) · meeting-view toggle panel + count + route wiring (T7) · season-grid marker (T8) · verification incl. no-leak (T9). All spec sections map to a task.
- **Type consistency:** `contacted` set shape `{ memberId, meetingId }[]` is identical to `unavailable` throughout; `via: "nudge" | "manual"` is consistent across server schema, `NudgeRecruitPicker` (`"nudge"`), and `OutreachPanel` (`"manual"`); `buildRecruitTargets` is 4-arg everywhere after T6.
- **Known fallout flagged:** adding a required `contacted` field to `SeasonGridData` breaks existing test fixtures — T4 Step 4 calls this out and lists the files to patch with `contacted: []`.
- **Deferred (per spec YAGNI):** no yes/no/maybe states, no per-role rows, no reminders, no "who asked" in UI, no member/public visibility.
