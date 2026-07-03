# VPE Assign-to-Member, Speaker TBA & Speech Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a VPE/admin assign an open role to a member or reassign a filled role from the authed meeting view; make speaker slots default to a "TBA" speech title; and add an edit-speech-details capability for a slot's assignee (own slot) or a VPE (any slot).

**Architecture:** Backend server fns stay trust-based (`requireMemberInClub`); UI gating (`canManage` / own-slot) controls exposure. Pure logic (`normalizeSpeakerDetails`, `resolveAssignAction`, `buildPickerRows`) lives in testable modules and is unit-tested; DB behavior is covered by mirrored integration tests following the existing `claim.integration.test.ts` convention (server fns can't be called directly in tests). A searchable member picker (shadcn `Command` + `Popover`) drives assignment.

**Tech Stack:** TanStack Start (React 19) · Drizzle ORM / Postgres (`pg`) · shadcn/ui + Tailwind v4 · Zod · Vitest · Biome · Bun.

**Spec:** `docs/superpowers/specs/2026-07-02-vpe-assign-slot-design.md`

**Conventions:** import alias `#/*`; Biome formats with **tabs** + **double quotes**; run `bunx vitest run <path>` for a single test; integration tests need `TEST_DATABASE_URL` (the `tm_test` DB in the `dev-postgres` container). Commit frequently.

---

## File Structure

**Pure logic (unit-tested):**
- `src/server/slots-logic.ts` — add `normalizeSpeakerDetails()` (empty title → "TBA", optional fields → null).
- `src/server/slots-logic.test.ts` — **new**, unit tests for `normalizeSpeakerDetails`.
- `src/lib/agenda.ts` — add `resolveAssignAction()` + `buildPickerRows()`.
- `src/lib/agenda.test.ts` — add unit tests for both helpers.

**Backend server fns:**
- `src/server/slots.ts` — relax `speakerDetailsSchema`; `claimSlot` TBA default (drop the throw); `reassignSlot` status + speaker-TBA reset; new `updateSpeakerDetails`.
- `src/server/meetings.ts` — `loadMeetingDetail` returns `roster` when `canManage`.

**Integration tests (mirrored, DB-backed):**
- `src/server/claim.integration.test.ts` — update `reassignSlotPublic` mirror; add mirrored coverage for claim→TBA, reassign→claimed+TBA, `updateSpeakerDetails`, and roster active-filter.

**Frontend:**
- `src/components/ui/command.tsx`, `src/components/ui/popover.tsx` — **new** (shadcn add).
- `src/components/club/assign-slot-sheet.tsx` — **new**, member picker.
- `src/components/club/edit-speech-sheet.tsx` — **new**, speech-detail editor.
- `src/routes/_authed/meetings.$id.tsx` — wire Assign / Reassign / Edit speech (`canManage`).
- `src/routes/club.$clubId.meeting.$meetingId.tsx` — relax self-claim title; Edit speech on own slot.

---

## Task 1: `normalizeSpeakerDetails` pure helper

**Files:**
- Modify: `src/server/slots-logic.ts`
- Test: `src/server/slots-logic.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/slots-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeSpeakerDetails } from "./slots-logic";

describe("normalizeSpeakerDetails", () => {
	it("defaults an empty/missing title to TBA and optional fields to null", () => {
		expect(normalizeSpeakerDetails()).toEqual({
			speechTitle: "TBA",
			pathwayPath: null,
			projectName: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
		});
		expect(normalizeSpeakerDetails({ speechTitle: "   " }).speechTitle).toBe("TBA");
	});

	it("trims a provided title and passes through optional fields", () => {
		expect(
			normalizeSpeakerDetails({
				speechTitle: "  Ice Breaker  ",
				pathwayPath: "Presentation Mastery",
				minMinutes: 4,
				maxMinutes: 6,
			}),
		).toEqual({
			speechTitle: "Ice Breaker",
			pathwayPath: "Presentation Mastery",
			projectName: null,
			projectLevel: null,
			minMinutes: 4,
			maxMinutes: 6,
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/server/slots-logic.test.ts`
Expected: FAIL — `normalizeSpeakerDetails` is not exported.

- [ ] **Step 3: Add the helper**

Append to `src/server/slots-logic.ts`:

```ts
export type SpeakerDetailsInput = {
	speechTitle?: string;
	pathwayPath?: string;
	projectName?: string;
	projectLevel?: string;
	minMinutes?: number;
	maxMinutes?: number;
};

export type NormalizedSpeakerDetails = {
	speechTitle: string;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
};

/** Normalize speaker details for persistence: blank/missing title → "TBA",
 *  blank optional strings → null, missing numbers → null. */
export function normalizeSpeakerDetails(
	input?: SpeakerDetailsInput,
): NormalizedSpeakerDetails {
	const title = input?.speechTitle?.trim();
	return {
		speechTitle: title && title.length > 0 ? title : "TBA",
		pathwayPath: input?.pathwayPath?.trim() || null,
		projectName: input?.projectName?.trim() || null,
		projectLevel: input?.projectLevel?.trim() || null,
		minMinutes: input?.minMinutes ?? null,
		maxMinutes: input?.maxMinutes ?? null,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/server/slots-logic.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots-logic.ts src/server/slots-logic.test.ts
git commit -m "feat(slots): normalizeSpeakerDetails helper (blank title -> TBA)"
```

---

## Task 2: Relax `claimSlot` — optional title, TBA default

**Files:**
- Modify: `src/server/slots.ts:19-26` (schema), `:37-103` (`claimSlot`)
- Test: `src/server/claim.integration.test.ts`

- [ ] **Step 1: Relax the schema**

In `src/server/slots.ts`, change `speakerDetailsSchema` so the title is optional:

```ts
const speakerDetailsSchema = z.object({
	speechTitle: z.string().trim().optional(),
	pathwayPath: z.string().trim().optional(),
	projectName: z.string().trim().optional(),
	projectLevel: z.string().trim().optional(),
	minMinutes: z.number().int().positive().optional(),
	maxMinutes: z.number().int().positive().optional(),
});
```

- [ ] **Step 2: Import the helper and rewrite the speaker branch of `claimSlot`**

In `src/server/slots.ts`, add `normalizeSpeakerDetails` to the existing `./slots-logic` import:

```ts
import {
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveSpeakerSlot,
	normalizeSpeakerDetails,
} from "./slots-logic";
```

Delete the throw (currently `slots.ts:62-64`):

```ts
if (slot.isSpeakerRole && !data.speakerDetails) {
	throw new Error("Speaker roles require speech details before claiming.");
}
```

Replace the `if (slot.isSpeakerRole && data.speakerDetails)` upsert block (currently `slots.ts:82-90`) with an unconditional TBA-normalized upsert:

```ts
if (slot.isSpeakerRole) {
	const details = normalizeSpeakerDetails(data.speakerDetails);
	await tx
		.insert(speakerDetails)
		.values({ slotId: data.slotId, ...details })
		.onConflictDoUpdate({
			target: speakerDetails.slotId,
			set: details,
		});
}
```

- [ ] **Step 3: Add the failing integration test**

In `src/server/claim.integration.test.ts`, inside the Phase B `describe` block (near the existing claim tests), add a test that mirrors the new TBA behavior. Place it after the existing `"claimSlot works without a session"` test:

```ts
it("claiming a speaker slot with no title stores TBA", async () => {
	// seed.speakerSlotId is an open speaker slot; if the seed lacks one, use the
	// existing seed.slotId as a stand-in speaker slot per the seed helper's shape.
	const details = normalizeSpeakerDetails(undefined);
	await testDb
		.insert(speakerDetails)
		.values({ slotId: seed.slotId, ...details })
		.onConflictDoUpdate({ target: speakerDetails.slotId, set: details });

	const [row] = await testDb
		.select({ speechTitle: speakerDetails.speechTitle })
		.from(speakerDetails)
		.where(eq(speakerDetails.slotId, seed.slotId))
		.limit(1);

	expect(row?.speechTitle).toBe("TBA");
});
```

Add the import at the top of the test file:

```ts
import { normalizeSpeakerDetails } from "./slots-logic";
```

- [ ] **Step 4: Run tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/claim.integration.test.ts`
Expected: PASS (existing tests still green + the new TBA test). If `TEST_DATABASE_URL` is unset the suite is skipped — set it to exercise the test.

- [ ] **Step 5: Commit**

```bash
git add src/server/slots.ts src/server/claim.integration.test.ts
git commit -m "feat(slots): claimSlot defaults speaker title to TBA (title now optional)"
```

---

## Task 3: `reassignSlot` resets status + speaker details

**Files:**
- Modify: `src/server/slots.ts:284-327` (`reassignSlot`)
- Test: `src/server/claim.integration.test.ts` (update `reassignSlotPublic` mirror + assertions)

- [ ] **Step 1: Rewrite `reassignSlot` to join the role def and reset**

In `src/server/slots.ts`, replace the `reassignSlot` slot lookup + transaction so it (a) learns `isSpeakerRole`, (b) sets `status: "claimed"`, and (c) resets speaker details to TBA. The full handler body:

```ts
.handler(async ({ data }) => {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			clubId: meetings.clubId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, data.slotId))
		.limit(1);

	if (!slot) {
		throw new Error("Role not found.");
	}

	// Trust guards: both the actor and the target must be club roster members.
	await requireMemberInClub(data.actorMemberId, slot.clubId);
	await requireMemberInClub(data.memberId, slot.clubId);

	return db.transaction(async (tx) => {
		// New holder hasn't been confirmed → back to "claimed".
		await tx
			.update(roleSlots)
			.set({ assignedMemberId: data.memberId, status: "claimed" })
			.where(eq(roleSlots.id, data.slotId));

		// The previous speaker's speech no longer applies — reset to TBA.
		if (slot.isSpeakerRole) {
			const details = normalizeSpeakerDetails(undefined);
			await tx
				.insert(speakerDetails)
				.values({ slotId: data.slotId, ...details })
				.onConflictDoUpdate({
					target: speakerDetails.slotId,
					set: details,
				});
		}

		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: data.actorMemberId,
			action: "reassign",
			targetType: "slot",
			targetId: data.slotId,
			detail: {
				fromMemberId: slot.assignedMemberId,
				memberId: data.memberId,
			},
		});

		return { ok: true as const };
	});
});
```

- [ ] **Step 2: Update the test mirror + assertions**

In `src/server/claim.integration.test.ts`, update `reassignSlotPublic` so its `UPDATE` matches the new behavior (add `status: "claimed"`):

```ts
await tx
	.update(roleSlots)
	.set({ assignedMemberId: newMemberId, status: "claimed" })
	.where(eq(roleSlots.id, slotId));
