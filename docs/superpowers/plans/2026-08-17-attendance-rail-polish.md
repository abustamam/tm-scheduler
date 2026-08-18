# Planned-Attendance Rail Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the officer's planned-attendance rail readable at 340px — full names, the sign-up
sheet's role codes, icon-only contact actions, role-aware outreach drafts, an inviting unset
state — and stop it chasing members whose role slot is already confirmed.

**Architecture:** One new precedence rule inside the existing pure derivation
(`buildPlanPanel`), a presentational rewrite of one row component, an opt-in `iconOnly` flag on
the shared `NudgeButtons`, and six lines of route wiring that reuse the season grid's own
`buildShortCodes`. No schema change, no server-fn change, no payload change.

**Tech Stack:** React 19 + TanStack Start, TypeScript strict, Tailwind v4 + shadcn/ui, Vitest +
Testing Library, Biome.

**Lint, every task.** The code blocks below are hand-written and are NOT Biome-formatted — Task 1
shipped two `check` violations (an unsorted `import type`, an unexpanded object literal) by
pasting them verbatim, and CI runs the gate. Before committing each task, run it SCOPED to the
files you touched:

```bash
bunx biome check --write <the files this task changed>
bunx biome check --diagnostic-level=error <the files this task changed>
```

Scoped, not `bun run fix` — that writes the whole tree and sweeps in unrelated files.

**Spec:** `docs/superpowers/specs/2026-08-17-attendance-rail-polish-design.md`

**Worktree:** `/media/rasheed-bustamam/Extra/coding/tm-attendance-rail`, branch
`feat/attendance-rail-polish` (already created and bootstrapped — do NOT create another). All
paths below are relative to that worktree.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/attendance-panel.ts` | Pure derivation: rows, precedence, counts, sort | Modify — new `PanelRole` type, `assumed` flag, precedence rule |
| `src/lib/attendance-panel.test.ts` | Gate for the above | Modify — precedence table; update 1 existing test |
| `src/components/club/nudge-buttons.tsx` | Shared WhatsApp/Email draft affordance | Modify — add opt-in `iconOnly` |
| `src/components/club/nudge-buttons.test.tsx` | Gate for the above | Modify — add 2 tests |
| `src/components/club/meeting-attendance-panel.tsx` | The rail | Modify — row layout, badge, role-aware mode, `Ask` |
| `src/components/club/meeting-attendance-panel.test.tsx` | Gate for the above | Modify — 5 new tests; update 2 existing |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Route wiring | Modify — build `panelRoleByMemberId` |
| `src/routes/attendance-rail-wiring.guard.test.ts` | Gate for route-computed props | **Create** |

**Why `PanelRole` lives in `src/lib/attendance-panel.ts` and not in the route:** the route cannot
be mounted in jsdom (the identity gate, a QueryClientProvider and the whole SeasonGrid come with
it), so anything defined there is unassertable. `src/lib/` is reachable from vitest with no
database — this repo's rule for anything worth testing.

---

## Task 1: Precedence rule and the role shape

The load-bearing task. Everything else is presentation.

**Files:**
- Modify: `src/lib/attendance-panel.ts`
- Test: `src/lib/attendance-panel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/attendance-panel.test.ts`. Put the import line at the top beside the existing
one, then append the two `describe` blocks at the end of the file (inside nothing — top level):

```ts
import type { PanelRole, PlanStatus } from "./attendance-panel";
```

```ts
const CONFIRMED: PanelRole = {
	code: "TD",
	roleName: "Toastmaster",
	confirmed: true,
};
const UNCONFIRMED: PanelRole = {
	code: "TD",
	roleName: "Toastmaster",
	confirmed: false,
};

