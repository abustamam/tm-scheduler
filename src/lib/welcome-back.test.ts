import { describe, expect, it } from "vitest";
import { welcomeBackMessage } from "./welcome-back";

const now = new Date("2026-10-31T12:00:00Z");

describe("welcomeBackMessage (#1446)", () => {
	it("names the month once the gap is over 28 days", () => {
		expect(
			welcomeBackMessage(
				"Marco Rossi",
				new Date("2026-08-12T12:00:00Z"),
				now,
				"UTC",
			),
		).toBe("Welcome back, Marco: first meeting since August");
	});
	it("names the day within 28 days", () => {
		expect(
			welcomeBackMessage("Marco", new Date("2026-10-08T12:00:00Z"), now, "UTC"),
		).toBe("Welcome back, Marco: first meeting since Oct 8");
	});
	it("says 'since joining' when never present", () => {
		expect(welcomeBackMessage("Marco", null, now)).toBe(
			"Welcome back, Marco: first meeting since joining",
		);
	});
	it("accepts the serialised date", () => {
		expect(
			welcomeBackMessage("Marco", "2026-10-08T12:00:00.000Z", now, "UTC"),
		).toContain("Oct 8");
	});
});
