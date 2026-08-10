# Meeting Chrome PR 1: Phase Model + Toolbar + Personal Strip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the meeting view's 8-chip toolbar with a phase-aware toolbar (primary + share + one Print & export menu + officer edit group) and fold availability into the personal identity strip.

**Architecture:** A pure `meetingPhase()` derivation joins the existing lifecycle helpers in `src/lib/meeting-lifecycle.ts`. All new chrome is pure, router-light components (`MeetingExportMenu`, `MeetingToolbar`, `MeetingPersonalStrip`) so the phase × persona matrix is jsdom-testable; the route only wires props. `MeetingViewActions` and the standalone `MeetingRoleSheets` popover are retired.

**Tech Stack:** TanStack Start (React 19), shadcn/ui (adds `dropdown-menu`), vitest + Testing Library, TypeScript strict, Biome (tabs, double quotes), `#/*` imports.

**Read first:** spec at `docs/superpowers/specs/2026-08-08-meeting-view-chrome-541.md`; CLAUDE.md sections "Git worktree isolation", "Commands", "Test Coverage".

**Ground rules for every task:** work in this worktree only; run `export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` once per shell before any `bun run test`; `bun run typecheck` is the only type gate; commit after each task with the shown message + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Before Task 1 (review 4A):** `git fetch origin main && git merge origin/main --no-edit` — main moved to v1.9.0.0 (PR #546, guest-resources/roles-guide work) after this plan was written, and #546 touches club-page surfaces near this plan's edit regions. Re-verify Task 7's quoted route anchors against the merged file before editing; the plan anchors by code content, not line numbers, but the content may have shifted.

**Timezone constraint (review 4A, spec D1):** `clubs.timezone` is `notNull default "America/Chicago"` with NO writer anywhere in the app. `meetingPhase` deliberately shares it with `isMeetingOver`/`meetingDatePassed` — a wrong club timezone shifts phase and the agenda freeze IDENTICALLY, so the page never self-contradicts; do NOT "fix" phase to instant-based math (that would make chrome disagree with the freeze at day boundaries). The settable-timezone gap is tracked separately (see #541 thread).

---

### Task 1: `meetingPhase()` in the lifecycle module

**Files:**
- Modify: `src/lib/meeting-lifecycle.ts` (append after `isMeetingOver`)
- Test: `src/lib/meeting-lifecycle.test.ts` (append a new `describe`)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/meeting-lifecycle.test.ts` (it already imports from `./meeting-lifecycle`; extend that import with `meetingPhase`):

```ts
describe("meetingPhase (#541 D1)", () => {
	// HCS shape: 2026-08-11T03:00:00Z is Mon Aug 10, 8:00 PM in Los Angeles —
	// the UTC date is one day AHEAD of the club-local date. Every case below
	// must resolve phase in CLUB time, never UTC.
	const scheduledAt = "2026-08-11T03:00:00.000Z";
	const timezone = "America/Los_Angeles";

	it("is 'upcoming' the club-local day before", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-09T20:00:00.000Z"), // Sun Aug 9, 1pm PT
			}),
		).toBe("upcoming");
	});

	it("is 'today' on the club-local meeting day", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-10T16:00:00.000Z"), // Mon Aug 10, 9am PT
			}),
		).toBe("today");
	});

	it("is 'today' even when the UTC calendar already flipped to the next day", () => {
		// Mon Aug 10, 6pm PT == Tue Aug 11, 01:00 UTC. A UTC-day comparison
		// would call this 'completed'; club-local must call it 'today'.
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-11T01:00:00.000Z"),
			}),
		).toBe("today");
	});

	it("is 'completed' the club-local day after, even if nobody pressed Complete", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-11T20:00:00.000Z"), // Tue Aug 11, 1pm PT
			}),
		).toBe("completed");
	});

	it("is 'completed' whenever the meeting is locked, regardless of date", () => {
		expect(
			meetingPhase({
				status: "completed",
				scheduledAt,
				timezone,
				now: new Date("2026-08-01T00:00:00.000Z"), // long before the meeting
			}),
		).toBe("completed");
	});

	it("does NOT special-case 'cancelled' — phase stays date-based (review 2A)", () => {
		// Deliberate: the spec scopes cancelled rendering to the route, and the
		// phase model must not silently start treating cancelled as completed —
		// that would flip the toolbar on cancelled-meeting pages.
		expect(
			meetingPhase({
				status: "cancelled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-09T20:00:00.000Z"), // day before, club time
			}),
		).toBe("upcoming");
	});
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bunx vitest run src/lib/meeting-lifecycle.test.ts`
Expected: FAIL — `meetingPhase` is not exported.

- [ ] **Step 3: Implement `meetingPhase`**

Append to `src/lib/meeting-lifecycle.ts`:

```ts
/**
 * The meeting's UI phase (#541 D1). Phases re-weight the chrome (which action
 * is primary, how loud Confirm is, whether Minutes starts expanded) — they
 * NEVER hide a capability. Same club-local day granularity and injectable
 * `now` as every helper above; a passed-but-never-completed meeting is
 * "completed" (recording what happened is the page's job there), while
 * `resolveMeetingViewer` still lets an admin edit it until they press
 * Complete — weight and capability are deliberately separate axes.
 */
