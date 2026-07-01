# Manage a Meeting (edit meta + variable speakers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in VPE/admin edit a meeting's meta (theme, Word of the Day, location, notes, time) and vary its speaker count (add / remove / reorder, with evaluators tracking by count) from the authed meeting page.

**Architecture:** Pure helpers in `src/lib/` (a datetime inverse for the reschedule prefill; a role-picker heuristic). DB logic in new `*-logic.ts` siblings (`meetings-logic.ts`, `slots-logic.ts`) — required because `meetings.ts`/`slots.ts` are `createServerFn` modules the guard test forbids from exporting db-touching functions. Thin `createServerFn` wrappers do auth (`requireClubRole(admin/vpe)`) then call the logic in a transaction. Activity reuses the existing `meeting_edit` action with a `detail.change` discriminator.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM + node-postgres, Zod, Vitest, Biome (tabs + double quotes), shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-01-manage-meeting-design.md`

**Working dir:** worktree `../tm-scheduler-manage-meeting` (branch `feat/manage-meeting`). Run `bun install` once before starting.

**Integration tests** run against `tm_test` and self-skip without `TEST_DATABASE_URL`. Run them with:
`TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run <path>`

---

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `src/lib/datetime.ts` | modify | add `utcToZonedWallTime` (UTC → `YYYY-MM-DDTHH:mm` in zone) for reschedule prefill |
| `src/lib/datetime.test.ts` | modify | round-trip test |
| `src/lib/meeting-roles.ts` | create | `pickSpeakerAndEvaluatorRoles` heuristic (pure) |
| `src/lib/meeting-roles.test.ts` | create | heuristic unit tests |
| `src/server/meetings-logic.ts` | create | `applyMeetingUpdate` |
| `src/server/slots-logic.ts` | create | `applyAddSpeakerSlot`, `applyRemoveSpeakerSlot`, `applyMoveSpeakerSlot` |
| `src/server/meetings.ts` | modify | `updateMeeting` server-fn wrapper |
| `src/server/slots.ts` | modify | `addSpeakerSlot` / `removeSpeakerSlot` / `moveSpeakerSlot` wrappers |
| `src/server/activity-feed-logic.ts` | modify | surface `detail.change` as `ActivityEntry.change` |
| `src/lib/activity-format.ts` | modify | `meeting_edit` formatter case (+ change variants) |
| `src/lib/activity-format.test.ts` | modify | formatter cases |
| `src/server/meeting-manage.integration.test.ts` | create | DB tests for update + add/remove/move |
| `src/routes/_authed/meetings.$id.tsx` | modify | Edit-meta dialog + speaker add/remove/reorder controls |

---

## Task 1: datetime inverse for reschedule prefill

**Files:**
- Modify: `src/lib/datetime.ts`
- Modify: `src/lib/datetime.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/datetime.test.ts`:

```ts
import { utcToZonedWallTime, zonedWallTimeToUtc } from "./datetime";

describe("utcToZonedWallTime", () => {
	it("formats a UTC instant as wall time in the zone", () => {
		// 2026-03-01T02:30Z is 2026-02-28 18:30 in America/Los_Angeles (UTC-8)
		const s = utcToZonedWallTime(new Date("2026-03-01T02:30:00Z"), "America/Los_Angeles");
		expect(s).toBe("2026-02-28T18:30");
	});

	it("round-trips with zonedWallTimeToUtc", () => {
		const wall = "2026-07-04T19:15";
		const utc = zonedWallTimeToUtc(wall, "America/Chicago");
		expect(utcToZonedWallTime(utc, "America/Chicago")).toBe(wall);
	});
});
```

(If `datetime.test.ts` has no `describe`/`import` yet, also add `import { describe, expect, it } from "vitest";` at the top — check first.)

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/datetime.test.ts`
Expected: FAIL — `utcToZonedWallTime` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/datetime.ts`:

```ts
/**
 * Inverse of `zonedWallTimeToUtc`: render a UTC instant as a
 * `YYYY-MM-DDTHH:mm` wall-clock string in `timeZone`, suitable for a
 * `datetime-local` input value.
 */
