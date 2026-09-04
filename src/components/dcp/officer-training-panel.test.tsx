// @vitest-environment jsdom
//
// Component tests for the Club Officer Training panel (#531).
//
// No `@testing-library/jest-dom` in this repo, so every assertion uses native
// DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
//
// The tallies in these fixtures are hand-written literals rather than built with
// `tallyPeriod`. That is deliberate: `officer-training.test.ts` already proves
// the derivation, and passing it through here would make this file assert that
// the panel renders whatever the derivation returns — which is true for a
// derivation that returns anything at all. What is under test here is the
// RENDERING, so the inputs are fixed and every expectation is a literal.
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	TrainingPeriod,
	TrainingPeriodTally,
} from "#/lib/officer-training";
import type {
	OfficerTrainingView,
	TrainingRecordView,
} from "#/server/officer-training-logic";
import { OfficerTrainingPanel } from "./officer-training-panel";

afterEach(cleanup);

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const CARA = "33333333-3333-3333-3333-333333333333";

function tally(
	period: TrainingPeriod,
	overrides: Partial<TrainingPeriodTally> = {},
): TrainingPeriodTally {
	const window =
		period === 1
			? { period, startsOn: "2026-06-01", endsOn: "2026-08-31" }
			: { period, startsOn: "2026-11-01", endsOn: "2027-02-28" };
	return {
		period,
		window,
		windowIsDefault: true,
		phase: period === 1 ? "open" : "upcoming",
		daysUntilClose: period === 1 ? 60 : 300,
		trained: 0,
		required: 4,
		met: false,
		shortfall: 4,
		...overrides,
	};
}

function record(
	overrides: Partial<TrainingRecordView> = {},
): TrainingRecordView {
	return {
		id: "rec-1",
		membershipId: ALICE,
		memberName: "Alice Dual",
		position: "secretary",
		period: 1,
		trainedOn: "2026-07-14",
		outsideWindow: false,
		counts: true,
		...overrides,
	};
}

function view(
	overrides: Partial<OfficerTrainingView> = {},
): OfficerTrainingView {
	return {
		programYear: 2026,
		today: "2026-07-02",
		periods: [tally(1), tally(2)],
		focus: 1,
		records: [],
		seats: [
			{ membershipId: ALICE, name: "Alice Dual", position: "secretary" },
			{ membershipId: ALICE, name: "Alice Dual", position: "treasurer" },
			{ membershipId: BOB, name: "Bob Boss", position: "president" },
		],
		roster: [
			{ membershipId: ALICE, name: "Alice Dual" },
			{ membershipId: BOB, name: "Bob Boss" },
			{ membershipId: CARA, name: "Cara Clerk" },
		],
		g9Suggestion: 0,
		hasRecords: false,
		...overrides,
	};
}

function noop() {
	/* intentionally empty */
}

function mount(v: OfficerTrainingView, busy = false) {
	const onAddRecord = vi.fn();
	const onRemoveRecord = vi.fn();
	const onSetWindow = vi.fn();
	const onResetWindow = vi.fn();
	const utils = render(
		<OfficerTrainingPanel
			view={v}
			busy={busy}
			onAddRecord={onAddRecord}
			onRemoveRecord={onRemoveRecord}
			onSetWindow={onSetWindow}
			onResetWindow={onResetWindow}
		/>,
	);
	return { ...utils, onAddRecord, onRemoveRecord, onSetWindow, onResetWindow };
}

