# GavelUp Phase B — De-auth the member-facing server layer

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps, TDD.

**Goal:** Make the member-facing server fns work **without a session** (public reads + trust-based member-keyed writes), so the public member mobile surface (#33) can call them — while keeping VPE-management fns authed.

**Architecture:** Phase A already keys writes to `memberId`/`actorMemberId` and added `requireMemberInClub`. Phase B removes the `requireUser`/`requireMembership` *gates* from the **member-facing** fns (reads use an *optional* session only to compute `canManage`), adds the new public fns the member UI needs (`listMembers`, `addMember`, `setAvailability`, `clearAvailability`, `listMemberCommitments`), and leaves VPE-only fns authed. The identity is the localStorage `memberId` the UI passes (decided in the member-UI spec).

**Tech Stack:** TanStack Start server fns, Drizzle, Zod, Vitest (`skipIf(!hasTestDb)` integration tests).

**Spec:** `…-gavelup-self-serve-mvp-design.md` §1/§3; `…-gavelup-member-mobile-ui-design.md`. Cutover plan §"Phase B".

## Public vs authed — the decision (apply exactly)

| Fn | After Phase B |
|---|---|
| `getMeeting`, `listUpcomingMeetings` (`meetings.ts`) | **PUBLIC** — drop `requireUser`/`requireMembership`; `getMeeting` resolves an *optional* session for `canManage` |
| `claimSlot`, `releaseSlot`, `reassignSlot` (`slots.ts`) | **PUBLIC** — drop `requireUser`/`requireMembership`; keep `requireMemberInClub` (trust guard) |
| `listMembers`, `addMember` (new `members.ts`) | **PUBLIC** |
| `setAvailability`, `clearAvailability` (new `availability.ts`) | **PUBLIC** |
| `listMemberCommitments(memberId)` (new, `meetings.ts`) | **PUBLIC** |
| `createMeeting` (`meetings.ts`) | **stays AUTHED** (`requireClubRole`) |
| `confirmSlot`, `unconfirmSlot` (`slots.ts`) | **stays AUTHED** (VPE action) |
| `listClubMembers`, `getMemberProfile`, `listMySpeeches` (`club.ts`), `getNextMeeting`, `listMyCommitments` (`meetings.ts`), `getAuthContext` | **stay AUTHED** (VPE workspace) |

The VPE workspace keeps working: its routes are `_authed` (route-level), its reads keep `canManage` (now via optional session), and its claim calls already pass `currentMemberId` (Phase A view glue).

## Commands
Typecheck `bunx tsc --noEmit` · lint `bun run check` · tests (no DB) `bunx vitest run` · tests (DB) `TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test bunx vitest run`. Local DB per `src/server/claim.integration.test.ts`.

## File structure
- Modify `src/server/meetings.ts` (de-auth `getMeeting`/`listUpcomingMeetings`; optional session for `canManage`; add `listMemberCommitments`).
- Modify `src/server/slots.ts` (de-auth `claimSlot`/`releaseSlot`/`reassignSlot`; keep `confirm`/`unconfirm` authed).
- Create `src/server/members.ts` (`listMembers`, `addMember`).
- Create `src/server/availability.ts` (`setAvailability`, `clearAvailability`).
- Modify `src/server/guards.ts` only if a small `getSessionUser`-based optional helper is needed (it already exists).
- Tests: extend `claim.integration.test.ts`; create `members.integration.test.ts`, `availability.integration.test.ts`, `public-reads.integration.test.ts`.

---

### Task 1: De-auth the reads (optional session for `canManage`)

**Files:** Modify `src/server/meetings.ts`; Test: `src/server/public-reads.integration.test.ts`

- [ ] **Step 1 (failing test):** `getMeeting` + `listUpcomingMeetings` return data with **no session**:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hasTestDb, seedClub, cleanup, type SeededClub } from "#/test/db";

