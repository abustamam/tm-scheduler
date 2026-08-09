# Digital Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the room vote for Best Speaker, Best Evaluator and Best Table Topics from their phones via a QR-reachable public ballot, with the Ballot Counter opening and closing each vote and confirming the winner into the existing `meeting_awards`.

**Architecture:** Two new tables (`meeting_vote_sessions`, `meeting_votes`) hold the vote window and the ballots; one shared derivation (`loadAwardCandidates`) is the single source of truth for both what the ballot displays and what the server accepts. A new public shell-escaped route is the ballot; a panel on the existing meeting page is the Ballot Counter's console. Transport is polling — no realtime infrastructure is added.

**Tech Stack:** TanStack Start + TanStack Router, Drizzle ORM on Postgres, TanStack Query for polling, Vitest (integration tests need `TEST_DATABASE_URL`), `qrcode.react`, biome.

**Spec:** `docs/superpowers/specs/2026-08-08-digital-voting-design.md`

---

## Before you start

Read these, in this order. The plan assumes you have:

1. `docs/superpowers/specs/2026-08-08-digital-voting-design.md` — the design this implements.
2. `src/server/minutes-logic.ts` — the member-XOR-guest pattern, `awardEligible`, `setAward`, `addTableTopicsSpeaker`.
3. `src/server/meeting-authz-logic.ts` — `resolveWordOfTheDayAuthz` is the template for Task 3.
4. `src/routes/club.$clubId_.guest-book.tsx` — the public shell-escaped route pattern for Task 9.

**Three project rules this plan depends on. Violating any of them produces a green test suite over broken code.**

- **Integration tests need a database.** `bun run test` alone silently skips ~630 integration tests and still reports success. Always run integration tests as `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test <path>`. Every "Expected: PASS" in this plan assumes that variable is set.
- **`bun run test` and `bun run build` do not type-check.** Run `bun run typecheck` (which is `tsc --noEmit`) separately.
- **Server module split.** `src/server/voting.ts` may export *only* `createServerFn`s and types. All database access lives in `src/server/voting-logic.ts`. `src/server/server-modules.guard.test.ts` enforces this; violating it puts `pg` in the client bundle and produces "Buffer is not defined" at runtime, which no test catches.

**Two more, less obvious:**

- `bun run dev` and `bun run build` both append an SSR Register block to `src/routeTree.gen.ts`. Run `git checkout src/routeTree.gen.ts` before committing if it shows as modified and you did not intend to change routing.
- After any schema change, sync the test database: `DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force`. The dev database auto-migrates via `predev`; never `db:push` the dev database.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/server/award-candidates-logic.ts` | The one derivation of who is eligible per award category, with display names. Read by both the ballot and the vote validator. |
| `src/server/award-candidates.integration.test.ts` | Tests for the above. |
| `src/server/voting-logic.ts` | All database access for voting: open, close, cast, tally, ballot read. |
| `src/server/voting.ts` | `createServerFn` wrappers and their zod validators. No database access. |
| `src/server/voting.integration.test.ts` | The behavioural suite for voting-logic. |
| `src/server/voting-authz.guard.test.ts` | Source-grep guard: every mutating vote server fn is gated. |
| `src/server/voting-payload.guard.test.ts` | Source-grep guard: the public ballot payload selects no PII columns. |
| `src/components/club/table-topics-capture.tsx` | The Table Topics speaker picker, lifted out of the minutes UI so both surfaces render one component. |
| `src/components/club/vote-counter-panel.tsx` | The Ballot Counter's console: open/close, count, who voted, set winner. |
| `src/components/club/ballot.tsx` | The voter's three-state ballot body (identify / waiting / vote). |
| `src/routes/club.$clubId_.meeting.$meetingId.vote.tsx` | The public ballot route. |
| `drizzle/XXXX_*.sql` | Generated migration for the two tables and the two enum values. |

**Modified:**

| File | Change |
| --- | --- |
| `src/db/schema.ts` | Two tables, two `activity_action` enum values. |
| `src/lib/meeting-roles.ts` | `findVoteCounterSlot`. |
| `src/server/meeting-authz-logic.ts` | `resolveVoteCounterAuthz`. |
| `src/server/minutes-logic.ts` | Export `requireMemberInMeetingClub`; `loadMinutes` consumes `loadAwardCandidates`. |
| `src/server/meetings-logic.ts` | `applyCompleteMeeting` closes open vote sessions in its transaction. |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Render the Ballot Counter panel. |
| `src/lib/agenda-slides.ts` | Vote slides carry the ballot URL. |
| `src/routes/club.$clubId_.meeting.$meetingId.present.tsx` | QR + participation badge on vote slides. |
| `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` | QR in the agenda footer. |

---

## Task 1: Schema — the two tables and the enum values

**Files:**
- Modify: `src/db/schema.ts` (after `meetingAwards`, which ends at line 1014)
- Modify: `src/db/schema.ts:91-122` (the `activityActionEnum`)
- Create: `src/server/voting.integration.test.ts`

- [x] **Step 1: Add the two enum values**

In `src/db/schema.ts`, at the end of the `activityActionEnum` list (currently ending with `"outreach_clear"` at line 121), add:

```ts
	// Digital voting (#510): a vote window opened or closed. Deliberately NOT
	// `vote_cast` — logging every ballot would put voter identity into a feed the
	// club can read, exposing the electorate for no benefit. The tally is the
	// record. `detail = { category }`.
	"vote_open",
	"vote_close",
```

- [x] **Step 2: Add the two tables**

In `src/db/schema.ts`, immediately after the `meetingAwards` table (line 1014) and before the `speeches` section comment:

```ts
// ---------------------------------------------------------------------------
// Digital voting (#510). A vote SESSION is the window for one award category on
// one meeting; a VOTE is one ballot cast into it. The winner does not live here
// — it lives in `meeting_awards`, which is already what the minutes, the minutes
// PDF and the printed awards beat read. The Ballot Counter confirms it there.
// ---------------------------------------------------------------------------

export const meetingVoteSessions = pgTable(
	"meeting_vote_sessions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		category: awardCategoryEnum("category").notNull(),
		openedAt: timestamp("opened_at").defaultNow().notNull(),
		// NULL means OPEN. Re-opening a closed vote sets this back to null on the
		// same row rather than inserting a second one; the open/close history lives
		// in `activity_log`.
		closedAt: timestamp("closed_at"),
		openedByMemberId: uuid("opened_by_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_vote_sessions_meeting_idx").on(t.meetingId),
		// Mirrors `meeting_awards_meeting_category_unique` so sessions, awards and
		// categories line up 1:1:1, and doubles as the ON CONFLICT arbiter for the
		// open/re-open upsert.
		uniqueIndex("meeting_vote_sessions_meeting_category_unique").on(
			t.meetingId,
			t.category,
		),
	],
);