/** The card for one period, so assertions never bleed across the two. */
function card(period: TrainingPeriod): HTMLElement {
	const el = screen.getByTestId(`cot-period-${period}`);
	return el;
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

describe("the tally", () => {
	it("renders the count against an absolute bar of 4", () => {
		mount(
			view({ periods: [tally(1, { trained: 3, shortfall: 1 }), tally(2)] }),
		);
		const first = card(1);
		expect(first.textContent).toContain("3");
		expect(first.textContent).toContain("/4");
		expect(first.textContent).toContain("1 more officer needed");
	});

	it("pluralises the shortfall", () => {
		mount(
			view({ periods: [tally(1, { trained: 2, shortfall: 2 }), tally(2)] }),
		);
		expect(card(1).textContent).toContain("2 more officers needed");
	});

	it("says the bar is cleared instead of naming a shortfall", () => {
		mount(
			view({
				periods: [tally(1, { trained: 4, met: true, shortfall: 0 }), tally(2)],
			}),
		);
		expect(card(1).textContent).toContain("Bar cleared");
		expect(card(1).textContent).not.toContain("more officer");
	});

	it("keeps the two periods' numbers apart", () => {
		mount(
			view({
				periods: [
					tally(1, { trained: 4, met: true, shortfall: 0 }),
					tally(2, {
						trained: 1,
						shortfall: 3,
						phase: "open",
						daysUntilClose: 40,
					}),
				],
			}),
		);
		expect(card(1).textContent).toContain("Bar cleared");
		expect(card(2).textContent).toContain("3 more officers needed");
	});
});

// ---------------------------------------------------------------------------
// The countdown — the half the bare toggle could never show
// ---------------------------------------------------------------------------

describe("the window", () => {
	it("counts the days down while the window is open", () => {
		mount(
			view({
				periods: [tally(1, { phase: "open", daysUntilClose: 60 }), tally(2)],
			}),
		);
		expect(card(1).textContent).toContain("Closes in 60 days");
	});

	it("says 'Closes today' rather than 'in 0 days'", () => {
		mount(
			view({
				periods: [tally(1, { phase: "open", daysUntilClose: 0 }), tally(2)],
			}),
		);
		expect(card(1).textContent).toContain("Closes today");
	});

	it("pluralises one day", () => {
		mount(
			view({
				periods: [tally(1, { phase: "open", daysUntilClose: 1 }), tally(2)],
			}),
		);
		expect(card(1).textContent).toContain("Closes in 1 day");
		expect(card(1).textContent).not.toContain("1 days");
	});

	it("marks the last three weeks urgent while the bar is unmet", () => {
		// The signal the club in the issue never got. Amber at 21 days and under,
		// and ONLY while short — a met period needs no alarm.
		const { container } = mount(
			view({
				periods: [
					tally(1, {
						phase: "open",
						daysUntilClose: 21,
						trained: 2,
						shortfall: 2,
					}),
					tally(2),
				],
			}),
		);
		expect(container.innerHTML).toContain("var(--warning-strong)");
	});

	it("does NOT mark a met period urgent, however few days are left", () => {
		const { container } = mount(
			view({
				periods: [
					tally(1, {
						phase: "open",
						daysUntilClose: 1,
						trained: 4,
						met: true,
						shortfall: 0,
					}),
					tally(2, { phase: "upcoming", daysUntilClose: 300 }),
				],
			}),
		);
		expect(card(1).textContent).toContain("Closes in 1 day");
		expect(container.innerHTML).not.toContain(
			"bg-[var(--warning-strong)] text-white",
		);
	});

	it("reports a shut window as Closed with no countdown", () => {
		mount(
			view({
				periods: [
					tally(1, {
						phase: "closed",
						daysUntilClose: null,
						trained: 3,
						shortfall: 1,
					}),
					tally(2),
				],
			}),
		);
		expect(card(1).textContent).toContain("Closed");
		expect(card(1).textContent).not.toContain("Closes in");
		// The failure the issue describes, on screen: shut and one short.
		expect(card(1).textContent).toContain("1 more officer needed");
	});

	it("names the opening date for an upcoming window", () => {
		mount(view());
		expect(card(2).textContent).toContain("Opens Nov 1, 2026");
	});

	it("renders the bounds from the ISO strings, not a parsed Date", () => {
		// "May 31" here would mean the display went through `new Date(iso)` and
		// rendered UTC midnight in local time — the one off-by-one a deadline
		// cannot afford.
		mount(view());
		expect(card(1).textContent).toContain("Jun 1, 2026 – Aug 31, 2026");
	});

	it("says whose dates these are", () => {
		mount(view());
		expect(card(1).textContent).toContain("Toastmasters' standard window");

		cleanup();
		mount(
			view({
				periods: [
					tally(1, {
						windowIsDefault: false,
						window: { period: 1, startsOn: "2026-06-15", endsOn: "2026-09-15" },
					}),
					tally(2),
				],
			}),
		);
		expect(card(1).textContent).toContain("your club's dates");
		expect(card(1).textContent).toContain("Jun 15, 2026 – Sep 15, 2026");
	});
});

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

describe("recorded training", () => {
	it("lists a record with its member, office and date", () => {
		mount(view({ records: [record()], hasRecords: true }));
		const text = card(1).textContent ?? "";
		expect(text).toContain("Alice Dual");
		expect(text).toContain("Secretary");
		expect(text).toContain("Jul 14, 2026");
	});

	it("says so when no date was recorded, rather than showing a placeholder date", () => {
		mount(view({ records: [record({ trainedOn: null })], hasRecords: true }));
		expect(card(1).textContent).toContain("date not recorded");
	});

	it("flags a record dated outside its window without hiding it", () => {
		mount(
			view({
				records: [record({ trainedOn: "2026-09-20", outsideWindow: true })],
				hasRecords: true,
			}),
		);
		const text = card(1).textContent ?? "";
		expect(text).toContain("outside this window");
		// Still listed, and still the club's claim.
		expect(text).toContain("Alice Dual");
	});

	it("marks a record that counts toward nothing", () => {
		mount(
			view({
				records: [
					record({ position: "immediate_past_president", counts: false }),
				],
				hasRecords: true,
			}),
		);
		expect(card(1).textContent).toContain("not counted");
	});

	it("puts a record in its own period's card only", () => {
		mount(view({ records: [record({ period: 2 })], hasRecords: true }));
		expect(card(1).textContent).toContain(
			"Nobody recorded for this period yet",
		);
		expect(card(2).textContent).toContain("Alice Dual");
	});

	it("removes by record id", async () => {
		const user = userEvent.setup();
		const { onRemoveRecord } = mount(
			view({ records: [record({ id: "rec-42" })], hasRecords: true }),
		);
		await user.click(
			screen.getByRole("button", { name: "Remove Alice Dual as Secretary" }),
		);
		expect(onRemoveRecord).toHaveBeenCalledWith("rec-42");
	});
});

// ---------------------------------------------------------------------------
// Who is NOT trained — the display grain
// ---------------------------------------------------------------------------

describe("the not-recorded list", () => {
	it("lists a dual-office holder's OTHER office after one is recorded", () => {
		// Alice counts 1 toward the four and is still half done. The list is keyed
		// on (member, office) precisely so this prompt survives.
		mount(
			view({
				records: [record({ position: "secretary" })],
				hasRecords: true,
			}),
		);
		const text = card(1).textContent ?? "";
		expect(text).toContain("Alice Dual · Treasurer");
		expect(text).toContain("Bob Boss · President");
		// The recorded seat is gone from the prompt.
		expect(text).not.toContain("Alice Dual · Secretary");
	});

	it("disappears entirely once every seat is covered", () => {
		mount(
			view({
				records: [
					record({ id: "r1", position: "secretary" }),
					record({ id: "r2", position: "treasurer" }),
					record({
						id: "r3",
						membershipId: BOB,
						memberName: "Bob Boss",
						position: "president",
					}),
				],
				hasRecords: true,
			}),
		);
		expect(card(1).textContent).not.toContain("Not recorded yet");
	});

	it("is per-period — a second-period record leaves the first period's seats open", () => {
		mount(view({ records: [record({ period: 2 })], hasRecords: true }));
		expect(card(1).textContent).toContain("Alice Dual · Secretary");
		expect(card(2).textContent).not.toContain("Alice Dual · Secretary");
	});
});

// ---------------------------------------------------------------------------
// Adding a record
// ---------------------------------------------------------------------------

describe("the add form", () => {
	it("submits the member, office, period and date", async () => {
		const user = userEvent.setup();
		const { onAddRecord } = mount(view());
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-1" }),
			BOB,
		);
		await user.selectOptions(
			screen.getByLabelText("Trained as", { selector: "#cot-office-1" }),
			"president",
		);
		await user.click(
			screen.getAllByRole("button", {
				name: /Record training/,
			})[0] as HTMLElement,
		);
		expect(onAddRecord).toHaveBeenCalledWith({
			membershipId: BOB,
			position: "president",
			// The period comes from the CARD, not from a field — picking the wrong
			// one here would credit the wrong window with every gate green.
			period: 1,
			trainedOn: "2026-07-02",
		});
	});

	it("carries the second card's period", async () => {
		const user = userEvent.setup();
		const { onAddRecord } = mount(
			view({
				periods: [tally(1), tally(2, { phase: "open", daysUntilClose: 40 })],
				today: "2026-12-05",
			}),
		);
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-2" }),
			BOB,
		);
		await user.selectOptions(
			screen.getByLabelText("Trained as", { selector: "#cot-office-2" }),
			"president",
		);
		await user.click(
			screen.getAllByRole("button", {
				name: /Record training/,
			})[1] as HTMLElement,
		);
		expect(onAddRecord).toHaveBeenCalledWith(
			expect.objectContaining({ period: 2, trainedOn: "2026-12-05" }),
		);
	});

	it("sends null rather than an empty string when the date is cleared", async () => {
		const user = userEvent.setup();
		const { onAddRecord } = mount(view());
		await user.clear(
			screen.getByLabelText("Date (optional)", { selector: "#cot-date-1" }),
		);
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-1" }),
			BOB,
		);
		await user.selectOptions(
			screen.getByLabelText("Trained as", { selector: "#cot-office-1" }),
			"president",
		);
		await user.click(
			screen.getAllByRole("button", {
				name: /Record training/,
			})[0] as HTMLElement,
		);
		expect(onAddRecord).toHaveBeenCalledWith(
			expect.objectContaining({ trainedOn: null }),
		);
	});

	it("pre-fills a CLOSED window's own last day, not today", async () => {
		// Pre-filling today would make the first record the panel creates arrive
		// already flagged as outside the window.
		const user = userEvent.setup();
		const { onAddRecord } = mount(
			view({
				periods: [
					tally(1, { phase: "closed", daysUntilClose: null }),
					tally(2),
				],
				today: "2026-10-05",
			}),
		);
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-1" }),
			BOB,
		);
		await user.selectOptions(
			screen.getByLabelText("Trained as", { selector: "#cot-office-1" }),
			"president",
		);
		await user.click(
			screen.getAllByRole("button", {
				name: /Record training/,
			})[0] as HTMLElement,
		);
		expect(onAddRecord).toHaveBeenCalledWith(
			expect.objectContaining({ trainedOn: "2026-08-31" }),
		);
	});

	it("cannot submit without a member and an office", () => {
		mount(view());
		const submit = screen.getAllByRole("button", {
			name: /Record training/,
		})[0] as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
	});

	it("offers the member's own offices first, then the rest of the seven", async () => {
		const user = userEvent.setup();
		mount(view());
		const office = screen.getByLabelText("Trained as", {
			selector: "#cot-office-1",
		}) as HTMLSelectElement;
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-1" }),
			ALICE,
		);
		const values = [...office.options].map((o) => o.value).filter(Boolean);
		expect(values.slice(0, 2)).toEqual(["secretary", "treasurer"]);
		// All seven stay reachable — a member may have been trained for an office
		// they have since handed on. Immediate Past President is not among them.
		expect(values).toHaveLength(7);
		expect(values).not.toContain("immediate_past_president");
	});

	it("offers all seven offices for a member holding none", async () => {
		const user = userEvent.setup();
		mount(view());
		const office = screen.getByLabelText("Trained as", {
			selector: "#cot-office-1",
		}) as HTMLSelectElement;
		await user.selectOptions(
			screen.getByLabelText("Member", { selector: "#cot-member-1" }),
			CARA,
		);
		const values = [...office.options].map((o) => o.value).filter(Boolean);
		expect(values).toEqual([
			"president",
			"vp_education",
			"vp_membership",
			"vp_public_relations",
			"secretary",
			"treasurer",
			"sergeant_at_arms",
		]);
	});
});

