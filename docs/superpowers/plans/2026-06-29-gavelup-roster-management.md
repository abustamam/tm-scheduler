# GavelUp Roster Management (edit / merge / remove) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. The three server mutations are extracted as plain, DB-testable fns (see the testing note); the formatter cases get unit tests; the roster UI is build-verified.

**Goal:** Give the VPE roster cleanup tools — **edit** (name/email/phone/office), **merge** duplicates (re-point all of an absorbed member's data + history to a keeper, then delete it), and **remove** a member (auto-releasing their upcoming roles first) — on the authed workspace roster view.

**Architecture:** Three authed (admin/vpe) server fns in `src/server/members.ts`, each a thin `createServerFn` wrapper (auth guard) over an exported **plain** fn (`applyMemberEdit` / `applyMemberMerge` / `applyMemberRemove`) that does the DB work in a transaction and writes the activity log. Plain fns are directly DB-testable (the wrappers can't run in tests — no Start runtime). The formatter gains cases for the three new actions; the roster UI gets edit/merge/remove affordances.

**Tech Stack:** TanStack Start server fns + file routes, Drizzle (`node-postgres`) incl. raw `sql` for jsonb re-attribution, Zod, shadcn/ui (Dialog), Bun, Vitest (`skipIf(!hasTestDb)` integration tests, `vi.mock("#/db")` → testDb), Biome.

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-self-serve-mvp-design.md` §5/§6 (roster management). **Decisions locked (2026-06-29):** merge re-points everything **including history**; remove **auto-releases** upcoming roles then deletes; build the **full** edit+merge+remove set this step.

## Locked semantics
- **Merge B→A:** re-point `role_slots.assignedMemberId`, `member_availability` (dedupe meeting conflicts), and `activity_log` (`actorMemberId` + `detail.memberId`/`detail.fromMemberId`); delete B's own `member_add` row; delete B; log `member_merge`. **A user-linked member (`userId` set) may not be the absorbed one** (would orphan the auth account) → reject; the user-linked record must be the keeper.
- **Remove:** reject if the member has a `userId` (it's the signed-in VPE). Otherwise release the member's upcoming, non-cancelled slots (each logged `release` with `detail.fromMemberId`), then delete the member (`member_availability` cascades; past `role_slots` references `set null`); log `member_remove`.
- **Edit:** name required (non-empty); email/phone/office nullable. Log `member_edit` with `{ before, after }` of the changed fields.
- All three are authed VPE (`requireUser` + `requireClubRole(clubId, ["admin","vpe"])`), club-scoped (member must belong to `clubId`).

## Schema facts (confirmed)
`members`: id, clubId, name, email?, phone?, office?, userId? (→user, set null), createdAt. `activity_log.actorMemberId` → members **set null** (so re-point BEFORE delete). `member_availability` → members **cascade**, unique(memberId, meetingId). `role_slots.assignedMemberId` → members **set null**. `member_merge`/`member_edit`/`member_remove` already exist in `activityActionEnum`.

## Testing note (read `[[gavelup-integration-testing]]` mindset)
`createServerFn` wrappers throw "No Start context" in Vitest. Test the **plain** `applyX` fns directly, with `vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }))` so they hit `tm_test`. `seedClub()` gives one roster member (`memberId`) + `slotId`/`meetingId`; insert extra members via `testDb`. **The controller runs the DB suites** (`TEST_DATABASE_URL=<dev url, db=tm_test> bunx vitest run`); implementers run `bunx tsc`, `bun run check`, `bun run build`, and `bunx vitest run` (unit only — integration skips without the env var) and report; the controller verifies the integration tests.

## Commands
`bunx tsc --noEmit` · `bun run check` · `bun run build` (authoritative route gen) · `bunx vitest run` (unit) · controller: `TEST_DATABASE_URL=… bunx vitest run`.

## File structure
- Modify `src/server/members.ts` — add `applyMemberEdit`/`editMember`, `applyMemberMerge`/`mergeMembers`, `applyMemberRemove`/`removeMember`.
- Modify `src/lib/activity-format.ts` (+ test) — member_edit/merge/remove cases.
- Modify the roster view `src/routes/_authed/index.tsx` (and/or `src/routes/_authed/members.$id.tsx`) — edit/merge/remove UI.
- Create `src/server/roster-mgmt.integration.test.ts`.

---

### Task 1: `editMember`

**Files:** Modify `src/server/members.ts`; Test: `src/server/roster-mgmt.integration.test.ts`

- [ ] **Step 1 (failing test):** with `#/db` mocked to testDb, `applyMemberEdit({ clubId, memberId, name:"New", email:"x@y.z", phone:null, office:"Timer" })` updates the row and writes a `member_edit` activity row.