describe("buildPlanPanel — status precedence", () => {
	// The whole table, so no combination is covered "by implication". The one
	// that matters most is `reached_out` + confirmed: a confirmed-role member has
	// NO plan row, so tapping their draft inserts `reached_out` (setPlanStatus's
	// `demoteFrom` is a `setWhere` on the conflict branch, and with no row there
	// is no conflict). Ranked the other way, confirming a Toastmaster and then
	// messaging them drops them from Coming back to Asked.
	const cases: {
		stored: PlanStatus | null;
		role: PanelRole | null;
		status: PlanStatus | null;
		assumed: boolean;
	}[] = [
		{ stored: null, role: null, status: null, assumed: false },
		{ stored: null, role: UNCONFIRMED, status: null, assumed: false },
		{ stored: null, role: CONFIRMED, status: "coming", assumed: true },

		{ stored: "reached_out", role: null, status: "reached_out", assumed: false },
		{
			stored: "reached_out",
			role: UNCONFIRMED,
			status: "reached_out",
			assumed: false,
		},
		{ stored: "reached_out", role: CONFIRMED, status: "coming", assumed: true },

		{ stored: "coming", role: null, status: "coming", assumed: false },
		{ stored: "coming", role: UNCONFIRMED, status: "coming", assumed: false },
		{ stored: "coming", role: CONFIRMED, status: "coming", assumed: false },

		{ stored: "not_coming", role: null, status: "not_coming", assumed: false },
		{
			stored: "not_coming",
			role: UNCONFIRMED,
			status: "not_coming",
			assumed: false,
		},
		// The member's own word beats the inference: a confirmed Toastmaster who
		// tells you the night before that they cannot come is NOT coming.
		{
			stored: "not_coming",
			role: CONFIRMED,
			status: "not_coming",
			assumed: false,
		},
	];

	for (const c of cases) {
		it(`stored=${c.stored ?? "none"} role=${
			c.role ? (c.role.confirmed ? "confirmed" : "unconfirmed") : "none"
		} → ${c.status ?? "none"}${c.assumed ? " (assumed)" : ""}`, () => {
			const { rows } = buildPlanPanel({
				roster: [roster[0]!],
				plan: c.stored ? [{ memberId: "d", status: c.stored }] : [],
				roleByMemberId: c.role ? { d: c.role } : {},
			});
			expect(rows[0]).toMatchObject({ status: c.status, assumed: c.assumed });
		});
	}
});

describe("buildPlanPanel — an assumed Coming is a real Coming", () => {
	it("counts toward `coming`, not toward `noAnswer`", () => {
		const { counts, countsLine } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!], // Dana, Ali
			plan: [],
			roleByMemberId: { a: CONFIRMED },
		});
		expect(counts).toEqual({
			coming: 1,
			notComing: 0,
			reachedOut: 0,
			noAnswer: 1,
		});
		expect(countsLine).toBe("1 coming · 1 no answer");
	});

	it("sorts into the coming bucket, not the chase-me-first bucket", () => {
		// The role goes to ALI on purpose. Ali sorts first alphabetically, so an
		// assumed Coming has to REVERSE the pair to pass — give the role to Dana
		// instead and the expected order is alphabetical either way, and the
		// assertion cannot fail. Dana has answered nothing and holds nothing, so
		// Dana is the one still to chase and sorts first.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!],
			plan: [],
			roleByMemberId: { a: CONFIRMED },
		});
		expect(rows.map((r) => r.id)).toEqual(["d", "a"]);
	});

	it("an UNCONFIRMED role still does not move anyone", () => {
		// Holding a role you have not confirmed is information, not an answer — so
		// the SAME fixture that reversed above must stay alphabetical here. This
		// pair is what makes either assertion able to fail.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!],
			plan: [],
			roleByMemberId: { a: UNCONFIRMED },
		});
		expect(rows.map((r) => r.id)).toEqual(["a", "d"]);
		expect(rows.every((r) => r.status === null)).toBe(true);
	});
});
```

Then REPLACE the existing test `"attaches the role a member holds, and does not reorder for it"`
(currently at lines 73–90) with this version — the role values are objects now, and the comment
has to stop claiming something that is no longer unconditionally true:

```ts
	it("attaches the role a member holds, and an UNCONFIRMED one does not reorder", () => {
		// Holding a role is INFORMATION on the row (spec D2: "assigned members
		// included, with a role chip"), not a bucket. A member with an unconfirmed
		// role who has not answered is still someone to chase. A CONFIRMED role IS
		// a bucket now — see the precedence describe below.
		const { rows } = buildPlanPanel({
			roster,
			plan: [{ memberId: "a", status: "coming" }],
			roleByMemberId: {
				a: { code: "TMR", roleName: "Timer", confirmed: false },
				d: { code: "TD", roleName: "Toastmaster", confirmed: false },
			},
		});
		expect(rows[0]).toMatchObject({ id: "b", role: null });
		expect(rows.find((r) => r.id === "d")?.role).toMatchObject({
			code: "TD",
			roleName: "Toastmaster",
		});
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			role: { code: "TMR", roleName: "Timer" },
			status: "coming",
		});
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-attendance-rail
bunx vitest run src/lib/attendance-panel.test.ts
```

Expected: FAIL. The `PanelRole` import does not resolve, and every precedence case reports
`assumed: undefined`.

- [ ] **Step 3: Implement it**

In `src/lib/attendance-panel.ts`, REPLACE the `PanelMember` interface (currently lines 21–32)
with:

```ts
/** The role slot a member holds on this meeting, as the rail needs it. */
export interface PanelRole {
	/** The sign-up sheet's short code — "TD", "GE", "SP1". Produced by
	 *  `buildShortCodes` (`#/lib/agenda`), the season grid's own function, so the
	 *  two surfaces share one abbreviation vocabulary. NOT one numbering: the
	 *  grid feeds `buildShortCodes` a user-selectable WINDOW of meetings and this
	 *  route feeds one meeting's slots, so the "SP1"/"#2" suffixes can differ. */
	code: string;
	/** The role's BASE name, for the outreach draft ("you're our Toastmaster")
	 *  and for the badge's tooltip. Deliberately NOT the numbered label: "you're
	 *  our Speaker 1" reads as a mail merge, and the agenda's own slot-card nudge
	 *  already uses the base name for the same reason. */
	roleName: string;
	/** The slot's status is `confirmed` — they said yes to the ROLE, which this
	 *  panel reads as saying yes to the meeting. */
	confirmed: boolean;
}

