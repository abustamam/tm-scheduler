import { describe, expect, it } from "vitest";
import { MEETING_CANCELLED_MESSAGE } from "./meeting-cancellation-notice";
import {
	acceptedStatuses,
	assertMeetingAccepts,
	isMeetingLocked,
	isMeetingOver,
	lockedViewer,
	MEETING_LOCKED_MESSAGE,
	MEETING_WRITE_POLICY,
	type MeetingWriteClass,
	meetingDatePassed,
	meetingDateReached,
	meetingPhase,
	meetingRefusal,
	resolveMeetingViewer,
} from "./meeting-lifecycle";
import { meetingViewer } from "./meeting-viewer";

describe("isMeetingLocked", () => {
	it("is true only for a completed meeting", () => {
		expect(isMeetingLocked("completed")).toBe(true);
		expect(isMeetingLocked("scheduled")).toBe(false);
	});
});

describe("meetingDatePassed", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");

	it("is true for a meeting whose date is strictly before today", () => {
		expect(meetingDatePassed("2026-07-09T18:00:00Z", tz, now)).toBe(true);
	});

	it("is false on the meeting day itself (still editable that day)", () => {
		expect(meetingDatePassed("2026-07-10T23:00:00Z", tz, now)).toBe(false);
	});

	it("is false for a future meeting", () => {
		expect(meetingDatePassed("2026-07-11T18:00:00Z", tz, now)).toBe(false);
	});

	it("differs from meetingDateReached, which includes today", () => {
		const todayMeeting = "2026-07-10T15:00:00Z";
		expect(meetingDateReached(todayMeeting, tz, now)).toBe(true);
		expect(meetingDatePassed(todayMeeting, tz, now)).toBe(false);
	});
});

describe("isMeetingOver", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");
	const scheduled = (scheduledAt: string, status = "scheduled") => ({
		status,
		scheduledAt,
		timezone: tz,
		now,
	});

	it("is true once the meeting day is strictly past", () => {
		expect(isMeetingOver(scheduled("2026-07-09T18:00:00Z"))).toBe(true);
	});

	it("is true for a completed meeting even before its date", () => {
		expect(isMeetingOver(scheduled("2026-07-15T18:00:00Z", "completed"))).toBe(
			true,
		);
	});

	it("is false for an open future meeting", () => {
		expect(isMeetingOver(scheduled("2026-07-15T18:00:00Z"))).toBe(false);
	});

	it("is a club-local DAY rule, not an instant: false at `now` itself", () => {
		// The boundary case. A meeting starting at this exact instant, one that
		// started eight hours ago, and one still to come tonight are ALL still
		// open — the agenda freezes at the next club-local day, not at the start
		// time. (`now` is 08:00 in New York on 2026-07-10.)
		expect(isMeetingOver(scheduled(now.toISOString()))).toBe(false);
		// 00:00 New York — the first instant of the meeting's own day.
		expect(isMeetingOver(scheduled("2026-07-10T04:00:00Z"))).toBe(false);
		// 23:59 New York — the last one.
		expect(isMeetingOver(scheduled("2026-07-11T03:59:00Z"))).toBe(false);
	});

	it("reads the day in the CLUB's timezone, not UTC", () => {
		// 2026-07-10T02:00Z is still 2026-07-09 in New York, so from a New York
		// club's midday-of-the-10th clock that meeting is over — while the same
		// pair of instants sits on one UTC day.
		expect(isMeetingOver(scheduled("2026-07-10T02:00:00Z"))).toBe(true);
		expect(
			isMeetingOver({ ...scheduled("2026-07-10T02:00:00Z"), timezone: "UTC" }),
		).toBe(false);
	});

	it("defaults `now` to the live clock", () => {
		const dayMs = 86_400_000;
		expect(
			isMeetingOver({
				status: "scheduled",
				scheduledAt: new Date(Date.now() - 30 * dayMs),
				timezone: tz,
			}),
		).toBe(true);
		expect(
			isMeetingOver({
				status: "scheduled",
				scheduledAt: new Date(Date.now() + 30 * dayMs),
				timezone: tz,
			}),
		).toBe(false);
	});

	it("agrees with resolveMeetingViewer on the same injected clock", () => {
		// The #393 regression: the two must never be able to read different
		// clocks. A past-but-never-completed meeting keeps an admin's canManage,
		// so `over` is the only thing that can differ.
		const input = {
			status: "scheduled",
			scheduledAt: "2026-07-09T18:00:00Z",
			timezone: tz,
			currentMemberId: "m1",
			canManage: false,
			isTmod: false,
			isGrammarian: false,
			isSignedIn: true,
			now,
		};
		expect(isMeetingOver(input)).toBe(true);
		// A non-manager viewer is frozen exactly when the meeting is over.
		expect(resolveMeetingViewer(input).canClaim).toBe(false);
		const early = { ...input, now: new Date("2026-07-08T12:00:00Z") };
		expect(isMeetingOver(early)).toBe(false);
		expect(resolveMeetingViewer(early).canClaim).toBe(true);
	});
});

