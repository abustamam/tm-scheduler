import { describe, expect, it } from "vitest";
import { urlKeysForMeetings } from "./meeting-url";

describe("urlKeysForMeetings `counting` (#1396)", () => {
	const live = { id: "live", scheduledAt: "2036-07-22T00:00:00Z" };

	it("counts only the list when nothing else is passed", () => {
		expect(urlKeysForMeetings([live], "America/Chicago").get("live")).toBe(
			"2036-07-21",
		);
	});

	it("suffixes a meeting whose date is shared with one the list leaves out", () => {
		const keys = urlKeysForMeetings([live], "America/Chicago", [
			live.scheduledAt,
			"2036-07-21T23:00:00Z",
		]);
		expect(keys.get("live")).toBe("2036-07-21-1900");
	});
});