export function utcToZonedWallTime(instant: Date, timeZone: string): string {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const p = Object.fromEntries(
		dtf.formatToParts(instant).map((x) => [x.type, x.value]),
	);
	const hour = p.hour === "24" ? "00" : p.hour;
	return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/lib/datetime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/datetime.ts src/lib/datetime.test.ts
git commit -m "feat(datetime): utcToZonedWallTime for reschedule prefill"
```

---

## Task 2: speaker/evaluator role picker (heuristic)

**Files:**
- Create: `src/lib/meeting-roles.ts`
- Create: `src/lib/meeting-roles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/meeting-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickSpeakerAndEvaluatorRoles, type RoleDefLite } from "./meeting-roles";

const def = (over: Partial<RoleDefLite>): RoleDefLite => ({
	id: "x",
	category: "functionary",
	defaultCount: 1,
	sortOrder: 0,
	isSpeakerRole: false,
	...over,
});

describe("pickSpeakerAndEvaluatorRoles", () => {
	it("picks the speaker role and the highest-count evaluator (not General Evaluator)", () => {
		const defs = [
			def({ id: "spk", category: "speaker", isSpeakerRole: true, defaultCount: 3, sortOrder: 2 }),
			def({ id: "ev", category: "evaluator", defaultCount: 3, sortOrder: 3 }),
			def({ id: "gen", category: "evaluator", defaultCount: 1, sortOrder: 4 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs)).toEqual({
			speakerRoleId: "spk",
			evaluatorRoleId: "ev",
		});
	});

	it("returns null evaluator when the club has no evaluator role", () => {
		const defs = [def({ id: "spk", isSpeakerRole: true, category: "speaker" })];
		expect(pickSpeakerAndEvaluatorRoles(defs)).toEqual({
			speakerRoleId: "spk",
			evaluatorRoleId: null,
		});
	});

	it("breaks evaluator ties by lowest sortOrder", () => {
		const defs = [
			def({ id: "spk", isSpeakerRole: true, category: "speaker" }),
			def({ id: "a", category: "evaluator", defaultCount: 2, sortOrder: 5 }),
			def({ id: "b", category: "evaluator", defaultCount: 2, sortOrder: 1 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs).evaluatorRoleId).toBe("b");
	});

	it("picks the lowest-sortOrder speaker role when several exist", () => {
		const defs = [
			def({ id: "s2", isSpeakerRole: true, category: "speaker", sortOrder: 9 }),
			def({ id: "s1", isSpeakerRole: true, category: "speaker", sortOrder: 2 }),
		];
		expect(pickSpeakerAndEvaluatorRoles(defs).speakerRoleId).toBe("s1");
	});

	it("throws when there is no speaker role", () => {
		expect(() => pickSpeakerAndEvaluatorRoles([def({ category: "evaluator" })])).toThrow();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/meeting-roles.ts`:

```ts
/** Minimal role-definition shape needed to choose speaker/evaluator roles. */
export interface RoleDefLite {
	id: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
}

export interface SpeakerEvaluatorRoles {
	speakerRoleId: string;
	/** null when the club defines no evaluator-category role. */
	evaluatorRoleId: string | null;
}

/**
 * Choose the club's speaker role and the evaluator role paired with it.
 * - Speaker = the `isSpeakerRole` def (lowest `sortOrder` if several).
 * - Paired evaluator = the `category === "evaluator"` def with the highest
 *   `defaultCount` (tie → lowest `sortOrder`). For the standard template this is
 *   "Evaluator" (3), not "General Evaluator" (1). Heuristic, not a modeled link.
 * Throws when there is no speaker role.
 */
export function pickSpeakerAndEvaluatorRoles(
	defs: RoleDefLite[],
): SpeakerEvaluatorRoles {
	const speaker = defs
		.filter((d) => d.isSpeakerRole)
		.sort((a, b) => a.sortOrder - b.sortOrder)[0];
	if (!speaker) throw new Error("This club has no speaker role.");
	const evaluator = defs
		.filter((d) => d.category === "evaluator")
		.sort((a, b) => b.defaultCount - a.defaultCount || a.sortOrder - b.sortOrder)[0];
	return { speakerRoleId: speaker.id, evaluatorRoleId: evaluator?.id ?? null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-roles.ts src/lib/meeting-roles.test.ts
git commit -m "feat(meeting-roles): speaker + paired-evaluator picker heuristic"
```

---

## Task 3: `applyMeetingUpdate` logic

**Files:**
- Create: `src/server/meetings-logic.ts`

- [ ] **Step 1: Implement the logic module**

Create `src/server/meetings-logic.ts`:

```ts
// Meeting-management DB logic, split out from the createServerFn wrappers in
// `meetings.ts` (which the server-modules guard test forbids from exporting
// db-touching functions). Directly integration-testable by mocking `#/db`.
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import { logActivity } from "./activity";

export interface MeetingUpdateInput {
	meetingId: string;
	actorMemberId: string | null;
	/** HTML datetime-local value, interpreted in the club timezone. */
	scheduledAt: string;
	theme?: string | null;
	location?: string | null;
	wordOfTheDay?: string | null;
	notes?: string | null;
}

/** Update a meeting's meta (incl. reschedule) and log a `meeting_edit`. */
export async function applyMeetingUpdate(input: MeetingUpdateInput) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const club = await db.query.clubs.findFirst({
		where: eq(clubs.id, meeting.clubId),
	});
	if (!club) throw new Error("Club not found.");

	const next = {
		scheduledAt: zonedWallTimeToUtc(input.scheduledAt, club.timezone),
		theme: input.theme?.trim() || null,
		location: input.location?.trim() || null,
		wordOfTheDay: input.wordOfTheDay?.trim() || null,
		notes: input.notes?.trim() || null,
	};

	await db.transaction(async (tx) => {
		await tx.update(meetings).set(next).where(eq(meetings.id, input.meetingId));
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				before: {
					theme: meeting.theme,
					wordOfTheDay: meeting.wordOfTheDay,
					location: meeting.location,
					notes: meeting.notes,
					scheduledAt: meeting.scheduledAt,
				},
				after: next,
			},
		});
	});

	return { clubId: meeting.clubId };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/meetings-logic.ts
git commit -m "feat(meetings): applyMeetingUpdate logic"
```

---

## Task 4: speaker slot logic (`applyAddSpeakerSlot`, `applyRemoveSpeakerSlot`, `applyMoveSpeakerSlot`)

**Files:**
- Create: `src/server/slots-logic.ts`

- [ ] **Step 1: Implement the logic module**

Create `src/server/slots-logic.ts`:

```ts
// Speaker-slot management DB logic, split out from `slots.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import { pickSpeakerAndEvaluatorRoles } from "#/lib/meeting-roles";
import { logActivity } from "./activity";

async function clubRoles(clubId: string) {
	const defs = await db
		.select({
			id: roleDefinitions.id,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
	return pickSpeakerAndEvaluatorRoles(defs);
}

/** Next 0-based slotIndex for a (meeting, role) pair. */
function nextIndex(indices: number[]): number {
	return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

/** Add one Speaker slot (+ a paired Evaluator slot, count-parity). */
export async function applyAddSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId } = await clubRoles(meeting.clubId);

	const existing = await db
		.select({ roleDefinitionId: roleSlots.roleDefinitionId, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, input.meetingId));
	const idxFor = (roleId: string) =>
		nextIndex(existing.filter((s) => s.roleDefinitionId === roleId).map((s) => s.slotIndex));

	await db.transaction(async (tx) => {
		await tx.insert(roleSlots).values({
			meetingId: input.meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: idxFor(speakerRoleId),
		});
		if (evaluatorRoleId) {
			await tx.insert(roleSlots).values({
				meetingId: input.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: idxFor(evaluatorRoleId),
			});
		}
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_added" },
		});
	});
	return { clubId: meeting.clubId };
}

/** Highest-index unclaimed (open, unassigned) slot id for a role, or null. */
function topUnclaimed(
	slots: { id: string; slotIndex: number; status: string; assignedMemberId: string | null }[],
	roleId: string,
	roleOf: (id: string) => string,
): string | null {
	const open = slots
		.filter((s) => roleOf(s.id) === roleId && s.status === "open" && !s.assignedMemberId)
		.sort((a, b) => b.slotIndex - a.slotIndex);
	return open[0]?.id ?? null;
}

/** Remove one unclaimed Speaker slot (+ one unclaimed Evaluator, best-effort). */
export async function applyRemoveSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId } = await clubRoles(meeting.clubId);

	const slots = await db
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, input.meetingId));
	const roleOf = (id: string) =>
		slots.find((s) => s.id === id)?.roleDefinitionId ?? "";

	const speakerId = topUnclaimed(slots, speakerRoleId, roleOf);
	if (!speakerId) throw new Error("Release a speaker before removing a slot.");
	const evaluatorId = evaluatorRoleId
		? topUnclaimed(slots, evaluatorRoleId, roleOf)
		: null;

	await db.transaction(async (tx) => {
		await tx.delete(roleSlots).where(eq(roleSlots.id, speakerId));
		if (evaluatorId) {
			await tx.delete(roleSlots).where(eq(roleSlots.id, evaluatorId));
		}
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_removed" },
		});
	});
	return { clubId: meeting.clubId };
}