export type MeetingPhase = "upcoming" | "today" | "completed";

export function meetingPhase(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	now?: Date;
}): MeetingPhase {
	if (isMeetingLocked(input.status)) return "completed";
	const now = input.now ?? new Date();
	if (meetingDatePassed(input.scheduledAt, input.timezone, now))
		return "completed";
	if (meetingDateReached(input.scheduledAt, input.timezone, now))
		return "today";
	return "upcoming";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/lib/meeting-lifecycle.test.ts`
Expected: PASS (all pre-existing tests in the file too).

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-lifecycle.ts src/lib/meeting-lifecycle.test.ts
git commit -m "feat(agenda): meetingPhase — club-local upcoming/today/completed (#541)"
```

---

### Task 2: Add the shadcn dropdown-menu primitive

**Files:**
- Create: `src/components/ui/dropdown-menu.tsx` (generated)

- [ ] **Step 1: Generate the component**

Run: `bunx shadcn@latest add dropdown-menu`
Expected: writes `src/components/ui/dropdown-menu.tsx` and possibly adds a `@radix-ui/react-dropdown-menu` dependency to `package.json`.

- [ ] **Step 2: Verify the tree still typechecks and only intended files changed**

Run: `bun run typecheck && git status --porcelain`
Expected: typecheck clean; changes limited to `src/components/ui/dropdown-menu.tsx`, `package.json`, `bun.lock` (name may be `bun.lockb`). If the generator touched `src/styles.css` or `components.json`, inspect the diff — accept only additive changes.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/dropdown-menu.tsx package.json bun.lock*
git commit -m "chore(ui): add shadcn dropdown-menu (#541)"
```

---

### Task 3: Extract `downloadDeckPptx` (mechanical, keeps PptxDownloadButton working)

The export menu needs the .pptx action as a callable, not a Button. Extract the click handler; the existing button keeps its behavior.

**Files:**
- Modify: `src/components/club/pptx-download-button.tsx`

- [ ] **Step 1: Extract the download body into an exported helper**

In `src/components/club/pptx-download-button.tsx`, add above `PptxDownloadButton`:

```ts
/**
 * The .pptx export action, extracted from the button so the meeting toolbar's
 * export menu (#541) can invoke it too. Returns after the file is written or
 * the failure toast is shown — callers only manage their own busy state.
 */
export async function downloadDeckPptx({
	deck,
	clubName,
	logoUrl,
}: {
	deck: Slide[];
	clubName: string;
	logoUrl: string | null;
}): Promise<void> {
	try {
		const [[{ default: PptxGenJS }, { deckToPptx, pptxFileName }], logo] =
			await Promise.all([
				Promise.all([import("pptxgenjs"), import("#/lib/deck-to-pptx")]),
				fetchClubLogo(logoUrl),
			]);
		const title = deck.find((s) => s.kind === "title");
		const fileName = title
			? pptxFileName(clubName, title.scheduledAt, title.timezone)
			: `${clubName} Agenda.pptx`;
		const pptx = deckToPptx(PptxGenJS, deck, logo);
		await pptx.writeFile({ fileName });
	} catch (err) {
		console.error("pptx export failed", err);
		toast.error("Could not build the PowerPoint file.");
	}
}
```

Then replace the body of the component's inner `download()` with:

```ts
	async function download() {
		if (busy) return;
		setBusy(true);
		try {
			await downloadDeckPptx({ deck, clubName, logoUrl });
		} finally {
			setBusy(false);
		}
	}
```

Delete nothing else — `fetchClubLogo`, `LOGO_FETCH_TIMEOUT_MS`, and the component's props/JSX stay byte-identical.

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bunx vitest run src/components/club/pptx-download-button.test.tsx`
Expected: typecheck clean. If that test file does not exist, run `bunx vitest run src/components/club` and expect the existing club-component suites to pass unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/components/club/pptx-download-button.tsx
git commit -m "refactor(agenda): extract downloadDeckPptx for the export menu (#541)"
```

---

### Task 4: `MeetingExportMenu` component

One `Print & export` dropdown holding every launch/export action. The per-meeting role-sheet PDFs open in a dialog from a menu item (a dropdown can't host a popover).

**Files:**
- Create: `src/components/club/meeting-export-menu.tsx`
- Test: `src/components/club/meeting-export-menu.test.tsx`
- Reference (do not modify yet): `src/components/club/meeting-role-sheets.tsx`, `src/components/club/meeting-view-actions.tsx`, `src/data/role-sheets.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/club/meeting-export-menu.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingExportMenu } from "./meeting-export-menu";

