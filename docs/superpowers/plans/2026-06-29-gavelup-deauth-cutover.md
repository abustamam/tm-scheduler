# GavelUp Roster Cutover — Implementation Plan (reconciled with PR #40)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Checkbox steps.

## Reconciliation note (2026-06-29, after PR #40)

PR #40 ("GavelUp club workspace — 5 views") landed the **VPE-facing, authed desktop workspace**, already sourcing the roster from the `members` table (post-#39). It introduced consumers my earlier draft didn't know about, and it stayed **auth-gated** (correct — the VPE signs in). So this plan is re-scoped into two phases:

- **Phase A — Re-key to members, KEEP auth (this plan, actionable now).** Re-key `role_slots.assigned_user_id` → `assigned_member_id`, update **every** consumer, and **drop the temporary `emailToUserId` user-bridge** so member history keys directly to the member. This directly closes the `TODO(cutover)` in `src/server/club.ts` and the "Roster cutover" item in `docs/persistence-todo.md`, and fixes the bug where members with no linked user show 0 history. **No auth-model change** — `requireUser`/`requireMembership` stay; the workspace keeps working.
- **Phase B — De-auth + no-auth member surface (separate, still GATED).** Make member-facing reads public + self-asserted member identity. **Gated on the member-identity mechanism being decided** (the redesign deferred it — it stayed authed) and the member mobile UI (#33). Outlined at the bottom; do NOT build it here.

**The one new contract Phase A introduces:** claim/release/reassign no longer derive the assignee from the session user — they take an explicit **`memberId`** (the assignee) and **`actorMemberId`** in the payload. In today's authed workspace the UI supplies these (the acting user's linked member, or a chosen member when filling a slot for someone). This is forward-compatible with Phase B (which just drops the auth guard; the contract is unchanged). **Confirm the workspace's claim UI passes a member id before executing** (grep the agenda view); if it currently claims "as the current user," coordinate the payload change with that view.

**Tech Stack:** TanStack Start server fns, Drizzle (`node-postgres`), Zod, Vitest. Tests follow `src/server/claim.integration.test.ts` + `src/test/db.ts`.

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-self-serve-mvp-design.md` §2 (re-key), §8 (activity log). Closes the additive-remainder of #31.

---

## Exact consumer map (from grep, on `main` @ PR #40)

Re-key (`assignedUserId` → `assignedMemberId`) + log, KEEPING auth guards:
- `src/server/slots.ts`: `claimSlot` (`:68`), `releaseSlot` (`:104,:119,:128`), `confirmSlot` (`:146`), `unconfirmSlot` (`:195`).
- `src/server/meetings.ts`: `loadMeetingDetail` assignee join (`:93`, used by `getMeeting`/`getNextMeeting`), `listMyCommitments` (`:179`).
- `src/server/club.ts`: `listClubMembers` speech bridge (`:60,:75,:82`), `getMemberProfile` (`:139,:142,:167` + bridge), `listMySpeeches` (`:239`); **delete `emailToUserId` (`:27`)**.
- `src/db/seed.ts`: 5 `assignedUserId` sets (`:232,:236,:242,:256,:284`).

Scope guard — **NOT in this plan:** removing any `requireUser`/`requireMembership` (that's Phase B), any route/UI, the VPE roster-merge tooling.

## Commands
Typecheck `bunx tsc --noEmit` · lint `bun run check` · migration `bun run db:generate` · tests (no DB) `bunx vitest run` · tests (DB) `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run`. (Local DB per `src/server/claim.integration.test.ts`.)

---

### Task 0: Confirm the claim contract (read-only, do first)

- [ ] **Step 1:** `grep -rn "claimSlot\|releaseSlot" src/routes/_authed/agenda.tsx src/routes/_authed/meetings.\$id.tsx` and read how the agenda view calls them today. Determine whether it can pass a `memberId`/`actorMemberId`.
  - If the view already has the acting member's id (it sources the roster from `members`), proceed.
  - If it claims purely "as the current user" with no member in hand, **STOP and report** — the payload change needs to land with a one-line view change, which is UI (out of this plan's scope); coordinate first.

---

### Task 1: Re-key the schema

**Files:** Modify `src/db/schema.ts`

- [ ] **Step 1:** Replace `assignedUserId` in `roleSlots` with:

```ts
		assignedMemberId: uuid("assigned_member_id").references(
			() => members.id,
			{ onDelete: "set null" },
		),
