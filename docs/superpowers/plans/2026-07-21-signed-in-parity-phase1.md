# Signed-in Member Parity — Phase 1 (Capability & Affordance Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a signed-in member full self-serve parity on the meeting view — a signed-in Grammarian edits the Word of the Day and a signed-in Toastmaster (TMOD) gets "Edit meeting", both on `/meetings/$id` — closing #302, with anonymous behavior unchanged.

**Architecture:** Collapse the two `MeetingViewer` adapters (`sessionViewer`, `selfAssertedViewer`) into one `meetingViewer(...)` so capabilities hold by construction, add two edit capabilities (`canEditMeetingMeta`, `canEditWod`), and lift both edit dialogs out of the route files into the shared `<MeetingAgenda>` component so both surfaces inherit them. No schema change, no new server capability (the `updateMeeting` / `updateWordOfTheDay` authz already grants admin / tmod-self-assert / grammarian-self-assert). URLs unchanged.

**Tech Stack:** TanStack Start (React 19), TypeScript strict, Vitest + `@testing-library/react` (jsdom), Biome (tabs, double quotes). Package manager Bun. Import alias `#/*` → `src/*`.

**Source spec:** `docs/superpowers/specs/2026-07-21-signed-in-member-parity-design.md` (Phase 1 section).

**Working directory:** worktree `.claude/worktrees/signed-in-parity-317` (branch `spec/317-signed-in-parity`). Run all commands from there. Verify with `git rev-parse --show-toplevel` before starting.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/lib/meeting-roles.ts` | Role-name matchers + role logic | **Modify** — add `deriveMeetingRoleFlags` |
| `src/lib/meeting-viewer.ts` | The `MeetingViewer` capability object + adapter | **Modify** — add 2 caps, replace 2 adapters with `meetingViewer` |
| `src/lib/meeting-viewer.test.ts` | Adapter unit tests | **Rewrite** — for `meetingViewer` + new caps |
| `src/lib/meeting-lifecycle.ts` | Lifecycle helpers + `lockedViewer` | **Modify** — zero the 2 new caps in `lockedViewer` |
| `src/lib/meeting-lifecycle.test.ts` | Lifecycle tests | **Modify** — update the `selfAssertedViewer` call site |
| `src/components/agenda/meeting-word-of-the-day-dialog.tsx` | Shared focused WOD editor | **Create** (moved from public route) |
| `src/components/agenda/meeting-meta-dialog.tsx` | Shared "Edit meeting" dialog (admin + TMOD) | **Create** (merged from both routes) |
| `src/components/agenda/meeting-agenda.tsx` | Shared agenda component | **Modify** — render both dialogs under the new caps; extend `MeetingAgendaActions` |
| `src/components/agenda/meeting-agenda.test.tsx` | Agenda render tests | **Modify** — migrate call sites; add cap-gated render cases |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Public meeting route | **Modify** — use `meetingViewer` + shared helper; delete inline dialogs + buttons |
| `src/routes/_authed/meetings.$id.tsx` | Authed meeting route | **Modify** — use `meetingViewer` + shared helper; delete inline `EditMeetingDialog` + button |

**Prerequisite facts (verified):** `/meetings/$id` has no admin gate (only the `_authed` signed-in gate), so a signed-in non-admin member already reaches it view-only. `AgendaSlot` (both routes) has `roleName: string` and `assigneeId: string | null`. `updateMeeting` accepts `{ ..., actorMemberId, selfMemberId }` and grants `admin | tmod-self-assert` (reschedule admin-only). `updateWordOfTheDay` accepts `{ meetingId, actorMemberId, selfMemberId, ... }` and grants `admin | tmod-self-assert | grammarian-self-assert`.

---

## Task 1: Unified `meetingViewer` + role-flag helper + capabilities

Replaces the two adapters with one and adds `canEditMeetingMeta` / `canEditWod`, gated on identity, role, and an edit window (locked handled by `lockedViewer`; past handled by an `isEditableWindow` input). Behavior-preserving: the routes are migrated to construct the new viewer but keep their inline dialogs for now, so nothing renders differently yet.

**Files:**
- Modify: `src/lib/meeting-roles.ts`
- Modify: `src/lib/meeting-viewer.ts`
- Modify: `src/lib/meeting-lifecycle.ts`
- Rewrite: `src/lib/meeting-viewer.test.ts`
- Modify: `src/lib/meeting-lifecycle.test.ts`
- Modify: `src/components/agenda/meeting-agenda.test.tsx` (call-site migration only)
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (viewer construction only)
- Modify: `src/routes/_authed/meetings.$id.tsx` (viewer construction only)

- [ ] **Step 1: Write the failing test for `deriveMeetingRoleFlags`**

Append to `src/lib/meeting-roles.ts`'s test file. If none exists, create `src/lib/meeting-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveMeetingRoleFlags } from "./meeting-roles";

