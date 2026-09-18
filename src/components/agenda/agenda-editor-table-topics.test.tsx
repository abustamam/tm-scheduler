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
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
		clubGoverned: false,
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

/** The club the fixture's agenda belongs to. A UUID, not a slug: since #685 the
 *  Club settings link is built from `clubUuid` rather than the `$clubId` URL
 *  segment, which `resolveClubOrRedirect` canonicalises to the SLUG. */
const CLUB_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function renderEditor(rows: AgendaDraftRow[]) {
	await renderUnderMemoryRouter(
		<AgendaEditor
			draft={draftWith(rows)}
			clubUuid={CLUB_UUID}
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
	// The STORED marker is what makes this the club's row since #683 — not the
	// role key, and not the presence of the three marks. The marks stay on the
	// fixture because this file is about what the officer SEES, and what they see
	// is these numbers as clocks.
	clubGoverned: true,
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
		// Carries the club (#685). Without it the settings page resolves the
		// workspace's ACTIVE club, which for a multi-club officer is a different
		// club than the agenda they are looking at.
		expect(link.getAttribute("href")).toBe(
			`/admin/club-settings?club=${CLUB_UUID}`,
		);
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

	it("keeps the inputs on an UNGOVERNED Table Topics row", async () => {
		// An officer who added a row and pointed it at the Table Topics Master must
		// still be able to set its marks — the render path does not refresh it, so
		// locking the fields would leave three blank controls and no way back. Since
		// #683 this is decided by the absent marker rather than by absent marks,
		// which is why the fixture below carries a full set of them: under the old
		// predicate this row was governed, and that was the bug.
		await renderEditor([
			row({
				id: "bare",
				roleKey: "table_topics_master",
				markGreen: 0.5,
				markYellow: 0.75,
				markRed: 1,
			}),
		]);
		await openDetail(0);
		const green = screen.getByLabelText(
			"Green mark minute",
		) as HTMLInputElement;
		expect(green.value).toBe("0.5");
		expect(green.disabled).toBe(false);
		expect(screen.queryByTestId("agenda-row-club-marks-bare")).toBeNull();
	});
});

/**
 * The way out, and the way back (#683).
 *
 * Governance used to be a one-way door: the only exit from the read-only panel
 * above was deleting the row and re-adding it, which loses its label, its note,
 * its minutes and its place in the agenda. These cases drive the two controls
 * and assert the PATCH each one sends, because what the button writes is the
 * whole of what it does.
 */
