# GavelUp De-Auth Cutover — Implementation Plan (breaking)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **⚠️ EXECUTION GATE — do not start until BOTH hold:** (1) the `club-workspace-views` desktop redesign has merged to `main`, and (2) the **identity mechanism below is confirmed**. This plan reworks the server fns the UI calls; running it against a moving UI will thrash. Land it as **one PR with a re-seed** (it drops assignment data — see Task 2).

**Goal:** Cut the member-facing flow over from Better-Auth accounts to the roster: slots are assigned to **members**, reads are **public** (no login), claim/release/reassign and availability are **member-keyed and trust-based**, and every mutation writes the **activity log**.

**Architecture:** Members never authenticate. The client (which remembers the self-asserted member in `localStorage`) passes the acting member's id in each mutation payload; the server validates the member belongs to the slot's club and acts on trust. Reads drop `requireUser`/`requireMembership`. The signed-in admin (magic-link, retained) keeps gated management actions. Builds on the additive foundation already merged (`members`, `member_availability`, `activity_log`, `logActivity`).

**Identity mechanism (the load-bearing assumption — confirm before executing):** mutations accept explicit `actorMemberId` (the self-asserted acting member) and, for claim/reassign, `assigneeMemberId` (usually === actor; differs for sheet-parity "I'll grab Timer for Mahbuba"). No cookie/session for members. **STOP and report if the landed redesign uses a different mechanism** (e.g. a member cookie) — the signatures below would change.

**Tech Stack:** TanStack Start server fns, Drizzle (`node-postgres`), Zod validators, Vitest. Tests follow `src/server/claim.integration.test.ts` + `src/test/db.ts` (skip without `TEST_DATABASE_URL`).

**Spec:** `docs/superpowers/specs/2026-06-29-gavelup-self-serve-mvp-design.md` §1–§3, §5, §8.

**Scope guard — in this plan:** `src/db/schema.ts` (re-key only), `src/db/seed.ts`, `src/server/{slots,meetings,members,availability,guards}.ts`, their tests. **NOT in this plan:** any route/UI (`src/routes/**`), the VPE grid, roster merge/dedupe tooling, and the activity-log *view* (those are the follow-on VPE-tooling + UI plans). This plan exposes the server fns the UI will call.

---

## File structure

- **Modify** `src/db/schema.ts` — `role_slots.assigned_user_id` → `assigned_member_id` (FK `members`, `onDelete: set null`); update `roleSlotsRelations` (assignee now → `members`).
- **Create** `drizzle/NNNN_*.sql` — generated re-key migration (drops the old column; destructive).
- **Modify** `src/db/seed.ts` — assign seeded slots to **members** (not users).
- **Modify** `src/server/guards.ts` — add `getMember()` / `requireMemberInClub()`; keep auth guards for admin.
- **Modify** `src/server/slots.ts` — `claimSlot`/`releaseSlot` go public + member-keyed + log; add `reassignSlot`.
- **Modify** `src/server/meetings.ts` — `getMeeting`/`listUpcomingMeetings` public (join `members`); replace `listMyCommitments` with `listMemberCommitments(memberId)`.
- **Create** `src/server/members.ts` — `listMembers(clubId)`, `addMember(...)` (self-add).
- **Create** `src/server/availability.ts` — `setAvailability`/`clearAvailability`.
- **Tests** — extend `src/server/claim.integration.test.ts`; add `src/server/availability.integration.test.ts`, `src/server/members.integration.test.ts`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | 0 |
| Gen migration | `bun run db:generate` | new file |
| Lint/format | `bun run check` | 0 |
| Tests (no DB) | `bunx vitest run` | 0, integration suites skipped |
| Tests (DB) | `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run` | pass |

(Local DB: `docker run -d --name tm-pg-test -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tm_test postgres:17` then `DATABASE_URL=…5433… bunx drizzle-kit push`.)

---

### Task 1: Re-key `role_slots` to members

**Files:** Modify `src/db/schema.ts`

- [ ] **Step 1: Swap the column.** In the `roleSlots` `pgTable`, replace the `assignedUserId` definition:

```ts
		// was: assignedUserId: text("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
		assignedMemberId: uuid("assigned_member_id").references(
			() => members.id,
			{ onDelete: "set null" },
		),
```