export const meetingVotes = pgTable(
	"meeting_votes",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sessionId: uuid("session_id")
			.notNull()
			.references(() => meetingVoteSessions.id, { onDelete: "cascade" }),
		voterMemberId: uuid("voter_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		voterGuestId: uuid("voter_guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		candidateMemberId: uuid("candidate_member_id").references(() => members.id, {
			onDelete: "set null",
		}),
		candidateGuestId: uuid("candidate_guest_id").references(() => guests.id, {
			onDelete: "cascade",
		}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("meeting_votes_session_idx").on(t.sessionId),
		// One vote per person per category, enforced HERE rather than in
		// application code. Plain (non-partial) unique indexes so ON CONFLICT can
		// infer them as arbiters; Postgres treats NULLs as distinct, so the member
		// rows (guest null) never collide with the guest rows (member null). Same
		// construction as `meeting_attendance`.
		uniqueIndex("meeting_votes_voter_member_unique").on(
			t.sessionId,
			t.voterMemberId,
		),
		uniqueIndex("meeting_votes_voter_guest_unique").on(
			t.sessionId,
			t.voterGuestId,
		),
		check(
			"meeting_votes_single_voter",
			sql`${t.voterMemberId} is null or ${t.voterGuestId} is null`,
		),
		check(
			"meeting_votes_single_candidate",
			sql`${t.candidateMemberId} is null or ${t.candidateGuestId} is null`,
		),
	],
);
```

- [x] **Step 3: Add the relations**

After `meetingAwardsRelations` (around line 1634):

```ts
export const meetingVoteSessionsRelations = relations(
	meetingVoteSessions,
	({ one, many }) => ({
		meeting: one(meetings, {
			fields: [meetingVoteSessions.meetingId],
			references: [meetings.id],
		}),
		votes: many(meetingVotes),
	}),
);

export const meetingVotesRelations = relations(meetingVotes, ({ one }) => ({
	session: one(meetingVoteSessions, {
		fields: [meetingVotes.sessionId],
		references: [meetingVoteSessions.id],
	}),
}));
```

- [x] **Step 4: Generate the migration**

Run: `bun run db:generate`

Expected: a new `drizzle/XXXX_<name>.sql` containing `CREATE TABLE "meeting_vote_sessions"`, `CREATE TABLE "meeting_votes"`, and two `ALTER TYPE "public"."activity_action" ADD VALUE` statements.

Open the generated SQL and confirm two things:
- There is **no `CREATE INDEX CONCURRENTLY`**. Drizzle migrations run inside a transaction and `CONCURRENTLY` cannot; it deploys fine locally and fails closed on Railway.
- The `ALTER TYPE ... ADD VALUE` statements exist. Postgres 12+ permits these in a transaction as long as the new value is not *used* in the same transaction — this migration only adds them, so it is fine.

- [x] **Step 5: Sync the test database**

Run: `DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force`

Expected: `[✓] Changes applied`.

- [x] **Step 6: Write the constraint test**

Create `src/server/voting.integration.test.ts`:

```ts
/**
 * DB-backed integration tests for digital voting (#510).
 *
 * The constraints in this file are the feature's real safety net: one vote per
 * person per category is enforced by a unique index, not by application code,
 * and the member-XOR-guest shape by check constraints. Exercised against a live
 * Postgres identified by TEST_DATABASE_URL; the whole suite skips when unset.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingVoteSessions, meetingVotes } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("vote table constraints (#510)", () => {
	let seed: SeededClub;
	let sessionId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [s] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_speaker" })
			.returning({ id: meetingVoteSessions.id });
		sessionId = s.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("rejects a second vote from the same member in one session", async () => {
		await testDb.insert(meetingVotes).values({
			sessionId,
			voterMemberId: seed.memberId,
			candidateMemberId: seed.adminMemberId,
		});
		await expect(
			testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				candidateMemberId: seed.adminMemberId,
			}),
		).rejects.toThrow();
	});

	it("lets many members vote in one session", async () => {
		await testDb.insert(meetingVotes).values([
			{ sessionId, voterMemberId: seed.memberId, candidateMemberId: seed.adminMemberId },
			{ sessionId, voterMemberId: seed.adminMemberId, candidateMemberId: seed.memberId },
		]);
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(2);
	});

	it("lets a guest and a member both vote — the NULL arbiters do not collide", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Nguyen, Thanh" })
			.returning({ id: guests.id });
		await testDb.insert(meetingVotes).values([
			{ sessionId, voterMemberId: seed.memberId, candidateMemberId: seed.adminMemberId },
			{ sessionId, voterGuestId: g.id, candidateMemberId: seed.adminMemberId },
		]);
		const rows = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, sessionId));
		expect(rows).toHaveLength(2);
	});

	it("rejects a vote that is both a member and a guest", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Ada Byron" })
			.returning({ id: guests.id });
		await expect(
			testDb.insert(meetingVotes).values({
				sessionId,
				voterMemberId: seed.memberId,
				voterGuestId: g.id,
				candidateMemberId: seed.adminMemberId,
			}),
		).rejects.toThrow();
	});

	it("rejects two sessions for the same meeting and category", async () => {
		await expect(
			testDb
				.insert(meetingVoteSessions)
				.values({ meetingId: seed.meetingId, category: "best_speaker" }),
		).rejects.toThrow();
	});
});
```

The guest fixture is deliberately `"Nguyen, Thanh"` — the Toastmasters export emits both `"First Last"` and `"Last, First"`, and single-shape fixtures have previously hidden a real bug from six reviewers.

- [x] **Step 7: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: PASS, 5 tests. If it reports "0 tests" the database URL is not set and the suite skipped — fix that before continuing.

- [x] **Step 8: Typecheck and commit**

```bash
bun run typecheck
bun run check
git add src/db/schema.ts drizzle/ src/server/voting.integration.test.ts
git commit -m "feat(voting): vote session and ballot tables (#510)"
```

---

## Task 2: One derivation of who is on the ballot

`loadMinutes` already derives award eligibility, but it returns bare id arrays and is buried inside a function that also loads action items, attendance and PDF data — far too much to call from a public endpoint, and it carries guest contact details we must never put on a public payload.

Extract the derivation so **the list the ballot renders and the list the server validates against are the same code**. If these two ever drift, the ballot offers a candidate the server then rejects, and nobody finds out until a meeting.

**Files:**
- Create: `src/server/award-candidates-logic.ts`
- Create: `src/server/award-candidates.integration.test.ts`
- Modify: `src/server/minutes-logic.ts`

- [x] **Step 1: Write the failing test**

Create `src/server/award-candidates.integration.test.ts`:

```ts
/**
 * The single derivation of who may win each award (#510). Both the public
 * ballot and the server-side vote validator read this, so a drift between them
 * is impossible by construction rather than by discipline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, roleDefinitions, roleSlots, tableTopicsSpeakers } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadAwardCandidates } = await import("#/server/award-candidates-logic");

describe.skipIf(!hasTestDb)("loadAwardCandidates (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function addRole(name: string, category: "speaker" | "evaluator") {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({ clubId: seed.clubId, name, category, sortOrder: 99 })
			.returning({ id: roleDefinitions.id });
		return def.id;
	}

	it("lists speaker-slot holders under best_speaker, with names", async () => {
		const roleId = await addRole("Speaker", "speaker");
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: roleId,
			slotIndex: 0,
			assignedMemberId: seed.memberId,
		});
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_speaker).toHaveLength(1);
		expect(c.best_speaker[0]).toMatchObject({ kind: "member", id: seed.memberId });
		expect(typeof c.best_speaker[0].name).toBe("string");
		expect(c.best_speaker[0].name.length).toBeGreaterThan(0);
	});

	it("lists evaluator-slot holders under best_evaluator only", async () => {
		const roleId = await addRole("Evaluator", "evaluator");
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: roleId,
			slotIndex: 0,
			assignedMemberId: seed.memberId,
		});
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_evaluator.map((x) => x.id)).toEqual([seed.memberId]);
		expect(c.best_speaker).toEqual([]);
	});

	it("lists table topics speakers, members and guests alike", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Okafor, Chidi" })
			.returning({ id: guests.id });
		await testDb.insert(tableTopicsSpeakers).values([
			{ meetingId: seed.meetingId, memberId: seed.memberId, sortOrder: 0 },
			{ meetingId: seed.meetingId, guestId: g.id, sortOrder: 1 },
		]);
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_table_topics).toHaveLength(2);
		expect(c.best_table_topics.map((x) => x.kind).sort()).toEqual([
			"guest",
			"member",
		]);
		expect(c.best_table_topics.find((x) => x.kind === "guest")?.name).toBe(
			"Okafor, Chidi",
		);
	});

	it("de-dupes a member holding two speaker slots", async () => {
		const roleId = await addRole("Speaker", "speaker");
		await testDb.insert(roleSlots).values([
			{ meetingId: seed.meetingId, roleDefinitionId: roleId, slotIndex: 0, assignedMemberId: seed.memberId },
			{ meetingId: seed.meetingId, roleDefinitionId: roleId, slotIndex: 1, assignedMemberId: seed.memberId },
		]);
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_speaker).toHaveLength(1);
	});

	it("returns no contact details on any candidate", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Rivera, Ana",
				email: "ana@example.com",
				phone: "+15551234567",
			})
			.returning({ id: guests.id });
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: seed.meetingId, guestId: g.id, sortOrder: 0 });
		const c = await loadAwardCandidates(seed.meetingId);
		const serialized = JSON.stringify(c);
		expect(serialized).not.toContain("ana@example.com");
		expect(serialized).not.toContain("5551234567");
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/award-candidates.integration.test.ts`

Expected: FAIL — `Cannot find module '#/server/award-candidates-logic'`.

- [x] **Step 3: Implement**

Create `src/server/award-candidates-logic.ts`:

```ts
/**
 * Who may win each award on a meeting (#510), with display names.
 *
 * ONE derivation, read by two callers that must never disagree: the public
 * ballot renders it, and `castVote` validates against it. If they drifted, the
 * ballot would offer a candidate the server rejects — a failure that only shows
 * up mid-meeting.
 *
 * Best Speaker  → holders of `speaker`-category role slots
 * Best Evaluator→ holders of `evaluator`-category role slots
 * Best Table Topics → the meeting's recorded Table Topics speakers
 *
 * Names ONLY. No email, no phone: the ballot is a fully public surface and the
 * public club sheet is a soft gate, so contact details must never reach it.
 * `award-candidates.integration.test.ts` asserts that directly.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	members,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { AWARD_CATEGORIES, type AwardCategory } from "./minutes-logic";

/** A person who may win an award. `kind` discriminates the id's table. */
export interface AwardCandidate {
	kind: "member" | "guest";
	id: string;
	name: string;
}

export type AwardCandidates = Record<AwardCategory, AwardCandidate[]>;

export async function loadAwardCandidates(
	meetingId: string,
): Promise<AwardCandidates> {
	// `members.name` is the per-club authoritative display name, denormalized on
	// purpose (#486) — it is what `loadMinutes` already reads for award winners.
	// Do NOT join through `people.name`: the two diverge, and the ballot must
	// show the same name every other surface shows.
	const slotRows = await db
		.select({
			category: roleDefinitions.category,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
		})
		.from(roleSlots)
		.innerJoin(roleDefinitions, eq(roleDefinitions.id, roleSlots.roleDefinitionId))
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

	const ttRows = await db
		.select({
			memberId: tableTopicsSpeakers.memberId,
			guestId: tableTopicsSpeakers.guestId,
			memberName: members.name,
			guestName: guests.name,
		})
		.from(tableTopicsSpeakers)
		.leftJoin(members, eq(members.id, tableTopicsSpeakers.memberId))
		.leftJoin(guests, eq(guests.id, tableTopicsSpeakers.guestId))
		.where(eq(tableTopicsSpeakers.meetingId, meetingId))
		.orderBy(asc(tableTopicsSpeakers.sortOrder));

	const empty = (): AwardCandidates => ({
		best_speaker: [],
		best_evaluator: [],
		best_table_topics: [],
	});
	const out = empty();
	// De-dupe per category: a member may hold two speaker slots and must appear
	// on the ballot once. Keyed by `kind:id`, insertion-ordered.
	const seen: Record<AwardCategory, Set<string>> = {
		best_speaker: new Set(),
		best_evaluator: new Set(),
		best_table_topics: new Set(),
	};

	const push = (
		category: AwardCategory,
		row: {
			memberId: string | null;
			guestId: string | null;
			memberName: string | null;
			guestName: string | null;
		},
	) => {
		const kind = row.memberId ? "member" : row.guestId ? "guest" : null;
		if (!kind) return;
		const id = (row.memberId ?? row.guestId) as string;
		const name = (kind === "member" ? row.memberName : row.guestName) ?? "";
		if (!name) return;
		const key = `${kind}:${id}`;
		if (seen[category].has(key)) return;
		seen[category].add(key);
		out[category].push({ kind, id, name });
	};

	for (const r of slotRows) {
		if (r.category === "speaker") push("best_speaker", r);
		else if (r.category === "evaluator") push("best_evaluator", r);
	}
	for (const r of ttRows) push("best_table_topics", r);

	return out;
}

/** True when `candidate` is eligible for `category` on this meeting. */
export function isEligibleCandidate(
	candidates: AwardCandidates,
	category: AwardCategory,
	candidate: { kind: "member" | "guest"; id: string },
): boolean {
	return candidates[category].some(
		(c) => c.kind === candidate.kind && c.id === candidate.id,
	);
}

export { AWARD_CATEGORIES };
```

If `roleSlots` has no `assignedGuestId` column, read `src/db/schema.ts:805-860` and use the actual column name; the rest of the function is unchanged.

- [x] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/award-candidates.integration.test.ts`

Expected: PASS, 5 tests.

- [x] **Step 5: Point `loadMinutes` at the shared derivation**

In `src/server/minutes-logic.ts`, replace the `awardEligible` construction (the block starting `const speakerMemberIds = new Set<string>();` and ending with the `awardEligible` object literal, around lines 356-400) with:

```ts
	// Award eligibility (#170) now comes from the ONE derivation the public
	// ballot also reads (#510), so the two can't drift. Mapped back to the id-only
	// shape this payload has always exposed.
	const candidates = await loadAwardCandidates(meetingId);
	const toEligible = (list: AwardCandidate[]): AwardEligible => ({
		memberIds: list.filter((c) => c.kind === "member").map((c) => c.id),
		guestIds: list.filter((c) => c.kind === "guest").map((c) => c.id),
	});
	const awardEligible: Record<AwardCategory, AwardEligible> = {
		best_speaker: toEligible(candidates.best_speaker),
		best_evaluator: toEligible(candidates.best_evaluator),
		best_table_topics: toEligible(candidates.best_table_topics),
	};
```

Add the import at the top of the file:

```ts
import {
	type AwardCandidate,
	loadAwardCandidates,
} from "./award-candidates-logic";
```

- [x] **Step 6: Export the club-scoping helper**

Still in `src/server/minutes-logic.ts`, change line 552 from `async function requireMemberInMeetingClub` to:

```ts
/** Throws unless `memberId` is on `clubId`'s roster. Exported for the voting
 *  logic (#510), which must scope voters the same way awards scope winners. */
export async function requireMemberInMeetingClub(
	memberId: string,
	clubId: string,
) {
```

- [x] **Step 7: Verify nothing regressed**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/minutes.integration.test.ts src/server/award-candidates.integration.test.ts`

Expected: PASS, all tests. The minutes suite covers `awardEligible` already; if any of it fails, the refactor changed behaviour and must be fixed rather than the test adjusted.

- [x] **Step 8: Typecheck and commit**

```bash
bun run typecheck
bun run check
git add src/server/award-candidates-logic.ts src/server/award-candidates.integration.test.ts src/server/minutes-logic.ts
git commit -m "refactor(minutes): one derivation of award eligibility, with names (#510)"
```

---

## Task 3: Vote Counter authorization

**Files:**
- Modify: `src/lib/meeting-roles.ts`
- Modify: `src/server/meeting-authz-logic.ts`
- Create: `src/lib/meeting-roles.vote-counter.test.ts`

Read `src/lib/meeting-roles.ts` first. The rule it encodes: **the key is identity, the name is a label.** Matching on name once handed a member the whole meeting because their invented role was called "Toastmaster Evaluator". Do not widen the name fallback to a prefix match.

- [x] **Step 1: Write the failing test**

Create `src/lib/meeting-roles.vote-counter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findVoteCounterSlot } from "./meeting-roles";

