import { describe, expect, it } from "vitest";
import {
	ATTENDANCE_LAPSE,
	type AttendanceMark,
	scoreAttendanceLapse,
} from "./attendance-lapse";

// Meetings are handed to the scorer newest-first, which is the order the window
// query returns. Helper builds N meetings one week apart, newest first.
function meetingsNewestFirst(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		meetingId: `m${i}`,
		scheduledAt: new Date(2026, 0, 100 - i * 7),
	}));
}

const ALICE = { memberId: "alice", name: "Alice", joinedAt: null };

/** Marks for one member across meetings, given newest-first statuses. */
function marks(
	memberId: string,
	statuses: (AttendanceMark | null)[],
): { meetingId: string; memberId: string; status: AttendanceMark }[] {
	return statuses.flatMap((s, i) =>
		s === null ? [] : [{ meetingId: `m${i}`, memberId, status: s }],
	);
}

describe("ATTENDANCE_LAPSE constants", () => {
	// Absolute assertions. A test written relative to these constants passes for
	// every value of them, including ones that make the feature dead: a threshold
	// of 5,000 means nobody is ever surfaced and the suite stays green.
	it("looks back over exactly 8 held meetings", () => {
		expect(ATTENDANCE_LAPSE.windowMeetings).toBe(8);
	});

	it("surfaces a member at exactly 3 consecutive absences", () => {
		expect(ATTENDANCE_LAPSE.streakThreshold).toBe(3);
	});
});

describe("scoreAttendanceLapse — the streak trigger", () => {
	it("surfaces a member with exactly 3 consecutive not-present meetings", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", ["absent", "absent", "absent", "present"]),
		});
		expect(row.streak).toBe(3);
		expect(row.isLapsed).toBe(true);
	});

	it("does NOT surface a member with only 2 consecutive not-present meetings", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", ["absent", "absent", "present", "present"]),
		});
		expect(row.streak).toBe(2);
		expect(row.isLapsed).toBe(false);
	});

	it("stops the streak at the most recent present meeting", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(5),
			members: [ALICE],
			marks: marks("alice", [
				"present",
				"absent",
				"absent",
				"absent",
				"absent",
			]),
		});
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});
});

describe("scoreAttendanceLapse — a missing record is not-present", () => {
	// The load-bearing decision from triage. The club marks who showed up and
	// leaves everyone else alone, so absences exist as MISSING ROWS, not as rows
	// with status 'absent'. A rule reading only explicit 'absent' rows would be
	// green, shipped, and permanently unable to fire.
	it("scores a missing record identically to an explicit absent record", () => {
		const explicit = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", ["absent", "absent", "absent", "present"]),
		})[0];

		const missing = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", [null, null, null, "present"]),
		})[0];

		expect(missing.streak).toBe(explicit.streak);
		expect(missing.isLapsed).toBe(explicit.isLapsed);
		expect(missing.rate).toBe(explicit.rate);
	});

	it("surfaces a member who has no records at all across the window", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(8),
			members: [ALICE],
			marks: [],
		});
		expect(row.streak).toBe(8);
		expect(row.isLapsed).toBe(true);
	});
});

describe("scoreAttendanceLapse — excused is neutral", () => {
	it("does not break a streak, and does not count toward it", () => {
		// absent, excused, absent → the excused meeting is transparent, so the
		// streak is 2 and the member is NOT surfaced at a threshold of 3.
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", ["absent", "excused", "absent", "present"]),
		});
		expect(row.streak).toBe(2);
		expect(row.isLapsed).toBe(false);
	});

	it("drops the meeting out of the attendance rate denominator", () => {
		// present + excused ⇒ 1 of 1, not 1 of 2. An excused member is not
		// penalised for telling somebody they would be away.
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(2),
			members: [ALICE],
			marks: marks("alice", ["present", "excused"]),
		});
		expect(row.eligibleCount).toBe(1);
		expect(row.rate).toBe(1);
	});

	it("yields a streak of 0 for present, excused, present", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(3),
			members: [ALICE],
			marks: marks("alice", ["present", "excused", "present"]),
		});
		expect(row.streak).toBe(0);
	});
});