```ts
// top of file:
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// in a test:
const { applyMemberEdit } = await import("#/server/members");
await applyMemberEdit({ clubId: seed.clubId, actorMemberId: seed.memberId, memberId: seed.memberId, name: "Renamed", email: "a@b.c", phone: null, office: "VP" });
const [m] = await testDb.select().from(members).where(eq(members.id, seed.memberId));
expect(m.name).toBe("Renamed");
const [log] = await testDb.select().from(activityLog).where(and(eq(activityLog.action, "member_edit"), eq(activityLog.targetId, seed.memberId))).orderBy(desc(activityLog.createdAt)).limit(1);
expect(log).toBeTruthy();
```

- [ ] **Step 2:** run with DB → fail. **Step 3:** Implement in `members.ts`:

```ts
const editSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
	name: z.string().trim().min(1),
	email: z.string().trim().email().nullable().optional(),
	phone: z.string().trim().nullable().optional(),
	office: z.string().trim().nullable().optional(),
});
type EditInput = z.infer<typeof editSchema>;

export async function applyMemberEdit(input: EditInput) {
	const [current] = await db.select().from(members)
		.where(and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)));
	if (!current) throw new Error("Member not found.");
	const next = {
		name: input.name,
		email: input.email ?? null,
		phone: input.phone ?? null,
		office: input.office ?? null,
	};
	await db.transaction(async (tx) => {
		await tx.update(members).set(next).where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				before: { name: current.name, email: current.email, phone: current.phone, office: current.office },
				after: next,
			},
		});
	});
	return { ok: true as const };
}

export const editMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => editSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberEdit(data);
	});
```

Add the imports `editMember`/`mergeMembers`/`removeMember` will need to `members.ts`: `and`, `eq`, `gte`, `inArray`, `ne`, `sql` from `drizzle-orm`; `meetings`, `memberAvailability`, `roleSlots`, `activityLog` from `#/db/schema`; `requireClubRole`, `requireUser` from `./guards`. (`members`, `logActivity`, `db`, `createServerFn`, `z` are already imported.)

- [ ] **Step 4:** run → pass; tsc 0. **Step 5:** commit `feat(server): editMember (authed VPE)`.

---

### Task 2: `mergeMembers`

**Files:** Modify `src/server/members.ts`; Test: `src/server/roster-mgmt.integration.test.ts`

- [ ] **Step 1 (failing tests):** seed keeper A (`seed.memberId`) + insert absorbed B + a third member C; assign B to `seed.slotId` (claim by inserting `assignedMemberId=B`), give B an availability row + an activity row referencing B (actor + a reassign detail.fromMemberId=B). Then `applyMemberMerge({ clubId, keeperId:A, absorbedId:B, actorMemberId:A })`:
  - B is deleted (`members` has no B).
  - the slot is now assigned to A.
  - B's availability row now belongs to A.
  - activity rows that had `actorMemberId=B` now have A; a row with `detail.fromMemberId=B` now reads A.
  - a `member_merge` row exists.
  - Add a rejection test: merging when **B has a `userId`** throws (set B.userId via testDb to the seed admin user). Add: `keeperId === absorbedId` throws.

- [ ] **Step 2:** fail. **Step 3:** Implement:

