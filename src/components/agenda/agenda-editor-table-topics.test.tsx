// @vitest-environment jsdom
/**
 * The agenda editor's CLUB-OWNED Table Topics row (#679).
 *
 * This branch was written, shipped through eight review specialists, and had
 * never once executed — every gate on it was a source grep. Two things a grep
 * structurally cannot see, and both are why this file exists:
 *
 * 1. It renders a `<Link>`, which is NEW to this component. Anything rendering
 *    one throws outside a router context (`src/test/router-harness.tsx` says so
 *    in its own docblock), so the branch could have been unrenderable in every
 *    environment and the suite would still have been green.
 * 2. Deleting the `marksFromClub ? … : …` ternary while keeping everything else
 *    passes typecheck, lint and every grep — and ships three number inputs
 *    showing `1.8833333333333333`, which is precisely the failure the branch
 *    exists to prevent.
 *
 * Scoped deliberately to that one row. `AgendaEditor` at large is covered by
 * `agenda-editor-parity.test.ts` (the clock) and the wiring guard (the seams);
 * this asks only what the officer SEES on the segment the club owns.
 *
 * SEPARATE from `agenda-editor.test.tsx` for a mechanical reason, not a
 * stylistic one: that file mounts with a bare `render(<AgendaEditor …/>)` and
 * no router, so the moment a fixture there satisfies `isTableTopicsSegment` and
 * its detail panel opens, the `<Link>` throws — an opaque router error rather
 * than a useful failure. Add Table Topics cases HERE, or convert that file to
 * `renderUnderMemoryRouter` first.
 */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgendaDraft, AgendaDraftRow } from "#/server/meeting-agenda-edit";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { AgendaEditor } from "./agenda-editor";

afterEach(cleanup);

/** MCF's window, 1:00–2:45, as `loadAgendaDraft` hands it over: MINUTES, and
 *  the yellow midpoint is the ugly float this branch exists to stop showing —
 *  (60 + 165) / 2 = 113s = 1.8833333333333333 min. */
const CLUB_MARKS = {
	markGreen: 1,
	markYellow: 1.8833333333333333,
	markRed: 2.75,
};

function row(over: Partial<AgendaDraftRow> & { id: string }): AgendaDraftRow {
	return {
		sortOrder: 0,
		kind: "role",
		label: "Row",
		detail: null,
		minutes: 5,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		...over,
	};
}

function draftWith(rows: AgendaDraftRow[]): AgendaDraft {
	return {
		templateId: "tpl",
		templateName: "Standard",
		editable: true,
		rows,
		roles: [
			{
				key: "table_topics_master",
				name: "Table Topics Master",
				category: "leadership",
				defaultCount: 1,
				isSpeakerRole: false,
			},
			{
				key: "evaluator",
				name: "Evaluator",
				category: "evaluator",
				defaultCount: 1,
				isSpeakerRole: false,
			},
		],
		slots: [],
		scheduledAt: "2026-09-30T02:00:00.000Z",
		timeZone: "America/Chicago",
		lengthMinutes: 90,
		geIntroducesFunctionaries: false,
	};
}

const noop = vi.fn(async () => ({}) as never);

async function renderEditor(rows: AgendaDraftRow[]) {
	await renderUnderMemoryRouter(
		<AgendaEditor
			draft={draftWith(rows)}
			onAddRow={vi.fn(async () => rows[0])}
			onUpdateRow={noop}
			onRemoveRow={noop}
			onMoveRow={noop}
			onRefresh={noop}
			onAddRole={noop}
			planRoleRemoval={vi.fn(async () => [])}
			onRemoveRole={noop}
		/>,
	);
}

/** Open a row's detail panel — the three mark controls live behind it. */
async function openDetail(index: number) {
	const buttons = screen.getAllByRole("button", { name: "Show row details" });
	const { default: userEvent } = await import("@testing-library/user-event");
	await userEvent.setup().click(buttons[index]);
}