describe("deriveMeetingRoleFlags", () => {
	const slots = [
		{ roleName: "Toastmaster of the Day", assigneeId: "tmod-m" },
		{ roleName: "Grammarian", assigneeId: "gram-m" },
		{ roleName: "Timer", assigneeId: "other-m" },
	];

	it("flags the member holding the TMOD slot", () => {
		expect(deriveMeetingRoleFlags(slots, "tmod-m")).toEqual({
			isTmod: true,
			isGrammarian: false,
		});
	});

	it("flags the member holding the Grammarian slot", () => {
		expect(deriveMeetingRoleFlags(slots, "gram-m")).toEqual({
			isTmod: false,
			isGrammarian: true,
		});
	});

	it("flags neither for an unrelated member", () => {
		expect(deriveMeetingRoleFlags(slots, "other-m")).toEqual({
			isTmod: false,
			isGrammarian: false,
		});
	});

	it("flags neither when identity is null", () => {
		expect(deriveMeetingRoleFlags(slots, null)).toEqual({
			isTmod: false,
			isGrammarian: false,
		});
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: FAIL — `deriveMeetingRoleFlags` is not exported.

- [ ] **Step 3: Add `deriveMeetingRoleFlags` to `src/lib/meeting-roles.ts`**

Append after `isGrammarianRoleName`:

```ts
/**
 * The current member's role flags for a meeting, from its slots. Both `false`
 * when `memberId` is null (no identity holds a role). Shared by both meeting
 * surfaces so the TMOD/Grammarian derivation can't drift between them.
 */
export function deriveMeetingRoleFlags(
	slots: { roleName: string; assigneeId: string | null }[],
	memberId: string | null,
): { isTmod: boolean; isGrammarian: boolean } {
	if (memberId === null) return { isTmod: false, isGrammarian: false };
	const tmod =
		slots.find((s) => isTmodRoleName(s.roleName))?.assigneeId ?? null;
	const gram =
		slots.find((s) => isGrammarianRoleName(s.roleName))?.assigneeId ?? null;
	return { isTmod: memberId === tmod, isGrammarian: memberId === gram };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bunx vitest run src/lib/meeting-roles.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite `src/lib/meeting-viewer.test.ts` for the unified adapter**

Replace the whole file:

```ts
import { describe, expect, it } from "vitest";
import { meetingViewer } from "./meeting-viewer";

const base = {
	currentMemberId: "m1",
	canManage: false,
	isTmod: false,
	isGrammarian: false,
	isEditableWindow: true,
};

describe("meetingViewer", () => {
	it("admin gets the full management + meta-edit set, no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, canManage: true });
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false); // admins edit WOD via "Edit meeting"
		expect(v.canToggleAvailability).toBe(true);
	});

	it("a plain member gets self-serve, no management or meta-edit", () => {
		const v = meetingViewer(base);
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canEditMeetingMeta).toBe(false);
		expect(v.canEditWod).toBe(false);
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canEditOwnSpeech).toBe(true);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
	});

	it("a non-admin TMOD gets assign/speakers/meta-edit but no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true });
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false); // TMOD edits WOD via "Edit meeting"
	});

	it("a pure Grammarian (not TMOD, not admin) gets the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isGrammarian: true });
		expect(v.canEditWod).toBe(true);
		expect(v.canEditMeetingMeta).toBe(false);
	});

	it("a TMOD who is also Grammarian uses meta-edit, not the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true, isGrammarian: true });
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
	});

	it("a null identity can do nothing mutating", () => {
		const v = meetingViewer({ ...base, currentMemberId: null });
		expect(v.canClaim).toBe(false);
		expect(v.canReleaseOwn).toBe(false);
		expect(v.canToggleAvailability).toBe(false);
		expect(v.canTakeOver).toBe(false);
		expect(v.canEditOwnSpeech).toBe(false);
	});

	it("a closed edit window disables meta-edit + WOD but leaves claim/release", () => {
		const admin = meetingViewer({
			...base,
			canManage: true,
			isEditableWindow: false,
		});
		expect(admin.canEditMeetingMeta).toBe(false);
		const gram = meetingViewer({
			...base,
			isGrammarian: true,
			isEditableWindow: false,
		});
		expect(gram.canEditWod).toBe(false);
		expect(gram.canClaim).toBe(true);
		expect(gram.canReleaseOwn).toBe(true);
	});
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bunx vitest run src/lib/meeting-viewer.test.ts`
Expected: FAIL — `meetingViewer` is not exported.

- [ ] **Step 7: Rewrite the adapter in `src/lib/meeting-viewer.ts`**

Add `canEditMeetingMeta` and `canEditWod` to the `MeetingViewer` interface (after `canReleaseOwn`), with doc comments:

```ts
	/** Open the "Edit meeting" dialog (theme/location/WOD/notes; reschedule is
	 *  admin-only inside it). Manager surface: admin OR the meeting's TMOD. */
	canEditMeetingMeta: boolean;
	/** Open the focused Word-of-the-Day editor. The pure Grammarian's affordance
	 *  only — admins and the TMOD edit the WOD through "Edit meeting". */
	canEditWod: boolean;