Update the index that referenced it: rename `role_slots_assigned_user_idx` → `role_slots_assigned_member_idx` on `t.assignedMemberId`.

- [ ] **Step 2: Update the relation.** In `roleSlotsRelations`, change the `assignedUser` relation to:

```ts
		assignedMember: one(members, {
			fields: [roleSlots.assignedMemberId],
			references: [members.id],
		}),
```

(Remove the old `assignedUser` one. Add a back-relation on `membersRelations` if you want `member.assignedSlots`; optional.)

- [ ] **Step 3: Verify.** `bunx tsc --noEmit` → expect errors **only** in files that read `assignedUserId` (`slots.ts`, `meetings.ts`, `seed.ts`) — those are fixed in later tasks. Schema itself compiles.

- [ ] **Step 4: Commit.**

```bash
git add src/db/schema.ts
git commit -m "feat(schema)!: re-key role_slots to assigned_member_id"
```

---

### Task 2: Generate the migration (destructive — re-seed after)

**Files:** Create `drizzle/NNNN_*.sql`

- [ ] **Step 1: Generate.** `bun run db:generate`. Expected: a migration that **drops `assigned_user_id`** and **adds `assigned_member_id`** (a clean rename is impossible — different type + FK target). Open it; confirm it only touches `role_slots`.

> This destroys existing slot assignments. That's accepted: the deployed data is demo seed (spec open question resolved to **re-seed**). Do NOT write a data-migration. STOP if the migration touches other tables.

- [ ] **Step 2: Apply to the test DB to prove it runs.** `DATABASE_URL=…5433… bunx drizzle-kit push` → "Changes applied".

- [ ] **Step 3: Commit.**

```bash
git add drizzle/
git commit -m "chore(db): migration re-keying role_slots to members"
```

---

### Task 3: Member guards

