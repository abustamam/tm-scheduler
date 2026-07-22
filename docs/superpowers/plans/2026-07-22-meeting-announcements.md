# Meeting Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each meeting an optional Announcements field that organizers edit in the meeting dialog and that displays on the on-screen agenda, all four printed agenda layouts, and the present-mode slide.

**Architecture:** Reuse the existing `meetings.reminders` text column (already validated by `updateMeetingSchema`, persisted by `applyMeetingUpdate`, and returned on every read path). No schema change. A single shared pure helper (`announcementLines`) turns the stored blob into display lines (split `\n` → trim → drop blanks) so every surface renders an identical list. Present mode keeps its existing behavior aside from a one-word title rename.

**Tech Stack:** TanStack Start (React 19), Drizzle/Postgres (unchanged here), shadcn/ui + Tailwind v4, Vitest + @testing-library/react (jsdom), Biome.

---

## Prerequisites

- Work happens in the existing worktree on branch `worktree-feat+meeting-announcements` (already created).
- Run `bun install` once before running any test.
- Run a single test file with `bunx vitest run <path>`.
- Type-check with `bun run typecheck`. Lint/format gate: `bun run check`.
- None of these tests touch the database, so `TEST_DATABASE_URL` is NOT required.

## File structure

| File | Responsibility |
|------|----------------|
| `src/lib/announcement-lines.ts` (new) | Pure `announcementLines()` — split/trim/drop-blank |
| `src/lib/announcement-lines.test.ts` (new) | Unit test for the helper |
| `src/components/agenda/meeting-meta-form.ts` (new) | Pure `meetingUpdateFromForm()` payload builder (extracted from the dialog) |
| `src/components/agenda/meeting-meta-form.test.ts` (new) | Unit test for the builder (asserts `reminders` passthrough) |
| `src/components/agenda/meeting-meta-dialog.tsx` (modify) | Add Announcements `<Textarea>` + notes/announcements visibility copy; use the extracted builder |
| `src/components/agenda/meeting-announcements.tsx` (new) | Presentational on-screen Announcements section (plain, not a callout) |
| `src/components/agenda/meeting-announcements.test.tsx` (new) | jsdom render test for the section |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` (modify) | Render `<MeetingAnnouncements>` under the header |
| `src/lib/slide-layout.ts` (modify) | Rename present-slide title "Reminders" → "Announcements" |
| `src/lib/slide-layout.test.ts` (modify) | Assert the renamed slide title |
| `src/components/agenda/meeting-agenda-print.tsx` (modify) | Add `announcements` to `AgendaHeader`; add `AnnouncementsBlock`; place in all four layouts |
| `src/components/agenda/meeting-agenda-print.test.tsx` (modify) | Per-layout render + two-pager swap tests |
| `src/routes/club.$clubId_.meeting.$meetingId.print.tsx` (modify) | Pass `announcements: meeting.reminders` into the print header |

---

## Task 1: Shared line helper `announcementLines`

**Files:**
- Create: `src/lib/announcement-lines.ts`
- Test: `src/lib/announcement-lines.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/announcement-lines.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { announcementLines } from "./announcement-lines";