```

Delete `sessionViewer` and `selfAssertedViewer` and their JSDoc; replace with:

```ts
/**
 * The single adapter both meeting surfaces construct (ADR-0008 session and
 * ADR-0010 self-serve converge here). The public route passes `canManage:false`;
 * the authed route passes it from the loader. `isTmod`/`isGrammarian` come from
 * `deriveMeetingRoleFlags`. `isEditableWindow` is false for a PAST meeting — it
 * disables the edit affordances while leaving claim/release available; a LOCKED
 * meeting is handled separately by `lockedViewer`.
 */
export function meetingViewer(input: {
	currentMemberId: string | null;
	canManage: boolean;
	isTmod: boolean;
	isGrammarian: boolean;
	isEditableWindow: boolean;
}): MeetingViewer {
	const hasIdentity = input.currentMemberId !== null;
	const manages = input.canManage;
	const runsMeeting = manages || input.isTmod;
	return {
		currentMemberId: input.currentMemberId,
		canManage: manages,
		canAssign: runsMeeting,
		canManageSpeakers: runsMeeting,
		canEditMeetingMeta: runsMeeting && input.isEditableWindow,
		canToggleAvailability: hasIdentity,
		canTakeOver: hasIdentity,
		canEditOwnSpeech: hasIdentity,
		canClaim: hasIdentity,
		canReleaseOwn: hasIdentity,
		canEditWod:
			input.isGrammarian &&
			!input.isTmod &&
			!manages &&
			input.isEditableWindow,
	};
}
```

- [ ] **Step 8: Extend `lockedViewer` in `src/lib/meeting-lifecycle.ts`**

Add the two new caps (both `false`) to the object returned by `lockedViewer`:

```ts
		canEditMeetingMeta: false,
		canEditWod: false,
```

- [ ] **Step 9: Migrate the remaining call sites so the app compiles**

`src/lib/meeting-lifecycle.test.ts` line ~43 — replace `selfAssertedViewer({ memberId: "m1", isTmod: true })` with:
```ts
meetingViewer({ currentMemberId: "m1", canManage: false, isTmod: true, isGrammarian: false, isEditableWindow: true })
```
and update the import on line 8 from `selfAssertedViewer` to `meetingViewer`.

`src/components/agenda/meeting-agenda.test.tsx` — update the import (line 5) to `import { meetingViewer } from "#/lib/meeting-viewer";`, update the `viewer` param type (line 56) to `ReturnType<typeof meetingViewer>`, and replace every `sessionViewer({ currentMemberId, canManage })` / `selfAssertedViewer({ memberId, isTmod })` call with the equivalent `meetingViewer({ currentMemberId: <id|null>, canManage: <bool>, isTmod: <bool>, isGrammarian: false, isEditableWindow: true })`. (`selfAssertedViewer({ memberId: X, isTmod: Y })` → `meetingViewer({ currentMemberId: X, canManage: false, isTmod: Y, isGrammarian: false, isEditableWindow: true })`; `sessionViewer({ currentMemberId: X, canManage: Y })` → `meetingViewer({ currentMemberId: X, canManage: Y, isTmod: false, isGrammarian: false, isEditableWindow: true })`.)

`src/routes/_authed/meetings.$id.tsx` — replace the import (line 47) `sessionViewer` → `meetingViewer`, add `deriveMeetingRoleFlags` to the `#/lib/meeting-roles` import, and replace line 163:
```ts
	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(slots, currentMemberId);
	const over = meeting.status
		? meetingDatePassed(meeting.scheduledAt, timezone)
		: false;
	const baseViewer = meetingViewer({
		currentMemberId,
		canManage,
		isTmod,
		isGrammarian,
		isEditableWindow: !locked && !over,
	});
```
(Use the existing `locked` variable and `timezone` from the loader data; `meetingDatePassed` is already importable from `#/lib/meeting-lifecycle` — confirm/add it to that import.)