```

Then extend the existing `"reassignSlot works without a session (trust-based)"` test (around `claim.integration.test.ts:519`) to assert the status reset. After the reassign call, add:

```ts
const [reassigned] = await testDb
	.select({
		assignedMemberId: roleSlots.assignedMemberId,
		status: roleSlots.status,
	})
	.from(roleSlots)
	.where(eq(roleSlots.id, seed.slotId))
	.limit(1);
expect(reassigned?.status).toBe("claimed");
```

- [ ] **Step 3: Run tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/claim.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/slots.ts src/server/claim.integration.test.ts
git commit -m "feat(slots): reassign resets status to claimed and clears speaker details to TBA"
```

---

## Task 4: `updateSpeakerDetails` server fn

**Files:**
- Modify: `src/server/slots.ts` (add fn near `reassignSlot`)
- Test: `src/server/claim.integration.test.ts` (mirrored)

- [ ] **Step 1: Add the server fn**

In `src/server/slots.ts`, after `reassignSlot`, add:

```ts
const updateSpeakerDetailsSchema = z.object({
	slotId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema,
});

/** Edit a speaker slot's speech details (trust-based). Blank title → "TBA".
 *  PUBLIC — no session required; trust guard via requireMemberInClub. */
export const updateSpeakerDetails = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateSpeakerDetailsSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		if (!slot.isSpeakerRole) {
			throw new Error("Only speaker roles have speech details.");
		}
		await requireMemberInClub(data.actorMemberId, slot.clubId);

		const details = normalizeSpeakerDetails(data.speakerDetails);
		await db
			.insert(speakerDetails)
			.values({ slotId: data.slotId, ...details })
			.onConflictDoUpdate({ target: speakerDetails.slotId, set: details });

		return { ok: true as const };
	});
```