describe("lockedViewer", () => {
	it("denies every mutation capability, including claim and own-release", () => {
		const locked = lockedViewer(
			meetingViewer({
				currentMemberId: "m1",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
				// Signed in, so every own-slot and reassign flag is TRUE before the
				// lock and the assertions below test the lock, not the session (#1003).
				isSignedIn: true,
			}),
		);
		expect(locked.currentMemberId).toBe("m1");
		expect(locked.canManage).toBe(false);
		expect(locked.canAssign).toBe(false);
		expect(locked.canManageSpeakers).toBe(false);
		expect(locked.canToggleAvailability).toBe(false);
		expect(locked.canTakeOver).toBe(false);
		expect(locked.canEditOwnSpeech).toBe(false);
		expect(locked.canClaim).toBe(false);
		expect(locked.canReleaseOwn).toBe(false);
		expect(locked.canReassignHeld).toBe(false);
	});
});

describe("resolveMeetingViewer", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");
	const future = "2026-07-15T18:00:00Z";
	const past = "2026-07-05T18:00:00Z";
	const common = {
		timezone: tz,
		currentMemberId: "m1",
		isTmod: false,
		isGrammarian: false,
		now,
	};

	it("admin on a future meeting: full management, editable meta", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin keeps editing a past-but-open meeting (not locked-wrapped)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin on a completed (locked) meeting is read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "completed",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canClaim).toBe(false);
	});

	it("signed-in member on a future meeting can claim + take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canToggleAvailability).toBe(true);
	});

	it("member on a past meeting freezes read-only (over)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canClaim).toBe(false);
		expect(v.canToggleAvailability).toBe(false);
	});

	it("anon on a future meeting can claim but not take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(false);
	});

	it("anon on a past meeting freezes read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(false);
	});

	it("cancelled meeting is read-only for a manager, whatever the date (#1090)", () => {
		for (const scheduledAt of [future, past]) {
			const v = resolveMeetingViewer({
				...common,
				status: "cancelled",
				scheduledAt,
				canManage: true,
				isSignedIn: true,
			});
			expect(v).toEqual(
				lockedViewer(
					meetingViewer({
						currentMemberId: "m1",
						canManage: true,
						isTmod: false,
						isGrammarian: false,
						isEditableWindow: true,
						isSignedIn: true,
					}),
				),
			);
		}
	});

	it("cancelled meeting is read-only for a member (#1090)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "cancelled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: true,
		});
		expect(v).toEqual(
			lockedViewer(
				meetingViewer({
					currentMemberId: "m1",
					canManage: false,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
					isSignedIn: true,
				}),
			),
		);
	});
});