export interface PanelMember {
	id: string;
	name: string;
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	/** The EFFECTIVE rung after the precedence rule below — not necessarily the
	 *  stored one. Counts and sort both read this, which is what makes an assumed
	 *  Coming a real Coming everywhere without a second code path. */
	status: PlanStatus | null;
	/** True when `status` is "coming" because the member holds a CONFIRMED role
	 *  and nobody actually answered. An inference, not their word — the row has
	 *  to render it differently or the rail is lying about who replied. */
	assumed: boolean;
	/** Non-null when they hold a slot on this meeting. */
	role: PanelRole | null;
}
```

REPLACE the `buildPlanPanel` signature and the `rows` construction (currently lines 55–73) with:

```ts
export function buildPlanPanel(input: {
	roster: Omit<PanelMember, "status" | "assumed" | "role">[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Readonly<Record<string, PanelRole>>;
}): {
	rows: PanelMember[];
	counts: PlanPanelCounts;
	countsLine: string;
} {
	const byMember = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the plan rows: an inactive member is
	// filtered upstream but their plan row survives in the table, and iterating
	// the plan would resurrect the name.
	const rows: PanelMember[] = input.roster.map((m) => {
		const stored = byMember.get(m.id) ?? null;
		const role = input.roleByMemberId[m.id] ?? null;
		// PRECEDENCE, in one expression:
		//
		//   explicit coming / not_coming  →  that answer   (their own word wins)
		//   role slot status = confirmed  →  "coming", assumed
		//   stored reached_out            →  "reached_out"
		//   nothing                       →  null
		//
		// A confirmed role outranking `reached_out` is not a style choice. A
		// confirmed-role member has NO plan row, so tapping their WhatsApp draft
		// INSERTS `reached_out` — `setPlanStatus`'s `demoteFrom: ["reached_out"]`
		// guard is a `setWhere` on the conflict branch, and with no existing row
		// there is no conflict, so the insert lands. Ranked the other way, an
		// officer confirms a Toastmaster, messages them, and watches them fall
		// from Coming back to Asked. Ordering it here fixes that with no write
		// change, and KEEPS the `reached_out` row, which is a true record of
		// having messaged them and belongs in the activity log.
		const assumed =
			stored !== "coming" &&
			stored !== "not_coming" &&
			role?.confirmed === true;
		return {
			...m,
			status: assumed ? ("coming" as const) : stored,
			assumed,
			role,
		};
	});
```

Leave the rest of the function (`rankOf`, `rows.sort`, `counts`, `countsLine`) exactly as it is.
It reads `r.status`, which is now the effective value, so an assumed Coming sorts and counts as
a Coming with no second code path. Add this line above the `counts` block:

```ts
	// Both of these read the EFFECTIVE status, so an assumed Coming is a Coming
	// here too. That is the point of resolving precedence once, above.
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bunx vitest run src/lib/attendance-panel.test.ts
```

Expected: PASS, 12 precedence cases + 3 assumed cases + the 6 pre-existing tests.

- [ ] **Step 5: Verify the tests can actually fail (mutation check)**

Do not skip this. This repo has shipped tests that could only pass.

Temporarily change the `assumed` expression to `const assumed = false;` and re-run.
Expected: the 3 CONFIRMED precedence cases and both "assumed Coming" tests FAIL. Then revert.

```bash
bunx vitest run src/lib/attendance-panel.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/attendance-panel.ts src/lib/attendance-panel.test.ts
git commit -m "feat(attendance): a confirmed role outranks reached_out

A confirmed-role member has no plan row, so tapping their draft INSERTS
reached_out (setPlanStatus's demoteFrom is a setWhere on the conflict branch,
and with no row there is no conflict) — which dropped them from Coming back to
Asked. Resolving precedence once in buildPlanPanel fixes it with no write
change and keeps the reached_out row, which is a true record of the message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `iconOnly` on the shared `NudgeButtons`

Opt-in, so the agenda slot cards and the recruit picker are untouched.

**Files:**
- Modify: `src/components/club/nudge-buttons.tsx`
- Test: `src/components/club/nudge-buttons.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append these inside the existing `describe("NudgeButtons", …)` in
`src/components/club/nudge-buttons.test.tsx`. The file already has a shared `base` fixture
(`name: "Jane"`, `mode: "confirm"`, `roleName: "Timer"`, …) and uses `screen` — both are already
imported, so these tests need no new imports.

```tsx
	it("keeps its labels by default, so the agenda and recruit picker are untouched", () => {
		render(<NudgeButtons {...base} phone="14155552671" email="j@x.io" />);
		expect(screen.getByRole("link", { name: "WhatsApp" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Email" })).toBeTruthy();
	});

	it("iconOnly drops the text but NOT the accessible name", () => {
		// The visible text WAS the accessible name. Removing it without putting one
		// back leaves a screen reader announcing "link", and leaves the buttons
		// unqueryable by anything but position. Note the existing tests in this
		// file query `/whatsapp/i`, which matches BOTH the label and the new
		// aria-label — so those cannot catch a missing accessible name, and these
		// assert the exact strings instead.
		render(
			<NudgeButtons {...base} iconOnly phone="14155552671" email="j@x.io" />,
		);
		expect(screen.queryByText("WhatsApp")).toBeNull();
		expect(screen.queryByText("Email")).toBeNull();
		expect(
			screen.getByRole("link", { name: "Message Jane on WhatsApp" }),
		).toBeTruthy();
		expect(screen.getByRole("link", { name: "Email Jane" })).toBeTruthy();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bunx vitest run src/components/club/nudge-buttons.test.tsx
```

Expected: FAIL — `iconOnly` is not a known prop (TS) and the accessible-name queries find
nothing.

- [ ] **Step 3: Implement it**

In `src/components/club/nudge-buttons.tsx`, add the field to `NudgeButtonsBase` (after
`onContacted`):

```ts
	/** Render glyphs with no text label. OPT-IN, because this component is shared
	 *  with the agenda slot cards and the recruit picker, where the words are
	 *  affordable; only the 340px attendance rail needs the space back. */
	iconOnly?: boolean;
```

Add `iconOnly` to the destructure at the top of the component (it is on the base, so it narrows
out of the union cleanly, same as the other fields):

```ts
	const {
		name,
		preferredName,
		phone,
		email,
		meetingDate,
		shareUrl,
		onContacted,
		iconOnly = false,
	} = props;
```

Do NOT add it to the `common` object — `NudgeInput` has no such field and it would fail
typecheck.

REPLACE the returned JSX (currently lines 96–120) with:

```tsx
	return (
		<div className="flex items-center gap-1.5">
			{nudge.whatsappUrl ? (
				<Button asChild size={iconOnly ? "icon-sm" : "sm"} variant="outline">
					<a
						href={nudge.whatsappUrl}
						target="_blank"
						rel="noopener noreferrer"
						onClick={onContacted}
						{...(iconOnly
							? {
									"aria-label": `Message ${name} on WhatsApp`,
									title: `Message ${name} on WhatsApp`,
								}
							: {})}
					>
						<MessageCircle className="size-4" aria-hidden />
						{iconOnly ? null : "WhatsApp"}
					</a>
				</Button>
			) : null}
			{nudge.mailtoUrl ? (
				<Button asChild size={iconOnly ? "icon-sm" : "sm"} variant="outline">
					<a
						href={nudge.mailtoUrl}
						onClick={onContacted}
						{...(iconOnly
							? { "aria-label": `Email ${name}`, title: `Email ${name}` }
							: {})}
					>
						<Mail className="size-4" aria-hidden />
						{iconOnly ? null : "Email"}
					</a>
				</Button>
			) : null}
		</div>
	);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bunx vitest run src/components/club/nudge-buttons.test.tsx
```

Expected: PASS, including every pre-existing test in the file — they exercise the default
(labelled) path, which is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/nudge-buttons.tsx src/components/club/nudge-buttons.test.tsx
git commit -m "feat(nudge): opt-in iconOnly variant with a real accessible name

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The row rewrite

**Files:**
- Modify: `src/components/club/meeting-attendance-panel.tsx`
- Test: `src/components/club/meeting-attendance-panel.test.tsx`

- [ ] **Step 1: Update the test helper and the two tests this change invalidates**

In `src/components/club/meeting-attendance-panel.test.tsx`:

REPLACE the existing test `"shows the role a member holds"` (lines 91–94) with:

```tsx
	it("shows the sign-up sheet's short code, with the full role as its tooltip", () => {
		// The code is the season grid's, produced by the same `buildShortCodes`, so
		// the two surfaces share one abbreviation vocabulary (not one numbering —
		// the suffix is derived per-meeting here, per-window there). The
		// full name rides along as `title` because the code alone is not readable
		// to someone who has not learnt the vocabulary yet.
		const { getByText } = renderPanel({
			roleByMemberId: {
				m2: { code: "TMR", roleName: "Timer", confirmed: false },
			},
		});
		const badge = getByText("TMR");
		expect(badge.getAttribute("title")).toBe("Timer");
	});
```

In `"treats an override of null as cleared, not as absent"` (lines 109–120), change the final
assertion from `.toContain("—")` to:

```tsx
		).toContain("Ask");
```

- [ ] **Step 2: Write the failing tests**

Append these five tests inside the same `describe`:

```tsx
	it("invites a first answer instead of rendering what looks like a deletion", () => {
		const { getByRole } = renderPanel();
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("Ask");
	});

	it("drafts a ROLE confirmation for a member who holds a slot", () => {
		// `mode` is COMPUTED at this call site, which is the #319 trap: a component
		// tested through its props cannot see a WRONG prop, and asserting that a
		// WhatsApp button merely EXISTS passes for either mode. So assert the text
		// the officer would actually send.
		const { getByRole } = renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: false },
			},
		});
		const href =
			getByRole("link", {
				name: /Message Ayesha Khan on WhatsApp/i,
			}).getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).toContain(
			"just confirming you're our Toastmaster",
		);
	});

	it("falls back to the attendance draft for a member with no slot", () => {
		const { getByRole } = renderPanel();
		const href =
			getByRole("link", {
				name: /Message Ayesha Khan on WhatsApp/i,
			}).getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).toContain("are you able to make our");
	});

	it("reads an ASSUMED Coming differently from an answered one", () => {
		// Same word, different accessible name. An officer must be able to tell
		// "she said yes" from "her role is confirmed", or the rail is claiming
		// replies nobody made.
		const { getByRole } = renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		const btn = getByRole("button", { name: /Ayesha Khan status/i });
		expect(btn.textContent).toContain("Coming");
		expect(btn.getAttribute("aria-label")).toMatch(/assumed/i);
	});

	it("renders a long name in full rather than cutting it off", () => {
		const { getByText } = renderPanel({
			roster: [
				{
					id: "m1",
					name: "Bartholomew Featherstonehaugh-Cholmondeley",
					preferredName: null,
					phone: null,
					email: null,
				},
			],
		});
		const el = getByText("Bartholomew Featherstonehaugh-Cholmondeley");
		// HONEST LIMIT: jsdom performs no layout, so the WRAP itself is not
		// assertable in process, and this diff is not worth standing up the
		// headless-Chrome harness for. What IS assertable is the mechanism — the
		// class that caused the cutoff is gone. Do not read a green run here as
		// proof of the rendered geometry.
		expect(el.className).not.toContain("truncate");
	});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
