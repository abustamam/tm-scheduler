import { describe, expect, it } from "vitest";
import { formatRemaining } from "./impersonation-banner";

describe("formatRemaining", () => {
	it("formats minutes and zero-padded seconds", () => {
		expect(formatRemaining(60 * 60 * 1000)).toBe("60:00");
		expect(formatRemaining(9 * 60 * 1000 + 5 * 1000)).toBe("9:05");
		expect(formatRemaining(59 * 1000)).toBe("0:59");
	});

	it("clamps negatives and sub-second to 0:00", () => {
		expect(formatRemaining(0)).toBe("0:00");
		expect(formatRemaining(-5000)).toBe("0:00");
		expect(formatRemaining(500)).toBe("0:00");
	});
});
