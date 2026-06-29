# GavelUp Roster Foundation — Implementation Plan (additive)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the additive data foundation for the self-serve MVP — a club **roster** (`members`), per-meeting **availability**, an **activity log**, and **role descriptions** — without touching any existing code path, so it's safe to land alongside the in-flight `club-workspace-views` redesign.

**Architecture:** Pure schema + seed + one write-helper. New tables are *not yet referenced* by any server fn or UI, so nothing breaks. The breaking cutover (re-key `role_slots.assigned_user_id → assigned_member_id`, de-auth claim/release, public reads, wiring activity-log writes) is a **separate follow-on plan** gated on the member-identity flow (#32) and the visual redesign landing.

**Tech Stack:** Drizzle ORM (`drizzle-orm/pg-core`) on Postgres, Bun, Vitest. Migrations via `drizzle-kit`. Tests follow the existing `src/server/claim.integration.test.ts` + `src/test/db.ts` harness (skip without `TEST_DATABASE_URL`).

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-self-serve-mvp-design.md` (§2 data model, §4 responsibilities, §5 Not-Available, §8 activity log). Implements the additive slice of issue **#31** plus the schema for **#34/#35/#36**.

**Scope guard — do NOT in this plan:** touch `role_slots.assigned_user_id`, `claimSlot`/`releaseSlot`/`createMeeting`, the guards, or any route/UI. Those are the follow-on cutover plan. This plan only *adds*.

---

## File structure

- **Modify** `src/db/schema.ts` — add `members`, `memberAvailability`, `activityLog` tables + `activityActionEnum`; add `description` to `roleDefinitions`; add relations. (One file; matches existing single-schema convention.)
- **Create** `drizzle/NNNN_*.sql` (+ meta) — generated migration. Never hand-edit.
- **Create** `src/server/activity.ts` — `logActivity()` write helper (the only consumer of `activityLog` for now).
- **Modify** `src/db/seed.ts` — additively seed a `members` roster + set `roleDefinitions.description` (idempotent; leaves existing user/membership seed intact).
- **Create** `src/server/activity.integration.test.ts` — DB-backed tests for `logActivity` + schema constraints (availability uniqueness), gated `skipIf(!hasTestDb)`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Gen migration | `bun run db:generate` | new file under `drizzle/` |
| Lint/format | `bun run check` | exit 0 |
| Unit/integration (no DB) | `bunx vitest run` | exit 0, new suite skipped |
| Integration (with DB) | `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run src/server/activity.integration.test.ts` | pass |

(For a local test DB: `docker run -d --name tm-pg-test -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tm_test postgres:17`, then `DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx drizzle-kit push`.)

---

### Task 1: Add the `members` roster table

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the table.** After the `clubMemberships` block in `src/db/schema.ts`, add (note `uniqueIndex` must be added to the existing `drizzle-orm/pg-core` import):

```ts
export const members = pgTable(
	"members",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		email: text("email"),
		phone: text("phone"),
		office: text("office"),
		// Links a roster member to the Better-Auth account of the one signed-in
		// admin/VPE. NULL for ordinary members (who never sign in).
		userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("members_club_idx").on(t.clubId)],
);
```

- [ ] **Step 2: Add relations.** Near the other `relations(...)` blocks:

```ts
export const membersRelations = relations(members, ({ one }) => ({
	club: one(clubs, { fields: [members.clubId], references: [clubs.id] }),
	user: one(user, { fields: [members.userId], references: [user.id] }),
}));
```

- [ ] **Step 3: Verify it compiles.** Run: `bunx tsc --noEmit` → Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add members roster table"
```

---

### Task 2: Add `description` to role definitions

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the column.** Inside the existing `roleDefinitions` `pgTable(... { ... })` column object, add:

```ts
		// Human-readable responsibilities, shown before claiming + on the shared link.
		description: text("description"),
```

- [ ] **Step 2: Verify.** Run: `bunx tsc --noEmit` → Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add role_definitions.description"
```

---

### Task 3: Add the `member_availability` table

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the table.** After `members`:

```ts
export const memberAvailability = pgTable(
	"member_availability",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// Presence of a row = "Not Available" for that meeting. One per pair.
		uniqueIndex("member_availability_unique").on(t.memberId, t.meetingId),
		index("member_availability_meeting_idx").on(t.meetingId),
	],
);
```

- [ ] **Step 2: Verify.** Run: `bunx tsc --noEmit` → Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add member_availability table"
```

---