describe("findVoteCounterSlot (#510)", () => {
	it("finds the slot by key", () => {
		const slots = [
			{ roleName: "Timer", roleKey: "timer", assignedMemberId: "t" },
			{ roleName: "Vote Counter", roleKey: "vote_counter", assignedMemberId: "v" },
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("finds a RENAMED vote counter — the key is identity, not the label", () => {
		const slots = [
			{ roleName: "Ballot Counter", roleKey: "vote_counter", assignedMemberId: "v" },
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("falls back to the exact canonical name for a keyless slot", () => {
		const slots = [
			{ roleName: "Vote Counter", roleKey: null, assignedMemberId: "v" },
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("v");
	});

	it("does NOT match a club-invented look-alike", () => {
		const slots = [
			{ roleName: "Vote Counter Assistant", roleKey: null, assignedMemberId: "x" },
			{ roleName: "Ballot Counter", roleKey: null, assignedMemberId: "y" },
		];
		expect(findVoteCounterSlot(slots)).toBeUndefined();
	});

	it("prefers the keyed slot over a keyless canonical look-alike", () => {
		const slots = [
			{ roleName: "Vote Counter", roleKey: null, assignedMemberId: "decoy" },
			{ roleName: "Ballot Counter", roleKey: "vote_counter", assignedMemberId: "real" },
		];
		expect(findVoteCounterSlot(slots)?.assignedMemberId).toBe("real");
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `bun run test src/lib/meeting-roles.vote-counter.test.ts`

Expected: FAIL — `findVoteCounterSlot is not a function`.

- [x] **Step 3: Implement**

In `src/lib/meeting-roles.ts`, beside `TMOD_ROLE_KEY` and `GRAMMARIAN_ROLE_KEY`:

```ts
const VOTE_COUNTER_ROLE_KEY = "vote_counter";
```

Beside `GRAMMARIAN_CANONICAL_NAMES`:

```ts
const VOTE_COUNTER_CANONICAL_NAMES = ["vote counter"];
```

After `findGrammarianSlot`:

```ts
/**
 * The meeting's Vote Counter slot, or undefined. The third capability role
 * (#510): its holder opens and closes the digital votes, sees the running
 * count, and confirms the winner.
 *
 * Same key-first construction as the other two, and the same deliberately
 * narrow name fallback — "Ballot Counter" is NOT canonical, so a club that
 * renamed the role keeps the capability through its key, while a club-invented
 * "Ballot Counter" with a NULL key is correctly denied it (#464).
 */
export function findVoteCounterSlot<T extends RoleIdentity>(
	slots: T[],
): T | undefined {
	return findCapabilityRole(
		slots,
		VOTE_COUNTER_ROLE_KEY,
		VOTE_COUNTER_CANONICAL_NAMES,
	);
}
```

- [x] **Step 4: Run the test**

Run: `bun run test src/lib/meeting-roles.vote-counter.test.ts`

Expected: PASS, 5 tests.

- [x] **Step 5: Add `resolveVoteCounterAuthz`**

In `src/server/meeting-authz-logic.ts`, extend `loadRoleSlotAssignees` (line 113) to also return the vote counter:

```ts
async function loadRoleSlotAssignees(meetingId: string): Promise<{
	tmodMemberId: string | null;
	grammarianMemberId: string | null;
	voteCounterMemberId: string | null;
}> {
```

and its return statement:

```ts
	return {
		tmodMemberId: findTmodSlot(slotRows)?.assignedMemberId ?? null,
		grammarianMemberId: findGrammarianSlot(slotRows)?.assignedMemberId ?? null,
		voteCounterMemberId:
			findVoteCounterSlot(slotRows)?.assignedMemberId ?? null,
	};
```

Add `findVoteCounterSlot` to the existing `#/lib/meeting-roles` import on line 18.

Then append to the file:

```ts
export interface VoteCounterAuthz {
	clubId: string;
	allowed: boolean;
	via: "admin" | "vote-counter-self-assert" | null;
	voteCounterMemberId: string | null;
	/** The member to credit in `activity_log` (null for an impersonated admin). */
	actorMemberId: string | null;
	/** The meeting's status, so the caller can decide about the lock itself. */
	meetingStatus: string;
}

/**
 * Decide whether a caller may operate a meeting's digital votes (#510): open
 * and close the windows, read the running tally, and confirm the winner.
 * Allowed for a club `admin` (session), or when the self-asserted `memberId`
 * holds the meeting's `vote_counter` slot.
 *
 * UNLIKE `resolveMeetingAgendaAuthz` and `resolveWordOfTheDayAuthz`, this does
 * NOT call `assertMeetingNotLocked`, and that is deliberate. Completing a
 * meeting is what force-closes voting, so a uniform lock check here would (a)
 * make the tally unreadable on exactly the meetings whose tally matters, and
 * (b) block the Ballot Counter from confirming a winner afterwards — which
 * `setAward` explicitly permits, because minutes are written up after the
 * meeting. Callers that MUTATE the vote window call `assertMeetingNotLocked`
 * on the returned `meetingStatus` themselves.
 */
export async function resolveVoteCounterAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<VoteCounterAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const clubId = meeting.clubId;
	const { voteCounterMemberId } = await loadRoleSlotAssignees(input.meetingId);

	const admin = await resolveAdminGrant(input.sessionUserId, clubId);
	if (admin.granted) {
		return {
			clubId,
			allowed: true,
			via: "admin",
			voteCounterMemberId,
			actorMemberId: admin.memberId,
			meetingStatus: meeting.status,
		};
	}

	if (
		input.selfMemberId &&
		voteCounterMemberId &&
		input.selfMemberId === voteCounterMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "vote-counter-self-assert",
			voteCounterMemberId,
			// Verified against the slot above, so it is safe to credit.
			actorMemberId: voteCounterMemberId,
			meetingStatus: meeting.status,
		};
	}

	return {
		clubId,
		allowed: false,
		via: null,
		voteCounterMemberId,
		actorMemberId: null,
		meetingStatus: meeting.status,
	};
}
```

- [x] **Step 6: Verify the existing authz tests still pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/meeting-authz.integration.test.ts`

Expected: PASS.

- [x] **Step 7: Typecheck and commit**

```bash
bun run typecheck
bun run check
git add src/lib/meeting-roles.ts src/lib/meeting-roles.vote-counter.test.ts src/server/meeting-authz-logic.ts
git commit -m "feat(voting): vote-counter capability, keyed not named (#510)"
```

---

## Task 4: Open and close a vote

**Files:**
- Create: `src/server/voting-logic.ts`
- Modify: `src/server/voting.integration.test.ts`

- [x] **Step 1: Write the failing tests**

Append to `src/server/voting.integration.test.ts`. Add the imports it needs at the top of the file:

```ts
const { closeVote, listVoteSessions, openVote } = await import(
	"#/server/voting-logic"
);
```

and the block:

```ts
describe.skipIf(!hasTestDb)("open and close a vote (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("opens a vote and reports it open", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker).toMatchObject({ isOpen: true });
	});

	it("closing sets closedAt and reports it closed", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker).toMatchObject({ isOpen: false });
	});

	it("re-opening a closed vote reuses the SAME row", async () => {
		const args = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		};
		await openVote(args);
		await closeVote(args);
		await openVote(args);
		const rows = await testDb
			.select()
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, seed.meetingId));
		expect(rows).toHaveLength(1);
		expect(rows[0].closedAt).toBeNull();
	});

	it("opening twice is idempotent, not an error", async () => {
		const args = {
			meetingId: seed.meetingId,
			category: "best_speaker" as const,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		};
		await openVote(args);
		await expect(openVote(args)).resolves.toBeUndefined();
	});

	it("reports every category, open or not", async () => {
		const sessions = await listVoteSessions(seed.meetingId);
		expect(Object.keys(sessions).sort()).toEqual([
			"best_evaluator",
			"best_speaker",
			"best_table_topics",
		]);
		expect(sessions.best_evaluator.isOpen).toBe(false);
	});
});
```

- [x] **Step 2: Run and watch it fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: FAIL — `Cannot find module '#/server/voting-logic'`.

- [x] **Step 3: Implement**

Create `src/server/voting-logic.ts`:

```ts
/**
 * Digital voting DB logic (#510), split out from `voting.ts` (a createServerFn
 * module the guard test forbids from exporting db-touching functions).
 *
 * A vote SESSION is the window for one award category on one meeting. NULL
 * `closed_at` means open. The winner is NOT stored here — the Ballot Counter
 * confirms it into `meeting_awards` via the existing `setAward`.
 *
 * Authorization is the caller's job (`resolveVoteCounterAuthz`), matching how
 * `minutes-logic.ts` trusts its server fn's admin gate.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { meetingVoteSessions } from "#/db/schema";
import { logActivity } from "./activity";
import { AWARD_CATEGORIES, type AwardCategory } from "./minutes-logic";

export interface VoteSessionState {
	isOpen: boolean;
	openedAt: Date | null;
	closedAt: Date | null;
}

export type VoteSessionStates = Record<AwardCategory, VoteSessionState>;

/** Every category's window state, whether or not a session row exists. */
export async function listVoteSessions(
	meetingId: string,
): Promise<VoteSessionStates> {
	const rows = await db
		.select()
		.from(meetingVoteSessions)
		.where(eq(meetingVoteSessions.meetingId, meetingId));
	const byCategory = new Map(rows.map((r) => [r.category, r]));
	const out = {} as VoteSessionStates;
	for (const category of AWARD_CATEGORIES) {
		const row = byCategory.get(category);
		out[category] = {
			isOpen: Boolean(row) && row?.closedAt == null,
			openedAt: row?.openedAt ?? null,
			closedAt: row?.closedAt ?? null,
		};
	}
	return out;
}

interface WindowInput {
	meetingId: string;
	clubId: string;
	category: AwardCategory;
	actorMemberId: string | null;
}

/**
 * Open (or re-open) a category's vote. Upserts on the (meeting, category)
 * unique index rather than inserting a second row, so re-opening after a close
 * restores the SAME session and every ballot already cast into it.
 */
export async function openVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.insert(meetingVoteSessions)
			.values({
				meetingId: input.meetingId,
				category: input.category,
				openedByMemberId: input.actorMemberId,
			})
			.onConflictDoUpdate({
				target: [
					meetingVoteSessions.meetingId,
					meetingVoteSessions.category,
				],
				set: {
					closedAt: null,
					openedAt: new Date(),
					openedByMemberId: input.actorMemberId,
					updatedAt: new Date(),
				},
			});
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_open",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/** Close a category's vote. A no-op when it was never opened or is already
 *  closed — closing is idempotent so a double-tap is harmless. */
export async function closeVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		const closed = await tx
			.update(meetingVoteSessions)
			.set({ closedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(meetingVoteSessions.meetingId, input.meetingId),
					eq(meetingVoteSessions.category, input.category),
					isNull(meetingVoteSessions.closedAt),
				),
			)
			.returning({ id: meetingVoteSessions.id });
		if (closed.length === 0) return;
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_close",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/**
 * Force-close every open vote on a meeting, inside a caller-supplied
 * transaction. Called by `applyCompleteMeeting` (#510) so a meeting that has
 * been closed out cannot still be voted on.
 *
 * Takes `tx` rather than opening its own, and does NOT route through
 * `closeVote`: the completion path sets `status = completed`, and `closeVote`'s
 * caller asserts the lock — so calling it here would throw on the very
 * transition that triggers it.
 */
export async function closeAllVotesTx(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	meetingId: string,
): Promise<void> {
	await tx
		.update(meetingVoteSessions)
		.set({ closedAt: sql`now()`, updatedAt: sql`now()` })
		.where(
			and(
				eq(meetingVoteSessions.meetingId, meetingId),
				isNull(meetingVoteSessions.closedAt),
			),
		);
}
```

- [x] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: PASS, 10 tests (5 from Task 1 plus 5 here).

- [x] **Step 5: Commit**

```bash
bun run typecheck
bun run check
git add src/server/voting-logic.ts src/server/voting.integration.test.ts
git commit -m "feat(voting): open, close and re-open a vote window (#510)"
```

---

## Task 5: Cast a vote

This is the security-critical task. Three separate things must hold, and each has its own test.

**Files:**
- Modify: `src/server/voting-logic.ts`
- Modify: `src/server/voting.integration.test.ts`

- [x] **Step 1: Write the failing tests**

Add `castVote` to the `voting-logic` import block at the top of the test file, then append:

```ts
describe.skipIf(!hasTestDb)("castVote (#510)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				sortOrder: 99,
			})
			.returning({ id: roleDefinitions.id });
		speakerRoleId = def.id;
		// The admin member is the meeting's speaker, so they are the one eligible
		// candidate for best_speaker.
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: 0,
			assignedMemberId: seed.adminMemberId,
		});
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const ballot = (over: Record<string, unknown> = {}) => ({
		meetingId: seed.meetingId,
		category: "best_speaker" as const,
		voter: { kind: "member" as const, id: seed.memberId },
		candidate: { kind: "member" as const, id: seed.adminMemberId },
		...over,
	});

	it("records a vote", async () => {
		await castVote(ballot());
		const rows = await testDb.select().from(meetingVotes);
		expect(rows).toHaveLength(1);
		expect(rows[0].candidateMemberId).toBe(seed.adminMemberId);
	});

	it("re-voting while open REPLACES the pick, it does not add a row", async () => {
		await castVote(ballot());
		await castVote(
			ballot({ candidate: { kind: "member", id: seed.memberId } }),
		);
		const rows = await testDb.select().from(meetingVotes);
		expect(rows).toHaveLength(1);
		expect(rows[0].candidateMemberId).toBe(seed.memberId);
	});

	it("REJECTS a vote once the window is closed", async () => {
		await closeVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await expect(castVote(ballot())).rejects.toThrow(/not open/i);
		expect(await testDb.select().from(meetingVotes)).toHaveLength(0);
	});

	it("REJECTS a vote for someone who is not an eligible candidate", async () => {
		// seed.memberId holds no speaker slot, so they cannot win best_speaker.
		await expect(
			castVote(ballot({ candidate: { kind: "member", id: seed.memberId } })),
		).rejects.toThrow(/not eligible/i);
	});

	it("REJECTS a voter from a DIFFERENT club", async () => {
		const other = await seedClub();
		try {
			await expect(
				castVote(ballot({ voter: { kind: "member", id: other.memberId } })),
			).rejects.toThrow(/not found in this club/i);
			expect(await testDb.select().from(meetingVotes)).toHaveLength(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("REJECTS a vote into a category that was never opened", async () => {
		await expect(
			castVote(ballot({ category: "best_evaluator" })),
		).rejects.toThrow(/not open/i);
	});

	it("lets a guest vote", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Silva, Marco" })
			.returning({ id: guests.id });
		await castVote(ballot({ voter: { kind: "guest", id: g.id } }));
		const rows = await testDb.select().from(meetingVotes);
		expect(rows[0].voterGuestId).toBe(g.id);
	});

	it("allows a self-vote — deliberately not blocked", async () => {
		await castVote(
			ballot({ voter: { kind: "member", id: seed.adminMemberId } }),
		);
		expect(await testDb.select().from(meetingVotes)).toHaveLength(1);
	});
});
```

Add `roleDefinitions` and `roleSlots` to the `#/db/schema` import at the top of the test file.

- [x] **Step 2: Run and watch it fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: FAIL — `castVote is not a function`.

- [x] **Step 3: Implement**

Append to `src/server/voting-logic.ts`:

```ts
export interface VoterRef {
	kind: "member" | "guest";
	id: string;
}

/**
 * Cast (or change) one ballot.
 *
 * Three things the client is NOT trusted for, in order:
 *
 *  1. The CANDIDATE is re-derived server-side from `loadAwardCandidates`, so a
 *     hand-crafted POST cannot vote for someone who never spoke.
 *  2. The VOTER is scoped to the meeting's club, the same way `setAward` scopes
 *     a winner. A guest carries a `club_id` and is checked directly.
 *  3. The WINDOW is checked inside the INSERT rather than before it. Reading
 *     `closed_at` and then inserting leaves a gap in which the Ballot Counter
 *     closes the vote and a ballot still lands; the conditional insert closes
 *     it, because the session row must still satisfy `closed_at IS NULL` at
 *     write time.
 */
export async function castVote(input: {
	meetingId: string;
	category: AwardCategory;
	voter: VoterRef;
	candidate: VoterRef;
}): Promise<void> {
	const clubId = await getMeetingClubId(input.meetingId);

	// (1) Candidate eligibility, from the SAME derivation the ballot rendered.
	const candidates = await loadAwardCandidates(input.meetingId);
	if (!isEligibleCandidate(candidates, input.category, input.candidate)) {
		throw new Error("That person is not eligible for this award.");
	}

	// (2) Voter scoping.
	if (input.voter.kind === "member") {
		await requireMemberInMeetingClub(input.voter.id, clubId);
	} else {
		await requireGuestInClub(input.voter.id, clubId);
	}

	const voterMemberId = input.voter.kind === "member" ? input.voter.id : null;
	const voterGuestId = input.voter.kind === "guest" ? input.voter.id : null;
	const candidateMemberId =
		input.candidate.kind === "member" ? input.candidate.id : null;
	const candidateGuestId =
		input.candidate.kind === "guest" ? input.candidate.id : null;

	// (3) Window check and write, atomically. `INSERT ... SELECT ... WHERE` means
	// the session must still be open at the instant the row lands.
	const inserted = await db
		.insert(meetingVotes)
		.select(
			db
				.select({
					sessionId: meetingVoteSessions.id,
					voterMemberId: sql<string | null>`${voterMemberId}::uuid`,
					voterGuestId: sql<string | null>`${voterGuestId}::uuid`,
					candidateMemberId: sql<string | null>`${candidateMemberId}::uuid`,
					candidateGuestId: sql<string | null>`${candidateGuestId}::uuid`,
				})
				.from(meetingVoteSessions)
				.where(
					and(
						eq(meetingVoteSessions.meetingId, input.meetingId),
						eq(meetingVoteSessions.category, input.category),
						isNull(meetingVoteSessions.closedAt),
					),
				),
		)
		.onConflictDoUpdate({
			target: voterMemberId
				? [meetingVotes.sessionId, meetingVotes.voterMemberId]
				: [meetingVotes.sessionId, meetingVotes.voterGuestId],
			set: {
				candidateMemberId,
				candidateGuestId,
				updatedAt: new Date(),
			},
		})
		.returning({ id: meetingVotes.id });

	if (inserted.length === 0) {
		throw new Error("Voting for this award is not open.");
	}
}

/** Throws unless `guestId` belongs to `clubId`. The guest-side twin of
 *  `requireMemberInMeetingClub`. */
async function requireGuestInClub(guestId: string, clubId: string) {
	const [row] = await db
		.select({ id: guests.id })
		.from(guests)
		.where(and(eq(guests.id, guestId), eq(guests.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error("Guest not found in this club.");
}
```

Extend the imports at the top of `voting-logic.ts`:

```ts
import { guests, meetingVoteSessions, meetingVotes } from "#/db/schema";
import {
	isEligibleCandidate,
	loadAwardCandidates,
} from "./award-candidates-logic";
import {
	AWARD_CATEGORIES,
	type AwardCategory,
	getMeetingClubId,
	requireMemberInMeetingClub,
} from "./minutes-logic";
```

If drizzle's `.insert().select()` builder is unavailable in the installed version, use `db.execute(sql\`...\`)` with the same `INSERT INTO meeting_votes (...) SELECT ... FROM meeting_vote_sessions WHERE ... AND closed_at IS NULL ON CONFLICT ... DO UPDATE ...` statement. The requirement is that the window predicate and the write are **one statement** — do not fall back to a read-then-write.

- [x] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: PASS, 18 tests.

- [x] **Step 5: Verify the window check is real, by breaking it**

A passing test proves nothing if the assertion never ran. **Do not verify this with a `console.log` — vitest swallows console output in this repo, which has previously made a live branch look dead.** Mutate the code instead:

In `castVote`, temporarily delete the `isNull(meetingVoteSessions.closedAt)` line from the `.where(...)`.

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: **FAIL** on "REJECTS a vote once the window is closed". If it still passes, the conditional insert is not doing the work and must be fixed before continuing.

Restore the line and re-run. Expected: PASS.

- [x] **Step 6: Verify the club scoping is real, the same way**

Temporarily delete the `await requireMemberInMeetingClub(...)` call.

Run the suite. Expected: **FAIL** on "REJECTS a voter from a DIFFERENT club".

This check matters more than it looks: a scope guard on this codebase has previously satisfied its own predicate rule while scoping nothing at all. The two-club test is the proof; the guard test in Task 8 is only a net.

Restore the line and re-run. Expected: PASS.

- [x] **Step 7: Commit**

```bash
bun run typecheck
bun run check
git add src/server/voting-logic.ts src/server/voting.integration.test.ts
git commit -m "feat(voting): cast a ballot, with atomic window and candidate checks (#510)"
```

---

## Task 6: The tally and the ballot read

**Files:**
- Modify: `src/server/voting-logic.ts`
- Modify: `src/server/voting.integration.test.ts`

- [x] **Step 1: Write the failing tests**

Add `loadBallot`, `loadTally` and `loadParticipation` to the `voting-logic` import block, then append:

```ts
describe.skipIf(!hasTestDb)("ballot and tally reads (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({ clubId: seed.clubId, name: "Speaker", category: "speaker", sortOrder: 99 })
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: def.id,
			slotIndex: 0,
			assignedMemberId: seed.adminMemberId,
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const open = (category: "best_speaker" | "best_evaluator") =>
		openVote({
			meetingId: seed.meetingId,
			category,
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});

	it("offers candidates only for OPEN categories", async () => {
		await open("best_speaker");
		const b = await loadBallot(seed.meetingId);
		expect(b.categories.best_speaker.isOpen).toBe(true);
		expect(b.categories.best_speaker.candidates).toHaveLength(1);
		expect(b.categories.best_evaluator.isOpen).toBe(false);
		expect(b.categories.best_evaluator.candidates).toEqual([]);
	});

	it("carries no contact details", async () => {
		await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Haddad, Layla",
				email: "layla@example.com",
				phone: "+15559876543",
			});
		await open("best_speaker");
		const b = await loadBallot(seed.meetingId);
		expect(JSON.stringify(b)).not.toContain("layla@example.com");
		expect(JSON.stringify(b)).not.toContain("5559876543");
	});

	it("tallies counts per candidate", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const t = await loadTally(seed.meetingId);
		expect(t.best_speaker.results[0]).toMatchObject({
			id: seed.adminMemberId,
			count: 1,
		});
		expect(t.best_speaker.voterNames).toHaveLength(1);
	});

	it("the tally reports WHO voted but never WHAT they voted for", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const t = await loadTally(seed.meetingId);
		const serialized = JSON.stringify(t.best_speaker.voterNames);
		expect(serialized).not.toContain(seed.adminMemberId);
		expect(serialized).not.toContain(seed.memberId);
	});

	it("participation reports a bare count, never per-candidate numbers", async () => {
		await open("best_speaker");
		await castVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			voter: { kind: "member", id: seed.memberId },
			candidate: { kind: "member", id: seed.adminMemberId },
		});
		const p = await loadParticipation(seed.meetingId);
		expect(p.categories.best_speaker).toEqual({ ballotsIn: 1 });
	});

	it("has no denominator until attendance is actually marked", async () => {
		await open("best_speaker");
		const before = await loadParticipation(seed.meetingId);
		expect(before.presentCount).toBeNull();

		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
		});
		const after = await loadParticipation(seed.meetingId);
		expect(after.presentCount).toBe(1);
	});
});
```

- [x] **Step 2: Run and watch it fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: FAIL — `loadBallot is not a function`.

- [x] **Step 3: Implement**

Append to `src/server/voting-logic.ts`:

```ts
export interface BallotCategory {
	isOpen: boolean;
	candidates: AwardCandidate[];
}

export interface BallotData {
	meetingId: string;
	categories: Record<AwardCategory, BallotCategory>;
}

/**
 * What a phone sees. PUBLIC — names and ids only, never contact details: this
 * renders on a fully public route, and `voting.integration.test.ts` asserts the
 * payload directly rather than trusting the select list to stay narrow.
 *
 * Candidates are withheld for a closed category. There is no reason for a
 * closed ballot to ship a candidate list, and shipping one would let a phone
 * cast into a category the operator has not opened yet if the client were ever
 * wrong.
 */
export async function loadBallot(meetingId: string): Promise<BallotData> {
	const [sessions, candidates] = await Promise.all([
		listVoteSessions(meetingId),
		loadAwardCandidates(meetingId),
	]);
	const categories = {} as Record<AwardCategory, BallotCategory>;
	for (const category of AWARD_CATEGORIES) {
		const isOpen = sessions[category].isOpen;
		categories[category] = {
			isOpen,
			candidates: isOpen ? candidates[category] : [],
		};
	}
	return { meetingId, categories };
}

export interface TallyResult {
	kind: "member" | "guest";
	id: string;
	name: string;
	count: number;
}

export interface CategoryTally {
	isOpen: boolean;
	results: TallyResult[];
	/** Who has voted — names only. Participation, never preference: it lets the
	 *  Ballot Counter spot a ballot from someone who went home, and it cannot
	 *  reveal a choice because no id or candidate travels with it. */
	voterNames: string[];
}

/** The Ballot Counter's view. GATED — never reachable from the public route. */
export async function loadTally(
	meetingId: string,
): Promise<Record<AwardCategory, CategoryTally>> {
	const [sessions, candidates] = await Promise.all([
		listVoteSessions(meetingId),
		loadAwardCandidates(meetingId),
	]);
	const rows = await db
		.select({
			category: meetingVoteSessions.category,
			candidateMemberId: meetingVotes.candidateMemberId,
			candidateGuestId: meetingVotes.candidateGuestId,
			voterMemberName: members.name,
			voterGuestName: guests.name,
		})
		.from(meetingVotes)
		.innerJoin(
			meetingVoteSessions,
			eq(meetingVoteSessions.id, meetingVotes.sessionId),
		)
		.leftJoin(members, eq(members.id, meetingVotes.voterMemberId))
		.leftJoin(guests, eq(guests.id, meetingVotes.voterGuestId))
		.where(eq(meetingVoteSessions.meetingId, meetingId));

	const out = {} as Record<AwardCategory, CategoryTally>;
	for (const category of AWARD_CATEGORIES) {
		const mine = rows.filter((r) => r.category === category);
		const counts = new Map<string, number>();
		for (const r of mine) {
			const key = r.candidateMemberId
				? `member:${r.candidateMemberId}`
				: r.candidateGuestId
					? `guest:${r.candidateGuestId}`
					: null;
			// A removed member's vote survives with a null candidate (FK set null)
			// and is dropped from the tally rather than counted for nobody.
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		out[category] = {
			isOpen: sessions[category].isOpen,
			results: candidates[category]
				.map((c) => ({
					kind: c.kind,
					id: c.id,
					name: c.name,
					count: counts.get(`${c.kind}:${c.id}`) ?? 0,
				}))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
			voterNames: mine
				.map((r) => r.voterMemberName ?? r.voterGuestName ?? "")
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b)),
		};
	}
	return out;
}

export interface Participation {
	categories: Record<AwardCategory, { ballotsIn: number }>;
	/**
	 * How many people are marked present, or NULL when nobody has marked
	 * attendance yet.
	 *
	 * Null is the honest answer and the UI must render it as one ("7 votes in",
	 * not "7 of 0"). The server cannot know who is in the room: the ballot's
	 * name-pick identity lives in localStorage and is invisible until someone
	 * actually votes. Making the name pick write an attendance row would give a
	 * real denominator — and is deliberately NOT v1, because it is a public
	 * unauthenticated write into a table that means something, and anyone could
	 * mark anyone present.
	 */
	presentCount: number | null;
}

/**
 * How many ballots are in, per category. PUBLIC — this is what the projector
 * shows. Deliberately a bare count: per-candidate numbers stay in `loadTally`,
 * because a live leaderboard on the projector produces bandwagon voting and
 * kills the reveal.
 */
export async function loadParticipation(
	meetingId: string,
): Promise<Participation> {
	const rows = await db
		.select({
			category: meetingVoteSessions.category,
			ballotsIn: sql<number>`count(${meetingVotes.id})::int`,
		})
		.from(meetingVoteSessions)
		.leftJoin(meetingVotes, eq(meetingVotes.sessionId, meetingVoteSessions.id))
		.where(eq(meetingVoteSessions.meetingId, meetingId))
		.groupBy(meetingVoteSessions.category);
	const byCategory = new Map(rows.map((r) => [r.category, r.ballotsIn]));
	const categories = {} as Record<AwardCategory, { ballotsIn: number }>;
	for (const category of AWARD_CATEGORIES) {
		categories[category] = { ballotsIn: byCategory.get(category) ?? 0 };
	}

	const [attendance] = await db
		.select({
			marked: sql<number>`count(*)::int`,
			present: sql<number>`count(*) filter (where ${meetingAttendance.status} = 'present')::int`,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, meetingId));

	return {
		categories,
		presentCount: (attendance?.marked ?? 0) > 0 ? attendance.present : null,
	};
}
```

Add `meetingAttendance` and `members` to the `#/db/schema` import and `type AwardCandidate` to the `award-candidates-logic` import. No `people` join — `members.name` is the per-club authoritative display name, as in Task 2.

Add `meetingAttendance` to the `#/db/schema` import in the test file too.

- [x] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: PASS, 24 tests.

- [x] **Step 5: Commit**

```bash
bun run typecheck
bun run check
git add src/server/voting-logic.ts src/server/voting.integration.test.ts
git commit -m "feat(voting): ballot, tally and participation reads (#510)"
```

---

## Task 7: Completing a meeting force-closes its votes

**Files:**
- Modify: `src/server/meetings-logic.ts:249-262`
- Modify: `src/server/voting.integration.test.ts`

- [x] **Step 1: Write the failing test**

Append to `src/server/voting.integration.test.ts`:

```ts
describe.skipIf(!hasTestDb)("completing a meeting closes voting (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("force-closes an open vote", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		const sessions = await listVoteSessions(seed.meetingId);
		expect(sessions.best_speaker.isOpen).toBe(false);
	});

	it("completing a meeting with no votes at all does not throw", async () => {
		await expect(
			applyCompleteMeeting({
				meetingId: seed.meetingId,
				actorMemberId: seed.adminMemberId,
			}),
		).resolves.toMatchObject({ clubId: seed.clubId });
	});

	it("the tally is STILL readable once the meeting is completed", async () => {
		await openVote({
			meetingId: seed.meetingId,
			category: "best_speaker",
			actorMemberId: seed.adminMemberId,
			clubId: seed.clubId,
		});
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		const t = await loadTally(seed.meetingId);
		expect(t.best_speaker.isOpen).toBe(false);
		expect(Array.isArray(t.best_speaker.results)).toBe(true);
	});

	it("the winner can STILL be confirmed after the meeting is locked", async () => {
		// This is the whole reason `resolveVoteCounterAuthz` does not assert the
		// meeting lock. `setAward` is deliberately unlocked (minutes are written up
		// afterwards); if the authz layer asserted, the Ballot Counter could never
		// set a winner from the final tally.
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		await expect(
			setAward({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.adminMemberId,
			}),
		).resolves.toBeUndefined();
	});

	it("REJECTS opening a vote on a completed meeting", async () => {
		await applyCompleteMeeting({
			meetingId: seed.meetingId,
			actorMemberId: seed.adminMemberId,
		});
		// The lock assert lives in the server fn, not in `openVote`, so assert it
		// where it actually is.
		expect(() => assertMeetingNotLocked("completed")).toThrow();
	});
});
```

Add to the imports at the top of the test file:

```ts
const { applyCompleteMeeting } = await import("#/server/meetings-logic");
const { setAward } = await import("#/server/minutes-logic");
const { assertMeetingNotLocked } = await import(
	"#/server/meeting-authz-logic"
);
```

`seedClub` creates the meeting in the past, so the `meetingDateReached` guard in `applyCompleteMeeting` passes. If it does not, update the seeded meeting's `scheduledAt` to a past date in `beforeEach` before completing.

- [x] **Step 2: Run and watch it fail**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: FAIL on "force-closes an open vote" — `isOpen` is still `true`.

- [x] **Step 3: Implement**

In `src/server/meetings-logic.ts`, inside the `applyCompleteMeeting` transaction (line 249), add the close between the status update and the activity log:

```ts
	await db.transaction(async (tx) => {
		await tx
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, input.meetingId));
		// Digital voting (#510): a meeting that has been closed out cannot still be
		// voted on from the parking lot. In the SAME transaction as the status
		// change, or a ballot slips through the gap. Deliberately not routed through
		// `closeVote`, which asserts the lock this very statement is applying.
		await closeAllVotesTx(tx, input.meetingId);
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "completed" },
		});
	});
```

Add the import:

```ts
import { closeAllVotesTx } from "./voting-logic";
```

- [x] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts src/server/meeting-lifecycle.integration.test.ts`

Expected: PASS.

- [x] **Step 5: Verify the close is inside the transaction**

Temporarily move the `closeAllVotesTx(tx, ...)` call to *after* the `db.transaction(...)` block, changing `tx` to `db`. Run the suite — it still passes, which is the point: **the test cannot see the transaction boundary.** Read the code and confirm the call sits inside the callback, then restore it. Note in your commit that transactional placement is verified by reading, not by test.

- [x] **Step 6: Commit**

```bash
bun run typecheck
bun run check
git add src/server/meetings-logic.ts src/server/voting.integration.test.ts
git commit -m "feat(voting): completing a meeting force-closes its open votes (#510)"
```

---

## Task 8: Server functions and the two guards

**Files:**
- Create: `src/server/voting.ts`
- Create: `src/server/voting-authz.guard.test.ts`
- Create: `src/server/voting-payload.guard.test.ts`

Read `src/server/outreach-authz.guard.test.ts` and `src/server/guards.ts` before writing this. Note the direction rule for source-grep guards on this codebase: a guard asserting a pattern **must be present** is bypassed by a comment that merely names the pattern, so it must read the source via `readSource`; a guard asserting a set of offenders **must be empty** only ever fails falsely, so it may be written raw.

- [x] **Step 1: Write `voting.ts`**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	assertMeetingNotLocked,
	resolveVoteCounterAuthz,
} from "./meeting-authz-logic";
import {
	castVote,
	closeVote,
	loadBallot,
	loadParticipation,
	loadTally,
	openVote,
} from "./voting-logic";

// The db-touching logic lives in `voting-logic.ts` (never imported by client
// routes) so it can't drag `#/db` → `pg` into the browser bundle. This module
// exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type {
	BallotData,
	CategoryTally,
	TallyResult,
	VoterRef,
} from "./voting-logic";

const uuid = z.string().uuid();
const category = z.enum([
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);
const voterRef = z.object({ kind: z.enum(["member", "guest"]), id: uuid });

/** The public ballot (#510). PUBLIC — no session, mirroring `submitGuestBook`.
 *  Names and ids only; never contact details. */
export const getBallot = createServerFn({ method: "GET" })
	.validator((input: unknown) => z.object({ meetingId: uuid }).parse(input))
	.handler(async ({ data }) => loadBallot(data.meetingId));

/** How many ballots are in, per category. PUBLIC — this is the projector badge.
 *  Bare counts only; per-candidate numbers live behind `getVoteTally`. */
export const getVoteParticipation = createServerFn({ method: "GET" })
	.validator((input: unknown) => z.object({ meetingId: uuid }).parse(input))
	.handler(async ({ data }) => loadParticipation(data.meetingId));

/** Cast or change one ballot. PUBLIC. Every trust boundary is inside
 *  `castVote`: candidate eligibility, voter club-scoping, and the open window. */
export const submitVote = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z
			.object({
				meetingId: uuid,
				category,
				voter: voterRef,
				candidate: voterRef,
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		await castVote(data);
		return { ok: true as const };
	});

const operateSchema = z.object({
	meetingId: uuid,
	category,
	selfMemberId: uuid.nullable().optional(),
});

/** Open a category's vote. GATED — Ballot Counter or club admin. */
export const openVoteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => operateSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await openVote({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** Close a category's vote. GATED — Ballot Counter or club admin. */
export const closeVoteFn = createServerFn({ method: "POST" })
	.validator((input: unknown) => operateSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireVoteCounter(data);
		assertMeetingNotLocked(authz.meetingStatus);
		await closeVote({
			meetingId: data.meetingId,
			clubId: authz.clubId,
			category: data.category,
			actorMemberId: authz.actorMemberId,
		});
		return { ok: true as const };
	});

/** The running count. GATED — Ballot Counter or club admin. Deliberately does
 *  NOT assert the lock: the tally must stay readable after the meeting is
 *  completed, which is exactly when the winner gets confirmed. */
export const getVoteTally = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z
			.object({ meetingId: uuid, selfMemberId: uuid.nullable().optional() })
			.parse(input),
	)
	.handler(async ({ data }) => {
		await requireVoteCounter(data);
		return loadTally(data.meetingId);
	});

async function requireVoteCounter(data: {
	meetingId: string;
	selfMemberId?: string | null;
}) {
	const { getOptionalUser } = await import("./guards");
	const currentUser = await getOptionalUser();
	const authz = await resolveVoteCounterAuthz({
		meetingId: data.meetingId,
		sessionUserId: currentUser?.id ?? null,
		selfMemberId: data.selfMemberId ?? null,
	});
	if (!authz.allowed) {
		throw new Error("Only the Vote Counter can do that.");
	}
	return authz;
}
```

Check `src/server/guards.ts` for the actual name of the "session user if any, else null" helper. If it is not `getOptionalUser`, use the real one and import it at the top of the file rather than dynamically. `resolveMeetingAgendaAuthz`'s existing callers show the established pattern — follow it.

- [x] **Step 2: Write the authz guard**

Create `src/server/voting-authz.guard.test.ts`:

```ts
/**
 * Every MUTATING vote server fn must be gated (#510).
 *
 * Reads the source rather than the module: a "must be present" guard is
 * satisfied by a comment that merely names the pattern, so it reads the real
 * text and strips comments before asserting.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/voting.ts");

const GATED = ["openVoteFn", "closeVoteFn", "getVoteTally"];

describe("voting server fns are gated (#510)", () => {
	for (const name of GATED) {
		it(`${name} calls requireVoteCounter`, () => {
			const start = SOURCE.indexOf(`export const ${name} =`);
			expect(start, `${name} not found`).toBeGreaterThan(-1);
			const next = GATED.map((n) =>
				n === name ? -1 : SOURCE.indexOf(`export const ${n} =`),
			)
				.concat(SOURCE.length)
				.filter((i) => i > start)
				.sort((a, b) => a - b)[0];
			expect(SOURCE.slice(start, next)).toContain("requireVoteCounter(");
		});
	}

	it("openVoteFn and closeVoteFn assert the meeting lock", () => {
		for (const name of ["openVoteFn", "closeVoteFn"]) {
			const start = SOURCE.indexOf(`export const ${name} =`);
			expect(SOURCE.slice(start, start + 800)).toContain(
				"assertMeetingNotLocked(",
			);
		}
	});
});
```

- [x] **Step 3: Write the payload guard**

Create `src/server/voting-payload.guard.test.ts`:

```ts
/**
 * The public ballot payload must never carry PII (#510). The club sheet is a
 * SOFT gate and this route is fully public, so an email or phone on the payload
 * is a leak, not a display bug.
 *
 * "Offenders must be EMPTY" shape — it can only fail falsely, so the raw source
 * is fine here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LOGIC = readFileSync("src/server/voting-logic.ts", "utf8");
const CANDIDATES = readFileSync("src/server/award-candidates-logic.ts", "utf8");

describe("public voting payloads carry no PII (#510)", () => {
	it("neither module selects an email or phone column", () => {
		const offenders: string[] = [];
		for (const [file, src] of [
			["voting-logic.ts", LOGIC],
			["award-candidates-logic.ts", CANDIDATES],
		] as const) {
			for (const column of [
				"guests.email",
				"guests.phone",
				"people.email",
				"people.phone",
				"members.email",
			]) {
				if (src.includes(column)) offenders.push(`${file}: ${column}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
```

- [x] **Step 4: Run the guards and the module split test**

Run: `bun run test src/server/voting-authz.guard.test.ts src/server/voting-payload.guard.test.ts src/server/server-modules.guard.test.ts`

Expected: PASS. If `server-modules.guard.test.ts` fails, `voting.ts` is exporting something that touches the database — move it to `voting-logic.ts`.

- [x] **Step 5: Commit**

```bash
bun run typecheck
bun run check
git add src/server/voting.ts src/server/voting-authz.guard.test.ts src/server/voting-payload.guard.test.ts
git commit -m "feat(voting): server functions, gated, with payload and authz guards (#510)"
```

---

## Task 9: The public ballot route

**Files:**
- Create: `src/components/club/ballot.tsx`
- Create: `src/routes/club.$clubId_.meeting.$meetingId.vote.tsx`

Read `src/routes/club.$clubId_.guest-book.tsx` and `src/components/club/pick-name-form.tsx` first — this route follows the former's structure exactly.

- [x] **Step 1: Write the ballot component**

Create `src/components/club/ballot.tsx`:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import type { BallotData } from "#/server/voting";
import { getBallot, submitVote } from "#/server/voting";

/** Who this phone is voting as. Meeting-scoped, not club-scoped: a guest
 *  identity is not a standing one, and a shared phone should not carry last
 *  month's pick. */
export interface VoterIdentity {
	kind: "member" | "guest";
	id: string;
	name: string;
}

const CATEGORY_LABELS = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
} as const;

export function Ballot({
	meetingId,
	voter,
}: {
	meetingId: string;
	voter: VoterIdentity;
}) {
	// Polling, not push. The payload is a few hundred bytes; twenty phones on a
	// 5s interval is nothing, and it means no realtime infrastructure exists to
	// reconnect, buffer or proxy.
	const ballot = useQuery({
		queryKey: ["ballot", meetingId],
		queryFn: () => getBallot({ data: { meetingId } }),
		refetchInterval: 5000,
	});

	const [picked, setPicked] = useState<Record<string, string>>({});
	const [failed, setFailed] = useState<Record<string, boolean>>({});

	const cast = useMutation({
		mutationFn: (v: {
			category: keyof typeof CATEGORY_LABELS;
			candidate: { kind: "member" | "guest"; id: string };
		}) =>
			submitVote({
				data: {
					meetingId,
					category: v.category,
					voter: { kind: voter.kind, id: voter.id },
					candidate: v.candidate,
				},
			}),
		onSuccess: (_r, v) => setFailed((f) => ({ ...f, [v.category]: false })),
		onError: (_e, v) => setFailed((f) => ({ ...f, [v.category]: true })),
	});

	if (ballot.isPending) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	const open = Object.entries(ballot.data?.categories ?? {}).filter(
		([, c]) => c.isOpen,
	);

	if (open.length === 0) {
		return (
			<div className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
				<h2 className="font-display text-xl font-semibold">
					Voting isn't open yet
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Hang tight — this page updates by itself when the Vote Counter opens
					a vote.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			{open.map(([category, c]) => {
				const key = category as keyof typeof CATEGORY_LABELS;
				const chosen = picked[key];
				return (
					<section
						key={key}
						className="rounded-2xl border border-border bg-card p-5"
					>
						<h2 className="font-display text-lg font-semibold">
							{CATEGORY_LABELS[key]}
						</h2>
						<div className="mt-4 flex flex-col gap-2">
							{c.candidates.map((cand) => {
								const id = `${cand.kind}:${cand.id}`;
								const isChosen = chosen === id;
								return (
									<Button
										key={id}
										variant={isChosen ? "default" : "outline"}
										// Large tap target: this is used one-handed, standing up,
										// in a room, on a phone.
										className="h-14 justify-start text-base"
										onClick={() => {
											setPicked((p) => ({ ...p, [key]: id }));
											cast.mutate({
												category: key,
												candidate: { kind: cand.kind, id: cand.id },
											});
										}}
									>
										{isChosen ? (
											<CheckCircle2 className="mr-2 size-5" aria-hidden />
										) : null}
										{cand.name}
									</Button>
								);
							})}
						</div>
						{failed[key] ? (
							// The selection is KEPT on failure. A dropped vote that looks
							// cast is worse than a visible retry.
							<p className="mt-3 text-sm text-destructive">
								Couldn't send that — tap your choice again.
							</p>
						) : chosen ? (
							<p className="mt-3 text-sm text-muted-foreground">
								Vote recorded. Tap another name to change it.
							</p>
						) : null}
					</section>
				);
			})}
		</div>
	);
}

export type { BallotData };
```

- [x] **Step 2: Write the route**

Create `src/routes/club.$clubId_.meeting.$meetingId.vote.tsx`:

```tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { Ballot, type VoterIdentity } from "#/components/club/ballot";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { PublicFooter } from "#/components/public-footer";
import { Button } from "#/components/ui/button";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { readStoredMember } from "#/lib/member-identity";
import { getPublicMeetingByKey } from "#/server/meetings";

// Escapes the `/club/$clubId` shell (trailing `_`) so it never hits the
// pick-your-name member gate and never loads the shell's payload — this is the
// PUBLIC, no-auth ballot (#510), reached by scanning a QR in the room. Lean on
// purpose: twenty phones load it simultaneously on conference wifi.
export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/vote")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		const detail = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		});
		if (detail.meeting.clubId !== club.id) throw notFound();
		return {
			clubId: club.id,
			clubName: club.name,
			clubNumber: club.clubNumber,
			meetingId: detail.meeting.id,
		};
	},
	component: VotePage,
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

const voterKey = (meetingId: string) => `gavelup:voter:${meetingId}`;

function readVoter(meetingId: string): VoterIdentity | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(voterKey(meetingId));
		if (!raw) return null;
		const v = JSON.parse(raw);
		return typeof v?.id === "string" &&
			typeof v?.name === "string" &&
			(v.kind === "member" || v.kind === "guest")
			? v
			: null;
	} catch {
		return null;
	}
}