describe("scoreAttendanceLapse — join date bounds the window", () => {
	it("ignores meetings held before the member joined", () => {
		// 4 meetings, newest first at days 100, 93, 86, 79. Joining at day 90
		// leaves only the two newest eligible.
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [
				{ memberId: "alice", name: "Alice", joinedAt: new Date(2026, 0, 90) },
			],
			marks: marks("alice", ["absent", "absent", "absent", "absent"]),
		});
		expect(row.eligibleCount).toBe(2);
		expect(row.streak).toBe(2);
		expect(row.isLapsed).toBe(false);
	});

	it("does not surface a member who joined after every meeting in the window", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(8),
			members: [
				{ memberId: "alice", name: "Alice", joinedAt: new Date(2027, 0, 1) },
			],
			marks: [],
		});
		expect(row.eligibleCount).toBe(0);
		expect(row.rate).toBeNull();
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});

	it("counts the meeting held exactly ON the join date", () => {
		// The bound is `>=`, not `>`. A member who joined the morning of a
		// meeting and did not come must have that meeting count against them, or
		// a `>` typo silently drops one meeting from every joiner's window and
		// nothing in a coarser fixture can tell.
		const meetings = meetingsNewestFirst(4);
		const joinMeeting = meetings[2];
		if (!joinMeeting) throw new Error("fixture");
		const [row] = scoreAttendanceLapse({
			meetings,
			members: [
				{ memberId: "alice", name: "Alice", joinedAt: joinMeeting.scheduledAt },
			],
			marks: marks("alice", ["absent", "absent", "absent", "absent"]),
		});
		expect(row.eligibleCount).toBe(3);
		expect(row.streak).toBe(3);
		expect(row.isLapsed).toBe(true);
	});
});

describe("scoreAttendanceLapse — reported figures", () => {
	it("reports the attendance rate over eligible meetings", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(4),
			members: [ALICE],
			marks: marks("alice", ["present", "absent", "present", "absent"]),
		});
		expect(row.presentCount).toBe(2);
		expect(row.eligibleCount).toBe(4);
		expect(row.rate).toBe(0.5);
	});

	it("reports the date last seen as the most recent present meeting", () => {
		const meetings = meetingsNewestFirst(4);
		const [row] = scoreAttendanceLapse({
			meetings,
			members: [ALICE],
			marks: marks("alice", ["absent", "present", "present", "absent"]),
		});
		expect(row.lastSeenAt).toEqual(meetings[1].scheduledAt);
	});

	it("reports a null last-seen for a member never recorded present", () => {
		const [row] = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(3),
			members: [ALICE],
			marks: marks("alice", ["absent", "excused", "absent"]),
		});
		expect(row.lastSeenAt).toBeNull();
	});

	it("orders the most lapsed member first", () => {
		const rows = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(5),
			members: [
				ALICE,
				{ memberId: "bob", name: "Bob", joinedAt: null },
				{ memberId: "cara", name: "Cara", joinedAt: null },
			],
			marks: [
				...marks("alice", ["absent", "absent", "absent", "present", "present"]),
				...marks("bob", ["absent", "absent", "absent", "absent", "absent"]),
				...marks("cara", [
					"present",
					"present",
					"present",
					"present",
					"present",
				]),
			],
		});
		expect(rows.map((r) => r.memberId)).toEqual(["bob", "alice", "cara"]);
	});

	it("breaks a streak tie by name rather than by input order", () => {
		// Members are handed in REVERSE alphabetical order with identical
		// streaks. Without the `localeCompare` tiebreak a stable sort returns
		// them in input order, so this is the only assertion that can see the
		// tiebreak exist — the ordering test above varies streak alone and
		// passes with the tiebreak deleted.
		const rows = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(3),
			members: [
				{ memberId: "z", name: "Zoe", joinedAt: null },
				{ memberId: "m", name: "Mia", joinedAt: null },
				{ memberId: "a", name: "Ana", joinedAt: null },
			],
			marks: [],
		});
		expect(rows.map((r) => r.streak)).toEqual([3, 3, 3]);
		expect(rows.map((r) => r.name)).toEqual(["Ana", "Mia", "Zoe"]);
	});

	it("returns a row for every member, lapsed or not", () => {
		const rows = scoreAttendanceLapse({
			meetings: meetingsNewestFirst(3),
			members: [ALICE, { memberId: "bob", name: "Bob", joinedAt: null }],
			marks: marks("alice", ["present", "present", "present"]),
		});
		expect(rows).toHaveLength(2);
		expect(rows.filter((r) => r.isLapsed).map((r) => r.memberId)).toEqual([
			"bob",
		]);
	});
});
