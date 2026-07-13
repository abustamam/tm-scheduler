# Per-Meeting "Can't go" Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small per-meeting "Can't go" / "Not going" toggle chip in the season-grid column headers so members can decline meetings from the public club home; self-claiming a role clears the decline flag; public grid links stop bouncing to sign-in.

**Architecture:** Pure view-model helper (`memberMeetingStatus`) computes per-meeting decline/held-role state from data already in the grid payload; the chip in `SeasonGrid`'s shared header reuses the component's existing availability handlers (`markUnavailable`, `clearUnavailable`, the release-and-mark confirm dialog). One server change: a `clearAvailabilityOnSelfClaim` helper in `slots-logic.ts` called by `claimSlot` and `reassignSlotCore` — self-claims (`memberId === actorMemberId`) delete the claimant's `member_availability` row; admin assignments don't. A new optional `clubSlug` prop threads through `SeasonGrid` → `GridCell` so the public page's header/cell links target the public meeting route.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM (node-postgres), Vitest, Tailwind v4, Biome (tabs, double quotes). Spec: `docs/superpowers/specs/2026-07-13-meeting-decline-button-design.md`.

**Conventions that will bite you if skipped:**
- Package manager is **Bun**: `bun run test`, `bunx vitest run <path>`. Tests are **Vitest**, never `bun test`.
- Integration tests need `TEST_DATABASE_URL` or they self-skip and prove nothing. Use: `TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's|/tm_scheduler|/tm_test|')"` prefix on test commands.
- **Only `bun run typecheck` type-checks.** Build and tests pass on type-broken code.
- Biome formats with tabs + double quotes; run `bun run check` before committing.
- `src/server/slots.ts` is a createServerFn module — it must NOT export plain db-touching functions (guard test enforces). The new db helper goes in `slots-logic.ts`.

---

### Task 1: `memberMeetingStatus` view-model helper

**Files:**
- Modify: `src/lib/season-grid-view.ts` (append at end of file)
- Test: `src/lib/season-grid-view.test.ts` (append at end of file)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/season-grid-view.test.ts`. The file already defines a `data: SeasonGridData` fixture at the top (meeting `m1`; member `a` holds the `tm` slot labeled "Toastmaster"; member `b` is in `unavailable` for `m1`; member `c` is free). Update the import line at the top of the file:

```ts
import { memberMeetingStatus, projectGrid } from "./season-grid-view";
```

Then append:

```ts
describe("memberMeetingStatus", () => {
	it("null member ⇒ empty map", () => {
		expect(memberMeetingStatus(data, null).size).toBe(0);
	});

	it("declined member: declined=true, no roles", () => {
		expect(memberMeetingStatus(data, "b").get("m1")).toEqual({
			declined: true,
			heldRoleLabels: [],
		});
	});

	it("role holder: labels resolved from rows", () => {
		expect(memberMeetingStatus(data, "a").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: ["Toastmaster"],
		});
	});

	it("free member: declined=false, no roles", () => {
		expect(memberMeetingStatus(data, "c").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: [],
		});
	});

	it("collects every held role's label for the meeting", () => {
		const dbl: SeasonGridData = {
			...data,
			cells: [
				data.cells[0]!,
				{
					slotId: "s-ti-a",
					meetingId: "m1",
					roleDefinitionId: "ti",
					slotIndex: 0,
					memberId: "a",
					status: "claimed",
					guestId: null,
				},
			],
		};
		expect(memberMeetingStatus(dbl, "a").get("m1")).toEqual({
			declined: false,
			heldRoleLabels: ["Toastmaster", "Timer"],
		});
	});
});
```

The red step here is the missing export: the suite fails to even evaluate `memberMeetingStatus` until Step 3 implements it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/lib/season-grid-view.test.ts`
Expected: FAIL — `memberMeetingStatus` is not exported (SyntaxError/undefined).

- [ ] **Step 3: Implement the helper**

Append to `src/lib/season-grid-view.ts`:

