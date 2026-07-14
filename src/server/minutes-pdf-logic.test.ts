/**
 * Pure unit tests for the minutes-PDF attendance section model (#218).
 *
 * `buildAttendanceSection` is the single source of the PDF's attendance
 * counts line and name rows, so these tests are the guarantee that the
 * PDF/export path never lists an unmarked member (no saved attendance
 * record, `status: null`) as absent.
 */
import { describe, expect, it, vi } from "vitest";

// minutes-pdf-logic imports #/db (via minutes-logic) at the top level; mock it
// so this pure-unit test runs without a DATABASE_URL and without Postgres.
vi.mock("#/db", () => ({ db: {} }));

import type { MinutesMemberRow } from "./minutes-logic";
import { buildAttendanceSection } from "./minutes-pdf-logic";

function member(
	name: string,
	status: MinutesMemberRow["status"],
): MinutesMemberRow {
	return { memberId: `id-${name}`, name, status, hasRole: false };
}

function countsFor(members: MinutesMemberRow[]) {
	return {
		present: members.filter((m) => m.status === "present").length,
		absent: members.filter((m) => m.status === "absent").length,
		excused: members.filter((m) => m.status === "excused").length,
		unmarked: members.filter((m) => m.status === null).length,
		guests: 0,
	};
}

describe("buildAttendanceSection (#218)", () => {
	it("never lists unmarked members as absent — they get their own row", () => {
		const members = [
			member("Alice", "present"),
			member("Ben", "absent"),
			member("Cara", null),
			member("Dev", null),
		];
		const section = buildAttendanceSection({
			members,
			guests: [],
			counts: countsFor(members),
		});

		expect(section.countsLine).toBe(
			"Present: 1   Absent: 1   Excused: 0   Unmarked: 2   Guests: 0",
		);
		expect(section.rows).toEqual([
			{ label: "Present", names: "Alice" },
			{ label: "Excused", names: "—" },
			{ label: "Absent", names: "Ben" },
			{ label: "Unmarked", names: "Cara, Dev" },
			{ label: "Guests", names: "—" },
		]);
	});

	it("a fully unmarked (future) meeting shows zero absent", () => {
		const members = [member("Alice", null), member("Ben", null)];
		const section = buildAttendanceSection({
			members,
			guests: [],
			counts: countsFor(members),
		});

		expect(section.countsLine).toBe(
			"Present: 0   Absent: 0   Excused: 0   Unmarked: 2   Guests: 0",
		);
		expect(section.rows.find((r) => r.label === "Absent")?.names).toBe("—");
		expect(section.rows.find((r) => r.label === "Unmarked")?.names).toBe(
			"Alice, Ben",
		);
	});

	it("omits the Unmarked row/count when every member is recorded (unchanged output)", () => {
		const members = [
			member("Alice", "present"),
			member("Ben", "excused"),
			member("Cara", "absent"),
		];
		const section = buildAttendanceSection({
			members,
			guests: [{ name: "Gale" }],
			counts: { ...countsFor(members), guests: 1 },
		});

		expect(section.countsLine).toBe(
			"Present: 1   Absent: 1   Excused: 1   Guests: 1",
		);
		expect(section.rows.map((r) => r.label)).toEqual([
			"Present",
			"Excused",
			"Absent",
			"Guests",
		]);
		expect(section.rows.find((r) => r.label === "Guests")?.names).toBe("Gale");
	});
});