function VotePage() {
	const { clubId, clubName, clubNumber, meetingId } = Route.useLoaderData();
	const [voter, setVoter] = useState<VoterIdentity | null>(() => {
		const stored = readVoter(meetingId);
		if (stored) return stored;
		// Pre-fill from the club-scoped pick the public club page already made, so
		// a regular member never picks their name twice.
		const m = readStoredMember(clubId);
		return m ? { kind: "member", id: m.id, name: m.name } : null;
	});

	function chooseVoter(v: VoterIdentity) {
		localStorage.setItem(voterKey(meetingId), JSON.stringify(v));
		setVoter(v);
	}

	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				<ThemeToggle compact />
			</header>

			<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
				{voter ? (
					<>
						<Ballot meetingId={meetingId} voter={voter} />
						<Button
							variant="ghost"
							className="self-center text-xs text-muted-foreground"
							onClick={() => {
								localStorage.removeItem(voterKey(meetingId));
								setVoter(null);
							}}
						>
							Voting as {voter.name} — not you?
						</Button>
					</>
				) : (
					<VoterPicker
						clubId={clubId}
						meetingId={meetingId}
						onPick={chooseVoter}
					/>
				)}
			</main>
			<PublicFooter />
		</div>
	);
}
```

- [x] **Step 3: Write the capped guest-join path (server side)**

The ballot lets a visitor create a guest row from a fully public, unauthenticated endpoint. That is the feature's abuse surface, so it gets its own bounded entry point rather than reusing `submitGuestBook` (whose return shape carries no guest id, and whose semantics are pipeline capture, not voting).

First the test. Append to `src/server/voting.integration.test.ts`, adding `joinBallotAsGuest` to the `voting-logic` import block:

```ts
describe.skipIf(!hasTestDb)("joinBallotAsGuest (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("creates a guest and returns its id and name", async () => {
		const g = await joinBallotAsGuest({
			meetingId: seed.meetingId,
			name: "  Osei, Kwame  ",
		});
		expect(g.name).toBe("Osei, Kwame");
		const [row] = await testDb
			.select()
			.from(guests)
			.where(eq(guests.id, g.id));
		expect(row.clubId).toBe(seed.clubId);
	});

	it("rejects an empty name", async () => {
		await expect(
			joinBallotAsGuest({ meetingId: seed.meetingId, name: "   " }),
		).rejects.toThrow(/name/i);
	});

	it("caps a very long name by CODE POINT, not by UTF-16 unit", async () => {
		// Every one of these is a surrogate pair. A `.slice(0, 200)` would cut one
		// in half and emit a lone surrogate; `cap` counts code points (#522).
		const g = await joinBallotAsGuest({
			meetingId: seed.meetingId,
			name: "😀".repeat(500),
		});
		const [row] = await testDb.select().from(guests).where(eq(guests.id, g.id));
		expect([...row.name]).toHaveLength(80);
		expect(row.name).not.toMatch(/[\uD800-\uDFFF]$/);
	});

	it("refuses to create more than the per-meeting guest cap", async () => {
		for (let i = 0; i < 60; i++) {
			await joinBallotAsGuest({
				meetingId: seed.meetingId,
				name: `Visitor ${i}`,
			});
		}
		await expect(
			joinBallotAsGuest({ meetingId: seed.meetingId, name: "One too many" }),
		).rejects.toThrow(/too many/i);
	});
});
```

Run it: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test src/server/voting.integration.test.ts`