- [ ] **Step 2: Add the failing integration test**

In `src/server/claim.integration.test.ts` (Phase B), add:

```ts
it("updateSpeakerDetails upserts details and normalizes blank title to TBA", async () => {
	const full = normalizeSpeakerDetails({ speechTitle: "My Speech", minMinutes: 5 });
	await testDb
		.insert(speakerDetails)
		.values({ slotId: seed.slotId, ...full })
		.onConflictDoUpdate({ target: speakerDetails.slotId, set: full });

	const cleared = normalizeSpeakerDetails({ speechTitle: "" });
	await testDb
		.insert(speakerDetails)
		.values({ slotId: seed.slotId, ...cleared })
		.onConflictDoUpdate({ target: speakerDetails.slotId, set: cleared });

	const [row] = await testDb
		.select({
			speechTitle: speakerDetails.speechTitle,
			minMinutes: speakerDetails.minMinutes,
		})
		.from(speakerDetails)
		.where(eq(speakerDetails.slotId, seed.slotId))
		.limit(1);
	expect(row?.speechTitle).toBe("TBA");
	expect(row?.minMinutes).toBeNull();
});
```

- [ ] **Step 3: Run tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/claim.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify the server-module guard still passes**

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS — `slots.ts` still exports only `createServerFn`s + types (the new export is a `createServerFn`).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots.ts src/server/claim.integration.test.ts
git commit -m "feat(slots): updateSpeakerDetails server fn (edit speech, blank title -> TBA)"
```

---

## Task 5: `roster` in `loadMeetingDetail` (VPE only)

**Files:**
- Modify: `src/server/meetings.ts:126-142`
- Test: `src/server/claim.integration.test.ts` (mirrored active-filter query)

- [ ] **Step 1: Add the roster query + return field**

In `src/server/meetings.ts`, inside `loadMeetingDetail`, after the `unavailableMembers` query (`meetings.ts:126-131`) and before the `return`, add:

```ts
// Roster for the VPE assign picker — active members only. Kept out of the
// public/unauthenticated payload: only populated when the caller can manage.
const roster = canManage
	? await db
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(
				and(eq(members.clubId, meeting.clubId), eq(members.status, "active")),
			)
			.orderBy(asc(members.name))
	: [];
