/**
 * Pure unit tests for the minutes-PDF section models.
 *
 * `buildAttendanceSection` (#218) is the single source of the PDF's attendance
 * counts line and name rows, so these tests are the guarantee that the
 * PDF/export path never lists an unmarked member (no saved attendance
 * record, `status: null`) as absent.
 *
 * `buildTimingSection` (#730) is the same shape for the Timer's measured
 * times, and it has to be pure for a stronger reason than tidiness: a rendered
 * PDF's content streams are COMPRESSED, so nothing about the wording, the
 * verdict or the omitted-when-empty rule is reachable by inspecting the bytes.
 * If the model were built inline in `renderMinutesPdf`, none of the assertions
 * below could exist at all.
 */
import { describe, expect, it, vi } from "vitest";
import { MINUTES_RENDER_CAPS } from "#/lib/minutes-render-caps";

// minutes-pdf-logic imports #/db (via minutes-logic) at the top level; mock it
// so this pure-unit test runs without a DATABASE_URL and without Postgres.
vi.mock("#/db", () => ({ db: {} }));

import type { MinutesMemberRow, MinutesTimingRow } from "./minutes-logic";
import {
	buildAttendanceSection,
	buildTimingSection,
} from "./minutes-pdf-logic";

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

/** A recorded time. A standard 5–7 speech unless a case says otherwise. */
function timing(over: Partial<MinutesTimingRow> = {}): MinutesTimingRow {
	return {
		slotId: "slot-1",
		roleName: "Speaker 1",
		assigneeName: "Rehanna Khan",
		isGuest: false,
		elapsedSeconds: 371,
		markGreen: 5,
		markRed: 7,
		...over,
	};
}

describe("buildTimingSection (#730)", () => {
	it("renders the role, the holder, the clock and the verdict", () => {
		const section = buildTimingSection({ timings: [timing()] });
		expect(section?.rows).toEqual([
			"Speaker 1: Rehanna Khan — 6:11 · Qualified",
		]);
		expect(section?.tail).toBeNull();
	});

	it("is OMITTED entirely when the club recorded no times", () => {
		// A club that does not use the stopwatch has not failed to record
		// anything, so it must not get a permanently empty heading on every set
		// of its minutes. `null` is what `renderMinutesPdf` reads as "no section",
		// following `buildActionItemsSection` rather than Table Topics' "No …
		// recorded." — see the function's docblock for why the repo does both.
		expect(buildTimingSection({ timings: [] })).toBeNull();
	});

	it("is omitted for a payload with no timings key at all", () => {
		// The offline snapshot in IndexedDB is an unversioned `MinutesData`
		// written by a PREVIOUS deploy. `actionItems` white-screened the minutes
		// page in exactly this state; this must not.
		expect(buildTimingSection({})).toBeNull();
	});

	it("marks a guest speaker as one", () => {
		const section = buildTimingSection({
			timings: [timing({ assigneeName: "Gale Okafor", isGuest: true })],
		});
		expect(section?.rows[0]).toContain("Gale Okafor (Guest)");
	});

	it("prints an em dash for a slot nobody held", () => {
		// Not "The club", and not a blank: an invented holder in a permanent
		// record reads as an attribution, which is the failure
		// `buildActionItemsSection` records for an unowned action item.
		const section = buildTimingSection({
			timings: [timing({ assigneeName: null })],
		});
		expect(section?.rows[0]).toBe("Speaker 1: — — 6:11 · Qualified");
	});

	it("derives the verdict from the row's OWN marks at every boundary", () => {
		const section = buildTimingSection({
			timings: [
				timing({ slotId: "a", roleName: "Under", elapsedSeconds: 269 }),
				timing({ slotId: "b", roleName: "Low edge", elapsedSeconds: 270 }),
				timing({ slotId: "c", roleName: "High edge", elapsedSeconds: 450 }),
				timing({ slotId: "d", roleName: "Over", elapsedSeconds: 451 }),
			],
		});
		expect(section?.rows.map((r) => r.split(" · ")[1])).toEqual([
			"Under time",
			"Qualified",
			"Qualified",
			"Over time",
		]);
	});

	it("says so rather than judging when the row has no window", () => {
		const section = buildTimingSection({
			timings: [timing({ markGreen: null, markRed: null })],
		});
		expect(section?.rows[0]).toContain("No window set");
	});

	it("two rows measured identically against different windows disagree", () => {
		// The point of copying the marks onto the row: an officer widening the
		// agenda's min/max cannot re-decide a speech already recorded, and this is
		// what makes that visible in the printed record.
		const section = buildTimingSection({
			timings: [
				timing({ slotId: "a", roleName: "Old", elapsedSeconds: 460 }),
				timing({
					slotId: "b",
					roleName: "New",
					elapsedSeconds: 460,
					markRed: 8,
				}),
			],
		});
		expect(section?.rows[0]).toContain("Over time");
		expect(section?.rows[1]).toContain("Qualified");
	});

	it("caps the row count and says how many it cut", () => {
		// react-pdf's cost is super-linear in row count and `role_slots` are
		// creatable through the self-assert path with no ceiling. A section that
		// silently stopped at 60 rows would read as a complete record.
		const many = Array.from({ length: 65 }, (_, i) =>
			timing({ slotId: `slot-${i}`, roleName: `Speaker ${i}` }),
		);
		const section = buildTimingSection({ timings: many });
		expect(section?.rows).toHaveLength(MINUTES_RENDER_CAPS.programRows);
		expect(section?.tail).toBe("+5 more not shown");
	});

	it("caps a long role name and a long holder name", () => {
		// Neither is write-capped: role names are admin-authored free text, and a
		// row written before any cap existed is still in the database. `cap`
		// spends one of its budget on the ellipsis, so the assertion is that
		// NEITHER raw run survives — not that a run of exactly `cap` characters
		// appears, which would pin `cap`'s own internals rather than this rule.
		// The absolute floors under these constants live in
		// `minutes-pdf-bounds.test.ts`; what is checked here is that they are
		// applied at all.
		const section = buildTimingSection({
			timings: [
				timing({ roleName: "R".repeat(400), assigneeName: "N".repeat(400) }),
			],
		});
		const row = section?.rows[0] ?? "";
		expect(row).not.toContain("R".repeat(MINUTES_RENDER_CAPS.roleName + 1));
		expect(row).not.toContain("N".repeat(MINUTES_RENDER_CAPS.name + 1));
		// …and it did not cap them to nothing: both runs are still recognisable.
		expect(row).toContain("R".repeat(MINUTES_RENDER_CAPS.roleName - 1));
		expect(row).toContain("N".repeat(MINUTES_RENDER_CAPS.name - 1));
	});
});
