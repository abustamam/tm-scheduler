import { describe, expect, it } from "vitest";
import { isMeetingNotFoundError } from "./meeting-errors";

describe("isMeetingNotFoundError", () => {
	it("is true for the exact 'Meeting not found.' error thrown by getMeeting", () => {
		expect(isMeetingNotFoundError(new Error("Meeting not found."))).toBe(true);
	});

	it("is false for other Error messages", () => {
		expect(isMeetingNotFoundError(new Error("Club not found."))).toBe(false);
		expect(isMeetingNotFoundError(new Error("Something went wrong."))).toBe(
			false,
		);
	});

	it("is false for non-Error values", () => {
		expect(isMeetingNotFoundError("Meeting not found.")).toBe(false);
		expect(isMeetingNotFoundError(null)).toBe(false);
		expect(isMeetingNotFoundError(undefined)).toBe(false);
		expect(isMeetingNotFoundError({ message: "Meeting not found." })).toBe(
			false,
		);
	});
});
