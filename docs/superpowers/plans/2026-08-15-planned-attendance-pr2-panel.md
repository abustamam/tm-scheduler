# Planned Attendance PR 2 — the panel, plan mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the officer's binary "contacted" checkbox with a per-member status chip over the three-rung planned-attendance ladder, in a panel that also carries the WhatsApp/email drafts, and delete the two surfaces it absorbs.

**Architecture:** One new officer-only component, `MeetingAttendancePanel`, rendered in **plan mode** only (`meetingPhase() === "upcoming"`). Its derivation — bucketing, sorting, counts — lives in a pure `src/lib/` module so it is testable without jsdom. It writes through `setPlannedAttendance` / `clearPlannedAttendance`, the server fns that shipped unused in v1.14.0.0. `loadMeetingDetail` gains one `plan` array replacing the three id arrays the absorbed surfaces used. Roll mode, the guests group and the offline-queue lift are **PR 3** and are explicitly out of scope here.

**Tech Stack:** TanStack Start (React 19), shadcn/ui (`DropdownMenu`, `Button`, `Badge`, `Card`), Tailwind v4, Drizzle on Postgres, Vitest + Testing Library, Biome (tabs, double quotes).

**Spec:** `docs/superpowers/specs/2026-08-11-planned-attendance-design.md` — D2 (modes), D4 (placement), D5 (row anatomy), D6 (who can write), "Surfaces absorbed", "Delivery → PR 2".

## Global Constraints

- **The data model already shipped (v1.14.0.0). Do NOT touch it.** `meeting_attendance_plan`, the migrations, `attendance-plan-logic.ts` and `attendance-plan.ts` are done. This PR is UI + payload only. No migration, no schema edit — `bun run db:generate` must keep reporting "No schema changes".
- **Reach the plan table only through `src/server/attendance-plan-logic.ts`.** `attendance-plan-store.guard.test.ts` fails on any other file naming `meeting_attendance_plan` or `meetingAttendancePlan` — **including in a code comment**, because it reads non-test source files RAW. Write "the planned-attendance table" in prose instead. This has already bitten twice.
- **`reached_out` is officer-only to write.** `setPlannedAttendance` throws `OFFICER_ONLY_REACHED_OUT_MESSAGE` for a non-officer. The panel is officer-only so it may offer all four; the personal strip (Task 7) is member-facing and must offer only `coming` / `not_coming` / clear.
- **Links must be `<Button asChild><a>`, never a bare `<a>`.** `src/styles.css` styles bare `a` OUTSIDE `@layer`, so it beats any Tailwind utility and repaints the anchor link-teal — the 3.81:1 contrast bug from #559/#328. `NudgeButtons` already does this correctly; do not "simplify" it.
- **Plan writes are rejected on a locked meeting** (`assertMeetingNotLocked` inside `setPlannedAttendance`). Render the chip **disabled**, not missing (spec, Error handling).
- **Preview-as-member hides the panel entirely**, like every other officer surface. The route already computes `effectiveCanManage = canManage && !previewAsMember`.
- **Integration tests need a database or they SILENTLY SKIP.** Export `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` before `bun run test`.
- **`bun run typecheck` is the only thing that type-checks.** Vitest and the build both transpile without it, so a wrong fixture field passes the test run. Run typecheck before claiming a task green.
- Biome: tabs, double quotes. Run `bun run fix` before each commit, then `bunx biome check src/ --diagnostic-level=error`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/nudge.ts` (modify) | add the `"attendance"` draft mode — copy only, no role name |
| `src/lib/attendance-panel.ts` (create) | PURE derivation: bucket + sort the roster by rung, compute the counts line. No React, no db, so it is unit-testable and its numbers are assertable without a DOM. |
| `src/components/club/nudge-buttons.tsx` (modify) | accept the attendance mode (`roleName` becomes optional) |
| `src/components/club/meeting-attendance-panel.tsx` (create) | the panel + its row. Presentational; every write arrives as a callback prop. |
| `src/server/meetings.ts` (modify) | `loadMeetingDetail` returns one `plan` array |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` (modify) | mode, rail/stacked layout, write handlers |
| `src/components/agenda/meeting-agenda.tsx` (modify) | delete the "Not available this week" section and the `OutreachPanel` render |
| `src/components/club/outreach-panel.tsx` (delete) | absorbed |
| `src/components/club/meeting-personal-strip.tsx` (modify) | add "I'll be there" |

Derivation is split from the component on purpose: the counts line and the sort order are the two things a reviewer will want to see asserted, and asserting them through a rendered DOM makes the test slower, more brittle, and blind to ordering when two rows share a label.

---

## Task 1: The attendance draft copy

Contacting someone from the panel asks *"are you coming"*, not *"will you take this role"*. `buildNudge` only knows the two role-scoped modes today, and `roleName` is a required field of `NudgeInput`.