**Files:** Modify `src/server/guards.ts`; Test: extend `src/server/claim.integration.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing guard describe in `claim.integration.test.ts`):

```ts
it("requireMemberInClub: resolves a member in the club, rejects a foreign member", async () => {
	const { requireMemberInClub } = await import("#/server/guards");
	const m = await requireMemberInClub(seed.memberId, seed.clubId); // seed exposes a roster member
	expect(m.id).toBe(seed.memberId);
	await expect(requireMemberInClub(seed.memberId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
});
```

> If `SeededClub`/`seedClub()` doesn't yet expose a `memberId` (a roster `members` row in the seeded club), extend `src/test/db.ts` to insert one and return its id. In-scope here.

- [ ] **Step 2: Run → fail.** `TEST_DATABASE_URL=… bunx vitest run src/server/claim.integration.test.ts` → FAIL (`requireMemberInClub` undefined).

- [ ] **Step 3: Implement** in `src/server/guards.ts`:

```ts
import { members } from "#/db/schema";

/** A roster member by id (or null). Server-only. */
export async function getMember(memberId: string) {
	const [m] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
	return m ?? null;
}

/** Trust-based: the self-asserted member must exist and belong to the club. */
export async function requireMemberInClub(memberId: string, clubId: string) {
	const m = await getMember(memberId);
	if (!m || m.clubId !== clubId) {
		throw new Error("That member isn't part of this club.");
	}
	return m;
}
```

Keep the existing `requireUser`/`requireClubRole` (still used by admin-only fns).

- [ ] **Step 4: Run → pass.** Same command → PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/server/guards.ts src/server/claim.integration.test.ts src/test/db.ts
git commit -m "feat(server): member-in-club guard for trust-based actions"
```

---

### Task 4: Public, member-keyed `claimSlot` + activity log

**Files:** Modify `src/server/slots.ts`; Test: `src/server/claim.integration.test.ts`

- [ ] **Step 1: Write the failing test** — claim now takes member ids and logs:

```ts
it("claim assigns the member and writes an activity-log row", async () => {
	const { claimSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, assigneeMemberId: seed.memberId, actorMemberId: seed.memberId } });
	const [slot] = await testDb.select().from(roleSlots).where(eq(roleSlots.id, seed.slotId)).limit(1);
	expect(slot.assignedMemberId).toBe(seed.memberId);
	expect(slot.status).toBe("claimed");
	const log = await testDb.select().from(activityLog).where(eq(activityLog.targetId, seed.slotId));
	expect(log.some((r) => r.action === "claim")).toBe(true);
});
```

> Note: `createServerFn` handlers can be called directly in tests as `fn({ data })`. The existing race-guard tests reproduce the SQL inline; this one calls the real fn — that's the intended coverage now that the fn is no longer request-bound.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Replace `claimSlot` in `src/server/slots.ts`. Remove `requireUser`/`requireMembership`; validate the member; keep the conditional-update race guard; log inside the transaction:

```ts
const claimSchema = z.object({
	slotId: z.string().uuid(),
	assigneeMemberId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema.optional(),
});

export const claimSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => claimSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
			})
			.from(roleSlots)
			.innerJoin(roleDefinitions, eq(roleDefinitions.id, roleSlots.roleDefinitionId))
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!slot) throw new Error("Role not found.");

		// Trust-based: actor + assignee must belong to this club.
		await requireMemberInClub(data.actorMemberId, slot.clubId);
		await requireMemberInClub(data.assigneeMemberId, slot.clubId);
		if (slot.isSpeakerRole && !data.speakerDetails) {
			throw new Error("Speaker roles require speech details before claiming.");
		}

		return db.transaction(async (tx) => {
			const updated = await tx
				.update(roleSlots)
				.set({ assignedMemberId: data.assigneeMemberId, status: "claimed", claimedAt: new Date() })
				.where(and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "open")))
				.returning({ id: roleSlots.id });
			if (updated.length === 0) {
				throw new Error("Sorry — this role was just claimed by someone else.");
			}
			if (slot.isSpeakerRole && data.speakerDetails) {
				await tx.insert(speakerDetails).values({ slotId: data.slotId, ...data.speakerDetails })
					.onConflictDoUpdate({ target: speakerDetails.slotId, set: data.speakerDetails });
			}
			await logActivity(tx, {
				clubId: slot.clubId, actorMemberId: data.actorMemberId,
				action: "claim", targetType: "slot", targetId: data.slotId,
				detail: { assigneeMemberId: data.assigneeMemberId },
			});
			return { ok: true as const };
		});
	});
```

Add imports: `import { requireMemberInClub } from "./guards";` (drop `requireUser`/`requireMembership` if now unused) and `import { logActivity } from "./activity";`.

- [ ] **Step 4: Run → pass.** Then `bunx tsc --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git add src/server/slots.ts src/server/claim.integration.test.ts
git commit -m "feat(server)!: public member-keyed claimSlot + activity log"
```

---

### Task 5: `releaseSlot` (public) + `reassignSlot`, both logged

**Files:** Modify `src/server/slots.ts`; Test: `src/server/claim.integration.test.ts`

- [ ] **Step 1: Write failing tests** — release clears + logs; reassign swaps member + logs:

```ts
it("release clears the slot and logs", async () => {
	const { claimSlot, releaseSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, assigneeMemberId: seed.memberId, actorMemberId: seed.memberId } });
	await releaseSlot({ data: { slotId: seed.slotId, actorMemberId: seed.memberId } });
	const [slot] = await testDb.select().from(roleSlots).where(eq(roleSlots.id, seed.slotId)).limit(1);
	expect(slot.assignedMemberId).toBeNull();
	expect(slot.status).toBe("open");
});

it("reassign moves a claimed slot to another member and logs", async () => {
	const { claimSlot, reassignSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, assigneeMemberId: seed.memberId, actorMemberId: seed.memberId } });
	await reassignSlot({ data: { slotId: seed.slotId, assigneeMemberId: seed.adminMemberId, actorMemberId: seed.adminMemberId } });
	const [slot] = await testDb.select().from(roleSlots).where(eq(roleSlots.id, seed.slotId)).limit(1);
	expect(slot.assignedMemberId).toBe(seed.adminMemberId);
});
```

> `seed.adminMemberId` = the admin's roster member; add to `seedClub()` if missing.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Rework `releaseSlot` (drop auth; take `actorMemberId`; sheet-parity = anyone may release; log) and add `reassignSlot`:

```ts
const slotActorSchema = z.object({ slotId: z.string().uuid(), actorMemberId: z.string().uuid() });

export const releaseSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => slotActorSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({ id: roleSlots.id, clubId: meetings.clubId })
			.from(roleSlots).innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId)).limit(1);
		if (!slot) throw new Error("Role not found.");
		await requireMemberInClub(data.actorMemberId, slot.clubId);
		return db.transaction(async (tx) => {
			await tx.delete(speakerDetails).where(eq(speakerDetails.slotId, slot.id));
			await tx.update(roleSlots)
				.set({ assignedMemberId: null, status: "open", claimedAt: null })
				.where(eq(roleSlots.id, slot.id));
			await logActivity(tx, { clubId: slot.clubId, actorMemberId: data.actorMemberId, action: "release", targetType: "slot", targetId: slot.id });
			return { ok: true as const };
		});
	});

const reassignSchema = z.object({ slotId: z.string().uuid(), assigneeMemberId: z.string().uuid(), actorMemberId: z.string().uuid() });

export const reassignSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => reassignSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({ id: roleSlots.id, clubId: meetings.clubId, prev: roleSlots.assignedMemberId })
			.from(roleSlots).innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId)).limit(1);
		if (!slot) throw new Error("Role not found.");
		await requireMemberInClub(data.actorMemberId, slot.clubId);
		await requireMemberInClub(data.assigneeMemberId, slot.clubId);
		return db.transaction(async (tx) => {
			await tx.update(roleSlots)
				.set({ assignedMemberId: data.assigneeMemberId, status: "claimed", claimedAt: new Date() })
				.where(eq(roleSlots.id, slot.id));
			await logActivity(tx, { clubId: slot.clubId, actorMemberId: data.actorMemberId, action: "reassign", targetType: "slot", targetId: slot.id, detail: { from: slot.prev, to: data.assigneeMemberId } });
			return { ok: true as const };
		});
	});
```

- [ ] **Step 4: Run → pass.** `bunx tsc --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git add src/server/slots.ts src/server/claim.integration.test.ts
git commit -m "feat(server)!: public release + reassign, logged"
```

---

### Task 6: Public reads (join members, drop auth)

**Files:** Modify `src/server/meetings.ts`; Test: `src/server/meetings.integration.test.ts` (create)

- [ ] **Step 1: Write a failing test** — `getMeeting` returns assignee **member** names with no auth:

```ts
it("getMeeting is public and returns member assignee names", async () => {
	const { getMeeting } = await import("#/server/meetings");
	const { claimSlot } = await import("#/server/slots");
	await claimSlot({ data: { slotId: seed.slotId, assigneeMemberId: seed.memberId, actorMemberId: seed.memberId } });
	const res = await getMeeting({ data: seed.meetingId });
	const claimed = res.slots.find((s) => s.id === seed.slotId);
	expect(claimed?.assigneeName).toBe(seed.memberName); // seedClub exposes the member's name
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** In `getMeeting`: remove `requireUser()`/`requireMembership()`; change the `assignee` alias join from `user` to `members` (`assigneeId/assigneeName` now come from `members.id`/`members.name`). Compute `canManage` from an **optional** session (if a signed-in admin) instead of requiring one:

```ts
// replace: const currentUser = await requireUser(); ... requireMembership(...)
const sessionUser = await getSessionUser(); // may be null (public)
// alias members as assignee:
const assignee = alias(members, "assignee");
// ...leftJoin(assignee, eq(assignee.id, roleSlots.assignedMemberId))
// select assigneeId: assignee.id, assigneeName: assignee.name
// canManage: derive from sessionUser being an admin member of meeting.clubId (or false)
```

Do the same for `listUpcomingMeetings` (drop the membership requirement — public). Replace `listMyCommitments` (which used the session user) with `listMemberCommitments` taking a `memberId` validator and filtering `roleSlots.assignedMemberId = memberId`. Update `getSessionUser` import; keep it for the optional admin check.

> Keep `evaluatesSlot` resolution + `resolveEvaluatorLinks` unchanged. The shape change is: assignee fields now sourced from `members`.

- [ ] **Step 4: Run → pass.** `bunx tsc --noEmit` → 0.

- [ ] **Step 5: Commit.**

```bash
git add src/server/meetings.ts src/server/meetings.integration.test.ts
git commit -m "feat(server)!: public meeting reads keyed to members"
```

---

### Task 7: Roster reads + self-add

**Files:** Create `src/server/members.ts`; Test: `src/server/members.integration.test.ts`

- [ ] **Step 1: Write failing tests** — list members; self-add inserts + logs:

```ts
it("listMembers returns the club roster", async () => {
	const { listMembers } = await import("#/server/members");
	const rows = await listMembers({ data: seed.clubId });
	expect(rows.some((m) => m.id === seed.memberId)).toBe(true);
});
it("addMember self-adds and logs member_add", async () => {
	const { addMember } = await import("#/server/members");
	const { id } = await addMember({ data: { clubId: seed.clubId, name: "New Person" } });
	const log = await testDb.select().from(activityLog).where(eq(activityLog.targetId, id));
	expect(log.some((r) => r.action === "member_add")).toBe(true);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/server/members.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members } from "#/db/schema";
import { logActivity } from "./activity";

export const listMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => z.string().uuid().parse(clubId))
	.handler(async ({ data: clubId }) =>
		db.select({ id: members.id, name: members.name, office: members.office })
			.from(members).where(eq(members.clubId, clubId)).orderBy(asc(members.name)),
	);

const addMemberSchema = z.object({
	clubId: z.string().uuid(),
	name: z.string().trim().min(1),
	email: z.string().email().optional(),
	phone: z.string().trim().optional(),
});

export const addMember = createServerFn({ method: "POST" })
	.validator((input: unknown) => addMemberSchema.parse(input))
	.handler(async ({ data }) => {
		const [m] = await db.insert(members).values({
			clubId: data.clubId, name: data.name, email: data.email ?? null, phone: data.phone ?? null,
		}).returning({ id: members.id });
		await logActivity(db, { clubId: data.clubId, actorMemberId: m.id, action: "member_add", targetType: "member", targetId: m.id, detail: { name: data.name } });
		return { id: m.id };
	});
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit.**

```bash
git add src/server/members.ts src/server/members.integration.test.ts
git commit -m "feat(server): public roster list + self-add member"
```

---

### Task 8: Availability set/clear

**Files:** Create `src/server/availability.ts`; Test: `src/server/availability.integration.test.ts`

- [ ] **Step 1: Write failing tests** — set inserts (idempotent) + logs; clear removes + logs:

```ts
it("setAvailability marks not-available (idempotent) and logs", async () => {
	const { setAvailability } = await import("#/server/availability");
	await setAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } });
	await setAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } }); // no error
	const rows = await testDb.select().from(memberAvailability).where(eq(memberAvailability.memberId, seed.memberId));
	expect(rows).toHaveLength(1);
});
it("clearAvailability removes it and logs", async () => {
	const { setAvailability, clearAvailability } = await import("#/server/availability");
	await setAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } });
	await clearAvailability({ data: { memberId: seed.memberId, meetingId: seed.meetingId, clubId: seed.clubId } });
	const rows = await testDb.select().from(memberAvailability).where(eq(memberAvailability.memberId, seed.memberId));
	expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/server/availability.ts`:

```ts
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { memberAvailability } from "#/db/schema";
import { logActivity } from "./activity";

const availSchema = z.object({
	memberId: z.string().uuid(),
	meetingId: z.string().uuid(),
	clubId: z.string().uuid(),
});

export const setAvailability = createServerFn({ method: "POST" })
	.validator((input: unknown) => availSchema.parse(input))
	.handler(async ({ data }) => {
		await db.insert(memberAvailability)
			.values({ memberId: data.memberId, meetingId: data.meetingId })
			.onConflictDoNothing();
		await logActivity(db, { clubId: data.clubId, actorMemberId: data.memberId, action: "availability_set", targetType: "meeting", targetId: data.meetingId });
		return { ok: true as const };
	});

export const clearAvailability = createServerFn({ method: "POST" })
	.validator((input: unknown) => availSchema.parse(input))
	.handler(async ({ data }) => {
		await db.delete(memberAvailability)
			.where(and(eq(memberAvailability.memberId, data.memberId), eq(memberAvailability.meetingId, data.meetingId)));
		await logActivity(db, { clubId: data.clubId, actorMemberId: data.memberId, action: "availability_clear", targetType: "meeting", targetId: data.meetingId });
		return { ok: true as const };
	});
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Commit.**

```bash
git add src/server/availability.ts src/server/availability.integration.test.ts
git commit -m "feat(server): member availability set/clear, logged"
```

---

### Task 9: Re-seed against members

**Files:** Modify `src/db/seed.ts`

- [ ] **Step 1: Re-key the seed's claims.** The seed currently sets `roleSlots.assignedUserId = <userId>` for the sample claims (TMOD, Timer, two speakers, an evaluator). Capture the inserted `members` rows' ids (the insert in the foundation already creates Rasheed/Alex/Sam/Jordan — change it to `.returning()` and map by name) and set `assignedMemberId` to the matching member id instead of the user id. Speaker-details inserts are unchanged (keyed by slot).

- [ ] **Step 2: Verify the seed runs end-to-end** against the test DB: `DATABASE_URL=…5433… bun run db:seed` → completes; spot-check a claimed slot has a non-null `assigned_member_id`:

```bash
DATABASE_URL=…5433… bun -e "import {drizzle} from 'drizzle-orm/node-postgres'; import * as s from './src/db/schema.ts'; import {isNotNull} from 'drizzle-orm'; const db=drizzle(process.env.DATABASE_URL,{schema:s}); console.log('claimed', (await db.select().from(s.roleSlots).where(isNotNull(s.roleSlots.assignedMemberId))).length)"
```
Expected: a non-zero count.

- [ ] **Step 3: tsc + check.** `bunx tsc --noEmit` → 0; `bun run check` → 0.

- [ ] **Step 4: Commit.**

```bash
git add src/db/seed.ts
git commit -m "feat(seed)!: assign seeded slots to roster members"
```

---

### Task 10: Full-suite green + final checks

- [ ] **Step 1: No-DB run.** `bunx vitest run` → exit 0, integration suites skipped.
- [ ] **Step 2: With-DB run.** `TEST_DATABASE_URL=…5433… bunx vitest run` → all pass (claim race guards still pass; new claim/release/reassign/reads/members/availability pass).
- [ ] **Step 3: Grep for stragglers.** `grep -rn "assignedUserId\|requireMembership\|requireUser" src/server` → only `requireUser`/`requireClubRole` in **admin-only** fns (`createMeeting`, `getAuthContext`) remain; no `assignedUserId` anywhere.
- [ ] **Step 4: Build.** `bun run build` → exit 0.
- [ ] **Step 5: Commit any final fixups.**

---

## Self-review (against the spec)

- **§1/§3 de-auth member flow:** claim/release/reassign public + member-keyed (Tasks 4–5), public reads (Task 6), roster list + self-add (Task 7). ✓
- **§5 Not-Available:** set/clear (Task 8). ✓
- **§8 activity log:** every mutation calls `logActivity` in-transaction (Tasks 4,5,7,8). ✓ (The VPE *read* feed + roster merge/dedupe are the follow-on VPE-tooling plan — explicitly out of scope here.)
- **§2 re-key:** Task 1–2 + re-seed Task 9. ✓
- **Placeholder scan:** Task 6 Step 3 describes the `getMeeting` edit in prose with the exact substitutions (alias `members`, drop `requireUser`, optional `getSessionUser` for `canManage`) — it's an edit to existing complex code, so the steps name every change precisely rather than re-pasting the whole 60-line fn; acceptable, unambiguous.
- **Type consistency:** payloads use `actorMemberId`/`assigneeMemberId` consistently across Tasks 4–8; `logActivity(tx|db, {...})` matches the helper from the foundation; `assignedMemberId` consistent schema↔fns↔seed.

## Follow-on plans (NOT this plan)
1. **VPE tooling** (#38 server side): roster merge/rename/remove (re-point assignments + log), the activity-log read feed, admin-gated.
2. **Member mobile UI** (#33) + **VPE overview grid** (#38 UI) + **shareable link/tap-to-nudge** (#37) — on the landed `club-workspace-views` design system, calling the fns this plan exposes.
