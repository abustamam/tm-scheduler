import { describe, expect, it } from "vitest";
import { clubCharterStatusEnum } from "#/db/schema";
import {
	CHARTER_DATE_FUTURE_MESSAGE,
	CHARTER_DATE_INVALID_MESSAGE,
	CHARTER_DATE_TOO_EARLY_MESSAGE,
	CHARTER_STATUSES,
	CLUB_NUMBER_FORMAT_MESSAGE,
	CLUB_NUMBER_REQUIRED_MESSAGE,
	charterDateSchema,
	charterInvariantError,
	EARLIEST_CHARTER_DATE,
	isCalendarDate,
	latestCharterDate,
	optionalClubNumberSchema,
} from "./club-charter";

describe("the charter status vocabulary", () => {
	it("matches the database enum exactly", () => {
		expect([...clubCharterStatusEnum.enumValues]).toEqual([
			...CHARTER_STATUSES,
		]);
	});
});

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

	it("refuses a date before Toastmasters was founded, and accepts the founding day", () => {
		expect(EARLIEST_CHARTER_DATE).toBe("1924-10-22");
		expect(
			charterDateSchema.safeParse("1924-10-21").error?.issues[0]?.message,
		).toBe(CHARTER_DATE_TOO_EARLY_MESSAGE);
		expect(
			charterDateSchema.safeParse("0001-01-01").error?.issues[0]?.message,
		).toBe(CHARTER_DATE_TOO_EARLY_MESSAGE);
		expect(charterDateSchema.parse("1924-10-22")).toBe("1924-10-22");
	});
});

describe("optionalClubNumberSchema", () => {
	it("trims, and reads empty as absent", () => {
		expect(optionalClubNumberSchema.parse(" 42 ")).toBe("42");
		expect(optionalClubNumberSchema.parse("  ")).toBeNull();
		expect(optionalClubNumberSchema.parse(undefined)).toBeNull();
		expect(optionalClubNumberSchema.parse(null)).toBeNull();
	});

	it("accepts 1-8 digits and refuses anything else", () => {
		expect(optionalClubNumberSchema.parse("1")).toBe("1");
		expect(optionalClubNumberSchema.parse("12345678")).toBe("12345678");
		for (const bad of [
			"123456789",
			"TM-123",
			"12 34",
			"3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f",
		]) {
			expect(
				optionalClubNumberSchema.safeParse(bad).error?.issues[0]?.message,
				bad,
			).toBe(CLUB_NUMBER_FORMAT_MESSAGE);
		}
	});
});
