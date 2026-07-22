# Person Identity Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one human = one `people` (Person) row across clubs — dedupe on the superadmin create-club path, and add a superadmin cross-club merge tool to repair existing duplicates.

**Architecture:** New pure keeper-ranking heuristic (`src/lib/person-identity.ts`); DB logic in `src/server/people-logic.ts` (`findBestPersonByEmail`, `mergePeople`, detection) and `src/server/membership-collapse-logic.ts` (`collapseMemberships`, shared with the existing within-club merge); thin superadmin-gated server fns in `src/server/people.ts`; a new `/superadmin/duplicate-people` route. No schema migration.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM + node-postgres, Vitest integration tests against `tm_test`, shadcn/ui, Biome.

**Spec:** `docs/superpowers/specs/2026-07-21-person-identity-unification-design.md`

---

## Conventions for every task

- **Server-module split (enforced by `server-modules.guard.test.ts`):** `*.ts` server-fn modules export ONLY `createServerFn`s + types; all `#/db`-touching logic lives in `*-logic.ts`. See `src/server/onboarding.ts` vs `onboarding-logic.ts`.
- **Test DB:** integration suites are `src/server/<name>.integration.test.ts`, gated `describe.skipIf(!hasTestDb)(...)`, and mock `#/db` → `testDb`:
  ```ts
  vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
  ```
  Fixtures/cleanup come from `#/test/db` (`seedClub`, `seedPerson`, `cleanup`, `hasTestDb`, `testDb`).
- **Before running any integration test**, sync the test DB schema (per `tm-test-db-sync-gotcha`): `DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force`. No schema changes here, but run it once to be safe.
- **Run a single suite:** `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/<name>.integration.test.ts`
- **Pure unit suite (no DB):** `bunx vitest run src/lib/<name>.test.ts`
- **Typecheck gate (the only real type check):** `bun run typecheck`. Lint/format gate: `bun run check`.
- Confirm the exact local `tm_test` URL from `.env.local` / prior suites' header docstrings if the one above differs.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/person-identity.ts` (create) | Pure keeper-ranking heuristic `pickKeeper()` + `KeeperCandidate` type. Shared by create-club dedupe and merge keeper-default. |
| `src/lib/person-identity.test.ts` (create) | Unit tests for the heuristic (no DB). |
| `src/server/people-logic.ts` (create) | `findBestPersonByEmail`, `mergePeople`, `checkMergeBlocks`, `getMergePreview`, `listDuplicatePeople`, `searchPeopleForMerge`. |
| `src/server/people.ts` (create) | Superadmin-gated `createServerFn` wrappers only. |
| `src/server/membership-collapse-logic.ts` (create) | `collapseMemberships(tx, clubId, keeperId, absorbedId)` — re-points all 10 membership FKs. |
| `src/server/*.integration.test.ts` (create) | Integration suites per logic module. |
| `src/server/onboarding-logic.ts` (modify) | `createClubWithAdmin` reuses an existing Person by email. |
| `src/server/members-logic.ts` (modify) | `applyMemberMerge` routes through `collapseMemberships`. |
| `src/routes/_authed/superadmin/duplicate-people.tsx` (create) | Detection groups + manual search + merge-confirm dialog. |
| `src/routes/_authed/superadmin/index.tsx` (modify) | Link to the new sub-view. |
| `src/components/app-shell.tsx` (modify) | Second Platform NavItem. |

---

# Phase 1 — Prevent (dedupe-on-write) + shared heuristic

## Task 1: Pure keeper-ranking heuristic

**Files:**
- Create: `src/lib/person-identity.ts`
- Test: `src/lib/person-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/person-identity.test.ts
import { describe, expect, it } from "vitest";
import { type KeeperCandidate, pickKeeper } from "./person-identity";

const c = (o: Partial<KeeperCandidate> & { id: string }): KeeperCandidate => ({
	linked: false,
	historyCount: 0,
	originalJoinDate: null,
	...o,
});

describe("pickKeeper", () => {
	it("returns null for an empty list", () => {
		expect(pickKeeper([])).toBeNull();
	});

	it("prefers a login-linked person over an unlinked one with more history", () => {
		const best = pickKeeper([
			c({ id: "unlinked", historyCount: 99 }),
			c({ id: "linked", linked: true, historyCount: 0 }),
		]);
		expect(best?.id).toBe("linked");
	});

	it("breaks ties among linked/unlinked by history, then oldest join, then id", () => {
		const older = new Date("2020-01-01");
		const newer = new Date("2024-01-01");
		expect(
			pickKeeper([
				c({ id: "b", historyCount: 5, originalJoinDate: newer }),
				c({ id: "a", historyCount: 5, originalJoinDate: older }),
			])?.id,
		).toBe("a"); // older join wins the history tie

		expect(
			pickKeeper([
				c({ id: "z", historyCount: 5 }),
				c({ id: "a", historyCount: 5 }),
			])?.id,
		).toBe("a"); // null join dates → id asc is the final tiebreak
	});

	it("is a pure sort — does not mutate the input array", () => {
		const input = [c({ id: "x" }), c({ id: "y", linked: true })];
		const copy = [...input];
		pickKeeper(input);
		expect(input).toEqual(copy);
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bunx vitest run src/lib/person-identity.test.ts`
Expected: FAIL — `Cannot find module './person-identity'`.

- [ ] **Step 3: Implement the heuristic**