afterEach(cleanup);

const BASE = {
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	wordOfTheDay: null as string | null,
	deck: undefined,
	clubName: undefined,
	presentIsPrimary: false,
};

async function openMenu(overrides: Partial<typeof BASE> = {}) {
	await renderUnderMemoryRouter(<MeetingExportMenu {...BASE} {...overrides} />);
	await userEvent.click(
		screen.getByRole("button", { name: /print & export/i }),
	);
}

describe("MeetingExportMenu (#541 D2)", () => {
	it("always offers Print agenda and All role sheets, pinned to their targets", async () => {
		await openMenu();
		const print = screen.getByRole("menuitem", { name: /print agenda/i });
		expect(print.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/print",
		);
		const roles = screen.getByRole("menuitem", { name: /all role sheets/i });
		expect(roles.closest("a")?.getAttribute("href")).toBe(
			"/club/downtown/roles",
		);
	});

	it("lists Present in the menu only when it is not the toolbar primary", async () => {
		await openMenu({ presentIsPrimary: false });
		expect(
			screen.getByRole("menuitem", { name: /present/i }),
		).toBeTruthy();
	});

	it("omits Present from the menu when the toolbar already leads with it", async () => {
		await openMenu({ presentIsPrimary: true });
		expect(
			screen.queryByRole("menuitem", { name: /^present$/i }),
		).toBeNull();
	});

	it("gates Word poster on a word existing — both branches", async () => {
		await openMenu({ wordOfTheDay: null });
		expect(screen.queryByRole("menuitem", { name: /word poster/i })).toBeNull();
		cleanup();
		await openMenu({ wordOfTheDay: "Buoyant" });
		expect(
			screen
				.getByRole("menuitem", { name: /word poster/i })
				.closest("a")
				?.getAttribute("href"),
		).toContain("/club/downtown/meeting/2026-08-10/word");
	});

	it("opens the per-meeting role-sheet PDFs in a dialog, one link per sheet", async () => {
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		for (const sheet of ROLE_SHEETS) {
			const link = screen.getByText(sheet.title).closest("a");
			expect(link?.getAttribute("href")).toBe(
				`/api/meetings/${BASE.dbMeetingId}/role-sheets/${sheet.key}/pdf`,
			);
		}
	});

	it("shows Download .pptx only when a deck and club name exist", async () => {
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /download \.pptx/i }),
		).toBeNull();
	});
});
```

Notes for the engineer:
- `renderUnderMemoryRouter` — this repo cannot render TanStack `Link` outside a router. Search `src/test/` and existing component tests (`grep -rl "createMemoryHistory\|renderUnderMemoryRouter\|createRouter" src/components src/test`) for the established harness and copy ITS import; if the codebase instead renders such components under a stub router per-test (see `meeting-view-actions.test.tsx` — read it), mirror exactly that pattern and adjust `openMenu` accordingly. Do not invent a new harness.
- Radix menus need a pointer implementation; if `userEvent.click` on the trigger doesn't open the menu under jsdom, use `userEvent.setup({ pointerEventsCheck: 0 })` — check how existing Radix popover tests in this repo (e.g. `meeting-role-sheets.test.tsx`) handle it and copy that.

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/components/club/meeting-export-menu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MeetingExportMenu`**

