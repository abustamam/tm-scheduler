// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import {
	EarlierDivider,
	PastBadge,
	PastSpeechDate,
} from "#/components/speech-log-date";

// protects=how a past speech (#1656) renders and how its sheet takes a loose date
// no_claim=server writes (past-speeches-logic.integration.test.ts)
const server = vi.hoisted(() => ({
	addPastSpeechFn: vi.fn(async () => ({ ok: true as const })),
	editPastSpeechFn: vi.fn(async () => ({ ok: true as const })),
	deletePastSpeechFn: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("#/server/speeches", () => ({
	addPastSpeechFn: server.addPastSpeechFn,
	editPastSpeechFn: server.editPastSpeechFn,
	deletePastSpeechFn: server.deletePastSpeechFn,
	editSpeechFromLog: vi.fn(),
}));
vi.mock("#/server/slots", () => ({ updateSpeakerDetails: vi.fn() }));
vi.mock("#/server/project-picker", () => ({
	getProjectOptions: vi.fn(async () => []),
}));
vi.mock("#/db", () => ({ db: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("past speech row pieces", () => {
	// fails_when=month/year/dash text changes
	it("renders MAR / 2023, the year alone, and a dash", () => {
		const { container, rerender } = render(
			<PastSpeechDate year={2023} month={3} />,
		);
		expect(container.textContent).toContain("MAR");
		expect(container.textContent).toContain("2023");
		rerender(<PastSpeechDate year={2022} month={null} />);
		expect(container.textContent).toContain("2022");
		expect(container.textContent).not.toMatch(/JAN|FEB|MAR/);
		rerender(<PastSpeechDate year={null} month={null} />);
		expect(container.textContent).toContain("—");
	});
	it("renders the Past badge and the Earlier divider", () => {
		render(
			<>
				<PastBadge />
				<EarlierDivider />
			</>,
		);
		expect(screen.getByText("Past")).toBeTruthy();
		expect(screen.getByText("Earlier")).toBeTruthy();
	});
});

describe("the past-speech sheet", () => {
	const slot = {
		id: "new-m1",
		label: "Jo Member",
		speechTitle: null,
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		projectId: null,
		assigneeId: "m1",
		minMinutes: null,
		maxMinutes: null,
		presentationUrl: null,
		introduction: null,
		past: {
			speechId: null,
			memberId: "m1",
			deliveredYear: null,
			deliveredMonth: null,
		},
	};
	// fails_when=Month is enabled before a year is chosen
	it("keeps Month disabled until a Year is picked", async () => {
		render(
			<EditSpeechSheet
				writer="past-speech"
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(screen.getByText(/Add past speech — Jo Member/)).toBeTruthy();
		const month = screen.getByLabelText(/Month/) as HTMLSelectElement;
		expect(month.disabled).toBe(true);
		await userEvent.selectOptions(screen.getByLabelText(/Year \(/), "2023");
		expect(month.disabled).toBe(false);
	});
	// protects=the sheet does not offer a month the server refuses (#1656)
	// fails_when=Month lists months after the current one in the current year
	it("lists only months up to this month in the current year, all twelve before it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
		try {
			render(
				<EditSpeechSheet
					writer="past-speech"
					slot={slot}
					onOpenChange={() => {}}
					onSaved={() => {}}
				/>,
			);
			const month = screen.getByLabelText(/Month/) as HTMLSelectElement;
			const year = screen.getByLabelText(/Year \(/);
			await userEvent.selectOptions(year, "2026");
			// "Not sure" plus Jan, Feb, Mar.
			expect(month.options).toHaveLength(4);
			await userEvent.selectOptions(month, "3");
			await userEvent.selectOptions(year, "2025");
			expect(month.options).toHaveLength(13);
			// A month left over from another year that the current year refuses is
			// dropped and not sent.
			await userEvent.selectOptions(month, "11");
			await userEvent.selectOptions(year, "2026");
			expect(month.value).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});
	// protects=an edit never erases a stored month the browser clock thinks is in the future (#1656)
	// fails_when=the Month select hides the stored month, or a save sends null for it
	// no_claim=the server's own timezone check
	it("keeps a stored month after the browser's current month and sends it unchanged", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-30T23:30:00Z"));
		try {
			render(
				<EditSpeechSheet
					writer="past-speech"
					slot={{
						...slot,
						id: "s1",
						past: {
							speechId: "sp1",
							memberId: "m1",
							deliveredYear: 2026,
							deliveredMonth: 12,
						},
					}}
					onOpenChange={() => {}}
					onSaved={() => {}}
				/>,
			);
			const month = screen.getByLabelText(/Month/) as HTMLSelectElement;
			expect(month.value).toBe("12");
			await userEvent.click(screen.getByRole("button", { name: /save/i }));
			await vi.waitFor(() =>
				expect(server.editPastSpeechFn).toHaveBeenCalledTimes(1),
			);
			expect(server.editPastSpeechFn).toHaveBeenCalledWith({
				data: expect.objectContaining({
					deliveredYear: 2026,
					deliveredMonth: 12,
				}),
			});
		} finally {
			vi.useRealTimers();
		}
	});
	// protects=a NEW speech is not offered a month after the current one in the current year
	// fails_when=the offered list ignores the current month
	// no_claim=stored months (see the test above)
	it("offers no month after the current one for a new speech in the current year", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-30T23:30:00Z"));
		try {
			render(
				<EditSpeechSheet
					writer="past-speech"
					slot={slot}
					onOpenChange={() => {}}
					onSaved={() => {}}
				/>,
			);
			await userEvent.selectOptions(screen.getByLabelText(/Year \(/), "2026");
			const month = screen.getByLabelText(/Month/) as HTMLSelectElement;
			// "Not sure" plus Jan..Nov.
			expect(month.options).toHaveLength(12);
		} finally {
			vi.useRealTimers();
		}
	});
	// fails_when=Delete skips its inline confirmation
	it("offers Delete only on an existing past speech, confirmed inline", async () => {
		const { rerender } = render(
			<EditSpeechSheet
				writer="past-speech"
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(screen.queryByText("Delete speech")).toBeNull();
		rerender(
			<EditSpeechSheet
				writer="past-speech"
				slot={{ ...slot, id: "s1", past: { ...slot.past, speechId: "s1" } }}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await userEvent.click(screen.getByText("Delete speech"));
		expect(server.deletePastSpeechFn).not.toHaveBeenCalled();
		await userEvent.click(screen.getByText("Yes, delete"));
		expect(server.deletePastSpeechFn).toHaveBeenCalledWith({
			data: { speechId: "s1" },
		});
	});
});