/** Swap a speaker slot's position with its neighbor (up = lower index). */
export async function applyMoveSpeakerSlot(input: {
	slotId: string;
	direction: "up" | "down";
	actorMemberId: string | null;
}) {
	const [target] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			clubId: meetings.clubId,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!target) throw new Error("Speaker slot not found.");

	const siblings = await db
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, target.meetingId),
				eq(roleSlots.roleDefinitionId, target.roleDefinitionId),
			),
		);
	const ordered = siblings.sort((a, b) => a.slotIndex - b.slotIndex);
	const pos = ordered.findIndex((s) => s.id === target.id);
	const neighbor = input.direction === "up" ? ordered[pos - 1] : ordered[pos + 1];
	if (!neighbor) throw new Error("No slot to swap with.");

	await db.transaction(async (tx) => {
		await tx
			.update(roleSlots)
			.set({ slotIndex: neighbor.slotIndex })
			.where(eq(roleSlots.id, target.id));
		await tx
			.update(roleSlots)
			.set({ slotIndex: target.slotIndex })
			.where(eq(roleSlots.id, neighbor.id));
		await logActivity(tx, {
			clubId: target.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: target.meetingId,
			detail: { change: "speaker_reordered" },
		});
	});
	return { clubId: target.clubId };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/slots-logic.ts