Expected: FAIL — `joinBallotAsGuest is not a function`.

Now implement. Append to `src/server/voting-logic.ts`:

```ts
/** Longest guest name the ballot will store, in CODE POINTS. */
const MAX_GUEST_NAME = 80;
/**
 * Most guests one meeting's ballot may create. The ballot is an unauthenticated
 * public POST that inserts rows, so it needs a ceiling — without one, a script
 * fills `guests` for any club whose meeting URL it can guess. Set far above any
 * real club meeting; a club that genuinely exceeds it adds the rest from the
 * minutes UI, which is gated.
 */
const MAX_BALLOT_GUESTS_PER_MEETING = 60;

/**
 * Register a visitor as a guest so they can vote (#510). PUBLIC and therefore
 * bounded on both axes: name length and how many rows one meeting can mint.
 *
 * The name is capped with `cap`, which counts CODE POINTS. Do not replace it
 * with `.slice()`: the truncation added to close a DoS in #522 WAS a DoS,
 * because slicing UTF-16 splits a surrogate pair and emits a lone surrogate.
 */
export async function joinBallotAsGuest(input: {
	meetingId: string;
	name: string;
}): Promise<{ id: string; name: string }> {
	const name = cap(input.name.trim(), MAX_GUEST_NAME);
	if (!name) throw new Error("A name is required to vote.");
	const clubId = await getMeetingClubId(input.meetingId);

	const [{ count } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(meetingBallotGuests)
		.where(eq(meetingBallotGuests.meetingId, input.meetingId));
	if (count >= MAX_BALLOT_GUESTS_PER_MEETING) {
		throw new Error("Too many guests have joined this ballot.");
	}

	return db.transaction(async (tx) => {
		const [created] = await tx
			.insert(guests)
			.values({ clubId, name })
			.returning({ id: guests.id, name: guests.name });
		await tx
			.insert(meetingBallotGuests)
			.values({ meetingId: input.meetingId, guestId: created.id });
		return created;
	});
}
```

