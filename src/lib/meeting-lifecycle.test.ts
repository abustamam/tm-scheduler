import { describe, expect, it } from "vitest";
import {
	isMeetingLocked,
	isMeetingOver,
	lockedViewer,
	meetingDatePassed,
	meetingDateReached,
	meetingPhase,
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
		// Mon Aug 10, 6pm PT == Tue Aug 11, 01:00 UTC. A UTC-day comparison
		// would call this 'completed'; club-local must call it 'today'.
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
});
