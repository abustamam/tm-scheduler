# Add a role to existing meetings (#143) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins add an arbitrary role to a meeting that already exists, remove an unclaimed one, and backfill missing standard roles onto all upcoming meetings with one click.

**Architecture:** One data-layer primitive per operation in `src/server/slots-logic.ts` (add, remove, template-sync), each guarded by admin-only `createServerFn` wrappers. A single coherent rule threads through all three: the paired **speaker + evaluator** are managed only by the existing "+ Add speaker" pair buttons; **every other role** is addable/removable/syncable. The paired pair is identified by a new non-throwing helper `pairedRoleIds`.

**Tech Stack:** TanStack Start server fns, Drizzle ORM (node-postgres), Vitest integration tests (mock `#/db` → `testDb`), React 19 + shadcn/ui, sonner toasts.

**Spec:** `docs/superpowers/specs/2026-07-09-add-role-to-existing-meetings-design.md`

---

## Preamble (read once)

- Work happens in the existing worktree at `.claude/worktrees/issue-143-add-role-to-meetings` on branch `worktree-issue-143-add-role-to-meetings`. Run all commands from there.
- Integration suites gate on `TEST_DATABASE_URL`. **Always** run tests with it set, or the DB suites silently skip:
  ```
  TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run <path>
  ```
  (The `tm_test` DB lives in the running `dev-postgres` container.)
- Pure unit tests (Task 1) need no DB — a plain `bunx vitest run <path>` works.
- Lint/format gate: `bun run check`. Typecheck: `bun run build` (no dedicated typecheck script).

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/meeting-roles.ts` | Speaker/evaluator role identification | Add `pairedRoleIds` (non-throwing) |
| `src/server/slots-logic.ts` | Slot DB logic (testable) | Add `applyAddRoleSlot`, `applyRemoveRoleSlot`, `applyTemplateSyncToUpcomingMeetings` |
| `src/server/slots.ts` | Slot server-fn wrappers | Add `addRoleSlot`, `removeRoleSlot` |
| `src/server/role-definitions.ts` | Role-template server-fn wrappers | Add `syncTemplateToUpcomingMeetings` |
| `src/server/meetings.ts` | Meeting read payload | Add `clubRoles` + `roleDefinitionId` on slots (canManage only) |
| `src/routes/_authed/meetings.$id.tsx` | Meeting view | "+ Add role" dialog + per-slot remove |
| `src/routes/_authed/admin/roles.tsx` | Role-template manager | Sync button + toast-with-action nudge |
| `src/lib/meeting-roles.test.ts` | Unit test | New — `pairedRoleIds` |
| `src/server/meeting-roles-mgmt.integration.test.ts` | Integration test | New — the three `apply*` fns |

---

## Task 1: `pairedRoleIds` helper (non-throwing)

`pickSpeakerAndEvaluatorRoles` **throws** when a club has no speaker role. The add/remove/sync paths must handle that club gracefully, so we add a non-throwing companion that returns the set of role ids to exclude (speaker + paired evaluator), empty when there's no speaker.

**Files:**
- Modify: `src/lib/meeting-roles.ts`
- Test: `src/lib/meeting-roles.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/meeting-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pairedRoleIds } from "./meeting-roles";

type Def = Parameters<typeof pairedRoleIds>[0][number];
const def = (o: Partial<Def> & { id: string }): Def => ({
	category: "functionary",
	defaultCount: 1,
	sortOrder: 0,
	isSpeakerRole: false,
	...o,
});