### Task 4: Add the `activity_log` table + enum

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add the enum.** With the other `pgEnum` declarations:

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
]);
```

- [ ] **Step 2: Add the table** (add `jsonb` to the `drizzle-orm/pg-core` import):

```ts
export const activityLog = pgTable(
	"activity_log",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// The self-asserted member who acted (NULL = system/unknown).
		actorMemberId: uuid("actor_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		action: activityActionEnum("action").notNull(),
		targetType: text("target_type").notNull(), // 'slot' | 'meeting' | 'member'
		targetId: text("target_id"),
		detail: jsonb("detail"), // { before?, after?, ... }
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("activity_log_club_created_idx").on(t.clubId, t.createdAt)],
);
```

- [ ] **Step 3: Verify.** Run: `bunx tsc --noEmit` → Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add activity_log table + activity_action enum"
```

---

### Task 5: Generate + apply the migration

**Files:**
- Create: `drizzle/NNNN_*.sql` and `drizzle/meta/*` (generated)

- [ ] **Step 1: Generate.** Run: `bun run db:generate` → Expected: a new SQL file under `drizzle/` creating `members`, `member_availability`, `activity_log`, the `activity_action` enum, and `ALTER TABLE role_definitions ADD COLUMN description`. Open it and confirm those statements are present.

- [ ] **Step 2: Apply to a local test DB to prove it runs.** Start Postgres (see Commands), then:

Run: `DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx drizzle-kit push`
Expected: "Changes applied" with no errors.

> STOP if `db:generate` produces edits to *unrelated* tables (it should only add the new tables/column) — that signals schema drift; report instead of committing.

- [ ] **Step 3: Commit.**

```bash
git add drizzle/
git commit -m "chore(db): migration for roster/availability/activity-log/role-description"
```

---

### Task 6: `logActivity` write helper

**Files:**
- Create: `src/server/activity.ts`
- Test: `src/server/activity.integration.test.ts`

- [ ] **Step 1: Write the failing test.** Create `src/server/activity.integration.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityLog } from "#/db/schema";
import { logActivity } from "#/server/activity";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

describe.skipIf(!hasTestDb)("logActivity", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("inserts a row with action, target, and detail", async () => {
		await logActivity(testDb, {
			clubId: seed.clubId,
			actorMemberId: null,
			action: "claim",
			targetType: "slot",
			targetId: seed.slotId,
			detail: { before: null, after: "claimed" },
		});
		const rows = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, seed.clubId));
		expect(rows).toHaveLength(1);
		expect(rows[0].action).toBe("claim");
		expect(rows[0].targetId).toBe(seed.slotId);
		expect(rows[0].detail).toEqual({ before: null, after: "claimed" });
	});
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run src/server/activity.integration.test.ts`
Expected: FAIL — `logActivity` is not defined / module not found.

> Note: `seedClub()` lives in `src/test/db.ts`. It currently seeds a club + users + one slot. If it does not yet expose `clubId`/`slotId` in `SeededClub`, extend it minimally to do so (it already creates these rows) — that's in-scope for this task.

- [ ] **Step 3: Implement.** Create `src/server/activity.ts`:

```ts
import type { db as Db } from "#/db";
import { activityLog } from "#/db/schema";

type ActivityAction =
	| "claim"
	| "release"
	| "reassign"
	| "availability_set"
	| "availability_clear"
	| "member_add"
	| "member_edit"
	| "member_merge"
	| "member_remove"
	| "meeting_create"
	| "meeting_edit";

export interface ActivityInput {
	clubId: string;
	actorMemberId: string | null;
	action: ActivityAction;
	targetType: "slot" | "meeting" | "member";
	targetId?: string | null;
	detail?: unknown;
}

/**
 * Append one row to the activity log. Pass a transaction (`tx`) when logging
 * inside the same transaction as the state change so the two commit together.
 */
export async function logActivity(
	conn: typeof Db,
	input: ActivityInput,
): Promise<void> {
	await conn.insert(activityLog).values({
		clubId: input.clubId,
		actorMemberId: input.actorMemberId ?? null,
		action: input.action,
		targetType: input.targetType,
		targetId: input.targetId ?? null,
		detail: input.detail ?? null,
	});
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run src/server/activity.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Confirm no-DB run still green.**

Run: `bunx vitest run` → Expected: exit 0, the `logActivity` suite reported **skipped**.

- [ ] **Step 6: Commit.**

```bash
git add src/server/activity.ts src/server/activity.integration.test.ts src/test/db.ts
git commit -m "feat(server): add logActivity write helper + tests"
```

---

### Task 7: Additively seed the roster + role descriptions

**Files:**
- Modify: `src/db/seed.ts`

- [ ] **Step 1: Add role descriptions to the template.** In `src/db/seed.ts`, the `ROLE_TEMPLATE` array currently has `{ name, category, defaultCount, sortOrder, isSpeakerRole }`. Add a `description` to each entry, e.g.:

```ts
	{
		name: "Toastmaster of the Day",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
		description:
			"Hosts the meeting: sets the theme, introduces each speaker and segment, and keeps energy and timing on track. Prep: review the agenda beforehand.",
	},
	// ...one description per role (Speaker, Evaluator, Timer, Ah-Counter, Grammarian, General Evaluator, Table Topics Master)