git commit -m "feat(slots): add/remove/move speaker slot logic"
```

---

## Task 5: server-fn wrappers (auth) for meeting update + speaker slots

**Files:**
- Modify: `src/server/meetings.ts`
- Modify: `src/server/slots.ts`

- [ ] **Step 1: Add `updateMeeting` to `meetings.ts`**

At the top, add the logic import (next to the other `#/lib`/local imports):

```ts
import { applyMeetingUpdate } from "./meetings-logic";
```

After the `createMeeting` export, add:

```ts
const updateMeetingSchema = z.object({
	meetingId: uuid,
	actorMemberId: uuid.nullable().optional(),
	scheduledAt: z.string().min(1),
	location: z.string().trim().optional(),
	theme: z.string().trim().optional(),
	wordOfTheDay: z.string().trim().optional(),
	notes: z.string().trim().optional(),
});

/** Admin/VPE only: edit a meeting's meta (incl. reschedule). AUTHED. */
export const updateMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateMeetingSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const meeting = await db.query.meetings.findFirst({
			where: eq(meetings.id, data.meetingId),
		});
		if (!meeting) throw new Error("Meeting not found.");
		await requireClubRole(currentUser.id, meeting.clubId, ["admin", "vpe"]);
		return applyMeetingUpdate({
			...data,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
```

(`requireUser`, `requireClubRole`, `eq`, `meetings`, `uuid`, `z` are already imported in `meetings.ts` — verify; `uuid` is the `z.string().uuid()` const defined near the top.)

- [ ] **Step 2: Add the three speaker wrappers to `slots.ts`**

At the top of `slots.ts`, add:

```ts
import {
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
} from "./slots-logic";
```

At the end of `slots.ts`, add:

```ts
const speakerSlotSchema = z.object({
	meetingId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});

async function requireMeetingManager(meetingId: string) {
	const currentUser = await requireUser();
	const [row] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	await requireClubRole(currentUser.id, row.clubId, ["admin", "vpe"]);
}

/** Admin/VPE: add a speaker slot (+ paired evaluator). AUTHED. */
export const addSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingManager(data.meetingId);
		return applyAddSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

/** Admin/VPE: remove an unclaimed speaker slot (+ unclaimed evaluator). AUTHED. */
export const removeSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		await requireMeetingManager(data.meetingId);
		return applyRemoveSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: data.actorMemberId ?? null,
		});
	});

const moveSpeakerSchema = z.object({
	slotId: z.string().uuid(),
	direction: z.enum(["up", "down"]),
	actorMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE: reorder a speaker slot up/down (swaps slotIndex). AUTHED. */
export const moveSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Speaker slot not found.");
		const currentUser = await requireUser();
		await requireClubRole(currentUser.id, row.clubId, ["admin", "vpe"]);
		return applyMoveSpeakerSlot({
			slotId: data.slotId,
			direction: data.direction,
			actorMemberId: data.actorMemberId ?? null,
		});
	});
```