describe.skipIf(!hasTestDb)("public reads (no session)", () => {
  let seed: SeededClub;
  beforeEach(async () => { seed = await seedClub(); });
  afterEach(async () => { await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]); });

  it("getMeeting works without a session and reports canManage=false", async () => {
    const { getMeeting } = await import("#/server/meetings");
    const res = await getMeeting({ data: seed.meetingId });
    expect(res.meeting?.id).toBe(seed.meetingId);
    expect(res.canManage).toBe(false);
  });
  it("listUpcomingMeetings works without a session", async () => {
    const { listUpcomingMeetings } = await import("#/server/meetings");
    const rows = await listUpcomingMeetings({ data: seed.clubId });
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 2:** Run with DB → fail (the fns currently `requireUser`, which throws with no request).
- [ ] **Step 3:** In `getMeeting`: drop `requireUser()`; resolve `const sessionUser = await getSessionUser()` (may be null) and pass its id (or null) into `loadMeetingDetail`. In `loadMeetingDetail(meetingId, currentUserId?: string | null)`: drop `requireMembership`; compute `canManage` only when `currentUserId` is set (look up that user's admin/vpe membership), else `false`. In `listUpcomingMeetings`: drop `requireUser()`/`requireMembership()`. Keep `getNextMeeting` authed (it still `requireUser()` then passes the id to `loadMeetingDetail`).
- [ ] **Step 4:** Run → pass. `bunx tsc --noEmit` → 0.
- [ ] **Step 5:** Commit `feat(server)!: public getMeeting + listUpcomingMeetings (optional session for canManage)`.

### Task 2: `listMemberCommitments(memberId)` (public)

**Files:** Modify `src/server/meetings.ts`; Test: `src/server/public-reads.integration.test.ts`

- [ ] **Step 1 (failing test):** after claiming a slot for `seed.memberId`, `listMemberCommitments(seed.memberId)` (no session) returns it.
- [ ] **Step 2:** fail. **Step 3:** Add `listMemberCommitments` — a public `createServerFn` validating a `memberId` (uuid), filtering `roleSlots.assignedMemberId = memberId` + future/non-cancelled meetings, returning the same shape `listMyCommitments` does (reuse its select; just key by the param instead of the session user). Leave `listMyCommitments` (authed, VPE dashboard) as-is. **Step 4:** pass; tsc 0. **Step 5:** commit `feat(server): public listMemberCommitments(memberId)`.

### Task 3: De-auth the writes (keep the trust guard)

**Files:** Modify `src/server/slots.ts`; Test: `src/server/claim.integration.test.ts`

- [ ] **Step 1 (failing test):** `claimSlot`/`releaseSlot`/`reassignSlot` succeed with **no session** (currently `requireUser` blocks):

```ts
it("claimSlot works without a session (member-keyed, trust-based)", async () => {
  const { claimSlot } = await import("#/server/slots");
  await claimSlot({ data: { slotId: seed.slotId, memberId: seed.memberId, actorMemberId: seed.memberId } });
  // assert assignedMemberId + activity row as in the Phase A test
});
```

- [ ] **Step 2:** fail. **Step 3:** In `claimSlot`/`releaseSlot`/`reassignSlot`: remove `requireUser()` and `requireMembership(...)`; keep `requireMemberInClub(memberId|actorMemberId, slot.clubId)` (already added in Phase A) as the only guard. Leave `confirmSlot`/`unconfirmSlot` **unchanged** (they keep `requireUser`/`requireClubRole` — VPE actions). **Step 4:** pass; existing race-guard tests still pass; tsc 0. **Step 5:** commit `feat(server)!: public member-keyed claim/release/reassign`.

### Task 4: `members.ts` — public roster list + self-add

**Files:** Create `src/server/members.ts`; Test: `src/server/members.integration.test.ts`

- [ ] **Step 1 (failing tests):** `listMembers(clubId)` (no session) returns the roster; `addMember({clubId, name})` inserts + logs `member_add`.
- [ ] **Step 2:** fail. **Step 3:** Implement (public — no auth):

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
      .from(members).where(eq(members.clubId, clubId)).orderBy(asc(members.name)));

const addMemberSchema = z.object({ clubId: z.string().uuid(), name: z.string().trim().min(1) });
export const addMember = createServerFn({ method: "POST" })
  .validator((i: unknown) => addMemberSchema.parse(i))
  .handler(async ({ data }) => {
    const [m] = await db.insert(members).values({ clubId: data.clubId, name: data.name }).returning({ id: members.id });
    await logActivity(db, { clubId: data.clubId, actorMemberId: m.id, action: "member_add", targetType: "member", targetId: m.id, detail: { name: data.name } });
    return { id: m.id };
  });
```

- [ ] **Step 4:** pass; tsc 0. **Step 5:** commit `feat(server): public roster list + self-add`.

### Task 5: `availability.ts` — set/clear

**Files:** Create `src/server/availability.ts`; Test: `src/server/availability.integration.test.ts`

- [ ] **Step 1 (failing tests):** `setAvailability` inserts (idempotent via `onConflictDoNothing`) + logs `availability_set`; `clearAvailability` deletes + logs `availability_clear`.
- [ ] **Step 2:** fail. **Step 3:** Implement (public) per the cutover plan's availability code (`memberId`, `meetingId`, `clubId` payload; `memberAvailability` table). **Step 4:** pass; tsc 0. **Step 5:** commit `feat(server): public availability set/clear`.

### Task 6: Authed fns still gated (regression guard)

**Files:** Test only — `src/server/public-reads.integration.test.ts`

- [ ] **Step 1:** Add a test asserting a VPE-only fn still rejects without a session — e.g. `await expect(createMeeting({ data: {...} })).rejects.toThrow()` (no session → `requireUser` throws), and the same for `confirmSlot`. This locks the selective-de-auth boundary so a later change can't accidentally make management public.
- [ ] **Step 2–3:** Run; confirm they throw (they should — those fns are unchanged). **Step 4:** commit `test: lock authed boundary for createMeeting/confirmSlot`.

### Task 7: Full green + boundary grep

- [ ] `bunx vitest run` (no DB) → 0, integration skipped. `TEST_DATABASE_URL=… bunx vitest run` → all pass. `bun run check` → 0. `bun run build` → 0.
- [ ] `grep -rn "requireUser\|requireMembership" src/server/members.ts src/server/availability.ts` → **none** (public fns). `grep -n "requireUser" src/server/slots.ts` → only in `confirmSlot`/`unconfirmSlot`. `grep -n "requireUser" src/server/meetings.ts` → only in `getNextMeeting`/`listMyCommitments`/`createMeeting`.
- [ ] Commit any fixups.

---

## Self-review (against the spec)

- **Public member fns:** reads (Task 1–2), writes (Task 3), roster (Task 4), availability (Task 5) — match the member-UI spec's "server fns consumed" list. ✓
- **Selective de-auth honored:** Task 6 locks createMeeting/confirm as authed; Task 7 greps the boundary. ✓
- **VPE workspace unbroken:** `canManage` now via optional session (Task 1); claim calls already pass `currentMemberId`; authed reads/management unchanged. The build + full suite (Task 7) catch breakage. ✓
- **Placeholder scan:** every fn has concrete code; tests have real assertions.
- **Type consistency:** `memberId`/`actorMemberId` payloads, `requireMemberInClub`, `logActivity(db|tx, …)`, `member_add`/`availability_*` enum values all match Phase A + the foundation.

## After Phase B
The member mobile UI (#33, spec `…-gavelup-member-mobile-ui-design.md`) can be built on these public fns. The localStorage `memberId` identity is the client side of the contract these fns already accept.