This needs a third small table to count against — `guests` is club-scoped, not meeting-scoped, so counting club guests would throttle a club with a long history. Add to `src/db/schema.ts` beside the other two voting tables:

```ts
// Which guests THIS meeting's public ballot created (#510). Exists only so the
// per-meeting creation cap has something to count: `guests` is club-scoped, so
// counting there would throttle a club with years of visitors rather than a
// script hammering one meeting.
export const meetingBallotGuests = pgTable(
	"meeting_ballot_guests",
	{
		meetingId: uuid("meeting_id")
			.notNull()
			.references(() => meetings.id, { onDelete: "cascade" }),
		guestId: uuid("guest_id")
			.notNull()
			.references(() => guests.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.meetingId, t.guestId] }),
		index("meeting_ballot_guests_meeting_idx").on(t.meetingId),
	],
);
```

Add `primaryKey` to the `drizzle-orm/pg-core` import in `schema.ts` if it is not already there, and `cap` from `#/lib/cap` plus `meetingBallotGuests` to `voting-logic.ts`'s imports.

Regenerate and sync:

```bash
bun run db:generate
DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run db:push --force
```

Run the tests again. Expected: PASS, 4 new tests.

- [x] **Step 4: Expose it as a server fn**

Add to `src/server/voting.ts`:

```ts
/** Register a visitor so they can vote. PUBLIC — bounded inside
 *  `joinBallotAsGuest` on both name length and rows-per-meeting. */
export const joinBallot = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		z
			.object({ meetingId: uuid, name: z.string().min(1).max(400) })
			.parse(input),
	)
	.handler(async ({ data }) => joinBallotAsGuest(data));
```

The zod `.max(400)` is a cheap early reject on obvious junk; the real, code-point-correct cap is `joinBallotAsGuest`'s. Import `joinBallotAsGuest` from `./voting-logic`.

- [x] **Step 5: Write the `VoterPicker`**

Add to `src/routes/club.$clubId_.meeting.$meetingId.vote.tsx`:

```tsx
function VoterPicker({
	clubId,
	meetingId,
	onPick,
}: {
	clubId: string;
	meetingId: string;
	onPick: (v: VoterIdentity) => void;
}) {
	const [guestName, setGuestName] = useState("");
	const join = useMutation({
		mutationFn: () => joinBallot({ data: { meetingId, name: guestName.trim() } }),
		onSuccess: (g) => onPick({ kind: "guest", id: g.id, name: g.name }),
	});

	return (
		<div className="flex flex-col gap-6">
			<div className="text-center">
				<h1 className="font-display text-2xl font-semibold">Who are you?</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					So we count one vote per person.
				</p>
			</div>

			<PickNameForm
				clubId={clubId}
				onPicked={(m) => onPick({ kind: "member", id: m.id, name: m.name })}
			/>

			<div className="rounded-2xl border border-border bg-card p-5">
				<h2 className="text-sm font-semibold">Visiting us today?</h2>
				<form
					className="mt-3 flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (!guestName.trim() || join.isPending) return;
						join.mutate();
					}}
				>
					<Input
						value={guestName}
						onChange={(e) => setGuestName(e.target.value)}
						placeholder="Your name"
						aria-label="Your name"
					/>
					<Button type="submit" disabled={!guestName.trim() || join.isPending}>
						{join.isPending ? "Joining…" : "Join as a guest"}
					</Button>
					{join.isError ? (
						<p className="text-sm text-destructive">
							Couldn't join — try again, or ask the Vote Counter.
						</p>
					) : null}
				</form>
			</div>
		</div>
	);
}
```

Add these imports to the route file:

```tsx
import { useMutation } from "@tanstack/react-query";
import { PickNameForm } from "#/components/club/pick-name-form";
import { Input } from "#/components/ui/input";
import { joinBallot } from "#/server/voting";
```

Read `src/components/club/pick-name-form.tsx` and match its actual prop names — if the callback is not `onPicked`, use the real one. Everything else here is unchanged.

- [x] **Step 6: Run the app and vote**

```bash
bun run dev
```

Open `http://localhost:3000/club/<club-slug>/meeting/<yyyy-mm-dd>/vote`. Use a date key or a real v4 UUID — the seed meeting id `99999999-…` is not RFC-compliant and returns a 500 from the zod `.uuid()` validator.

Expected: the "Who are you?" picker, then "Voting isn't open yet." Open a vote directly in the database (`INSERT INTO meeting_vote_sessions (meeting_id, category) VALUES ('<id>', 'best_speaker')`), wait five seconds, and the page should flip to a ballot with no reload.

- [x] **Step 7: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
bun run typecheck
bun run check
git add src/db/schema.ts drizzle/ src/server/voting-logic.ts src/server/voting.ts src/server/voting.integration.test.ts src/components/club/ballot.tsx src/routes/club.\$clubId_.meeting.\$meetingId.vote.tsx
git commit -m "feat(voting): the public QR-reachable ballot, with a bounded guest join (#510)"
```

---

## Task 10: The Ballot Counter panel

**Files:**
- Create: `src/components/club/table-topics-capture.tsx`
- Create: `src/components/club/vote-counter-panel.tsx`
- Modify: `src/components/club/meeting-minutes.tsx:794` (the Table Topics section)
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [x] **Step 1: Extract the Table Topics picker**

Read `src/components/club/meeting-minutes.tsx` around line 794 (`const speakers = minutes.tableTopicsSpeakers;`). Lift that section — the list, the add-picker, the remove and reorder controls — into `src/components/club/table-topics-capture.tsx` as a component taking the speaker list plus `onAdd` / `onRemove` / `onMove` callbacks. Have `meeting-minutes.tsx` render it with its existing handlers.

This is a pure move. No behaviour changes.

- [x] **Step 2: Verify the move changed nothing**

Run: `bun run test src/components/club/meeting-minutes.test.tsx`

Expected: PASS, unchanged count. If any test needed editing, the move was not pure — revert and redo it.

- [x] **Step 3: Commit the extraction separately**

```bash
bun run typecheck
bun run check
git add src/components/club/table-topics-capture.tsx src/components/club/meeting-minutes.tsx
git commit -m "refactor(minutes): extract the Table Topics capture component (#510)"
```

- [x] **Step 4: Write the panel**

Create `src/components/club/vote-counter-panel.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "#/components/ui/button";
import type { AwardCategory } from "#/server/minutes-logic";
import { closeVoteFn, getVoteTally, openVoteFn } from "#/server/voting";

const CATEGORY_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as AwardCategory[];