```ts
// src/lib/person-identity.ts

/**
 * A Person considered as a merge/dedupe keeper. `historyCount` is speeches +
 * Pathways enrollments; `linked` is whether people.user_id is set.
 */
export interface KeeperCandidate {
	id: string;
	linked: boolean;
	historyCount: number;
	originalJoinDate: Date | null;
}

/**
 * The canonical "which Person is the real human" ordering, shared by create-club
 * dedupe (Part A) and the merge keeper default (Part B/C):
 *   login-linked  →  most history  →  oldest original join  →  id (stable).
 * Pure: returns the best candidate without mutating the input.
 */
export function pickKeeper<T extends KeeperCandidate>(candidates: T[]): T | null {
	if (candidates.length === 0) return null;
	const rank = (x: KeeperCandidate) => x.originalJoinDate?.getTime() ?? Infinity;
	return [...candidates].sort((a, b) => {
		if (a.linked !== b.linked) return a.linked ? -1 : 1;
		if (a.historyCount !== b.historyCount) return b.historyCount - a.historyCount;
		const ja = rank(a);
		const jb = rank(b);
		if (ja !== jb) return ja - jb; // older join (smaller time) first
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	})[0];
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `bunx vitest run src/lib/person-identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/person-identity.ts src/lib/person-identity.test.ts
git commit -m "feat(people): pure keeper-ranking heuristic for dedupe/merge"
```

---

## Task 2: `findBestPersonByEmail`

**Files:**
- Create: `src/server/people-logic.ts`
- Test: `src/server/people-logic.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/people-logic.integration.test.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathEnrollments, pathwaysPaths, people, speeches } from "#/db/schema";
import { cleanup, hasTestDb, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("findBestPersonByEmail", () => {
	let mod: typeof import("#/server/people-logic");
	const personIds: string[] = [];

	beforeEach(async () => {
		mod = await import("#/server/people-logic");
		personIds.length = 0;
	});
	afterEach(async () => {
		if (personIds.length) {
			await testDb.delete(people).where(eq(people.id, personIds[0])); // best-effort; see cleanup below
		}
		// delete every person we created (club-less people aren't cascade-cleaned)
		for (const id of personIds) await testDb.delete(people).where(eq(people.id, id));
	});

	async function person(over: Partial<typeof people.$inferInsert>): Promise<string> {
		const [row] = await testDb
			.insert(people)
			.values({ name: "P", ...over })
			.returning({ id: people.id });
		personIds.push(row.id);
		return row.id;
	}

	it("returns null when no person matches the email", async () => {
		expect(await mod.findBestPersonByEmail(`none-${randomUUID()}@x.io`)).toBeNull();
	});

	it("matches case-insensitively", async () => {
		const email = `cy-${randomUUID()}@x.io`;
		const id = await person({ email });
		expect(await mod.findBestPersonByEmail(email.toUpperCase())).toBe(id);
	});

	it("prefers the login-linked person among multiple matches (Rule B)", async () => {
		const email = `dup-${randomUUID()}@x.io`;
		await person({ email }); // unlinked
		// seedPerson creates a linked user+person pair; give it the same email.
		const linked = await seedPerson({ email });
		personIds.push(linked.personId);
		expect(await mod.findBestPersonByEmail(email)).toBe(linked.personId);
	});
});
```

> Note: confirm `seedPerson`'s signature in `src/test/db.ts` (it seeds a `user` + linked `people` row). If it does not accept an `email` override, insert a `user` row and a `people` row with `userId` set inline instead. Adjust the assertion accordingly.

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/people-logic.integration.test.ts`
Expected: FAIL — `findBestPersonByEmail` is not exported.

- [ ] **Step 3: Implement `findBestPersonByEmail`**

```ts
// src/server/people-logic.ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { pathEnrollments, people, speeches } from "#/db/schema";
import { type KeeperCandidate, pickKeeper } from "#/lib/person-identity";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

/**
 * The best existing Person for a create-club/dedupe email match (Rule B): case-
 * insensitive email, ranked by the shared keeper heuristic. Returns null on no
 * match. Runs inside the caller's transaction when one is passed.
 */
export async function findBestPersonByEmail(
	email: string,
	conn: Conn = db,
): Promise<string | null> {
	const normalized = email.trim().toLowerCase();
	if (!normalized) return null;

	const rows = await conn
		.select({
			id: people.id,
			userId: people.userId,
			originalJoinDate: people.originalJoinDate,
		})
		.from(people)
		.where(sql`lower(${people.email}) = ${normalized}`);
	if (rows.length === 0) return null;
	if (rows.length === 1) return rows[0].id;

	const ids = rows.map((r) => r.id);
	const history = await historyCounts(conn, ids);
	const candidates: KeeperCandidate[] = rows.map((r) => ({
		id: r.id,
		linked: r.userId != null,
		historyCount: history.get(r.id) ?? 0,
		originalJoinDate: r.originalJoinDate,
	}));
	return pickKeeper(candidates)?.id ?? null;
}

/** speeches + path enrollments per person id (0 when absent). */
export async function historyCounts(
	conn: Conn,
	personIds: string[],
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (personIds.length === 0) return out;
	const sp = await conn
		.select({ id: speeches.personId, n: sql<number>`count(*)::int` })
		.from(speeches)
		.where(inArray(speeches.personId, personIds))
		.groupBy(speeches.personId);
	const en = await conn
		.select({ id: pathEnrollments.personId, n: sql<number>`count(*)::int` })
		.from(pathEnrollments)
		.where(inArray(pathEnrollments.personId, personIds))
		.groupBy(pathEnrollments.personId);
	for (const r of [...sp, ...en]) out.set(r.id, (out.get(r.id) ?? 0) + r.n);
	return out;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/people-logic.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → expect no errors.
```bash
git add src/server/people-logic.ts src/server/people-logic.integration.test.ts
git commit -m "feat(people): findBestPersonByEmail (Rule B email dedupe lookup)"
```

---

## Task 3: Create-club reuses an existing Person by email

**Files:**
- Modify: `src/server/onboarding-logic.ts:226-287` (`createClubWithAdmin`)
- Test: `src/server/onboarding-logic.integration.test.ts` (create, or extend an existing onboarding suite if present)

- [ ] **Step 1: Write the failing test**

```ts
// src/server/onboarding-logic.integration.test.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people } from "#/db/schema";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("createClubWithAdmin dedupe (Rule B)", () => {
	let mod: typeof import("#/server/onboarding-logic");
	const clubIds: string[] = [];
	const personIds: string[] = [];

	beforeEach(async () => {
		mod = await import("#/server/onboarding-logic");
		clubIds.length = 0;
		personIds.length = 0;
	});
	afterEach(async () => {
		for (const id of clubIds) await cleanup(id, []);
		for (const id of personIds) await testDb.delete(people).where(eq(people.id, id));
	});

	function input(over: Partial<mod.CreateClubInput> = {}) {
		return {
			clubName: `C ${randomUUID()}`,
			clubNumber: randomUUID().slice(0, 8),
			adminName: "Rasheed",
			adminEmail: `r-${randomUUID()}@x.io`,
			...over,
		};
	}

	it("creates a fresh Person when no email match exists", async () => {
		const res = await mod.createClubWithAdmin(input());
		clubIds.push(res.clubId);
		personIds.push(res.personId);
		const [p] = await testDb.select().from(people).where(eq(people.id, res.personId));
		expect(p).toBeTruthy();
	});

	it("reuses an existing Person (one human, two memberships) on an email match", async () => {
		const email = `share-${randomUUID()}@x.io`;
		const first = await mod.createClubWithAdmin(input({ adminEmail: email }));
		clubIds.push(first.clubId);
		personIds.push(first.personId);

		const second = await mod.createClubWithAdmin(input({ adminEmail: email }));
		clubIds.push(second.clubId);

		expect(second.personId).toBe(first.personId); // same Person reused
		const rosterRows = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.personId, first.personId));
		expect(rosterRows).toHaveLength(2); // two memberships, one person
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/onboarding-logic.integration.test.ts`
Expected: FAIL — second club creates a *new* person (`second.personId !== first.personId`), so the reuse assertion fails.

- [ ] **Step 3: Modify `createClubWithAdmin`**

Add the import near the top of `src/server/onboarding-logic.ts` (imports block, line ~11):
```ts
import { findBestPersonByEmail } from "./people-logic";
```

Replace the admin-`people`-insert block (currently lines ~257-264) with a reuse-or-create block. Before:
```ts
		const [person] = await tx
			.insert(people)
			.values({
				name: input.adminName,
				email: input.adminEmail,
				// user_id LEFT NULL on purpose — #188 links on first sign-in.
			})
			.returning({ id: people.id });
		if (!person) throw new Error("Failed to create the admin person.");
```
After:
```ts
		// Reuse an existing Person on an email match (Rule B) so one human stays
		// one Person across clubs; otherwise create a fresh Person (#188 links it
		// on first sign-in). Runs in-tx so a concurrent create sees a consistent view.
		let personId = await findBestPersonByEmail(input.adminEmail, tx);
		if (!personId) {
			const [person] = await tx
				.insert(people)
				.values({ name: input.adminName, email: input.adminEmail })
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to create the admin person.");
			personId = person.id;
		}
```

Then update the membership insert (lines ~266-275) to use `personId` instead of `person.id`, and the return (lines ~279-285) to return `personId`:
```ts
		const [member] = await tx
			.insert(members)
			.values({
				clubId: club.id,
				personId,
				name: input.adminName,
				email: input.adminEmail,
				clubRole: "admin",
				status: "active",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("Failed to create the admin membership.");

		return { clubId: club.id, slug: club.slug, personId, memberId: member.id };
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/onboarding-logic.integration.test.ts`
Expected: PASS (2 tests). Also run Task 2's suite to confirm no regression.

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`.
```bash
git add src/server/onboarding-logic.ts src/server/onboarding-logic.integration.test.ts
git commit -m "feat(onboarding): create-club reuses an existing Person by email (Rule B)"
```

> **Phase-1 checkpoint:** Part A is complete and independently shippable — this alone unbreaks self-provisioning (a superadmin provisioning a club for their own email now reuses their Person, and the club renders "Linked" immediately via `listClubsForConsole`). Consider a small PR here before Phase 2.

---

# Phase 2 — Repair (merge tool)

## Task 4: `collapseMemberships` shared helper

**Files:**
- Create: `src/server/membership-collapse-logic.ts`
- Test: `src/server/membership-collapse-logic.integration.test.ts`

**Reconciliation + collision rules (from the spec):** surviving membership takes higher `club_role`, `active` if either, earliest `joined_at`, keeper's contact filled from absorbed. Re-point all 10 membership FKs; on the unique-constrained tables (`member_dues`(period), `member_availability`(meeting), `meeting_attendance`(meeting,member), `meeting_awards`(meeting,category), `notifications`(slot,member)) delete the absorbed duplicate first, then re-point; `officer_terms` dedup to one open term per position (earliest-start).

- [ ] **Step 1: Write the failing test** (covers reconcile + the data-loss-fix rows)

```ts
// src/server/membership-collapse-logic.integration.test.ts
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	duesPeriods, memberDues, members, officerTerms,
} from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("collapseMemberships", () => {
	let mod: typeof import("#/server/membership-collapse-logic");
	let club: Awaited<ReturnType<typeof seedClub>>;

	beforeEach(async () => {
		mod = await import("#/server/membership-collapse-logic");
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, club.userIds);
	});

	// Insert a second membership for the same club to be absorbed.
	async function absorbedMember(role: "admin" | "member" = "member") {
		const [p] = await testDb.insert(members).values({
			clubId: club.clubId,
			personId: club.memberPersonId, // reuse a person; see note
			name: "Absorbed",
			clubRole: role,
			status: "inactive",
		}).returning({ id: members.id });
		return p.id;
	}

	it("preserves officer_terms and member_dues (the data-loss fix) and deletes the absorbed row", async () => {
		const absorbedId = await absorbedMember();
		// Give the ABSORBED membership an open officer term + a dues row.
		await testDb.insert(officerTerms).values({
			membershipId: absorbedId, position: "secretary", termEnd: null,
		});
		const [period] = await testDb.insert(duesPeriods).values({
			clubId: club.clubId, label: "2026", dueDate: new Date("2026-04-01"),
		}).returning({ id: duesPeriods.id });
		await testDb.insert(memberDues).values({
			membershipId: absorbedId, duesPeriodId: period.id, status: "paid",
		});

		await testDb.transaction((tx) =>
			mod.collapseMemberships(tx, club.clubId, club.adminMemberId, absorbedId),
		);

		// Absorbed membership gone…
		const gone = await testDb.select().from(members).where(eq(members.id, absorbedId));
		expect(gone).toHaveLength(0);
		// …but its office + dues moved to the keeper (NOT cascade-deleted).
		const terms = await testDb.select().from(officerTerms)
			.where(eq(officerTerms.membershipId, club.adminMemberId));
		expect(terms.some((t) => t.position === "secretary")).toBe(true);
		const dues = await testDb.select().from(memberDues)
			.where(eq(memberDues.membershipId, club.adminMemberId));
		expect(dues).toHaveLength(1);
	});

	it("takes the higher club_role and active-if-either status", async () => {
		const absorbedId = await absorbedMember("admin"); // absorbed is admin, inactive
		// keeper (club.adminMemberId) is admin/active in seedClub; make a member/active
		// keeper case instead: demote keeper, then collapse an admin/inactive absorbed.
		await testDb.update(members)
			.set({ clubRole: "member", status: "active" })
			.where(eq(members.id, club.adminMemberId));

		await testDb.transaction((tx) =>
			mod.collapseMemberships(tx, club.clubId, club.adminMemberId, absorbedId),
		);

		const [keeper] = await testDb.select().from(members)
			.where(eq(members.id, club.adminMemberId));
		expect(keeper.clubRole).toBe("admin"); // higher of {member, admin}
		expect(keeper.status).toBe("active"); // active if either
	});
});
```

> **Setup note:** confirm `seedClub()`'s returned shape in `src/test/db.ts` and adjust field names (`adminMemberId`, `memberPersonId`, `clubId`, `userIds`). If it doesn't expose a member person id, insert a fresh `people` row for the absorbed membership and track it for cleanup. The two memberships must share `clubId` (same-club collapse) but may point at different persons — `collapseMemberships` operates on membership ids only.

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/membership-collapse-logic.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `collapseMemberships`**

```ts
// src/server/membership-collapse-logic.ts
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	activityLog, guests, meetingAttendance, meetingAwards, memberAvailability,
	memberDues, members, notifications, officerTerms, roleSlots, tableTopicsSpeakers,
} from "#/db/schema";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Collapse two memberships of the SAME club into the keeper, re-pointing all
 * membership-scoped history and dropping the absorbed row. Shared by the person
 * merge (same-club branch) and the within-club member merge. Must run inside a tx.
 *
 * Fixes the legacy member-merge data loss: officer_terms + member_dues are
 * re-pointed, never cascade-deleted.
 */
export async function collapseMemberships(
	tx: Tx,
	clubId: string,
	keeperId: string,
	absorbedId: string,
): Promise<void> {
	if (keeperId === absorbedId) return;
	const rows = await tx.select().from(members)
		.where(and(eq(members.clubId, clubId), sql`${members.id} in (${keeperId}, ${absorbedId})`));
	const keeper = rows.find((m) => m.id === keeperId);
	const absorbed = rows.find((m) => m.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Both memberships must be in this club.");

	// 1. Reconcile the surviving membership.
	await tx.update(members).set({
		clubRole: keeper.clubRole === "admin" || absorbed.clubRole === "admin" ? "admin" : "member",
		status: keeper.status === "active" || absorbed.status === "active" ? "active" : "inactive",
		joinedAt: earliest(keeper.joinedAt, absorbed.joinedAt),
		email: keeper.email ?? absorbed.email,
		phone: keeper.phone ?? absorbed.phone,
	}).where(eq(members.id, keeperId));

	// 2. No-unique re-points.
	await tx.update(roleSlots).set({ assignedMemberId: keeperId })
		.where(eq(roleSlots.assignedMemberId, absorbedId));
	await tx.update(tableTopicsSpeakers).set({ memberId: keeperId })
		.where(eq(tableTopicsSpeakers.memberId, absorbedId));
	await tx.update(guests).set({ convertedMembershipId: keeperId })
		.where(eq(guests.convertedMembershipId, absorbedId));

	// 3. Unique-constrained re-points: drop absorbed dup on the keeper's key, then move.
	await dropDupThenMove(tx, "member_dues", "membership_id", "dues_period_id", keeperId, absorbedId);
	await dropDupThenMove(tx, "member_availability", "member_id", "meeting_id", keeperId, absorbedId);
	await dropDupThenMove(tx, "meeting_attendance", "member_id", "meeting_id", keeperId, absorbedId);
	await dropDupThenMove(tx, "meeting_awards", "member_id", "meeting_id", keeperId, absorbedId, "category");
	await dropDupThenMove(tx, "notifications", "assigned_member_id", "slot_id", keeperId, absorbedId);

	// 4. officer_terms → keeper, then keep one OPEN term per position (earliest-start).
	await tx.update(officerTerms).set({ membershipId: keeperId })
		.where(eq(officerTerms.membershipId, absorbedId));
	await tx.execute(sql`
		DELETE FROM officer_terms o USING officer_terms keep
		WHERE o.membership_id = ${keeperId} AND keep.membership_id = ${keeperId}
		  AND o.position = keep.position AND o.term_end IS NULL AND keep.term_end IS NULL
		  AND (coalesce(keep.term_start, 'epoch') < coalesce(o.term_start, 'epoch')
		       OR (coalesce(keep.term_start, 'epoch') = coalesce(o.term_start, 'epoch') AND keep.id < o.id))`);

	// 5. Activity: actor column + jsonb subject refs → keeper (scoped to this club).
	await tx.update(activityLog).set({ actorMemberId: keeperId })
		.where(eq(activityLog.actorMemberId, absorbedId));
	await tx.execute(sql`UPDATE activity_log SET detail = jsonb_set(detail, '{memberId}', ${`"${keeperId}"`}::jsonb)
		WHERE club_id = ${clubId} AND detail->>'memberId' = ${absorbedId}`);
	await tx.execute(sql`UPDATE activity_log SET detail = jsonb_set(detail, '{fromMemberId}', ${`"${keeperId}"`}::jsonb)
		WHERE club_id = ${clubId} AND detail->>'fromMemberId' = ${absorbedId}`);
	await tx.delete(activityLog)
		.where(and(eq(activityLog.targetType, "member"), eq(activityLog.targetId, absorbedId)));

	// 6. Delete the absorbed membership.
	await tx.delete(members).where(eq(members.id, absorbedId));
}

function earliest(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a < b ? a : b;
}

/**
 * For a table whose unique key is (memberCol, keyCol[, extraCol]): delete the
 * absorbed rows whose key the keeper already holds, then re-point the remainder.
 * Raw SQL because table/column names vary; values are still parameterized.
 */
async function dropDupThenMove(
	tx: Tx, table: string, memberCol: string, keyCol: string,
	keeperId: string, absorbedId: string, extraCol?: string,
): Promise<void> {
	const extra = extraCol
		? sql` AND a.${sql.raw(extraCol)} IS NOT DISTINCT FROM k.${sql.raw(extraCol)}`
		: sql``;
	await tx.execute(sql`
		DELETE FROM ${sql.raw(table)} a
		USING ${sql.raw(table)} k
		WHERE a.${sql.raw(memberCol)} = ${absorbedId}
		  AND k.${sql.raw(memberCol)} = ${keeperId}
		  AND a.${sql.raw(keyCol)} IS NOT DISTINCT FROM k.${sql.raw(keyCol)}${extra}`);
	await tx.execute(sql`
		UPDATE ${sql.raw(table)} SET ${sql.raw(memberCol)} = ${keeperId}
		WHERE ${sql.raw(memberCol)} = ${absorbedId}`);
}
```

> **Verify at implementation time:** the exact column names above against `src/db/schema.ts` (`notifications.assigned_member_id`, `meeting_awards.category`, etc.) and that `sql.raw` interpolation compiles under this drizzle version. If `dropDupThenMove`'s dynamic SQL feels fragile, inline five explicit `tx.execute` blocks (one per table) with literal column names — clarity over DRY here is fine.

- [ ] **Step 4: Run it to confirm it passes**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/membership-collapse-logic.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/server/membership-collapse-logic.ts src/server/membership-collapse-logic.integration.test.ts
git commit -m "feat(members): collapseMemberships helper (re-points all 10 membership FKs)"
```

---

## Task 5: Back-port `applyMemberMerge` onto the shared helper

**Files:**
- Modify: `src/server/members-logic.ts:324-403` (`applyMemberMerge`)
- Test: extend the existing suite that covers `applyMemberMerge` (find it: `rg "applyMemberMerge" src/server/*.integration.test.ts`; likely `roster-mgmt.integration.test.ts`).

- [ ] **Step 1: Add a failing test asserting officer_terms/dues survive a within-club merge**

Add to the located suite (mirror its existing merge test's setup). Assert that after `applyMemberMerge`, an open `officer_terms` row and a `member_dues` row that belonged to the absorbed member now belong to the keeper (previously cascade-deleted).

```ts
	it("preserves the absorbed member's officer term and dues (no cascade loss)", async () => {
		// …seed keeper + absorbed in one club (absorbed's person has NO account)…
		// …give absorbed an open officer_terms row + a member_dues row…
		await applyMemberMerge({ clubId, keeperId, absorbedId });
		// assert both rows now reference keeperId (see Task 4 assertions for shape)
	});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/roster-mgmt.integration.test.ts`
Expected: FAIL — the rows were cascade-deleted with the absorbed membership.

- [ ] **Step 3: Route `applyMemberMerge` through `collapseMemberships`**

Add the import to `members-logic.ts` (imports block, line ~29):
```ts
import { collapseMemberships } from "./membership-collapse-logic";
```

Replace the transaction body of `applyMemberMerge` (the steps 1-4 that re-point role_slots/availability/activity and delete the member, lines ~349-387) with a single call, keeping the guards (self-merge, member-in-club, `personHasAccount`) and the merge-log:
```ts
	await db.transaction(async (tx) => {
		await collapseMemberships(tx, clubId, keeperId, absorbedId);
		await logActivity(tx, {
			clubId,
			actorMemberId: input.actorMemberId ?? null,
			action: "member_merge",
			targetType: "member",
			targetId: keeperId,
			detail: { absorbedId, absorbedName: absorbed.name, keeperName: keeper.name },
		});
	});
```

- [ ] **Step 4: Run the full members suite to confirm pass + no regression**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/roster-mgmt.integration.test.ts`
Expected: PASS, including the pre-existing merge tests (their assertions about role_slots/availability re-point still hold).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/server/members-logic.ts src/server/roster-mgmt.integration.test.ts
git commit -m "fix(members): route within-club merge through collapseMemberships (stop losing officer_terms/dues)"
```

---

## Task 6: `mergePeople` + hard blocks + path-collision

**Files:**
- Modify: `src/server/people-logic.ts` (add `checkMergeBlocks`, `mergePeople`, `mergePeopleSchema`, types)
- Test: `src/server/people-merge.integration.test.ts` (create)

- [ ] **Step 1: Write the failing tests** (clean cross-club, each hard block, path collision, audit)

```ts
// src/server/people-merge.integration.test.ts
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, people, speeches } from "#/db/schema";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("mergePeople", () => {
	let mod: typeof import("#/server/people-logic");
	const personIds: string[] = [];
	const clubIds: string[] = [];

	beforeEach(async () => {
		mod = await import("#/server/people-logic");
		personIds.length = 0;
		clubIds.length = 0;
	});
	afterEach(async () => {
		for (const id of clubIds) await cleanup(id, []);
		for (const id of personIds) await testDb.delete(people).where(eq(people.id, id));
	});

	async function person(over: Partial<typeof people.$inferInsert> = {}) {
		const [p] = await testDb.insert(people).values({ name: "P", ...over }).returning({ id: people.id });
		personIds.push(p.id);
		return p.id;
	}

	it("re-points speeches to the keeper and deletes the absorbed Person (clean cross-club)", async () => {
		const keeper = await person({ email: "k@x.io" });
		const absorbed = await person({ email: "k@x.io" });
		await testDb.insert(speeches).values({ personId: absorbed, title: "Ice Breaker" });

		const res = await mergePeopleOk(mod, keeper, absorbed);
		expect(res.ok).toBe(true);
		const gone = await testDb.select().from(people).where(eq(people.id, absorbed));
		expect(gone).toHaveLength(0);
		const moved = await testDb.select().from(speeches).where(eq(speeches.personId, keeper));
		expect(moved).toHaveLength(1);
	});

	it("blocks when both sides have different Customer IDs", async () => {
		const keeper = await person({ customerId: `A-${randomUUID()}` });
		const absorbed = await person({ customerId: `B-${randomUUID()}` });
		await expect(mergePeopleOk(mod, keeper, absorbed)).rejects.toThrow(/customer/i);
	});

	it("blocks when both sides have different sign-in accounts", async () => {
		// two people each linked to a distinct user id (see seedPerson / inline user insert)
		// expect(...).rejects.toThrow(/account/i)
	});

	it("adopts the absorbed Customer ID when the keeper has none", async () => {
		const cid = `C-${randomUUID()}`;
		const keeper = await person({});
		const absorbed = await person({ customerId: cid });
		await mergePeopleOk(mod, keeper, absorbed);
		const [k] = await testDb.select().from(people).where(eq(people.id, keeper));
		expect(k.customerId).toBe(cid);
	});
});

// helper wrapping the logic fn's arg shape
function mergePeopleOk(
	mod: typeof import("#/server/people-logic"),
	keeperPersonId: string,
	absorbedPersonId: string,
) {
	return mod.mergePeople({ keeperPersonId, absorbedPersonId, actorUserId: null });
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/people-merge.integration.test.ts`
Expected: FAIL — `mergePeople` not exported.

- [ ] **Step 3: Implement `checkMergeBlocks` + `mergePeople`**

Append to `src/server/people-logic.ts`. Add imports at top:
```ts
import { z } from "zod";
import {
	activityLog, members, pathEnrollments, pathLevelProgress, people, speeches,
} from "#/db/schema";
import { collapseMemberships } from "./membership-collapse-logic";
```

```ts
export const mergePeopleSchema = z.object({
	keeperPersonId: z.string().uuid(),
	absorbedPersonId: z.string().uuid(),
	actorUserId: z.string().nullable().optional(),
});
export type MergePeopleInput = z.infer<typeof mergePeopleSchema>;

type PersonRow = typeof people.$inferSelect;

/** A hard "these are probably different humans / can't fuse" reason, or null. */
export function checkMergeBlocks(keeper: PersonRow, absorbed: PersonRow): string | null {
	if (keeper.id === absorbed.id) return "Pick two different people.";
	const conflict = (a: string | null, b: string | null) => a != null && b != null && a !== b;
	if (conflict(keeper.userId, absorbed.userId))
		return "Both people have separate sign-in accounts — resolve the accounts first.";
	if (conflict(keeper.customerId, absorbed.customerId))
		return "Both people have different Toastmasters Customer IDs — they are different members.";
	if (conflict(keeper.basecampUserId, absorbed.basecampUserId))
		return "Both people have different Base Camp accounts — they are different members.";
	return null;
}

export interface MergePeopleResult {
	ok: true;
	movedCounts: { memberships: number; collapsed: number; speeches: number; enrollments: number };
}

/** Cross-club, irreversible Person merge. Superadmin-only at the server-fn layer. */
export async function mergePeople(input: MergePeopleInput): Promise<MergePeopleResult> {
	const parsed = mergePeopleSchema.parse(input);
	return db.transaction(async (tx) => {
		const rows = await tx.select().from(people)
			.where(sql`${people.id} in (${parsed.keeperPersonId}, ${parsed.absorbedPersonId})`);
		const keeper = rows.find((p) => p.id === parsed.keeperPersonId);
		const absorbed = rows.find((p) => p.id === parsed.absorbedPersonId);
		if (!keeper || !absorbed) throw new Error("Person not found.");

		const block = checkMergeBlocks(keeper, absorbed);
		if (block) throw new Error(block);

		// 1. Person-level reconcile (keeper canonical; adopt only where keeper is null).
		await tx.update(people).set({
			email: keeper.email ?? absorbed.email,
			phone: keeper.phone ?? absorbed.phone,
			customerId: keeper.customerId ?? absorbed.customerId,
			basecampUserId: keeper.basecampUserId ?? absorbed.basecampUserId,
			userId: keeper.userId ?? absorbed.userId,
			originalJoinDate: earliestDate(keeper.originalJoinDate, absorbed.originalJoinDate),
		}).where(eq(people.id, keeper.id));

		// 2. Memberships: collapse in shared clubs, else re-point.
		const absorbedMemberships = await tx.select({ id: members.id, clubId: members.clubId })
			.from(members).where(eq(members.personId, absorbed.id));
		const keeperMemberships = await tx.select({ id: members.id, clubId: members.clubId })
			.from(members).where(eq(members.personId, keeper.id));
		const keeperByClub = new Map(keeperMemberships.map((m) => [m.clubId, m.id]));
		const affectedClubIds = new Set<string>();
		let collapsed = 0;
		let repointed = 0;
		for (const abs of absorbedMemberships) {
			affectedClubIds.add(abs.clubId);
			const keeperMembershipId = keeperByClub.get(abs.clubId);
			if (keeperMembershipId) {
				await collapseMemberships(tx, abs.clubId, keeperMembershipId, abs.id);
				collapsed++;
			} else {
				await tx.update(members).set({ personId: keeper.id }).where(eq(members.id, abs.id));
				repointed++;
			}
		}

		// 3. Speeches (person-scoped, no unique) → keeper.
		const spMoved = await tx.update(speeches).set({ personId: keeper.id })
			.where(eq(speeches.personId, absorbed.id)).returning({ id: speeches.id });

		// 4. Path enrollments: keep more-progressed on a (person, path) collision.
		const enMoved = await mergeEnrollments(tx, keeper.id, absorbed.id);

		// 5. Delete the absorbed Person.
		await tx.delete(people).where(eq(people.id, absorbed.id));

		// 6. Audit: one member_merge row per affected club, attributed to the superadmin.
		const movedCounts = {
			memberships: repointed, collapsed, speeches: spMoved.length, enrollments: enMoved,
		};
		for (const clubId of affectedClubIds) {
			await tx.insert(activityLog).values({
				clubId, actorMemberId: null, impersonatedBy: parsed.actorUserId ?? null,
				action: "member_merge", targetType: "member", targetId: keeper.id,
				detail: { keeperPersonId: keeper.id, absorbedPersonId: absorbed.id, movedCounts },
			});
		}
		return { ok: true, movedCounts };
	});
}

function earliestDate(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a < b ? a : b;
}

/** Re-point absorbed enrollments; on a shared path keep the more-progressed one. */
async function mergeEnrollments(tx: Tx, keeperId: string, absorbedId: string): Promise<number> {
	const keeperEnr = await tx.select().from(pathEnrollments).where(eq(pathEnrollments.personId, keeperId));
	const absEnr = await tx.select().from(pathEnrollments).where(eq(pathEnrollments.personId, absorbedId));
	const keeperByPath = new Map(keeperEnr.map((e) => [e.pathId, e]));
	let moved = 0;
	for (const abs of absEnr) {
		const k = keeperByPath.get(abs.pathId);
		if (!k) {
			await tx.update(pathEnrollments).set({ personId: keeperId }).where(eq(pathEnrollments.id, abs.id));
			moved++;
			continue;
		}
		const [aScore, kScore] = [await approvedLevels(tx, abs.id), await approvedLevels(tx, k.id)];
		const keepAbsorbed = aScore > kScore || (aScore === kScore && abs.lastSyncedAt > k.lastSyncedAt);
		if (keepAbsorbed) {
			await tx.delete(pathEnrollments).where(eq(pathEnrollments.id, k.id)); // children cascade
			await tx.update(pathEnrollments).set({ personId: keeperId }).where(eq(pathEnrollments.id, abs.id));
			moved++;
		} else {
			await tx.delete(pathEnrollments).where(eq(pathEnrollments.id, abs.id));
		}
	}
	return moved;
}

async function approvedLevels(tx: Tx, enrollmentId: string): Promise<number> {
	const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(pathLevelProgress)
		.where(and(eq(pathLevelProgress.enrollmentId, enrollmentId), eq(pathLevelProgress.approved, true)));
	return r?.n ?? 0;
}
```

Add the `Tx` type + missing imports (`and`, `sql`, `eq`) to the file's import block if not already present from Task 2.

- [ ] **Step 4: Run it to confirm it passes**

Run: `TEST_DATABASE_URL=… bunx vitest run src/server/people-merge.integration.test.ts`
Expected: PASS. Fill in the two stubbed tests (differing-account block; path-collision keep-more-progressed) with real fixtures before moving on.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/server/people-logic.ts src/server/people-merge.integration.test.ts
git commit -m "feat(people): mergePeople — cross-club merge with hard blocks + path-collision handling"
```

---

## Task 7: Detection + preview + search logic

**Files:**
- Modify: `src/server/people-logic.ts` (add `listDuplicatePeople`, `searchPeopleForMerge`, `getMergePreview` + types)
- Test: `src/server/people-detect.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// src/server/people-detect.integration.test.ts — abridged
it("groups people who share a case-insensitive email across clubs", async () => {
	const email = `d-${randomUUID()}@x.io`;
	const a = await person({ name: "Ras", email });
	const b = await person({ name: "Ras", email: email.toUpperCase() });
	const groups = await mod.listDuplicatePeople();
	const g = groups.find((x) => x.email === email.toLowerCase());
	expect(g?.people.map((p) => p.id).sort()).toEqual([a, b].sort());
});

it("getMergePreview surfaces the block reason and moved counts without mutating", async () => {
	const keeper = await person({ customerId: "X1" });
	const absorbed = await person({ customerId: "X2" });
	const preview = await mod.getMergePreview(keeper, absorbed);
	expect(preview.block).toMatch(/customer/i);
	// nothing deleted
	expect(await testDb.select().from(people).where(eq(people.id, absorbed))).toHaveLength(1);
});
```

- [ ] **Step 2: Run to confirm it fails.** `TEST_DATABASE_URL=… bunx vitest run src/server/people-detect.integration.test.ts` → module exports missing.

- [ ] **Step 3: Implement detection/preview/search**

```ts
// append to src/server/people-logic.ts
export interface DuplicatePerson {
	id: string; name: string; email: string | null; linked: boolean;
	historyCount: number; clubs: string[];
}
export interface DuplicateGroup { email: string; people: DuplicatePerson[] }

export async function listDuplicatePeople(): Promise<DuplicateGroup[]> {
	const dupEmails = await db
		.select({ email: sql<string>`lower(${people.email})` })
		.from(people)
		.where(sql`${people.email} is not null and length(trim(${people.email})) > 0`)
		.groupBy(sql`lower(${people.email})`)
		.having(sql`count(*) > 1`);
	const groups: DuplicateGroup[] = [];
	for (const { email } of dupEmails) {
		groups.push({ email, people: await peopleForEmail(email) });
	}
	return groups;
}

export async function searchPeopleForMerge(query: string): Promise<DuplicatePerson[]> {
	const q = `%${query.trim().toLowerCase()}%`;
	if (query.trim().length < 2) return [];
	const rows = await db.select({ id: people.id, name: people.name, email: people.email, userId: people.userId })
		.from(people)
		.where(sql`lower(${people.name}) like ${q} or lower(${people.email}) like ${q}`)
		.limit(25);
	return decorate(rows);
}

export interface MergePreview {
	block: string | null;
	keeper: DuplicatePerson;
	absorbed: DuplicatePerson;
	movedCounts: { memberships: number; collapsed: number; speeches: number; enrollments: number };
}

export async function getMergePreview(keeperId: string, absorbedId: string): Promise<MergePreview> {
	const rows = await db.select().from(people)
		.where(sql`${people.id} in (${keeperId}, ${absorbedId})`);
	const keeper = rows.find((p) => p.id === keeperId);
	const absorbed = rows.find((p) => p.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Person not found.");
	const [dk, da] = await decorate([keeper, absorbed]);
	// counts (read-only): absorbed memberships split by shared-club, speeches, enrollments
	const absM = await db.select({ clubId: members.clubId }).from(members).where(eq(members.personId, absorbedId));
	const keepClubs = new Set((await db.select({ clubId: members.clubId }).from(members).where(eq(members.personId, keeperId))).map((m) => m.clubId));
	const collapsed = absM.filter((m) => keepClubs.has(m.clubId)).length;
	const [sp] = await db.select({ n: sql<number>`count(*)::int` }).from(speeches).where(eq(speeches.personId, absorbedId));
	const [en] = await db.select({ n: sql<number>`count(*)::int` }).from(pathEnrollments).where(eq(pathEnrollments.personId, absorbedId));
	return {
		block: checkMergeBlocks(keeper, absorbed),
		keeper: dk, absorbed: da,
		movedCounts: { memberships: absM.length - collapsed, collapsed, speeches: sp?.n ?? 0, enrollments: en?.n ?? 0 },
	};
}
```

Implement the small shared helpers `peopleForEmail(email)`, `decorate(rows)` (join clubs via `members`→`clubs.name`, compute `historyCount` via `historyCounts`, `linked = userId != null`). Keep them in this file.

- [ ] **Step 4: Run to confirm it passes.** Fill in helper bodies until green.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/server/people-logic.ts src/server/people-detect.integration.test.ts
git commit -m "feat(people): duplicate detection, search, and read-only merge preview"
```

---

## Task 8: Superadmin server fns

**Files:**
- Create: `src/server/people.ts`

- [ ] **Step 1: Implement the guarded wrappers** (no new test file — covered by the existing `server-modules.guard.test.ts`; the logic is already tested)

```ts
// src/server/people.ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin, requireUser } from "./guards";
import {
	getMergePreview, listDuplicatePeople, mergePeople, mergePeopleSchema, searchPeopleForMerge,
} from "./people-logic";

export const listDuplicatePeopleFn = createServerFn({ method: "GET" }).handler(async () => {
	const u = await requireUser();
	await requireSuperadmin(u.id);
	return listDuplicatePeople();
});

export const searchPeople = createServerFn({ method: "GET" })
	.validator((q: unknown) => z.string().parse(q))
	.handler(async ({ data }) => {
		const u = await requireUser();
		await requireSuperadmin(u.id);
		return searchPeopleForMerge(data);
	});

const previewSchema = z.object({ keeperId: z.string().uuid(), absorbedId: z.string().uuid() });
export const previewMerge = createServerFn({ method: "GET" })
	.validator((i: unknown) => previewSchema.parse(i))
	.handler(async ({ data }) => {
		const u = await requireUser();
		await requireSuperadmin(u.id);
		return getMergePreview(data.keeperId, data.absorbedId);
	});

export const mergePeopleFn = createServerFn({ method: "POST" })
	.validator((i: unknown) => mergePeopleSchema.omit({ actorUserId: true }).parse(i))
	.handler(async ({ data }) => {
		const u = await requireUser();
		await requireSuperadmin(u.id);
		return mergePeople({ ...data, actorUserId: u.id });
	});
```

- [ ] **Step 2: Run the guard test + typecheck**

Run: `bunx vitest run src/server/server-modules.guard.test.ts` → PASS (people.ts exports only server fns).
Run: `bun run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add src/server/people.ts
git commit -m "feat(people): superadmin-gated server fns (list/search/preview/merge)"
```

---

## Task 9: Superadmin "Duplicate people" UI

**Files:**
- Create: `src/routes/_authed/superadmin/duplicate-people.tsx`
- Modify: `src/routes/_authed/superadmin/index.tsx` (add a link), `src/components/app-shell.tsx:490` (second Platform NavItem)

Follow the console idiom exactly: `loader` calls the read fn directly; writes are `await fn({ data })` + `router.invalidate()` with `useState(submitting)`; use `Dialog` from `#/components/ui/dialog` for the confirm screen; hand-rolled `<table>`; `toast` from `sonner`.

- [ ] **Step 1: Route + auto-detected groups list**

```tsx
// src/routes/_authed/superadmin/duplicate-people.tsx
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import {
	Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "#/components/ui/dialog";
import { listDuplicatePeopleFn, mergePeopleFn, previewMerge } from "#/server/people";

export const Route = createFileRoute("/_authed/superadmin/duplicate-people")({
	loader: () => listDuplicatePeopleFn(),
	component: DuplicatePeople,
});

function DuplicatePeople() {
	const groups = Route.useLoaderData();
	const router = useRouter();
	return (
		<PageContainer>
			<div className="space-y-4">
				<div>
					<Link to="/superadmin" className="text-sm text-[var(--palm)] underline-offset-2 hover:underline">
						← Superadmin
					</Link>
					<h1 className="text-2xl font-bold">Duplicate people</h1>
					<p className="text-sm text-muted-foreground">
						People sharing an email across clubs. Merging keeps one Person and moves all
						history to it. This cannot be undone.
					</p>
				</div>
				{groups.length === 0 ? (
					<p className="text-sm text-muted-foreground">No duplicates detected.</p>
				) : (
					groups.map((g) => (
						<DuplicateGroupCard key={g.email} group={g} onMerged={() => router.invalidate()} />
					))
				)}
				{/* Manual search-and-merge escape hatch (Task 9, Step 3) */}
			</div>
		</PageContainer>
	);
}
```

- [ ] **Step 2: Group card — keeper selection + confirm dialog + merge**

Render each group's people rows with a radio to choose the keeper (default: the first, which the server returns keeper-ranked — sort `g.people` client-side by `linked` then `historyCount` to match, or return them pre-sorted from `peopleForEmail`). A "Merge" button opens a `Dialog` that calls `previewMerge({ data: { keeperId, absorbedId } })` to show moved counts and any `block` (disable Merge if `preview.block`). On confirm, `await mergePeopleFn({ data: { keeperPersonId, absorbedPersonId } })`, then `toast.success` + `onMerged()`.

```tsx
function DuplicateGroupCard({ group, onMerged }: {
	group: import("#/server/people-logic").DuplicateGroup; onMerged: () => void;
}) {
	const sorted = [...group.people].sort(
		(a, b) => Number(b.linked) - Number(a.linked) || b.historyCount - a.historyCount,
	);
	const [keeperId, setKeeperId] = useState(sorted[0]?.id ?? "");
	// For 2-person groups the "absorbed" is the other one; for >2 pick pairwise.
	const absorbed = sorted.find((p) => p.id !== keeperId);
	// … radio list of `sorted` (name · email · clubs · history · Linked badge) …
	// … <MergeConfirm keeperId absorbedId={absorbed.id} onMerged /> …
}

function MergeConfirm({ keeperId, absorbedId, onMerged }: {
	keeperId: string; absorbedId: string; onMerged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<import("#/server/people-logic").MergePreview | null>(null);
	const [busy, setBusy] = useState(false);

	async function openDialog() {
		setOpen(true);
		setPreview(await previewMerge({ data: { keeperId, absorbedId } }));
	}
	async function confirm() {
		setBusy(true);
		try {
			await mergePeopleFn({ data: { keeperPersonId: keeperId, absorbedPersonId: absorbedId } });
			toast.success("People merged.");
			setOpen(false);
			onMerged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Merge failed.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button size="sm" variant="destructive" onClick={openDialog}>Merge…</Button>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Merge these two people?</DialogTitle>
					<DialogDescription>
						{preview?.block
							? preview.block
							: preview
								? `Moves ${preview.movedCounts.memberships + preview.movedCounts.collapsed} membership(s), ${preview.movedCounts.speeches} speech(es), ${preview.movedCounts.enrollments} enrollment(s) to the keeper. This cannot be undone.`
								: "Loading…"}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
					<Button variant="destructive" disabled={busy || !preview || !!preview.block} onClick={confirm}>
						Merge
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 3: Manual search-and-merge** — an `<Input>` bound to state; on change (debounced or on Enter) `await searchPeople({ data: query })`; render results with the same keeper-pick + `MergeConfirm`. Reuse `MergeConfirm`.

- [ ] **Step 4: Link + nav**

In `src/routes/_authed/superadmin/index.tsx`, add near the "All clubs" heading:
```tsx
<Link to="/superadmin/duplicate-people" className="text-sm text-[var(--palm)] underline-offset-2 hover:underline">
	Duplicate people →
</Link>
```
In `src/components/app-shell.tsx` Platform group (line ~490), add a second item:
```tsx
<NavItem to="/superadmin/duplicate-people" icon={Users} label="Duplicate people" onNavigate={onNavigate} />
```
(Import `Users` from `lucide-react` if not already imported.)

- [ ] **Step 5: Regenerate routes, typecheck, lint, manual verify**

Run: `bun run generate-routes` (adds the new route to `routeTree.gen.ts`; do not hand-edit it).
Run: `bun run typecheck` and `bun run check`.
Manual: `bun run dev`, sign in as a superadmin, open `/superadmin/duplicate-people`, confirm your two "Rasheed Bustamam" rows appear as a group, and that the merge dialog shows the moved counts. (Per `browse-needs-no-sandbox`, if using /browse set `GSTACK_CHROMIUM_NO_SANDBOX=1`.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authed/superadmin/duplicate-people.tsx src/routes/_authed/superadmin/index.tsx src/components/app-shell.tsx src/routeTree.gen.ts
git commit -m "feat(superadmin): duplicate-people console — detect + merge UI"
```

---

## Final verification (before PR)

- [ ] `bun run typecheck` — clean.
- [ ] `bun run check` — Biome clean.
- [ ] `DATABASE_URL=…tm_test bun run db:push --force` then `TEST_DATABASE_URL=…tm_test bunx vitest run` — all suites pass (integration suites actually run, not skipped).
- [ ] `bun run build` mutates `routeTree.gen.ts` with an SSR Register block (`build-mutates-routetree-gen`) — if you build, `git checkout src/routeTree.gen.ts` before committing; do not commit that artifact.
- [ ] Manually merge the two real Rasheed Persons via the new UI and confirm THR-you now shows your unified identity.

## Self-review — spec coverage

- Part A (create-club dedupe, Rule B) → Tasks 1-3. ✅
- Part B `mergePeople` (3 person FKs, hard blocks, person reconcile, path-collision, per-club audit) → Task 6. ✅
- `collapseMemberships` (10 membership FKs, unique collisions, reconcile) + back-port → Tasks 4-5. ✅
- Part C (auto-detected groups + manual search + confirm dialog) → Tasks 7-9. ✅
- Testing (unit heuristic + integration per module, incl. back-port regression) → every task. ✅
- Non-goals honored: paste untouched; manual single-add untouched; no migration (audit reuses `activity_log` + `impersonated_by`). ✅