`src/routes/club.$clubId.meeting.$meetingId.tsx` — replace the import (line 56) `selfAssertedViewer` → `meetingViewer`, add `deriveMeetingRoleFlags` to the `#/lib/meeting-roles` import (it already imports `isGrammarianRoleName, isTmodRoleName` — you can drop those if the inline derivation is fully replaced), and replace line 200 (and the inline `isTmod`/`isGrammarian`/`grammarianMemberId` derivation around lines 185–190) with:
```ts
	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(slots, myId);
	const baseViewer = meetingViewer({
		currentMemberId: myId,
		canManage: false,
		isTmod,
		isGrammarian,
		isEditableWindow: !over,
	});
```
Keep the existing `over` variable and the existing `locked ? lockedViewer(baseViewer) : baseViewer` wrapping. The route's inline dialogs still read `isTmod`/`isGrammarian`/`over` — leave those dialogs in place for now (removed in Tasks 2–3).

- [ ] **Step 10: Run the full affected test set**

Run: `bunx vitest run src/lib/meeting-viewer.test.ts src/lib/meeting-roles.test.ts src/lib/meeting-lifecycle.test.ts src/components/agenda/meeting-agenda.test.tsx`
Expected: PASS.
Then: `bun run typecheck` → clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/meeting-viewer.ts src/lib/meeting-viewer.test.ts src/lib/meeting-roles.ts src/lib/meeting-roles.test.ts src/lib/meeting-lifecycle.ts src/lib/meeting-lifecycle.test.ts src/components/agenda/meeting-agenda.test.tsx src/routes/_authed/meetings.\$id.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "refactor(meeting): unify the meeting viewer adapter + role-flag helper (#302)"
```

---

## Task 2: Lift the focused Word-of-the-Day dialog into `<MeetingAgenda>`

Extract the existing `WordOfTheDayDialog` (public route) into a shared component and render it inside `<MeetingAgenda>` under `viewer.canEditWod`, wired via a new action. Remove the inline dialog + button from the public route. After this task the **authed route gains the WOD editor for a signed-in Grammarian** — the #302 WOD half.

**Files:**
- Create: `src/components/agenda/meeting-word-of-the-day-dialog.tsx`
- Modify: `src/components/agenda/meeting-agenda.tsx`
- Modify: `src/components/agenda/meeting-agenda.test.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Create the shared dialog component**

Create `src/components/agenda/meeting-word-of-the-day-dialog.tsx`. Move the body of the existing `WordOfTheDayDialog` function (currently in `src/routes/club.$clubId.meeting.$meetingId.tsx`, the `function WordOfTheDayDialog({...})` block and its JSX) into this new file verbatim, exported as `MeetingWordOfTheDayDialog`. Keep its prop shape exactly (`open`, `onOpenChange`, `meeting`, `actorMemberId`, `selfMemberId`, `onSaved`) and its `updateWordOfTheDay` call. Import `updateWordOfTheDay` from `#/server/meetings` and the UI primitives (`Dialog*`, `Button`, `Input`, `Label`, `Textarea` as used) with `#/*` paths. Type the `meeting` prop as the minimal fields it reads:
```ts
	meeting: {
		id: string;
		wordOfTheDay: string | null;
		wodDefinition: string | null;
		wodExample: string | null;
	};
```

- [ ] **Step 2: Add the WOD action to `MeetingAgendaActions` and render the dialog**

