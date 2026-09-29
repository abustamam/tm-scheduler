// In the room or on the call (#1049). PURE — no React, no db — so the server
// (`loadMinutes`, the minutes PDF) and the client (roll mode, the Minutes card,
// the offline projection) all read the same rules from one place.
//
// The column is `meeting_attendance.mode` (#1046): `in_person | online`, and
// NULL = NOT RECORDED. Every row written before #1049 is NULL and stays NULL:
// nothing here guesses a value for it, and nothing backfills it. A NULL mode on
// a present row is counted as present-with-no-mode, never as in person.

/** Mirrors the `attendance_mode` enum in `src/db/schema.ts`. */
export type AttendanceMode = "in_person" | "online";

export const ATTENDANCE_MODES: readonly AttendanceMode[] = [
	"in_person",
	"online",
];

export const ATTENDANCE_MODE_LABELS: Record<AttendanceMode, string> = {
	in_person: "In person",
	online: "Online",
};

/**
 * The mode roll mode's toggle starts on for this meeting.
 *
 * An ONLINE-ONLY meeting is one with a join link AND no location (maintainer's
 * rule on #1049). Anything else — in person, hybrid, or a meeting with neither
 * set — starts on in person. Whitespace-only values count as unset, so a
 * location of " " does not turn an online meeting hybrid.
 *
 * This is only where the TOGGLE starts. It is written only when the officer
 * records someone present with it showing, which is the officer's choice.
 */
export function defaultAttendanceMode(meeting: {
	joinUrl: string | null | undefined;
	location: string | null | undefined;
}): AttendanceMode {
	const hasJoinLink = (meeting.joinUrl ?? "").trim().length > 0;
	const hasLocation = (meeting.location ?? "").trim().length > 0;
	return hasJoinLink && !hasLocation ? "online" : "in_person";
}

/**
 * The mode a presence write stores. Anything but `present` clears it (decision
 * 4 on #1049): someone who was absent or excused was neither in the room nor on
 * the call. For `present`, `undefined` means "not given" — the caller keeps
 * whatever is stored — and is distinct from an explicit value.
 */
export function modeForStatus(
	status: "present" | "absent" | "excused",
	mode: AttendanceMode | undefined,
): AttendanceMode | null | undefined {
	return status === "present" ? mode : null;
}

/**
 * The mode roll mode sends with a status write (#1049, decision 1).
 *
 * A row BECOMING present is recorded with the mode the toggle starts on — the
 * meeting's default — and that tap is the officer's choice. Re-picking Present
 * on someone already present sends NONE, so neither an officer's earlier choice
 * nor a NULL from before #1049 is overwritten by the default. Absent and
 * excused send none; the server clears the mode for them.
 */
export function presenceWriteMode(input: {
	status: "present" | "absent" | "excused";
	currentStatus: "present" | "absent" | "excused" | null | undefined;
	defaultMode: AttendanceMode;
}): AttendanceMode | undefined {
	return input.status === "present" && input.currentStatus !== "present"
		? input.defaultMode
		: undefined;
}

export interface ModeSplit {
	inPerson: number;
	online: number;
	/** Present, but no mode was recorded (older rows, or never toggled). */
	unrecorded: number;
}

/** Tally the modes of people who were PRESENT. `undefined` (a snapshot saved
 *  before the field existed) is the same as `null`: not recorded. */
export function tallyModes(
	modes: readonly (AttendanceMode | null | undefined)[],
): ModeSplit {
	const split: ModeSplit = { inPerson: 0, online: 0, unrecorded: 0 };
	for (const m of modes) {
		if (m === "in_person") split.inPerson++;
		else if (m === "online") split.online++;
		else split.unrecorded++;
	}
	return split;
}

/**
 * The split over everyone present at a meeting: members marked present, plus
 * every listed guest (a listed guest IS present — ADR-0013). Fields are read
 * optionally because the offline minutes snapshot is unversioned and one saved
 * by an earlier deploy carries no `mode` at all.
 */
export function minutesModeSplit(minutes: {
	members: readonly { status: string | null; mode?: AttendanceMode | null }[];
	guests: readonly { mode?: AttendanceMode | null }[];
}): ModeSplit {
	return tallyModes([
		...minutes.members.filter((m) => m.status === "present").map((m) => m.mode),
		...minutes.guests.map((g) => g.mode),
	]);
}

/**
 * Easy-Speak's format: "12 + 4 online" (12 in the room, 4 on the call).
 *
 * Returns `null` when NO mode is recorded, so the caller shows its plain total
 * — a meeting recorded before #1049 must read exactly as it always did. When
 * some present people have a mode and some do not, the unrecorded ones are
 * named rather than folded into either side: "8 + 2 online, 2 not recorded".
 */
export function formatModeSplit(split: ModeSplit): string | null {
	if (split.inPerson + split.online === 0) return null;
	const recorded =
		split.online === 0
			? `${split.inPerson} in person`
			: split.inPerson === 0
				? `${split.online} online`
				: `${split.inPerson} + ${split.online} online`;
	return split.unrecorded > 0
		? `${recorded}, ${split.unrecorded} not recorded`
		: recorded;
}
