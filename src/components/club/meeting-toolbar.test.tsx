// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The export menu renders the packet dialog (#589), which calls a server fn —
// vitest follows that import into `#/db` where the real build strips it. Same
// hoisted-mock convention as `ballot.test.tsx`.
vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import type { Slide } from "#/lib/agenda-slides";
import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { type LifecycleAction, MeetingToolbar } from "./meeting-toolbar";

const BASE = {
	phase: "upcoming" as MeetingPhase,
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	// Deliberately NOT `/club/${clubSlug}/meeting/${meetingId}`. With the
	// derivable value here, the "passes sharePath through" test below could not
	// fail: replacing `path={sharePath}` with a locally-built template string
	// kept all 22 tests green (mutation-verified in the ship review). The
	// `?from=share` discriminator makes the prop observably the source.
	sharePath: "/club/downtown/meeting/2026-08-10?from=share",
	printLayout: undefined as AgendaLayout | undefined,
	wordOfTheDay: null as string | null,
	deck: undefined as Slide[] | undefined,
	clubName: undefined as string | undefined,
	hasIdentity: false,
	canManage: false,
	locked: false,
	canComplete: false,
	hasAddableRoles: false,
	lifecycleBusy: false,
	onAddRole: vi.fn(),
	onComplete: vi.fn(),
	onReopen: vi.fn(),
	cancelled: undefined as boolean | undefined,
	canCancel: undefined as boolean | undefined,
	canLineupBlast: undefined as boolean | undefined,
	onLineupBlast: undefined as (() => void) | undefined,
	busyAction: undefined as LifecycleAction | null | undefined,
};

afterEach(cleanup);

/**
 * MeetingToolbar renders <Link>s (Present/Minutes/export menu), so mount it
 * under a minimal router — shared with meeting-export-menu.test.tsx via
 * src/test/router-harness.tsx.
 */
async function renderToolbar(overrides: Partial<typeof BASE> = {}) {
	const props = { ...BASE, ...overrides };
	await renderUnderMemoryRouter(<MeetingToolbar {...props} />);
	return props;
}

/** Opens the Manage menu (#1307): the officer extras are menu items now. */
async function openManage() {
	await userEvent.click(screen.getByRole("button", { name: /^manage$/i }));
}
const item = (name: RegExp) => screen.queryByRole("menuitem", { name });