```

Write a real one-sentence responsibility for each of the 8 template roles (standard Toastmasters duties). The `roleDefinitions` insert already spreads the template, so `description` flows through once added to the objects.

- [ ] **Step 2: Seed a roster.** After the club is created and `clubMemberships` are inserted, add `members` rows for the club (idempotent — guard with a count check so re-running doesn't duplicate). Link the admin's member to their auth user:

```ts
import { members } from "./schema.ts";
// ...after club + memberships exist:
const existingMembers = await db
	.select({ id: members.id })
	.from(members)
	.where(eq(members.clubId, club.id));
if (existingMembers.length === 0) {
	await db.insert(members).values([
		{ clubId: club.id, name: "Rasheed Bustamam", email: ADMIN_EMAIL, office: "VP Education", userId: adminId },
		{ clubId: club.id, name: "Alex Rivera", email: "alex@example.com" },
		{ clubId: club.id, name: "Sam Chen", email: "sam@example.com" },
		{ clubId: club.id, name: "Jordan Patel", email: "jordan@example.com" },
	]);
}
```

- [ ] **Step 3: Verify the seed runs.** Against the local test DB:

Run: `DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bun run db:seed`
Expected: completes; "Seeded club MCF…". Then confirm rows exist:

Run: `DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bun -e "import {drizzle} from 'drizzle-orm/node-postgres'; import * as s from './src/db/schema.ts'; const db=drizzle(process.env.DATABASE_URL,{schema:s}); console.log('members', (await db.select().from(s.members)).length, 'described roles', (await db.select().from(s.roleDefinitions)).filter(r=>r.description).length)"`
Expected: `members 4 described roles 8` (or your counts).

- [ ] **Step 4: Confirm typecheck + lint.**

Run: `bunx tsc --noEmit` → exit 0. Run: `bun run check` → exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/db/seed.ts
git commit -m "feat(seed): roster members + role descriptions (additive)"
```

---

## Self-review (completed against the spec)

- **Spec coverage:** §2 `members` (Task 1) + `member_availability` (Task 3) + `activity_log` (Task 4) ✓; §4 `role_definitions.description` (Task 2) + seeded text (Task 7) ✓; §8 activity-log table + write helper (Tasks 4, 6) ✓. **Deliberately deferred to the cutover plan:** the `role_slots` re-key, de-auth of claim/release, public reads, and *wiring* `logActivity` into mutations (this plan only adds the helper + tables). The admin↔member link column is here (Task 1) so the cutover can use it.
- **Placeholder scan:** Task 7 Step 1 asks the engineer to author 8 role descriptions — that's content, not a code placeholder; one full example is given and the pattern is unambiguous. No "TODO/handle edge cases" steps.
- **Type consistency:** `logActivity(conn, input)` signature, `ActivityInput` fields, and the `activityActionEnum` values match between Task 4 (schema), Task 6 (helper + test), and the table columns. `SeededClub` fields (`clubId`, `slotId`, `adminUserId`, `memberUserId`) are used consistently; Task 6 Step 2 flags extending `src/test/db.ts` if any are missing.

## Follow-on plans (NOT this plan)

1. **Cutover: re-key + de-auth** (gated on identity #32 + the visual redesign): `role_slots.assigned_user_id → assigned_member_id`; claim/release/reassign take a self-asserted member; wire `logActivity` into each mutation; make reads public; retire `clubMemberships` for the roster. Likely a re-seed (spec open question).
2. **Member mobile UI** (#33) and **VPE overview grid** (#38) — build on the landed `club-workspace-views` design system.
3. **Shareable link + tap-to-nudge** (#37).