bunx vitest run src/components/club/meeting-attendance-panel.test.tsx
```

Expected: FAIL — the `roleByMemberId` object values do not typecheck against `string`, the
status button reads `—`, and there is no link named `Message Ayesha Khan on WhatsApp`.

- [ ] **Step 4: Implement the row**

In `src/components/club/meeting-attendance-panel.tsx`:

Change the lucide import on line 1 to add `Check`:

```tsx
import { Check, ChevronDown, ChevronUp } from "lucide-react";
```

Change the `#/lib/attendance-panel` import (lines 13–17) to bring in the role type:

```tsx
import {
	buildPlanPanel,
	type PanelMember,
	type PanelRole,
	type PlanStatus,
} from "#/lib/attendance-panel";
```

REPLACE the whole `AttendanceRow` component (currently lines 37–96) with:

```tsx
function AttendanceRow({
	m,
	locked,
	meetingDate,
	shareUrl,
	pending,
	onWriteRung,
	onContacted,
}: {
	m: PanelMember;
	locked: boolean;
	meetingDate: string;
	shareUrl: string;
	pending: boolean;
	onWriteRung: (memberId: string, next: PlanStatus | null) => void;
	onContacted: (memberId: string) => void;
}) {
	// COMPUTED prop, deliberately named. A member holding a slot gets the same
	// draft the agenda's slot card sends — asking "are you coming?" of someone
	// you already put on the programme wastes the ask. Uses the BASE role name,
	// never the numbered code: "you're our Speaker 1" reads as a mail merge.
	const nudgeMode = m.role
		? ({ mode: "confirm" as const, roleName: m.role.roleName })
		: ({ mode: "attendance" as const });

	// An inference must not read as an answer. Same visible word, different
	// accessible name, muted chip.
	const statusAriaLabel = m.assumed
		? `${m.name} status: Coming — assumed, role confirmed`
		: `${m.name} status`;

	return (
		<div className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
			{/* Identity line. The name owns it — at 2-4 characters the role code
			 *  costs it almost nothing, which is the whole reason the code replaced
			 *  the full role name here. */}
			<div className="flex items-start gap-1.5">
				<span className="min-w-0 flex-1 break-words text-sm font-medium">
					{m.name}
				</span>
				{m.role ? (
					<Badge
						variant={m.assumed ? "default" : "secondary"}
						title={m.role.roleName}
						aria-label={m.role.roleName}
						className="mt-0.5 shrink-0"
					>
						{/* An ICON, not a "✓" character: a literal would join the code in
						 *  `textContent` and break every `getByText(code)` query. */}
						{m.assumed ? <Check aria-hidden /> : null}
						{m.role.code}
					</Badge>
				) : null}
			</div>
			{/* Action line. One right-aligned cluster, so every row in the rail
			 *  shares one right edge — this is the alignment fix. Nothing is
			 *  vertically centred across a variable-height block any more. */}
			<div className="flex items-center justify-end gap-1.5">
				<NudgeButtons
					{...nudgeMode}
					iconOnly
					name={m.name}
					preferredName={m.preferredName}
					phone={m.phone}
					email={m.email}
					meetingDate={meetingDate}
					shareUrl={shareUrl}
					onContacted={() => onContacted(m.id)}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							disabled={locked || pending}
							aria-label={statusAriaLabel}
							className={m.assumed ? "text-muted-foreground" : undefined}
						>
							{m.status ? RUNG_LABELS[m.status] : "Ask"}
							<ChevronDown className="size-3.5 opacity-60" aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					{/* "No answer" on an ASSUMED row does not MOVE the row — the
					 *  confirmed slot still stands — but it is not a no-op. If the
					 *  officer already messaged them, `m.storedStatus` is
					 *  `reached_out`, and picking this DELETES that row and writes an
					 *  activity entry while nothing on screen changes. To say they are
					 *  out, the officer picks "Not coming", which is an explicit answer
					 *  and outranks the inference. */}
					<DropdownMenuContent align="end">
						{MENU.map((item) => (
							<DropdownMenuItem
								key={item.label}
								onSelect={() => onWriteRung(m.id, item.status)}
							>
								{item.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
```