```

Add `roster` to the returned object:

```ts
	return {
		meeting,
		slots,
		canManage,
		timezone: club?.timezone ?? "UTC",
		clubName: club?.name ?? "",
		clubSlug: club?.slug ?? "",
		unavailableMembers,
		unavailableMemberIds: unavailableMembers.map((m) => m.id),
		roster,
	};
```

Ensure `and` is imported from `drizzle-orm` at the top of `meetings.ts` (it already imports `eq`, `asc`; add `and` if absent):

```ts
import { and, asc, eq } from "drizzle-orm";
```

- [ ] **Step 2: Add the failing integration test**

In `src/server/claim.integration.test.ts` (Phase B), mirror the active-filter query:

```ts
it("roster query returns only active members, ordered by name", async () => {
	// Mark the seeded member inactive; it should be excluded.
	await testDb
		.update(members)
		.set({ status: "inactive" })
		.where(eq(members.id, seed.memberId));

	const roster = await testDb
		.select({ id: members.id, status: members.status })
		.from(members)
		.where(and(eq(members.clubId, seed.clubId), eq(members.status, "active")));

	expect(roster.every((m) => m.status === "active")).toBe(true);
	expect(roster.some((m) => m.id === seed.memberId)).toBe(false);
});
```

Ensure `and` is imported in the test file (it already imports `{ and, eq }` per the file header — confirm).

- [ ] **Step 3: Run tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/claim.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/meetings.ts src/server/claim.integration.test.ts
git commit -m "feat(meetings): loadMeetingDetail returns active roster when canManage"
```

---

## Task 6: `resolveAssignAction` + `buildPickerRows` helpers

**Files:**
- Modify: `src/lib/agenda.ts`
- Test: `src/lib/agenda.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/agenda.test.ts` (add imports to the existing top-of-file import from `./agenda`):

```ts
import { buildPickerRows, resolveAssignAction } from "./agenda";

describe("resolveAssignAction", () => {
	it("open slot claims; speaker flags TBA", () => {
		expect(
			resolveAssignAction({ status: "open", isSpeakerRole: false }),
		).toEqual({ kind: "claim", speakerTba: false });
		expect(
			resolveAssignAction({ status: "open", isSpeakerRole: true }),
		).toEqual({ kind: "claim", speakerTba: true });
	});

	it("filled slot reassigns", () => {
		expect(
			resolveAssignAction({ status: "claimed", isSpeakerRole: true }),
		).toEqual({ kind: "reassign", speakerTba: false });
		expect(
			resolveAssignAction({ status: "confirmed", isSpeakerRole: false }),
		).toEqual({ kind: "reassign", speakerTba: false });
	});
});

describe("buildPickerRows", () => {
	const roster = [
		{ id: "c", name: "Cara" },
		{ id: "a", name: "Ana" },
		{ id: "b", name: "Ben" },
	];

	it("flags unavailable and already-assigned members, sorting them last", () => {
		const rows = buildPickerRows(roster, { b: "Timer" }, ["a"]);
		// Clean member (Cara) first, then flagged sorted by name (Ana, Ben).
		expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			unavailable: true,
			currentRole: null,
		});
		expect(rows.find((r) => r.id === "b")).toMatchObject({
			unavailable: false,
			currentRole: "Timer",
		});
	});
});
```