// ---------------------------------------------------------------------------
// Editing the window
// ---------------------------------------------------------------------------

describe("the window editor", () => {
	async function openEditor(period: TrainingPeriod) {
		const user = userEvent.setup();
		const buttons = screen.getAllByRole("button", { name: "Edit these dates" });
		await user.click(buttons[period - 1] as HTMLElement);
		return user;
	}

	it("saves the edited dates for its own period", async () => {
		const mounted = mount(view());
		const user = await openEditor(1);
		const end = screen.getByLabelText("Closes", { selector: "#cot-end-1" });
		await user.clear(end);
		await user.type(end, "2026-09-15");
		await user.click(screen.getByRole("button", { name: "Save dates" }));
		expect(mounted.onSetWindow).toHaveBeenCalledWith({
			period: 1,
			startsOn: "2026-06-01",
			endsOn: "2026-09-15",
		});
	});

	it("refuses to save a window that ends before it starts", async () => {
		mount(view());
		const user = await openEditor(1);
		const end = screen.getByLabelText("Closes", { selector: "#cot-end-1" });
		await user.clear(end);
		await user.type(end, "2026-05-01");
		expect(
			(screen.getByRole("button", { name: "Save dates" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(document.body.textContent).toContain(
			"The window must end on or after it starts.",
		);
	});

	it("refuses to save an unchanged window", async () => {
		mount(view());
		await openEditor(1);
		expect(
			(screen.getByRole("button", { name: "Save dates" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("offers the reset only once the club has its own dates", async () => {
		mount(view());
		await openEditor(1);
		expect(
			screen.queryByRole("button", { name: /Use Toastmasters' dates/ }),
		).toBeNull();
	});

	// Regression: #531 QA — after a save or a reset landed while the editor was
	// still open, its date inputs kept the OLD dates while the header above showed
	// the new ones, and `changed` was therefore true, so "Save dates" was live and
	// one stray click silently re-applied the override the admin had just cleared.
	// Found by /qa on 2026-09-04 in a real browser: it needs a WRITE to land while
	// the editor is open, which no fixture built at mount time reproduces.
	// Report: .gstack/qa-reports/qa-report-localhost-3000-2026-09-04.md
	it("re-syncs its inputs when the stored window changes underneath it", async () => {
		const overridden = view({
			periods: [
				tally(1, {
					windowIsDefault: false,
					window: { period: 1, startsOn: "2026-06-01", endsOn: "2026-09-30" },
				}),
				tally(2),
			],
		});
		const mounted = mount(overridden);
		await openEditor(1);
		expect(
			(
				screen.getByLabelText("Closes", {
					selector: "#cot-end-1",
				}) as HTMLInputElement
			).value,
		).toBe("2026-09-30");

		// The reset lands: the parent re-renders with TI's window restored, editor
		// still open.
		mounted.rerender(
			<OfficerTrainingPanel
				view={view()}
				onAddRecord={noop}
				onRemoveRecord={noop}
				onSetWindow={noop}
				onResetWindow={noop}
			/>,
		);

		expect(
			(
				screen.getByLabelText("Closes", {
					selector: "#cot-end-1",
				}) as HTMLInputElement
			).value,
		).toBe("2026-08-31");
		// …and Save is inert again, so there is nothing to click that would undo it.
		expect(
			(screen.getByRole("button", { name: "Save dates" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("does not clobber a half-typed date on an unrelated re-render", async () => {
		// The mirror sync is keyed on the window VALUES, not the object, so a
		// re-render handing over an equal-but-new `window` must leave the admin's
		// in-progress edit alone. Keyed on the object it would wipe every keystroke.
		const mounted = mount(view());
		const user = await openEditor(1);
		const end = screen.getByLabelText("Closes", { selector: "#cot-end-1" });
		await user.clear(end);
		await user.type(end, "2026-09-15");

		mounted.rerender(
			<OfficerTrainingPanel
				view={view()}
				onAddRecord={noop}
				onRemoveRecord={noop}
				onSetWindow={noop}
				onResetWindow={noop}
			/>,
		);

		expect((end as HTMLInputElement).value).toBe("2026-09-15");
	});

	it("resets an overridden window back to TI's dates", async () => {
		const mounted = mount(
			view({
				periods: [
					tally(1, {
						windowIsDefault: false,
						window: { period: 1, startsOn: "2026-06-15", endsOn: "2026-09-15" },
					}),
					tally(2),
				],
			}),
		);
		const user = await openEditor(1);
		await user.click(
			screen.getByRole("button", { name: /Use Toastmasters' dates/ }),
		);
		expect(mounted.onResetWindow).toHaveBeenCalledWith(1);
	});
});

// ---------------------------------------------------------------------------
// Disclosure and busy state
// ---------------------------------------------------------------------------

describe("the panel", () => {
	it("discloses that it counts PEOPLE where Toastmasters counts roles", () => {
		// Load-bearing copy, not decoration: the app's count is deliberately
		// conservative, and a club comparing this page against TI's own report has
		// to be told why the two can differ.
		const { container } = render(
			<OfficerTrainingPanel
				view={view()}
				onAddRecord={noop}
				onRemoveRecord={noop}
				onSetWindow={noop}
				onResetWindow={noop}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("distinct");
		expect(text).toContain("a member holding two offices counts once");
		expect(text).toContain("never over-count");
		expect(text).toContain("goal 9 is never ticked for you");
	});

	it("disables every control while a write is in flight", () => {
		mount(view({ records: [record()], hasRecords: true }), true);
		for (const button of screen.getAllByRole("button")) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}
		for (const box of screen.getAllByRole("combobox")) {
			expect((box as HTMLSelectElement).disabled).toBe(true);
		}
	});

	it("highlights the period in focus", () => {
		mount(view({ focus: 2 }));
		expect(card(2).className).toContain("border-[var(--lagoon-deep)]");
		expect(card(1).className).toContain("border-[var(--line)]");
	});
});