describe("MeetingToolbar (#541 D2)", () => {
	it("upcoming: no primary — just share and the export menu", async () => {
		await renderToolbar({ phase: "upcoming", hasIdentity: true });
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("today + officer: Present is the filled primary, pinned to the present route", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true, canManage: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/present/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/present",
		);
		// Filled weight — Button defaults to variant="default", not "outline",
		// so the phase primary reads as the one emphasized action in the row.
		expect(primary.getAttribute("data-variant")).toBe("default");
		// Opened in a new tab (target="_blank" above) needs noopener so the new
		// page can't reach back into this one via window.opener.
		expect(primary.closest("a")?.getAttribute("rel")).toContain("noopener");
	});

	it("today + member: Present is OUTLINE (the member's filled action is I'll be there), touch sized", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.getAttribute("data-variant")).toBe("outline");
		expect(primary.getAttribute("data-size")).toBe("touch");
		expect(
			document.querySelectorAll('[data-slot="button"][data-variant="default"]'),
		).toHaveLength(0);
	});

	it("Present, Share link and Print & export use the touch height", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		expect(screen.getByTestId("toolbar-primary").dataset.size).toBe("touch");
		expect(
			screen.getByRole("button", { name: /copy share link/i }).className,
		).toContain("h-11");
		expect(
			screen.getByRole("button", { name: /print & export/i }).dataset.size,
		).toBe("touch");
	});

	it("today + GUEST (no identity): no primary, but share + the export menu stay reachable (spec D2 guest row)", async () => {
		await renderToolbar({ phase: "today", hasIdentity: false });
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
		// Present stays one tap away for guests: the export menu lists it
		// whenever it is not the primary (asserted in meeting-export-menu.test).
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
	});

	it("today + officer without personal identity still gets the primary (canManage counts)", async () => {
		await renderToolbar({
			phase: "today",
			hasIdentity: false,
			canManage: true,
		});
		expect(screen.getByTestId("toolbar-primary").textContent).toMatch(
			/present/i,
		);
	});

	it("completed + officer: Minutes is the primary and anchors to the minutes section", async () => {
		await renderToolbar({ phase: "completed", canManage: true });
		const primary = screen.getByTestId("toolbar-primary");
		expect(primary.textContent).toMatch(/minutes/i);
		expect(primary.closest("a")?.getAttribute("href")).toContain("#minutes");
	});

	it("completed + member/guest: no primary — Minutes primary is officer-only per the spec table", async () => {
		await renderToolbar({
			phase: "completed",
			hasIdentity: true,
			canManage: false,
		});
		expect(screen.queryByTestId("toolbar-primary")).toBeNull();
	});

	it("today + identity: Present is already the toolbar primary, so the export menu omits it", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(screen.queryByRole("menuitem", { name: /^present$/i })).toBeNull();
	});

	it("upcoming: no toolbar primary, so the export menu hands Present back", async () => {
		await renderToolbar({ phase: "upcoming", hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(screen.getByRole("menuitem", { name: /^present$/i })).toBeTruthy();
	});

	it("officer edit group renders only for canManage, as Manage menu items", async () => {
		await renderToolbar({ canManage: false, hasAddableRoles: true });
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		cleanup();
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
		});
		// Not top-level buttons any more.
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
		await openManage();
		expect(item(/add role/i)).toBeTruthy();
		expect(item(/complete meeting/i)).toBeTruthy();
		expect(item(/promote/i)).toBeTruthy();
	});

	it("Manage items come in the specified order, Cancel last behind a separator", async () => {
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
			canCancel: true,
			canLineupBlast: true,
		});
		await openManage();
		expect(
			screen.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
		).toEqual([
			"Promote",
			"Add role",
			"Lineup blast",
			"Complete meeting",
			"Cancel meeting",
		]);
		expect(item(/cancel meeting/i)?.getAttribute("data-variant")).toBe(
			"destructive",
		);
		expect(screen.getByRole("separator")).toBeTruthy();
	});

	it("Manage trigger is hidden when no item is visible, and shows for lineup access alone", async () => {
		// A member with nothing: no trigger.
		await renderToolbar({ canManage: false });
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		cleanup();
		// A cancelled meeting empties an officer's menu too.
		await renderToolbar({ canManage: true, cancelled: true });
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		cleanup();
		// A member with lineup access: Manage with ONLY Lineup blast.
		const onLineupBlast = vi.fn();
		await renderToolbar({
			canManage: false,
			canLineupBlast: true,
			onLineupBlast,
		});
		await openManage();
		expect(
			screen.getAllByRole("menuitem").map((el) => el.textContent?.trim()),
		).toEqual(["Lineup blast"]);
		await userEvent.click(item(/lineup blast/i) as HTMLElement);
		expect(onLineupBlast).toHaveBeenCalledTimes(1);
	});

	it("locked meeting offers Reopen (officer) instead of Add role / Complete", async () => {
		await renderToolbar({
			canManage: true,
			locked: true,
			hasAddableRoles: true,
			canComplete: true,
		});
		await openManage();
		expect(item(/reopen meeting/i)).toBeTruthy();
		expect(item(/add role/i)).toBeNull();
		expect(item(/complete meeting/i)).toBeNull();
	});

	it("wires the edit-group handlers", async () => {
		const onAddRole = vi.fn();
		const onComplete = vi.fn();
		await renderToolbar({
			canManage: true,
			hasAddableRoles: true,
			canComplete: true,
			onAddRole,
			onComplete,
		});
		await openManage();
		await userEvent.click(item(/add role/i) as HTMLElement);
		await openManage();
		await userEvent.click(item(/complete meeting/i) as HTMLElement);
		expect(onAddRole).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	// Persona × phase cell the matrix above skips: every locked-meeting case
	// sets canManage. `Reopen meeting` is gated on `canManage && locked`, and
	// the only test that varies canManage does it on an UNLOCKED meeting — so
	// dropping the canManage half of that condition passes the whole suite while
	// handing a member (or an officer previewing as one, which is the same prop)
	// a button that unlocks the club's completed minutes.
	it("member/guest on a locked meeting gets NO officer controls at all", async () => {
		await renderToolbar({
			phase: "completed",
			hasIdentity: true,
			canManage: false,
			locked: true,
			canComplete: true,
			hasAddableRoles: true,
		});
		// No Manage trigger at all, so no item can be reached.
		expect(screen.queryByRole("button", { name: /^manage$/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /reopen meeting/i }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /add role/i })).toBeNull();
		expect(
			screen.queryByRole("button", { name: /complete meeting/i }),
		).toBeNull();
		// …but the read-only affordances stay: a locked meeting is still shareable
		// and still printable by everyone (#365).
		expect(
			screen.getByRole("button", { name: /copy share link/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /print & export/i }),
		).toBeTruthy();
	});

	it("wires the reopen handler", async () => {
		const onReopen = vi.fn();
		await renderToolbar({ canManage: true, locked: true, onReopen });
		await openManage();
		await userEvent.click(item(/reopen meeting/i) as HTMLElement);
		expect(onReopen).toHaveBeenCalledTimes(1);
	});

	it("officer, but no addable roles left: no Add role item", async () => {
		await renderToolbar({ canManage: true, hasAddableRoles: false });
		await openManage();
		expect(item(/add role/i)).toBeNull();
	});

	it("officer, but nothing left to complete: no Complete meeting item", async () => {
		await renderToolbar({
			canManage: true,
			canComplete: false,
			locked: false,
		});
		await openManage();
		expect(item(/complete meeting/i)).toBeNull();
	});

	it("lifecycle mutation in flight: Complete meeting disables instead of hiding", async () => {
		await renderToolbar({
			canManage: true,
			canComplete: true,
			lifecycleBusy: true,
		});
		await openManage();
		const complete = item(/complete meeting/i) as HTMLElement;
		expect(complete.getAttribute("aria-disabled")).toBe("true");
	});

	// `disabled` alone tells a screen-reader user nothing: the swapped-in spinner
	// is a childless lucide icon, which lucide-react marks `aria-hidden`, and
	// `disabled` has already removed the button from the focus order. So the
	// only signal that a lifecycle mutation is in flight is the visual spin.
	// MeetingPersonalStrip's availability chip already sets aria-busy; these two
	// did not until the ship design review.
	it.each([
		{ name: /complete meeting/i, props: { canComplete: true } },
		{ name: /reopen meeting/i, props: { locked: true } },
	])("announces the in-flight mutation via aria-busy — $name", async ({
		name,
		props,
	}) => {
		await renderToolbar({ canManage: true, lifecycleBusy: true, ...props });
		await openManage();
		expect(item(name)?.getAttribute("aria-busy")).toBe("true");
		cleanup();
		// Not stuck on: it must be absent/false when idle, or it announces a
		// permanent busy state and the assertion above proves nothing.
		await renderToolbar({ canManage: true, lifecycleBusy: false, ...props });
		await openManage();
		expect(item(name)?.getAttribute("aria-busy")).not.toBe("true");
	});

	it("lifecycle mutation in flight while locked: Reopen meeting disables instead of hiding", async () => {
		await renderToolbar({
			canManage: true,
			locked: true,
			lifecycleBusy: true,
		});
		await openManage();
		expect(item(/reopen meeting/i)?.getAttribute("aria-disabled")).toBe("true");
	});

	it("passes printLayout/deck/clubName/wordOfTheDay through to the export menu", async () => {
		const deck = [{ kind: "title" }] as unknown as Slide[];
		await renderToolbar({
			phase: "upcoming",
			hasIdentity: true,
			wordOfTheDay: "Buoyant",
			deck,
			clubName: "HCS",
			printLayout: "editorial",
		});
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		expect(
			screen
				.getByRole("menuitem", { name: /word poster/i })
				.closest("a")
				?.getAttribute("href"),
		).toContain("/word");
		expect(
			screen.getByRole("menuitem", { name: /download \.pptx/i }),
		).toBeTruthy();
		expect(
			screen
				.getByRole("menuitem", { name: /print agenda/i })
				.closest("a")
				?.getAttribute("href"),
		).toBe("/club/downtown/meeting/2026-08-10/print?layout=editorial");
	});

	it("passes dbMeetingId through — the per-meeting PDFs must name THIS meeting", async () => {
		// dbMeetingId is a DIFFERENT id from meetingId two props above (uuid vs
		// URL key); wiring the wrong one serves another meeting's role sheets.
		await renderToolbar({ hasIdentity: true });
		await userEvent.click(
			screen.getByRole("button", { name: /print & export/i }),
		);
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		const pdf = document.querySelector('a[href*="/role-sheets/"]');
		expect(pdf?.getAttribute("href")).toContain(BASE.dbMeetingId);
	});

	it("passes sharePath through — the share chip copies the meeting URL", async () => {
		const user = userEvent.setup();
		await renderToolbar({ hasIdentity: true });
		await user.click(screen.getByRole("button", { name: /copy share link/i }));
		const copied = await window.navigator.clipboard.readText();
		// The discriminator, not just the path: it exists nowhere the component
		// could reconstruct, so this can only pass if the PROP was used.
		expect(copied).toContain("/club/downtown/meeting/2026-08-10?from=share");
	});

	// Regression: /qa 2026-08-10 — Complete meeting shipped at the DEFAULT
	// (filled) variant while every other edit-group button was `outline`, so an
	// officer on meeting day saw two identically weighted filled CTAs (Present
	// and Complete meeting) and the phase primary stopped reading as primary.
	// Found by /qa on 2026-08-10 · report: .gstack/qa-reports/
	//
	// These assert the COUNT of filled controls, not Complete's own variant: the
	// invariant D2 actually promises is "exactly one emphasized action in the
	// row", so a future button added at the wrong weight fails here too. Both
	// phases that HAVE a primary are covered — `completed` was already correct
	// and is pinned so the fix can't be applied by inverting the two.
	it.each([
		{
			label: "today + officer: Present filled, Complete meeting outline",
			props: {
				phase: "today" as MeetingPhase,
				hasIdentity: true,
				canManage: true,
				canComplete: true,
				hasAddableRoles: true,
			},
			expected: /present/i,
		},
		{
			label: "completed + officer: Minutes filled, Reopen meeting outline",
			props: {
				phase: "completed" as MeetingPhase,
				hasIdentity: true,
				canManage: true,
				locked: true,
				canComplete: true,
			},
			expected: /minutes/i,
		},
	])("the phase primary is the ONLY filled control — $label", async ({
		props,
		expected,
	}) => {
		await renderToolbar(props);
		// Queried by attribute rather than by role: the primary renders as an
		// <a data-slot="button">, so getAllByRole("button") would miss it and the
		// count would be wrong in the direction that passes.
		//
		// Scoped to `[data-slot="button"]` because `DropdownMenuItem` ALSO stamps
		// `data-variant="default"` — a bare attribute query starts counting menu
		// items the moment any case opens the export menu, and the failure
		// message would still say "filled control in the toolbar".
		//
		// NOTE: this counts within a render of the TOOLBAR ALONE, so it is blind
		// to a filled control in the personal strip stacked above it in the real
		// header — which is exactly how the second collision shipped. The
		// composed count lives in meeting-chrome-composition.test.tsx.
		const filled = [
			...document.querySelectorAll(
				'[data-slot="button"][data-variant="default"]',
			),
		];
		expect(
			filled.map((el) => el.textContent?.trim()),
			"expected exactly one filled control in the toolbar — the phase primary",
		).toHaveLength(1);
		expect(filled[0].textContent).toMatch(expected);
	});

	it("orders the toolbar: primary, then share, then the export menu trigger", async () => {
		await renderToolbar({ phase: "today", hasIdentity: true, canManage: true });
		const primary = screen.getByTestId("toolbar-primary");
		const share = screen.getByRole("button", { name: /copy share link/i });
		const menuTrigger = screen.getByRole("button", {
			name: /print & export/i,
		});
		expect(
			primary.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			share.compareDocumentPosition(menuTrigger) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	// The trigger is gated by `showManage`, a hand-written mirror of each item's
	// inline gate. Drift either way is a bug: a trigger over an empty menu, or
	// an item no one can reach. So assert the equivalence over the whole
	// persona x phase x locked matrix rather than pinning today's expressions.
	describe("Manage trigger renders iff the menu has an item", () => {
		const PERSONAS: Record<string, Partial<typeof BASE>> = {
			"officer, everything on": {
				hasIdentity: true,
				canManage: true,
				hasAddableRoles: true,
				canComplete: true,
				canCancel: true,
				canLineupBlast: true,
			},
			"officer, nothing else": { hasIdentity: true, canManage: true },
			"member with lineup access": {
				hasIdentity: true,
				canLineupBlast: true,
			},
			"member without": { hasIdentity: true },
			anonymous: {},
		};
		const PHASES: Record<string, Partial<typeof BASE>> = {
			upcoming: { phase: "upcoming" },
			today: { phase: "today" },
			completed: { phase: "completed" },
			cancelled: { phase: "upcoming", cancelled: true },
		};
		const cases = Object.entries(PERSONAS).flatMap(([persona, p]) =>
			Object.entries(PHASES).flatMap(([phase, ph]) =>
				[false, true].map((locked) => ({
					label: `${persona} / ${phase} / ${locked ? "locked" : "unlocked"}`,
					props: { ...p, ...ph, locked },
				})),
			),
		);

		// The menu's items are not in the DOM until the trigger exists, so
		// "no trigger" alone cannot show an item went unreachable. The oracle
		// is the item rules themselves: Promote / Add role / Complete / Cancel
		// need an officer on a live (not cancelled) meeting, Reopen an officer
		// on a locked one (cancelled included), Lineup blast its own flag.
		it.each(cases)("$label", async ({ props }) => {
			const officer = props.canManage === true;
			const anyItem =
				props.canLineupBlast === true ||
				(officer && (props.cancelled !== true || props.locked === true));
			await renderToolbar(props);
			const trigger = screen.queryByRole("button", { name: /^manage$/i });
			expect(trigger !== null).toBe(anyItem);
			if (trigger === null) return;
			await userEvent.click(trigger);
			expect(screen.getAllByRole("menuitem").length).toBeGreaterThanOrEqual(1);
		});

		it("the matrix reaches both outcomes (it is not vacuous)", async () => {
			let shown = 0;
			let hidden = 0;
			for (const { props } of cases) {
				await renderToolbar(props);
				if (screen.queryByRole("button", { name: /^manage$/i })) shown++;
				else hidden++;
				cleanup();
			}
			expect(shown).toBeGreaterThan(0);
			expect(hidden).toBeGreaterThan(0);
		});
	});

	// The trigger spins only for a write that lives in the Manage menu. Restore
	// is the cancelled banner's button, so it must not make Manage busy.
	describe("Manage trigger busy state", () => {
		const trigger = () =>
			screen.getByRole("button", { name: /manage/i }) as HTMLElement;
		const OFFICER = { canManage: true, canComplete: true, canCancel: true };

		it.each([
			"complete",
			"reopen",
			"cancel",
		] as const)("busy %s: spins and carries aria-busy", async (busyAction) => {
			await renderToolbar({
				...OFFICER,
				lifecycleBusy: true,
				busyAction,
			});
			expect(trigger().getAttribute("aria-busy")).toBe("true");
			expect(trigger().querySelector("svg.animate-spin")).not.toBeNull();
		});

		it("busy restore: Manage is NOT busy (Restore is the banner's action)", async () => {
			await renderToolbar({
				...OFFICER,
				lifecycleBusy: true,
				busyAction: "restore",
			});
			expect(trigger().getAttribute("aria-busy")).not.toBe("true");
			expect(trigger().querySelector("svg.animate-spin")).toBeNull();
		});

		it("busy with no busyAction named: spins (old behaviour, as the items do)", async () => {
			await renderToolbar({ ...OFFICER, lifecycleBusy: true });
			expect(trigger().getAttribute("aria-busy")).toBe("true");
			expect(trigger().querySelector("svg.animate-spin")).not.toBeNull();
		});

		it("idle: neither", async () => {
			await renderToolbar({
				...OFFICER,
				lifecycleBusy: false,
				busyAction: "complete",
			});
			expect(trigger().getAttribute("aria-busy")).not.toBe("true");
			expect(trigger().querySelector("svg.animate-spin")).toBeNull();
		});
	});
});