const TT_ROW = row({
	id: "tt",
	label: "Table Topics Master",
	roleKey: "table_topics_master",
	flex: true,
	...CLUB_MARKS,
});

const EVALUATOR_ROW = row({
	id: "ev",
	sortOrder: 1,
	label: "Evaluator",
	roleKey: "evaluator",
	markGreen: 2,
	markYellow: 2.5,
	markRed: 3,
});

describe("the club-owned Table Topics row in the agenda editor (#679)", () => {
	it("renders at all — the <Link> needs a router, and nothing proved that", async () => {
		// The failure mode this isolates is "unrenderable", not "renders wrongly":
		// the `<Link>` is new to this component and throws outside a router.
		//
		// It MUST open the detail panel to mean anything. `RowDetail` sits behind
		// `{open ? … : null}` with `open` starting false, so the first cut of this
		// case rendered the table and no `<Link>` at all — a test named for a
		// router requirement that never mounted the thing requiring one.
		await renderEditor([TT_ROW, EVALUATOR_ROW]);
		await openDetail(0);
		expect(
			within(screen.getByTestId("agenda-row-club-marks-tt")).getByRole("link"),
		).toBeTruthy();
	});

	it("shows the window as CLOCKS, never the raw float minutes", async () => {
		await renderEditor([TT_ROW, EVALUATOR_ROW]);
		await openDetail(0);

		const panel = screen.getByTestId("agenda-row-club-marks-tt");
		// ABSOLUTE. 1 / 1.8833333333333333 / 2.75 minutes is 1:00 / 1:53 / 2:45.
		expect(within(panel).getByText(/Green 1:00/)).toBeTruthy();
		expect(panel.textContent).toContain("1:53");
		expect(panel.textContent).toContain("2:45");
		// The pre-fix rendering, named so this cannot pass by coincidence. A
		// disabled `<Input type="number">` would show this exact string.
		expect(panel.textContent).not.toContain("1.8833333333333333");
	});

	it("offers NO mark inputs on that row, rather than disabled ones", async () => {
		// R2. Three disabled inputs would satisfy "the officer cannot edit it" and
		// still show the float. The controls are gone, not greyed.
		await renderEditor([TT_ROW]);
		await openDetail(0);
		expect(screen.queryByLabelText("Green mark minute")).toBeNull();
		expect(screen.queryByLabelText("Yellow mark minute")).toBeNull();
		expect(screen.queryByLabelText("Red mark minute")).toBeNull();
	});

	it("says WHERE to change it, and links there", async () => {
		await renderEditor([TT_ROW]);
		await openDetail(0);
		const panel = screen.getByTestId("agenda-row-club-marks-tt");
		expect(panel.textContent).toContain("Set once for the whole club");
		const link = within(panel).getByRole("link", { name: /Club settings/ });
		expect(link.getAttribute("href")).toBe("/admin/club-settings");
	});

	it("leaves every OTHER row's three inputs editable", async () => {
		// The vacuity control. Without it, a branch that swallowed the mark inputs
		// on every row would pass all three assertions above.
		await renderEditor([TT_ROW, EVALUATOR_ROW]);
		await openDetail(1);
		const green = screen.getByLabelText(
			"Green mark minute",
		) as HTMLInputElement;
		expect(green.value).toBe("2");
		expect(green.disabled).toBe(false);
		expect(screen.queryByTestId("agenda-row-club-marks-ev")).toBeNull();
	});

	it("keeps the inputs on a Table Topics row with NO marks", async () => {
		// The predicate's marks clause, seen from the UI. An officer who added a
		// row and pointed it at the Table Topics Master must still be able to set
		// its marks — the render path does not refresh it, so locking the fields
		// would leave three blank controls and no way back.
		await renderEditor([row({ id: "bare", roleKey: "table_topics_master" })]);
		await openDetail(0);
		expect(screen.getByLabelText("Green mark minute")).toBeTruthy();
		expect(screen.queryByTestId("agenda-row-club-marks-bare")).toBeNull();
	});
});