```ts
const mergeSchema = z.object({
	clubId: z.string().uuid(),
	keeperId: z.string().uuid(),
	absorbedId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});
type MergeInput = z.infer<typeof mergeSchema>;

export async function applyMemberMerge(input: MergeInput) {
	const { clubId, keeperId, absorbedId } = input;
	if (keeperId === absorbedId) throw new Error("Pick two different members to merge.");
	const rows = await db.select().from(members)
		.where(and(inArray(members.id, [keeperId, absorbedId]), eq(members.clubId, clubId)));
	const keeper = rows.find((m) => m.id === keeperId);
	const absorbed = rows.find((m) => m.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Member not found in this club.");
	if (absorbed.userId) {
		throw new Error("That member is a signed-in account — merge the other direction (keep it).");
	}

	await db.transaction(async (tx) => {
		// 1. Role assignments → keeper (a member may hold many slots; no unique conflict).
		await tx.update(roleSlots).set({ assignedMemberId: keeperId })
			.where(eq(roleSlots.assignedMemberId, absorbedId));
		// 2. Availability → keeper, dropping meetings the keeper already covers (unique meetingId,memberId).
		await tx.execute(sql`DELETE FROM member_availability WHERE member_id = ${absorbedId}
			AND meeting_id IN (SELECT meeting_id FROM member_availability WHERE member_id = ${keeperId})`);
		await tx.update(memberAvailability).set({ memberId: keeperId })
			.where(eq(memberAvailability.memberId, absorbedId));
		// 3. Activity history → keeper (actor + jsonb subject refs), drop B's own member_add row.
		await tx.update(activityLog).set({ actorMemberId: keeperId })
			.where(eq(activityLog.actorMemberId, absorbedId));
		await tx.execute(sql`UPDATE activity_log SET detail = jsonb_set(detail, '{memberId}', ${`"${keeperId}"`}::jsonb)
			WHERE club_id = ${clubId} AND detail->>'memberId' = ${absorbedId}`);
		await tx.execute(sql`UPDATE activity_log SET detail = jsonb_set(detail, '{fromMemberId}', ${`"${keeperId}"`}::jsonb)
			WHERE club_id = ${clubId} AND detail->>'fromMemberId' = ${absorbedId}`);
		await tx.delete(activityLog)
			.where(and(eq(activityLog.targetType, "member"), eq(activityLog.targetId, absorbedId)));
		// 4. Delete the absorbed member (availability already moved; no remaining slot refs).
		await tx.delete(members).where(eq(members.id, absorbedId));
		// 5. Log the merge.
		await logActivity(tx, {
			clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_merge",
			targetType: "member",
			targetId: keeperId,
			detail: { absorbedId, absorbedName: absorbed.name, keeperName: keeper.name },
		});
	});
	return { ok: true as const };
}

export const mergeMembers = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberMerge(data);
	});
```

Note the jsonb bind: `${`"${keeperId}"`}::jsonb` passes the JSON string `"<uuid>"` as a parameter, cast to jsonb (a JSON string scalar). Verify with the test that `detail->>'fromMemberId'` reads the keeper id afterward.

- [ ] **Step 4:** run → pass; tsc 0. **Step 5:** commit `feat(server): mergeMembers re-points data + history`.

---

### Task 3: `removeMember`

**Files:** Modify `src/server/members.ts`; Test: `src/server/roster-mgmt.integration.test.ts`

