import { describe, expect, it } from "vitest";
import {
	CHARTER_DATE_FUTURE_MESSAGE,
	CHARTER_DATE_INVALID_MESSAGE,
	CLUB_NUMBER_REQUIRED_MESSAGE,
	charterDateSchema,
	charterInvariantError,
	isCalendarDate,
	latestCharterDate,
	optionalClubNumberSchema,
} from "./club-charter";

describe("charterInvariantError (#944)", () => {
	it("requires a number of a chartered club", () => {
		for (const clubNumber of [null, undefined, "", "   "]) {
			expect(
				charterInvariantError({ charterStatus: "chartered", clubNumber }),
			).toBe(CLUB_NUMBER_REQUIRED_MESSAGE);
		}
		expect(
			charterInvariantError({ charterStatus: "chartered", clubNumber: "123" }),
		).toBeNull();
	});

	it("lets a chartering club have a number or none", () => {
		expect(
			charterInvariantError({ charterStatus: "chartering", clubNumber: null }),
		).toBeNull();
		expect(
			charterInvariantError({ charterStatus: "chartering", clubNumber: "123" }),
		).toBeNull();
	});
});

describe("charter dates", () => {
	it("accepts real calendar days only", () => {
		expect(isCalendarDate("2024-02-29")).toBe(true);
		expect(isCalendarDate("2023-02-29")).toBe(false);
		expect(isCalendarDate("2026-13-01")).toBe(false);
		expect(isCalendarDate("2026-9-1")).toBe(false);
		expect(isCalendarDate("")).toBe(false);
	});

	it("allows one day of slack past today in UTC, for clubs east of UTC", () => {
		expect(latestCharterDate(new Date("2026-09-28T23:30:00Z"))).toBe(
			"2026-09-29",
		);
	});

	it("rejects a non-date and a future date with their own messages", () => {
		expect(charterDateSchema.safeParse("nope").error?.issues[0]?.message).toBe(
			CHARTER_DATE_INVALID_MESSAGE,
		);
		expect(
			charterDateSchema.safeParse("2999-01-01").error?.issues[0]?.message,
		).toBe(CHARTER_DATE_FUTURE_MESSAGE);
		expect(charterDateSchema.parse(" 2020-01-01 ")).toBe("2020-01-01");
	});
});

describe("optionalClubNumberSchema", () => {
	it("trims, and reads empty as absent", () => {
		expect(optionalClubNumberSchema.parse(" 42 ")).toBe("42");
		expect(optionalClubNumberSchema.parse("  ")).toBeNull();
		expect(optionalClubNumberSchema.parse(undefined)).toBeNull();
		expect(optionalClubNumberSchema.parse(null)).toBeNull();
	});
});