(`slots.ts` already imports `requireClubRole`, `requireUser`, `meetings`, `roleSlots`, `eq`, `z`, `db` — verify each; add any missing to the existing import lines.)

- [ ] **Step 3: Verify build + guard test**

Run: `bun run build && bunx vitest run src/server/server-modules.guard.test.ts`
Expected: build compiles; guard test passes (db logic lives in `*-logic.ts`, wrappers export only server fns).

- [ ] **Step 4: Commit**

```bash
git add src/server/meetings.ts src/server/slots.ts
git commit -m "feat(server): updateMeeting + add/remove/move speaker slot wrappers"
```

---

## Task 6: DB-backed integration tests

**Files:**
- Create: `src/server/meeting-manage.integration.test.ts`

- [ ] **Step 1: Write the tests**

Create `src/server/meeting-manage.integration.test.ts`:

```ts
/**
 * DB-backed tests for meeting management (edit meta + variable speakers).
 * Tests the plain logic fns directly (`#/db` redirected to the test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-manage.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, roleDefinitions, roleSlots } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
} = await import("./slots-logic");
const { applyMeetingUpdate } = await import("./meetings-logic");

/** Add a speaker + evaluator role def to the seeded club; return their ids. */
async function addSpeakerAndEvaluatorRoles(clubId: string) {
	const [spk] = await testDb
		.insert(roleDefinitions)
		.values({ clubId, name: "Speaker", category: "speaker", defaultCount: 3, sortOrder: 10, isSpeakerRole: true })
		.returning({ id: roleDefinitions.id });
	const [ev] = await testDb
		.insert(roleDefinitions)
		.values({ clubId, name: "Evaluator", category: "evaluator", defaultCount: 3, sortOrder: 11, isSpeakerRole: false })
		.returning({ id: roleDefinitions.id });
	await testDb
		.insert(roleDefinitions)
		.values({ clubId, name: "General Evaluator", category: "evaluator", defaultCount: 1, sortOrder: 12, isSpeakerRole: false });
	return { speakerRoleId: spk.id, evaluatorRoleId: ev.id };
}

async function slotsFor(meetingId: string, roleId: string) {
	return testDb
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex, status: roleSlots.status, assignedMemberId: roleSlots.assignedMemberId })
		.from(roleSlots)
		.where(and(eq(roleSlots.meetingId, meetingId), eq(roleSlots.roleDefinitionId, roleId)))
		.orderBy(roleSlots.slotIndex);
}

describe.skipIf(!hasTestDb)("meeting management", () => {
	let club: SeededClub;
	let speakerRoleId: string;
	let evaluatorRoleId: string;

	beforeEach(async () => {
		club = await seedClub();
		const roles = await addSpeakerAndEvaluatorRoles(club.clubId);
		speakerRoleId = roles.speakerRoleId;
		evaluatorRoleId = roles.evaluatorRoleId;
	});
	afterEach(cleanup);

	it("updateMeeting writes fields + logs meeting_edit", async () => {
		await applyMeetingUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			scheduledAt: "2026-08-01T18:30",
			theme: "  New Beginnings  ",
			wordOfTheDay: "verve",
		});
		const [m] = await testDb.select().from(activityLog).where(eq(activityLog.action, "meeting_edit"));
		expect(m).toBeTruthy();
	});

	it("addSpeakerSlot adds a paired speaker + evaluator", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(1);
	});

	it("removeSpeakerSlot removes the top unclaimed speaker + an evaluator", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		await applyRemoveSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(1);
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(1);
	});

	it("removeSpeakerSlot errors when every speaker is claimed", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		const [spk] = await slotsFor(club.meetingId, speakerRoleId);
		await testDb.update(roleSlots).set({ status: "claimed", assignedMemberId: club.memberId }).where(eq(roleSlots.id, spk.id));
		await expect(
			applyRemoveSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId }),
		).rejects.toThrow(/Release a speaker/);
	});

	it("removing down to 0 speakers succeeds", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		await applyRemoveSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		expect(await slotsFor(club.meetingId, speakerRoleId)).toHaveLength(0);
	});

	it("moveSpeakerSlot swaps adjacent speaker indices, leaving evaluators", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		const before = await slotsFor(club.meetingId, speakerRoleId); // [idx0, idx1]
		await applyMoveSpeakerSlot({ slotId: before[1].id, direction: "up", actorMemberId: club.memberId });
		const after = await slotsFor(club.meetingId, speakerRoleId);
		expect(after[0].id).toBe(before[1].id); // the second slot is now first
		expect(await slotsFor(club.meetingId, evaluatorRoleId)).toHaveLength(2);
	});

	it("moveSpeakerSlot errors at the boundary", async () => {
		await applyAddSpeakerSlot({ meetingId: club.meetingId, actorMemberId: club.memberId });
		const [only] = await slotsFor(club.meetingId, speakerRoleId);
		await expect(
			applyMoveSpeakerSlot({ slotId: only.id, direction: "up", actorMemberId: club.memberId }),
		).rejects.toThrow(/No slot to swap/);
	});
});
```

- [ ] **Step 2: Run the integration tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-manage.integration.test.ts`
Expected: PASS (7 tests). If `tm_test` doesn't exist yet, create it: `docker exec dev-postgres psql -U dev -d postgres -c "CREATE DATABASE tm_test;"` then apply migrations: `DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:migrate`.