describe("announcementLines", () => {
	it("splits on newlines, trims each line, and drops blank lines", () => {
		expect(announcementLines("  Bring a guest  \n\nRenew dues\n")).toEqual([
			"Bring a guest",
			"Renew dues",
		]);
	});

	it("returns [] for null, undefined, or whitespace-only input", () => {
		expect(announcementLines(null)).toEqual([]);
		expect(announcementLines(undefined)).toEqual([]);
		expect(announcementLines("   \n  \t ")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/announcement-lines.test.ts`
Expected: FAIL — cannot resolve `./announcement-lines`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/announcement-lines.ts`:

```ts
/**
 * Turn a stored announcements/reminders blob into display lines: split on
 * newlines, trim each, and drop blank lines. Shared by the on-screen agenda and
 * the printed agenda so both render an identical clean list. Present mode keeps
 * its own blank-line-as-spacer behavior in `slide-layout.ts` — deliberately not
 * this.
 */
export function announcementLines(text: string | null | undefined): string[] {
	if (!text) return [];
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/announcement-lines.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/announcement-lines.ts src/lib/announcement-lines.test.ts
git commit -m "feat(agenda): announcementLines helper (split/trim/drop-blank)"
```

---

## Task 2: Extract `meetingUpdateFromForm` payload builder

Extract the dialog's inline FormData→payload logic into a pure, testable function. This avoids rendering the Radix dialog in jsdom while directly covering the new `reminders` passthrough.

**Files:**
- Create: `src/components/agenda/meeting-meta-form.ts`
- Test: `src/components/agenda/meeting-meta-form.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/agenda/meeting-meta-form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { meetingUpdateFromForm } from "./meeting-meta-form";

function form(fields: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return fd;
}

const ctx = {
	meetingId: "m1",
	actorMemberId: null,
	selfMemberId: null,
	scheduledAt: "2026-07-22T19:00",
};

describe("meetingUpdateFromForm", () => {
	it("passes announcements through as `reminders`, trimming ends but keeping internal newlines", () => {
		const data = meetingUpdateFromForm(
			form({ reminders: "  Bring a guest\nRenew dues  " }),
			ctx,
		);
		expect(data.reminders).toBe("Bring a guest\nRenew dues");
	});

	it("omits reminders (undefined) when the field is blank or absent", () => {
		expect(meetingUpdateFromForm(form({ reminders: "   " }), ctx).reminders).toBeUndefined();
		expect(meetingUpdateFromForm(form({}), ctx).reminders).toBeUndefined();
	});

	it("carries the other meta fields and the provided scheduledAt", () => {
		const data = meetingUpdateFromForm(
			form({ theme: " New Horizons ", lengthMinutes: "75" }),
			ctx,
		);
		expect(data.theme).toBe("New Horizons");
		expect(data.lengthMinutes).toBe(75);
		expect(data.scheduledAt).toBe("2026-07-22T19:00");
		expect(data.meetingId).toBe("m1");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/meeting-meta-form.test.ts`
Expected: FAIL — cannot resolve `./meeting-meta-form`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/agenda/meeting-meta-form.ts`:

```ts
export interface MeetingUpdateFormContext {
	meetingId: string;
	actorMemberId: string | null;
	selfMemberId: string | null;
	/** Already-resolved wall-time string the caller decided on. */
	scheduledAt: string;
}

/**
 * Build the `updateMeeting` payload from the "Edit meeting" form. Pure so it can
 * be unit-tested without rendering the Radix dialog. Empty text fields become
 * `undefined`; the server (`applyMeetingUpdate`) normalizes each to `null`.
 */
export function meetingUpdateFromForm(
	form: FormData,
	ctx: MeetingUpdateFormContext,
) {
	const lengthRaw = String(form.get("lengthMinutes") ?? "").trim();
	return {
		meetingId: ctx.meetingId,
		actorMemberId: ctx.actorMemberId,
		selfMemberId: ctx.selfMemberId,
		scheduledAt: ctx.scheduledAt,
		lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
		theme: String(form.get("theme") ?? "").trim() || undefined,
		location: String(form.get("location") ?? "").trim() || undefined,
		wordOfTheDay: String(form.get("wordOfTheDay") ?? "").trim() || undefined,
		wodDefinition: String(form.get("wodDefinition") ?? "").trim() || undefined,
		wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
		notes: String(form.get("notes") ?? "").trim() || undefined,
		reminders: String(form.get("reminders") ?? "").trim() || undefined,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/agenda/meeting-meta-form.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/agenda/meeting-meta-form.ts src/components/agenda/meeting-meta-form.test.ts
git commit -m "refactor(agenda): extract pure meetingUpdateFromForm builder"
```

---

## Task 3: Wire the builder + Announcements field into the dialog

**Files:**
- Modify: `src/components/agenda/meeting-meta-dialog.tsx`

- [ ] **Step 1: Import the Textarea and the builder**

At the top of `src/components/agenda/meeting-meta-dialog.tsx`, add these imports (keep existing imports):

```ts
import { Textarea } from "#/components/ui/textarea";
import { meetingUpdateFromForm } from "./meeting-meta-form";
```

- [ ] **Step 2: Replace the inline payload construction in `onSubmit`**

Replace this block (currently lines ~66–87):

```ts
		setSubmitting(true);
		try {
			// Only admins get the length field; without it `lengthRaw` is "" →
			// undefined, which leaves the meeting's current length untouched.
			const lengthRaw = String(form.get("lengthMinutes") ?? "").trim();
			await updateMeeting({
				data: {
					meetingId: meeting.id,
					actorMemberId,
					selfMemberId,
					scheduledAt,
					lengthMinutes: lengthRaw ? Number(lengthRaw) : undefined,
					theme: String(form.get("theme") ?? "").trim() || undefined,
					location: String(form.get("location") ?? "").trim() || undefined,
					wordOfTheDay:
						String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					wodDefinition:
						String(form.get("wodDefinition") ?? "").trim() || undefined,
					wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
					notes: String(form.get("notes") ?? "").trim() || undefined,
				},
			});
			toast.success("Meeting updated.");
			await onSaved();
```

with:

```ts
		setSubmitting(true);
		try {
			await updateMeeting({
				data: meetingUpdateFromForm(form, {
					meetingId: meeting.id,
					actorMemberId,
					selfMemberId,
					scheduledAt,
				}),
			});
			toast.success("Meeting updated.");
			await onSaved();
```

- [ ] **Step 3: Add the Announcements field and the notes visibility copy**

Replace the existing Notes block (currently lines ~170–173):

```tsx
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
					</div>
```

with the Announcements field followed by the Notes field (announcements sits with the public fields, above private notes):

```tsx
					<div className="space-y-2">
						<Label htmlFor="reminders">Announcements</Label>
						<Textarea
							id="reminders"
							name="reminders"
							rows={3}
							defaultValue={meeting.reminders ?? ""}
						/>
						<p className="text-xs text-muted-foreground">
							Shown publicly on the agenda, printout, and slides — visible to
							guests. One per line.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
						<p className="text-xs text-muted-foreground">
							Private — only visible to organizers.
						</p>
					</div>
```

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: PASS (no errors). `meeting.reminders` is valid — the `meeting` prop is the full `getMeeting` row, which includes `reminders`.

- [ ] **Step 5: Run the builder test again (guards the refactor)**

Run: `bunx vitest run src/components/agenda/meeting-meta-form.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/agenda/meeting-meta-dialog.tsx
git commit -m "feat(agenda): edit meeting Announcements in the meta dialog"
```

---

## Task 4: On-screen Announcements section component

**Files:**
- Create: `src/components/agenda/meeting-announcements.tsx`
- Test: `src/components/agenda/meeting-announcements.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/agenda/meeting-announcements.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingAnnouncements } from "./meeting-announcements";

afterEach(cleanup);

describe("MeetingAnnouncements", () => {
	it("renders one list item per non-blank line", () => {
		render(<MeetingAnnouncements text={"Bring a guest\n\nRenew dues"} />);
		expect(screen.getByText("Announcements")).toBeTruthy();
		expect(screen.getByText("Bring a guest")).toBeTruthy();
		expect(screen.getByText("Renew dues")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("renders nothing when whitespace-only", () => {
		const { container } = render(<MeetingAnnouncements text={"   \n  "} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when null", () => {
		const { container } = render(<MeetingAnnouncements text={null} />);
		expect(container.firstChild).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/agenda/meeting-announcements.test.tsx`
Expected: FAIL — cannot resolve `./meeting-announcements`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/agenda/meeting-announcements.tsx`:

```tsx
import { Megaphone } from "lucide-react";
import { announcementLines } from "#/lib/announcement-lines";

/**
 * Plain inline "Announcements" section for the on-screen meeting agenda (not a
 * highlighted callout). Renders nothing when there are no announcements.
 */
export function MeetingAnnouncements({
	text,
}: {
	text: string | null | undefined;
}) {
	const lines = announcementLines(text);
	if (lines.length === 0) return null;
	return (
		<section className="space-y-1.5">
			<h2 className="flex items-center gap-1.5 text-sm font-semibold">
				<Megaphone className="size-4 text-primary" aria-hidden />
				Announcements
			</h2>
			<ul className="ml-5 list-disc space-y-1 text-sm text-muted-foreground">
				{lines.map((line, i) => (
					<li key={`${i}-${line}`}>{line}</li>
				))}
			</ul>
		</section>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/agenda/meeting-announcements.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/agenda/meeting-announcements.tsx src/components/agenda/meeting-announcements.test.tsx
git commit -m "feat(agenda): plain on-screen Announcements section component"
```

---

## Task 5: Render Announcements on the on-screen agenda route

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [ ] **Step 1: Import the component**

Add to the imports in `src/routes/club.$clubId.meeting.$meetingId.tsx`:

```ts
import { MeetingAnnouncements } from "#/components/agenda/meeting-announcements";
```

- [ ] **Step 2: Render it between the header and the agenda**

Find the closing `</header>` followed by `<GuestResources />` (around line 387). Insert the announcements section immediately after `</header>`:

```tsx
			</header>

			<MeetingAnnouncements text={meeting.reminders} />

			<GuestResources />
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: PASS. `meeting.reminders` is part of the loaded meeting row.

- [ ] **Step 4: Verify no test regressions in the agenda area**

Run: `bunx vitest run src/components/agenda/meeting-announcements.test.tsx`
Expected: PASS (3 tests). (The route file itself has no unit test; typecheck is the gate.)

- [ ] **Step 5: Commit**

```bash
git add "src/routes/club.\$clubId.meeting.\$meetingId.tsx"
git commit -m "feat(agenda): show Announcements on the meeting agenda"
```

---

## Task 6: Rename the present-mode slide title

**Files:**
- Modify: `src/lib/slide-layout.ts` (the `case "reminders"` descriptor, ~line 179)
- Test: `src/lib/slide-layout.test.ts`

- [ ] **Step 1: Add the failing title assertion**

In `src/lib/slide-layout.test.ts`, inside the existing `describe("slideLayout headers ...")` block (after the `awards` assertion near line 33), add a new `it`:

```ts
	it("titles the reminders slide 'Announcements'", () => {
		expect(contentHeader({ kind: "reminders", text: "Bring a guest" })).toBe(
			"Announcements",
		);
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/slide-layout.test.ts`
Expected: FAIL — received "Reminders", expected "Announcements".

- [ ] **Step 3: Make the change**

In `src/lib/slide-layout.ts`, in the `case "reminders":` block (~line 178), change the title string only:

```ts
		case "reminders":
			return content("Announcements", {
				form: "centered",
				lines: slide.text
					.split("\n")
					.map((t) => (t.trim() ? muted(t.trim()) : SPACER)),
			});
```

(Leave the slide `kind` as `"reminders"` everywhere else — only the visible title changes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/slide-layout.test.ts`
Expected: PASS — including the existing "reminders maps non-blank lines to trimmed muted lines, blanks to spacers" test (unchanged; it asserts body lines, not the title).

- [ ] **Step 5: Commit**

```bash
git add src/lib/slide-layout.ts src/lib/slide-layout.test.ts
git commit -m "feat(present): rename slide title Reminders -> Announcements"
```

---

## Task 7: Print — `AgendaHeader` field, `AnnouncementsBlock`, and one-pager layouts (Grid + Editorial)

**Files:**
- Modify: `src/components/agenda/meeting-agenda-print.tsx`
- Test: `src/components/agenda/meeting-agenda-print.test.tsx`

- [ ] **Step 1: Write the failing tests (Grid + Editorial)**

In `src/components/agenda/meeting-agenda-print.test.tsx`:

First, add `announcements: null` to the shared `header` fixture (it becomes a required field):

```ts
const header: AgendaHeader = {
	clubName: "Downtown Toastmasters",
	clubNumber: "1234",
	district: "District 5",
	mission: null,
	meetingSchedule: null,
	dateLong: "Wednesday, July 22, 2026",
	dateShort: "Wed · Jul 22, 2026",
	timeRange: "7:00 – 8:15 PM",
	theme: "New Horizons",
	wordOfTheDay: "Ebullient",
	location: null,
	announcements: null,
};
```

Then append this `describe` block at the end of the file:

```tsx
describe("MeetingAgendaPrint announcements", () => {
	const withAnnouncements: AgendaHeader = {
		...header,
		announcements: "Bring a guest\n\nRenew your dues",
	};

	function renderWith(layout: AgendaLayout, h: AgendaHeader) {
		return render(
			<MeetingAgendaPrint
				layout={layout}
				header={h}
				roles={[{ label: "Toastmaster", name: "Lee P." }]}
				officers={[]}
				explainers={[]}
				rows={rows}
			/>,
		);
	}

	for (const layout of ["grid", "editorial"] as const) {
		it(`renders the announcements list on the ${layout} one-pager`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getAllByText("Announcements").length).toBeGreaterThan(0);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.getByText("Renew your dues")).toBeTruthy();
		});

		it(`renders no announcements on the ${layout} one-pager when empty`, () => {
			renderWith(layout, header);
			expect(screen.queryByText("Bring a guest")).toBeNull();
		});
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx`
Expected: FAIL — `announcements` is not assignable / not on `AgendaHeader`, and the "Bring a guest" text is not found.

- [ ] **Step 3: Add the `announcements` field to `AgendaHeader`**

In `src/components/agenda/meeting-agenda-print.tsx`, extend the `AgendaHeader` type (currently ends at line ~44):

```ts
export type AgendaHeader = {
	clubName: string;
	clubNumber: string | null;
	district: string | null; // "District 39"
	mission: string | null; // free text, may be multi-line
	meetingSchedule: string | null; // "2nd & 4th Thursday, 6:45–7:45 PM"
	dateLong: string; // "Thursday, June 25, 2026"
	dateShort: string; // "Thu · Jun 25, 2026"
	timeRange: string; // "6:45 – 7:45 PM"
	theme: string | null;
	wordOfTheDay: string | null;
	location: string | null;
	announcements: string | null; // free-text, one per line; null/empty ⇒ hidden
};
```

- [ ] **Step 4: Import `announcementLines` and add the `AnnouncementsBlock` component**

Add the import near the other `#/lib` imports at the top of the file:

```ts
import { announcementLines } from "#/lib/announcement-lines";
```

Add this component next to `NotesBlock` (near line 1569):

```tsx
function AnnouncementsBlock({
	text,
	style,
}: {
	text: string | null;
	style?: React.CSSProperties;
}) {
	const lines = announcementLines(text);
	if (lines.length === 0) return null;
	return (
		<div style={style}>
			<Kick style={{ fontSize: 9.5, marginBottom: 7 }}>Announcements</Kick>
			<ul style={{ margin: 0, paddingLeft: 16, listStyleType: "disc" }}>
				{lines.map((line, i) => (
					<li
						key={`${i}-${line}`}
						style={{
							fontSize: 10.5,
							color: INK,
							lineHeight: 1.4,
							marginBottom: 3,
						}}
					>
						{line}
					</li>
				))}
			</ul>
		</div>
	);
}
```

- [ ] **Step 5: Render in the Grid layout (after Run of Show, before the officer footer)**

In `GridLayout`, find the end of the Run of Show table `</div>` (the closing of the `border`/`borderRadius` wrapper, ~line 743) which is immediately followed by the `{/* officer footer ... */}` comment (~line 745). Insert between them:

```tsx
					</div>

					<AnnouncementsBlock
						text={header.announcements}
						style={{ marginTop: 14 }}
					/>

					{/* officer footer (also carries the club's meets schedule + mission) */}
```

(The block returns `null` when empty, so the Grid is unchanged for meetings with no announcements. `FitPage` scales the sheet to one page if the added content overflows.)

- [ ] **Step 6: Render in the Editorial layout (bottom of the left rail)**

In `EditorialLayout`, find the end of the Club Mission block inside the left rail — the `) : null}` that closes the `{header.mission ? (...) : null}` (~line 564), immediately before the left-rail `</div>` (~line 565). Insert the announcements block after the mission block, still inside the left rail:

```tsx
						) : null}
						<AnnouncementsBlock
							text={header.announcements}
							style={{ marginTop: 14 }}
						/>
					</div>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx`
Expected: PASS — the new grid/editorial announcement tests plus all pre-existing timing/legend tests.

- [ ] **Step 8: Note on typecheck**

Do NOT run a full `bun run typecheck` yet: adding the required `announcements`
field means the print route's `header` literal (Task 9) and the test fixture (done
in Step 1) must also set it. Vitest transpiles without type-checking, so Step 7's
tests pass regardless. Tasks 8 and 9 modify the same files in sequence; the full
project typecheck is run once, green, in Task 10. Proceed to commit.

- [ ] **Step 9: Commit**

```bash
git add src/components/agenda/meeting-agenda-print.tsx src/components/agenda/meeting-agenda-print.test.tsx
git commit -m "feat(agenda): announcements on grid + editorial printouts"
```

---

## Task 8: Print — two-pager conditional swap (Spacious + Timing)

In both two-page layouts, the page-2 row is `NotesBlock` beside `VotesBlock`. Swap `NotesBlock` for `AnnouncementsBlock` **only when announcements exist**; otherwise keep the ruled "Meeting Notes" lines. `VotesBlock` is untouched.

**Files:**
- Modify: `src/components/agenda/meeting-agenda-print.tsx`
- Test: `src/components/agenda/meeting-agenda-print.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("MeetingAgendaPrint announcements", ...)` block in `src/components/agenda/meeting-agenda-print.test.tsx`:

```tsx
	for (const layout of ["spacious", "timing"] as const) {
		it(`${layout}: announcements replace the ruled Meeting Notes lines when present`, () => {
			renderWith(layout, withAnnouncements);
			expect(screen.getByText("Bring a guest")).toBeTruthy();
			expect(screen.queryByText("Meeting Notes")).toBeNull();
			expect(screen.getByText("Tonight's Votes")).toBeTruthy();
		});

		it(`${layout}: keeps the Meeting Notes lines when there are no announcements`, () => {
			renderWith(layout, header);
			expect(screen.getByText("Meeting Notes")).toBeTruthy();
			expect(screen.queryByText("Bring a guest")).toBeNull();
			expect(screen.getByText("Tonight's Votes")).toBeTruthy();
		});
	}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx`
Expected: FAIL — "Meeting Notes" still present when announcements exist; "Bring a guest" not found in these layouts.

- [ ] **Step 3: Swap in the Spacious layout**

In `SpaciousLayout`, replace this row (currently lines ~1084–1087):

```tsx
					<div style={{ display: "flex", gap: 20, marginTop: 22 }}>
						<NotesBlock lines={3} />
						<VotesBlock />
					</div>
```

with:

```tsx
					<div style={{ display: "flex", gap: 20, marginTop: 22 }}>
						{announcementLines(header.announcements).length > 0 ? (
							<AnnouncementsBlock
								text={header.announcements}
								style={{ flex: 1 }}
							/>
						) : (
							<NotesBlock lines={3} />
						)}
						<VotesBlock />
					</div>
```

- [ ] **Step 4: Swap in the Timing layout**

In `TimingLayout`, replace this row (currently lines ~1484–1487):

```tsx
					<div style={{ display: "flex", gap: 16, marginTop: 18 }}>
						<NotesBlock lines={4} />
						<VotesBlock compact />
					</div>
```

with:

```tsx
					<div style={{ display: "flex", gap: 16, marginTop: 18 }}>
						{announcementLines(header.announcements).length > 0 ? (
							<AnnouncementsBlock
								text={header.announcements}
								style={{ flex: 1 }}
							/>
						) : (
							<NotesBlock lines={4} />
						)}
						<VotesBlock compact />
					</div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run src/components/agenda/meeting-agenda-print.test.tsx`
Expected: PASS — all announcement tests (grid, editorial, spacious, timing) plus the pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/agenda/meeting-agenda-print.tsx src/components/agenda/meeting-agenda-print.test.tsx
git commit -m "feat(agenda): announcements swap notes block on two-pager printouts"
```

---

## Task 9: Pass announcements into the print route header

**Files:**
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

- [ ] **Step 1: Add the field to the header object**

In `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`, find the `const header = { ... }` object (~lines 153–165) and add `announcements`:

```ts
	const header = {
		clubName,
		clubNumber,
		district: clubDistrict,
		mission: clubMission,
		meetingSchedule: clubMeetingSchedule,
		dateLong,
		dateShort,
		timeRange: timeRange(startsAt, endsAt, timezone),
		theme: meeting.theme,
		wordOfTheDay: meeting.wordOfTheDay,
		location: meeting.location,
		announcements: meeting.reminders,
	};
```

- [ ] **Step 2: Type-check the whole project**

Run: `bun run typecheck`
Expected: PASS — the print route header now satisfies `AgendaHeader`, and no other `AgendaHeader` literal exists (verify with `grep -rn "AgendaHeader" src` — only the type/uses in `meeting-agenda-print.tsx`, the test fixture, and this route).

- [ ] **Step 3: Commit**

```bash
git add "src/routes/club.\$clubId_.meeting.\$meetingId.print.tsx"
git commit -m "feat(agenda): feed meeting announcements into printouts"
```

---

## Task 10: Full verification

- [ ] **Step 1: Type-check**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: PASS — including the new files:
`announcement-lines.test.ts`, `meeting-meta-form.test.ts`, `meeting-announcements.test.tsx`, updated `slide-layout.test.ts`, updated `meeting-agenda-print.test.tsx`.

- [ ] **Step 3: Lint/format gate**

Run: `bun run check`
Expected: PASS. If Biome reports formatting, run `bun run format` and re-check, then amend the last commit or make a `style:` commit.

- [ ] **Step 4: Manual smoke (optional, recommended)**

Run `bun run dev`, open a meeting you manage, click "Edit meeting", add two announcement lines, save. Confirm:
- The plain Announcements section appears under the header on the agenda.
- `/club/<slug>/meeting/<id>/print?layout=grid` (and `editorial`, `spacious`, `timing`) show the announcements; `spacious`/`timing` show them in place of the Meeting Notes lines.
- Present mode (`/…/present`) shows the slide titled "Announcements".
- Clearing the field and saving removes the section everywhere.

---

## Notes / rationale carried from the spec

- **No schema/migration/server-fn change.** `reminders` is already in `updateMeetingSchema` and persisted by `applyMeetingUpdate` as `input.reminders?.trim() || null`. Sending `undefined` (blank field) clears it; sending text stores it.
- **Editor gate unchanged.** The dialog already renders only under `viewer.canEditMeetingMeta` (admin OR the meeting's TMOD, within the editable window). No new permission.
- **Public visibility** is inherent — `meeting.reminders` is already returned on public read paths, and the agenda/print/slide surfaces are public.
- **One-page guarantee.** Grid/Editorial are wrapped in `FitPage`, which scales the sheet to a single page if content overflows, so the added block cannot force a second page. The two-pagers have room and reuse the notes slot.