The lifted dialog owns its own save (it calls `updateWordOfTheDay` internally); the shared component owns only the open/close state. So do **not** add a WOD action to `MeetingAgendaActions`. Instead, in `src/components/agenda/meeting-agenda.tsx` add to `MeetingAgendaProps`:
```ts
	/** The meeting's WOD fields + id, for the lifted editors. */
	meeting: {
		id: string;
		wordOfTheDay: string | null;
		wodDefinition: string | null;
		wodExample: string | null;
	};
	/** Identity args the lifted edit dialogs pass to their server fns. */
	actorMemberId: string | null;
	selfMemberId: string | null;
	onMetaSaved: () => void | Promise<void>;
```
- Import `MeetingWordOfTheDayDialog`. Add local open state `const [wodOpen, setWodOpen] = useState(false);`. Where the component renders its header/action row, add, gated on the cap:
```tsx
{viewer.canEditWod ? (
	<Button
		type="button"
		variant="outline"
		size="sm"
		onClick={() => setWodOpen(true)}
	>
		Edit Word of the Day
	</Button>
) : null}
{viewer.canEditWod ? (
	<MeetingWordOfTheDayDialog
		open={wodOpen}
		onOpenChange={setWodOpen}
		meeting={meeting}
		actorMemberId={actorMemberId}
		selfMemberId={selfMemberId}
		onSaved={async () => {
			setWodOpen(false);
			await onMetaSaved();
		}}
	/>
) : null}
```

These new props are **required** on `MeetingAgendaProps`, so the existing test harness must supply them. In `src/components/agenda/meeting-agenda.test.tsx`, add these props to the `<MeetingAgenda>` in the `renderAgenda` helper:
```tsx
			meeting={{ id: "m1", wordOfTheDay: null, wodDefinition: null, wodExample: null }}
			actorMemberId="me"
			selfMemberId="me"
			onMetaSaved={() => {}}
```

- [ ] **Step 3: Write the failing render test**

In `src/components/agenda/meeting-agenda.test.tsx`, add a case using the file's existing `slot(...)` factory and `renderAgenda` harness:
```ts
it("shows the WOD editor to a pure grammarian, hides it from a plain member", () => {
	renderAgenda(
		meetingViewer({ currentMemberId: "me", canManage: false, isTmod: false, isGrammarian: true, isEditableWindow: true }),
		[slot({ status: "open" })],
	);
	expect(screen.getByRole("button", { name: /edit word of the day/i })).toBeInTheDocument();
	cleanup();
	renderAgenda(
		meetingViewer({ currentMemberId: "me", canManage: false, isTmod: false, isGrammarian: false, isEditableWindow: true }),
		[slot({ status: "open" })],
	);
	expect(screen.queryByRole("button", { name: /edit word of the day/i })).toBeNull();
});
```

- [ ] **Step 4: Run it — fails, then passes after Step 2 wiring**

Run: `bunx vitest run src/components/agenda/meeting-agenda.test.tsx`
Expected: the new test PASSES once Steps 1–2 are in; if it fails on missing props, wire `renderAgenda` to supply them.