- [ ] **Step 3: Commit**

```bash
git add src/server/meeting-manage.integration.test.ts
git commit -m "test(meeting): integration coverage for update + speaker add/remove/move"
```

---

## Task 7: surface `detail.change` in the activity feed + formatter

**Files:**
- Modify: `src/server/activity-feed-logic.ts`
- Modify: `src/lib/activity-format.ts`
- Modify: `src/lib/activity-format.test.ts`

- [ ] **Step 1: Write the failing formatter test**

Append to `src/lib/activity-format.test.ts` (matching the existing test style — construct a minimal `ActivityEntry`):

```ts
it("formats meeting_edit variants from detail.change", () => {
	const base = {
		id: "1", createdAt: new Date(), actorName: "Rasheed",
		targetType: "meeting" as const, roleName: null, meetingId: "m",
		meetingScheduledAt: null, subjectName: null, fromName: null,
	};
	expect(formatActivity({ ...base, action: "meeting_edit", change: "speaker_added" }).summary).toBe("added a speaker");
	expect(formatActivity({ ...base, action: "meeting_edit", change: "speaker_removed" }).summary).toBe("removed a speaker");
	expect(formatActivity({ ...base, action: "meeting_edit", change: "speaker_reordered" }).summary).toBe("reordered speakers");
	expect(formatActivity({ ...base, action: "meeting_edit", change: null }).summary).toBe("updated the meeting");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/activity-format.test.ts`
Expected: FAIL — `change` not on `ActivityEntry` type / summary mismatch.

- [ ] **Step 3: Add `change` to the activity pipeline**

In `src/server/activity-feed-logic.ts`:

- Extend `LogDetail`:

```ts
type LogDetail = {
	memberId?: string;
	fromMemberId?: string;
	name?: string;
	change?: string;
};
```

- Add `change` to the `ActivityEntry` interface (after `fromName`):

```ts
	fromName: string | null;
	/** meeting_edit → agenda-structure change (speaker_added | speaker_removed | speaker_reordered) */
	change: string | null;
```

- In the `rows.map((r): ActivityEntry => { ... return { ... } })`, add to the returned object:

```ts
		fromName: d.fromMemberId
			? (memberName.get(d.fromMemberId) ?? null)
			: null,
		change: d.change ?? null,
```

- [ ] **Step 4: Add the formatter case**

In `src/lib/activity-format.ts`, add before `default:` in the switch:

```ts
		case "meeting_create":
			summary = "created the meeting";
			break;
		case "meeting_edit":
			switch (entry.change) {
				case "speaker_added":
					summary = "added a speaker";
					break;
				case "speaker_removed":
					summary = "removed a speaker";
					break;
				case "speaker_reordered":
					summary = "reordered speakers";
					break;
				default:
					summary = "updated the meeting";
			}
			break;
```

- [ ] **Step 5: Run to verify it passes**

Run: `bunx vitest run src/lib/activity-format.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/activity-feed-logic.ts src/lib/activity-format.ts src/lib/activity-format.test.ts
git commit -m "feat(activity): render meeting_edit + speaker-change feed lines"
```

---