```ts
export interface MemberMeetingStatus {
	declined: boolean;
	heldRoleLabels: string[];
}

/**
 * Per-meeting availability status for one member — drives the header
 * "Can't go" chip. `declined` mirrors the NA set; `heldRoleLabels` feeds the
 * release-and-mark confirm dialog when declining a meeting where the member
 * already holds roles.
 */
export function memberMeetingStatus(
	data: SeasonGridData,
	memberId: string | null,
): Map<string, MemberMeetingStatus> {
	const result = new Map<string, MemberMeetingStatus>();
	if (!memberId) return result;

	const labelByRow = new Map(
		data.rows.map((r) => [`${r.roleDefinitionId}:${r.slotIndex}`, r.label]),
	);
	const heldByMeeting = new Map<string, string[]>();
	for (const c of data.cells) {
		if (c.memberId !== memberId) continue;
		const label =
			labelByRow.get(`${c.roleDefinitionId}:${c.slotIndex}`) ?? "a role";
		const list = heldByMeeting.get(c.meetingId) ?? [];
		list.push(label);
		heldByMeeting.set(c.meetingId, list);
	}
	const declined = new Set(
		data.unavailable
			.filter((u) => u.memberId === memberId)
			.map((u) => u.meetingId),
	);

	for (const m of data.meetings) {
		result.set(m.id, {
			declined: declined.has(m.id),
			heldRoleLabels: heldByMeeting.get(m.id) ?? [],
		});
	}
	return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/lib/season-grid-view.test.ts`
Expected: PASS (all existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/season-grid-view.ts src/lib/season-grid-view.test.ts
git commit -m "feat(grid): memberMeetingStatus view-model for the decline chip"
```

---

### Task 2: `clearAvailabilityOnSelfClaim` + `reassignSlotCore` NA-clear (server)

**Files:**
- Modify: `src/server/slots-logic.ts` (schema import; `reassignSlotCore` select + call; new exported helper)
- Test: Create `src/server/claim-availability.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `src/server/claim-availability.integration.test.ts`:

```ts
/**
 * DB-backed integration tests for the self-claim NA-clear (spec 2026-07-13):
 * claiming/reassigning a role for YOURSELF deletes your member_availability
 * ("not going") row for that meeting; admin assignments (actor ≠ member, or
 * no actor) leave the member's own absence statement intact.
 *
 * Exercises the REAL slots-logic helpers; `#/db` is mocked to the test client
 * so importing slots-logic doesn't require a DATABASE_URL (same pattern as
 * reassign.integration.test.ts). Skips cleanly when TEST_DATABASE_URL is
 * unset. Run with:
 *   TEST_DATABASE_URL=postgresql://...tm_test \
 *     bunx vitest run src/server/claim-availability.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memberAvailability, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function naRowExists(memberId: string, meetingId: string) {
	const rows = await testDb
		.select({ id: memberAvailability.id })
		.from(memberAvailability)
		.where(
			and(
				eq(memberAvailability.memberId, memberId),
				eq(memberAvailability.meetingId, meetingId),
			),
		);
	return rows.length > 0;
}

describe.skipIf(!hasTestDb)("self-claim clears the decline flag", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// The member has declined the seeded meeting.
		await testDb
			.insert(memberAvailability)
			.values({ memberId: seed.memberId, meetingId: seed.meetingId });
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("self-claim (member === actor) deletes the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.memberId,
			meetingId: seed.meetingId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
	});

	it("admin assignment (member !== actor) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: seed.adminMemberId,
			meetingId: seed.meetingId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});

	it("no actor (null) leaves the NA row", async () => {
		const { clearAvailabilityOnSelfClaim } = await import("./slots-logic");
		await clearAvailabilityOnSelfClaim(testDb, {
			memberId: seed.memberId,
			actorMemberId: null,
			meetingId: seed.meetingId,
		});
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});

	it("reassignSlotCore self-takeover clears the NA row end-to-end", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.memberId,
			}),
		);
		const [slot] = await testDb
			.select({ assignedMemberId: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		expect(slot?.assignedMemberId).toBe(seed.memberId);
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(false);
	});

	it("reassignSlotCore admin-assign leaves the NA row", async () => {
		const { reassignSlotCore } = await import("./slots-logic");
		await testDb.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}),
		);
		expect(await naRowExists(seed.memberId, seed.meetingId)).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's|/tm_scheduler|/tm_test|')" bunx vitest run src/server/claim-availability.integration.test.ts`