- [ ] **Step 1 (failing tests):** assign `seed.memberId` to `seed.slotId` (upcoming meeting); `applyMemberRemove({ clubId, memberId: seed.memberId, actorMemberId: null })`:
  - the slot is back to `status:"open"` with `assignedMemberId:null`, and a `release` activity row with `detail.fromMemberId = seed.memberId` exists.
  - the member is deleted; a `member_remove` row exists.
  - Rejection test: set the member's `userId` (via testDb) → `applyMemberRemove` throws.
  (`seedClub`'s meeting is upcoming; if it's in the past, the release-upcoming filter won't catch it — check `meetings.scheduledAt` in the seed; if past, insert a future meeting+slot for this test or assert against whatever the seed provides. Read `src/test/db.ts`.)

- [ ] **Step 2:** fail. **Step 3:** Implement:

```ts
const removeSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid().nullable().optional(),
});
type RemoveInput = z.infer<typeof removeSchema>;

export async function applyMemberRemove(input: RemoveInput) {
	const [member] = await db.select().from(members)
		.where(and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)));
	if (!member) throw new Error("Member not found.");
	if (member.userId) throw new Error("That member is a signed-in account and can't be removed.");

	await db.transaction(async (tx) => {
		// Release their upcoming, non-cancelled slots (logged) before deleting.
		const upcoming = await tx.select({ id: roleSlots.id, clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(and(
				eq(roleSlots.assignedMemberId, input.memberId),
				gte(meetings.scheduledAt, new Date()),
				ne(meetings.status, "cancelled"),
			));
		for (const s of upcoming) {
			await tx.delete(speakerDetails).where(eq(speakerDetails.slotId, s.id));
			await tx.update(roleSlots)
				.set({ assignedMemberId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, s.id));
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId ?? null,
				action: "release",
				targetType: "slot",
				targetId: s.id,
				detail: { fromMemberId: input.memberId },
			});
		}
		// Delete the member (member_availability cascades; past slot refs set null).
		await tx.delete(members).where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_remove",
			targetType: "member",
			targetId: input.memberId,
			detail: { name: member.name },
		});
	});
	return { ok: true as const };
}

export const removeMember = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);
		return applyMemberRemove(data);
	});
```

`speakerDetails` import: add to the `#/db/schema` import in `members.ts`. (Deleting the member's `member_remove` targetId references the now-deleted member, but `activity_log.targetId` is a plain text column with no FK — fine.)

- [ ] **Step 4:** run → pass; tsc 0. **Step 5:** commit `feat(server): removeMember (auto-release upcoming, authed VPE)`.

---

### Task 4: formatter cases for the new actions

**Files:** Modify `src/lib/activity-format.ts` + `src/lib/activity-format.test.ts`

- [ ] **Step 1 (failing test):** add cases — `member_edit` → `/updated .* details/i` (or similar), `member_merge` → `/merged/i` and mentions the absorbed/keeper, `member_remove` → `/removed/i`. The formatter only has the `ActivityEntry` fields; `member_merge`/`member_edit` specifics live in `detail` which `ActivityEntry` does NOT currently surface. Keep it simple and DRY: render generic phrases from the fields available —
  - `member_edit` → `updated ${subjectName ?? "a member"}'s details` (note: `member_edit`'s `targetId` is the member, but `subjectName` is derived from `detail.memberId`/`name`, which edit doesn't set — so `subjectName` will be null; render `updated a member's details`). **Acceptable** — or, if you want the name, that's a `loadActivity` enrichment change (out of scope; do NOT change the server). Use the generic phrase.
  - `member_merge` → `merged a duplicate member`.
  - `member_remove` → `removed a member`.
- [ ] **Step 2:** fail. **Step 3:** add the three `case` branches to the `switch` in `formatActivity`. **Step 4:** pass; tsc 0. **Step 5:** commit `feat(lib): format member_edit/merge/remove activity`.

> If you want richer phrasing (names), that requires `loadActivity` to also resolve `member_merge`'s `detail.absorbedName`/`keeperName` etc. — **out of scope for this plan**; note it as a follow-up, don't expand the server fn here.

---

### Task 5: Roster management UI

**Files:** Modify `src/routes/_authed/index.tsx` (roster view); optionally `src/routes/_authed/members.$id.tsx`

- [ ] **Step 1:** Read `src/routes/_authed/index.tsx` (the "Manage · Roster" view; uses `listClubMembers` → `{id,name,email,office,userId,createdAt}` + speech counts) and `src/components/ui/dialog`. Add per-member actions (a row menu or buttons), gated so a `userId`-linked member shows no Remove and can't be the absorbed in a merge:
  - **Edit:** a Dialog with name/email/phone/office inputs (prefill from the row; phone may need `getMemberProfile` or extend `listClubMembers` to include phone — prefer reading what's already loaded and add phone to `listClubMembers`'s select if needed, a 1-line additive change). Submit → `editMember({ data: { clubId, memberId, actorMemberId: currentMemberId, ...fields } })` → toast + `router.invalidate()`.
  - **Merge:** a Dialog to pick the keeper + the duplicate to absorb (two member selects, or "merge X into …" from a row). Submit → `mergeMembers({ data: { clubId, keeperId, absorbedId, actorMemberId: currentMemberId } })`. Disable choosing a `userId`-linked member as the absorbed one. Soft-confirm ("Merge X into Y? X's roles and history move to Y, then X is removed.").
  - **Remove:** a confirm Dialog ("Remove X? Their upcoming roles are released."). Hidden/disabled for `userId`-linked members. Submit → `removeMember({ data: { clubId, memberId, actorMemberId: currentMemberId } })`.
  - `clubId` + `currentMemberId` from `Route.useRouteContext()` (the `_authed` context: `{ authUser, clubs, currentMemberId }`; clubId = `clubs[0].clubId`). Every mutation: try/`toast`/`await router.invalidate()`; busy-disable buttons. Match the workspace design system + how sibling routes do dialogs/mutations.
- [ ] **Step 2:** `bun run build` → succeeds; `bunx tsc --noEmit` → 0; `bun run check` → 0 in changed files. **Step 3:** commit `feat(workspace): roster edit/merge/remove UI`.

---

### Task 6: Full green + boundary

- [ ] **Step 1:** `bunx tsc --noEmit` 0; `bun run check` 0; `bun run build` 0; `bunx vitest run` (unit: formatter) pass. Controller: `TEST_DATABASE_URL=… bunx vitest run` → all integration pass (roster-mgmt + existing).
- [ ] **Step 2:** `grep -n "requireUser\|requireClubRole" src/server/members.ts` → present on editMember/mergeMembers/removeMember (NOT on the existing public `listMembers`/`addMember`). `grep -rn "editMember\|mergeMembers\|removeMember" src/routes` → only under `_authed/`.
- [ ] **Step 3:** commit fixups.

---

## Self-review (against the locked decisions)
- **Merge re-points everything incl. history:** Task 2 re-points slots, availability (dedup), activity actor + jsonb subject, drops B's member_add, deletes B, logs member_merge. ✓ User-linked-absorbed rejected. ✓
- **Remove auto-releases then deletes:** Task 3 releases upcoming (logged, with fromMemberId so the feed reads coherently), deletes (cascade availability), logs member_remove; user-linked rejected. ✓
- **Full set this step:** edit (Task 1) + merge (Task 2) + remove (Task 3) + UI (Task 5). ✓
- **Authed VPE + club-scoped:** all three wrappers `requireUser` + `requireClubRole(admin|vpe)`; plain fns verify member∈club. Task 6 greps the boundary. ✓
- **Activity log integration:** new actions logged; formatter renders them (Task 4). ✓
- **Testing:** plain `applyX` fns DB-tested via `vi.mock("#/db")`; controller runs the DB suite. ✓
- **Type/name consistency:** `applyMemberEdit/Merge/Remove` + `editMember/mergeMembers/removeMember`; `detail` shapes match what `loadActivity`/the formatter read (`memberId`, `fromMemberId`, `name`; merge/edit details are extra and ignored by the feed).

## STOP conditions
- If a `member` FK or `member_availability` unique constraint behaves differently than assumed and a merge/remove tx errors in a way the plan didn't anticipate, STOP and report the exact constraint.
- If the jsonb `jsonb_set` bind/cast doesn't update `detail` (test shows the subject still resolves to the absorbed id), STOP — don't ship a half-merge.
- If the roster view's data/context shape differs from the above after reading it, adapt and report.

## Maintenance / follow-ups
- Richer merge/edit feed phrasing (names) needs `loadActivity` to resolve `member_merge`/`member_edit` detail — deferred.
- One-tap undo from the log still deferred.
- `editMember`/contact fields may want validation (phone format) later; v1 trusts input.