describe("meetingPhase (#541 D1)", () => {
	// HCS shape: 2026-08-11T03:00:00Z is Mon Aug 10, 8:00 PM in Los Angeles —
	// the UTC date is one day AHEAD of the club-local date. Every case below
	// must resolve phase in CLUB time, never UTC.
	const scheduledAt = "2026-08-11T03:00:00.000Z";
	const timezone = "America/Los_Angeles";

	it("is 'upcoming' the club-local day before", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-09T20:00:00.000Z"), // Sun Aug 9, 1pm PT
			}),
		).toBe("upcoming");
	});

	it("is 'today' on the club-local meeting day", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-10T16:00:00.000Z"), // Mon Aug 10, 9am PT
			}),
		).toBe("today");
	});

	it("is 'today' even when the UTC calendar already flipped to the next day", () => {
		// Mon Aug 10, 6pm PT == Tue Aug 11, 01:00 UTC. This is the only fixture
		// that catches a HALF-converted implementation — one that resolves the
		// meeting's own day in club time but reads `now`'s day in UTC — the
		// likelier real mistake than a fully-UTC implementation, which would
		// still call this 'today' too.
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-11T01:00:00.000Z"),
			}),
		).toBe("today");
	});

	it("is 'completed' the club-local day after, even if nobody pressed Complete", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-11T20:00:00.000Z"), // Tue Aug 11, 1pm PT
			}),
		).toBe("completed");
	});

	it("is 'completed' whenever the meeting is locked, regardless of date", () => {
		expect(
			meetingPhase({
				status: "completed",
				scheduledAt,
				timezone,
				now: new Date("2026-08-01T00:00:00.000Z"), // long before the meeting
			}),
		).toBe("completed");
	});

	it("does NOT special-case 'cancelled' — phase stays date-based (review 2A)", () => {
		// Deliberate: the spec scopes cancelled rendering to the route, and the
		// phase model must not silently start treating cancelled as completed —
		// that would flip the toolbar on cancelled-meeting pages.
		expect(
			meetingPhase({
				status: "cancelled",
				scheduledAt,
				timezone,
				now: new Date("2026-08-09T20:00:00.000Z"), // day before, club time
			}),
		).toBe("upcoming");
	});

	it("defaults `now` to the live clock (a long-past meeting reads completed)", () => {
		expect(
			meetingPhase({
				status: "scheduled",
				scheduledAt: "2020-01-08T04:00:00.000Z",
				timezone,
			}),
		).toBe("completed");
	});

	it("a passed-but-open meeting is phase 'completed' yet still admin-editable", () => {
		const input = {
			status: "scheduled",
			scheduledAt,
			timezone,
			now: new Date("2026-08-11T20:00:00.000Z"),
		};
		expect(meetingPhase(input)).toBe("completed");
		expect(isMeetingOver(input)).toBe(true);
		expect(
			resolveMeetingViewer({
				...input,
				currentMemberId: "m1",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isSignedIn: true,
			}).canManage,
		).toBe(true);
	});
});

// The meeting write policy (#1134). One table owns which statuses each write
// class refuses; these pin its rows and the two functions that read it.
describe("MEETING_WRITE_POLICY", () => {
	it("has exactly the plan and record rows", () => {
		expect(MEETING_WRITE_POLICY).toEqual({
			plan: { scheduled: "accept", cancelled: "refuse", completed: "refuse" },
			record: { scheduled: "accept", cancelled: "refuse", completed: "accept" },
		});
	});
});

describe("meetingRefusal", () => {
	it.each<[string, MeetingWriteClass, string | null]>([
		["scheduled", "plan", null],
		["cancelled", "plan", "cancelled"],
		["completed", "plan", "completed"],
		["scheduled", "record", null],
		["cancelled", "record", "cancelled"],
		["completed", "record", null],
	])("%s under %s refuses %s", (status, writeClass, refused) => {
		expect(meetingRefusal(status, writeClass)).toBe(refused);
	});

	it("throws on an unknown status, naming it, for both classes", () => {
		for (const writeClass of ["plan", "record"] as const) {
			expect(() => meetingRefusal("postponed", writeClass)).toThrow(
				"Unknown meeting status: postponed",
			);
		}
	});

	it("does not mistake an Object.prototype key for a known status", () => {
		for (const status of ["toString", "__proto__", "constructor", ""]) {
			expect(() => meetingRefusal(status, "plan")).toThrow(
				"Unknown meeting status",
			);
		}
	});
});