export function VoteCounterPanel({
	meetingId,
	selfMemberId,
	onSetWinner,
}: {
	meetingId: string;
	selfMemberId: string | null;
	/** Calls the EXISTING setAward path the minutes UI already uses — the winner
	 *  lives in `meeting_awards`, not in the vote tables. */
	onSetWinner: (
		category: AwardCategory,
		winner: { kind: "member" | "guest"; id: string },
	) => void;
}) {
	const qc = useQueryClient();
	const tally = useQuery({
		queryKey: ["vote-tally", meetingId],
		queryFn: () => getVoteTally({ data: { meetingId, selfMemberId } }),
		refetchInterval: 5000,
	});

	const toggle = useMutation({
		mutationFn: (v: { category: AwardCategory; open: boolean }) =>
			v.open
				? openVoteFn({ data: { meetingId, category: v.category, selfMemberId } })
				: closeVoteFn({ data: { meetingId, category: v.category, selfMemberId } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["vote-tally", meetingId] }),
	});

	return (
		<div className="flex flex-col gap-4">
			{CATEGORIES.map((category) => {
				const t = tally.data?.[category];
				const total = t?.results.reduce((n, r) => n + r.count, 0) ?? 0;
				const top = t?.results[0]?.count ?? 0;
				const tied = (t?.results ?? []).filter(
					(r) => r.count === top && top > 0,
				);
				return (
					<section
						key={category}
						className="rounded-xl border border-border bg-card p-4"
					>
						<div className="flex items-center justify-between gap-3">
							<h3 className="font-semibold">{CATEGORY_LABELS[category]}</h3>
							<Button
								size="sm"
								variant={t?.isOpen ? "destructive" : "default"}
								disabled={toggle.isPending}
								onClick={() =>
									toggle.mutate({ category, open: !t?.isOpen })
								}
							>
								{t?.isOpen ? (
									<>
										<Lock className="mr-1 size-4" aria-hidden /> Close voting
									</>
								) : (
									<>
										<LockOpen className="mr-1 size-4" aria-hidden /> Open voting
									</>
								)}
							</Button>
						</div>

						<p className="mt-2 text-sm text-muted-foreground">
							{total} {total === 1 ? "vote" : "votes"} in
						</p>

						{/* Counts are visible HERE and nowhere else. The projector gets a
						    participation badge only — a live leaderboard in the room
						    produces bandwagon voting and kills the reveal. */}
						{!t?.isOpen && total > 0 ? (
							<div className="mt-3 flex flex-col gap-2">
								{tied.length > 1 ? (
									<p className="text-sm font-medium text-warning">
										{tied.length} tied on {top} — pick the winner.
									</p>
								) : null}
								{t.results.map((r) => (
									<div
										key={`${r.kind}:${r.id}`}
										className="flex items-center justify-between gap-3"
									>
										<span className="text-sm">
											{r.name} — {r.count}
										</span>
										<Button
											size="sm"
											variant="outline"
											onClick={() =>
												onSetWinner(category, { kind: r.kind, id: r.id })
											}
										>
											Set winner
										</Button>
									</div>
								))}
							</div>
						) : null}

						{t?.voterNames.length ? (
							/* WHO voted, never WHAT they voted for. Lets the Ballot Counter
							   spot a ballot from someone who already went home. */
							<details className="mt-3">
								<summary className="cursor-pointer text-xs text-muted-foreground">
									Who has voted ({t.voterNames.length})
								</summary>
								<p className="mt-1 text-xs text-muted-foreground">
									{t.voterNames.join(" · ")}
								</p>
							</details>
						) : null}
					</section>
				);
			})}
		</div>
	);
}
```

Note the deliberate absence: **no auto-write.** Closing a vote never sets an award. `onSetWinner` is always an explicit tap, so a tie, a winner who left early, or a late paper slip are all handled by the human rather than by a rule that has to anticipate them.

- [x] **Step 5: Mount it**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, add the vote-counter flag to the existing role derivation rather than building a parallel one. In `src/lib/meeting-roles.ts`, extend `deriveMeetingRoleFlags`:

```ts
export function deriveMeetingRoleFlags(
	slots: (RoleIdentity & { assigneeId: string | null })[],
	memberId: string | null,
): { isTmod: boolean; isGrammarian: boolean; isVoteCounter: boolean } {
	if (memberId === null)
		return { isTmod: false, isGrammarian: false, isVoteCounter: false };
	const tmod = findTmodSlot(slots)?.assigneeId ?? null;
	const gram = findGrammarianSlot(slots)?.assigneeId ?? null;
	const vote = findVoteCounterSlot(slots)?.assigneeId ?? null;
	return {
		isTmod: memberId === tmod,
		isGrammarian: memberId === gram,
		isVoteCounter: memberId === vote,
	};
}
```

Then in the meeting route, beside where the page already renders the Table Topics section:

```tsx
{(isVoteCounter || isAdmin) && (
	<>
		<TableTopicsCapture
			speakers={minutes.tableTopicsSpeakers}
			onAdd={handleAddTableTopicsSpeaker}
			onRemove={handleRemoveTableTopicsSpeaker}
			onMove={handleMoveTableTopicsSpeaker}
		/>
		<VoteCounterPanel
			meetingId={meetingId}
			selfMemberId={member?.id ?? null}
			onSetWinner={(category, winner) =>
				setAwardMutation.mutate({
					meetingId,
					category,
					memberId: winner.kind === "member" ? winner.id : null,
					guestId: winner.kind === "guest" ? winner.id : null,
				})
			}
		/>
	</>
)}
```

Match `handleAdd…`/`setAwardMutation` to the real handler names on that route; the shape above is what they must be wired to, not necessarily what they are called.

Run `bun run test src/lib/meeting-roles.test.ts` after changing `deriveMeetingRoleFlags` — existing callers destructure two fields and adding a third is additive, but the test file asserts the returned object and may need the new key.

- [x] **Step 6: Verify end to end in the browser**

```bash
GSTACK_CHROMIUM_NO_SANDBOX=1 bun run dev
```

Sign in via `/api/dev-login` (needs `ENABLE_DEV_LOGIN=1`). Assign yourself the Vote Counter role on a meeting, open Best Speaker from the panel, cast a vote from the ballot page in a second browser profile, and confirm the count reaches 1 within five seconds. Then close the vote and set the winner; confirm it appears in the minutes' awards section.

Do not use `mcp__claude-in-chrome__*` tools for this — use the `/browse` skill or the `$B` binary.

- [x] **Step 7: Commit**

```bash
git checkout src/routeTree.gen.ts 2>/dev/null || true
bun run typecheck
bun run check
git add src/components/club/vote-counter-panel.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx src/lib/meeting-roles.ts
git commit -m "feat(voting): the Ballot Counter panel (#510)"
```

---

## Task 11: QR and participation on the present-mode vote slides

**Files:**
- Modify: `src/lib/agenda-slides.ts:180,202,210`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`
- Modify: `src/lib/agenda-slides.test.ts`

- [x] **Step 1: Write the failing test**

Add to `src/lib/agenda-slides.test.ts`:

```ts
it("carries the ballot URL on every vote slide (#510)", () => {
	const deck = buildSlideDeck(meeting, club, slots);
	const voteSlides = deck.filter((s) => s.kind.startsWith("vote"));
	expect(voteSlides.length).toBeGreaterThan(0);
	for (const s of voteSlides) {
		expect(s).toHaveProperty("ballotUrl");
		expect((s as { ballotUrl: string }).ballotUrl).toContain("/vote");
	}
});
```

Match `meeting`, `club` and `slots` to the fixtures already in that file.

- [x] **Step 2: Run and watch it fail**

Run: `bun run test src/lib/agenda-slides.test.ts`

Expected: FAIL — no `ballotUrl` property.

- [x] **Step 3: Implement**

In `src/lib/agenda-slides.ts`, add the field to the `VoteTiming` type that all three vote slide kinds intersect (lines 180, 202, 210):

```ts
	/** Absolute URL of this meeting's public ballot (#510), rendered as a QR on
	 *  the slide. The projector is already showing "Vote for Best Speaker" at
	 *  exactly the moment people need to scan, which beats a printed footer. */
	ballotUrl: string;
```

Add `ballotUrl` to `SlideDeckInput` (line 370) so the caller supplies it — building a URL inside a pure deck builder would need the origin, which it has no business knowing:

```ts
	ballotUrl: string;
```

Then populate it at the three construction sites (lines 545, 571, 606):

```ts
		deck.push({
			kind: "voteSpeaker",
			names: assignedNames(speakers),
			ballotUrl: input.ballotUrl,
			...voteTiming,
		});
```

and the equivalent for `voteTableTopics` (line 571) and `voteEvaluator` (line 606). Match each site's existing property list; only `ballotUrl` is new.

At the call site, build the URL with the helper in `src/lib/presentation-url.ts` rather than concatenating a path — read that file and follow its pattern, appending the `/vote` segment.

- [x] **Step 4: Render it**

In `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`, in the branch that renders the three vote slide kinds:

```tsx
<div className="flex items-center gap-8">
	<div className="flex-1">{/* the existing candidate names */}</div>
	<div className="flex flex-col items-center gap-2">
		<div className="rounded-xl bg-white p-3">
			<QRCodeSVG value={slide.ballotUrl} size={220} marginSize={0} />
		</div>
		<p className="text-lg font-semibold">Scan to vote</p>
		{/* A BARE COUNT. Never per-candidate numbers on the projector: a live
		    leaderboard produces bandwagon voting and destroys the reveal. The
		    denominator appears ONLY when attendance has been marked — with no
		    attendance there is no honest denominator, so we show none. */}
		<p className="text-sm opacity-70">{participationLabel(slide.kind)}</p>
	</div>
</div>
```

with, near the top of the component:

```tsx
import { QRCodeSVG } from "qrcode.react";
import { getVoteParticipation } from "#/server/voting";

const participation = useQuery({
	queryKey: ["vote-participation", meetingId],
	queryFn: () => getVoteParticipation({ data: { meetingId } }),
	refetchInterval: 5000,
});

const voteCategory = (kind: string) =>
	kind === "voteSpeaker"
		? "best_speaker"
		: kind === "voteEvaluator"
			? "best_evaluator"
			: "best_table_topics";

function participationLabel(kind: string): string {
	const p = participation.data;
	const n = p?.categories[voteCategory(kind)]?.ballotsIn ?? 0;
	// `presentCount` is null until someone marks attendance. Render the bare
	// count then — "7 of 0" would be worse than no denominator at all.
	return p?.presentCount != null
		? `${n} of ${p.presentCount} present have voted`
		: `${n} ${n === 1 ? "vote" : "votes"} in`;
}
```

The white padded wrapper is not decoration — a QR rendered dark-on-dark in the projector's dark theme will not scan.

- [x] **Step 5: Run the tests**

Run: `bun run test src/lib/agenda-slides.test.ts src/lib/slide-layout.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
bun run typecheck
bun run check
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx
git commit -m "feat(present): QR and participation badge on the vote slides (#510)"
```

---

## Task 12: QR on the printed agenda

**This task touches print CSS, which is invisible to every automated gate except one.** A missing reset once shipped a blank second page past six test files, typecheck, lint and two human reviews. The page-count gate added in v1.8.4.0 (#502) is the only thing that catches it.

**Files:**
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.test.tsx`

- [x] **Step 1: Read the page-count gate first**

Read `src/routes/print-page-reset.guard.test.ts` and `src/routes/club.$clubId_.meeting.$meetingId.print.test.tsx` before writing any markup. Understand what the gate counts and how, then write the QR into the footer in a way that gate can see.

- [x] **Step 2: Add the QR**

Add the QR **inside the existing footer element**, not as a new top-level block — a new top-level block is what pushes a page.

```tsx
<span className="pg-novoid inline-flex items-center gap-2">
	<QRCodeSVG value={ballotUrl} size={64} marginSize={0} />
	<span className="text-[10px] leading-tight">
		Scan to vote
		<br />
		Best Speaker · Evaluator · Table Topics
	</span>
</span>
```

with `import { QRCodeSVG } from "qrcode.react";` at the top, and `ballotUrl` built by the same `presentation-url.ts` helper Task 11 used.

Two print-specific requirements, both invisible to the browser preview:

- The QR must be **inline** (`inline-flex`), not a block. A block-level element in the footer is what breaks the page.
- It must not be allowed to break across pages. If the repo's print stylesheet has a "keep together" utility, use it; otherwise add `break-inside: avoid` to this element in the print stylesheet rather than inline, so the single-stylesheet rule from v1.8.4.0 holds.

Replace `pg-novoid` with whatever the repo's print stylesheet actually calls its no-break utility — read `src/styles/print-theme.tsx` (or the file `print-page-reset.guard.test.ts` points at) and use the real class. Do not invent one.

- [x] **Step 3: Run the print gates**

Run: `bun run test src/routes/club.\$clubId_.meeting.\$meetingId.print.test.tsx src/routes/print-page-reset.guard.test.ts`

Expected: PASS, with the page count unchanged from before your edit. If the count went from 1 to 2, the footer block is breaking the page — fix the CSS, do not update the expected count.

- [x] **Step 4: Verify by counting pages in a real PDF**

```bash
bun run dev
```

Open the print route, print to PDF, and **count the pages**. The gate asserts a number; your eyes confirm the number is the right one.

- [x] **Step 5: Commit**

```bash
bun run typecheck
bun run check
git add src/routes/club.\$clubId_.meeting.\$meetingId.print.tsx src/routes/club.\$clubId_.meeting.\$meetingId.print.test.tsx
git commit -m "feat(print): scan-to-vote QR in the agenda footer (#510)"
```

---

## Final verification

- [ ] **Full suite with the database**

```bash
TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test
```

Expected: PASS. Check the reported test count is in the thousands, not the hundreds — a count near ~2,600 means the integration suite skipped and the run is meaningless.

- [ ] **Typecheck and lint**

```bash
bun run typecheck
bun run check
```

- [ ] **Confirm the routeTree is clean**

```bash
git status --short src/routeTree.gen.ts
```

If it shows modified and you did not intend a routing change beyond the new vote route, run `git checkout src/routeTree.gen.ts`.

- [ ] **Ship**

Use the `/ship` skill: it merges the base branch, runs the tests, reviews the diff, bumps `VERSION`, updates `CHANGELOG.md`, commits, pushes and opens the PR. Reference #510 in the PR body.

---

## Notes for the reviewer

Three things in this build are load-bearing and easy to break in a later refactor:

1. **`loadAwardCandidates` is read by both the ballot and the validator.** If someone re-inlines the eligibility derivation into one of them, the ballot can start offering candidates the server rejects, and it will only show up mid-meeting.
2. **The window check lives inside the INSERT.** Refactoring `castVote` into a read-then-write reopens a race where a ballot lands after the Ballot Counter closed the vote.
3. **`resolveVoteCounterAuthz` deliberately does not assert the meeting lock.** Adding the assert for consistency with its two siblings breaks the tally read and the after-the-fact winner confirmation. The comment on the function says so; keep it there.