Create `src/components/club/meeting-export-menu.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import {
	ClipboardList,
	Download,
	FileDown,
	Loader2,
	Printer,
	Presentation,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { downloadDeckPptx } from "#/components/club/pptx-download-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { ROLE_SHEETS } from "#/data/role-sheets";
import type { Slide } from "#/lib/agenda-slides";
import { hasWordOfTheDay } from "#/lib/word-poster";

/**
 * The meeting view's single "Print & export" menu (#541 D2). Replaces the
 * MeetingViewActions chip row + the standalone MeetingRoleSheets popover:
 * every launch/export action lives here, one tap deep, in every phase.
 * Present appears here whenever the toolbar is not already leading with it
 * (deck-testing an upcoming meeting is a real officer behavior), so no
 * capability is ever phase-gated away.
 */
export function MeetingExportMenu({
	clubSlug,
	meetingId,
	dbMeetingId,
	printLayout = "grid",
	deck,
	clubName,
	wordOfTheDay,
	presentIsPrimary,
}: {
	clubSlug: string;
	/** URL key (date or uuid) — used by the print/present/word LINKS. */
	meetingId: string;
	/** Database uuid — used by the per-meeting role-sheet PDF endpoints. */
	dbMeetingId: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	wordOfTheDay: string | null;
	/** True when the toolbar already renders Present as the phase primary. */
	presentIsPrimary: boolean;
}) {
	const [sheetsOpen, setSheetsOpen] = useState(false);
	const [pptxBusy, setPptxBusy] = useState(false);
	const logoUrl =
		deck?.find((s) => s.kind === "title")?.logoUrl ?? null;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						<Printer />
						Print & export
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem asChild>
						<Link
							to="/club/$clubId/meeting/$meetingId/print"
							params={{ clubId: clubSlug, meetingId }}
							search={{ layout: printLayout }}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Printer />
							Print agenda
						</Link>
					</DropdownMenuItem>
					{presentIsPrimary ? null : (
						<DropdownMenuItem asChild>
							<Link
								to="/club/$clubId/meeting/$meetingId/present"
								params={{ clubId: clubSlug, meetingId }}
								target="_blank"
								rel="noopener noreferrer"
							>
								<Presentation />
								Present
							</Link>
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => setSheetsOpen(true)}>
						<FileDown />
						This meeting's role sheets…
					</DropdownMenuItem>
					<DropdownMenuItem asChild>
						<Link
							to="/club/$clubId/roles"
							params={{ clubId: clubSlug }}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ClipboardList />
							All role sheets
						</Link>
					</DropdownMenuItem>
					{hasWordOfTheDay(wordOfTheDay) ? (
						<DropdownMenuItem asChild>
							<Link
								to="/club/$clubId/meeting/$meetingId/word"
								params={{ clubId: clubSlug, meetingId }}
								target="_blank"
								rel="noopener noreferrer"
							>
								<Sparkles />
								Word poster
							</Link>
						</DropdownMenuItem>
					) : null}
					{deck && clubName ? (
						<DropdownMenuItem
							disabled={pptxBusy}
							onSelect={async (e) => {
								// Keep the menu's default close-on-select; the busy state
								// lives on the item for the reopen case.
								e.preventDefault();
								if (pptxBusy) return;
								setPptxBusy(true);
								try {
									await downloadDeckPptx({ deck, clubName, logoUrl });
								} finally {
									setPptxBusy(false);
								}
							}}
						>
							{pptxBusy ? <Loader2 className="animate-spin" /> : <Download />}
							Download .pptx
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={sheetsOpen} onOpenChange={setSheetsOpen}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>This meeting's role sheets</DialogTitle>
					</DialogHeader>
					{/* Same public PDF links the retired MeetingRoleSheets popover
					    served (#365: role-sheet PDFs hold only public-agenda data). */}
					<div className="flex flex-col gap-1">
						{ROLE_SHEETS.map((sheet) => (
							<a
								key={sheet.key}
								href={`/api/meetings/${dbMeetingId}/role-sheets/${sheet.key}/pdf`}
								target="_blank"
								rel="noopener noreferrer"
								className="rounded-md px-2 py-1.5 text-sm hover:bg-muted"
							>
								{sheet.title}
							</a>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
```

Before finalizing, open `src/components/club/meeting-role-sheets.tsx` and `src/data/role-sheets.ts` and mirror the exact link markup/fields the popover used (`sheet.title` vs a description line, download attribute, etc.) — the dialog must serve byte-equivalent links so `meeting-role-sheets.test.tsx`'s assertions can migrate here in Task 6.

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/components/club/meeting-export-menu.test.tsx && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/meeting-export-menu.tsx src/components/club/meeting-export-menu.test.tsx
git commit -m "feat(agenda): Print & export menu — one home for every launch action (#541)"
```

---

### Task 5: `MeetingToolbar` component (phase × persona matrix)

**Files:**
- Create: `src/components/club/meeting-toolbar.tsx`
- Test: `src/components/club/meeting-toolbar.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/club/meeting-toolbar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingToolbar } from "./meeting-toolbar";

