import { describe, expect, it } from "vitest";
import { clubDetailsComplete } from "./onboarding-checklist";

const base = { name: "Club", meetingSchedule: "Thursdays" };

describe("clubDetailsComplete (#944)", () => {
	it("needs a number for a chartered club", () => {
		for (const clubNumber of [null, "", "  "]) {
			expect(
				clubDetailsComplete({
					...base,
					charterStatus: "chartered",
					clubNumber,
				}),
			).toBe(false);
		}
		expect(
			clubDetailsComplete({
				...base,
				charterStatus: "chartered",
				clubNumber: "1",
			}),
		).toBe(true);
	});

	it("does not need one for a chartering club, with or without", () => {
		expect(
			clubDetailsComplete({
				...base,
				charterStatus: "chartering",
				clubNumber: null,
			}),
		).toBe(true);
		expect(
			clubDetailsComplete({
				...base,
				charterStatus: "chartering",
				clubNumber: "1",
			}),
		).toBe(true);
	});

	it("still needs a name and a schedule in either status", () => {
		for (const charterStatus of ["chartering", "chartered"] as const) {
			expect(
				clubDetailsComplete({
					name: "  ",
					meetingSchedule: "Thursdays",
					charterStatus,
					clubNumber: "1",
				}),
			).toBe(false);
			expect(
				clubDetailsComplete({
					name: "Club",
					meetingSchedule: null,
					charterStatus,
					clubNumber: "1",
				}),
			).toBe(false);
		}
	});
});
