// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import { MeetingRoleSheets } from "./meeting-role-sheets";

afterEach(cleanup);

describe("MeetingRoleSheets (#542 label)", () => {
	// The trigger label carries the disambiguation: these PDFs are pre-filled
	// for THIS meeting, unlike the club-level "All role sheets" link beside it.
	it("labels the download menu as this meeting's role sheets", () => {
		render(<MeetingRoleSheets meetingId="m-1" />);
		expect(
			screen.getByRole("button", { name: /this meeting's role sheets/i }),
		).toBeTruthy();
	});

	it("opens to one pre-filled PDF download per sheet", async () => {
		render(<MeetingRoleSheets meetingId="m-1" />);
		await userEvent.click(
			screen.getByRole("button", { name: /this meeting's role sheets/i }),
		);
		for (const sheet of ROLE_SHEETS) {
			const link = screen.getByText(sheet.title).closest("a");
			expect(link?.getAttribute("href")).toBe(
				`/api/meetings/m-1/role-sheets/${sheet.key}/pdf`,
			);
		}
	});
});