afterEach(cleanup);

const BASE = {
	phase: "upcoming" as const,
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	sharePath: "/club/downtown/meeting/2026-08-10",
	wordOfTheDay: null as string | null,
	deck: undefined,
	clubName: undefined,
	hasIdentity: false,
	canManage: false,
	locked: false,
	canComplete: false,
	hasAddableRoles: false,
	lifecycleBusy: false,
	onAddRole: vi.fn(),
	onComplete: vi.fn(),
	onReopen: vi.fn(),
};

async function renderToolbar(overrides: Partial<typeof BASE> = {}) {
	await renderUnderMemoryRouter(<MeetingToolbar {...BASE} {...overrides} />);
}

describe("MeetingToolbar (#541 D2)", () => {
	it("upcoming: no primary — just share and the export menu", async () => {
		await renderToolbar({ phase: "upcoming", hasIdentity: true });
		expect(screen.getByRole("button", { name: /copy share link/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /print & export/i })).toBeTruthy();
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("today + identity: Present is the filled primary, pinned to the present route", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/present/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/present",
		);
	});

	it("today + GUEST (no identity): no primary — spec D2 keeps guest chrome quiet (review 1A)", async () => {
		await renderToolbar({ phase: "today", hasIdentity: false });
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
		// Present stays one tap away for guests: the export menu lists it
		// whenever it is not the primary (asserted in meeting-export-menu.test).
	});

	it("completed + officer: Minutes is the primary and anchors to the minutes section", async () => {
		await renderToolbar({ phase: "completed", canManage: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/minutes/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain("#minutes");
	});

	it("completed + member/guest: no primary — Minutes primary is officer-only per the spec table", async () => {
		await renderToolbar({ phase: "completed", hasIdentity: true, canManage: false });
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("officer edit group renders only for canManage", async () => {
		await renderToolbar({ canManage: false, hasAddableRoles: true });
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		cleanup();
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
		});
		expect(screen.getByRole("button", { name: /add role/i })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /complete meeting/i }),
		).toBeTruthy();
	});

	it("locked meeting offers Reopen (officer) instead of Add role / Complete", async () => {
		await renderToolbar({ canManage: true, locked: true, hasAddableRoles: true });
		expect(screen.getByRole("button", { name: /reopen meeting/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
	});
});
```

(Same router-harness note as Task 4. `ShareLinkButton` renders a button whose accessible name includes "Copy share link" — verify against `src/components/share-link-button.tsx` and adjust the name matcher to its actual label before assuming.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/components/club/meeting-toolbar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `MeetingToolbar`**

Create `src/components/club/meeting-toolbar.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ClipboardList, Loader2, LockOpen, Presentation } from "lucide-react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { MeetingExportMenu } from "#/components/club/meeting-export-menu";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";

/**
 * The meeting view's toolbar (#541 D2): at most four top-level things —
 * a phase-driven primary (today → Present, completed → Minutes anchor,
 * upcoming → none), the share chip, the Print & export menu, and the
 * officer edit group. Pure component so the phase × persona matrix is
 * testable in jsdom; the route only wires props.
 */
export function MeetingToolbar({
	phase,
	clubSlug,
	meetingId,
	dbMeetingId,
	sharePath,
	printLayout,
	deck,
	clubName,
	wordOfTheDay,
	hasIdentity,
	canManage,
	locked,
	canComplete,
	hasAddableRoles,
	lifecycleBusy,
	onAddRole,
	onComplete,
	onReopen,
}: {
	phase: MeetingPhase;
	clubSlug: string;
	meetingId: string;
	dbMeetingId: string;
	sharePath: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	wordOfTheDay: string | null;
	/** Session member OR picked anon identity. Gates the phase primary:
	 *  spec D2 keeps guest chrome quiet (review decision 1A) — guests reach
	 *  Present via the export menu instead. */
	hasIdentity: boolean;
	canManage: boolean;
	locked: boolean;
	canComplete: boolean;
	hasAddableRoles: boolean;
	lifecycleBusy: boolean;
	onAddRole: () => void;
	onComplete: () => void;
	onReopen: () => void;
}) {
	// Spec D2 primary matrix: guests never get a primary; members get Present
	// on meeting day; only officers get the completed-phase Minutes primary.
	const presentIsPrimary = phase === "today" && (hasIdentity || canManage);
	const minutesIsPrimary = phase === "completed" && canManage;
	return (
		<div className="flex flex-wrap items-center gap-2 pt-1">
			{presentIsPrimary ? (
				<Button asChild size="sm" data-testid="toolbar-primary">
					<Link
						to="/club/$clubId/meeting/$meetingId/present"
						params={{ clubId: clubSlug, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Presentation />
						Present
					</Link>
				</Button>
			) : null}
			{minutesIsPrimary ? (
				<Button asChild size="sm" data-testid="toolbar-primary">
					{/* In-page anchor: the minutes section carries id="minutes"
					    (wired in the route in this same PR). */}
					<a href="#minutes">
						<ClipboardList />
						Minutes
					</a>
				</Button>
			) : null}
			<ShareLinkButton path={sharePath} />
			<MeetingExportMenu
				clubSlug={clubSlug}
				meetingId={meetingId}
				dbMeetingId={dbMeetingId}
				printLayout={printLayout}
				deck={deck}
				clubName={clubName}
				wordOfTheDay={wordOfTheDay}
				presentIsPrimary={presentIsPrimary}
			/>
			{canManage && !locked && hasAddableRoles ? (
				<Button size="sm" variant="outline" onClick={onAddRole}>
					+ Add role
				</Button>
			) : null}
			{canManage && locked ? (
				<Button
					size="sm"
					variant="outline"
					onClick={onReopen}
					disabled={lifecycleBusy}
				>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<LockOpen className="size-4" />
					)}
					Reopen meeting
				</Button>
			) : null}
			{canManage && !locked && canComplete ? (
				<Button size="sm" onClick={onComplete} disabled={lifecycleBusy}>
					{lifecycleBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<CheckCircle2 className="size-4" />
					)}
					Complete meeting
				</Button>
			) : null}
		</div>
	);
}
```

Note the edit-group JSX is a lift of the route's existing blocks (`+ Add role` / `Reopen meeting` / `Complete meeting` around `src/routes/club.$clubId.meeting.$meetingId.tsx:668-700`) with `onClick` turned into props — compare against the route before deleting from it in Task 7, and keep any conditions the route has that this sketch missed (e.g. the exact `addableRoles.length > 0` gate becomes the `hasAddableRoles` prop).

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/components/club/meeting-toolbar.test.tsx && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/meeting-toolbar.tsx src/components/club/meeting-toolbar.test.tsx
git commit -m "feat(agenda): phase-aware meeting toolbar (#541)"
```

---

### Task 6: `MeetingPersonalStrip` (identity + availability in one row)

**Files:**
- Create: `src/components/club/meeting-personal-strip.tsx`
- Test: `src/components/club/meeting-personal-strip.test.tsx`
- Reference: `src/components/club/viewing-as.tsx` (kept — the strip composes it)

- [ ] **Step 1: Write the failing tests**

Create `src/components/club/meeting-personal-strip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingPersonalStrip } from "./meeting-personal-strip";

afterEach(cleanup);

const MEMBER = { id: "m1", name: "Nina Petrov" };

const BASE = {
	source: "anon" as "anon" | "session",
	member: null as typeof MEMBER | null,
	promptIdentity: vi.fn(),
	over: false,
	myUnavailable: false,
	availBusy: false,
	canToggleAvailability: true,
	onToggleAvailability: vi.fn(),
	hasIdentity: false,
};

function renderStrip(overrides: Partial<typeof BASE> = {}) {
	render(<MeetingPersonalStrip {...BASE} {...overrides} />);
}

describe("MeetingPersonalStrip (#541 D3)", () => {
	it("guest without identity: viewing-as line, NO availability control", () => {
		renderStrip();
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("anon with identity: signing-up-as line AND the availability chip", () => {
		renderStrip({ member: MEMBER, hasIdentity: true });
		expect(screen.getByText("Nina Petrov")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("signed-in member: chip only, no redundant identity line", () => {
		renderStrip({ source: "session", member: MEMBER, hasIdentity: true });
		expect(screen.queryByText(/signing up as/i)).toBeNull();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("marked unavailable: chip carries the state and the inline undo", async () => {
		const onToggle = vi.fn();
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			myUnavailable: true,
			onToggleAvailability: onToggle,
		});
		const chip = screen.getByRole("button", { name: /undo/i });
		expect(chip.textContent).toMatch(/can't make this one — undo\?/i);
		await userEvent.click(chip);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("meeting over: attendance statement replaces the chip", () => {
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			over: true,
			myUnavailable: false,
		});
		expect(screen.getByText(/you attended this meeting/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("respects canToggleAvailability=false by disabling, not hiding", () => {
		renderStrip({ member: MEMBER, hasIdentity: true, canToggleAvailability: false });
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toHaveProperty("disabled", true);
	});

	it("meeting over + NO identity: viewing-as line only — no attendance claim about nobody (review 3A)", () => {
		renderStrip({ over: true, member: null, hasIdentity: false });
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByText(/attended this meeting/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/components/club/meeting-personal-strip.tsx`:

```tsx
import { Loader2 } from "lucide-react";
import { ViewingAs } from "#/components/club/viewing-as";
import { Button } from "#/components/ui/button";
import type { StoredMember } from "#/lib/member-identity";

/**
 * One row for everything about YOU on the meeting page (#541 D3): identity
 * (anon surfaces only — a session already knows who you are), the
 * availability chip, or the post-meeting attendance statement. Replaces the
 * full-width availability button that used to float among the page actions.
 * No identity → no availability control: the claim flow bootstraps identity
 * when the visitor first acts.
 */
export function MeetingPersonalStrip({
	source,
	member,
	promptIdentity,
	over,
	myUnavailable,
	availBusy,
	canToggleAvailability,
	onToggleAvailability,
	hasIdentity,
}: {
	source: "anon" | "session";
	member: StoredMember | null;
	promptIdentity: () => void;
	over: boolean;
	myUnavailable: boolean;
	availBusy: boolean;
	canToggleAvailability: boolean;
	onToggleAvailability: () => void;
	hasIdentity: boolean;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			{source === "anon" ? (
				<ViewingAs member={member} promptIdentity={promptIdentity} />
			) : null}
			{!hasIdentity ? null : over ? (
				<p className="text-sm font-medium text-muted-foreground">
					{myUnavailable
						? "You did not attend this meeting."
						: "You attended this meeting."}
				</p>
			) : (
				<Button
					type="button"
					variant={myUnavailable ? "default" : "outline"}
					size="sm"
					onClick={onToggleAvailability}
					disabled={!canToggleAvailability || availBusy}
				>
					{availBusy ? (
						<Loader2 className="size-4 animate-spin" />
					) : myUnavailable ? (
						"You can't make this one — undo?"
					) : (
						"I can't make this one"
					)}
				</Button>
			)}
		</div>
	);
}
```

- [ ] **Step 4: Run the tests**

Run: `bunx vitest run src/components/club/meeting-personal-strip.test.tsx && bun run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/meeting-personal-strip.tsx src/components/club/meeting-personal-strip.test.tsx
git commit -m "feat(agenda): personal strip owns identity + availability (#541)"
```

---

### Task 7: Rewire the route; retire `MeetingViewActions` + the standalone popover

**Files:**
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`
- Delete: `src/components/club/meeting-view-actions.tsx`, `src/components/club/meeting-view-actions.test.tsx`, `src/components/club/meeting-role-sheets.tsx`, `src/components/club/meeting-role-sheets.test.tsx`
- Reference: the assertions from both deleted test files must already exist in `meeting-export-menu.test.tsx` (Task 4) — verify before deleting, port any that are missing.

- [ ] **Step 1: Compute the phase in the route**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, next to the existing lifecycle wiring (`const locked = isMeetingLocked(meeting.status);` around line 318 — the file already imports from `#/lib/meeting-lifecycle`; extend that import with `meetingPhase`):

```ts
	const phase = meetingPhase({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
	});
```

- [ ] **Step 2: Replace the availability button + toolbar block**

Replace the region from the `{over ? (` availability/attendance block (route ~line 628) through the closing `</div>` of the `flex flex-wrap items-center gap-2 pt-1` toolbar container (route ~line 700) with:

```tsx
				<MeetingPersonalStrip
					source={source}
					member={member}
					promptIdentity={promptIdentity}
					over={over}
					myUnavailable={myUnavailable}
					availBusy={availBusy}
					canToggleAvailability={viewer.canToggleAvailability}
					onToggleAvailability={toggleAvailability}
				/>
				{/* Task 6 review dropped the hasIdentity prop — the strip derives
				    identity from `member !== null` (two flags no caller could
				    diverge). The TOOLBAR still takes hasIdentity={!!myId}. */}
				<MeetingToolbar
					phase={phase}
					clubSlug={clubId}
					meetingId={urlKey}
					dbMeetingId={meeting.id}
					sharePath={`/club/${clubId}/meeting/${urlKey}`}
					deck={deck}
					clubName={clubName}
					wordOfTheDay={meeting.wordOfTheDay}
					hasIdentity={!!myId}
					canManage={effectiveCanManage}
					locked={locked}
					canComplete={canComplete}
					hasAddableRoles={addableRoles.length > 0}
					lifecycleBusy={lifecycleBusy}
					onAddRole={() => setAddRoleOpen(true)}
					onComplete={doComplete}
					onReopen={doReopen}
				/>
```

Details that MUST be reconciled against the file while editing (names above come from the current file and may drift):
- The old block renders `<ViewingAs …>` under `source === "anon"` a few lines ABOVE the availability button (route ~line 626) — remove that instance; the strip now owns it.
- `hasIdentity`: the route names the current member id `myId` in the `over` branch — grep `myId` in the file and pass its actual truthiness source.
- Delete the now-unused imports (`MeetingViewActions`, `MeetingRoleSheets`, `ViewingAs` if unused elsewhere in the file) — strict TS fails the build on unused imports.
- Keep the `previewAsMember` semantics: the toolbar receives `effectiveCanManage` (already false in preview mode), so Preview-as-member hides the edit group exactly as before. Verify the "Preview as member" toggle itself renders OUTSIDE the replaced region; if it was inside, re-home it next to the toolbar unchanged.

- [ ] **Step 3: Give the minutes section its anchor**

Find the Minutes heading/section in the same route file (search `Minutes`) and add `id="minutes"` to its outer container element, plus `scroll-mt-20` to its className so the sticky header doesn't cover it when the completed-phase primary anchors there.

- [ ] **Step 4: Delete the retired components and their tests**

```bash
git rm src/components/club/meeting-view-actions.tsx src/components/club/meeting-view-actions.test.tsx src/components/club/meeting-role-sheets.tsx src/components/club/meeting-role-sheets.test.tsx
```

Then `grep -rn "MeetingViewActions\|MeetingRoleSheets" src/` — expected: no hits. (If the print/present routes or others import them, STOP: that's an unmapped call site; wire it to the new components the same way before deleting.)

- [ ] **Step 5: Full verification**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
bun run typecheck
bun run test
bun run fix && bunx biome check --diagnostic-level=error
```

Expected: all clean/green — including `meeting-share-label.guard.test.ts` (the share chip still renders one label via `ShareLinkButton` with no `label` override) and the print page-count suite (untouched surfaces).

- [ ] **Step 6: Commit**

```bash
git add -u && git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(agenda): wire phase toolbar + personal strip into the meeting view (#541)"
```

---

### Task 8: Gates, eyeball QA notes, ship prep

- [ ] **Step 1: Full suite + gates one final time** (same commands as Task 7 Step 5). Paste output into the session log — /ship's Step 16 wants fresh evidence.

- [ ] **Step 2: Record what jsdom cannot see** for the /qa pass (do not fake tests for these): menu opens and every item navigates (guest + officer, 375px and desktop); Present renders filled only on a meeting whose club-local day is today (use the HCS seed club — its UTC offset shape is the trap); completed meeting shows Minutes primary and the anchor scrolls; availability chip toggles with inline undo from the strip; guests see no availability control until they pick a name.

- [ ] **Step 3: /ship from this worktree.** Expected review flags to pre-empt in the PR body: the deleted `meeting-view-actions.test.tsx` / `meeting-role-sheets.test.tsx` assertions live on in `meeting-export-menu.test.tsx` (say so explicitly, with the file map); Present/Print are one tap deeper for officers by design (spec D2, grill-locked).

---

## Self-review checklist (author ran this)

- Spec coverage: D1 → Task 1; D2 → Tasks 2–5, 7; D3 → Tasks 6–7; D7 staging → this plan is PR 1 only. D4/D5/D6 are PR 2/3 and deliberately absent.
- Placeholders: none — every code step shows the code; the two "reconcile against the file" notes are verification instructions with named symbols, not deferred design.
- Type consistency: `MeetingPhase` exported once (Task 1) and imported in Task 5; `downloadDeckPptx` signature (Task 3) matches its Task 4 call; `dbMeetingId` vs URL-key `meetingId` distinction is explicit in both components' props.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | SKIPPED (codex_reviews disabled) | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN, 2026-08-08, commit 3bc6d0a) | 4 issues, 0 critical gaps — all folded into this plan (1A primary gating, 2A cancelled pin, 3A over+guest pin, 4A timezone constraint + rebase rule; follow-up filed as #547) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** ENG CLEARED — ready to implement (subagent-driven-development in this worktree, after merging origin/main per the 4A ground rule).

NO UNRESOLVED DECISIONS