describe("the un-govern and re-govern controls (#683)", () => {
	const UN_GOVERN = "Use a different window for this meeting";
	const RE_GOVERN = "Follow the club's Table Topics window";

	async function renderWith(rows: AgendaDraftRow[]) {
		const onUpdateRow = vi.fn(async () => ({}) as never);
		const onRefresh = vi.fn(async () => ({}) as never);
		await renderUnderMemoryRouter(
			<AgendaEditor
				draft={draftWith(rows)}
				clubUuid={CLUB_UUID}
				onAddRow={vi.fn(async () => rows[0] as AgendaDraftRow)}
				onUpdateRow={onUpdateRow}
				onRemoveRow={noop}
				onMoveRow={noop}
				onRefresh={onRefresh}
				onAddRole={noop}
				planRoleRemoval={vi.fn(async () => [])}
				onRemoveRole={noop}
			/>,
		);
		return { onUpdateRow, onRefresh };
	}

	async function click(name: string) {
		const { default: userEvent } = await import("@testing-library/user-event");
		await userEvent.setup().click(screen.getByRole("button", { name }));
	}

	it("sends the marks ALONG WITH the flag, so the window does not jump", async () => {
		// The stored row can still hold the materialisation snapshot while the
		// panel shows the club's CURRENT window (`loadAgendaDraft` refreshes on the
		// way out). Un-governing without carrying the displayed numbers would drop
		// the officer into three inputs holding a window they never chose and were
		// not shown — the app changing their timing at the moment they took it over.
		const { onUpdateRow } = await renderWith([TT_ROW]);
		await openDetail(0);
		await click(UN_GOVERN);
		expect(onUpdateRow).toHaveBeenCalledWith("tt", {
			clubGoverned: false,
			markGreen: 1,
			markYellow: 1.8833333333333333,
			markRed: 2.75,
		});
	});

	it("RE-READS after each, or the panel does not move", async () => {
		// Both directions change what this panel offers, and re-governing replaces
		// all three marks with the club's current window — numbers the client does
		// not have. `marksFromClub` derives from `draft`, so with no refresh the
		// save lands and nothing on screen changes until an unprompted reload. That
		// is the "dead button" `setFlex` already carries a docblock about.
		const un = await renderWith([TT_ROW]);
		await openDetail(0);
		await click(UN_GOVERN);
		await waitFor(() => expect(un.onRefresh).toHaveBeenCalled());

		cleanup();
		const re = await renderWith([
			row({ id: "own", roleKey: "table_topics_master" }),
		]);
		await openDetail(0);
		await click(RE_GOVERN);
		await waitFor(() => expect(re.onRefresh).toHaveBeenCalled());
	});

	it("survives a blur on the inputs it hands the officer", async () => {
		// The corruption this pairing produced. `resolveTableTopicsMarks` returns
		// `seconds / 60`, so a 1:00–2:45 club's yellow is 113/60 = 1.8833…; the
		// un-govern patch puts those three into the row, the row flips to the
		// editable branch, and `commitMarks` re-parses ALL THREE on any single
		// blur. Under `parseInt` one focus-and-blur wrote 1 / 1 / 2 — green equal
		// to yellow — onto the printed sheet, the deck and the Timer's card, with
		// `assertMarks` (all-three-or-none) seeing nothing wrong.
		//
		// Driven on the already-un-governed row, because that is the state the
		// officer is left in and the marks are the club's own.
		const { onUpdateRow } = await renderWith([
			row({
				id: "own",
				roleKey: "table_topics_master",
				markGreen: 1,
				markYellow: 1.8833333333333333,
				markRed: 2.75,
			}),
		]);
		await openDetail(0);
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Green mark minute"));
		await user.tab();
		// Nothing changed, so `commitMarks` should send nothing at all — and if it
		// ever does send, the values must be the ones it was given.
		for (const call of onUpdateRow.mock.calls as unknown as [
			string,
			Record<string, unknown>,
		][]) {
			expect(call[1]).toEqual({
				markGreen: 1,
				markYellow: 1.8833333333333333,
				markRed: 2.75,
			});
		}
		// And a deliberate fractional edit round-trips rather than truncating.
		const yellow = screen.getByLabelText("Yellow mark minute");
		await user.clear(yellow);
		await user.type(yellow, "2.5");
		await user.tab();
		await waitFor(() =>
			expect(onUpdateRow).toHaveBeenCalledWith("own", {
				markGreen: 1,
				markYellow: 2.5,
				markRed: 2.75,
			}),
		);
	});

	it("offers the way BACK on an ungoverned Table Topics row", async () => {
		const { onUpdateRow } = await renderWith([
			row({
				id: "own",
				roleKey: "table_topics_master",
				markGreen: 1,
				markYellow: 2,
				markRed: 3,
			}),
		]);
		await openDetail(0);
		await click(RE_GOVERN);
		// The flag alone: the club's window is re-derived at the next render, so
		// sending marks here would write numbers the refresh immediately replaces.
		expect(onUpdateRow).toHaveBeenCalledWith("own", { clubGoverned: true });
	});

	it("offers exactly ONE of the two on the Table Topics row", async () => {
		// Both at once would be incoherent, and neither would be the original bug.
		await renderWith([TT_ROW]);
		await openDetail(0);
		expect(screen.getByRole("button", { name: UN_GOVERN })).toBeTruthy();
		expect(screen.queryByRole("button", { name: RE_GOVERN })).toBeNull();
	});

	it("offers NEITHER on a row the club's window cannot govern", async () => {
		// The vacuity control. An editor that showed "Follow the club's Table Topics
		// window" on every row would pass the case above and put a button on the
		// evaluator row that the server refuses.
		await renderWith([TT_ROW, EVALUATOR_ROW]);
		await openDetail(1);
		expect(screen.queryByRole("button", { name: UN_GOVERN })).toBeNull();
		expect(screen.queryByRole("button", { name: RE_GOVERN })).toBeNull();
	});
});