Update the panel's own prop type — find `roleByMemberId: Readonly<Record<string, string>>;`
(line 121) and change it to:

```tsx
	roleByMemberId: Readonly<Record<string, PanelRole>>;
```

Nothing else in the file changes: `effectivePlan`, `buildPlanPanel`, the counts line and the
mobile collapse all still work on the same values.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bunx vitest run src/components/club/meeting-attendance-panel.test.tsx
```

Expected: PASS, 15 tests.

- [ ] **Step 6: Verify the role-aware test can fail (mutation check)**

Temporarily force `const nudgeMode = { mode: "attendance" as const };` and re-run.
Expected: `"drafts a ROLE confirmation for a member who holds a slot"` FAILS. Then revert.

- [ ] **Step 7: Commit**

```bash
git add src/components/club/meeting-attendance-panel.tsx src/components/club/meeting-attendance-panel.test.tsx
git commit -m "feat(attendance): rebuild the rail row for a 340px column

Name owns the identity line and wraps instead of truncating; the role becomes
the sign-up sheet's short code with the full name as its tooltip; contact
actions go icon-only; the three controls share one right edge; the unset state
reads Ask rather than an em dash that looked like a deletion. A member holding
a slot now gets the agenda's role-confirmation draft.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Route wiring and its source guard

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx:47` (import), `:566-570` (the maps),
  `:1387` (the prop)
- Create: `src/routes/attendance-rail-wiring.guard.test.ts`

- [ ] **Step 1: Write the failing guard**

Create `src/routes/attendance-rail-wiring.guard.test.ts`:

```ts
// The rail's role map is COMPUTED in the route, and this repo has shipped that
// exact bug before: #319 wired `isMember={shell}` on `club.$clubId.index.tsx`
// and every component test stayed green, because a component tested through its
// props cannot see a WRONG prop. The props ARE the fixture.
//
// Rendering this route to observe the expression is not reachable: it needs a
// QueryClientProvider, the identity gate, the commitments query and the whole
// SeasonGrid. So the gate is a source grep, the same shape
// `club-index-wiring.guard.test.ts` uses for the same reason.
//
// What it pins, and why each one:
//  - `buildShortCodes` is the SEASON GRID's function. Hand-rolling codes here is
//    the failure this is really guarding: the rail would look right and disagree
//    with the sign-up sheet.
//  - the `confirmed` polarity. `s.status === "claimed"` typechecks, renders, and
//    silently marks unconfirmed members as attending.
//  - that the PANEL receives the rich map. `roleByMemberId` (the plain
//    string map) still exists for <MeetingAgenda>, so passing the wrong one is
//    one character away and typechecks only until the shapes diverge.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "this pattern must BE
// present" form, and this very file quotes the patterns it looks for — a raw
// read would pass on a commented-out wiring. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(HERE, "./club.$clubId.meeting.$meetingId.tsx");

