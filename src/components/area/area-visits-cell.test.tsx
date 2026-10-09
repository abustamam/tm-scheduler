// @vitest-environment jsdom
//
// A club's two visit rounds (#1120): what the cell prints in each state, what a
// Record / Edit / Clear does, and what `readOnly` removes. The server fns are
// stubbed; their refusals and date rules are proven at the real handlers in
// `src/server/area-visits.integration.test.ts`.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { recordClubVisit, clearClubVisit, invalidate } = vi.hoisted(() => ({
	recordClubVisit: vi.fn(),
	clearClubVisit: vi.fn(),
	invalidate: vi.fn(),
}));
vi.mock("#/server/area-visits", () => ({ recordClubVisit, clearClubVisit }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

import { AreaVisitsCell } from "./area-visits-cell";

const CLUB = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AreaVisitsCell", () => {
	it("says 'not yet' for both rounds and offers Record on each, when nothing is recorded", () => {
		render(<AreaVisitsCell areaClubId={CLUB} visits={undefined} />);
		expect(screen.getAllByText("not yet")).toHaveLength(2);
		expect(
			screen.getByRole("button", { name: "Record round 1 visit" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Record round 2 visit" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
	});

	it("prints a recorded round's date and offers Edit and Clear on it, Record on the other", () => {
		render(<AreaVisitsCell areaClubId={CLUB} visits={{ 1: "2026-10-12" }} />);
		expect(screen.getByText("Oct 12")).toBeTruthy();
		expect(screen.getAllByText("not yet")).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "Edit round 1 visit" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Clear round 1 visit" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Record round 2 visit" }),
		).toBeTruthy();
	});

	it("prints a date-only value as written, in no zone's calendar", () => {
		render(<AreaVisitsCell areaClubId={CLUB} visits={{ 2: "2027-01-01" }} />);
		expect(screen.getByText("Jan 1")).toBeTruthy();
	});

	it("records a round with the date typed, then reloads the page's data", async () => {
		recordClubVisit.mockResolvedValue({ round: 2, visitedOn: "2026-10-12" });
		render(<AreaVisitsCell areaClubId={CLUB} visits={undefined} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Record round 2 visit" }),
		);
		fireEvent.change(screen.getByLabelText("Round 2 visit date"), {
			target: { value: "2026-10-12" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(recordClubVisit).toHaveBeenCalledWith({
			data: { areaClubId: CLUB, round: 2, visitedOn: "2026-10-12" },
		});
		// Back to the display state.
		expect(screen.queryByLabelText("Round 2 visit date")).toBeNull();
	});

	it("starts an edit from the recorded date", () => {
		render(<AreaVisitsCell areaClubId={CLUB} visits={{ 1: "2026-10-12" }} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit round 1 visit" }));
		expect(
			(screen.getByLabelText("Round 1 visit date") as HTMLInputElement).value,
		).toBe("2026-10-12");
	});

	it("clears one round", async () => {
		clearClubVisit.mockResolvedValue(undefined);
		render(<AreaVisitsCell areaClubId={CLUB} visits={{ 1: "2026-10-12" }} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Clear round 1 visit" }),
		);

		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(clearClubVisit).toHaveBeenCalledWith({
			data: { areaClubId: CLUB, round: 1 },
		});
	});

	it("shows the server's refusal and stays in the form, without reloading", async () => {
		recordClubVisit.mockRejectedValue(
			new Error("A visit can't be dated in the future"),
		);
		render(<AreaVisitsCell areaClubId={CLUB} visits={undefined} />);

		fireEvent.click(
			screen.getByRole("button", { name: "Record round 1 visit" }),
		);
		fireEvent.change(screen.getByLabelText("Round 1 visit date"), {
			target: { value: "2999-01-01" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("A visit can't be dated in the future");
		expect(screen.getByLabelText("Round 1 visit date")).toBeTruthy();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("readOnly prints the dates and no controls at all", () => {
		render(
			<AreaVisitsCell
				areaClubId={CLUB}
				visits={{ 1: "2026-10-12" }}
				readOnly
			/>,
		);
		expect(screen.getByText("Oct 12")).toBeTruthy();
		expect(screen.getByText("not yet")).toBeTruthy();
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});
});
