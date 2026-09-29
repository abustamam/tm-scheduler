import { describe, expect, it } from "vitest";
import {
	defaultAttendanceMode,
	formatModeSplit,
	minutesModeSplit,
	modeForStatus,
	presenceWriteMode,
	tallyModes,
} from "./attendance-mode";

describe("defaultAttendanceMode (#1049, decision 2)", () => {
	it("is online ONLY for a join link with no location", () => {
		expect(
			defaultAttendanceMode({
				joinUrl: "https://zoom.us/j/1",
				location: null,
			}),
		).toBe("online");
	});

	it("is in person for a hybrid meeting (join link AND location)", () => {
		expect(
			defaultAttendanceMode({
				joinUrl: "https://zoom.us/j/1",
				location: "Library, Room 2",
			}),
		).toBe("in_person");
	});

	it("is in person with a location and no join link", () => {
		expect(defaultAttendanceMode({ joinUrl: null, location: "Library" })).toBe(
			"in_person",
		);
	});

	it("is in person with neither set — nothing says the meeting is online", () => {
		expect(defaultAttendanceMode({ joinUrl: null, location: null })).toBe(
			"in_person",
		);
		expect(
			defaultAttendanceMode({ joinUrl: undefined, location: undefined }),
		).toBe("in_person");
	});

	it("treats whitespace-only values as unset", () => {
		expect(
			defaultAttendanceMode({
				joinUrl: "https://meet.example/x",
				location: "  ",
			}),
		).toBe("online");
		expect(defaultAttendanceMode({ joinUrl: "   ", location: null })).toBe(
			"in_person",
		);
	});
});

describe("modeForStatus (#1049, decision 4)", () => {
	it("clears the mode for absent and excused, whatever was sent", () => {
		expect(modeForStatus("absent", "online")).toBeNull();
		expect(modeForStatus("excused", "in_person")).toBeNull();
		expect(modeForStatus("absent", undefined)).toBeNull();
	});

	it("keeps an explicit mode on present", () => {
		expect(modeForStatus("present", "online")).toBe("online");
		expect(modeForStatus("present", "in_person")).toBe("in_person");
	});

	it("returns undefined — leave it alone — for present with no mode", () => {
		expect(modeForStatus("present", undefined)).toBeUndefined();
	});
});

describe("presenceWriteMode (#1049, decision 1)", () => {
	it("sends the default when a row BECOMES present", () => {
		for (const currentStatus of [
			null,
			undefined,
			"absent",
			"excused",
		] as const) {
			expect(
				presenceWriteMode({
					status: "present",
					currentStatus,
					defaultMode: "online",
				}),
			).toBe("online");
		}
	});

	it("sends nothing when re-picking Present, so a recorded choice survives", () => {
		expect(
			presenceWriteMode({
				status: "present",
				currentStatus: "present",
				defaultMode: "online",
			}),
		).toBeUndefined();
	});

	it("sends nothing for absent or excused", () => {
		expect(
			presenceWriteMode({
				status: "absent",
				currentStatus: "present",
				defaultMode: "in_person",
			}),
		).toBeUndefined();
		expect(
			presenceWriteMode({
				status: "excused",
				currentStatus: null,
				defaultMode: "in_person",
			}),
		).toBeUndefined();
	});
});

describe("tallyModes / minutesModeSplit", () => {
	it("counts null AND undefined as not recorded, never as in person", () => {
		expect(tallyModes(["in_person", "online", null, undefined])).toEqual({
			inPerson: 1,
			online: 1,
			unrecorded: 2,
		});
	});

	it("counts present members and every listed guest, not absent members", () => {
		expect(
			minutesModeSplit({
				members: [
					{ status: "present", mode: "in_person" },
					{ status: "present", mode: "online" },
					{ status: "present" },
					{ status: "absent", mode: null },
					{ status: null },
				],
				guests: [{ mode: "online" }, {}],
			}),
		).toEqual({ inPerson: 1, online: 2, unrecorded: 2 });
	});
});

describe("formatModeSplit", () => {
	it("is null when nothing is recorded, so the plain total shows", () => {
		expect(
			formatModeSplit({ inPerson: 0, online: 0, unrecorded: 5 }),
		).toBeNull();
		expect(
			formatModeSplit({ inPerson: 0, online: 0, unrecorded: 0 }),
		).toBeNull();
	});

	it("uses Easy-Speak's '12 + 4 online'", () => {
		expect(formatModeSplit({ inPerson: 12, online: 4, unrecorded: 0 })).toBe(
			"12 + 4 online",
		);
	});

	it("names one side alone when the other is empty", () => {
		expect(formatModeSplit({ inPerson: 7, online: 0, unrecorded: 0 })).toBe(
			"7 in person",
		);
		expect(formatModeSplit({ inPerson: 0, online: 3, unrecorded: 0 })).toBe(
			"3 online",
		);
	});

	it("names the unrecorded rather than folding them into either side", () => {
		expect(formatModeSplit({ inPerson: 8, online: 2, unrecorded: 2 })).toBe(
			"8 + 2 online, 2 not recorded",
		);
	});
});
