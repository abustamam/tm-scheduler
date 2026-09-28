// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingFeedbackLink } from "./meeting-feedback-link";

afterEach(cleanup);

async function renderLink(open: boolean, inRoom: boolean) {
	await renderUnderMemoryRouter(
		<MeetingFeedbackLink
			open={open}
			inRoom={inRoom}
			clubId="downtown"
			meetingKey="2026-10-03"
		/>,
	);
}

describe("MeetingFeedbackLink (#984)", () => {
	it("shows while the window is open, linking to the meeting's feedback page", async () => {
		await renderLink(true, false);
		const link = screen.getByTestId("meeting-leave-feedback");
		expect(link.textContent).toBe("Leave feedback");
		expect(link.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-10-03/feedback",
		);
	});

	it("is absent while the window is not open", async () => {
		await renderLink(false, false);
		expect(screen.queryByTestId("meeting-leave-feedback")).toBeNull();
	});

	it("steps aside while the in-room strip shows, which has its own button", async () => {
		await renderLink(true, true);
		expect(screen.queryByTestId("meeting-leave-feedback")).toBeNull();
	});
});