## Task 8: Edit-meta dialog on the meeting page

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Add imports + Dialog**

Add to the imports:

```ts
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { utcToZonedWallTime } from "#/lib/datetime";
import { updateMeeting } from "#/server/meetings";
import {
	addSpeakerSlot,
	moveSpeakerSlot,
	removeSpeakerSlot,
} from "#/server/slots";
```

- [ ] **Step 2: Add edit state + Edit button in the header**

In `MeetingDetail`, add near the other `useState`:

```ts
	const [editOpen, setEditOpen] = useState(false);
```

In the header (`<header>`), after the `<ShareLinkButton .../>`, add (only when manageable):

```tsx
				{canManage ? (
					<Button
						size="sm"
						variant="outline"
						className="mt-1 ml-2"
						onClick={() => setEditOpen(true)}
					>
						Edit meeting
					</Button>
				) : null}
```

- [ ] **Step 3: Render the dialog (before the closing `</div>` of MeetingDetail, next to `ClaimSpeakerSheet`)**

```tsx
			{canManage ? (
				<EditMeetingDialog
					open={editOpen}
					onOpenChange={setEditOpen}
					meeting={meeting}
					timezone={timezone}
					actorMemberId={currentMemberId}
					onSaved={async () => {
						setEditOpen(false);
						await router.invalidate();
					}}
				/>
			) : null}
```

- [ ] **Step 4: Implement `EditMeetingDialog` (add at the end of the file)**

```tsx
function EditMeetingDialog({
	open,
	onOpenChange,
	meeting,
	timezone,
	actorMemberId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	actorMemberId: string | null;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const scheduledAt = String(form.get("scheduledAt") ?? "");
		if (!scheduledAt) {
			toast.error("Date & time is required.");
			return;
		}
		setSubmitting(true);
		try {
			await updateMeeting({
				data: {
					meetingId: meeting.id,
					actorMemberId,
					scheduledAt,
					theme: String(form.get("theme") ?? "").trim() || undefined,
					location: String(form.get("location") ?? "").trim() || undefined,
					wordOfTheDay: String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					notes: String(form.get("notes") ?? "").trim() || undefined,
				},
			});
			toast.success("Meeting updated.");
			await onSaved();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit meeting</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="scheduledAt">Date &amp; time</Label>
						<Input
							id="scheduledAt"
							name="scheduledAt"
							type="datetime-local"
							required
							defaultValue={utcToZonedWallTime(new Date(meeting.scheduledAt), timezone)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="theme">Theme</Label>
						<Input id="theme" name="theme" defaultValue={meeting.theme ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="location">Location</Label>
						<Input id="location" name="location" defaultValue={meeting.location ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="wordOfTheDay">Word of the day</Label>
						<Input id="wordOfTheDay" name="wordOfTheDay" defaultValue={meeting.wordOfTheDay ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={submitting}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={submitting}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : "Save changes"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 5: Verify build + lint**

Run: `bun run build && bun run check`
Expected: no errors. Confirm `meeting.notes` is present on the `getMeeting` return type (it is — `loadMeetingDetail` returns the full meeting row); if TS complains, the field exists on `meeting`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authed/meetings.$id.tsx
git commit -m "feat(meeting-ui): edit meeting meta dialog (VPE)"
```

---

## Task 9: speaker add / remove / reorder controls

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Add speaker-management handlers + count**

In `MeetingDetail`, after the existing `do*` handlers, add:

```ts
	const speakerSlots = slots.filter((s) => s.isSpeakerRole);

	async function doAddSpeaker() {
		setBusySlotId("add-speaker");
		try {
			await addSpeakerSlot({ data: { meetingId: meeting.id, actorMemberId: currentMemberId } });
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRemoveSpeaker() {
		if (speakerSlots.length <= 1) {
			const ok = window.confirm("This meeting will have no speakers. Continue?");
			if (!ok) return;
		}
		setBusySlotId("remove-speaker");
		try {
			await removeSpeakerSlot({ data: { meetingId: meeting.id, actorMemberId: currentMemberId } });
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doMoveSpeaker(slot: Slot, direction: "up" | "down") {
		setBusySlotId(slot.id);
		try {
			await moveSpeakerSlot({ data: { slotId: slot.id, direction, actorMemberId: currentMemberId } });
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}
```

- [ ] **Step 2: Add ↑/↓ reorder controls to speaker slots**