If `agenda.test.ts` doesn't already import `describe`, add it: `import { describe, expect, it } from "vitest";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/agenda.ts`:

```ts
/** Which server fn an assign action maps to for a given slot. */
export function resolveAssignAction(slot: {
	status: "open" | "claimed" | "confirmed";
	isSpeakerRole: boolean;
}): { kind: "claim" | "reassign"; speakerTba: boolean } {
	if (slot.status === "open") {
		return { kind: "claim", speakerTba: slot.isSpeakerRole };
	}
	return { kind: "reassign", speakerTba: false };
}

export type PickerRow = {
	id: string;
	name: string;
	unavailable: boolean;
	currentRole: string | null;
};

/** Build member-picker rows. Members flagged unavailable-for-this-meeting or
 *  already holding a role this meeting sort after unflagged members (then by
 *  name); all remain selectable. */
export function buildPickerRows(
	roster: { id: string; name: string }[],
	roleByMemberId: Record<string, string>,
	unavailableIds: string[],
): PickerRow[] {
	const unavailable = new Set(unavailableIds);
	return roster
		.map((m) => ({
			id: m.id,
			name: m.name,
			unavailable: unavailable.has(m.id),
			currentRole: roleByMemberId[m.id] ?? null,
		}))
		.sort((a, b) => {
			const aFlag = a.unavailable || a.currentRole !== null;
			const bFlag = b.unavailable || b.currentRole !== null;
			if (aFlag !== bFlag) return aFlag ? 1 : -1;
			return a.name.localeCompare(b.name);
		});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/lib/agenda.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda.ts src/lib/agenda.test.ts
git commit -m "feat(agenda): resolveAssignAction + buildPickerRows picker helpers"
```

---

## Task 7: Install shadcn `command` + `popover`

**Files:**
- Create: `src/components/ui/command.tsx`, `src/components/ui/popover.tsx`

- [ ] **Step 1: Add the components**

Run: `bunx shadcn@latest add command popover`
This creates `src/components/ui/command.tsx` and `src/components/ui/popover.tsx` and installs `cmdk` + `@radix-ui/react-popover`.

- [ ] **Step 2: Verify install + lint**

Run: `bun run check`
Expected: no errors (the generated files are formatted by Biome; if the tool reports import-order or quote diffs, run `bun run format` and re-check).

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/command.tsx src/components/ui/popover.tsx package.json bun.lock
git commit -m "chore(ui): add shadcn command + popover for the member picker"
```

---

## Task 8: `AssignSlotSheet` component

**Files:**
- Create: `src/components/club/assign-slot-sheet.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/club/assign-slot-sheet.tsx`:

```tsx
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { buildPickerRows } from "#/lib/agenda";
import { claimSlot, reassignSlot } from "#/server/slots";

type AssignSlot = {
	id: string;
	status: "open" | "claimed" | "confirmed";
	isSpeakerRole: boolean;
	label: string;
};