**Files:**
- Modify: `src/lib/nudge.ts`
- Modify: `src/components/club/nudge-buttons.tsx`
- Test: `src/lib/nudge.test.ts`, `src/components/club/nudge-buttons.test.tsx`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `NudgeMode` widens to `"confirm" | "recruit" | "attendance"`; `NudgeInput.roleName` becomes `roleName?: string`; `NudgeButtons` accepts `mode="attendance"` with no `roleName`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/nudge.test.ts`:

```ts
describe("attendance mode (#planned-attendance D5)", () => {
	it("asks whether they can make the meeting, naming no role", () => {
		const n = buildNudge({
			name: "Sam Rivera",
			phone: "+15551234567",
			email: null,
			meetingDate: "Tue 19 Aug",
			shareUrl: "https://club.example/m/2026-08-19",
			mode: "attendance",
		});
		expect(n.message).toBe(
			"Hi Sam, are you able to make our Tue 19 Aug meeting? Agenda here: https://club.example/m/2026-08-19",
		);
		// The whole point of the mode: no role is being asked for. A template that
		// leaked `undefined` would still contain the date and the URL and pass a
		// looser assertion.
		expect(n.message).not.toContain("undefined");
		expect(n.message).not.toContain("role");
	});

	it("greets by preferred name, like the other modes (#486)", () => {
		const n = buildNudge({
			name: "Zabihullah Kogyani",
			preferredName: "Zabi",
			phone: "+15551234567",
			email: null,
			meetingDate: "Tue 19 Aug",
			shareUrl: "https://club.example/m",
			mode: "attendance",
		});
		expect(n.message).toContain("Hi Zabi,");
	});

	it("uses an attendance subject line for the email fallback", () => {
		const n = buildNudge({
			name: "Sam Rivera",
			phone: null,
			email: "sam@example.com",
			meetingDate: "Tue 19 Aug",
			shareUrl: "https://club.example/m",
			mode: "attendance",
		});
		expect(n.emailUrl).toContain("subject=");
		expect(decodeURIComponent(n.emailUrl as string)).toContain(
			"Are you coming? — Tue 19 Aug",
		);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx vitest run src/lib/nudge.test.ts`
Expected: FAIL — `mode: "attendance"` is not assignable to `NudgeMode`.

- [ ] **Step 3: Widen the mode and make `roleName` optional**

In `src/lib/nudge.ts`:

```ts
export type NudgeMode = "confirm" | "recruit" | "attendance";
```

In `NudgeInput`, change `roleName: string;` to:

```ts
	/**
	 * The role being asked about. Absent for `mode: "attendance"`, which asks
	 * whether the member is coming AT ALL — role-specific asks stay on the slot
	 * cards and in "Nudge someone" (spec D5).
	 */
	roleName?: string;
```

Then extend both template functions. Handle `attendance` FIRST so the existing
ternaries keep their shape:

```ts
function messageFor(i: NudgeInput): string {
	const who = greetingName(i);
	if (i.mode === "attendance") {
		return `Hi ${who}, are you able to make our ${i.meetingDate} meeting? Agenda here: ${i.shareUrl}`;
	}
	return i.mode === "confirm"
		? `Hi ${who}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting. Details: ${i.shareUrl}`
		: `Hi ${who}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? Info here: ${i.shareUrl}`;
}

function subjectFor(i: NudgeInput): string {
	if (i.mode === "attendance") return `Are you coming? — ${i.meetingDate}`;
	return i.mode === "confirm"
		? `Confirming your ${i.roleName} role — ${i.meetingDate}`
		: `Open ${i.roleName} role — ${i.meetingDate} meeting?`;
}
```

- [ ] **Step 4: Make `roleName` optional on the component too**

In `src/components/club/nudge-buttons.tsx`, change the prop type `roleName: string;` to:

```ts
	/** Omitted for `mode="attendance"` — see `NudgeInput.roleName`. */
	roleName?: string;
```

Nothing else in that component changes: it forwards `roleName` straight into `buildNudge`, which now tolerates its absence.

- [ ] **Step 5: Add the component test**

Append to `src/components/club/nudge-buttons.test.tsx`:

```tsx
it("renders an attendance draft with no role name", () => {
	const { getByRole } = render(
		<NudgeButtons
			name="Sam Rivera"
			phone="+15551234567"
			email={null}
			meetingDate="Tue 19 Aug"
			shareUrl="https://club.example/m"
			mode="attendance"
		/>,
	);
	const link = getByRole("link", { name: /whatsapp/i });
	const href = decodeURIComponent(link.getAttribute("href") ?? "");
	expect(href).toContain("are you able to make our Tue 19 Aug meeting");
	expect(href).not.toContain("undefined");
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/nudge.test.ts src/components/club/nudge-buttons.test.tsx`
Expected: PASS. Then `bun run typecheck` — expected: clean. Making `roleName` optional must not have broken the two existing call sites (slot cards, recruit picker); if typecheck complains there, they were relying on it being required and need no change — they still pass it.

- [ ] **Step 7: Commit**

```bash
bun run fix
git add src/lib/nudge.ts src/lib/nudge.test.ts src/components/club/nudge-buttons.tsx src/components/club/nudge-buttons.test.tsx
git commit -m "feat(nudge): an attendance draft mode that names no role"
```

---

## Task 2: Panel derivation — buckets, sort, counts

The panel's two reviewable properties are its ORDER (chase-worthy first) and its COUNTS. Both are pure functions of the roster plus the plan rows, so they live in `lib/` where a test can assert them directly. A DOM assertion cannot see ordering when two rows render the same label, and cannot see a count that is right for the wrong reason.

**Files:**
- Create: `src/lib/attendance-panel.ts`
- Test: `src/lib/attendance-panel.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export type PlanStatus = "reached_out" | "coming" | "not_coming";
  export interface PanelMember {
  	id: string;
  	name: string;
  	preferredName?: string | null;
  	phone: string | null;
  	email: string | null;
  	status: PlanStatus | null;   // null = no answer
  	roleName: string | null;     // non-null ⇒ holds a slot, renders a role chip
  }
  export function buildPlanPanel(input: {
  	roster: Omit<PanelMember, "status" | "roleName">[];
  	plan: { memberId: string; status: PlanStatus }[];
  	roleByMemberId: Readonly<Record<string, string>>;
  }): { rows: PanelMember[]; counts: { coming: number; notComing: number; reachedOut: number; noAnswer: number }; countsLine: string };
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/attendance-panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPlanPanel } from "./attendance-panel";

const roster = [
	{ id: "d", name: "Dana", preferredName: null, phone: null, email: null },
	{ id: "a", name: "Ali", preferredName: null, phone: null, email: null },
	{ id: "c", name: "Cleo", preferredName: null, phone: null, email: null },
	{ id: "b", name: "Bo", preferredName: null, phone: null, email: null },
];

describe("buildPlanPanel", () => {
	it("sorts by how much chasing is left, then alphabetically", () => {
		// Spec D2: no answer → reached out → coming → not coming. The people you
		// still have to do something about are at the top; the settled answers sink.
		const { rows } = buildPlanPanel({
			roster,
			plan: [
				{ memberId: "a", status: "coming" },
				{ memberId: "b", status: "not_coming" },
				{ memberId: "c", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
	});

	it("orders alphabetically WITHIN a rung", () => {
		// Two members on the same rung, inserted in reverse alphabetical order —
		// the sort must be stable on name, not on input order.
		const { rows } = buildPlanPanel({
			roster: [
				{ id: "z", name: "Zoe", preferredName: null, phone: null, email: null },
				{ id: "a", name: "Ali", preferredName: null, phone: null, email: null },
			],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.name)).toEqual(["Ali", "Zoe"]);
	});

	it("counts every member exactly once, including no-answer", () => {
		const { counts, countsLine } = buildPlanPanel({
			roster,
			plan: [
				{ memberId: "a", status: "coming" },
				{ memberId: "b", status: "not_coming" },
				{ memberId: "c", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		expect(counts).toEqual({
			coming: 1,
			notComing: 1,
			reachedOut: 1,
			noAnswer: 1,
		});
		// The arithmetic check: a member cannot be dropped rather than bucketed.
		expect(
			counts.coming + counts.notComing + counts.reachedOut + counts.noAnswer,
		).toBe(roster.length);
		expect(countsLine).toBe("1 coming · 1 out · 1 asked · 1 no answer");
	});

	it("omits empty buckets from the counts line", () => {
		const { countsLine } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("1 no answer");
	});

	it("attaches the role a member holds, and does not reorder for it", () => {
		// Holding a role is INFORMATION on the row (spec D2: "assigned members
		// included, with a role chip"), not a bucket. A member with a role who has
		// not answered is still someone to chase.
		const { rows } = buildPlanPanel({
			roster,
			plan: [{ memberId: "a", status: "coming" }],
			roleByMemberId: { a: "Timer", d: "Toastmaster" },
		});
		expect(rows[0]).toMatchObject({ id: "b", roleName: null });
		expect(rows.find((r) => r.id === "d")).toMatchObject({
			roleName: "Toastmaster",
		});
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			roleName: "Timer",
			status: "coming",
		});
	});

	it("ignores a plan row for someone not on the roster", () => {
		// Inactive members are filtered out of the roster upstream, but their plan
		// rows survive in the table — a stale row must not resurrect a name.
		const { rows, counts } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [{ memberId: "ghost", status: "coming" }],
			roleByMemberId: {},
		});
		expect(rows).toHaveLength(1);
		expect(counts.coming).toBe(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/attendance-panel.test.ts`
Expected: FAIL — cannot resolve `./attendance-panel`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/attendance-panel.ts`:

```ts
// Pure derivation for the planned-attendance panel (spec D2). No React and no
// db, so the ORDER and the COUNTS — the two things a reviewer actually checks —
// are assertable directly. Through a rendered DOM neither is: two rows on the
// same rung render the same label, and a count can be right for the wrong
// reason.

/** The three stored rungs. `null` (no row) means "no answer" and is not a
 *  fourth value — see CONTEXT.md's Planned attendance entry. */
export type PlanStatus = "reached_out" | "coming" | "not_coming";

export interface PanelMember {
	id: string;
	name: string;
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	status: PlanStatus | null;
	/** Non-null when they hold a slot on this meeting — renders a role chip.
	 *  Information, never a bucket: a Toastmaster who has not replied is still
	 *  someone to chase. */
	roleName: string | null;
}

export interface PlanPanelCounts {
	coming: number;
	notComing: number;
	reachedOut: number;
	noAnswer: number;
}

/** Chase-worthy first. `null` sorts before every rung because "no answer" is
 *  the only state where nobody has done anything at all. */
const RUNG_ORDER: Record<string, number> = {
	null: 0,
	reached_out: 1,
	coming: 2,
	not_coming: 3,
};

export function buildPlanPanel(input: {
	roster: Omit<PanelMember, "status" | "roleName">[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Readonly<Record<string, string>>;
}): {
	rows: PanelMember[];
	counts: PlanPanelCounts;
	countsLine: string;
} {
	const byMember = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the plan rows: an inactive member is
	// filtered upstream but their plan row survives in the table, and iterating
	// the plan would resurrect the name.
	const rows: PanelMember[] = input.roster.map((m) => ({
		...m,
		status: byMember.get(m.id) ?? null,
		roleName: input.roleByMemberId[m.id] ?? null,
	}));

	rows.sort((a, b) => {
		const rung =
			(RUNG_ORDER[String(a.status)] ?? 0) - (RUNG_ORDER[String(b.status)] ?? 0);
		return rung !== 0 ? rung : a.name.localeCompare(b.name);
	});

	const counts: PlanPanelCounts = {
		coming: rows.filter((r) => r.status === "coming").length,
		notComing: rows.filter((r) => r.status === "not_coming").length,
		reachedOut: rows.filter((r) => r.status === "reached_out").length,
		noAnswer: rows.filter((r) => r.status === null).length,
	};

	// Empty buckets are omitted rather than rendered as "0 out" — the line is a
	// glance, and a zero is noise in a ~340px rail.
	const countsLine = (
		[
			[counts.coming, "coming"],
			[counts.notComing, "out"],
			[counts.reachedOut, "asked"],
			[counts.noAnswer, "no answer"],
		] as const
	)
		.filter(([n]) => n > 0)
		.map(([n, label]) => `${n} ${label}`)
		.join(" · ");

	return { rows, counts, countsLine };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/attendance-panel.test.ts` — expected: PASS (6 tests).
Run: `bun run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
bun run fix
git add src/lib/attendance-panel.ts src/lib/attendance-panel.test.ts
git commit -m "feat(attendance): pure bucket/sort/count derivation for the panel"
```

---

## Task 3: The payload carries one plan array

The panel needs each member's rung. `loadMeetingDetail` currently ships three separate id arrays (`unavailableMemberIds`, `contactedMemberIds`, `comingMemberIds`) built for the surfaces this PR deletes. Replace them with the shape the panel actually wants; the old arrays are removed in Task 6 once their last consumer is gone.

**Files:**
- Modify: `src/server/meetings.ts`
- Test: `src/server/meetings-plan-payload.integration.test.ts` (create)

**Interfaces:**
- Consumes: `listPlanForMeetings` from `src/server/attendance-plan-logic.ts` (already exists, already returns `{ memberId, meetingId, status }[]`)
- Produces: **two** arrays on the `loadMeetingDetail(...)` payload:
  - `plan: { memberId: string; status: PlanStatus }[]` — all three rungs, **admin-only** (`[]` when `!canManage`). Feeds the officer panel.
  - `answeredRungs: { memberId: string; status: "coming" | "not_coming" }[]` — **always populated**, never contains `reached_out`. Feeds the personal strip.

**Why two arrays and not one.** The strip has to show a member their OWN answer, and the server cannot resolve "my" — the viewing member is known only on the client (`useEffectiveMember`, route:288), which is how `myUnavailable` already works (`unavailableMemberIds.includes(myId)`, route:451). The anonymous roster pick is the dominant identity in this product, so a server-resolved `myPlanStatus` would be null for most users. The client therefore needs an array to filter, and that array must not carry `reached_out` — the officer's private record of having asked. One array with a per-rung filter was rejected: `plan` would then mean two different things depending on the caller, and a reader holding it could not tell which.

- [ ] **Step 1: Write the failing test**

Create `src/server/meetings-plan-payload.integration.test.ts`:

```ts
/**
 * The meeting payload carries the plan rungs the panel renders.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meetings-plan-payload.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { loadMeetingDetailForTest } = await import("#/server/meetings-logic");

describe.skipIf(!hasTestDb)("meeting payload plan rungs", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("carries every rung, not just the unavailable ones", async () => {
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "coming",
			actorMemberId: seed.memberId,
		});
		await setPlanStatus(testDb, {
			memberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});

		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: true,
		});
		expect(
			[...payload.plan].sort((a, b) => a.status.localeCompare(b.status)),
		).toEqual([
			{ memberId: seed.memberId, status: "coming" },
			{ memberId: seed.adminMemberId, status: "reached_out" },
		]);
	});

	it("withholds the full plan from a non-managing caller", async () => {
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
		const payload = await loadMeetingDetailForTest(seed.meetingId, {
			canManage: false,
		});
		expect(payload.plan).toEqual([]);
	});

	it("NEVER puts reached_out on the public array, for either caller", async () => {
		// THE invariant of the two-array split. The strip needs a public array to
		// filter by the client-known member id, and `reached_out` is the officer's
		// private record of having asked — it rides the same table as the member's
		// own answer, so nothing but an explicit filter keeps it off the public
		// payload. This is the guard against re-opening the leak PR 1 closed.
		await setPlanStatus(testDb, {
			memberId: seed.memberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "reached_out",
			actorMemberId: seed.adminMemberId,
		});
		await setPlanStatus(testDb, {
			memberId: seed.adminMemberId,
			meetingId: seed.meetingId,
			clubId: seed.clubId,
			status: "coming",
			actorMemberId: seed.adminMemberId,
		});

		for (const canManage of [true, false]) {
			const payload = await loadMeetingDetailForTest(seed.meetingId, {
				canManage,
			});
			// Anti-vacuity FIRST: an empty array satisfies "contains no
			// reached_out" for the wrong reason.
			expect(
				payload.answeredRungs.length,
				`answeredRungs was empty for canManage=${canManage}, so the assertion below proves nothing`,
			).toBe(1);
			expect(payload.answeredRungs).toEqual([
				{ memberId: seed.adminMemberId, status: "coming" },
			]);
			expect(payload.answeredRungs.map((r) => r.status)).not.toContain(
				"reached_out",
			);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meetings-plan-payload.integration.test.ts`
Expected: FAIL — `loadMeetingDetailForTest` is not exported.

- [ ] **Step 3: Expose the loader to tests**

`loadMeetingDetail` is a module-private function in `src/server/meetings.ts`, a `createServerFn` module — and `server-modules.guard.test.ts` forbids that module from exporting anything but server fns and types. So do NOT export it from there. Instead add a thin named export in the existing sibling `src/server/meetings-logic.ts`:

```ts
/** Test seam for the meeting payload. `loadMeetingDetail` lives in the
 *  server-fn module and cannot be exported from there (server-modules guard),
 *  and a `createServerFn` handler is unreachable from vitest — so the payload's
 *  shape would otherwise have no gate at all. */
export async function loadMeetingDetailForTest(
	meetingId: string,
	opts: { canManage: boolean },
): Promise<{ plan: { memberId: string; status: PlanStatus }[] }> {
	const plan = opts.canManage
		? (await listPlanForMeetings(db, [meetingId])).map(
				({ memberId, status }) => ({ memberId, status }),
			)
		: [];
	return { plan };
}
```

Import `listPlanForMeetings` and `type PlanStatus` (re-exported as `AttendancePlanStatus`) from `./attendance-plan-logic`, and `db` from `#/db`.

- [ ] **Step 4: Use the same derivation in the real loader**

In `src/server/meetings.ts`, inside `loadMeetingDetail`, beside the existing `comingMemberIds` block:

```ts
	const allRungs = (await listPlanForMeetings(db, [meetingId])).map(
		({ memberId, status }) => ({ memberId, status }),
	);
	// The whole ladder for the officer's panel. Admin-only for the same reason
	// `contactedMemberIds` was: `reached_out` is the officer's private record of
	// having asked, and it now shares one array with the member's own answer.
	const plan = canManage ? allRungs : [];
	// The members' OWN answers, public. The personal strip must show a member the
	// answer they gave, and the server cannot resolve "my" — the viewer is known
	// only on the client (route:288), which is why `myUnavailable` filters an
	// array today rather than reading a resolved field. `reached_out` is filtered
	// out HERE, once, rather than at each consumer.
	const answeredRungs = allRungs.filter(
		(r): r is { memberId: string; status: "coming" | "not_coming" } =>
			r.status !== "reached_out",
	);
```

Add both `plan` and `answeredRungs` to the returned object, next to `contactedMemberIds`. Add `listPlanForMeetings` to the existing `./attendance-plan-logic` import. `loadMeetingDetailForTest` must use the SAME two expressions — if it derives them differently it is testing itself.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meetings-plan-payload.integration.test.ts` — expected: PASS (2).
Run: `bunx vitest run src/server/server-modules.guard.test.ts` — expected: PASS (the new export is in `*-logic.ts`, not the server-fn module).
Run: `bun run typecheck` — expected: clean.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add src/server/meetings.ts src/server/meetings-logic.ts src/server/meetings-plan-payload.integration.test.ts
git commit -m "feat(server): carry the whole plan ladder on the meeting payload"
```

---

## Task 4: The panel component, plan mode

**Files:**
- Create: `src/components/club/meeting-attendance-panel.tsx`
- Test: `src/components/club/meeting-attendance-panel.test.tsx`

**Interfaces:**
- Consumes: `buildPlanPanel`, `PanelMember`, `PlanStatus` (Task 2); `NudgeButtons` with `mode="attendance"` (Task 1)
- Produces:
  ```tsx
  export function MeetingAttendancePanel(props: {
  	roster: Omit<PanelMember, "status" | "roleName">[];
  	plan: { memberId: string; status: PlanStatus }[];
  	/** Optimistic overrides from the route, keyed by member. A key present with
  	 *  value `null` means "optimistically cleared" — distinct from absent,
  	 *  which means "no override". */
  	rungOverride: Readonly<Record<string, PlanStatus | null>>;
  	roleByMemberId: Readonly<Record<string, string>>;
  	meetingDate: string;
  	shareUrl: string;
  	locked: boolean;
  	/** One writer for both directions; `null` clears. Two callbacks made the
  	 *  clear path a separate thing to remember at every call site. */
  	onWriteRung: (
  		memberId: string,
  		next: PlanStatus | null,
  	) => void | Promise<void>;
  	onContacted: (memberId: string) => void | Promise<void>;
  }): JSX.Element
  ```

  The component applies the override before calling `buildPlanPanel`, so sort
  and counts both reflect the optimistic state and a chip does not jump rows a
  beat after it is tapped:

  ```ts
  const effectivePlan = roster
  	.map((m) => ({
  		memberId: m.id,
  		status:
  			rungOverride[m.id] !== undefined
  				? rungOverride[m.id]
  				: (plan.find((p) => p.memberId === m.id)?.status ?? null),
  	}))
  	.filter((p): p is { memberId: string; status: PlanStatus } => p.status !== null);
  ```

- [ ] **Step 1: Write the failing test**

Create `src/components/club/meeting-attendance-panel.test.tsx`:

```tsx
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAttendancePanel } from "./meeting-attendance-panel";

const roster = [
	{
		id: "m1",
		name: "Ayesha Khan",
		preferredName: null,
		phone: "+15551234567",
		email: null,
	},
	{ id: "m2", name: "Bo Lin", preferredName: null, phone: null, email: null },
];

function renderPanel(over: Partial<Parameters<typeof MeetingAttendancePanel>[0]> = {}) {
	const props = {
		roster,
		plan: [],
		rungOverride: {},
		roleByMemberId: {},
		meetingDate: "Tue 19 Aug",
		shareUrl: "https://club.example/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		...over,
	};
	return { props, ...render(<MeetingAttendancePanel {...props} />) };
}

describe("MeetingAttendancePanel (plan mode)", () => {
	afterEach(() => cleanup());

	it("lists the whole roster with its counts line", () => {
		const { getByText } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		expect(getByText("Ayesha Khan")).toBeTruthy();
		expect(getByText("Bo Lin")).toBeTruthy();
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("sets a rung through the row's dropdown", async () => {
		const { props, getByRole, findByRole } = renderPanel();
		fireEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "Coming" }));
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", "coming");
	});

	it("clears back to no answer through the same menu", async () => {
		const { props, getByRole, findByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		fireEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "No answer" }));
		// Clearing is a DELETE, not a fourth status — the row's absence is the
		// only encoding of "no answer". `null` is how the single writer says so.
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", null);
	});

	it("disables the chips on a locked meeting rather than hiding them", () => {
		// Spec, Error handling: a control that vanishes reads as a bug; a disabled
		// one reads as "not now".
		const { getByRole } = renderPanel({ locked: true });
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("offers a WhatsApp draft when a phone is on file, and says so when not", () => {
		const { getByText, getAllByRole } = renderPanel();
		expect(getAllByRole("link").length).toBeGreaterThan(0);
		expect(getByText(/No contact on file/i)).toBeTruthy();
	});

	it("shows the role a member holds", () => {
		const { getByText } = renderPanel({ roleByMemberId: { m2: "Timer" } });
		expect(getByText("Timer")).toBeTruthy();
	});

	it("renders the optimistic override, not the server value", () => {
		// The whole point of the optimistic path: the chip changes on tap, before
		// any server round trip. Rendering `plan` here would show the stale rung
		// and the officer would tap twice.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "not_coming" as const }],
			rungOverride: { m1: "coming" as const },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("Coming");
	});

	it("treats an override of null as cleared, not as absent", () => {
		// `null` and "no key" are different states and `??` cannot tell them
		// apart — an optimistic CLEAR would fall through to the server's old rung
		// and the chip would appear not to have changed.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
			rungOverride: { m1: null },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("—");
	});

	it("counts and sorts on the optimistic state too", () => {
		// Otherwise the counts line disagrees with the chips for a beat, and the
		// row jumps to its new bucket only after the refetch.
		const { getByText } = renderPanel({
			plan: [],
			rungOverride: { m1: "coming" as const },
		});
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("collapses to the counts line below lg, and expands on tap", () => {
		// Spec D4: in plan mode on mobile the panel renders collapsed, so a
		// 15-person roster does not push the agenda off screen. The rows are
		// absent from the DOM when collapsed rather than merely hidden — a
		// `hidden` class is invisible to this assertion and to a screen reader.
		const { getByRole, queryByText, getByText } = renderPanel();
		expect(getByText("2 no answer")).toBeTruthy();
		expect(queryByText("Ayesha Khan")).toBeNull();
		fireEvent.click(getByRole("button", { name: /show|expand/i }));
		expect(getByText("Ayesha Khan")).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/club/meeting-attendance-panel.test.tsx`
Expected: FAIL — cannot resolve `./meeting-attendance-panel`.

- [ ] **Step 3: Write the component**

Create `src/components/club/meeting-attendance-panel.tsx`. Key points, all load-bearing:

```tsx
import { useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	buildPlanPanel,
	type PanelMember,
	type PlanStatus,
} from "#/lib/attendance-panel";

/** Chip copy. "No answer" is the ABSENCE of a row, so choosing it clears. */
const RUNG_LABELS: Record<PlanStatus, string> = {
	reached_out: "Asked",
	coming: "Coming",
	not_coming: "Not coming",
};

const MENU: { label: string; status: PlanStatus | null }[] = [
	{ label: "No answer", status: null },
	{ label: "Asked", status: "reached_out" },
	{ label: "Coming", status: "coming" },
	{ label: "Not coming", status: "not_coming" },
];
```

The panel body renders `<Card>` with the title "Planned attendance", the `countsLine`, then one row per `rows` entry. Each row:

- The name, truncating (`truncate` + `min-w-0` on the flex child — without `min-w-0` a flex item refuses to shrink below its content and the row overflows the ~340px rail).
- A `DropdownMenu` whose trigger is `<Button variant="outline" size="sm" disabled={locked} aria-label={`${m.name} status`}>` showing `m.status ? RUNG_LABELS[m.status] : "—"`. The `aria-label` is what the tests query and what a screen reader reads; the visible text alone is ambiguous across rows.
- Every menu item calls `onWriteRung(m.id, status)` — including "No answer", which passes `null`. One writer, both directions.
- `<NudgeButtons mode="attendance" … onContacted={() => onContacted(m.id)} />` with no `roleName`.
- `{m.roleName ? <Badge variant="secondary">{m.roleName}</Badge> : null}`.

Per-row in-flight state uses the `pendingId` pattern lifted from `OutreachPanel` (a single `useState<string|null>`, set before the await and cleared in a `finally`), which guards a rapid double-tap on one member. It is a BUSY guard, not the optimism — the chip's displayed value comes from `rungOverride`, which the route owns.

**Mobile collapse (spec D4).** Below `lg`, plan mode renders collapsed to the counts line so a 15-person roster does not push the agenda off screen; roll mode (PR 3) will render expanded. Implement with a `useState(false)` for `expanded` and render the row list only when `expanded || isDesktop`, where `isDesktop` is a `lg:` presentational split — **two renders of the header, one `lg:hidden` with a toggle button and one `hidden lg:block` without**, rather than a CSS `hidden` on the list. The rows must be ABSENT from the DOM when collapsed, not merely invisible: a `hidden` class still ships 15 members' names to a screen reader and to the test above, so the collapse would be untestable and only half-real.

Do **not** use `<DropdownMenuItem asChild>` with an anchor — #541's link-color split. These items are buttons.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/components/club/meeting-attendance-panel.test.tsx` — expected: PASS (6).
Run: `bun run typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
bun run fix
git add src/components/club/meeting-attendance-panel.tsx src/components/club/meeting-attendance-panel.test.tsx
git commit -m "feat(attendance): the planned-attendance panel in plan mode"
```

---

## Task 5: Route wiring, rail and stacked layout

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Test: `src/routes/attendance-panel-wiring.guard.test.ts` (create)

**Interfaces:**
- Consumes: `MeetingAttendancePanel` (Task 4), `plan` on the payload (Task 3), `meetingPhase` from `#/lib/meeting-lifecycle`
- Produces: the panel rendered in plan mode only; write handlers calling `setPlannedAttendance` / `clearPlannedAttendance`.

- [ ] **Step 1: Use the mode the route ALREADY computes**

**Do not add a `meetingPhase` call.** `const phase = meetingPhase({...})` already exists at `club.$clubId.meeting.$meetingId.tsx:356`, and `meetingPhase` is already in the `#/lib/meeting-lifecycle` import block (line ~66). Adding a second call is not merely redundant: route:346 documents *"ONE clock for the whole render — every phase/freeze/completability"*, and the `now` at line 355 is deliberately a single frozen value. A second call written with an inline `new Date()` would let two components on one page disagree about the club-local day across midnight.

Add ONE line, beside the other gates:

```ts
	// Spec D2: plan mode is the EXISTING phase, reusing the route's frozen clock.
	// PR 2 ships plan mode only — roll mode (`today` / `completed`) is PR 3, so
	// the panel simply does not render outside `upcoming` yet.
	const showPlanPanel = effectiveCanManage && phase === "upcoming";
```

Then lift the role map so both the agenda and the panel read ONE derivation. It lives at `meeting-agenda.tsx:220-222` today, inside the component, and the panel renders in the route as a sibling — so it is out of scope there. Move it up rather than deriving it twice: a second copy silently disagrees the moment `slotLabel` changes.

```ts
	// Lifted from <MeetingAgenda> so the agenda and the panel share one map.
	const roleCounts = buildRoleCounts(slots);
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}
```

`buildRoleCounts` and `slotLabel` are already exported from `#/lib/agenda`. Delete the loop from `meeting-agenda.tsx` and take `roleByMemberId` as a prop there instead.

- [ ] **Step 2: Add the write handlers — OPTIMISTIC, with rollback**

The spec's Error handling says *"optimistic per-row update with rollback and a toast on failure"*. `await` + `router.invalidate()` is neither: it refetches the whole meeting payload — slots, roster, minutes, action items — for one chip, and an officer chasing a 15-person roster pays that per tap on a ~340px rail. `pendingId` is a busy guard, not optimism.

Hold an override map in the route and let the panel render `override ?? server`:

```ts
	// Optimistic rung overrides, keyed by member. `undefined` = no override, so
	// a member can be optimistically cleared to `null` and still be
	// distinguishable from "not touched" — which `??` alone cannot express.
	const [rungOverride, setRungOverride] = useState<
		Record<string, PlanStatus | null>
	>({});

	async function writeRung(memberId: string, next: PlanStatus | null) {
		const previous = plan.find((p) => p.memberId === memberId)?.status ?? null;
		setRungOverride((o) => ({ ...o, [memberId]: next }));
		try {
			await (next === null
				? clearPlannedAttendance({ data: { memberId, meetingId: meeting.id } })
				: setPlannedAttendance({
						data: { memberId, meetingId: meeting.id, status: next },
					}));
		} catch (e) {
			// Roll back to what the server last told us, not to `null` — reverting
			// to empty would silently erase a rung the officer did not touch.
			setRungOverride((o) => ({ ...o, [memberId]: previous }));
			toast.error(e instanceof Error ? e.message : "Couldn't save that.");
		}
	}
```

Import both server fns from `#/server/attendance-plan`. The payload takes **no `clubId`** — the server derives it from the meeting (#396); do not add one.

Drop the override for a member once the server payload agrees, so the map cannot grow unboundedly across a long session:

```ts
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the
	// server payload only — including `rungOverride` would re-run on every write.
	useEffect(() => {
		setRungOverride((o) => {
			const next = { ...o };
			let changed = false;
			for (const [memberId, value] of Object.entries(o)) {
				const server =
					plan.find((p) => p.memberId === memberId)?.status ?? null;
				if (server === value) {
					delete next[memberId];
					changed = true;
				}
			}
			return changed ? next : o;
		});
	}, [plan]);
```

`onContacted` advances no-answer → reached out and must **not** touch a member who already answered (spec D5). Read through the override so a chip set a moment ago counts:

```ts
	async function markAsked(memberId: string) {
		const current =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (plan.find((p) => p.memberId === memberId)?.status ?? null);
		if (current !== null) return;
		await writeRung(memberId, "reached_out");
	}
```

- [ ] **Step 3: Render it in the rail**

Wrap the existing body in the two-column layout. At `≥ lg` the agenda takes the left column and the panel a sticky ~340px right rail; below `lg` the panel is a card above the roles list:

```tsx
<div className="lg:flex lg:items-start lg:gap-6">
	<div className="min-w-0 flex-1 space-y-5">{/* existing agenda body */}</div>
	{showPlanPanel ? (
		<aside className="mt-5 lg:mt-0 lg:sticky lg:top-24 lg:w-[340px] lg:shrink-0">
			<MeetingAttendancePanel
				roster={roster}
				plan={plan}
				rungOverride={rungOverride}
				roleByMemberId={roleByMemberId}
				meetingDate={nudgeDate}
				shareUrl={nudgeShareUrl}
				locked={locked}
				onWriteRung={writeRung}
				onContacted={markAsked}
			/>
		</aside>
	) : null}
</div>
```

`min-w-0` on the left column is required — without it the flex child will not shrink and the agenda pushes the rail off screen.

Note `nudgeShareUrl` (route:445) and `nudgeDate` (route:450) already exist and feed the slot cards' drafts; reuse them rather than deriving a second date or URL. The route does NOT have `shareUrl` or a `formatCalendarDay` call.

- [ ] **Step 4: Write the wiring guard**

The meeting route cannot mount in jsdom (loader + server fns), so nothing in the suite observes these expressions. Mirror `meeting-chrome-wiring.guard.test.ts`.

Create `src/routes/attendance-panel-wiring.guard.test.ts`:

```ts
// Route→component wiring pins for the planned-attendance panel (PR 2).
//
// `club.$clubId.meeting.$meetingId.tsx` cannot be rendered in jsdom, so the
// panel is tested exhaustively THROUGH its props and structurally cannot see a
// wrong one (#319). Every prop pinned here is same-typed with a plausible wrong
// expression, so a swap type-checks and lints clean.
//
// COMMENT-BLIND (`readSource`): all assertions are "must BE present", and this
// header quotes the patterns it checks for.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("attendance panel route wiring (PR 2)", () => {
	const src = readSource(ROUTE);

	it("gates the panel on the phase, not on the over/locked flags", () => {
		// `over`, `locked` and `canComplete` are all booleans in scope here. Only
		// `phase === "upcoming"` is plan mode: `canComplete` is TRUE on meeting day
		// and would keep the plan panel up into roll territory, and `over` is false
		// all through meeting day and would do the opposite.
		expect(src).toContain('phase === "upcoming"');
		expect(src).toContain("effectiveCanManage && phase");
	});

	it("computes the phase exactly once, on the route's frozen clock", () => {
		// route:346 documents ONE clock for the whole render. A second
		// `meetingPhase(` call — especially one with an inline `new Date()` — lets
		// two components disagree about the club-local day across midnight.
		expect(src.split("meetingPhase({").length - 1).toBe(1);
	});

	it("reads the member's own rung from the PUBLIC array", () => {
		// `plan` is admin-only, so filtering it for `myId` reads null forever for
		// a plain member: they answer, the page reloads, and the strip asks again.
		expect(src).toContain("answeredRungs.find");
		expect(src).not.toContain("plan.find((p) => p.memberId === myId)");
	});

	it("hides the panel from preview-as-member", () => {
		// `effectiveCanManage`, never bare `canManage` — #320 drops management
		// everywhere it gates admin UI.
		expect(src).toContain("const showPlanPanel = effectiveCanManage");
	});

	it("passes the plan array and the roster, not the legacy id arrays", () => {
		expect(src).toContain("plan={plan}");
		expect(src).toContain("roster={roster}");
	});

	it("keeps the agenda column shrinkable so the rail cannot be pushed off", () => {
		expect(src).toContain("min-w-0 flex-1");
	});
});
```

- [ ] **Step 5: Run everything**

Run: `bunx vitest run src/routes/attendance-panel-wiring.guard.test.ts` — expected: PASS (4).
Run: `bun run typecheck` — expected: clean.
Run: `TEST_DATABASE_URL=… bun run test` — expected: all green.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/attendance-panel-wiring.guard.test.ts
git commit -m "feat(meeting): render the planned-attendance panel in a sticky rail"
```

---

## Task 6: Delete the absorbed surfaces

Both surfaces the panel replaces must go in the same PR — leaving them shows the same facts twice, in two orders, with two write paths.

**Files:**
- Delete: `src/components/club/outreach-panel.tsx`, `src/components/club/outreach-panel.test.tsx`
- Modify: `src/components/agenda/meeting-agenda.tsx`
- Modify: `src/server/meetings.ts` (drop the three now-unused arrays)
- Test: `src/components/club/absorbed-surfaces.guard.test.ts` (create)

**Interfaces:**
- Consumes: the panel rendering from Task 5
- Produces: `OutreachPanel` gone; `unavailableMemberIds` / `contactedMemberIds` / `comingMemberIds` gone from the payload and from `MeetingAgendaProps`.

- [ ] **Step 1: Write the deletion guard first**

Create `src/components/club/absorbed-surfaces.guard.test.ts`:

```ts
// The panel ABSORBED two surfaces (spec, "Surfaces absorbed"). Deleting a file
// is easy to do halfway: the component goes and a stale import, a dead prop or
// the second copy of the same list stays behind, and the officer sees the same
// members twice in two different orders.
//
// Read RAW: these are "must be ABSENT" assertions, and comment-stripping could
// only ever loosen them.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("surfaces absorbed by the planned-attendance panel", () => {
	it("OutreachPanel is gone", () => {
		expect(existsSync(resolve(ROOT, "src/components/club/outreach-panel.tsx"))).toBe(
			false,
		);
	});

	it("nothing still imports or renders it", () => {
		const agenda = readFileSync(
			resolve(ROOT, "src/components/agenda/meeting-agenda.tsx"),
			"utf8",
		);
		expect(agenda).not.toContain("OutreachPanel");
		expect(agenda).not.toContain("deriveOutreach");
	});

	it("the 'Not available this week' section is gone", () => {
		const agenda = readFileSync(
			resolve(ROOT, "src/components/agenda/meeting-agenda.tsx"),
			"utf8",
		);
		expect(agenda).not.toContain("Not available this week");
	});

	it("the payload no longer ships the three id arrays the panel replaced", () => {
		const meetings = readFileSync(resolve(ROOT, "src/server/meetings.ts"), "utf8");
		for (const dead of [
			"unavailableMemberIds",
			"contactedMemberIds",
			"comingMemberIds",
		]) {
			expect(meetings, `${dead} is dead once the panel owns this`).not.toContain(
				dead,
			);
		}
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/club/absorbed-surfaces.guard.test.ts`
Expected: FAIL on all four — nothing is deleted yet.

- [ ] **Step 3: Delete**

```bash
git rm src/components/club/outreach-panel.tsx src/components/club/outreach-panel.test.tsx
```

In `src/components/agenda/meeting-agenda.tsx`: delete the `OutreachPanel` import, the `{showPlanningPanels ? <OutreachPanel …/> : null}` block (line ~443), and the whole `{showPlanningPanels && unavailableMembers.length > 0 ? <section>…Not available this week…</section> : null}` block (line ~425). Then remove every prop that fed only those two — `contactedMemberIds`, `comingMemberIds`, `unavailableMemberIds`, `unavailableMembers`, `onContacted`, `onUncontacted` — from `MeetingAgendaProps` and from the destructure, and delete the now-unused handlers in the route.

**Two symbols go orphan when those blocks do**, and strict TS's no-unused-locals will catch them but the plan should not leave it to chance:

- `showPlanningPanels` (`meeting-agenda.tsx:232`, `viewer.canManage && !meetingOver`) gated ONLY those two blocks. Delete it. Its job moved to the route's `showPlanPanel`, which gates on the phase rather than on `!meetingOver` — a deliberate narrowing, since `!meetingOver` is still true all through meeting day.
- `meetingOver` may lose its last consumer with it. Grep before deleting; it likely has others.

`roleByMemberId` is NOT this task's business — Task 5 Step 1 already lifted its derivation to the route and converted it to a prop here. Leave it alone.

In `src/server/meetings.ts`: delete the `unavailableMemberIds`, `contactedMemberIds` and `comingMemberIds` payload fields and the loaders that fed only them (`listNotComingWithNames` stays only if another consumer remains — check with a grep; `listReachedOutForMeeting` and `listComingForMeeting` become unused and their seam exports can stay, since the seam is allowed to hold unused readers PR 3 will want).

- [ ] **Step 4: Run the full suite and follow the failures**

Run: `TEST_DATABASE_URL=… bun run test`
Expected: several unrelated suites fail because they asserted the deleted props. For each: if it tested a behaviour the panel now owns, move the assertion to `meeting-attendance-panel.test.tsx`; if it tested the deleted surface itself, delete it. Do not weaken an assertion to make it pass.
Run: `bun run typecheck` — expected: clean; it catches every stale prop.

- [ ] **Step 5: Commit**

```bash
bun run fix
git add -A src/
git commit -m "refactor(meeting): absorb OutreachPanel and the not-available list into the panel"
```

---

## Task 7: "I'll be there" on the personal strip

The strip today offers only "I can't make this one". The ladder can hold the positive answer, so the member gets to give it (spec D6).

**Files:**
- Modify: `src/components/club/meeting-personal-strip.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Test: `src/components/club/meeting-personal-strip.test.tsx`

**Interfaces:**
- Consumes: `setRung` / `clearRung` from Task 5
- Produces: `MeetingPersonalStrip` takes `myStatus: PlanStatus | null` and `onSetStatus: (s: PlanStatus | null) => void`, replacing `myUnavailable` / `onToggleAvailability`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/club/meeting-personal-strip.test.tsx`:

```tsx
it("offers both answers, and never the officer-only rung", () => {
	const onSetStatus = vi.fn();
	const { getByRole, queryByRole } = render(
		<MeetingPersonalStrip
			source="anon"
			member={{ id: "m1", name: "Ayesha" } as never}
			promptIdentity={() => {}}
			over={false}
			myStatus={null}
			availBusy={false}
			canToggleAvailability={true}
			onSetStatus={onSetStatus}
		/>,
	);
	fireEvent.click(getByRole("button", { name: "I'll be there" }));
	expect(onSetStatus).toHaveBeenCalledWith("coming");
	// `reached_out` is an officer's record of having asked. A member offering it
	// about themselves is nonsense, and the server rejects it.
	expect(queryByRole("button", { name: /asked/i })).toBeNull();
});

it("lets you take back an answer you already gave", () => {
	const onSetStatus = vi.fn();
	const { getByRole } = render(
		<MeetingPersonalStrip
			source="anon"
			member={{ id: "m1", name: "Ayesha" } as never}
			promptIdentity={() => {}}
			over={false}
			myStatus="coming"
			availBusy={false}
			canToggleAvailability={true}
			onSetStatus={onSetStatus}
		/>,
	);
	fireEvent.click(getByRole("button", { name: /undo/i }));
	expect(onSetStatus).toHaveBeenCalledWith(null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx`
Expected: FAIL — `myStatus` is not a prop.

- [ ] **Step 3: Replace the boolean with the rung**

Swap `myUnavailable: boolean` for `myStatus: PlanStatus | null` and `onToggleAvailability: () => void` for `onSetStatus: (s: PlanStatus | null) => void`. Render two buttons when `myStatus === null` ("I'll be there" → `"coming"`, "I can't make this one" → `"not_coming"`), and a single confirmation with an undo (→ `null`) once an answer exists. Keep the existing `availBusy` disable and the `canToggleAvailability` gate untouched.

- [ ] **Step 4: Wire the route from the PUBLIC array**

```ts
	const myStatus = myId
		? (answeredRungs.find((r) => r.memberId === myId)?.status ?? null)
		: null;
```

and `onSetStatus={(s) => myId && writeRung(myId, s)}`.

**Read `answeredRungs`, never `plan`.** `plan` is admin-only (Task 3), so a plain member's copy is `[]` and their own rung would read `null` forever — they would answer, the page would reload, and the strip would offer the question again. This mirrors `myUnavailable` at route:451 exactly: a public array filtered by the client-known `myId`, because the server cannot resolve "my" for an anonymous roster pick.

Do NOT add a server-resolved `myPlanStatus`. It cannot work for the dominant identity path, and the tempting repair — widening `plan` to everyone — publishes the officer-only `reached_out` rung.

The strip must also apply `rungOverride` so the member's own tap is instant, same as the panel's chips:

```ts
	const myEffectiveStatus =
		myId && rungOverride[myId] !== undefined ? rungOverride[myId] : myStatus;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx` — expected: PASS.
Run: `bun run typecheck` — expected: clean.

- [ ] **Step 6: Commit**

```bash
bun run fix
git add src/components/club/meeting-personal-strip.tsx src/components/club/meeting-personal-strip.test.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx src/server/meetings.ts
git commit -m "feat(meeting): let a member say they'll be there, not only that they can't"
```

---

## Task 8: Full verification

- [ ] **Step 1: Every gate, in CI's form**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
bun run typecheck
bunx biome check src/ --diagnostic-level=error
bun run build
bun run db:generate   # MUST report "No schema changes" — this PR adds no migration
```

- [ ] **Step 2: Confirm the two guards can actually fail**

A guard that cannot fail is worse than none. Verify each by mutation, then restore:

```bash
# Wiring guard: swap the phase gate for the plausible wrong flag.
sed -i '' 's/phase === "upcoming"/canComplete/' src/routes/club.\$clubId.meeting.\$meetingId.tsx
bunx vitest run src/routes/attendance-panel-wiring.guard.test.ts   # expect FAIL
git checkout -- src/routes/club.\$clubId.meeting.\$meetingId.tsx

# Deletion guard: put the dead prop back.
# (append `unavailableMemberIds,` to the payload in src/server/meetings.ts)
bunx vitest run src/components/club/absorbed-surfaces.guard.test.ts  # expect FAIL
git checkout -- src/server/meetings.ts
```

- [ ] **Step 3: Manual pass against a real club**

`bun run dev`, then on an **upcoming** meeting as an officer: the rail shows every active member with no-answer first; setting a rung persists across reload; the counts line adds up to the roster size; WhatsApp on a no-answer member flips them to Asked and does **not** flip a member already Coming. On a **today** or **completed** meeting the panel is absent (roll mode is PR 3) and the Minutes attendance section is unchanged. At `<lg` the panel is collapsed to its counts line above the roles list.

- [ ] **Step 4: Ship**

Run `/review` for the adversarial pass, then `/ship`. Expect a MINOR bump (new user-facing surface).

---

## Self-Review

**Spec coverage.** D2 modes → Task 5 (plan mode only; roll mode is PR 3 by the spec's own delivery split). D4 placement → Task 5 Step 3. D5 row anatomy and contact → Tasks 1 and 4. D6 who can write → the server fns shipped in v1.14.0.0; the member half is Task 7, and the panel is officer-gated in Task 5. Surfaces absorbed → Task 6. Testing #4 (mode boundary in a non-UTC timezone) is already covered by the existing `meeting-lifecycle` suite for `meetingPhase`, so no new task; testing #5 (route wiring guard) → Task 5 Step 4; #7 (deletions) → Task 6 Step 1; #8 (authz) shipped with PR 1. Testing #1 (the seven-module sweep), #2 (plan never becomes a record), #3 (backfill) and #6 (offline) belong to PR 1 (shipped) and PR 3 (roll mode) respectively.

**Deliberately deferred to PR 3, per the spec:** roll mode, the dashed suggestion rendering, the guests group, deleting the Minutes `AttendanceSection`, and lifting the #176 offline queue into `useMinutesOfflineQueue`. Plan-mode writes are online-only.

**One risk flagged during writing:** the payload's `plan` array is admin-only, which would leave a plain member's own rung reading `null` forever on the personal strip — the #319 class, type-clean and silently wrong. The first draft resolved it with a server-side `myPlanStatus`; `/plan-eng-review` found that impossible (the viewer is client-side only) and it became the public `answeredRungs` array. See the report below.

---

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|---|---|---|---|
| Eng Review (plan) | 1 | COMPLETE | 8 (1 P1, 4 P2, 3 P3) — all resolved into the plan |
| Scope challenge | 1 | TRIGGERED (18 files) | Proceed as-is, all 8 tasks — user decision |
| Outside voice | 0 | SKIPPED | Codex disabled in this repo (no OpenAI credentials) |

**Findings and resolutions**

| # | Sev | Conf | Finding | Resolution |
|---|---|---|---|---|
| A1 | P1 | 9/10 | `myPlanStatus` cannot be resolved server-side: the viewer is known only on the client (`useEffectiveMember`, route:288); `myUnavailable` filters an array at route:451. The tempting repair — widening `plan` — leaks the officer-only `reached_out`. | Task 3 now ships TWO arrays: admin-only `plan` (all rungs) and public `answeredRungs` (`coming`/`not_coming` only). Task 7 reads the public one. New payload test asserts `reached_out` never appears on it, for either caller, with an anti-vacuity length check first. |
| A2 | P2 | 9/10 | The panel renders in the route (for the rail) but `roleByMemberId` is derived inside `MeetingAgenda` (line 220). | Task 5 Step 1 lifts the derivation to the route; Task 6 deletes the component-local copy and takes it as a prop. One derivation, two consumers. |
| P1 | P2 | 8/10 | Plan contradicted the spec: spec asks for optimistic-with-rollback, plan did `await` + `router.invalidate()` — a full meeting-payload refetch per chip, on a 15-person chase. | Task 5 Step 2 rewritten optimistic: a `rungOverride` map in the route, rollback to the previous SERVER value on failure, and an effect that drops an override once the payload agrees. Three new panel tests cover override rendering, `null`-vs-absent, and counts/sort on optimistic state. |
| Q1 | P2 | 10/10 | Task 5 added a second `meetingPhase({...})`; route:356 already computes it on the frozen `now`, and route:346 documents "ONE clock for the whole render". | Step 1 rewritten to reuse it, with the reason stated. Wiring guard now asserts exactly one `meetingPhase({` in the route. |
| T1 | P2 | 9/10 | D4's mobile collapse was a placeholder ("add it if not already present") with no test — the TBD pattern `writing-plans` forbids. | Specified concretely in Task 4: two header renders (`lg:hidden` with toggle, `hidden lg:block` without) and rows ABSENT from the DOM when collapsed, not `hidden`. New test asserts collapse and expand. |
| T2 | P2 | 9/10 | Nothing guarded `reached_out` staying off the public payload — load-bearing once A1 introduced two arrays. | Covered by the new Task 3 test above. |
| Q2 | P3 | 10/10 | Wrong identifiers: plan used `shareUrl` / `formatCalendarDay`; route has `nudgeShareUrl` (445) and `nudgeDate` (450). | Corrected in Task 5 Step 3, with a note not to derive a second date or URL. |
| Q3 | P3 | 8/10 | `showPlanningPanels` (`meeting-agenda.tsx:232`) gates only the two deleted surfaces and goes orphan; `meetingOver` may follow. | Task 6 now names both, and explains that the gate narrowed deliberately (phase, not `!meetingOver`). |

**VERDICT: APPROVED WITH CHANGES — all eight findings resolved into the plan; ready for `subagent-driven-development`.**

The plan changed materially in three places (Tasks 3, 5, 7). Anyone who read the pre-review version should re-read those before implementing.

NO UNRESOLVED DECISIONS