Expected: FAIL — the three helper tests error because `clearAvailabilityOnSelfClaim` is undefined (not yet exported from `./slots-logic`), and the two `reassignSlotCore` tests fail the NA-row assertion (it still exists).
(If it reports "skipped", TEST_DATABASE_URL didn't resolve — fix that before proceeding; a skip is NOT a red step.)

- [ ] **Step 3: Implement in `slots-logic.ts`**

In `src/server/slots-logic.ts`:

(a) Add `memberAvailability` to the existing schema import:

```ts
import {
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
```

(b) Add the exported helper (place it above `reassignSlotCore`):

```ts
/**
 * Self-claiming a role is the strongest "I'm coming" statement, so it clears
 * the claimant's decline flag ("not going" row) for that meeting — spec
 * 2026-07-13. Admin assignments (actor ≠ member, or no actor) must NOT
 * silently erase the member's own absence statement, so they no-op.
 */
export async function clearAvailabilityOnSelfClaim(
	tx: DbOrTx,
	args: { memberId: string; actorMemberId: string | null; meetingId: string },
): Promise<void> {
	if (args.actorMemberId === null || args.memberId !== args.actorMemberId)
		return;
	await tx
		.delete(memberAvailability)
		.where(
			and(
				eq(memberAvailability.memberId, args.memberId),
				eq(memberAvailability.meetingId, args.meetingId),
			),
		);
}
```

(c) In `reassignSlotCore` (around line 539): add `meetingId: roleSlots.meetingId,` to the locked select's field object (alongside `id`, `status`, `assignedMemberId`, …), and call the helper right after the `UPDATE ... set assignedMemberId` statement (before the speaker-speech block):

```ts
		await clearAvailabilityOnSelfClaim(tx, {
			memberId: args.memberId,
			actorMemberId: args.actorMemberId,
			meetingId: slot.meetingId,
		});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's|/tm_scheduler|/tm_test|')" bunx vitest run src/server/claim-availability.integration.test.ts`
Expected: PASS (5 tests).

Also run the neighboring suites that exercise `reassignSlotCore`:
`TEST_DATABASE_URL="..." bunx vitest run src/server/claim.integration.test.ts src/server/meeting-roles-mgmt.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/slots-logic.ts src/server/claim-availability.integration.test.ts
git commit -m "feat(slots): self-claim clears the claimant's decline flag"
```

---

### Task 3: Wire the NA-clear into `claimSlot`

**Files:**
- Modify: `src/server/slots.ts` (claimSlot pre-read select + transaction)

The claim transaction lives inline in the server fn (not extractable without a bigger refactor); the behavior itself is covered by Task 2's helper tests, so this task is wiring only — verified by typecheck + the full suite.

- [ ] **Step 1: Add the import**

In `src/server/slots.ts`, add `clearAvailabilityOnSelfClaim` to the existing `./slots-logic` import list (keep alphabetical order — Biome organizes imports):

```ts
import {
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyMoveSpeakerSlot,
	applyRemoveRoleSlot,
	applyRemoveSpeakerSlot,
	attachSpeechToSlot,
	clearAvailabilityOnSelfClaim,
	editSlotSpeech,
	reassignSlotCore,
} from "./slots-logic";
```

- [ ] **Step 2: Select the meetingId in claimSlot's pre-read**

In the `claimSlot` handler (~line 49), add `meetingId: roleSlots.meetingId,` to the select:

```ts
		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				meetingId: roleSlots.meetingId,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
```

- [ ] **Step 3: Call the helper inside the claim transaction**

Immediately after the `if (slot.isSpeakerRole) { ... }` block and before the `await logActivity(tx, ...)` call, add:

```ts
			await clearAvailabilityOnSelfClaim(tx, {
				memberId: data.memberId,
				actorMemberId: data.actorMemberId,
				meetingId: slot.meetingId,
			});
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck`
Expected: clean exit, no errors.

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS (slots.ts still exports only createServerFns/types).

- [ ] **Step 5: Commit**

```bash
git add src/server/slots.ts
git commit -m "feat(slots): claimSlot clears self-claimant's decline flag"
```

---

### Task 4: Header chip + public links in `SeasonGrid` / `GridCell`

**Files:**
- Modify: `src/components/club/season-grid.tsx`
- Modify: `src/components/club/grid-cell.tsx`

No component unit tests in this repo for the grid (logic lives in the tested view-model); verified by typecheck + Task 6's manual pass.

- [ ] **Step 1: Add `clubSlug` + public link to `GridCell`**

In `src/components/club/grid-cell.tsx`:

(a) Add the prop (after `onAvailability` in both the destructuring and the type):

```ts
	onAvailability?: (cell: ViewCell) => void;
	/** Club slug — when set (public club shell), cell links target the public
	 *  meeting view instead of the signed-in `/meetings/$id` route. */
	clubSlug?: string;
```

(b) Replace the final `return (<Link to="/meetings/$id" ...>` block (after `if (cell.kind === "blank") return inner;`) with:

```tsx
	if (cell.kind === "blank") return inner;
	if (clubSlug)
		return (
			<Link
				to="/club/$clubId/meeting/$meetingId"
				params={{ clubId: clubSlug, meetingId: cell.meetingId }}
				className="block"
				aria-label={cell.title || "meeting"}
			>
				{inner}
			</Link>
		);
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
```

- [ ] **Step 2: Add the chip + links to `SeasonGrid`**

In `src/components/club/season-grid.tsx`:

(a) Update imports:

```ts
import { Loader2, Lock, X } from "lucide-react";
```

and extend the view-model import:

```ts
import {
	type MemberMeetingStatus,
	memberMeetingStatus,
	type Orientation,
	projectGrid,
	type ViewCell,
} from "#/lib/season-grid-view";
```

(b) Add the prop. In the component signature after `clubId?: string;`:

```ts
	/** Club uuid — required for the availability calls. */
	clubId?: string;
	/** Club slug — when set (public club shell), meeting links in the header
	 *  and cells target the public meeting view instead of `/meetings/$id`. */
	clubSlug?: string;
```

…and add `clubSlug,` to the destructured parameters.

(c) Compute the per-meeting status next to `const rows = projectGrid(data, orientation);`:

```ts
	const rows = projectGrid(data, orientation);
	const meetingStatus = memberMeetingStatus(data, currentMemberId ?? null);
```

(d) Add the chip's click handler next to the existing `onAvailability` function:

```ts
	// Header chip: decline (or un-decline) a whole meeting. Holding a role
	// routes through the same release-and-mark confirm as the members-row cells.
	function onHeaderAvailability(
		m: SeasonGridData["meetings"][number],
		status: MemberMeetingStatus | undefined,
	) {
		if (!status) return;
		if (status.declined) {
			clearUnavailable(m.id);
		} else if (status.heldRoleLabels.length > 0) {
			setConfirm({
				meetingId: m.id,
				roleLabel: status.heldRoleLabels.join(", "),
				date: formatMeetingDate(m.scheduledAt, m.timezone),
			});
		} else {
			markUnavailable(m.id);
		}
	}
```

(e) Rewrite the meeting-header map (the `{data.meetings.map((m) => (<th ...>...</th>))}` block in `<thead>`) to a block body with the surface-aware link and the chip:

```tsx
							{data.meetings.map((m) => {
								const status = meetingStatus.get(m.id);
								const chipVisible =
									!!currentMemberId &&
									!!clubId &&
									!m.isPast &&
									!m.isCompleted;
								const header = (
									<>
										<div>{formatMeetingDate(m.scheduledAt, m.timezone)}</div>
										{m.isCompleted ? (
											<div className="flex items-center justify-center gap-0.5 text-[10px] font-semibold text-muted-foreground">
												<Lock className="size-2.5" aria-hidden />
												locked
											</div>
										) : (
											<div className="text-[10px] font-medium text-amber-600">
												{m.isPast
													? "done"
													: m.openCount === 0
														? "full"
														: `${m.openCount} open`}
											</div>
										)}
									</>
								);
								return (
									<th
										key={m.id}
										ref={m.isAnchor ? anchorRef : undefined}
										className={cn(
											"sticky top-0 min-w-[3.5rem] bg-card px-2 py-2 text-center text-xs font-semibold",
											m.isPast && !m.isCompleted && "opacity-45",
											m.isCompleted && "bg-muted/60",
											m.isAnchor && "rounded-md ring-2 ring-primary",
										)}
									>
										{clubSlug ? (
											<Link
												to="/club/$clubId/meeting/$meetingId"
												params={{ clubId: clubSlug, meetingId: m.id }}
												className="block"
											>
												{header}
											</Link>
										) : (
											<Link
												to="/meetings/$id"
												params={{ id: m.id }}
												className="block"
											>
												{header}
											</Link>
										)}
										{chipVisible ? (
											<button
												type="button"
												disabled={busyMeetingId === m.id}
												onClick={() => onHeaderAvailability(m, status)}
												title={
													status?.declined
														? "Tap if you can make it after all"
														: "Mark yourself unavailable — I can't make this one"
												}
												aria-pressed={status?.declined ?? false}
												className={cn(
													"mx-auto mt-1 flex cursor-pointer items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50",
													status?.declined
														? "border-rose-600 bg-rose-600 text-white hover:opacity-80"
														: "border-border text-muted-foreground/70 hover:border-rose-400 hover:text-rose-600",
												)}
											>
												{busyMeetingId === m.id ? (
													<Loader2 className="size-2.5 animate-spin" aria-hidden />
												) : status?.declined ? (
													<>
														Not going
														<X className="size-2.5" aria-hidden />
													</>
												) : (
													"Can't go"
												)}
											</button>
										) : null}
									</th>
								);
							})}
```

(f) `SeasonGridData` is already imported as a type in this file (`import type { SeasonGridCount, SeasonGridData } from "#/server/season-grid";`) — the handler's parameter type needs no new import.

(g) Pass the slug to the body cells. In the `<GridCell ... />` usage add:

```tsx
												availabilityEditable={availabilityEditable}
												onAvailability={onAvailability}
												clubSlug={clubSlug}
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck`
Expected: clean.

Run: `bun run check`
Expected: clean (Biome may reformat — re-stage if it fixes files).

- [ ] **Step 4: Commit**

```bash
git add src/components/club/season-grid.tsx src/components/club/grid-cell.tsx
git commit -m "feat(grid): per-meeting decline chip + public meeting links in header/cells"
```

---

### Task 5: Pass `clubSlug` from the public club home

**Files:**
- Modify: `src/routes/club.$clubId.index.tsx`

- [ ] **Step 1: Add the prop**

In `ClubHome`, the `clubId` route param IS the slug (`const { clubId } = Route.useParams();`). Add one line to the `<SeasonGrid>` usage:

```tsx
					<SeasonGrid
						data={grid}
						orientation={view}
						count={count}
						currentMemberId={member?.id ?? null}
						clubId={clubUuid}
						clubSlug={clubId}
```

The signed-in `/schedule` page intentionally does NOT pass `clubSlug` — its links keep targeting `/meetings/$id`.

- [ ] **Step 2: Verify + commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add src/routes/club.\$clubId.index.tsx
git commit -m "feat(club): decline chip live on the public sign-up sheet"
```

---

### Task 6: Full gates + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full quality gates**

```bash
bun run check
bun run typecheck
TEST_DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | sed 's|/tm_scheduler|/tm_test|')" bun run test
```

Expected: all clean; test count ≥ 655 (645 baseline + ~10 new), 0 failures.

- [ ] **Step 2: Manual browse verification (public page)**

Start the dev server (`bun run dev`, port 3000) and drive the public club page with the /browse skill (needs `GSTACK_CHROMIUM_NO_SANDBOX=1`). At `http://localhost:3000/club/<seeded-club-slug>`:

1. Pick a member name at the gate.
2. Default Roles × Meetings view: every upcoming column header shows a "Can't go" chip; past/locked columns don't.
3. Tap "Can't go" on a meeting where the member holds no role → chip flips to "Not going ✕", toast with Undo appears; Members × Meetings view shows NA in that member's row.
4. Tap "Not going ✕" → flips back to "Can't go".
5. Claim a role in a meeting, then tap its "Can't go" → confirm dialog names the role and date → confirm → role released AND chip shows "Not going ✕".
6. While "Not going", claim a role in that meeting → after refetch the chip returns to "Can't go" (self-claim cleared the flag).
7. Tap a date header → lands on `/club/<slug>/meeting/<id>` (NOT the sign-in page). Tap a read-only cell → same.
8. Flip to Members × Meetings → chip present there too.

Gotchas from project memory: browse can't click shadcn `cmdk` Command items headless — the name-picker gate may need `localStorage` seeding or a direct click on a plain button; if the picker is cmdk-based, set the stored member via `localStorage` (see `src/lib/member-identity.ts`) and reload instead of fighting it.

- [ ] **Step 3: Commit any leftover fixes**

If verification surfaced fixes, commit them with descriptive messages. If `bun run build` was run at any point, revert the mutated `src/routeTree.gen.ts` before committing (`git checkout src/routeTree.gen.ts`).

---

## Done means

- All three gates green (check, typecheck, full test run with TEST_DATABASE_URL).
- Manual pass of Task 6 Step 2 on the public page.
- Spec requirements all traceable: chip both orientations ✓ (shared header), personal-only ✓ (no count added), start-time cutoff ✓ (`!m.isPast`), self-claim NA-clear ✓ (Tasks 2–3), public links ✓ (Tasks 4–5).