describe("pairedRoleIds", () => {
	it("returns the speaker + highest-count evaluator ids", () => {
		const ids = pairedRoleIds([
			def({ id: "spk", category: "speaker", isSpeakerRole: true, sortOrder: 1 }),
			def({ id: "ev", category: "evaluator", defaultCount: 3, sortOrder: 2 }),
			def({ id: "gen-ev", category: "evaluator", defaultCount: 1, sortOrder: 3 }),
			def({ id: "timer", sortOrder: 4 }),
		]);
		expect(ids).toEqual(new Set(["spk", "ev"]));
	});

	it("is empty when the club has no speaker role", () => {
		expect(pairedRoleIds([def({ id: "timer" })])).toEqual(new Set());
	});

	it("returns just the speaker when there is no evaluator role", () => {
		expect(
			pairedRoleIds([
				def({ id: "spk", category: "speaker", isSpeakerRole: true }),
			]),
		).toEqual(new Set(["spk"]));
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: FAIL — `pairedRoleIds` is not exported.

- [ ] **Step 3: Implement `pairedRoleIds`**

Append to `src/lib/meeting-roles.ts` (after `pickSpeakerAndEvaluatorRoles`):

```ts
/**
 * Role ids the generic add/remove/template-sync must skip: the speaker role and
 * its paired evaluator (both managed by the "+ Add speaker" / "− Remove speaker"
 * pair buttons). Empty when the club has no speaker role. A non-throwing
 * companion to `pickSpeakerAndEvaluatorRoles`, reusing the same heuristic.
 */
export function pairedRoleIds(defs: RoleDefLite[]): Set<string> {
	const speaker = defs
		.filter((d) => d.isSpeakerRole)
		.sort((a, b) => a.sortOrder - b.sortOrder)[0];
	if (!speaker) return new Set<string>();
	const evaluator = defs
		.filter((d) => d.category === "evaluator")
		.sort(
			(a, b) => b.defaultCount - a.defaultCount || a.sortOrder - b.sortOrder,
		)[0];
	return new Set(evaluator ? [speaker.id, evaluator.id] : [speaker.id]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-roles.ts src/lib/meeting-roles.test.ts
git commit -m "feat(#143): add non-throwing pairedRoleIds helper"
```

---

## Task 2: `applyAddRoleSlot`

Adds one `open` slot of any non-paired role to a meeting; duplicates allowed (next `slotIndex`). Rejects a foreign-club role and the speaker/paired-evaluator roles.

**Files:**
- Modify: `src/server/slots-logic.ts`
- Test: `src/server/meeting-roles-mgmt.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/meeting-roles-mgmt.integration.test.ts`:

```ts
/**
 * DB-backed tests for adding/removing arbitrary roles on a meeting and syncing
 * the template onto upcoming meetings (#143). Tests the plain logic fns directly
 * (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts
 */
import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyAddRoleSlot,
	applyRemoveRoleSlot,
	applyTemplateSyncToUpcomingMeetings,
} = await import("./slots-logic");

/** Insert a role definition on the seeded club; return its id. */
async function addRole(
	clubId: string,
	o: {
		name: string;
		category?: "leadership" | "speaker" | "evaluator" | "functionary";
		defaultCount?: number;
		sortOrder?: number;
		isSpeakerRole?: boolean;
	},
): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: o.name,
			category: o.category ?? "functionary",
			defaultCount: o.defaultCount ?? 1,
			sortOrder: o.sortOrder ?? 50,
			isSpeakerRole: o.isSpeakerRole ?? false,
		})
		.returning({ id: roleDefinitions.id });
	return row.id;
}

async function slotsFor(meetingId: string, roleId: string) {
	return testDb
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
}

describe.skipIf(!hasTestDb)("meeting role management (#143)", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("applyAddRoleSlot adds an open slot", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		expect(await slotsFor(club.meetingId, roleId)).toHaveLength(1);
	});

	it("applyAddRoleSlot allows a duplicate at the next slotIndex", async () => {
		const roleId = await addRole(club.clubId, { name: "Vote Counter" });
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		await applyAddRoleSlot({
			meetingId: club.meetingId,
			roleDefinitionId: roleId,
			actorMemberId: club.adminMemberId,
		});
		const rows = await slotsFor(club.meetingId, roleId);
		expect(rows.map((r) => r.slotIndex)).toEqual([0, 1]);
	});

	it("applyAddRoleSlot rejects a role from a different club", async () => {
		const other = await seedClub();
		try {
			await expect(
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: other.roleDefinitionId,
					actorMemberId: club.adminMemberId,
				}),
			).rejects.toThrow(/not found for this club/i);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("applyAddRoleSlot rejects the speaker role", async () => {
		const spk = await addRole(club.clubId, {
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 10,
		});
		await expect(
			applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: spk,
				actorMemberId: club.adminMemberId,
			}),
		).rejects.toThrow(/speaker controls/i);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: FAIL — `applyAddRoleSlot` is not exported.

- [ ] **Step 3: Implement `applyAddRoleSlot`**

In `src/server/slots-logic.ts`, update the drizzle import to add `gt`, and the meeting-roles import to add `pairedRoleIds`:

```ts
import { and, eq, gt } from "drizzle-orm";
```
```ts
import { pairedRoleIds, pickSpeakerAndEvaluatorRoles } from "#/lib/meeting-roles";
```

Then add (after `applyAddSpeakerSlot`):

```ts
/** The club's role defs in the shape `pairedRoleIds` needs, plus name/id. */
async function clubRoleDefs(clubId: string) {
	return db
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
}

/** Add one open slot of an arbitrary non-paired role to a meeting. Duplicates
 *  allowed (next slotIndex). Rejects the speaker/paired-evaluator roles (those
 *  go through the +/- speaker buttons) and roles from another club. */
export async function applyAddRoleSlot(input: {
	meetingId: string;
	roleDefinitionId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");

	const defs = await clubRoleDefs(meeting.clubId);
	const role = defs.find((d) => d.id === input.roleDefinitionId);
	if (!role) throw new Error("Role not found for this club.");
	if (pairedRoleIds(defs).has(role.id)) {
		throw new Error("Add speakers with the speaker controls.");
	}

	const existing = await db
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, input.meetingId),
				eq(roleSlots.roleDefinitionId, input.roleDefinitionId),
			),
		);
	const slotIndex = nextIndex(existing.map((s) => s.slotIndex));

	await db.transaction(async (tx) => {
		await tx.insert(roleSlots).values({
			meetingId: input.meetingId,
			roleDefinitionId: input.roleDefinitionId,
			slotIndex,
		});
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				change: "role_added",
				roleDefinitionId: input.roleDefinitionId,
			},
		});
	});
	return { clubId: meeting.clubId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots-logic.ts src/server/meeting-roles-mgmt.integration.test.ts
git commit -m "feat(#143): applyAddRoleSlot — add arbitrary non-paired role to a meeting"
```

---

## Task 3: `applyRemoveRoleSlot`

Deletes an unclaimed, non-paired slot. Rejects a claimed slot and the speaker/paired-evaluator roles.

**Files:**
- Modify: `src/server/slots-logic.ts`
- Test: `src/server/meeting-roles-mgmt.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these `it` blocks inside the existing `describe` in `meeting-roles-mgmt.integration.test.ts`:

```ts
it("applyRemoveRoleSlot deletes an unclaimed slot", async () => {
	// The seeded club already has one open Timer slot on the meeting.
	await applyRemoveRoleSlot({
		slotId: club.slotId,
		actorMemberId: club.adminMemberId,
	});
	expect(
		await slotsFor(club.meetingId, club.roleDefinitionId),
	).toHaveLength(0);
});

it("applyRemoveRoleSlot rejects a claimed slot", async () => {
	await testDb
		.update(roleSlots)
		.set({ status: "claimed", assignedMemberId: club.memberId })
		.where(eq(roleSlots.id, club.slotId));
	await expect(
		applyRemoveRoleSlot({
			slotId: club.slotId,
			actorMemberId: club.adminMemberId,
		}),
	).rejects.toThrow(/release the role/i);
});

it("applyRemoveRoleSlot rejects the paired evaluator", async () => {
	await addRole(club.clubId, {
		name: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		sortOrder: 10,
	});
	const evId = await addRole(club.clubId, {
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 11,
	});
	const [evSlot] = await testDb
		.insert(roleSlots)
		.values({ meetingId: club.meetingId, roleDefinitionId: evId })
		.returning({ id: roleSlots.id });
	await expect(
		applyRemoveRoleSlot({
			slotId: evSlot.id,
			actorMemberId: club.adminMemberId,
		}),
	).rejects.toThrow(/speaker controls/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: FAIL — `applyRemoveRoleSlot` is not exported.

- [ ] **Step 3: Implement `applyRemoveRoleSlot`**

Add to `src/server/slots-logic.ts` (after `applyAddRoleSlot`):

```ts
/** Remove one unclaimed, non-paired slot from a meeting. Rejects a claimed slot
 *  (never destroys an assignment) and the speaker/paired-evaluator roles. */
export async function applyRemoveRoleSlot(input: {
	slotId: string;
	actorMemberId: string | null;
}) {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");
	if (slot.assignedMemberId || slot.status !== "open") {
		throw new Error("Release the role before removing it.");
	}

	const defs = await clubRoleDefs(slot.clubId);
	if (pairedRoleIds(defs).has(slot.roleDefinitionId)) {
		throw new Error("Remove speakers with the speaker controls.");
	}

	await db.transaction(async (tx) => {
		await tx.delete(roleSlots).where(eq(roleSlots.id, input.slotId));
		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: slot.meetingId,
			detail: {
				change: "role_removed",
				roleDefinitionId: slot.roleDefinitionId,
			},
		});
	});
	return { clubId: slot.clubId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots-logic.ts src/server/meeting-roles-mgmt.integration.test.ts
git commit -m "feat(#143): applyRemoveRoleSlot — remove an unclaimed non-paired slot"
```

---

## Task 4: `applyTemplateSyncToUpcomingMeetings`

Presence-based backfill: for each upcoming meeting, add one slot of every standard (`defaultCount ≥ 1`), non-paired role the meeting has zero of. Never tops up counts, never touches speakers/paired evaluators, never rewrites past meetings.

**Files:**
- Modify: `src/server/slots-logic.ts`
- Test: `src/server/meeting-roles-mgmt.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these `it` blocks inside the existing `describe`:

```ts
it("sync adds a missing standard role to upcoming meetings", async () => {
	const vc = await addRole(club.clubId, {
		name: "Vote Counter",
		sortOrder: 60,
	});
	const res = await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(res.meetingsChanged).toBe(1);
	expect(res.rolesAdded).toEqual(["Vote Counter"]);
	expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
});

it("sync skips roles already present (idempotent)", async () => {
	// Timer (the seeded role) is already on the meeting.
	const first = await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(first.meetingsChanged).toBe(0);
	// Adding then re-running adds it once, and a second run is a no-op.
	await addRole(club.clubId, { name: "Vote Counter", sortOrder: 60 });
	await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	const again = await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(again.meetingsChanged).toBe(0);
});

it("sync skips defaultCount 0 roles", async () => {
	const joke = await addRole(club.clubId, {
		name: "Jokemaster",
		defaultCount: 0,
		sortOrder: 61,
	});
	await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(await slotsFor(club.meetingId, joke)).toHaveLength(0);
});

it("sync never adds speakers or the paired evaluator", async () => {
	const spk = await addRole(club.clubId, {
		name: "Speaker",
		category: "speaker",
		isSpeakerRole: true,
		defaultCount: 2,
		sortOrder: 10,
	});
	const ev = await addRole(club.clubId, {
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 2,
		sortOrder: 11,
	});
	await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(await slotsFor(club.meetingId, spk)).toHaveLength(0);
	expect(await slotsFor(club.meetingId, ev)).toHaveLength(0);
});

it("sync leaves past meetings untouched", async () => {
	const [past] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	const vc = await addRole(club.clubId, {
		name: "Vote Counter",
		sortOrder: 60,
	});
	await applyTemplateSyncToUpcomingMeetings({
		clubId: club.clubId,
		actorMemberId: club.adminMemberId,
	});
	expect(await slotsFor(past.id, vc)).toHaveLength(0);
	// sanity: the upcoming meeting DID get it
	expect(await slotsFor(club.meetingId, vc)).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: FAIL — `applyTemplateSyncToUpcomingMeetings` is not exported.

- [ ] **Step 3: Implement `applyTemplateSyncToUpcomingMeetings`**

Add to `src/server/slots-logic.ts` (after `applyRemoveRoleSlot`):

```ts
/** Presence-based template backfill: for every upcoming meeting (scheduledAt >
 *  now), add one open slot of each standard (defaultCount >= 1), non-paired role
 *  the meeting has zero of. Never tops up counts, never adds speakers/paired
 *  evaluators, never touches past meetings. Idempotent. Returns how many
 *  meetings changed and the distinct role names added. */
export async function applyTemplateSyncToUpcomingMeetings(input: {
	clubId: string;
	actorMemberId: string | null;
}) {
	const defs = await clubRoleDefs(input.clubId);
	const paired = pairedRoleIds(defs);
	const standard = defs.filter((d) => d.defaultCount >= 1 && !paired.has(d.id));

	const upcoming = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				gt(meetings.scheduledAt, new Date()),
			),
		);

	const rolesAdded = new Set<string>();
	let meetingsChanged = 0;

	await db.transaction(async (tx) => {
		for (const m of upcoming) {
			const present = await tx
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, m.id));
			const presentIds = new Set(present.map((s) => s.roleDefinitionId));
			const missing = standard.filter((d) => !presentIds.has(d.id));
			if (missing.length === 0) continue;

			await tx.insert(roleSlots).values(
				missing.map((d) => ({
					meetingId: m.id,
					roleDefinitionId: d.id,
					slotIndex: 0,
				})),
			);
			for (const d of missing) rolesAdded.add(d.name);
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "meeting_edit",
				targetType: "meeting",
				targetId: m.id,
				detail: {
					change: "template_sync",
					roleDefinitionIds: missing.map((d) => d.id),
				},
			});
			meetingsChanged += 1;
		}
	});

	return { meetingsChanged, rolesAdded: [...rolesAdded] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-roles-mgmt.integration.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots-logic.ts src/server/meeting-roles-mgmt.integration.test.ts
git commit -m "feat(#143): applyTemplateSyncToUpcomingMeetings — presence-based backfill"
```

---

## Task 5: Server-fn wrappers (admin-gated)

Expose the three primitives as `createServerFn`s. All admin-only. Db logic stays in `*-logic.ts` — these modules export only server fns (enforced by `server-modules.guard.test.ts`).

**Files:**
- Modify: `src/server/slots.ts` (add `addRoleSlot`, `removeRoleSlot`)
- Modify: `src/server/role-definitions.ts` (add `syncTemplateToUpcomingMeetings`)

- [ ] **Step 1: Add `addRoleSlot` + `removeRoleSlot` to `slots.ts`**

In `src/server/slots.ts`, extend the import from `./slots-logic` to include the two new fns:

```ts
import {
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveRoleSlot,
	applyRemoveSpeakerSlot,
	attachSpeechToSlot,
	editSlotSpeech,
	reassignSlotCore,
} from "./slots-logic";
```

Then append at the end of the file:

```ts
const addRoleSlotSchema = z.object({
	meetingId: z.string().uuid(),
	roleDefinitionId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE: add one arbitrary non-paired role slot to a meeting. AUTHED. */
export const addRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => addRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, data.meetingId))
			.limit(1);
		if (!row) throw new Error("Meeting not found.");
		await requireClubRole(currentUser.id, row.clubId, ["admin"]);
		return applyAddRoleSlot({
			meetingId: data.meetingId,
			roleDefinitionId: data.roleDefinitionId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

const removeRoleSlotSchema = z.object({
	slotId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE: remove one unclaimed non-paired role slot. AUTHED. */
export const removeRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Role not found.");
		await requireClubRole(currentUser.id, row.clubId, ["admin"]);
		return applyRemoveRoleSlot({
			slotId: data.slotId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
```

(`db`, `meetings`, `roleSlots`, `requireUser`, `requireClubRole`, `z`, `createServerFn`, `eq` are all already imported in `slots.ts`.)

- [ ] **Step 2: Add `syncTemplateToUpcomingMeetings` to `role-definitions.ts`**

In `src/server/role-definitions.ts`, add an import for the sync logic (from `slots-logic`, not `role-definitions-logic`):

```ts
import { applyTemplateSyncToUpcomingMeetings } from "./slots-logic";
```

Then append at the end of the file:

```ts
const syncTemplateSchema = z.object({
	clubId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});

/** Backfill missing standard roles onto all upcoming meetings. AUTHED — admin. */
export const syncTemplateToUpcomingMeetings = createServerFn({ method: "POST" })
	.validator((input: unknown) => syncTemplateSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, data.clubId, ["admin"]);
		return applyTemplateSyncToUpcomingMeetings({
			clubId: data.clubId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
```

(`z`, `createServerFn`, `requireUser`, `requireClubRole` are already imported.)

- [ ] **Step 3: Verify the module-boundary guard + typecheck**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS (the new exports are `createServerFn`s only).

Run: `bun run build`
Expected: build succeeds, no type errors. (This mutates `src/routeTree.gen.ts` with an SSR Register block — revert it before committing: `git checkout src/routeTree.gen.ts`.)

- [ ] **Step 4: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
git add src/server/slots.ts src/server/role-definitions.ts
git commit -m "feat(#143): admin-gated wrappers addRoleSlot/removeRoleSlot/syncTemplate"
```

---

## Task 6: Expose `clubRoles` + slot `roleDefinitionId` in the meeting payload

The meeting view needs (a) the club's roles to populate the "+ Add role" picker, and (b) each slot's `roleDefinitionId` so the per-slot remove control can exclude the paired evaluator precisely (not all evaluators). Both are gated to `canManage` where it matters (roster is already gated the same way).

**Files:**
- Modify: `src/server/meetings.ts` (`loadMeetingDetail`)

- [ ] **Step 1: Add `roleDefinitionId` to the slot select**

In `loadMeetingDetail` (`src/server/meetings.ts`), add `roleDefinitionId` to the `rows` select object (near `id: roleSlots.id`):

```ts
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
```

- [ ] **Step 2: Add a `clubRoles` query (canManage only)**

In `loadMeetingDetail`, right after the `roster` block, add:

```ts
	// Club role template for the "+ Add role" picker — management-only, like the
	// roster. Ordered like the roles page.
	const clubRoles = canManage
		? await db
				.select({
					id: roleDefinitions.id,
					name: roleDefinitions.name,
					category: roleDefinitions.category,
					defaultCount: roleDefinitions.defaultCount,
					sortOrder: roleDefinitions.sortOrder,
					isSpeakerRole: roleDefinitions.isSpeakerRole,
				})
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, meeting.clubId))
				.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name))
		: [];
```

- [ ] **Step 3: Return `clubRoles`**

Add `clubRoles,` to the object returned by `loadMeetingDetail` (next to `roster,`):

```ts
		roster,
		clubRoles,
	};
```

(`roleDefinitions`, `asc`, `eq`, `db` are already imported in `meetings.ts`.)

- [ ] **Step 4: Typecheck**

Run: `bun run build`
Expected: build succeeds. Revert the route-tree artifact: `git checkout src/routeTree.gen.ts`.

- [ ] **Step 5: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
git add src/server/meetings.ts
git commit -m "feat(#143): expose clubRoles + slot roleDefinitionId for the add/remove UI"
```

---

## Task 7: Meeting-view UI — "+ Add role" dialog + per-slot remove

Wire the primitives into `meetings.$id.tsx`. This is UI plumbing over already-tested server fns, so it's verified by typecheck + a manual smoke, not unit tests (consistent with the spec).

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Imports + loader data + derived sets**

Add `Trash2` to the `lucide-react` import; import `pairedRoleIds`; import `addRoleSlot`/`removeRoleSlot`:

```ts
import {
	CalendarDays,
	CalendarOff,
	Loader2,
	MapPin,
	Sparkles,
	Trash2,
} from "lucide-react";
```
```ts
import { buildRoleCounts, slotLabel, summarizeAgenda } from "#/lib/agenda";
import { pairedRoleIds } from "#/lib/meeting-roles";
```
```ts
import {
	addRoleSlot,
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
	releaseSlot,
	removeRoleSlot,
	removeSpeakerSlot,
	unconfirmSlot,
} from "#/server/slots";
```

In `MeetingDetail`, add `clubRoles` to the destructured loader data and derive the excluded set + addable list + an add-role dialog state:

```ts
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		clubSlug,
		roster,
		clubRoles,
		navItems,
	} = Route.useLoaderData();
```
```ts
	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
```

- [ ] **Step 2: Add the `doAddRole` / `doRemoveRole` handlers**

Add inside `MeetingDetail` (near `doAddSpeaker`):

```ts
	async function doAddRole(roleDefinitionId: string) {
		setBusySlotId("add-role");
		try {
			await addRoleSlot({
				data: { meetingId: meeting.id, roleDefinitionId, actorMemberId: currentMemberId },
			});
			toast.success("Role added.");
			setAddRoleOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRemoveRole(slot: Slot) {
		setBusySlotId(slot.id);
		try {
			await removeRoleSlot({
				data: { slotId: slot.id, actorMemberId: currentMemberId },
			});
			toast.success("Role removed.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}
```

- [ ] **Step 3: Add the "+ Add role" button to the header actions**

In the header actions row (where "Edit meeting" lives, around the `MeetingViewActions` line), add before the Edit button:

```tsx
					{canManage && addableRoles.length > 0 ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setAddRoleOpen(true)}
						>
							+ Add role
						</Button>
					) : null}
```

- [ ] **Step 4: Add the per-slot remove (trash) control**

In the slot's action column, the block gated by `canManage` currently holds Assign/Edit-speech. Add a remove control for unclaimed, non-paired slots. Insert this just after the `{canManage ? ( ...Assign... ) : null}` block, still inside the `<div className="flex shrink-0 flex-col gap-2">`:

```tsx
												{canManage &&
												slot.status === "open" &&
												!slot.assigneeId &&
												!pairedIds.has(slot.roleDefinitionId) ? (
													<Button
														size="sm"
														variant="ghost"
														aria-label={`Remove ${slot.roleName}`}
														disabled={busy}
														onClick={() => doRemoveRole(slot)}
													>
														<Trash2 className="size-4" />
													</Button>
												) : null}
```

- [ ] **Step 5: Add the Add-role dialog near the other dialogs/sheets**

Add just before the closing `</PageContainer>` (next to `EditMeetingDialog`/`AssignSlotSheet`), inside the `canManage` region:

```tsx
			<Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add a role</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const roleId = String(
								new FormData(e.currentTarget).get("roleDefinitionId") ?? "",
							);
							if (roleId) void doAddRole(roleId);
						}}
						className="space-y-4"
					>
						<div className="space-y-2">
							<Label htmlFor="roleDefinitionId">Role</Label>
							<select
								id="roleDefinitionId"
								name="roleDefinitionId"
								required
								className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								{addableRoles.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
									</option>
								))}
							</select>
							<p className="text-xs text-muted-foreground">
								Picking a role already on this meeting adds another instance
								(e.g. “Timer 2”).
							</p>
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline">
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" disabled={busySlotId === "add-role"}>
								{busySlotId === "add-role" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Add role"
								)}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
```

- [ ] **Step 6: Lint + typecheck**

Run: `bun run check`
Expected: no lint/format errors (fix any it reports).

Run: `bun run build`
Expected: build succeeds. Then `git checkout src/routeTree.gen.ts`.

- [ ] **Step 7: Manual smoke (dev server)**

Start dev (`bun run dev`), open a meeting you can manage. Verify: "+ Add role" lists non-speaker roles; adding one shows it in its category section as Open; a trash icon appears on unclaimed non-speaker slots and removes them; the trash does NOT appear on speaker/paired-evaluator slots or claimed slots.

- [ ] **Step 8: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
git add src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(#143): meeting view — add-role dialog + per-slot remove"
```

---

## Task 8: Roles-page UI — sync button + toast-with-action nudge

**Files:**
- Modify: `src/routes/_authed/admin/roles.tsx`

- [ ] **Step 1: Import the sync fn**

Add to the `#/server/role-definitions` import:

```ts
import {
	createClubRole,
	deleteClubRole,
	listClubRoles,
	reorderClubRoles,
	syncTemplateToUpcomingMeetings,
	updateClubRole,
} from "#/server/role-definitions";
```

- [ ] **Step 2: Add a `syncUpcoming` runner + state in `RolesManager`**

Inside `RolesManager`, add:

```ts
	const [syncing, setSyncing] = useState(false);
	async function syncUpcoming() {
		setSyncing(true);
		try {
			const res = await syncTemplateToUpcomingMeetings({
				data: { clubId, actorMemberId: null },
			});
			if (res.meetingsChanged === 0) {
				toast.success("Upcoming meetings already match the standard set.");
			} else {
				const plural = res.meetingsChanged === 1 ? "" : "s";
				toast.success(
					`Added ${res.rolesAdded.join(", ")} to ${res.meetingsChanged} upcoming meeting${plural}.`,
				);
			}
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't update meetings.",
			);
		} finally {
			setSyncing(false);
		}
	}
```

Add `useState` to the React import if it isn't there already (it is — `roles.tsx` already imports `useState`).

- [ ] **Step 3: Add the sync button in the header block**

In the header `<div>` (the one with the `<h1>Meeting roles</h1>` and the paragraph), wrap the existing content and add the button. Replace the opening `<div>` and its children's container with a flex row:

```tsx
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
						Meeting roles
					</h1>
					<p className="text-sm text-muted-foreground">
						The role template for {adminClub.name}. Descriptions show on the
						sign-up sheet and the public shared agenda. Changing a role's default
						count only affects meetings created afterwards — existing meetings
						keep their slots.
					</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={syncUpcoming}
					disabled={syncing}
				>
					{syncing ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Update upcoming meetings to match"
					)}
				</Button>
			</div>
```

- [ ] **Step 4: Pass `onSync` into `AddRoleForm` and fire the nudge**

Change the `AddRoleForm` usage:

```tsx
			<AddRoleForm
				clubId={clubId}
				onAdded={() => router.invalidate()}
				onSync={syncUpcoming}
			/>
```

Update `AddRoleForm`'s signature and success toast:

```tsx
function AddRoleForm({
	clubId,
	onAdded,
	onSync,
}: {
	clubId: string;
	onAdded: () => Promise<void> | void;
	onSync: () => Promise<void> | void;
}) {
```

Replace the `toast.success("Role added.");` line with a non-blocking action toast:

```tsx
			toast.success("Role added.", {
				action: {
					label: "Update upcoming meetings",
					onClick: () => {
						void onSync();
					},
				},
			});
```

- [ ] **Step 5: Lint + typecheck**

Run: `bun run check`
Expected: clean.

Run: `bun run build`
Expected: succeeds. Then `git checkout src/routeTree.gen.ts`.

- [ ] **Step 6: Manual smoke**

On the roles page: "Update upcoming meetings to match" reports a specific toast (or "already match"); adding a new role shows a "Role added." toast with an "Update upcoming meetings" action that runs the sync.

- [ ] **Step 7: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
git add src/routes/_authed/admin/roles.tsx
git commit -m "feat(#143): roles page — template-sync button + add-role nudge"
```

---

## Task 9: Full verification

- [ ] **Step 1: Full lint/format gate**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 2: Full test suite with the DB**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: PASS — including the new `meeting-roles-mgmt` and `meeting-roles` suites and the unchanged `server-modules.guard` suite.

- [ ] **Step 3: Full build**

Run: `bun run build`
Expected: succeeds. Revert the route-tree artifact: `git checkout src/routeTree.gen.ts`.

- [ ] **Step 4: Final commit (only if anything is uncommitted)**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
git status
```

---

## Self-review notes (spec coverage)

- Per-meeting add any non-paired role, duplicates → Task 2 + Task 7.
- Per-meeting remove unclaimed non-paired slot → Task 3 + Task 7.
- Template-level, presence-based sync (`defaultCount ≥ 1`, non-paired, `scheduledAt > now`, skip-if-present) → Task 4 + Task 8.
- Speaker/paired-evaluator excluded from add, remove, sync (UI + server) → `pairedRoleIds` (Task 1) applied in Tasks 2/3/4 and the UI filters in Tasks 7/8.
- Admin/VPE only → Task 5 guards (`requireClubRole` admin).
- No blocking confirms; toast-with-action nudge + persistent button; specific result toast → Task 8.
- Per-meeting has no date gate; bulk is future-only → Task 4 uses `gt(scheduledAt, now)`; per-meeting fns have no date check.
- Race safety: inserts of new open slots / delete of an unclaimed slot only; never mutates existing assignment/status → Tasks 2–4.
- Module boundary (db logic in `*-logic.ts`) → Task 5 verified by `server-modules.guard.test.ts`.
```
