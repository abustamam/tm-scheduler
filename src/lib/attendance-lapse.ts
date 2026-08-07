// Pure, client-safe attendance-lapse scoring (#530). NO `#/db` import lives
// here, so the constants and the maths are importable by a unit test without a
// database — the reason `#/lib/minutes-render-caps` and `#/lib/speaker-limits`
// were pulled out of their renderers. A constant defined in a module that
// imports `#/db` at load throws `DATABASE_URL is not set` in vitest, which
// makes it unassertable and therefore silently raisable to any value.
//
// The window SELECTION (which meetings count) is SQL's job — see
// `reporting-logic.ts`. This module scores whatever window it is handed.

/**
 * The two numbers the feature is.
 *
 * Both are asserted ABSOLUTELY in the unit test rather than relative to
 * themselves. `expect(streak).toBeLessThanOrEqual(streakThreshold)` passes for
 * every value of the threshold, including 5,000 — which surfaces nobody, ever,
 * with the whole suite green. That is the shape #519 shipped twice.
 *
 * `windowMeetings` counts HELD meetings rather than days on purpose. A
 * date-based window silently empties over a holiday break or a run of
 * cancellations, so a club's rates go undefined at exactly the time of year
 * people drift away. Counting meetings is invariant to cadence: it reads the
 * same for a weekly club and a fortnightly one.
 */
export const ATTENDANCE_LAPSE = {
	/** How many held meetings back the window reaches. */
	windowMeetings: 8,
	/** Consecutive not-present meetings before a member is surfaced. */
	streakThreshold: 3,
} as const;

/** The persisted attendance statuses (`attendance_status` in the schema). */
export type AttendanceMark = "present" | "absent" | "excused";

/** One meeting inside the scoring window. */
export interface LapseWindowMeeting {
	meetingId: string;
	scheduledAt: Date;
}

/** One active member being scored. */
export interface LapseMember {
	memberId: string;
	name: string;
	joinedAt: Date | null;
}

/** One stored attendance record. Absence of a record is meaningful — see below. */
export interface LapseMark {
	meetingId: string;
	memberId: string;
	status: AttendanceMark;
}

export interface AttendanceLapseRow {
	memberId: string;
	name: string;
	joinedAt: Date | null;
	/** Consecutive not-present meetings, counting back from the most recent. */
	streak: number;
	/** Meetings in the member's window where they were recorded present. */
	presentCount: number;
	/** Meetings counting toward this member — excludes pre-join and excused. */
	eligibleCount: number;
	/** presentCount / eligibleCount, or null when nothing is eligible. */
	rate: number | null;
	/** Most recent meeting the member was recorded present at. */
	lastSeenAt: Date | null;
	isLapsed: boolean;
}

interface ScoreInput {
	/** The window, NEWEST FIRST. */
	meetings: LapseWindowMeeting[];
	members: LapseMember[];
	marks: LapseMark[];
}

/**
 * Score every member against the window.
 *
 * Three rules carry the whole feature, and each was settled deliberately:
 *
 * 1. **"Not present" means "not recorded present".** A missing record scores
 *    identically to an explicit `absent`. The club marks who showed up and
 *    leaves the rest alone, so absences exist in the database as missing rows —
 *    a rule reading only `status = 'absent'` would be tested, green, shipped
 *    and permanently unable to fire. This deliberately relaxes the #218 rule
 *    ("unmarked is not absent") at the AGGREGATE layer only: #218 exists to
 *    stop a meeting that has not happened rendering as "everyone absent", and
 *    that still holds on every per-meeting surface. Do not carry this
 *    relaxation back into one.
 *
 * 2. **`excused` is transparent.** It neither counts toward a streak nor breaks
 *    one, and it drops out of the rate denominator. A member who says they will
 *    be away must not be flagged alongside one who simply stopped coming —
 *    that would surface the most communicative members first.
 *
 * 3. **A member is only scored from their join date.** Otherwise somebody who
 *    joined last month reads as having missed everything before that.
 */
export function scoreAttendanceLapse(input: ScoreInput): AttendanceLapseRow[] {
	const byMember = new Map<string, Map<string, AttendanceMark>>();
	for (const m of input.marks) {
		let forMember = byMember.get(m.memberId);
		if (!forMember) {
			forMember = new Map();
			byMember.set(m.memberId, forMember);
		}
		forMember.set(m.meetingId, m.status);
	}

	const rows = input.members.map((member) => {
		const seen = byMember.get(member.memberId);
		// Rule 3: the window is bounded below by the join date. A null join date
		// (legacy rows) is treated as "has always been here" rather than excluding
		// the member, so an unknown date never hides a real lapse.
		const eligible = input.meetings.filter(
			(mt) => member.joinedAt === null || mt.scheduledAt >= member.joinedAt,
		);

		let presentCount = 0;
		let eligibleCount = 0;
		let lastSeenAt: Date | null = null;
		let streak = 0;
		let streakOpen = true;

		for (const mt of eligible) {
			const status = seen?.get(mt.meetingId) ?? null;

			// Rule 2: excused is skipped entirely — not counted, not a streak break.
			if (status === "excused") continue;

			eligibleCount++;
			if (status === "present") {
				presentCount++;
				if (lastSeenAt === null) lastSeenAt = mt.scheduledAt;
				streakOpen = false;
			} else if (streakOpen) {
				// Rule 1: `absent` and a missing record are the same thing here.
				streak++;
			}
		}

		return {
			memberId: member.memberId,
			name: member.name,
			joinedAt: member.joinedAt,
			streak,
			presentCount,
			eligibleCount,
			rate: eligibleCount === 0 ? null : presentCount / eligibleCount,
			lastSeenAt,
			isLapsed: streak >= ATTENDANCE_LAPSE.streakThreshold,
		};
	});

	// Longest lapse first — that is the order an officer works the list in.
	// Name breaks ties so the ordering is stable across reads.
	return rows.sort(
		(a, b) => b.streak - a.streak || a.name.localeCompare(b.name),
	);
}
