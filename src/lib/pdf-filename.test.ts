import { describe, expect, it } from "vitest";
import { meetingPdfBasename } from "./pdf-filename";

describe("meetingPdfBasename", () => {
	it("builds <slug>-meeting-<iso> from a plain name", () => {
		expect(
			meetingPdfBasename(
				"Downtown Toastmasters",
				"2026-07-22T18:45:00Z",
				"UTC",
			),
		).toBe("Downtown-Toastmasters-meeting-2026-07-22");
	});

	it("collapses punctuation, symbols, and emoji to single hyphens", () => {
		expect(
			meetingPdfBasename(
				"Café & Co. 🎤 Speakers!",
				"2026-07-22T12:00:00Z",
				"UTC",
			),
		).toBe("Café-Co-Speakers-meeting-2026-07-22");
	});

	it("uses the club timezone's calendar day, not UTC's", () => {
		// 02:00Z on the 22nd is still the 21st in Los Angeles (UTC-7 in July).
		const instant = "2026-07-22T02:00:00Z";
		expect(meetingPdfBasename("Club", instant, "America/Los_Angeles")).toBe(
			"Club-meeting-2026-07-21",
		);
		expect(meetingPdfBasename("Club", instant, "UTC")).toBe(
			"Club-meeting-2026-07-22",
		);
	});

	it("accepts a Date as well as an ISO string", () => {
		expect(
			meetingPdfBasename("Club", new Date("2026-01-05T12:00:00Z"), "UTC"),
		).toBe("Club-meeting-2026-01-05");
	});

	it("falls back to 'agenda' for empty or punctuation-only names", () => {
		const iso = "2026-07-22T12:00:00Z";
		expect(meetingPdfBasename("", iso, "UTC")).toBe(
			"agenda-meeting-2026-07-22",
		);
		expect(meetingPdfBasename("   ", iso, "UTC")).toBe(
			"agenda-meeting-2026-07-22",
		);
		expect(meetingPdfBasename("!!!", iso, "UTC")).toBe(
			"agenda-meeting-2026-07-22",
		);
	});
});