describe("assertMeetingAccepts", () => {
	it("refuses a cancelled meeting for both classes with the cancelled sentence", () => {
		for (const writeClass of ["plan", "record"] as const) {
			expect(() => assertMeetingAccepts("cancelled", writeClass)).toThrow(
				new Error(MEETING_CANCELLED_MESSAGE),
			);
		}
	});

	it("refuses a completed meeting for plan with the lock sentence", () => {
		expect(() => assertMeetingAccepts("completed", "plan")).toThrow(
			new Error(MEETING_LOCKED_MESSAGE),
		);
	});

	it("accepts a completed meeting for record and a scheduled one for either", () => {
		expect(() => assertMeetingAccepts("completed", "record")).not.toThrow();
		expect(() => assertMeetingAccepts("scheduled", "plan")).not.toThrow();
		expect(() => assertMeetingAccepts("scheduled", "record")).not.toThrow();
	});

	it("replaces the sentence for the status it names and no other", () => {
		const messages = { cancelled: "No edits on a cancelled meeting." };
		expect(() =>
			assertMeetingAccepts("cancelled", "plan", { messages }),
		).toThrow(new Error("No edits on a cancelled meeting."));
		// The lock keeps its own copy when only the cancelled sentence is given.
		expect(() =>
			assertMeetingAccepts("completed", "plan", { messages }),
		).toThrow(new Error(MEETING_LOCKED_MESSAGE));
	});

	it("lets a writer accept a status its class refuses, and only that one", () => {
		const options = { accept: ["cancelled"] } as const;
		expect(() =>
			assertMeetingAccepts("cancelled", "plan", options),
		).not.toThrow();
		expect(() => assertMeetingAccepts("completed", "plan", options)).toThrow(
			new Error(MEETING_LOCKED_MESSAGE),
		);
	});

	it("throws on an unknown status, naming it, even when the writer accepts", () => {
		expect(() => assertMeetingAccepts("postponed", "plan")).toThrow(
			"Unknown meeting status: postponed",
		);
		expect(() =>
			assertMeetingAccepts("postponed", "record", {
				accept: ["cancelled", "completed"],
			}),
		).toThrow("Unknown meeting status: postponed");
	});
});

// The list the SQL helpers filter on (#1134). An allow-list: a status missing
// from it is refused by the statement, which is how an unknown one fails closed.
describe("acceptedStatuses", () => {
	it("is the statuses the class accepts, in policy order", () => {
		expect(acceptedStatuses("plan")).toEqual(["scheduled"]);
		expect(acceptedStatuses("record")).toEqual(["scheduled", "completed"]);
	});

	it("always includes scheduled, whatever the class and override", () => {
		for (const writeClass of ["plan", "record"] as const) {
			expect(acceptedStatuses(writeClass)).toContain("scheduled");
			expect(
				acceptedStatuses(writeClass, ["cancelled", "completed"]),
			).toContain("scheduled");
		}
	});

	it("adds a status the writer accepts anyway, and no other", () => {
		expect(acceptedStatuses("plan", ["cancelled"])).toEqual([
			"scheduled",
			"cancelled",
		]);
		expect(acceptedStatuses("plan", ["completed"])).toEqual([
			"scheduled",
			"completed",
		]);
		expect(acceptedStatuses("plan", ["cancelled", "completed"])).toEqual([
			"scheduled",
			"cancelled",
			"completed",
		]);
	});

	it("does not list a status twice when the class already accepts it", () => {
		expect(acceptedStatuses("record", ["completed"])).toEqual([
			"scheduled",
			"completed",
		]);
	});

	it("agrees with meetingRefusal on every status, with and without an override", () => {
		for (const writeClass of ["plan", "record"] as const) {
			for (const status of ["scheduled", "cancelled", "completed"] as const) {
				expect(acceptedStatuses(writeClass).includes(status)).toBe(
					meetingRefusal(status, writeClass) === null,
				);
			}
		}
	});

	it("does not change the policy it reads", () => {
		acceptedStatuses("plan", ["cancelled", "completed"]);
		expect(MEETING_WRITE_POLICY.plan).toEqual({
			scheduled: "accept",
			cancelled: "refuse",
			completed: "refuse",
		});
	});
});