describe("attendance rail role wiring", () => {
	const src = readSource(ROUTE);

	it("builds the rail's codes with the sign-up sheet's own function", () => {
		expect(src).toContain("buildShortCodes(");
		expect(src).toContain("panelRoleByMemberId");
	});

	it("reads `confirmed` from the slot status, with the right polarity", () => {
		expect(src).toContain('confirmed: s.status === "confirmed"');
	});

	it("hands the PANEL the rich map, not the agenda's string map", () => {
		expect(src).toContain("roleByMemberId={panelRoleByMemberId}");
	});
});
```

- [ ] **Step 2: Run the guard to verify it fails**

```bash
bunx vitest run src/routes/attendance-rail-wiring.guard.test.ts
```

Expected: FAIL on all three — none of those strings exist in the route yet.

- [ ] **Step 3: Implement the wiring**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`:

Change the import on line 47 to:

```ts
import { buildRoleCounts, buildShortCodes, slotLabel } from "#/lib/agenda";
```

Add a type import beside the other `#/lib` imports:

```ts
import type { PanelRole } from "#/lib/attendance-panel";
```

Directly AFTER the existing `roleByMemberId` loop (currently ending line 570), insert:

```ts
	// The RAIL's own map, deliberately separate from `roleByMemberId` above.
	// That one is read as a plain string by four other consumers
	// (<MeetingAgenda>, <AssignSlotSheet>, <NudgeRecruitPicker>, buildPickerRows)
	// and widening its value type to serve one of them is how a shared map
	// becomes everyone's problem.
	//
	// `buildShortCodes` is the season grid's own function — reusing it is what
	// gives the rail the sign-up sheet's abbreviation VOCABULARY rather than a
	// second hand-maintained list. It does NOT guarantee the same numeric suffix:
	// `buildShortCodes` is a function of the whole row set, and the grid feeds it
	// a user-selectable window of meetings (`?count=`) while this feeds it one
	// meeting's slots.
	const shortCodes = buildShortCodes(
		slots.map((s) => ({
			roleDefinitionId: s.roleDefinitionId,
			slotIndex: s.slotIndex,
			name: s.roleName,
		})),
	);
	const panelRoleByMemberId: Record<string, PanelRole> = {};
	for (const s of slots) {
		if (!s.assigneeId) continue;
		panelRoleByMemberId[s.assigneeId] = {
			code: shortCodes.get(`${s.roleDefinitionId}:${s.slotIndex}`) ?? "?",
			// The BASE role name, not `slotLabel` — the draft says "you're our
			// Speaker", never "you're our Speaker 1".
			roleName: s.roleName,
			confirmed: s.status === "confirmed",
		};
	}
```

