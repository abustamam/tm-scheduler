// The panel ABSORBED two surfaces (spec, "Surfaces absorbed"). Deleting a file
// is easy to do halfway: the component goes and a stale import, a dead prop or
// the second copy of the same list stays behind, and the officer sees the same
// members twice in two different orders.
//
// Read RAW: these are "must be ABSENT" assertions, and comment-stripping could
// only ever loosen them.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("surfaces absorbed by the planned-attendance panel", () => {
	it("OutreachPanel is gone", () => {
		expect(
			existsSync(resolve(ROOT, "src/components/club/outreach-panel.tsx")),
		).toBe(false);
	});

	it("nothing still imports or renders it", () => {
		const agenda = readFileSync(
			resolve(ROOT, "src/components/agenda/meeting-agenda.tsx"),
			"utf8",
		);
		expect(agenda).not.toContain("OutreachPanel");
		expect(agenda).not.toContain("deriveOutreach");
	});

	it("the 'Not available this week' section is gone", () => {
		const agenda = readFileSync(
			resolve(ROOT, "src/components/agenda/meeting-agenda.tsx"),
			"utf8",
		);
		expect(agenda).not.toContain("Not available this week");
	});

	it("AttendanceSection is gone from the Minutes card", () => {
		// Absorbed into the attendance panel's roll mode (spec "Surfaces absorbed").
		// Two surfaces recording the same rows is how a club ends up with an officer
		// marking someone present in one place and absent in the other.
		const minutes = readFileSync(
			resolve(ROOT, "src/components/club/meeting-minutes.tsx"),
			"utf8",
		);
		expect(minutes).not.toContain("AttendanceSection");
		// The card must still POINT at where roll call moved to, or an officer who
		// knows the old location just finds it missing.
		expect(minutes).toContain("Attendance is taken in the Attendance panel");
	});

	it("the payload no longer ships the three id arrays the panel replaced", () => {
		const meetings = readFileSync(
			resolve(ROOT, "src/server/meetings.ts"),
			"utf8",
		);
		for (const dead of [
			"unavailableMemberIds",
			"contactedMemberIds",
			"comingMemberIds",
		]) {
			expect(
				meetings,
				`${dead} is dead once the panel owns this`,
			).not.toContain(dead);
		}
	});
});