Inside the slot `<li>`'s action column (`<div className="flex shrink-0 flex-col gap-2">`), at the top, add reorder controls for manageable speaker slots:

```tsx
											{canManage && slot.isSpeakerRole ? (
												<div className="flex gap-1">
													<Button
														size="sm"
														variant="ghost"
														aria-label="Move speaker up"
														disabled={busy || speakerSlots[0]?.id === slot.id}
														onClick={() => doMoveSpeaker(slot, "up")}
													>
														↑
													</Button>
													<Button
														size="sm"
														variant="ghost"
														aria-label="Move speaker down"
														disabled={busy || speakerSlots[speakerSlots.length - 1]?.id === slot.id}
														onClick={() => doMoveSpeaker(slot, "down")}
													>
														↓
													</Button>
												</div>
											) : null}
```

(`speakerSlots` is in display order because `slots` arrives sorted by `sortOrder, slotIndex`.)

- [ ] **Step 3: Add + Add / − Remove speaker buttons under the Speakers section**

In the `categories.map((category) => ...)` render, after the `</ul>` of a section, add speaker controls when it's the speaker category and manageable. Replace the section's closing so it reads:

```tsx
						</ul>
						{canManage && category === "speaker" ? (
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="outline"
									disabled={busySlotId === "add-speaker"}
									onClick={doAddSpeaker}
								>
									+ Add speaker
								</Button>
								{speakerSlots.length > 0 ? (
									<Button
										size="sm"
										variant="outline"
										disabled={busySlotId === "remove-speaker"}
										onClick={doRemoveSpeaker}
									>
										− Remove speaker
									</Button>
								) : null}
							</div>
						) : null}
					</section>
```

Edge: when a club/meeting has **zero** speaker slots, the `"speaker"` category won't appear in `categories` (which is derived from existing slots), so "+ Add speaker" would vanish. To always allow adding the first speaker back, render a standalone add control when `canManage && speakerSlots.length === 0`, right after the `categories.map(...)` block:

```tsx
				{canManage && speakerSlots.length === 0 ? (
					<section className="space-y-2">
						<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							{CATEGORY_LABELS.speaker}
						</h2>
						<Button size="sm" variant="outline" onClick={doAddSpeaker} disabled={busySlotId === "add-speaker"}>
							+ Add speaker
						</Button>
					</section>
				) : null}
```

- [ ] **Step 4: Verify build + lint**

Run: `bun run build && bun run check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_authed/meetings.$id.tsx
git commit -m "feat(meeting-ui): add/remove/reorder speaker slots (VPE)"
```

---

## Task 10: full verification + browser QA

**Files:** none (verification)

- [ ] **Step 1: Full gate**

Run:
```bash
bun run check
bun run build
TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test
```
Expected: `check` clean, `build` compiles, all Vitest suites green (unit + the new integration suite; others may skip without the test DB — the meeting-manage suite runs because TEST_DATABASE_URL is set).

- [ ] **Step 2: Browser QA (dev-login as the seeded admin)**

Start the dev server against local dev DB (`ENABLE_DEV_LOGIN=1 bun run dev`, detached), dev-login as `rasheed.bustamam@gmail.com`, open a meeting page (`/meetings/<id>` — find one via the schedule/agenda), and confirm as VPE:
- **Edit meeting** opens pre-filled (incl. date/time in club zone); saving updates the header.
- **+ Add speaker** adds a Speaker (and an Evaluator appears under Evaluation).
- **− Remove speaker** removes one; removing the last prompts the zero-speaker confirm.
- **↑/↓** reorder swaps two speakers; disabled at the ends.
- No console errors. (Use the `/browse` skill.)

- [ ] **Step 3: No commit** (verification only). Fix any issue in the relevant task and re-run.

---

## Self-review notes (coverage)

- Spec Feature 1 (edit meta + reschedule + `meeting_edit` formatting) → Tasks 1, 3, 5, 7, 8.
- Spec Feature 2 (add/remove/reorder, evaluator count-parity, heuristic, stable slotIndex, 0-speaker warn, no gating) → Tasks 2, 4, 5, 6, 9.
- Activity logging via `meeting_edit` + `detail.change` → Tasks 4, 7.
- Testing (unit heuristic + datetime; integration update/add/remove/move; formatter) → Tasks 1, 2, 6, 7.
- Out-of-scope items (#63/#66/#67/#68, real evaluator links, status transitions) intentionally not implemented.