- [ ] **Step 5: Remove the inline WOD dialog + button from the public route**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`: delete the `function WordOfTheDayDialog(...)` definition (moved), the `{isGrammarian && !isTmod && !over ? (<Button ... Edit Word of the Day)` button block, and the `{isGrammarian && !isTmod && !over ? (<WordOfTheDayDialog ... />)` block. Pass the new props to `<MeetingAgenda>`: `meeting={{ id: meeting.id, wordOfTheDay: meeting.wordOfTheDay, wodDefinition: meeting.wodDefinition, wodExample: meeting.wodExample }}`, `actorMemberId={myId}`, `selfMemberId={myId}`, `onMetaSaved={async () => { await router.invalidate(); }}`. Remove the now-unused `editWodOpen` state.

- [ ] **Step 6: Wire the authed route's new `<MeetingAgenda>` props**

In `src/routes/_authed/meetings.$id.tsx`, pass to `<MeetingAgenda>`: `meeting={{ id: meeting.id, wordOfTheDay: meeting.wordOfTheDay, wodDefinition: meeting.wodDefinition, wodExample: meeting.wodExample }}`, `actorMemberId={currentMemberId}`, `selfMemberId={currentMemberId}`, `onMetaSaved={async () => { await router.invalidate(); }}`. (The authed route keeps its admin `EditMeetingDialog` for now — removed in Task 3.)

- [ ] **Step 7: Verify**

Run: `bunx vitest run src/components/agenda/meeting-agenda.test.tsx` → PASS.
Run: `bun run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/agenda/meeting-word-of-the-day-dialog.tsx src/components/agenda/meeting-agenda.tsx src/components/agenda/meeting-agenda.test.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(meeting): lift the Word-of-the-Day editor into the shared agenda (#302)"
```

---

## Task 3: Unify + lift the "Edit meeting" dialog into `<MeetingAgenda>`

Merge the authed `EditMeetingDialog` (has reschedule) and the public `EditMeetingMetaDialog` (self-assert, no reschedule) into one shared component gated on `viewer.canEditMeetingMeta`, with the reschedule field shown only when `viewer.canManage`. After this task a signed-in non-admin **TMOD gets "Edit meeting"** on `/meetings/$id`.

**Files:**
- Create: `src/components/agenda/meeting-meta-dialog.tsx`
- Modify: `src/components/agenda/meeting-agenda.tsx`
- Modify: `src/components/agenda/meeting-agenda.test.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx`

- [ ] **Step 1: Create the merged shared dialog**

Create `src/components/agenda/meeting-meta-dialog.tsx` exporting `MeetingMetaDialog`. Base it on the existing authed `EditMeetingDialog` (`src/routes/_authed/meetings.$id.tsx`, the `function EditMeetingDialog({...})` block ~L495–L630 with the `updateMeeting` call and the full field set: `scheduledAt`, `lengthMinutes`, `theme`, `location`, `wordOfTheDay`, `wodDefinition`, `wodExample`, `notes`). Modify it:
- Add props `selfMemberId: string | null` and `canReschedule: boolean`.
- Pass `selfMemberId` through to the `updateMeeting({ data: { ..., selfMemberId } })` call (keep `actorMemberId`).
- Wrap the `scheduledAt` and `lengthMinutes` form fields in `{canReschedule ? (<>...</>) : null}` so a TMOD (self-assert) never sees reschedule (the server rejects it anyway). When `!canReschedule`, do not send `scheduledAt`/`lengthMinutes` in the `updateMeeting` payload.
- Prop shape:
```ts
{
	open: boolean;
	onOpenChange: (o: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	actorMemberId: string | null;
	selfMemberId: string | null;
	canReschedule: boolean;
	onSaved: () => void | Promise<void>;
}
```

- [ ] **Step 2: Render it in `<MeetingAgenda>` under the cap**

In `src/components/agenda/meeting-agenda.tsx`: add `const [metaOpen, setMetaOpen] = useState(false);`, extend `MeetingAgendaProps` with `timezone: string;`, import `MeetingMetaDialog`, and render (near the WOD button/dialog):
```tsx
{viewer.canEditMeetingMeta ? (
	<Button type="button" variant="outline" size="sm" onClick={() => setMetaOpen(true)}>
		Edit meeting
	</Button>
) : null}
{viewer.canEditMeetingMeta ? (
	<MeetingMetaDialog
		open={metaOpen}
		onOpenChange={setMetaOpen}
		meeting={meeting}
		timezone={timezone}
		actorMemberId={actorMemberId}
		selfMemberId={selfMemberId}
		canReschedule={viewer.canManage}
		onSaved={async () => {
			setMetaOpen(false);
			await onMetaSaved();
		}}
	/>
) : null}
```
Widen the `meeting` prop type on `MeetingAgendaProps` from the narrow WOD shape (Task 2) to the full `Awaited<ReturnType<typeof getMeeting>>["meeting"]` (the meta dialog needs all fields); the WOD dialog's narrower read still type-checks against it. Then update the `renderAgenda` harness in the test file: add `timezone="UTC"` and widen its `meeting` fixture to a cast full-meeting stub (mirror the file's existing `as unknown as AgendaSlot` cast pattern):
```tsx
			meeting={{ id: "m1", scheduledAt: "2026-01-01T00:00:00Z", lengthMinutes: 90, theme: null, location: null, wordOfTheDay: null, wodDefinition: null, wodExample: null, notes: null } as unknown as MeetingAgendaProps["meeting"]}
			timezone="UTC"
```

- [ ] **Step 3: Failing render test**

Add to `src/components/agenda/meeting-agenda.test.tsx` (using the file's `slot(...)` factory):
```ts
it("shows 'Edit meeting' to a TMOD and an admin, hides it from a plain member", () => {
	for (const v of [
		meetingViewer({ currentMemberId: "me", canManage: false, isTmod: true, isGrammarian: false, isEditableWindow: true }),
		meetingViewer({ currentMemberId: "me", canManage: true, isTmod: false, isGrammarian: false, isEditableWindow: true }),
	]) {
		renderAgenda(v, [slot({ status: "open" })]);
		expect(screen.getByRole("button", { name: /edit meeting/i })).toBeInTheDocument();
		cleanup();
	}
	renderAgenda(
		meetingViewer({ currentMemberId: "me", canManage: false, isTmod: false, isGrammarian: false, isEditableWindow: true }),
		[slot({ status: "open" })],
	);
	expect(screen.queryByRole("button", { name: /edit meeting/i })).toBeNull();
});
```
Ensure `renderAgenda` passes a full `meeting` fixture + `timezone: "UTC"`.

- [ ] **Step 4: Run — PASS after Steps 1–2**

Run: `bunx vitest run src/components/agenda/meeting-agenda.test.tsx` → PASS.

- [ ] **Step 5: Remove the inline meta dialogs from both routes**

- Public route (`src/routes/club.$clubId.meeting.$meetingId.tsx`): delete the `function EditMeetingMetaDialog(...)` definition, its `{isTmod ? (<Button ... Edit meeting)` button, and its `{isTmod && !over ? (<EditMeetingMetaDialog ... />)` render block. Remove the now-unused `editMetaOpen` state. `<MeetingAgenda>` already receives `timezone` — pass `timezone={timezone}`.
- Authed route (`src/routes/_authed/meetings.$id.tsx`): delete the `function EditMeetingDialog(...)` definition (moved+merged), its `{canManage && !locked ? (<Button ... Edit meeting)` button, and the `{canManage ? (<EditMeetingDialog ... />)` render block. Pass `timezone={timezone}` to `<MeetingAgenda>`. Remove now-unused imports (`updateMeeting` if only the dialog used it, dialog-only UI primitives).

- [ ] **Step 6: Verify**

Run: `bunx vitest run src/components/agenda/meeting-agenda.test.tsx` → PASS.
Run: `bun run typecheck` → clean (fix any now-unused-import/param errors — strict TS fails on them).

- [ ] **Step 7: Commit**

```bash
git add src/components/agenda/meeting-meta-dialog.tsx src/components/agenda/meeting-agenda.tsx src/components/agenda/meeting-agenda.test.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(meeting): unify + lift the Edit-meeting dialog into the shared agenda (#302)"
```

---

## Task 4: Full verification + #302 acceptance

**Files:** none (verification only), unless a gap surfaces.

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: clean. Fix any unused-symbol errors from the deletions (strict TS: `noUnusedLocals`/`noUnusedParameters`).

- [ ] **Step 2: Lint/format gate (the real gate)**

Run: `bun run check`
Expected: exit 0. If it reports a format error, run `bunx biome check src --write` and keep only your files' changes.

- [ ] **Step 3: Full test suite**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: all pass. Pay attention to `meeting-agenda.test.tsx`, `meeting-viewer.test.ts`, `meeting-roles.test.ts`, `meeting-lifecycle.test.ts`.

- [ ] **Step 4: Migration no-drift sanity (no schema change expected)**

Run: `bun run db:generate`
Expected: `No schema changes, nothing to migrate`.

- [ ] **Step 5: #302 acceptance (manual reasoning + render coverage)**

Confirm via the agenda tests + a read of the wired routes:
- A signed-in non-admin Grammarian on `/meetings/$id`: `deriveMeetingRoleFlags` → `isGrammarian:true, isTmod:false`, `canManage:false` → `canEditWod:true` → the "Edit Word of the Day" button renders. ✅ #302.
- A signed-in non-admin TMOD on `/meetings/$id`: `isTmod:true` → `canEditMeetingMeta:true` → "Edit meeting" renders (reschedule hidden, `canReschedule=canManage=false`). ✅
- An admin: `canEditMeetingMeta:true`, `canEditWod:false` → one "Edit meeting" (with reschedule), no duplicate WOD editor. ✅
- Anonymous public: unchanged (same caps as before via `meetingViewer(canManage:false, ...)`; over/locked still gate the affordances). ✅

- [ ] **Step 6: Final commit (if Step 2/3 required fixes)**

```bash
git add -A
git commit -m "chore(meeting): phase-1 parity verification fixes (#302)"
```
