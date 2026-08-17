# Planned Attendance PR 3 — Roll Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On meeting day the attendance panel becomes the roll-call surface — real `meeting_attendance` rows, seeded as dashed *suggestions* from the plan — and the Minutes card's `AttendanceSection` is absorbed into it and deleted.

**Architecture:** The panel gains a `mode` of `"plan" | "roll"`, derived from the phase the route already computes. Roll mode writes `meeting_attendance` through the server fns the Minutes card already uses (`setAttendance` / `addMinutesGuest` / `removeMinutesGuest`), so no new write surface and no schema change. The offline queue that currently lives inside `MeetingMinutes` is lifted into a shared hook FIRST, because absorbing the section without it would silently drop offline roll call — a shipped capability (#176). A second pure derivation module (`buildRollPanel`) handles roll's rows, alphabetical sort and counts, mirroring `buildPlanPanel`.

**Tech Stack:** TanStack Start (React 19, SSR via Nitro) · TanStack Query · Drizzle ORM on Postgres (node-postgres) · shadcn/ui + Tailwind v4 · Vitest · Biome · TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-08-11-planned-attendance-design.md` — D2 (mode table), D3 (suggestion rendering), D4 (placement), the "PR 3 — roll mode" scope at line 293, and the Error handling / Testing sections. Read the spec before Task 1; this plan argues from it.

**Shipped already, do not rebuild:** the data model (v1.14.0.0), the panel in plan mode (v1.15.0.0), the Toastmaster's access to plan mode (v1.16.0.0).

## Global Constraints

- **The test DB is on port 5433 on this machine, and a wrong port reads as GREEN.** Every
  `TEST_DATABASE_URL` in this plan says `localhost:5433/tm_test`. It said 5432 (the value in
  CLAUDE.md, correct on the Linux box this repo is usually developed on) until mid-execution:
  here 5432 is a different project's port-forward that is OPEN but rejects the `dev` password,
  so `hasTestDb` comes back false and every `describe.skipIf` suite SKIPS. The run then reports
  a pass with ~630 tests silently absent. So do not just run the command — after any run that
  is supposed to include an integration suite, confirm from the output that those tests
  actually RAN. A skip count where you expected assertions is a failed run, not a green one.
- **No schema change.** D3 works because `getMinutes` already reports `status: null` for a member with no attendance row, so "suggested" IS "no row yet". If a task appears to need a migration, stop — the design is wrong, not the schema.
- Roll counts report **real rows only**. `3 unmarked` means three rows nobody confirmed, whatever their plan said. A dashed suggestion is never counted as present.
- Roll-mode sort is **alphabetical**. The plan ladder's chase-worthy-first order is plan mode only.
- Contact (WhatsApp/Email) **survives into `today`** and is hidden once `completed`. Spec: "the Timer hasn't arrived and we start in ten minutes" is the most urgent message a VPE sends, and it is exactly when the panel is on screen.
- Guests appear in **roll mode only**. Pre-meeting guest expectation is out of scope (ADR-0018 owns the pipeline).
- `preview-as-member` hides the panel entirely, as every other officer surface does.
- Every write keeps the existing optimistic-with-rollback + `pendingId` busy guard. A locked meeting renders chips **disabled, not missing**.
- Vitest, never `bun test`. Integration suites need `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"` exported or ~630 tests skip while the run still reads green.
- Lint gate is CI's **bare** invocation: `bun run check --diagnostic-level=error` (618 files). `biome check src/` covers fewer files and hid a failure on v1.16.0.0.
- Coverage target 85% against the diff; minimum 60.

---

## Decisions this plan makes that the spec does not

The spec was written on 2026-08-11, before the Toastmaster gained access (v1.16.0.0). Three questions it therefore cannot answer. Each is settled here with its reason, so an implementer does not have to guess and a reviewer can disagree with the decision rather than the code.

### DP1 — Roll mode is officer-only, which is NARROWER than plan mode

Counterintuitive and load-bearing. Plan mode admits a club officer **or this meeting's Toastmaster** (v1.16.0.0). Roll mode admits **only a signed-in club admin**, because both halves of it are already gated that way and this plan does not widen them:

- `setAttendance` / `addMinutesGuest` / `removeMinutesGuest` → `gateAdmin` (`src/server/minutes.ts:107`) → `requireUser()` + `requireClubRole(…, ["admin"])`.
- `getMinutes` is only reached for a signed-in member: the route calls it behind `context.shell`, and an anonymous visitor gets `EMPTY_MINUTES`.

So a Toastmaster who identified by roster pick has no attendance rows to render and no write that would succeed. Rendering roll mode for them would produce a panel of "Unmarked" rows whose every tap 403s — exactly the "buttons that only error" failure the existing comment at `meeting-minutes.tsx:355` warns about.

**What a Toastmaster sees on meeting day: nothing.** The panel is absent for them once `phase !== "upcoming"`. That is a real loss against v1.16.0.0's intent (they can plan, then lose the surface the day it matters), and it is deliberate rather than overlooked. Widening it means either lifting `gateAdmin` on three shipped minutes fns or adding a TMOD-scoped attendance reader — both larger than this PR and neither in the spec. **File it as a follow-up issue; do not solve it here.**

### DP2 — #548's fix is truthful for a signed-in member and SILENT for an anonymous one

#548: the personal strip tells a member "You attended this meeting." derived from the plan ladder, not from attendance. Still live; the issue's body is stale (it names `myUnavailable` / `unavailableMemberIds`, which v1.15.0.0 replaced with `myStatus`). The debt is documented at `meeting-personal-strip.tsx:23`.

The honest statement needs the viewer's own `meeting_attendance` row. A signed-in member can have it from `getMinutes`, already loaded. An anonymous roster-pick member cannot, and the only way to give it to them is a new public array of everyone's attendance — which widens "who was absent" for the whole club to any visitor. **This plan does not add that array.** #574 is an open question about a strictly milder version of the same widening (`coming`/`not_coming`), so shipping a wider one underneath it would settle #574 by accident.

So: signed-in member gets the true statement from attendance; anonymous member gets copy that **claims nothing** about attendance. Exact strings in Task 7.

### DP3 — The offline lift goes FIRST, moves the WHOLE subsystem, and has exactly ONE owner

The spec calls the lift "the reason this is its own PR rather than a tail on PR 2". It must land before the section is absorbed, because `MeetingMinutes` is where offline roll call currently lives (#176) and absorbing the section into a panel with no queue would drop that capability silently — no error, no test failure, just a tap that vanishes on a bad connection at a meeting.

**It is not just `mutate` / `opMeta`.** The subsystem in `MeetingMinutes` is `queue`, `snapshot`, `draining`, `syncError`, `justSynced`, `drainingRef`, `onMutatedRef`, the persisted-snapshot load effect and `runDrain` (`meeting-minutes.tsx:138-175` and the drain effect below it). `mutate` guards on `draining`, so moving `mutate` alone leaves the guard reading a variable its new home does not have.

**One owner, because there is one queue per meeting.** `enqueue(meetingId, op)` is keyed by meeting, and after this PR two components write into it. Two hook instances would mean two `draining` flags and two drains racing the same queue — replaying a stale status over a newer one, silently. So the hook is instantiated **once in the route** and its pieces are passed to both `MeetingMinutes` and the panel.

Task 1 still changes **no behavior**. If its diff changes what any existing minutes test asserts, the extraction is wrong.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/hooks/use-offline-minutes.ts` **(create)** | The whole lifted offline subsystem: `queue`, `snapshot`, `draining`, `syncError`, `justSynced`, the persisted-snapshot load, `runDrain`, and `mutate` / `opMeta`. Instantiated ONCE in the route (DP3) and consumed by both `MeetingMinutes` and the panel. Knows about the op queue, not about attendance. |
| `src/hooks/use-offline-minutes.test.ts` **(create)** | Hook behavior: online path, offline enqueue, busy guard, draining guard, and that a drain does not start while a write is in flight. |
| `src/lib/roll-panel.ts` **(create)** | `buildRollPanel` — pure. Rows from roster + attendance + plan suggestions, alphabetical, counts of real rows only. Sibling to `attendance-panel.ts`; kept separate because the two modes share no sort, no counts and no row shape. |
| `src/lib/roll-panel.test.ts` **(create)** | The D3 mapping, the counts arithmetic, and that a suggestion is never counted. |
| `src/components/club/meeting-attendance-panel.tsx` **(modify)** | Gains `mode`. Switches title, counts, sort source, contact visibility, and chip rendering (solid vs dashed). |
| `src/components/club/attendance-guests-group.tsx` **(create)** | The roll-only Guests group + "+ Add guest". Its own file because it owns a form and a picker, and the panel is already ~380 lines. |
| `src/components/club/meeting-minutes.tsx` **(modify)** | Consumes the hook (Task 1). Loses `AttendanceSection` and its call site (Task 6); gains the link up to the panel. |
| `src/components/club/meeting-personal-strip.tsx` **(modify)** | The over-state statement reads real attendance (Task 7). |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` **(modify)** | Mode derivation, the DP1 gate, feeding attendance + guests to the panel, the roll write handlers. |
| `src/routes/attendance-panel-wiring.guard.test.ts` **(modify)** | Re-point the phase-gate pins; add roll-mode wiring pins. |
| `src/components/club/absorbed-surfaces.guard.test.ts` **(modify)** | Add `AttendanceSection` to the "deleted and stays deleted" set. |

---

## Task 1: Lift the offline mutate into a shared hook

**Files:**
- Create: `src/hooks/use-offline-minutes.ts`
- Create: `src/hooks/use-offline-minutes.test.ts`
- Modify: `src/components/club/meeting-minutes.tsx` — delete the offline subsystem (`:138-175` state + refs + snapshot-load effect, the drain effect, and `mutate` / `opMeta` at `:266-299`) and accept its pieces as props instead
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` — instantiate the hook once and pass the pieces to `MeetingMinutes`

**Interfaces:**
- Consumes: `enqueue` and `MinutesOp` from `#/lib/offline-minutes-queue` (existing).
- Produces: `useOfflineMinutes({ meetingId, onMutated })` returning
  `{ mutate, opMeta, busy, queue, snapshot, draining, syncError, justSynced }`, where
  `mutate(onlineFn: () => Promise<unknown>, makeOp: () => MinutesOp) => Promise<void>` and
  `opMeta() => { opId: string; queuedAt: number }`. The hook reads `useOnlineStatus()` itself, so
  callers pass no `online`. Task 5 calls `mutate` for roll writes; Task 1 passes the same object's
  pieces into `MeetingMinutes` as props.

**PURE REFACTOR.** No behavior change. Move the bodies verbatim — do not "improve" them. `mutate` and `opMeta` come from `:266-299`; the state, refs, snapshot-load effect and `runDrain` come from `:138` onward. `MeetingMinutes` keeps rendering the offline banner and the synced confirmation; it just receives `queue` / `draining` / `syncError` / `justSynced` instead of owning them. Its two guards are load-bearing and the reasons are in its comments: `draining` joins the busy guard so a reconnect drain cannot interleave with a fresh edit and reorder ops, and a queue only exists after a real offline session, so `draining` is always false for an online-only user whose path must stay byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test**

`src/hooks/use-offline-minutes.test.ts`:

```tsx
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSpy = vi.fn(async () => {});
vi.mock("#/lib/offline-minutes-queue", () => ({
	enqueue: (...args: unknown[]) => enqueueSpy(...args),
	readQueue: async () => QUEUED,
	readSnapshot: async () => null,
	saveSnapshot: async () => {},
}));
// The hook reads connectivity itself, so the test drives it here rather than
// through a prop — which also proves the hook is not silently trusting a caller.
let ONLINE = true;
let QUEUED: unknown[] = [];
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => ONLINE,
	useOfflineReady: () => true,
}));

const { useOfflineMinutes } = await import("#/hooks/use-offline-minutes");

const OP = () => ({
	type: "setAttendance" as const,
	opId: "op-1",
	queuedAt: 1,
	memberId: "m1",
	status: "present" as const,
});

describe("useOfflineMinutes", () => {
	beforeEach(() => {
		enqueueSpy.mockClear();
		QUEUED = [];
	});

	it("runs the online fn and refreshes when online", async () => {
		const onlineFn = vi.fn(async () => {});
		const onMutated = vi.fn(async () => {});
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated }),
		);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		expect(onlineFn).toHaveBeenCalledTimes(1);
		expect(onMutated).toHaveBeenCalledTimes(1);
		// The ONLINE path must never touch the queue. A regression that enqueued
		// unconditionally would still pass a "did the write happen" assertion.
		expect(enqueueSpy).not.toHaveBeenCalled();
	});

	it("queues the op and does NOT call the server when offline", async () => {
		const onlineFn = vi.fn(async () => {});
		ONLINE = false;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		expect(onlineFn).not.toHaveBeenCalled();
		expect(enqueueSpy).toHaveBeenCalledWith("meet-1", OP());
		expect(result.current.queue).toHaveLength(1);
	});

	it("refuses to start a write while a drain is in flight", async () => {
		// The ordering guard. Without it a reconnect drain interleaves with a fresh
		// edit and the two land out of order — the queue replays a stale status over
		// a newer one, silently.
		// Driven through the hook's REAL drain, not a test-only setter. Seed a
		// persisted queue so the mount-time drain starts and sets `draining` itself,
		// then assert a fresh write is refused while it runs.
		//
		// No `__setDrainingForTest` backdoor: an API that exists only so a test can
		// reach it lets the guard be deleted while the test still passes. If the
		// drain proves non-deterministic in jsdom, report DONE_WITH_CONCERNS with
		// what you tried and assert something narrower — do NOT add a backdoor.
		const onlineFn = vi.fn(async () => {});
		ONLINE = true;
		QUEUED = [OP()]; // readQueue returns this, so the drain has work on mount
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);

		await act(async () => {
			await result.current.mutate(onlineFn, OP);
		});

		// The drain owns the queue for the duration; a concurrent write would let
		// the replay reorder against it and land a stale status over a newer one.
		expect(onlineFn).not.toHaveBeenCalled();
	});

	it("stamps each op with a distinct id", () => {
		ONLINE = true;
		const { result } = renderHook(() =>
			useOfflineMinutes({ meetingId: "meet-1", onMutated: async () => {} }),
		);
		// Two ops queued in the same tick must not collide — the drain de-dups on
		// opId, so a shared id silently drops one of them.
		expect(result.current.opMeta().opId).not.toBe(result.current.opMeta().opId);
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/hooks/use-offline-minutes.test.ts`
Expected: FAIL — `Cannot find module '#/hooks/use-offline-minutes'`.

- [ ] **Step 3: Write the hook**

`src/hooks/use-offline-minutes.ts`:

```ts
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { enqueue, type MinutesOp } from "#/lib/offline-minutes-queue";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The offline-capable write path for meeting-day edits (#176), lifted out of
 * `MeetingMinutes` so the attendance panel gets the same capability when it
 * absorbs roll call (PR 3). Behaviour is unchanged from the original — this is a
 * move, not a rewrite.
 *
 * `draining` joins the busy guard so a reconnect drain is not interleaved with a
 * fresh edit (which could reorder ops). A queue only ever exists after an actual
 * offline session, so `draining` is ALWAYS false for a normal online-only user —
 * their online path is byte-for-byte what it was.
 */
export function useOfflineMinutes(input: {
	meetingId: string;
	onMutated: () => Promise<void>;
}) {
	const online = useOnlineStatus();
	const [busy, setBusy] = useState(false);
	const [queue, setQueue] = useState<MinutesOp[]>([]);
	// Moved verbatim from MeetingMinutes — see DP3 for why the WHOLE subsystem
	// travels and why it may only be instantiated once per meeting.
	const [snapshot, setSnapshot] = useState<MinutesData | null>(null);
	const [draining, setDraining] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [justSynced, setJustSynced] = useState(false);
	const drainingRef = useRef(false);
	const onMutatedRef = useRef(input.onMutated);
	onMutatedRef.current = input.onMutated;

	async function mutate(
		onlineFn: () => Promise<unknown>,
		makeOp: () => MinutesOp,
	) {
		if (busy || draining) return;
		if (!online) {
			const op = makeOp();
			setQueue((q) => [...q, op]);
			try {
				await enqueue(input.meetingId, op);
			} catch (err) {
				toast.error(errMessage(err));
			}
			return;
		}
		setBusy(true);
		try {
			await onlineFn();
			await input.onMutated();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusy(false);
		}
	}

	const opMeta = () => ({
		opId: crypto.randomUUID(),
		queuedAt: Date.now(),
	});

	// The snapshot-load effect and `runDrain` move here verbatim from
	// `meeting-minutes.tsx` (`:159` onward). `drainingRef` stays alongside
	// `draining` for the reason its original comment gives: the state lags a tick,
	// so the effect can re-fire before it flips, and only a synchronous ref blocks
	// a second concurrent drain.

	return {
		mutate,
		opMeta,
		busy,
		queue,
		snapshot,
		draining,
		syncError,
		justSynced,
	};
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/hooks/use-offline-minutes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Instantiate once in the route, pass the pieces down**

In `src/routes/club.$clubId.meeting.$meetingId.tsx` — ONE instance per meeting (DP3):

```tsx
const offline = useOfflineMinutes({
	meetingId: meeting.id,
	onMutated: async () => {
		await router.invalidate();
	},
});
```

Pass `offline={offline}` to `<MeetingMinutes>`. In `meeting-minutes.tsx`, delete the offline state, the refs, the snapshot-load effect, the drain effect, `mutate` and `opMeta`, and read them off the new prop instead:

```tsx
const { mutate, opMeta, busy, queue, snapshot, draining, syncError, justSynced } = offline;
```

Keep every existing `mutate(...)` and `opMeta()` CALL SITE unchanged, and keep the banner/confirmation JSX where it is — that is the check that this was a move and not a redesign.

- [ ] **Step 6: Prove the refactor changed nothing**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/components/club/meeting-minutes.test.tsx src/lib/offline-minutes-queue.test.ts src/lib/drain-minutes.test.ts`
Expected: PASS, with **no test edited**. If any minutes test needed changing, the extraction altered behavior — revert and redo Step 5.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-offline-minutes.ts src/hooks/use-offline-minutes.test.ts src/components/club/meeting-minutes.tsx
git commit -m "refactor: lift the offline minutes mutate into a shared hook

Pure move out of MeetingMinutes so the attendance panel can reuse it when it
absorbs roll call. No behaviour change: every call site is unchanged and no
existing minutes test was edited. The draining guard travels with it — a
reconnect drain interleaved with a fresh edit reorders ops."
```

---

## Task 2: The roll-mode derivation (pure)

**Files:**
- Create: `src/lib/roll-panel.ts`
- Create: `src/lib/roll-panel.test.ts`

**Interfaces:**
- Consumes: `PlanStatus` from `#/lib/attendance-panel` (a type-only alias of the pgEnum-derived union — do NOT hand-list the rungs, see that file's comment and #510). `AttendanceStatus` from `#/server/minutes-logic` (`"present" | "absent" | "excused"`), imported `type`-only so no `#/db` reaches the client bundle.
- Produces: `buildRollPanel(input) => { rows: RollRow[]; counts: RollCounts; countsLine: string }`, and the types `RollRow`, `RollCounts`, `RollSuggestion`. Task 3 renders `rows` and `countsLine`.

Separate module from `attendance-panel.ts` on purpose: the two modes share no sort, no counts and no row shape, and the spec's D2 table is a list of things that differ. A single `buildPanel` with a mode flag would be two functions wearing one name.

**D3, verbatim from the spec:** a member with **no** `meeting_attendance` row renders a dashed **suggestion** derived from their plan — `coming → Present?`, `not_coming → Excused?`, anything else → `Unmarked`. Tapping it writes the real row and it renders solid. Counts report real rows ONLY.

- [ ] **Step 1: Write the failing test**

`src/lib/roll-panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRollPanel } from "#/lib/roll-panel";

const roster = [
	{ id: "m-cara", name: "Cara Diaz", phone: null, email: null },
	{ id: "m-abe", name: "Abe Nkemelu", phone: null, email: null },
	{ id: "m-bea", name: "Bea Osei", phone: null, email: null },
];

describe("buildRollPanel", () => {
	it("sorts alphabetically, NOT by the plan ladder", () => {
		// Plan mode sorts chase-worthy-first. Roll mode is a register being read
		// down, so a row must not move because someone tapped it.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-cara", status: "present" }],
			plan: [{ memberId: "m-abe", status: "not_coming" }],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.name)).toEqual([
			"Abe Nkemelu",
			"Bea Osei",
			"Cara Diaz",
		]);
	});

	it("maps a plan rung to a SUGGESTION when no attendance row exists", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [],
			plan: [
				{ memberId: "m-abe", status: "coming" },
				{ memberId: "m-bea", status: "not_coming" },
				{ memberId: "m-cara", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		const by = (id: string) => rows.find((r) => r.id === id);
		expect(by("m-abe")).toMatchObject({
			status: null,
			suggestion: "present",
		});
		expect(by("m-bea")).toMatchObject({
			status: null,
			suggestion: "excused",
		});
		// `reached_out` is an ask, not an answer — it suggests nothing.
		expect(by("m-cara")).toMatchObject({ status: null, suggestion: null });
	});

	it("a real row WINS over the plan and renders solid", () => {
		// The whole point of D3: a plan can never be mistaken for a record.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-abe", status: "absent" }],
			plan: [{ memberId: "m-abe", status: "coming" }],
			roleByMemberId: {},
		});
		expect(rows.find((r) => r.id === "m-abe")).toMatchObject({
			status: "absent",
			suggestion: null,
		});
	});

	it("counts REAL rows only — a suggestion is never counted", () => {
		// The assertion this module exists for. Counting suggestions would report
		// "12 present" for a room nobody had checked, which is worse than no count.
		const { counts, countsLine } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-cara", status: "present" }],
			// Two members carry `coming`, so a suggestion-counting bug reads 3.
			plan: [
				{ memberId: "m-abe", status: "coming" },
				{ memberId: "m-bea", status: "coming" },
			],
			roleByMemberId: {},
		});
		expect(counts).toEqual({ present: 1, absent: 0, excused: 0, unmarked: 2 });
		expect(countsLine).toBe("1 present · 2 unmarked");
	});

	it("sums every bucket to the roster size", () => {
		const { counts } = buildRollPanel({
			roster,
			attendance: [
				{ memberId: "m-abe", status: "present" },
				{ memberId: "m-bea", status: "excused" },
				{ memberId: "m-cara", status: "absent" },
			],
			plan: [],
			roleByMemberId: {},
		});
		const total =
			counts.present + counts.absent + counts.excused + counts.unmarked;
		expect(total).toBe(roster.length);
	});

	it("omits empty buckets from the counts line", () => {
		const { countsLine } = buildRollPanel({
			roster,
			attendance: [],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("3 unmarked");
	});

	it("builds rows from the ROSTER, so a stale attendance row cannot resurrect a name", () => {
		// An inactive member is filtered upstream but their attendance row survives
		// in the table. Iterating attendance would put them back on screen.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-ghost", status: "present" }],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.id === "m-ghost")).toBeUndefined();
	});

	it("carries the role chip as information, never as a bucket", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [],
			plan: [],
			roleByMemberId: { "m-bea": "Timer" },
		});
		expect(rows.find((r) => r.id === "m-bea")?.roleName).toBe("Timer");
		expect(rows.find((r) => r.id === "m-abe")?.roleName).toBeNull();
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx vitest run src/lib/roll-panel.test.ts`
Expected: FAIL — `Cannot find module '#/lib/roll-panel'`.

- [ ] **Step 3: Write the derivation**

`src/lib/roll-panel.ts`:

```ts
// Pure derivation for the attendance panel in ROLL mode (spec D2/D3). No React
// and no db, so the sort, the suggestion mapping and the counts are assertable
// directly — through a rendered DOM none of them are, because two rows on the
// same status render the same chip and a count can be right for the wrong
// reason.
//
// Sibling to `attendance-panel.ts` rather than a mode flag inside it: the two
// modes share no sort, no counts and no row shape, so one function with a flag
// would be two functions wearing one name.

import type { PlanStatus } from "#/lib/attendance-panel";
import type { AttendanceStatus } from "#/server/minutes-logic";

/** What the plan SUGGESTS for a member with no attendance row yet. `null` means
 *  the plan says nothing useful — `reached_out` is an ask, not an answer. */
export type RollSuggestion = Extract<AttendanceStatus, "present" | "excused">;

export interface RollRow {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
	/** The RECORDED status, or null when nobody has recorded one. */
	status: AttendanceStatus | null;
	/** Non-null only when `status` is null. Renders dashed; tapping it writes the
	 *  real row. A row can never carry both — that is what makes a plan
	 *  physically unmistakable for a record (D3, the guard against #548). */
	suggestion: RollSuggestion | null;
	/** Information, never a bucket: the Timer still needs marking present. */
	roleName: string | null;
}

export interface RollCounts {
	present: number;
	absent: number;
	excused: number;
	unmarked: number;
}

/** D3's mapping, in one place. `coming → Present?`, `not_coming → Excused?`,
 *  anything else → no suggestion. */
function suggest(plan: PlanStatus | null): RollSuggestion | null {
	if (plan === "coming") return "present";
	if (plan === "not_coming") return "excused";
	return null;
}

export function buildRollPanel(input: {
	roster: {
		id: string;
		name: string;
		phone: string | null;
		email: string | null;
		preferredName?: string | null;
	}[];
	attendance: { memberId: string; status: AttendanceStatus }[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Record<string, string>;
}): { rows: RollRow[]; counts: RollCounts; countsLine: string } {
	const recorded = new Map(input.attendance.map((a) => [a.memberId, a.status]));
	const planned = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the attendance rows: an inactive member is
	// filtered upstream but their row survives in the table, and iterating
	// attendance would resurrect the name.
	const rows: RollRow[] = input.roster.map((m) => {
		const status = recorded.get(m.id) ?? null;
		return {
			...m,
			status,
			// Mutually exclusive by construction, not by convention.
			suggestion: status === null ? suggest(planned.get(m.id) ?? null) : null,
			roleName: input.roleByMemberId[m.id] ?? null,
		};
	});

	// Alphabetical, so a row does not move because someone tapped it. Roll call is
	// read down a register; plan mode's chase-worthy-first order would make the
	// list reorder under the officer's finger.
	rows.sort((a, b) => a.name.localeCompare(b.name));

	// REAL rows only. A suggestion is not a record, so it counts as unmarked.
	const counts: RollCounts = {
		present: rows.filter((r) => r.status === "present").length,
		absent: rows.filter((r) => r.status === "absent").length,
		excused: rows.filter((r) => r.status === "excused").length,
		unmarked: rows.filter((r) => r.status === null).length,
	};

	const countsLine = (
		[
			[counts.present, "present"],
			[counts.absent, "absent"],
			[counts.excused, "excused"],
			[counts.unmarked, "unmarked"],
		] as const
	)
		.filter(([n]) => n > 0)
		.map(([n, label]) => `${n} ${label}`)
		.join(" · ");

	return { rows, counts, countsLine };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bunx vitest run src/lib/roll-panel.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Confirm no `#/db` reached the client bundle**

Run: `bunx vitest run src/server/server-modules.guard.test.ts && bun run typecheck`
Expected: PASS. `AttendanceStatus` is imported `type`-only, which erases at compile time — the same route six `src/lib` modules already take into `#/server/*-logic`. A VALUE import from `#/server/minutes-logic` would drag `#/db` → `pg` → `Buffer` into the browser and white-screen the page.

- [ ] **Step 6: Commit**

```bash
git add src/lib/roll-panel.ts src/lib/roll-panel.test.ts
git commit -m "feat(attendance): pure roll-mode derivation with plan-as-suggestion

D3: a member with no meeting_attendance row renders a dashed suggestion from
their plan (coming to Present?, not_coming to Excused?), and a real row always
wins. Counts report real rows only, so a suggestion is never counted as present.
Alphabetical, because roll call is read down a register and a row must not move
when it is tapped."
```

---

## Task 3: The panel renders roll mode

**Files:**
- Modify: `src/components/club/meeting-attendance-panel.tsx`
- Modify: `src/components/club/meeting-attendance-panel.test.tsx`

**Interfaces:**
- Consumes: `buildRollPanel`, `RollRow`, `RollSuggestion` from `#/lib/roll-panel` (Task 2). `useOfflineMinutes` is NOT used here — the panel stays presentational and the route owns writes, exactly as plan mode does.
- Produces: the panel accepts

```ts
mode: "plan" | "roll";
/** Roll mode only. Recorded rows; ignored in plan mode. */
attendance?: { memberId: string; status: AttendanceStatus }[];
/** Roll mode only. Fired by a chip or a dashed suggestion. */
onSetAttendance?: (memberId: string, status: AttendanceStatus) => void;
```

  Task 5 passes them. `mode` is REQUIRED so an existing call site cannot silently keep plan behavior after this lands.

**Per the spec's D2 table**, roll mode changes five things and nothing else: title `Attendance`, the roll counts line, alphabetical order, contact hidden once `completed`, and the chip menu offers Present / Absent / Excused instead of the plan rungs.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/club/meeting-attendance-panel.test.tsx`:

```tsx
describe("roll mode", () => {
	const rollProps = {
		mode: "roll" as const,
		roster: [
			{ id: "m-abe", name: "Abe Nkemelu", phone: "+12025550101", email: "abe@example.com" },
			{ id: "m-bea", name: "Bea Osei", phone: null, email: "bea@example.com" },
		],
		plan: [{ memberId: "m-abe", status: "coming" as const }],
		attendance: [],
		rungOverride: {},
		roleByMemberId: {},
		meetingDate: "August 20, 2026",
		shareUrl: "https://example.test/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		onSetAttendance: vi.fn(),
	};

	it("titles itself Attendance and counts real rows", () => {
		const { getByText } = render(<MeetingAttendancePanel {...rollProps} />);
		getByText("Attendance");
		// Abe's plan says `coming`, which is a SUGGESTION, not a record — so both
		// members are unmarked. A suggestion-counting bug reads "1 present".
		getByText("2 unmarked");
	});

	it("renders a dashed suggestion for a planned member and a solid chip for a recorded one", () => {
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				attendance={[{ memberId: "m-bea", status: "present" }]}
			/>,
		);
		// Abe: no row, plan says coming -> dashed "Present?"
		const abe = getByRole("button", { name: /Abe Nkemelu status/i });
		expect(abe.textContent).toContain("Present?");
		expect(abe.className).toContain("border-dashed");
		// Bea: real row -> solid, no question mark.
		const bea = getByRole("button", { name: /Bea Osei status/i });
		expect(bea.textContent).toContain("Present");
		expect(bea.textContent).not.toContain("?");
		expect(bea.className).not.toContain("border-dashed");
	});

	it("tapping a dashed suggestion writes the suggested status", async () => {
		const onSetAttendance = vi.fn();
		const { getByRole } = render(
			<MeetingAttendancePanel {...rollProps} onSetAttendance={onSetAttendance} />,
		);
		fireEvent.click(getByRole("button", { name: /Abe Nkemelu status/i }));
		// One tap commits the suggestion — that is the affordance. It must NOT open
		// the menu, or roll call costs two taps per member.
		expect(onSetAttendance).toHaveBeenCalledWith("m-abe", "present");
	});

	it("offers the attendance statuses, not the plan rungs", async () => {
		const { getByRole, findByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				attendance={[{ memberId: "m-bea", status: "present" }]}
			/>,
		);
		fireEvent.click(getByRole("button", { name: /Bea Osei status/i }));
		await findByRole("menuitem", { name: "Present" });
		getByRole("menuitem", { name: "Absent" });
		getByRole("menuitem", { name: "Excused" });
		expect(() => getByRole("menuitem", { name: "Coming" })).toThrow();
	});

	it("keeps contact while the meeting is today and drops it once completed", () => {
		const today = render(<MeetingAttendancePanel {...rollProps} />);
		today.getByRole("link", { name: /WhatsApp/i });
		today.unmount();
		// `completed` rows are a historical record — nobody is being chased.
		const done = render(<MeetingAttendancePanel {...rollProps} locked={true} phaseCompleted={true} />);
		expect(() => done.getByRole("link", { name: /WhatsApp/i })).toThrow();
	});

	it("expands by default below lg, unlike plan mode", () => {
		// Plan mode collapses to its counts line so a big roster does not push the
		// agenda off screen. Roll mode IS the task on meeting day, so it opens.
		window.innerWidth = 375;
		const { getAllByRole } = render(<MeetingAttendancePanel {...rollProps} />);
		expect(getAllByRole("button", { name: / status/i })).toHaveLength(2);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run src/components/club/meeting-attendance-panel.test.tsx`
Expected: FAIL — `mode` is not a known prop; `Attendance` not found.

- [ ] **Step 3: Implement**

In `meeting-attendance-panel.tsx`:

1. Add `mode`, `attendance`, `onSetAttendance`, `phaseCompleted` to the props type (see Interfaces above; `phaseCompleted?: boolean` defaults false).
2. Derive once, branching on mode, so the two derivations never both run:

```tsx
const roll = mode === "roll";
const rollPanel = roll
	? buildRollPanel({
			roster,
			attendance: attendance ?? [],
			plan: effectivePlanForPanel,
			roleByMemberId,
		})
	: null;
const planPanel = roll ? null : buildPlanPanel({ roster, plan: effectivePlanForPanel, roleByMemberId });
const countsLine = rollPanel?.countsLine ?? planPanel?.countsLine ?? "";
```

3. Title: `{roll ? "Attendance" : "Planned attendance"}`.
4. Contact visibility: pass `shareUrl=""` down when `roll && phaseCompleted`, which is the existing "no contact" path — do NOT add a second mechanism.
5. Chip: in roll mode render `RollChip`, where a `suggestion` renders `border-dashed` with a trailing `?` and a single-tap handler, and a recorded `status` renders solid and opens the menu:

```tsx
const ROLL_LABELS: Record<AttendanceStatus, string> = {
	present: "Present",
	absent: "Absent",
	excused: "Excused",
};
const ROLL_MENU: { label: string; status: AttendanceStatus }[] = [
	{ label: "Present", status: "present" },
	{ label: "Absent", status: "absent" },
	{ label: "Excused", status: "excused" },
];
```

6. Mobile: `showRows = roll || expanded || isDesktop` — roll mode opens.

- [ ] **Step 4: Run and confirm pass**

Run: `bunx vitest run src/components/club/meeting-attendance-panel.test.tsx`
Expected: PASS, including every pre-existing plan-mode test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/meeting-attendance-panel.tsx src/components/club/meeting-attendance-panel.test.tsx
git commit -m "feat(attendance): the panel renders roll mode

Title, counts, order, contact visibility and the chip menu all switch on mode.
A dashed suggestion commits in ONE tap — roll call costs two taps per member
otherwise. Roll mode opens on mobile rather than collapsing, because on meeting
day the panel IS the task."
```

---

## Task 4: The Guests group

**Files:**
- Create: `src/components/club/attendance-guests-group.tsx`
- Create: `src/components/club/attendance-guests-group.test.tsx`
- Modify: `src/components/club/meeting-attendance-panel.tsx` (render it in roll mode only)

**Interfaces:**
- Consumes: `MinutesGuestRow` (`{ guestId, name, fromRole, … }`) from `#/server/minutes-logic`, type-only. `clubGuests` in the shape `AttendanceSection` already receives (`{ id, name }[]`).
- Produces: `<AttendanceGuestsGroup guests clubGuests locked onAddGuest onRemoveGuest />` where
  `onAddGuest(payload: { guestId?: string; newGuest?: { name: string; email?: string; phone?: string } }) => void` — the SAME payload shape `addMinutesGuest` takes, so the route can forward it unchanged.

Guests are roll-mode only (spec: "Guests appear only in roll mode. Pre-meeting guest expectation is out of scope"). Lifted verbatim in behavior from `AttendanceSection`'s guest half so Task 6 can delete that section without losing anything.

**Read the thing you are lifting before you write it.** The source is `GuestAdder` and the guest half of
`AttendanceSection`, both in `src/components/club/meeting-minutes.tsx` (`AttendanceSection` at :488, `GuestAdder`
at :594). Three details there are load-bearing and an earlier draft of this task got all three wrong, which is
why they are called out rather than left to "verbatim":

- It is a **`Popover` + `cmdk` `Command`**, NOT a `DropdownMenu`. That is what makes `role="option"` the right
  query — `CommandItem` renders an option inside a listbox, whereas a `DropdownMenuItem` would render
  `role="menuitem"` and every `getByRole("option")` below would fail.
- The new-guest form carries **`email` and `phone`** alongside the name (`aria-label` `Guest email` / `Guest
  phone`), and its submit button reads **`Add guest`** — the same accessible name as the trigger, so once the
  popover is open `getByRole("button", { name: /Add guest/i })` is AMBIGUOUS and throws. Query the trigger
  before opening, or scope by role/position. Task 6 deletes the old section, so dropping email/phone here is a
  silent capability regression, not a simplification.
- A guest with **`fromRole: true`** gets NO remove button at all — they are present because they hold a role, so
  removing them from attendance would desync the two surfaces. `locked`/`busy` DISABLES the control; `fromRole`
  OMITS it. Those are different and both must survive.

- [ ] **Step 1: Write the failing tests**

`src/components/club/attendance-guests-group.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttendanceGuestsGroup } from "#/components/club/attendance-guests-group";

const base = {
	guests: [{ guestId: "g1", name: "Nadia Farouk", fromRole: false }],
	clubGuests: [
		{ id: "g1", name: "Nadia Farouk" },
		{ id: "g2", name: "Tom Reyes" },
	],
	locked: false,
	onAddGuest: vi.fn(),
	onRemoveGuest: vi.fn(),
};

describe("AttendanceGuestsGroup", () => {
	// vitest here runs without `globals`, so testing-library's auto-cleanup never
	// registers and renders leak between tests. Every component suite in this repo
	// carries this line explicitly — see meeting-attendance-panel.test.tsx.
	afterEach(() => cleanup());

	it("lists the guests present and offers to add one", () => {
		const { getByText, getByRole } = render(<AttendanceGuestsGroup {...base} />);
		getByText("Nadia Farouk");
		getByRole("button", { name: /Add guest/i });
	});

	it("adds an EXISTING club guest by id", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByRole } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		// Radix's PopoverTrigger opens on `pointerdown`, not a bare `click` —
		// `userEvent.click` replays the real pointer sequence. Capture the trigger
		// BEFORE opening: the new-guest form's submit button shares its accessible
		// name, so `getByRole("button", { name: /Add guest/i })` throws on ambiguity
		// once the popover is open.
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		// `CommandItem` (cmdk) renders `role="option"`. Selection goes through
		// cmdk's own handler, so a plain click is right here.
		fireEvent.click(await findByRole("option", { name: /Tom Reyes/ }));
		// `guestId` path, not `newGuest` — adding an existing guest again must not
		// create a duplicate person in the club's pipeline (ADR-0018).
		expect(onAddGuest).toHaveBeenCalledWith({ guestId: "g2" });
	});

	it("creates a NEW guest from a typed name, carrying email and phone", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByLabelText, getByLabelText } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		const trigger = getByRole("button", { name: /Add guest/i });
		await userEvent.click(trigger);
		fireEvent.change(await findByLabelText(/New guest name/i), {
			target: { value: "Wale Adeyemi" },
		});
		fireEvent.change(getByLabelText(/Guest email/i), {
			target: { value: "wale@example.com" },
		});
		// Submit through the FORM, not by name — the submit button and the trigger
		// are both "Add guest", and this asserts the form's own submit path.
		fireEvent.submit(getByLabelText(/New guest name/i).closest("form") as HTMLFormElement);
		// email/phone must survive. Task 6 deletes the old AttendanceSection, so a
		// name-only payload here is a silent capability regression, not a
		// simplification.
		expect(onAddGuest).toHaveBeenCalledWith({
			newGuest: { name: "Wale Adeyemi", email: "wale@example.com", phone: undefined },
		});
	});

	it("refuses to submit a whitespace-only name", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByLabelText, getByLabelText } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		// Whitespace, NOT empty: `required` already blocks empty, so an empty-string
		// fixture would pass with the trim guard deleted.
		fireEvent.change(await findByLabelText(/New guest name/i), {
			target: { value: "   " },
		});
		fireEvent.submit(getByLabelText(/New guest name/i).closest("form") as HTMLFormElement);
		expect(onAddGuest).not.toHaveBeenCalled();
	});

	it("disables the actions on a locked meeting rather than hiding them", () => {
		const { getByRole } = render(<AttendanceGuestsGroup {...base} locked={true} />);
		expect(
			getByRole("button", { name: /Add guest/i }).hasAttribute("disabled"),
		).toBe(true);
		expect(
			getByRole("button", { name: /Remove Nadia Farouk/i }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("OMITS the remove control for a guest who is present because of a role", () => {
		// `fromRole` and `locked` are different things: locked disables, fromRole
		// omits. A role-holder removed from attendance desyncs the two surfaces.
		const { queryByRole, getByText } = render(
			<AttendanceGuestsGroup
				{...base}
				guests={[{ guestId: "g3", name: "Priya Nair", fromRole: true }]}
			/>,
		);
		getByText("Priya Nair");
		expect(queryByRole("button", { name: /Remove Priya Nair/i })).toBeNull();
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run src/components/club/attendance-guests-group.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the group**

Build `AttendanceGuestsGroup` with the props above, lifting the structure from `GuestAdder` and
`AttendanceSection`'s guest half in `src/components/club/meeting-minutes.tsx` (:594 and :556-588).
A section headed `Guests`, one `Badge` per `guests` entry carrying the name and — only when
`!guest.fromRole` — a `Remove <name>` icon button, then the adder: a `Popover` whose trigger reads
`+ Add guest`, containing a `cmdk` `Command` listing the `clubGuests` not already present (each a
`CommandItem`, which renders `role="option"`) above a `<form>` with `New guest name` (required),
`Guest email` and `Guest phone` inputs and an `Add guest` submit button.

On submit, trim the name, `toast.error("A guest name is required.")` and return when it is empty,
otherwise call `onAddGuest({ newGuest: { name, email: email || undefined, phone: phone || undefined } })`
and close the popover. Selecting an existing guest calls `onAddGuest({ guestId })` and closes. Keep
the toast: a silent no-op on a blank name looks to the user like the button is broken.

`locked` maps to the `busy`/`canEdit` behaviour of the source: it DISABLES the trigger, the submit
and each remove button. It does not hide them — only `fromRole` omits a control.

- [ ] **Step 4: Run and confirm pass**

Run: `bunx vitest run src/components/club/attendance-guests-group.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Render it in the panel, roll mode only**

In `meeting-attendance-panel.tsx`, after the member rows:

```tsx
{roll && guests ? (
	<AttendanceGuestsGroup
		guests={guests}
		clubGuests={clubGuests ?? []}
		locked={locked}
		onAddGuest={onAddGuest ?? (() => {})}
		onRemoveGuest={onRemoveGuest ?? (() => {})}
	/>
) : null}
```

Add a panel test asserting the group is ABSENT in plan mode — a group that renders in both modes contradicts the spec and puts a pre-meeting guest surface on screen that ADR-0018 explicitly does not own.

- [ ] **Step 6: Commit**

```bash
git add src/components/club/attendance-guests-group.tsx src/components/club/attendance-guests-group.test.tsx src/components/club/meeting-attendance-panel.tsx src/components/club/meeting-attendance-panel.test.tsx
git commit -m "feat(attendance): guests group in roll mode

Lifted from the Minutes AttendanceSection's guest half so Task 6 can delete that
section without losing the existing-guest-vs-new-guest distinction, which keeps a
returning visitor from becoming a duplicate row in the pipeline (ADR-0018).
Roll mode only — pre-meeting guest expectation is out of scope."
```

---

## Task 5: Route wiring — the mode, the DP1 gate, and the roll writes

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Modify: `src/routes/attendance-panel-wiring.guard.test.ts`

**Interfaces:**
- Consumes: the panel props from Tasks 3-4; the SINGLE `offline` object Task 1 created in this route (do not instantiate a second — DP3); `setAttendance` / `addMinutesGuest` / `removeMinutesGuest` from `#/server/minutes` (already imported by this route for the Minutes card).
- Produces: nothing downstream. This is the last wiring task before the deletion.

**THE GATE — read DP1 before writing code.** Plan mode admits officer OR this meeting's Toastmaster. Roll mode admits **signed-in club admin only**, because `gateAdmin` and `getMinutes` are both already gated that way. Getting this wrong ships a Toastmaster a panel whose every tap 403s.

- [ ] **Step 1: Write the failing guard assertions**

Append these INSIDE the existing `describe("attendance panel route wiring (PR 2)", …)` block —
`src` is a `const` scoped to that describe (`attendance-panel-wiring.guard.test.ts:23`), so an
`it()` appended at the end of the FILE would not compile.

**Match multi-line code through `src.replace(/\s+/g, " ")`, never a literal `\n\t\t`.** Biome owns
this file's formatting, so a hardcoded tab count asserts a formatting decision rather than the
rule: if Biome fits `const showPanel = …` on one line, a `\n\t\t` match fails on CORRECT code, and
the next person edits the guard instead of reading it. The existing file already settled this —
it uses the `\s+` normalisation for every multi-line match and contains not one `\n\t`. Follow it.

```ts
it("derives the panel mode from the phase, with no second clock", () => {
	expect(src.replace(/\s+/g, " ")).toContain(
		'const panelMode = phase === "upcoming" ? "plan" : "roll";',
	);
	// Still exactly one `meetingPhase({` in the file — a second call, especially
	// one with an inline `new Date()`, lets the panel and the agenda disagree
	// about the club-local day across midnight.
	expect(src.split("meetingPhase({").length - 1).toBe(1);
});

it("gates ROLL mode on a signed-in admin, NOT on the Toastmaster arm", () => {
	// DP1. `setAttendance` runs `gateAdmin` (requireUser + requireClubRole admin)
	// and `getMinutes` is only reached behind `context.shell`, so a roster-pick
	// Toastmaster has no rows to render and no write that would land. Rendering
	// roll mode for them is a panel of buttons that only error.
	const flat = src.replace(/\s+/g, " ");
	expect(flat).toContain(
		'const showPanel = panelMode === "plan" ? showPlanPanel : showRollPanel;',
	);
	expect(flat).toContain(
		"const showRollPanel = effectiveCanManage && minutes.canEdit;",
	);
	// The TMOD arm must NOT reach roll mode.
	expect(
		flat,
		"runsThisMeeting admits the Toastmaster and must not gate the roll panel",
	).not.toContain("const showRollPanel = runsThisMeeting");
});

it("feeds roll mode the recorded rows and the guests from minutes", () => {
	expect(src).toContain("attendance={rollAttendance}");
	expect(src).toContain("guests={minutes.guests}");
	expect(src.replace(/\s+/g, " ")).toContain(
		"const rollAttendance = minutes.members.flatMap((m) => m.status === null ? [] : [{ memberId: m.memberId, status: m.status }], );",
	);
});

it("routes every roll write through the offline hook, so a bad connection queues", () => {
	// #176's capability. A direct `setAttendance(...)` call here would work online
	// and silently vanish offline — at a meeting, on club wifi.
	expect(src).toContain("await offline.mutate(");
	expect(src).toContain('type: "setAttendance",');
	// Exactly ONE instance per meeting (DP3) — a second would race the same queue.
	expect(src.split("useOfflineMinutes({").length - 1).toBe(1);
	expect(
		src.replace(/\s+/g, " "),
		"roll writes must not bypass the queue",
	).not.toMatch(/onSetAttendance=\{\(memberId, status\) => setAttendance\(/);
});
```

If the `\s+`-normalised literal above does not match once the code is written, print the
normalised slice and fix the ASSERTION to the real text — do not reformat the route to satisfy a
string I wrote from memory.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run src/routes/attendance-panel-wiring.guard.test.ts`
Expected: FAIL on all four new cases.

- [ ] **Step 3: Wire the route**

```tsx
// ONE derivation of the mode, off the route's existing frozen clock.
const panelMode = phase === "upcoming" ? "plan" : "roll";

// DP1: roll mode is signed-in-admin only. `minutes.canEdit` is the same signal
// the Minutes card gates its own recorder on, so the panel and the card can never
// disagree about whether this viewer may record attendance. A Toastmaster who
// identified by roster pick fails both halves and sees no panel on meeting day —
// deliberate, and filed as a follow-up rather than solved here.
const showRollPanel = effectiveCanManage && minutes.canEdit;
const showPanel =
	panelMode === "plan" ? showPlanPanel : showRollPanel;

// Recorded rows only. `minutes.members` carries `status: null` for anyone
// unrecorded, and `buildRollPanel` needs the ABSENCE of a row to render a
// suggestion — so a null must not be flattened into a value here.
const rollAttendance = minutes.members.flatMap((m) =>
	m.status === null ? [] : [{ memberId: m.memberId, status: m.status }],
);

// REUSE the single instance Task 1 created — do NOT call useOfflineMinutes
// again. Two instances mean two `draining` flags racing one queue (DP3), which
// replays a stale status over a newer one with no error.
async function writeAttendance(memberId: string, status: AttendanceStatus) {
	await offline.mutate(
		() => setAttendance({ data: { meetingId: meeting.id, memberId, status } }),
		() => ({ type: "setAttendance", ...offline.opMeta(), memberId, status }),
	);
}
```

Then swap the render gate from `showPlanPanel && !tmodPanelUnavailable` to `showPanel && !tmodPanelUnavailable`, pass `mode={panelMode}`, `attendance={rollAttendance}`, `guests={minutes.guests}`, `clubGuests={clubGuests}`, `phaseCompleted={phase === "completed"}`, `onSetAttendance={writeAttendance}`, and the two guest handlers.

Build the guest handlers exactly like `writeAttendance` above — through `offline.mutate` with an
`offline.opMeta()` op. **There is no `rollMutate`**; an earlier draft of this line named one and it
never existed. The route already has working `addMinutesGuest` / `removeMinutesGuest` handlers for
the Minutes card at `meeting-minutes.tsx:261-285`, including the `crypto.randomUUID()` client PK
that makes a queued new-guest replay idempotent (#176 slice 5) — lift their bodies rather than
writing new ones, since Task 6 deletes the originals and any difference between the two becomes a
behaviour change hidden inside a deletion.

- [ ] **Step 4: Run and confirm pass**

Run: `bunx vitest run src/routes/attendance-panel-wiring.guard.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove each new guard can fail**

Run each mutation, confirm the named test fails, then restore. **Check the mutation actually applied before trusting a green run** — a replace that silently no-ops reports a false pass, which happened on v1.16.0.0.

| Mutation | Must fail |
|---|---|
| `showRollPanel = runsThisMeeting && minutes.canEdit` | the DP1 gate test |
| in `rollAttendance`, replace the `m.status === null ? [] : [...]` branch with an unconditional `[{ memberId: m.memberId, status: m.status ?? "present" }]` | the recorded-rows test |
| call `setAttendance(...)` directly in `onSetAttendance` | the offline-hook test |

- [ ] **Step 6: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/attendance-panel-wiring.guard.test.ts
git commit -m "feat(attendance): wire roll mode, gated on a signed-in admin

Roll mode is NARROWER than plan mode and that is deliberate (DP1): setAttendance
runs gateAdmin and getMinutes needs a session, so a roster-pick Toastmaster has
no rows and no write that lands. Gated on minutes.canEdit specifically, so the
panel and the Minutes card can never disagree about who may record.

Roll writes go through the lifted offline hook, so a tap on club wifi queues
instead of vanishing."
```

---

## Task 6: Absorb and delete the Minutes AttendanceSection

**Files:**
- Modify: `src/components/club/meeting-minutes.tsx` (delete `AttendanceSection`, its call site, and the now-unused handlers)
- Modify: `src/components/club/meeting-minutes.test.tsx` (drop the section's tests)
- Modify: `src/components/club/absorbed-surfaces.guard.test.ts`

**Interfaces:**
- Consumes: nothing new. Everything the section did now lives in Tasks 3-5.
- Produces: nothing. This is the deletion the spec's "Surfaces absorbed" table calls for.

Do this LAST of the feature tasks. Deleting before the panel is wired leaves meeting day with no attendance surface at all.

- [ ] **Step 1: Write the failing guard**

In `src/components/club/absorbed-surfaces.guard.test.ts`, add to the deleted set. **That file has no
`minutesSrc`** — an earlier draft of this step invented one. Each `it()` there reads its own file
inline with `readFileSync` (see `:23`, `:32`, `:40`), so read the minutes card the same way:

```ts
it("AttendanceSection is gone from the Minutes card", () => {
	// Absorbed into the attendance panel's roll mode (spec "Surfaces absorbed").
	// Two surfaces recording the same rows is how a club ends up with an officer
	// marking someone present in one place and absent in the other.
	const minutes = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "meeting-minutes.tsx"),
		"utf8",
	);
	expect(minutes).not.toContain("AttendanceSection");
	// The card must still POINT at where roll call moved to, or an officer who
	// knows the old location just finds it missing.
	expect(minutes).toContain("Attendance is taken in the Attendance panel");
});
```

Match the path idiom the file already uses for its other reads rather than the one above if they
differ — the point is the inline read, not this exact expression.

**This read is RAW, not comment-blind, and that is deliberate** — a commented-out
`AttendanceSection` block must still fail, which is the right call for a deletion guard. The
consequence to plan for: you cannot leave a breadcrumb comment that NAMES the symbol. A
`// AttendanceSection moved to the attendance panel` note in `meeting-minutes.tsx` fails this
guard. Say "roll call moved to the attendance panel" instead. Do not weaken the guard to allow
the comment.

Dropping the second `not.toContain("function AttendanceSection")` from the earlier draft on
purpose: it can never fail while the line above it passes, and a test that cannot fail is worse
than no test because it reads as coverage.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run src/components/club/absorbed-surfaces.guard.test.ts`
Expected: FAIL — `AttendanceSection` is still present.

- [ ] **Step 3: Delete and link up**

Line numbers verified against HEAD — an earlier draft of this step had both of them wrong, so
trust these and still confirm before cutting:

1. Delete `function AttendanceSection({` (`meeting-minutes.tsx:488`) and its JSX call site, the
   `{meetingDayReached ? (<AttendanceSection … />) : null}` block starting at `:244`.
2. Delete `function GuestAdder({` (`:594`) too. It is called only from `AttendanceSection` (`:586`),
   so it is orphaned by step 1 and strict TS fails the build on it. The earlier draft did not name
   it.
3. Delete the `onSetStatus` / `onAddGuest` / `onRemoveGuest` closures that fed ONLY the section.
   Keep `mutate`, `opMeta` and every other section untouched.
4. Delete `STATUS_LABELS` (`:66`). Its only two uses are `:538` and `:544`, both inside
   `AttendanceSection`, and it is not exported or read anywhere else in `src/`. Check whether the
   `AttendanceStatus` type import it needed is still used after it goes.
5. In its place, one line that tells an officer where roll call went:

```tsx
{meetingDayReached ? (
	<p className="text-sm text-muted-foreground">
		Attendance is taken in the Attendance panel, beside the agenda.
	</p>
) : null}
```

6. Remove the now-unused imports. `setAttendance` (`:52`, used only at `:252`), `addMinutesGuest`
   (`:45`) and `removeMinutesGuest` (`:50`) all fall out, plus whatever the deleted JSX was the last
   consumer of — the `X` icon and the `Popover` / `Command` / `Input` primitives `GuestAdder` used
   are the likely ones, but let the compiler tell you rather than guessing. Strict TS fails the
   build on unused symbols, which is the check that the deletion was complete.

- [ ] **Step 4: Follow the suite failures**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/components/club/meeting-minutes.test.tsx src/components/club/absorbed-surfaces.guard.test.ts`

Delete the tests that covered the SECTION (they tested a deleted surface). Do **not** delete tests that cover the minutes card's other halves. If a deleted test asserted something no Task 3-5 test covers, port the assertion up rather than dropping it — that is the one way this task can silently lose coverage.

- [ ] **Step 5: Confirm the PDF and email are untouched**

Run: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/minutes-pdf-logic.test.ts src/server/minutes-email.integration.test.ts src/server/minutes.integration.test.ts`
Expected: PASS with no edits. `getMinutes` still returns its counts, so the PDF and the emailed minutes are unchanged — the spec says so explicitly, and this run is what makes that claim true rather than hopeful.

- [ ] **Step 6: Commit**

```bash
git add src/components/club/meeting-minutes.tsx src/components/club/meeting-minutes.test.tsx src/components/club/absorbed-surfaces.guard.test.ts
git commit -m "refactor(minutes): absorb AttendanceSection into the attendance panel

Roll call now happens in one place. The Minutes card keeps its counts, the PDF
and the emailed minutes are byte-identical (their suites pass unedited), and the
card points at where the recorder moved so an officer who knows the old spot is
not left guessing."
```

---

## Task 7: The strip stops claiming attendance it cannot know (#548)

**Files:**
- Modify: `src/components/club/meeting-personal-strip.tsx`
- Modify: `src/components/club/meeting-personal-strip.test.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (pass the viewer's own recorded status)

**Interfaces:**
- Consumes: `rollAttendance` from Task 5 and the route's existing `myId`.
- Produces: the strip accepts `myAttendance?: AttendanceStatus | null` — `undefined` means "this viewer cannot be told" (no session), `null` means "session, but nobody recorded a row".

**Read DP2 first.** The distinction between `undefined` and `null` is the whole fix and it is easy to collapse. `undefined` → say nothing about attendance. `null` → a session exists and the row genuinely is not there.

The current statement (`meeting-personal-strip.tsx:60-66`) reads `myStatus`, the PLAN ladder, so it tells anyone who never declared `not_coming` "You attended this meeting." whether or not they turned up. The debt comment at :23 names #548 and must be deleted with the fix, not left pointing at a closed issue.

- [ ] **Step 1: Write the failing tests**

Use the file's OWN idiom — it has a `BASE` fixture and a `renderStrip(overrides)` helper that
renders into the global `screen`, and a file-level `afterEach(cleanup)`. Do not hand-roll
`render(<MeetingPersonalStrip …/>)` beside it, and do not invent a `baseProps`: the fixture is
called `BASE` and `renderStrip` returns nothing, so query through `screen`. `MEMBER` is the
file's existing member fixture. There is no `isSignedIn` prop — a session is `source: "session"`.

```tsx
describe("the over-state attendance statement (#548)", () => {
	/** All three statements end in "this meeting." — asserting on that one pattern
	 *  catches the excused string too. Asserting only /attended/ and /did not
	 *  attend/ would let a wrong "You were excused from this meeting." through. */
	const ANY_STATEMENT = /this meeting\./i;

	it("tells a signed-in member the truth from the RECORDED row", () => {
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: null,
			myAttendance: "present",
		});
		expect(screen.getByText("You attended this meeting.")).toBeTruthy();
		cleanup();

		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			// The plan said COMING and the record says ABSENT. The record wins —
			// that disagreement is exactly the lie #548 filed, so this fixture is
			// the one that separates the two sources.
			myStatus: "coming",
			myAttendance: "absent",
		});
		expect(screen.getByText("You did not attend this meeting.")).toBeTruthy();
		cleanup();

		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: null,
			myAttendance: "excused",
		});
		expect(screen.getByText("You were excused from this meeting.")).toBeTruthy();
	});

	it("says nothing about attendance when nobody recorded a row", () => {
		// A session exists, so we KNOW there is no row. Claiming either way would
		// be inventing a record.
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: "coming",
			myAttendance: null,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});

	it("says nothing about attendance to a viewer we cannot verify", () => {
		// DP2: an anonymous roster-pick member — the dominant identity path here.
		// Telling them anything would need a public array of everyone's
		// attendance, which widens "who was absent" to any visitor, and #574 is
		// still open on a milder version of that.
		renderStrip({
			source: "anon",
			member: MEMBER,
			over: true,
			myStatus: "coming",
			myAttendance: undefined,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});

	it("never derives the statement from the plan ladder", () => {
		// The regression guard. `myStatus` alone must not produce a claim, or the
		// bug walks straight back in the next time someone simplifies this branch.
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: "not_coming",
			myAttendance: undefined,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});
});
```

**Then mutate to prove the last three can fail.** Change the implementation to fall back to
`myStatus` when `myAttendance` is `undefined` and confirm the plan-ladder test fails; re-read the
file to confirm the mutation actually landed before trusting the run. Revert it.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx`
Expected: FAIL — `myAttendance` unknown; the plan-derived statement still renders.

- [ ] **Step 3: Implement**

Replace the over-state block:

```tsx
{!hasIdentity ? null : over ? (
	// From the RECORDED row, never the plan. `undefined` means this viewer
	// cannot be told (no session — see the panel's DP2 note); `null` means a
	// session exists and no row was recorded. Both say nothing rather than
	// inventing a record. Fixes #548.
	myAttendance === undefined || myAttendance === null ? null : (
		<p className="text-sm font-medium text-muted-foreground">
			{myAttendance === "present"
				? "You attended this meeting."
				: myAttendance === "excused"
					? "You were excused from this meeting."
					: "You did not attend this meeting."}
		</p>
	)
) : myStatus === null ? (
```

Delete the `#548` paragraph from the file's doc comment (lines ~23-27) — it describes a bug that no longer exists, and a stale comment pointing at a closed issue is worse than none.

In the route, pass it — `undefined` when there is no session, so the type carries the distinction rather than a second boolean:

```tsx
myAttendance={
	isSignedIn && myId
		? (rollAttendance.find((a) => a.memberId === myId)?.status ?? null)
		: undefined
}
```

- [ ] **Step 4: Run and confirm pass**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx src/components/club/meeting-chrome-composition.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/meeting-personal-strip.tsx src/components/club/meeting-personal-strip.test.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "fix(meeting): stop telling members they attended based on their plan (#548)

The strip read the plan ladder, so anyone who never declared not_coming was told
'You attended this meeting.' whether or not they turned up. It now reads the
recorded meeting_attendance row.

A viewer we cannot verify is told NOTHING rather than given a public array of
everyone's attendance — that would widen 'who was absent' to any visitor, and
#574 is still open on a milder version of the same question. undefined (no
session) and null (session, no row) are deliberately distinct.

Closes #548."
```

---

## Task 8: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Every gate, in CI's form**

```bash
# BOTH env vars, or the run reports green with tests missing. Without
# TEST_DATABASE_URL ~630 integration tests vanish; without CHROME_PATH the two
# browser-backed print suites skip. A skip is not a pass.
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
export CHROME_PATH="$(echo "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell | tr ' ' '\n' | head -1)"
bun run test
bun run typecheck
bun run check          # CI's BARE invocation — NOT `biome check src/`, which covers fewer files
bun run build
bun run db:generate    # MUST report "No schema changes"
```

Three things about that block, each of which has produced a false green in this repo:

- **`bun run check` is the gate; `bunx biome check --diagnostic-level=error` is how you READ it.**
  They are different commands and the earlier draft of this step fused them into one line that was
  neither. Run the bare one to decide pass/fail, then the filtered one to find a real error in the
  ~118 pre-existing `seed.ts` warnings. Do not pin a file count — it moves as files are added, and a
  count in the plan just goes stale.
- **Confirm from the output that the DB-backed and print suites actually RAN.** Check the skip count,
  not just the pass count. `CHROME_PATH` must point at a Playwright `chrome-headless-shell`; do NOT
  point it at `/Applications/Google Chrome.app/...`, which answers `--version` and then never
  returns from `--print-to-pdf`, turning an honest skip into ~135s of `ETIMEDOUT`.
- **`git checkout -- src/routeTree.gen.ts` after `build`** — it appends a block to that tracked file
  that must not be committed.

`db:generate` reporting a diff means D3 was implemented against a schema change it does not need —
stop and re-read the Global Constraints. It reads `drizzle.config.ts`, which loads `.env.local`; if
this worktree has none, `DATABASE_URL` may be unset and the command fails on config rather than on a
real diff. That failure is not a schema drift — say which one you got.

- [ ] **Step 2: Mutation-test every new guard**

For each guard added in Tasks 5-7, break the thing it guards, confirm THAT test fails, restore. **Verify the mutation applied** (diff the file or grep for the removed token) before believing a green run — a no-op replace reports a false pass.

- [ ] **Step 3: Manual pass against a real club**

`bun run dev`, as a signed-in officer:

| Where | Expect |
|---|---|
| **upcoming** meeting | plan mode unchanged from v1.16.0.0 — title "Planned attendance", chase-worthy-first, collapsed below `lg` |
| **today** meeting | title "Attendance"; alphabetical; a member who said Coming shows a dashed `Present?`; ONE tap makes it solid `Present`; counts move; WhatsApp still present; Guests group with "+ Add guest" |
| **completed** meeting | as today, but no WhatsApp/Email anywhere |
| Minutes card, meeting day | no attendance recorder; the line pointing at the panel |
| a **past** meeting, as a member | no "You attended" claim unless a row was actually recorded |
| offline (devtools → Offline), **today** | tapping a chip queues; the offline banner shows; reconnect drains and the row lands |

Then as a **Toastmaster who identified by roster pick** (not signed in): on an **upcoming** meeting the panel is there; on **today** it is absent (DP1). Confirm no error toast fires — absent, not broken.

- [ ] **Step 4: File the DP1 follow-up**

Roll mode is admin-only, so a Toastmaster loses the panel on the day it matters most. File it with the DP1 reasoning and the two options (lift `gateAdmin` on the three minutes fns, or add a TMOD-scoped attendance reader mirroring `getTmodPanelData`). It meets the issue bar: a real capability gap a user hits, not review residue.

- [ ] **Step 5: `/review`, then `/ship`**

Ask `/review` for the ADVERSARIAL pass, not just the specialists. Expect a **MINOR** bump: roll mode is a new capability, and #548 is a user-visible correctness fix.

---

## Self-review

**Spec coverage.** D2's mode table → Tasks 2-3 (title, counts, sort, rows, contact, writes). D3 suggestion rendering → Task 2 (mapping) + Task 3 (dashed chip, one-tap commit). D4 placement → unchanged from PR 2, except roll mode opens on mobile (Task 3, Step 3.6). Guests group → Task 4. Absorbing `AttendanceSection` → Task 6. Offline queue lift → Task 1. Error handling (optimistic rollback, locked = disabled, preview-as-member hidden) → Tasks 3-5, inherited from PR 2's shipped code. Testing §1's seven-module sweep → **already shipped in v1.14.0.0**; not re-done here.

**Gaps I am leaving on purpose, each with its reason in the plan:** pre-meeting guest expectation (spec: out of scope), a "coming but passed on the role" rung (spec: out of scope), reminder sending (#7), backfilling attendance from historical plans (spec: out of scope), and the DP1 Toastmaster gap (Task 8 Step 4 files it).

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the code. Task 3 Step 3 and Task 4 Step 3 describe component structure in prose plus the exact constants and props rather than a full JSX dump — the props, labels, menu items and class names an implementer must match are all literal.

**Type consistency.** `PlanStatus` (type-only from `#/lib/attendance-panel`, pgEnum-derived, never hand-listed) and `AttendanceStatus` (type-only from `#/server/minutes-logic`) are the only status types. `RollRow.status: AttendanceStatus | null` and `RollRow.suggestion: RollSuggestion | null` are mutually exclusive by construction in Task 2 and consumed that way in Task 3. `buildRollPanel` is spelled identically in Tasks 2, 3 and the File Structure. `onSetAttendance(memberId, status)` matches `writeAttendance` in Task 5. `myAttendance?: AttendanceStatus | null` in Task 7 keeps `undefined` and `null` distinct at the type level, which is what DP2 rests on. The guest payload `{ guestId?: string; newGuest?: { name: string; email?: string; phone?: string } }` in Task 4 is the shape `addMinutesGuest` already takes, so Task 5 forwards it unchanged — the first draft of Task 4 wrote it name-only, which would have quietly dropped the email and phone fields the surface being deleted in Task 6 already collects.

**One defect the self-review caught, recorded because it would have stopped Task 5 dead.** The first draft had Task 1 lifting only `mutate` / `opMeta` and Task 5 calling `useOfflineMinutes({ online, draining })` in the route. `online` and `isSignedIn` and `phase` do exist there — `draining` does not; it is a `useState` inside `MeetingMinutes`, bound to the drain effect that also lives there. So `mutate`'s ordering guard would have been reading a variable its new home did not have, and Task 5 would not have compiled. Fixing it surfaced the real constraint (DP3): there is ONE queue per meeting, so the subsystem has one owner, instantiated once in the route. Verified against HEAD by grepping the route for each symbol rather than assuming.