```

Rename the index `role_slots_assigned_user_idx` → `role_slots_assigned_member_idx` on `t.assignedMemberId`. In `roleSlotsRelations`, replace the `assignedUser` relation with `assignedMember: one(members, { fields: [roleSlots.assignedMemberId], references: [members.id] })`.

- [ ] **Step 2:** `bunx tsc --noEmit` → errors only in the consumer files (fixed next). Commit:

```bash
git add src/db/schema.ts && git commit -m "feat(schema)!: re-key role_slots to assigned_member_id"
```

### Task 2: Migration (destructive; re-seed follows)

- [ ] **Step 1:** `bun run db:generate` → drops `assigned_user_id`, adds `assigned_member_id` (only `role_slots`). STOP if it touches other tables.
- [ ] **Step 2:** Apply to a local test DB (`drizzle-kit push`) to prove it runs.
- [ ] **Step 3:** `git add drizzle/ && git commit -m "chore(db): migration re-keying role_slots to members"`

### Task 3: `slots.ts` — member-keyed claim/release/reassign/confirm + log (keep auth)

**Files:** Modify `src/server/slots.ts`; Test: `src/server/claim.integration.test.ts`

- [ ] **Step 1 (failing test):** claim assigns the member + logs; release clears + logs (use the seeded `members` rows; add a member to `seedClub()`/`SeededClub` if absent):

```ts
it("claim assigns a member and logs", async () => {
	const { claimSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, memberId: seed.memberId, actorMemberId: seed.memberId } });
	const [s] = await testDb.select().from(roleSlots).where(eq(roleSlots.id, seed.slotId)).limit(1);
	expect(s.assignedMemberId).toBe(seed.memberId);
	const log = await testDb.select().from(activityLog).where(eq(activityLog.targetId, seed.slotId));
	expect(log.some((r) => r.action === "claim")).toBe(true);
});
```

> Auth is still required by the fn; the test seeds an authed admin context the same way the existing claim tests do, OR (simpler) the existing tests reproduce the SQL inline — keep that pattern for the race-guard tests and add this one calling the real fn. If `requireUser` blocks the direct call in the test harness, mirror how the current passing tests handle it (they reproduce the conditional UPDATE inline). Adjust the test to the existing harness convention; the assertion (member-keyed + logged) is the point.

- [ ] **Step 2:** Run → fail. **Step 3:** Implement. In each of `claimSlot`/`releaseSlot`/`confirmSlot`/`unconfirmSlot`: keep `requireUser()`/`requireMembership(...)` (auth stays); add `memberId`/`actorMemberId` to the claim/reassign validators; set/read `assignedMemberId` instead of `assignedUserId`; validate the member via `requireMemberInClub` (add it to guards — see Task 4); and `await logActivity(tx, { clubId, actorMemberId, action, targetType: "slot", targetId })` inside each mutation's transaction. Add a `reassignSlot` (claimed→other member, logs `reassign`). Concrete claim body:

```ts
const claimSchema = z.object({
	slotId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema.optional(),
});
// handler: requireUser(); load slot+clubId+isSpeakerRole; requireMembership(user, clubId);
// requireMemberInClub(memberId, clubId); conditional UPDATE set assignedMemberId=memberId WHERE status='open';
// speakerDetails upsert; logActivity(tx, { action:"claim", actorMemberId, targetType:"slot", targetId:slotId, clubId, detail:{memberId} }).
```

`releaseSlot`: drop the `slot.assignedUserId === currentUser.id` ownership check’s *user* comparison — keep "assignee or admin may release" but compare against `assignedMemberId` (resolve the actor's member) OR, simplest for Phase A, allow assignee-or-admin via the existing admin check + log. Keep behavior equivalent; just member-keyed + logged.

- [ ] **Step 4:** Run → pass; `bunx tsc --noEmit` → 0. **Step 5:** commit `feat(server)!: member-keyed slot mutations + activity log`.

### Task 4: `requireMemberInClub` guard

**Files:** Modify `src/server/guards.ts`

- [ ] Add `getMember(memberId)` and `requireMemberInClub(memberId, clubId)` (member exists + `clubId` matches; throws otherwise). Keep `requireUser`/`requireMembership`/`requireClubRole`. Commit `feat(server): requireMemberInClub guard`.

### Task 5: `meetings.ts` — assignee + commitments keyed to members

**Files:** Modify `src/server/meetings.ts`

- [ ] In `loadMeetingDetail` (`:93`): change the `assignee` alias from `user` → `members`; `assigneeId`/`assigneeName` now from `members.id`/`members.name`; join on `roleSlots.assignedMemberId`. In `listMyCommitments` (`:179`): it filters `assignedUserId = currentUser.id` — re-key by resolving the current user's member (`members.userId = currentUser.id`) and filtering `assignedMemberId = thatMember.id`; rename to `listMemberCommitments` only if you also update its caller (dashboard) — otherwise keep the name and resolve the member internally to avoid a UI change in Phase A. Keep `requireUser`. `tsc` → 0. Commit `feat(server)!: meeting reads keyed to member assignees`.

### Task 6: `club.ts` — key history to members, delete the bridge

**Files:** Modify `src/server/club.ts`

- [ ] Delete `emailToUserId` (`:27`). In `listClubMembers`: the speech-count subquery groups by `roleSlots.assignedUserId` and maps via `emailMap` — change to group by `roleSlots.assignedMemberId` and map speeches directly per `members.id` (no bridge). In `getMemberProfile`: the param is a member id now; filter `roleSlots.assignedMemberId = <memberId>` (`:142,:167`); the evaluator join (`:139`) joins on `assignedMemberId` against `members`. In `listMySpeeches`: re-key to the member. Keep `requireUser`/`requireMembership`. This makes unlinked members show real history. `tsc` → 0; `bun run check` → 0. Commit `feat(server)!: club history keyed to members, drop user bridge`.

### Task 7: Re-seed against members

**Files:** Modify `src/db/seed.ts`

- [ ] The foundation seed already inserts `members` (Rasheed/Alex/Sam/Jordan). Change that insert to `.returning()` and build a name→memberId map. Replace the 5 `assignedUserId: <userId>` sets with `assignedMemberId: <memberId>`. Verify the seed runs against a test DB and a claimed slot has a non-null `assigned_member_id`. `tsc`/`check` → 0. Commit `feat(seed)!: assign seeded slots to members`.

### Task 8: Full green + straggler grep

- [ ] `bunx vitest run` (no DB) → 0, integration skipped. `TEST_DATABASE_URL=… bunx vitest run` → all pass (race guards still pass). `grep -rn "assignedUserId\|emailToUserId" src` → **no matches**. `bun run build` → 0. Commit any fixups.

---

## Self-review (against the spec + #40)

- **§2 re-key:** Tasks 1–2, applied to every consumer (slots/meetings/club/seed) via the grep'd map; bridge deleted (Task 6). ✓
- **§8 activity log:** wired into slot mutations (Task 3). ✓ (Roster/meeting-edit logging + the VPE read feed remain follow-on VPE tooling.)
- **Auth unchanged:** every task keeps `requireUser`/`requireMembership` — no public reads here (that's Phase B). ✓ Matches #40's authed workspace.
- **Type consistency:** `assignedMemberId` across schema/slots/meetings/club/seed; `requireMemberInClub`, `logActivity(tx, …)` match the foundation; claim payload `{memberId, actorMemberId}` consistent.
- **Risk flagged:** Task 0 gates on the agenda view's claim contract — if it claims "as current user," that's a coordinated UI change.

## Phase B — De-auth member surface (NOT this plan; still gated)
Drop `requireUser`/`requireMembership` on member-facing reads/writes; add public meeting reads + roster list + self-add (`src/server/members.ts`) + availability (`src/server/availability.ts`) + the self-asserted identity (memberId already in the write contract). **Gated on:** the member-identity mechanism being decided (the redesign deferred it) and the member mobile UI (#33). The write contract from Phase A (`memberId`/`actorMemberId`) is already the right shape, so Phase B is mostly guard removal + new public read/roster/availability fns + the mobile UI.
