// @vitest-environment jsdom
//
// The charter dashboard (#943): the official-requirements note in both states,
// the chartered club's closed dashboard, the progress and the pick-a-period
// prompt, and what the checklist and helper controls send. The server fns are
// mocked (they reach `#/db`).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
vi.mock("#/server/charter", () => ({
	addCharterHelper: vi.fn(),
	addCharterStep: vi.fn(),
	removeCharterHelper: vi.fn(),
	removeCharterStep: vi.fn(),
	renameCharterStep: vi.fn(),
	reorderCharterSteps: vi.fn(),
	setCharterStepDone: vi.fn(),
	startCharterChecklist: vi.fn(),
	updateCharterTarget: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import {
	OFFICIAL_REQUIREMENTS_NOTE,
	OFFICIAL_REQUIREMENTS_URL,
} from "#/lib/charter-dashboard";
import {
	addCharterHelper,
	reorderCharterSteps,
	setCharterStepDone,
	startCharterChecklist,
	updateCharterTarget,
} from "#/server/charter";
import type { CharterDashboard as Data } from "#/server/charter-logic";
import { CHARTER_DASHBOARD_COPY, CharterDashboard } from "./charter-dashboard";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const PERIOD = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function data(over: Partial<Data> = {}): Data {
	return {
		started: true,
		membersNeeded: 20,
		duesPeriodId: PERIOD,
		paidCount: 12,
		periods: [{ id: PERIOD, label: "Charter dues" }],
		steps: [
			{ id: "s1", label: "First", position: 0, doneAt: null },
			{ id: "s2", label: "Second", position: 1, doneAt: "2026-09-01" },
		],
		helpers: [],
		people: [{ personId: PERSON, name: "Rasheed" }],
		...over,
	};
}

function renderDashboard(dashboard: Data | null) {
	const onChanged = vi.fn();
	render(
		<CharterDashboard
			clubId={CLUB_ID}
			dashboard={dashboard}
			onChanged={onChanged}
		/>,
	);
	return { onChanged };
}

function expectOfficialNote() {
	const note = screen.getByTestId("charter-official-note");
	expect(note.textContent).toContain(OFFICIAL_REQUIREMENTS_NOTE);
	expect(note.querySelector("a")?.getAttribute("href")).toBe(
		OFFICIAL_REQUIREMENTS_URL,
	);
}

describe("charter dashboard", () => {
	it("shows the progress and the official-requirements note", () => {
		renderDashboard(data());
		expectOfficialNote();
		expect(screen.getByTestId("charter-progress-text").textContent).toBe(
			"12 of 20",
		);
		expect(screen.queryByTestId("charter-pick-period")).toBeNull();
		expect(screen.getAllByTestId("charter-step")).toHaveLength(2);
	});

	it("prompts the club to pick a period when none is selected", () => {
		renderDashboard(data({ duesPeriodId: null, paidCount: 0 }));
		expect(screen.getByTestId("charter-pick-period").textContent).toContain(
			CHARTER_DASHBOARD_COPY.pickPeriod,
		);
		expect(screen.getByTestId("charter-progress-text").textContent).toBe(
			"0 of 20",
		);
	});

	it("says to add a dues period first when the club has none", () => {
		renderDashboard(data({ duesPeriodId: null, paidCount: 0, periods: [] }));
		expect(screen.getByTestId("charter-pick-period").textContent).toContain(
			CHARTER_DASHBOARD_COPY.noPeriods,
		);
	});

	it("once chartered: the note stays, the dashboard is closed", () => {
		renderDashboard(null);
		expectOfficialNote();
		expect(screen.getByText(CHARTER_DASHBOARD_COPY.chartered)).toBeTruthy();
		expect(screen.queryByTestId("charter-progress-text")).toBeNull();
		expect(screen.queryByTestId("charter-step")).toBeNull();
	});

	it("saves the target and the picked period", async () => {
		vi.mocked(updateCharterTarget).mockResolvedValue({ ok: true });
		const { onChanged } = renderDashboard(data({ duesPeriodId: null }));
		const needed = screen.getByLabelText(
			CHARTER_DASHBOARD_COPY.membersNeededLabel,
		);
		await userEvent.clear(needed);
		await userEvent.type(needed, "25");
		await userEvent.selectOptions(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.periodLabel),
			PERIOD,
		);
		await userEvent.click(screen.getByTestId("save-target"));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(updateCharterTarget).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, membersNeeded: 25, duesPeriodId: PERIOD },
		});
	});

	it("sends only the target field that changed", async () => {
		vi.mocked(updateCharterTarget).mockResolvedValue({ ok: true });
		const { onChanged } = renderDashboard(data());
		const needed = screen.getByLabelText(
			CHARTER_DASHBOARD_COPY.membersNeededLabel,
		);
		await userEvent.clear(needed);
		await userEvent.type(needed, "30");
		await userEvent.click(screen.getByTestId("save-target"));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(updateCharterTarget).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, membersNeeded: 30 },
		});
	});

	it("sends nothing when nothing changed", async () => {
		renderDashboard(data());
		await userEvent.click(screen.getByTestId("save-target"));
		expect(updateCharterTarget).not.toHaveBeenCalled();
	});

	it("shows a not-yet-started checklist read-only, with a Start button that seeds it", async () => {
		vi.mocked(startCharterChecklist).mockResolvedValue({ ok: true });
		const { onChanged } = renderDashboard(
			data({
				started: false,
				steps: [{ id: "default-0", label: "First", position: 0, doneAt: null }],
			}),
		);
		expect(screen.getByTestId("charter-not-started")).toBeTruthy();
		expect(
			(screen.getByLabelText("Remove First") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			(
				screen.getByLabelText(
					CHARTER_DASHBOARD_COPY.doneOnLabel("First"),
				) as HTMLInputElement
			).disabled,
		).toBe(true);
		await userEvent.click(screen.getByTestId("start-checklist"));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(startCharterChecklist).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID },
		});
	});

	it("a started checklist has no Start button", () => {
		renderDashboard(data());
		expect(screen.queryByTestId("start-checklist")).toBeNull();
	});

	it("moves a step down by sending the whole new order", async () => {
		vi.mocked(reorderCharterSteps).mockResolvedValue({ ok: true });
		renderDashboard(data());
		await userEvent.click(screen.getByLabelText("Move First down"));
		await waitFor(() =>
			expect(reorderCharterSteps).toHaveBeenCalledWith({
				data: { clubId: CLUB_ID, stepIds: ["s2", "s1"] },
			}),
		);
		expect(
			(screen.getByLabelText("Move First up") as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("clears a done date as null", async () => {
		vi.mocked(setCharterStepDone).mockResolvedValue({ ok: true });
		renderDashboard(data());
		await userEvent.clear(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.doneOnLabel("Second")),
		);
		await waitFor(() =>
			expect(setCharterStepDone).toHaveBeenCalledWith({
				data: { clubId: CLUB_ID, stepId: "s2", doneAt: null },
			}),
		);
	});

	it("adds a roster Person as a helper by id alone", async () => {
		vi.mocked(addCharterHelper).mockResolvedValue({ id: "h1" });
		renderDashboard(data());
		await userEvent.selectOptions(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.fromRosterLabel),
			PERSON,
		);
		expect(
			screen.queryByLabelText(CHARTER_DASHBOARD_COPY.nameLabel),
		).toBeNull();
		await userEvent.click(screen.getByTestId("add-helper"));
		await waitFor(() =>
			expect(addCharterHelper).toHaveBeenCalledWith({
				data: { clubId: CLUB_ID, role: "sponsor", personId: PERSON },
			}),
		);
	});

	it("adds an outside club mentor from free text, and refuses one with no name", async () => {
		vi.mocked(addCharterHelper).mockResolvedValue({ id: "h1" });
		renderDashboard(data());
		await userEvent.click(screen.getByTestId("add-helper"));
		expect(toast.error).toHaveBeenCalledWith(
			CHARTER_DASHBOARD_COPY.nameRequired,
		);
		expect(addCharterHelper).not.toHaveBeenCalled();

		await userEvent.selectOptions(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.roleLabel),
			"club_mentor",
		);
		await userEvent.type(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.nameLabel),
			"Pat",
		);
		await userEvent.type(
			screen.getByLabelText(CHARTER_DASHBOARD_COPY.homeClubLabel),
			"Downtown",
		);
		await userEvent.click(screen.getByTestId("add-helper"));
		await waitFor(() =>
			expect(addCharterHelper).toHaveBeenCalledWith({
				data: {
					clubId: CLUB_ID,
					role: "club_mentor",
					personId: null,
					name: "Pat",
					email: "",
					phone: "",
					homeClub: "Downtown",
				},
			}),
		);
	});

	it("lists helpers with their role", () => {
		renderDashboard(
			data({
				helpers: [
					{
						id: "h1",
						role: "club_mentor",
						personId: null,
						name: "Pat",
						email: "pat@example.com",
						phone: null,
						homeClub: "Downtown",
					},
				],
			}),
		);
		const row = screen.getByTestId("charter-helper");
		expect(row.textContent).toContain("Pat");
		expect(row.textContent).toContain("Club mentor");
		expect(row.textContent).toContain("Downtown · pat@example.com");
	});
});