export function AssignSlotSheet({
	slot,
	roster,
	roleByMemberId,
	unavailableIds,
	actorMemberId,
	onOpenChange,
	onAssigned,
}: {
	slot: AssignSlot | null;
	roster: { id: string; name: string }[];
	roleByMemberId: Record<string, string>;
	unavailableIds: string[];
	actorMemberId: string | null;
	onOpenChange: (open: boolean) => void;
	onAssigned: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const rows = buildPickerRows(roster, roleByMemberId, unavailableIds);
	const isReassign = slot !== null && slot.status !== "open";

	async function pick(memberId: string) {
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusy(true);
		try {
			if (slot.status === "open") {
				await claimSlot({
					data: {
						slotId: slot.id,
						memberId,
						actorMemberId,
						speakerDetails: slot.isSpeakerRole
							? { speechTitle: "TBA" }
							: undefined,
					},
				});
			} else {
				await reassignSlot({
					data: { slotId: slot.id, memberId, actorMemberId },
				});
			}
			toast.success(isReassign ? "Role reassigned." : "Role assigned.");
			await onAssigned();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>
						{isReassign ? "Reassign" : "Assign"} {slot?.label ?? "role"}
					</SheetTitle>
					<SheetDescription>Pick a member to fill this role.</SheetDescription>
				</SheetHeader>
				<div className="px-4 pb-4">
					<Command>
						<CommandInput placeholder="Search members…" />
						<CommandList>
							<CommandEmpty>No members found.</CommandEmpty>
							<CommandGroup>
								{rows.map((row) => (
									<CommandItem
										key={row.id}
										value={row.name}
										disabled={busy}
										onSelect={() => pick(row.id)}
										className="flex items-center justify-between gap-2"
									>
										<span>{row.name}</span>
										<span className="flex items-center gap-1">
											{row.currentRole ? (
												<Badge variant="secondary">{row.currentRole}</Badge>
											) : null}
											{row.unavailable ? (
												<Badge variant="outline">Not available</Badge>
											) : null}
											{busy ? (
												<Loader2 className="size-4 animate-spin" />
											) : null}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</div>
			</SheetContent>
		</Sheet>
	);
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors from this file. (If `CommandEmpty`/`CommandGroup` export names differ in the generated `command.tsx`, adjust imports to match that file's exports.)

- [ ] **Step 3: Commit**

```bash
git add src/components/club/assign-slot-sheet.tsx
git commit -m "feat(club): AssignSlotSheet member picker (claim open / reassign filled)"
```

---

## Task 9: `EditSpeechSheet` component

**Files:**
- Create: `src/components/club/edit-speech-sheet.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/club/edit-speech-sheet.tsx`:

```tsx
import { Loader2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { updateSpeakerDetails } from "#/server/slots";

type SpeechSlot = {
	id: string;
	label: string;
	speechTitle: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
};

export function EditSpeechSheet({
	slot,
	actorMemberId,
	onOpenChange,
	onSaved,
}: {
	slot: SpeechSlot | null;
	actorMemberId: string | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	async function submit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		const form = new FormData(e.currentTarget);
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setBusy(true);
		try {
			await updateSpeakerDetails({
				data: {
					slotId: slot.id,
					actorMemberId,
					speakerDetails: {
						speechTitle: String(form.get("speechTitle") ?? "").trim() || undefined,
						pathwayPath: String(form.get("pathwayPath") ?? "").trim() || undefined,
						projectName: String(form.get("projectName") ?? "").trim() || undefined,
						projectLevel: String(form.get("projectLevel") ?? "").trim() || undefined,
						minMinutes: minRaw ? Number(minRaw) : undefined,
						maxMinutes: maxRaw ? Number(maxRaw) : undefined,
					},
				},
			});
			toast.success("Speech updated.");
			await onSaved();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Edit speech — {slot?.label ?? ""}</SheetTitle>
				</SheetHeader>
				{slot ? (
					<form onSubmit={submit} className="space-y-4 px-4 pb-4">
						<div className="space-y-2">
							<Label htmlFor="speechTitle">Speech title</Label>
							<Input
								id="speechTitle"
								name="speechTitle"
								defaultValue={slot.speechTitle ?? ""}
								placeholder="TBA"
								autoFocus
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="pathwayPath">Pathways path</Label>
							<Input
								id="pathwayPath"
								name="pathwayPath"
								defaultValue={slot.pathwayPath ?? ""}
								placeholder="e.g. Presentation Mastery"
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="projectName">Project</Label>
								<Input
									id="projectName"
									name="projectName"
									defaultValue={slot.projectName ?? ""}
									placeholder="Ice Breaker"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="projectLevel">Level</Label>
								<Input
									id="projectLevel"
									name="projectLevel"
									defaultValue={slot.projectLevel ?? ""}
									placeholder="Level 1"
								/>
							</div>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-2">
								<Label htmlFor="minMinutes">Min minutes</Label>
								<Input
									id="minMinutes"
									name="minMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									defaultValue={slot.minMinutes ?? ""}
									placeholder="4"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="maxMinutes">Max minutes</Label>
								<Input
									id="maxMinutes"
									name="maxMinutes"
									type="number"
									inputMode="numeric"
									min={1}
									defaultValue={slot.maxMinutes ?? ""}
									placeholder="6"
								/>
							</div>
						</div>
						<SheetFooter className="px-0">
							<Button type="submit" disabled={busy} className="w-full">
								{busy ? <Loader2 className="size-4 animate-spin" /> : "Save speech"}
							</Button>
							<SheetClose asChild>
								<Button type="button" variant="ghost" className="w-full">
									Cancel
								</Button>
							</SheetClose>
						</SheetFooter>
					</form>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/components/club/edit-speech-sheet.tsx
git commit -m "feat(club): EditSpeechSheet for editing/clearing speech details"
```

---

## Task 10: Wire the VPE view (`_authed/meetings.$id.tsx`)

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Import the sheets + helpers and read roster**

Add imports near the other component imports:

```tsx
import { AssignSlotSheet } from "#/components/club/assign-slot-sheet";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
```

Add `updateSpeakerDetails` is not needed here (it's used inside `EditSpeechSheet`). Add `roster` to the loader-data destructure (`meetings.$id.tsx:67`):

```tsx
const { meeting, slots, canManage, timezone, unavailableMembers, clubSlug, roster } =
	Route.useLoaderData();
```

- [ ] **Step 2: Add picker state + derived maps**

Inside `MeetingDetail`, next to the existing `useState` hooks:

```tsx
const [assignSlot, setAssignSlot] = useState<Slot | null>(null);
const [editSpeechSlot, setEditSpeechSlot] = useState<Slot | null>(null);

// memberId → their current role label this meeting (for picker flags).
const roleByMemberId: Record<string, string> = {};
for (const s of slots) {
	if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
}
```

- [ ] **Step 3: Add the manage controls in the slot row**

In the slot-row action area, within the `canManage` region (alongside the existing confirm/claim controls, around `meetings.$id.tsx:360-400`), add:

```tsx
{canManage ? (
	<div className="flex flex-wrap items-center gap-2">
		<Button size="sm" variant="outline" onClick={() => setAssignSlot(slot)}>
			{slot.status === "open" ? "Assign…" : "Reassign…"}
		</Button>
		{slot.isSpeakerRole && slot.status !== "open" ? (
			<Button
				size="sm"
				variant="ghost"
				onClick={() => setEditSpeechSlot(slot)}
			>
				Edit speech
			</Button>
		) : null}
	</div>
) : null}
```

- [ ] **Step 4: Render the sheets**

Before the component's closing `</PageContainer>` (or root wrapper), add:

```tsx
<AssignSlotSheet
	slot={
		assignSlot
			? {
					id: assignSlot.id,
					status: assignSlot.status,
					isSpeakerRole: assignSlot.isSpeakerRole,
					label: slotLabel(assignSlot, roleCounts),
				}
			: null
	}
	roster={roster}
	roleByMemberId={roleByMemberId}
	unavailableIds={unavailableMembers.map((m) => m.id)}
	actorMemberId={currentMemberId}
	onOpenChange={(open) => {
		if (!open) setAssignSlot(null);
	}}
	onAssigned={async () => {
		setAssignSlot(null);
		await router.invalidate();
	}}
/>
<EditSpeechSheet
	slot={
		editSpeechSlot
			? {
					id: editSpeechSlot.id,
					label: slotLabel(editSpeechSlot, roleCounts),
					speechTitle: editSpeechSlot.speechTitle,
					pathwayPath: editSpeechSlot.pathwayPath,
					projectName: editSpeechSlot.projectName,
					projectLevel: editSpeechSlot.projectLevel,
					minMinutes: editSpeechSlot.minMinutes,
					maxMinutes: editSpeechSlot.maxMinutes,
				}
			: null
	}
	actorMemberId={currentMemberId}
	onOpenChange={(open) => {
		if (!open) setEditSpeechSlot(null);
	}}
	onSaved={async () => {
		setEditSpeechSlot(null);
		await router.invalidate();
	}}
/>
```

- [ ] **Step 5: Type-check + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: no errors. (Confirm the `Slot` type includes `speechTitle`/`pathwayPath`/etc. — it derives from `getMeeting`'s row, which selects them; see `meetings.ts:99-104`.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(meeting): VPE assign/reassign picker + edit-speech controls"
```

---

## Task 11: Relax member self-claim title + own-slot edit (`club.$clubId.meeting.$meetingId.tsx`)

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [ ] **Step 1: Make the self-claim title optional**

In `claimSpeaker` (`club.$clubId.meeting.$meetingId.tsx:470-500`), remove the required-title guard:

```tsx
const speechTitle = String(form.get("speechTitle") ?? "").trim();
if (!speechTitle) {
	toast.error("A speech title is required.");
	return;
}
```

Change the `claimSlot` call so a blank title is sent as `undefined` (server normalizes to "TBA"):

```tsx
speakerDetails: {
	speechTitle: speechTitle || undefined,
	// …unchanged pathwayPath / projectName / projectLevel / minMinutes / maxMinutes
},
```

In the speaker form JSX, drop the `required` attribute from the title input and add a "TBA" hint (`:531`):

```tsx
<Input id="speechTitle" name="speechTitle" placeholder="TBA if not decided yet" autoFocus />
```

- [ ] **Step 2: Add own-slot Edit speech**

Add the import:

```tsx
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
```

Add state next to the other `useState` hooks:

```tsx
const [editSpeechSlot, setEditSpeechSlot] = useState<Slot | null>(null);
```

In the assignee action column, where a slot `isMine` and is a speaker role (near the "Release" button, `:346-358`), add an Edit speech affordance:

```tsx
{isMine && slot.isSpeakerRole ? (
	<button
		type="button"
		onClick={() => setEditSpeechSlot(slot)}
		className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
	>
		Edit speech
	</button>
) : null}
```

- [ ] **Step 3: Render the sheet**

Near the existing `ClaimSheet` / takeover `Dialog` at the end of the component, add:

```tsx
<EditSpeechSheet
	slot={
		editSpeechSlot
			? {
					id: editSpeechSlot.id,
					label: slotLabel(editSpeechSlot, roleCounts),
					speechTitle: editSpeechSlot.speechTitle,
					pathwayPath: editSpeechSlot.pathwayPath,
					projectName: editSpeechSlot.projectName,
					projectLevel: editSpeechSlot.projectLevel,
					minMinutes: editSpeechSlot.minMinutes,
					maxMinutes: editSpeechSlot.maxMinutes,
				}
			: null
	}
	actorMemberId={myId}
	onOpenChange={(open) => {
		if (!open) setEditSpeechSlot(null);
	}}
	onSaved={async () => {
		setEditSpeechSlot(null);
		await router.invalidate();
	}}
/>
```

- [ ] **Step 4: Type-check + lint**

Run: `bunx tsc --noEmit && bun run check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(meeting): optional self-claim speech title + own-slot edit speech"
```

---

## Task 12: Full verification

- [ ] **Step 1: Lint + format gate**

Run: `bun run check`
Expected: PASS (no lint/format errors).

- [ ] **Step 2: Full type check / build**

Run: `bun run build`
Expected: builds with no TypeScript errors.

- [ ] **Step 3: Unit + integration tests**

Run: `bun run test` then `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server`
Expected: all green (unit suites + integration suites incl. the new roster/claim/reassign/updateSpeakerDetails coverage and the `server-modules.guard.test.ts`).

- [ ] **Step 4: Manual smoke (dev server)**

Run: `bun run dev`, sign in as a VPE, open a meeting, and verify:
- "Assign…" on an open role opens the searchable picker; unavailable / already-assigned members show muted tags and sort last; selecting one fills the role (speaker slots show "TBA").
- "Reassign…" on a filled role changes the holder; a reassigned speaker resets to "TBA" and status returns to claimed.
- "Edit speech" (VPE, any speaker slot / member, own speaker slot) saves details; clearing the title stores "TBA".
- Self-claiming a speaker slot with a blank title succeeds and shows "TBA".

- [ ] **Step 5: Final commit (if any manual tweaks)**

```bash
git add -A
git commit -m "chore: VPE assign-to-member feature verification tweaks"
```

---

## Notes for the executor

- **Trust model:** `claimSlot` / `reassignSlot` / `updateSpeakerDetails` are intentionally PUBLIC/trust-based (`requireMemberInClub`). Gating is UI-only; do not add session guards.
- **Server-module boundary:** keep all db logic out of client-imported top-level exports in `slots.ts` — the new `updateSpeakerDetails` is a `createServerFn` (fine); `normalizeSpeakerDetails` lives in `slots-logic.ts`. `server-modules.guard.test.ts` enforces this.
- **Reassign is deliberately destructive** to speaker details (resets to "TBA"); the durable fix is tracked in GitHub issue #79 (speeches as first-class entities). Do not attempt that here.
- If the generated shadcn `command.tsx` uses different sub-component export names, adjust the imports in `AssignSlotSheet` to match.
```