At line 1387 (inside `<MeetingAttendancePanel …>`), change:

```tsx
							roleByMemberId={panelRoleByMemberId}
```

Leave line 1170 (`<MeetingAgenda roleByMemberId={roleByMemberId}>`) alone.

- [ ] **Step 4: Run the guard to verify it passes**

```bash
bunx vitest run src/routes/attendance-rail-wiring.guard.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the guard can fail (mutation check)**

Temporarily change the route's `confirmed:` line to `confirmed: s.status === "claimed",` and
re-run. Expected: `"reads `confirmed` from the slot status, with the right polarity"` FAILS.
Then revert.

- [ ] **Step 6: Commit**

```bash
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/attendance-rail-wiring.guard.test.ts
git commit -m "feat(attendance): wire the rail to the sign-up sheet's role codes

buildShortCodes is the season grid's own function and the meeting payload
already carries roleDefinitionId and slotIndex, so the rail's codes agree with
the sign-up sheet's abbreviation vocabulary rather than a second list — though
not its numbering, which is row-set dependent on both sides. The route
cannot mount in jsdom, so the computed prop gets a comment-blind source guard
(#319's shape).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Full gates

Nothing in this change touches the database, but the suite must run WITH one or ~630 integration
tests silently skip and the pass count still reads green.

- [ ] **Step 1: Typecheck**

`bun run build` and `bun run test` both transpile without type-checking. This is the only step
that type-checks, and Tasks 1 and 3 changed a shared interface.

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-attendance-rail
bun run typecheck
```

Expected: no output, exit 0. If `PanelMember.roleName` is still referenced anywhere, it surfaces
here — that is the point of running it before the suite.

- [ ] **Step 2: Full suite, with a database**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
bun run test
```

Expected: all green. Confirm the total is in the ~3,500 range, not ~2,900 — a lower number means
`TEST_DATABASE_URL` did not take and the integration suites skipped.

If `tm_test` is unreachable, check the container is up with `docker ps` (do NOT `docker run` a
new Postgres — it collides on 5432). A `/dev/tcp` probe false-negatives here because `localhost`
resolves to IPv6.

- [ ] **Step 3: Lint gate**

Run it LAST, with CI's bare invocation, and read it at error level — `src/db/seed.ts` carries
~118 pre-existing warnings that bury a real error.

```bash
bunx biome check --diagnostic-level=error
```

If it reports formatting or import-order violations, fix with `bun run fix` (never `--unsafe`,
and never mid-merge), then re-run.

- [ ] **Step 4: Confirm the route tree was not accidentally committed**

`bun run dev` and `bun run build` both append an SSR Register block to `src/routeTree.gen.ts`.

```bash
git status --short
```

Expected: clean. If `src/routeTree.gen.ts` shows as modified, `git checkout src/routeTree.gen.ts`.

- [ ] **Step 5: Push and open the PR**

Per the repo's feature-pipeline order, run `/review` and ask for the ADVERSARIAL pass BEFORE
`/ship` — running the harshest reader last is what turned one round into four on #519.

```bash
git push -u origin feat/attendance-rail-polish
```

`/ship` decides the version bump. This is a user-visible behaviour change (assumed attendance),
not styling alone, so expect MINOR — `1.18.0.1` → `1.19.0.0`.

---

## Manual QA (after `/ship`, or against `bun run dev`)

Not a substitute for the gates — these are the things no test in this plan can see, because
jsdom performs no layout.

- [ ] A member with a long name renders it in full, wrapped, with no ellipsis.
- [ ] The role code and the sign-up sheet's code for the same slot match.
- [ ] Hovering the code shows the full role name.
- [ ] Every row's status control sits on one shared right edge.
- [ ] Confirm a slot on the agenda → that member's rail row moves to Coming with a checked badge,
      and the counts line increments `coming`.
- [ ] With that member still assumed-Coming, tap their WhatsApp icon → the draft says "just
      confirming you're our …", and **the row stays Coming** (this is the regression the
      precedence rule exists to prevent — if it flips to "Asked", Task 1 did not take).
- [ ] Set that member to "Not coming" → it sticks, overriding the confirmed role.
- [ ] The rail still collapses below `lg` and expands on tap.
