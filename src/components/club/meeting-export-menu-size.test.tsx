// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingExportMenu } from "./meeting-export-menu";

afterEach(cleanup);

const PROPS = {
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	wordOfTheDay: null,
	deck: undefined,
	clubName: undefined,
	presentIsPrimary: false,
};

describe("MeetingExportMenu trigger size (#1307)", () => {
	it("defaults to the sm trigger, so other callers keep their height", async () => {
		await renderUnderMemoryRouter(<MeetingExportMenu {...PROPS} />);
		expect(
			screen.getByRole("button", { name: /print & export/i }).dataset.size,
		).toBe("sm");
	});

	it("size=touch gives the touch trigger", async () => {
		await renderUnderMemoryRouter(
			<MeetingExportMenu {...PROPS} size="touch" />,
		);
		expect(
			screen.getByRole("button", { name: /print & export/i }).dataset.size,
		).toBe("touch");
	});
});
