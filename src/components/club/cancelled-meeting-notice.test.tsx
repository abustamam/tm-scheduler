// @vitest-environment jsdom
//
// The three shapes a cancelled meeting takes on the surfaces a link lands on
// (#1057; the maintainer's decision on #1084).
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import {
	CancelledArtifactMarker,
	CancelledMeetingNotice,
	CancelledWatermark,
} from "./cancelled-meeting-notice";

const MEETING_UUID = "22222222-2222-4222-8222-222222222222";

afterEach(cleanup);

describe("CancelledMeetingNotice", () => {
	it("says the meeting is cancelled in the shared sentence, and links to it by uuid", async () => {
		await renderUnderMemoryRouter(
			<CancelledMeetingNotice clubId="downtown" meetingId={MEETING_UUID} />,
		);
		const notice = screen.getByTestId("cancelled-meeting-notice");
		expect(notice.textContent).toContain(MEETING_CANCELLED_MESSAGE);
		expect(notice.textContent).toContain("Everyone keeps their role.");
		expect(
			screen
				.getByRole("link", { name: "See the meeting" })
				.getAttribute("href"),
		).toBe(`/club/downtown/meeting/${MEETING_UUID}`);
		// A live region a screen reader announces: `<output>`.
		expect(notice.tagName).toBe("OUTPUT");
	});

	it("takes the page's own sentence in place of the default", async () => {
		await renderUnderMemoryRouter(
			<CancelledMeetingNotice
				clubId="downtown"
				meetingId={MEETING_UUID}
				detail="There's no vote for a cancelled meeting."
			/>,
		);
		const notice = screen.getByTestId("cancelled-meeting-notice");
		expect(notice.textContent).toContain("There's no vote");
		expect(notice.textContent).not.toContain("Everyone keeps their role.");
	});
});

describe("CancelledArtifactMarker", () => {
	it("says the meeting is not happening, as a status", async () => {
		await renderUnderMemoryRouter(<CancelledArtifactMarker />);
		const marker = screen.getByTestId("cancelled-artifact-marker");
		expect(marker.textContent).toBe(
			"Cancelled — this meeting is not happening",
		);
		expect(marker.tagName).toBe("OUTPUT");
	});
});

describe("CancelledWatermark", () => {
	it("is fixed and hidden from screen readers, so it neither moves a layout nor repeats the marker", async () => {
		await renderUnderMemoryRouter(<CancelledWatermark />);
		const watermark = screen.getByTestId("cancelled-watermark");
		expect(watermark.textContent).toBe("CANCELLED");
		expect(watermark.style.position).toBe("fixed");
		expect(watermark.style.pointerEvents).toBe("none");
		expect(watermark.getAttribute("aria-hidden")).toBe("true");
	});
});
